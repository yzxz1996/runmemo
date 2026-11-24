import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendJsonl } from "../src/core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("concurrent updateHtmlSink calls from CC and Codex sessions preserve both in sessions-index.json", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-idx-race-"));
  try {
    const htmlUrl = pathToFileURL(path.join(ROOT, "src/sinks/html.mjs")).href;
    const runWorker = (sid, agentSource) =>
      new Promise((resolve, reject) => {
        const script = [
          `import { updateHtmlSink } from ${JSON.stringify(htmlUrl)};`,
          `for (let i = 0; i < 6; i++) {`,
          `  updateHtmlSink(undefined, { sessionId: ${JSON.stringify(sid)}, agentSource: ${JSON.stringify(agentSource)}, projectName: ${JSON.stringify(sid)}, status: "running", tier: "L2", updatedAt: Date.now() + i, durationSec: i, counts: { mutate: i + 1, verify: 0, subagentsTotal: 0 }, briefs: [] });`,
          `}`,
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, RUNMEMO_HOME: tmpHome },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
      });

    await Promise.all([runWorker("race-cc", "cc"), runWorker("race-codex", "codex")]);

    const idx = JSON.parse(fs.readFileSync(path.join(tmpHome, "sessions-index.json"), "utf8"));
    const ids = idx.map((x) => x.sessionId).sort();
    assert.deepEqual(ids, ["race-cc", "race-codex"]);
    assert.ok(fs.existsSync(path.join(tmpHome, "views/race-cc.js")));
    assert.ok(fs.existsSync(path.join(tmpHome, "views/race-codex.js")));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("runBriefPass preserves events arriving concurrently during LLM step and keeps byte offsets consistent", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-snap-race-"));
  const env = { ...process.env, RUNMEMO_HOME: tmpHome, RUNMEMO_MOCK_LLM: "1", RUNMEMO_DISABLE_FEISHU: "1" };
  try {
    const sid = "snap-race-1";
    const evFile = path.join(tmpHome, "sessions", sid, "events.jsonl");
    const sumScript = path.join(ROOT, "src/summarizer.mjs");

    // 1. 写入前 2 条事件并物化一次
    appendJsonl(evFile, { ts: 1000, sessionId: sid, agentSource: "cc", eventType: "SessionStart", cwd: "/workspace/app" });
    appendJsonl(evFile, { ts: 1100, sessionId: sid, agentSource: "cc", eventType: "UserPromptSubmit", cwd: "/workspace/app", prompt: "改接口并单测" });
    const r1 = spawnSync(process.execPath, [sumScript, "--session", sid, "--trigger", "UserPromptSubmit", "--mock-llm", "--no-feishu"], { encoding: "utf8", env });
    assert.equal(r1.status, 0, r1.stderr);

    // 2. 追加写变更、验证和 Stop，运行 summarizer 生成简报并验证 snapshot 字节游标与真实文件长度一致
    appendJsonl(evFile, { ts: 1200, sessionId: sid, agentSource: "cc", eventType: "PostToolUse", cwd: "/workspace/app", toolName: "Edit", opClass: "MUTATE", risk: "normal", target: "src/api.ts", ok: true, snippet: "ok" });
    appendJsonl(evFile, { ts: 1300, sessionId: sid, agentSource: "cc", eventType: "PostToolUse", cwd: "/workspace/app", toolName: "Bash", opClass: "VERIFY", risk: "normal", target: "npm test", ok: true, snippet: "10/10" });
    appendJsonl(evFile, { ts: 1400, sessionId: sid, agentSource: "cc", eventType: "Stop", cwd: "/workspace/app" });

    const r2 = spawnSync(process.execPath, [sumScript, "--session", sid, "--trigger", "Stop", "--mock-llm", "--no-feishu"], { encoding: "utf8", env });
    assert.equal(r2.status, 0, r2.stderr);

    const snap = JSON.parse(fs.readFileSync(path.join(tmpHome, "sessions", sid, "snapshot.json"), "utf8"));
    const evSize = fs.statSync(evFile).size;
    const brSize = fs.statSync(path.join(tmpHome, "sessions", sid, "briefs.jsonl")).size;

    assert.equal(snap.counts.totalEvents, 5);
    assert.equal(snap.briefs.length, 1);
    assert.equal(snap.eventsByteOffset, evSize);
    assert.equal(snap.briefsByteOffset, brSize);
    assert.equal(snap.status, "idle");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("runBriefPass merges events appended mid-LLM without losing concurrent updates", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-midllm-"));
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-fakebin-"));
  try {
    const sid = "midllm-1";
    const evFile = path.join(tmpHome, "sessions", sid, "events.jsonl");
    const sumScript = path.join(ROOT, "src/summarizer.mjs");

    // 构造一个临时伪造 CLI：它在输出简报前，向 events.jsonl 追加 1 条新事件，模拟并发 Hook B
    const helperJs = path.join(tmpBinDir, "fake-claude.mjs");
    const fakeCmd = path.join(tmpBinDir, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
    fs.writeFileSync(
      helperJs,
      [
        'import fs from "node:fs";',
        "const evFile = process.env.TEST_EV_FILE;",
        "const midEvent = { ts: 1500, sessionId: process.env.TEST_SID, agentSource: 'cc', eventType: 'PostToolUse', cwd: '/workspace/app', toolName: 'Edit', opClass: 'MUTATE', risk: 'normal', target: 'src/concurrent.ts', ok: true, snippet: 'mid-llm' };",
        "fs.appendFileSync(evFile, JSON.stringify(midEvent) + '\\n', 'utf8');",
        "console.log(JSON.stringify({ title: '修复接口', status: 'ok', bullets: ['修改 src/api.ts'], files: ['src/api.ts'], check: '单测通过', alert: '' }));",
      ].join("\n"),
      "utf8"
    );
    if (process.platform === "win32") {
      fs.writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${helperJs}" %*\r\n`, "utf8");
    } else {
      fs.writeFileSync(fakeCmd, `#!/bin/sh\nexec "${process.execPath}" "${helperJs}" "$@"\n`, "utf8");
      fs.chmodSync(fakeCmd, 0o755);
    }

    const env = {
      ...process.env,
      RUNMEMO_HOME: tmpHome,
      RUNMEMO_CLAUDE_BIN: fakeCmd,
      RUNMEMO_DISABLE_FEISHU: "1",
      TEST_EV_FILE: evFile,
      TEST_SID: sid,
    };

    appendJsonl(evFile, { ts: 1000, sessionId: sid, agentSource: "cc", eventType: "SessionStart", cwd: "/workspace/app" });
    appendJsonl(evFile, { ts: 1100, sessionId: sid, agentSource: "cc", eventType: "UserPromptSubmit", cwd: "/workspace/app", prompt: "测试并发合并" });
    appendJsonl(evFile, { ts: 1200, sessionId: sid, agentSource: "cc", eventType: "PostToolUse", cwd: "/workspace/app", toolName: "Edit", opClass: "MUTATE", risk: "normal", target: "src/api.ts", ok: true, snippet: "ok" });
    appendJsonl(evFile, { ts: 1300, sessionId: sid, agentSource: "cc", eventType: "PostToolUse", cwd: "/workspace/app", toolName: "Bash", opClass: "VERIFY", risk: "normal", target: "npm test", ok: true, snippet: "ok" });

    const res = spawnSync(process.execPath, [sumScript, "--session", sid, "--trigger", "Stop"], { encoding: "utf8", env });
    assert.equal(res.status, 0, res.stderr);

    const snap = JSON.parse(fs.readFileSync(path.join(tmpHome, "sessions", sid, "snapshot.json"), "utf8"));
    assert.equal(snap.briefs.length, 1);
    assert.equal(snap.briefs[0].source, "claude-cli");
    assert.equal(snap.counts.totalEvents, 5);
    assert.ok(snap.touchedFiles.includes("src/concurrent.ts"), "mid-LLM concurrent event was lost!");
    assert.equal(snap.eventsByteOffset, fs.statSync(evFile).size);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpBinDir, { recursive: true, force: true });
  }
});
