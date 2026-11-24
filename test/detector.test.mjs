import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCliBin } from "../src/cli-bin.mjs";
import {
  detectInstalledAgents,
  formatDetectionReport,
  parseAgentSelection,
} from "../src/detector.mjs";
import { installCcHooks, uninstallCcHooks } from "../src/installer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI_BIN = path.join(ROOT, "bin", "runmemo.mjs");

function createFakeStub(dir, name, platform = process.platform) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, platform === "win32" ? `${name}.cmd` : name);
  const body = platform === "win32" ? "@echo off\r\necho stub\r\n" : "#!/bin/sh\necho stub\n";
  fs.writeFileSync(filePath, body, "utf8");
  if (platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

function buildIsolatedEnv({ pathDir, homeDir, memoHome }) {
  const env = {};
  const blocked = new Set([
    "path",
    "home",
    "userprofile",
    "codex_home",
    "xdg_config_home",
    "appdata",
    "localappdata",
    "runmemo_home",
  ]);
  for (const [k, v] of Object.entries(process.env)) {
    if (!blocked.has(k.toLowerCase())) {
      env[k] = v;
    }
  }
  env.PATH = pathDir;
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.APPDATA = path.join(homeDir, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(homeDir, "AppData", "Local");
  env.RUNMEMO_HOME = memoHome;
  return env;
}

test("resolveCliBin ignores directory collisions, strips quoted PATH segments, and respects ignoreCache", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-bin-res-"));
  try {
    const p1 = path.join(tmp, "p1");
    const p2 = path.join(tmp, "p2");
    const collisionName = process.platform === "win32" ? "claude.exe" : "claude";
    fs.mkdirSync(path.join(p1, collisionName), { recursive: true });

    const realStub = createFakeStub(p2, "claude");
    const pathEnv = `"${p1}"${path.delimiter}${p2}`;
    const res = resolveCliBin("claude", null, { pathEnv, ignoreCache: true });
    assert.equal(res.found, true);
    assert.equal(res.bin, realStub);

    // 删除 stub 后启用 ignoreCache 必须实时反映未找到
    fs.unlinkSync(realStub);
    const resAfter = resolveCliBin("claude", null, { pathEnv, ignoreCache: true });
    assert.equal(resAfter.found, false);

    // 显式绝对路径不存在时不得回落到 PATH 扫描
    const missingAbs = resolveCliBin(path.join(tmp, "missing-claude"), null, {
      pathEnv: p2,
      ignoreCache: true,
    });
    assert.equal(missingAbs.found, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectInstalledAgents performs real-time detection of PATH binaries, fallback paths, config dirs, and hook state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-det-unit-"));
  try {
    const homeDir = path.join(tmp, "home");
    const pathDir = path.join(tmp, "path-bin");
    const projDir = path.join(tmp, "proj");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(pathDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    const env = {
      APPDATA: path.join(homeDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
    };

    // 1. 全空环境
    const emptyReport = detectInstalledAgents({
      scope: "project",
      dir: projDir,
      pathEnv: pathDir,
      homeDir,
      env,
      includeSystemFallbacks: false,
    });
    assert.equal(emptyReport.detected.length, 0);
    assert.equal(emptyReport.notDetected.length, 3);
    assert.ok(emptyReport.agents.every((a) => a.status === "not-found"));

    // 2. 混合环境：PATH 中的 claude、常见路径中的 opencode、仅配置目录的 .codex、以及暂未接入的 .gemini/antigravity
    createFakeStub(pathDir, "claude");
    const ocFallback =
      process.platform === "win32"
        ? path.join(homeDir, ".opencode", "bin", "opencode.exe")
        : path.join(homeDir, ".opencode", "bin", "opencode");
    fs.mkdirSync(path.dirname(ocFallback), { recursive: true });
    fs.writeFileSync(ocFallback, "stub", "utf8");
    if (process.platform !== "win32") fs.chmodSync(ocFallback, 0o755);

    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".gemini", "antigravity"), { recursive: true });

    const mixed = detectInstalledAgents({
      scope: "project",
      dir: projDir,
      pathEnv: pathDir,
      homeDir,
      env,
      includeSystemFallbacks: false,
    });
    assert.equal(mixed.detected.length, 3);
    const byId = Object.fromEntries(mixed.agents.map((a) => [a.id, a]));
    assert.equal(byId.cc.status, "installed");
    assert.equal(byId.cc.binSource, "path");
    assert.equal(byId.codex.status, "config-only");
    assert.equal(byId.codex.configDirFound, true);
    assert.equal(byId.opencode.status, "installed");
    assert.equal(byId.opencode.binSource, "fallback");
    assert.equal(byId.cc.hook.installed, false);

    // 暂未支持的 Antigravity 只进 unsupportedDetected，不污染可选列表
    assert.equal(mixed.unsupportedDetected.length, 1);
    assert.equal(mixed.unsupportedDetected[0].id, "agy");

    // 3. 实时性：新增 codex 二进制后立即变为 installed；安装与卸载 CC 钩子后状态实时变化
    const codexStub = createFakeStub(pathDir, "codex");
    installCcHooks({ scope: "project", dir: projDir });

    const updated = detectInstalledAgents({
      scope: "project",
      dir: projDir,
      pathEnv: pathDir,
      homeDir,
      env,
      includeSystemFallbacks: false,
    });
    const byId2 = Object.fromEntries(updated.agents.map((a) => [a.id, a]));
    assert.equal(byId2.codex.status, "installed");
    assert.equal(byId2.cc.hook.installed, true);

    const formatted = formatDetectionReport(updated, { numbered: true });
    assert.ok(formatted.includes("[1] Claude Code (cc)"));
    assert.ok(formatted.includes("[钩子: 已安装 ✅]"));
    assert.ok(formatted.includes("Antigravity (agy)"));

    fs.unlinkSync(codexStub);
    uninstallCcHooks({ scope: "project", dir: projDir });
    const reverted = detectInstalledAgents({
      scope: "project",
      dir: projDir,
      pathEnv: pathDir,
      homeDir,
      env,
      includeSystemFallbacks: false,
    });
    const byId3 = Object.fromEntries(reverted.agents.map((a) => [a.id, a]));
    assert.equal(byId3.codex.status, "config-only");
    assert.equal(byId3.cc.hook.installed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseAgentSelection parses numbers, aliases, defaults, cancel tokens, and rejects invalid inputs", () => {
  const sample = [
    { id: "cc", aliases: ["cc", "claude"], hook: { installed: true } },
    { id: "codex", aliases: ["codex"], hook: { installed: false } },
    { id: "opencode", aliases: ["opencode", "oc"], hook: { installed: false } },
  ];

  // 空回车优先选中未挂载的 Agent
  assert.deepEqual(parseAgentSelection("", sample), {
    targets: ["codex", "opencode"],
    cancelled: false,
    isDefault: true,
  });

  // 全部已挂载时，空回车回落全部
  const allInstalled = sample.map((a) => ({ ...a, hook: { installed: true } }));
  assert.deepEqual(parseAgentSelection("", allInstalled), {
    targets: ["cc", "codex", "opencode"],
    cancelled: false,
    isDefault: true,
  });

  // 卸载模式 defaultMode="all" 默认选全部
  assert.deepEqual(parseAgentSelection("", sample, { defaultMode: "all" }), {
    targets: ["cc", "codex", "opencode"],
    cancelled: false,
    isDefault: true,
  });

  assert.deepEqual(parseAgentSelection("2", sample).targets, ["codex"]);
  assert.deepEqual(parseAgentSelection("1,3", sample).targets, ["cc", "opencode"]);
  assert.deepEqual(parseAgentSelection("1，2", sample).targets, ["cc", "codex"]);
  assert.deepEqual(parseAgentSelection("oc claude 1", sample).targets, ["opencode", "cc"]);
  assert.deepEqual(parseAgentSelection("all", sample).targets, ["cc", "codex", "opencode"]);
  assert.equal(parseAgentSelection("q", sample).cancelled, true);
  assert.equal(parseAgentSelection("0", sample).cancelled, true);

  assert.throws(() => parseAgentSelection("9", sample), /超出范围/);
  assert.throws(() => parseAgentSelection("unknown", sample), /无法识别/);
});

test("CLI detect & interactive install / uninstall work end-to-end in isolated directories", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-det-cli-"));
  try {
    const homeDir = path.join(tmp, "home");
    const binDir = path.join(tmp, "bin");
    const projDir = path.join(tmp, "proj");
    const memoHome = path.join(tmp, "runmemo-home");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    // 在隔离环境放置假的 claude 与 codex，确保不触及用户真实配置且不执行任何外部 CLI
    createFakeStub(binDir, "claude");
    createFakeStub(binDir, "codex");
    const env = buildIsolatedEnv({ pathDir: binDir, homeDir, memoHome });

    // 1. runmemo detect --json
    const detectRes = spawnSync(process.execPath, [CLI_BIN, "detect", "--json", "--scope", "project", "--dir", projDir], {
      encoding: "utf8",
      env,
    });
    assert.equal(detectRes.status, 0, detectRes.stderr);
    const report = JSON.parse(detectRes.stdout);
    const detectedIds = report.detected.map((a) => a.id);
    assert.ok(detectedIds.includes("cc"));
    assert.ok(detectedIds.includes("codex"));
    assert.equal(detectedIds[0], "cc");
    if (process.platform === "win32") {
      assert.deepEqual(detectedIds, ["cc", "codex"]);
    }

    // 2. 交互安装选 "1" -> 只装第一个检测到的 (cc)
    const inst1 = spawnSync(process.execPath, [CLI_BIN, "install", "--scope", "project", "--dir", projDir], {
      encoding: "utf8",
      env,
      input: "1\n",
    });
    assert.equal(inst1.status, 0, inst1.stderr);
    assert.equal(fs.existsSync(path.join(projDir, ".claude", "settings.json")), true);
    assert.equal(fs.existsSync(path.join(projDir, ".codex", "hooks.json")), false);

    // 3. 再次交互安装输入 q -> 取消，不写入 codex
    const instCancel = spawnSync(process.execPath, [CLI_BIN, "install", "--scope", "project", "--dir", projDir], {
      encoding: "utf8",
      env,
      input: "q\n",
    });
    assert.equal(instCancel.status, 0, instCancel.stderr);
    assert.ok(instCancel.stdout.includes("已取消安装"));
    assert.equal(fs.existsSync(path.join(projDir, ".codex", "hooks.json")), false);

    // 4. 空 stdin EOF 不挂起、干净退出并取消
    const instEof = spawnSync(process.execPath, [CLI_BIN, "install", "--scope", "project", "--dir", projDir], {
      encoding: "utf8",
      env,
      input: "",
    });
    assert.equal(instEof.status, 0, instEof.stderr);
    assert.equal(fs.existsSync(path.join(projDir, ".codex", "hooks.json")), false);

    // 5. 回车默认值：cc 已装而 codex 未装，直接回车只装未挂载的 codex
    const instDefault = spawnSync(process.execPath, [CLI_BIN, "install", "--scope", "project", "--dir", projDir], {
      encoding: "utf8",
      env,
      input: "\n",
    });
    assert.equal(instDefault.status, 0, instDefault.stderr);
    assert.equal(fs.existsSync(path.join(projDir, ".codex", "hooks.json")), true);

    // 6. --dry-run 前置布尔 flag 不吞参数测试
    const dryRes = spawnSync(
      process.execPath,
      [CLI_BIN, "install", "--dry-run", "cc", "--scope", "project", "--dir", projDir],
      { encoding: "utf8", env }
    );
    assert.equal(dryRes.status, 0, dryRes.stderr);
    assert.ok(dryRes.stdout.includes("[dry-run][cc]"));

    // 7. 交互卸载选 "1" -> 只卸载 cc，保留 codex
    const uninst1 = spawnSync(process.execPath, [CLI_BIN, "uninstall", "--scope", "project", "--dir", projDir], {
      encoding: "utf8",
      env,
      input: "1\n",
    });
    assert.equal(uninst1.status, 0, uninst1.stderr);
    const ccAfter = JSON.parse(fs.readFileSync(path.join(projDir, ".claude", "settings.json"), "utf8"));
    assert.equal(ccAfter.hooks, undefined);
    const cxAfter = JSON.parse(fs.readFileSync(path.join(projDir, ".codex", "hooks.json"), "utf8"));
    assert.ok(Array.isArray(cxAfter.hooks.Stop) && cxAfter.hooks.Stop.length > 0);

    // 8. runmemo install -y 一键为全部已检测 Agent 安装
    const instYes = spawnSync(process.execPath, [CLI_BIN, "install", "-y", "--scope", "project", "--dir", projDir], {
      encoding: "utf8",
      env,
    });
    assert.equal(instYes.status, 0, instYes.stderr);
    const ccReinstalled = JSON.parse(fs.readFileSync(path.join(projDir, ".claude", "settings.json"), "utf8"));
    assert.ok(Array.isArray(ccReinstalled.hooks?.Stop));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
