import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyTool, extractPatchFiles, extractTarget, redactSecrets } from "../src/classify.mjs";
import { appendJsonl, foldIntoSession, materializeSession, readJsonlFromOffset } from "../src/core.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

test("classifyTool handles Claude Code, Codex, and OpenCode tools uniformly", () => {
  assert.deepEqual(classifyTool("Edit", { file_path: "src/app.ts" }), { opClass: "MUTATE", risk: "normal" });
  assert.deepEqual(classifyTool("edit", { filePath: "src/app.ts" }), { opClass: "MUTATE", risk: "normal" });
  assert.deepEqual(classifyTool("Read", { file_path: "src/app.ts" }), { opClass: "READ", risk: "normal" });
  assert.deepEqual(classifyTool("read", { filePath: "src/app.ts" }), { opClass: "READ", risk: "normal" });
  assert.deepEqual(
    classifyTool("apply_patch", { input: "*** Begin Patch\n*** Update File: db/migration.sql\n*** End Patch" }),
    { opClass: "MUTATE", risk: "high" }
  );
  assert.deepEqual(classifyTool("shell", { command: "pytest tests/ -q" }), { opClass: "VERIFY", risk: "normal" });
  assert.deepEqual(classifyTool("bash", { command: "kubectl apply -f prod.yaml" }), { opClass: "MUTATE", risk: "high" });
  assert.deepEqual(classifyTool("bash", { command: "git status" }), { opClass: "READ", risk: "normal" });
});

test("extractPatchFiles parses multi-file apply_patch targets", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: /workspace/app/src/auth/jwt.ts",
    "*** Add File: /workspace/app/tests/jwt.test.ts",
    "*** Delete File: /workspace/app/src/auth/old.ts",
    "*** Update File: /workspace/app/src/auth/jwt.ts",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(extractPatchFiles(patch, "/workspace/app"), [
    "src/auth/jwt.ts",
    "tests/jwt.test.ts",
    "src/auth/old.ts",
  ]);
  assert.equal(
    extractTarget("apply_patch", { input: patch }, "/workspace/app"),
    "src/auth/jwt.ts, tests/jwt.test.ts, src/auth/old.ts"
  );
});

test("redactSecrets masks common tokens and credentials", () => {
  const raw =
    "Bearer eyJhbGciOi.abc123 sk-proj_1234567890abcdef ghp_1234567890123456789012 " +
    "github_pat_11ABC_12345678901234567890 AKIAIOSFODNN7EXAMPLE xoxb-12345-67890 password=mysecretpass";
  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes("eyJhbGciOi"));
  assert.ok(!redacted.includes("sk-proj_"));
  assert.ok(!redacted.includes("ghp_123456"));
  assert.ok(!redacted.includes("github_pat_11ABC"));
  assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!redacted.includes("xoxb-12345"));
  assert.ok(!redacted.includes("mysecretpass"));
});

test("readJsonlFromOffset + foldIntoSession matches full materializeSession with UTF-8 and reset", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-core-"));
  try {
    const evFile = path.join(tmp, "events.jsonl");
    const events = [
      { ts: 1000, sessionId: "s1", agentSource: "codex", eventType: "SessionStart", cwd: "/workspace/order" },
      { ts: 1100, sessionId: "s1", agentSource: "codex", eventType: "UserPromptSubmit", cwd: "/workspace/order", prompt: "修复中文订单超时锁" },
      { ts: 1200, sessionId: "s1", agentSource: "codex", eventType: "PostToolUse", cwd: "/workspace/order", toolName: "apply_patch", opClass: "MUTATE", risk: "normal", target: "src/订单.ts, src/锁.ts", ok: true, snippet: "更新 2 文件" },
      { ts: 1300, sessionId: "s1", agentSource: "codex", eventType: "PostToolUse", cwd: "/workspace/order", toolName: "shell", opClass: "VERIFY", risk: "normal", target: "pytest", ok: true, snippet: "24 passed" },
      { ts: 1400, sessionId: "s1", agentSource: "codex", eventType: "SessionEnd", cwd: "/workspace/order" },
    ];

    let snap = null;
    let offset = 0;
    for (const batch of [events.slice(0, 2), events.slice(2, 4), events.slice(4)]) {
      for (const ev of batch) appendJsonl(evFile, ev);
      const r = readJsonlFromOffset(evFile, offset);
      assert.equal(r.items.length, batch.length);
      snap = foldIntoSession(snap, "s1", r.items, [], DEFAULT_CONFIG);
      offset = r.nextOffset;
    }

    const full = materializeSession("s1", events, [], DEFAULT_CONFIG);
    assert.deepEqual(snap, full);
    assert.deepEqual(snap.touchedFiles, ["src/订单.ts", "src/锁.ts"]);
    assert.equal(snap.status, "idle");

    // 验证文件被外部截断时正确触发 reset=true
    fs.writeFileSync(evFile, JSON.stringify(events[0]) + "\n", "utf8");
    const resetRead = readJsonlFromOffset(evFile, offset);
    assert.equal(resetRead.reset, true);
    assert.equal(resetRead.items.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
