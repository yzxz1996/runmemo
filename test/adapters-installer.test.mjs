import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installCcHooks,
  installCodexHooks,
  installOpencodePlugin,
  uninstallCcHooks,
  uninstallCodexHooks,
  uninstallOpencodePlugin,
} from "../src/installer.mjs";
import { RunmemoPlugin } from "../src/plugin-opencode.mjs";
import { readJsonlSafe } from "../src/core.mjs";
import { buildFeishuCardPayload, generateFeishuSign } from "../src/sinks/feishu.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("isolated install / 2x idempotency / uninstall works for CC, Codex (BOM & TOML), and OpenCode", async () => {
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-inst-"));
  try {
    fs.mkdirSync(path.join(tmpProj, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmpProj, ".codex"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpProj, ".claude/settings.json"),
      "\uFEFF" + JSON.stringify({ env: { KEEP: "1" }, hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo cc" }] }] } }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpProj, ".codex/hooks.json"),
      "\uFEFF" + JSON.stringify({ hooks: { PostToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "echo cx" }] }] } }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpProj, ".codex/config.toml"),
      "\uFEFFmodel = \"gpt-5-codex\"\n\n[features]\nhooks = false\n",
      "utf8"
    );

    // 安装 2 次验证幂等
    installCcHooks({ scope: "project", dir: tmpProj });
    installCcHooks({ scope: "project", dir: tmpProj });
    installCodexHooks({ scope: "project", dir: tmpProj });
    installCodexHooks({ scope: "project", dir: tmpProj });
    const ocRes1 = installOpencodePlugin({ scope: "project", dir: tmpProj });
    const ocRes2 = installOpencodePlugin({ scope: "project", dir: tmpProj });

    assert.equal(ocRes1.overwroteUnmanaged, false);
    assert.equal(ocRes2.unchanged, true);

    const ccData = JSON.parse(fs.readFileSync(path.join(tmpProj, ".claude/settings.json"), "utf8"));
    assert.equal(ccData.hooks.PostToolUse.length, 2);

    const cxData = JSON.parse(fs.readFileSync(path.join(tmpProj, ".codex/hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(cxData), ["hooks"]);
    assert.equal(cxData.hooks.PostToolUse.length, 2);

    const toml = fs.readFileSync(path.join(tmpProj, ".codex/config.toml"), "utf8");
    assert.ok(toml.includes("hooks = true"));
    assert.ok(!toml.includes("hooks = false"));
    assert.ok(toml.includes("codex_hooks = true"));

    // OpenCode shim 只能具名导出 RunmemoPlugin 且注入 RUNMEMO_NODE_BIN（复制到 .mjs 以兼容 Node 18 无 package.json 临时目录导入）
    const ocPath = path.join(tmpProj, ".opencode/plugins/runmemo.js");
    const ocText = fs.readFileSync(ocPath, "utf8");
    assert.ok(ocText.includes("RUNMEMO_NODE_BIN"));
    const verifyShimPath = path.join(tmpProj, "verify-opencode-shim.mjs");
    fs.writeFileSync(verifyShimPath, ocText, "utf8");
    const ocMod = await import(pathToFileURL(verifyShimPath).href);
    assert.equal(typeof ocMod.RunmemoPlugin, "function");
    assert.equal(ocMod.default, undefined);

    // 卸载验证
    uninstallCcHooks({ scope: "project", dir: tmpProj });
    uninstallCodexHooks({ scope: "project", dir: tmpProj });
    uninstallOpencodePlugin({ scope: "project", dir: tmpProj });

    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpProj, ".claude/settings.json"), "utf8")).hooks.PostToolUse.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpProj, ".codex/hooks.json"), "utf8")).hooks.PostToolUse.length, 1);
    assert.equal(fs.existsSync(ocPath), false);

    // 内联 features = { ... } 保守跳过，不破坏原有 TOML
    const inlineToml = path.join(tmpProj, ".codex/config.toml");
    fs.writeFileSync(inlineToml, 'features = { some_flag = true }\n', "utf8");
    const inlineRes = installCodexHooks({ scope: "project", dir: tmpProj });
    assert.equal(inlineRes.featureFlagUpdated, false);
    assert.ok(inlineRes.featureFlagWarning.includes("内联"));

    // 非托管 OpenCode 同名文件不会被 uninstall 删除，安装时会明确标记 overwroteUnmanaged
    fs.mkdirSync(path.dirname(ocPath), { recursive: true });
    fs.writeFileSync(ocPath, "export default async () => ({});\n", "utf8");
    const unRes = uninstallOpencodePlugin({ scope: "project", dir: tmpProj });
    assert.equal(unRes.skippedUnmanaged, true);
    assert.equal(fs.existsSync(ocPath), true);
    const overRes = installOpencodePlugin({ scope: "project", dir: tmpProj });
    assert.equal(overRes.overwroteUnmanaged, true);
    assert.ok(fs.existsSync(overRes.backupPath));
  } finally {
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }
});

test("RunmemoPlugin captures user prompt from message.part.updated without role, ignores assistant parts, tracks child & error", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-oc-plugin-"));
  const prevHome = process.env.RUNMEMO_HOME;
  const prevSkip = process.env.RUNMEMO_SKIP_SPAWN;
  const prevInternal = process.env.RUNMEMO_INTERNAL;

  try {
    // 递归防爆检查
    process.env.RUNMEMO_INTERNAL = "1";
    assert.deepEqual(await RunmemoPlugin({ directory: tmpHome }), {});
    delete process.env.RUNMEMO_INTERNAL;

    process.env.RUNMEMO_HOME = tmpHome;
    process.env.RUNMEMO_SKIP_SPAWN = "1";

    const hooks = await RunmemoPlugin({ directory: "/workspace/demo-app" });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "oc_root" } } } });

    // 先来一条不带 text 的 user message.updated，再来一条不带 role 的 message.part.updated
    await hooks.event({
      event: { type: "message.updated", properties: { info: { id: "msg_user_1", sessionID: "oc_root", role: "user" } } },
    });
    await hooks.event({
      event: { type: "message.part.updated", properties: { part: { type: "text", text: "帮我修登录 Bug", messageID: "msg_user_1", sessionID: "oc_root" } } },
    });

    // 助手文本不能误算成用户提问
    await hooks.event({
      event: { type: "message.updated", properties: { info: { id: "msg_asst_1", sessionID: "oc_root", role: "assistant" } } },
    });
    await hooks.event({
      event: { type: "message.part.updated", properties: { part: { type: "text", text: "好的我来看看", messageID: "msg_asst_1", sessionID: "oc_root" } } },
    });

    // 子任务 + 错误事件
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: "oc_child", parentID: "oc_root", title: "e2e-sub" } } },
    });
    await hooks.event({
      event: { type: "session.error", properties: { sessionID: "oc_child", error: { message: "Playwright timeout" } } },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "oc_child" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "oc_root" } } });

    const events = readJsonlSafe(path.join(tmpHome, "sessions/oc_root/events.jsonl"));
    const prompts = events.filter((e) => e.eventType === "UserPromptSubmit");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].prompt, "帮我修登录 Bug");
    assert.ok(events.some((e) => e.eventType === "SubagentStart" && e.agentId === "oc_child"));
    assert.ok(events.some((e) => e.eventType === "PostToolUseFailure" && e.agentId === "oc_child" && e.snippet.includes("Playwright timeout")));
    assert.ok(events.some((e) => e.eventType === "SubagentStop" && e.agentId === "oc_child"));
    assert.ok(events.some((e) => e.eventType === "Stop"));

    // 确认 CLI --dry-run 不调用真实外部二进制且退出 0
    const dryRes = spawnSync(process.execPath, [path.join(ROOT, "bin/runmemo.mjs"), "install", "all", "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, RUNMEMO_HOME: tmpHome },
    });
    assert.equal(dryRes.status, 0);
  } finally {
    if (prevHome === undefined) delete process.env.RUNMEMO_HOME;
    else process.env.RUNMEMO_HOME = prevHome;
    if (prevSkip === undefined) delete process.env.RUNMEMO_SKIP_SPAWN;
    else process.env.RUNMEMO_SKIP_SPAWN = prevSkip;
    if (prevInternal === undefined) delete process.env.RUNMEMO_INTERNAL;
    else process.env.RUNMEMO_INTERNAL = prevInternal;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Feishu card payload omits empty fields, sets source label, and signs correctly", () => {
  const { timestamp, sign } = generateFeishuSign("sec-123", 1700000000000);
  assert.equal(timestamp, "1700000000");
  assert.ok(sign.length > 20);

  const card = buildFeishuCardPayload(
    { sessionId: "s1", agentSource: "codex", projectName: "auth-gw", tier: "L2", durationSec: 12, status: "idle" },
    { title: "修复 JWT 偏差", status: "ok", trigger: "Stop", bullets: ["更新 leeway=30s"], files: [], check: "", alert: "" },
    "sec-123"
  );
  const raw = JSON.stringify(card);
  assert.ok(raw.includes("Codex · L2 · 12s"));
  assert.ok(!raw.includes("暂无"));
  assert.ok(!raw.includes("无明显风险"));
  assert.ok(card.timestamp && card.sign);
});
