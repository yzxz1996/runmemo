#!/usr/bin/env node
/**
 * runmemo CLI · AI 工作简报命令行工具
 * 用法：runmemo <command> [options]
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  getConfigPath,
  getRuntimePaths,
  loadConfig,
  maskConfigForDisplay,
  PACKAGE_ROOT,
  saveConfig,
  setConfigKey,
  unsetConfigKey,
} from "../src/config.mjs";
import {
  inspectCcInstall,
  inspectCodexInstall,
  inspectOpencodeInstall,
  installCcHooks,
  installCodexHooks,
  installOpencodePlugin,
  uninstallCcHooks,
  uninstallCodexHooks,
  uninstallOpencodePlugin,
} from "../src/installer.mjs";
import { detectInstalledAgents, formatDetectionReport, parseAgentSelection } from "../src/detector.mjs";
import { sendFeishuBrief } from "../src/sinks/feishu.mjs";
import { updateHtmlSink } from "../src/sinks/html.mjs";
import { runDemo } from "../src/demo.mjs";

const PKG = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

function printHelp() {
  console.log(`
runmemo v${PKG.version} — AI 工作简报（无感异步监控 Coding Agent，精炼输出到 HTML / 飞书）

用法：
  runmemo <命令> [参数]

核心命令：
  detect [--scope user|project] [--dir <目录>] [--json] [--install]
      实时检测本机已安装的 Coding Agent（仅查 PATH/常见路径与配置目录，不执行 CLI），
      加 --install 可直接勾选并安装钩子

  install [<cc|codex|opencode|all>] [--scope user|project] [--dir <目录>] [-y|--yes] [--dry-run]
      不传目标时自动实时检测本机 Agent 并交互选择；传入目标时直接安装纯旁观钩子/插件：
        cc        Claude Code (~/.claude/settings.json)
        codex     OpenAI Codex CLI (~/.codex/hooks.json + 启用 codex_hooks)
        opencode  OpenCode (~/.config/opencode/plugins/runmemo.js)
        all       一键安装全部三款工具

  uninstall [<cc|codex|opencode|all>] [--scope user|project] [--dir <目录>] [-y|--yes] [--dry-run]
      干净卸载 runmemo 写入的钩子/插件（不传目标时交互选择；保留用户原有配置）

  config [show]
      查看当前配置（自动脱敏 Webhook / 密钥）

  config init
      交互式配置向导（选输出通道、飞书 Webhook、概括 CLI 引擎与模型）

  config set <key> <value>
      修改单项配置，常用示例：
        runmemo config set output html
        runmemo config set output feishu
        runmemo config set output html,feishu
        runmemo config set cli auto             # auto | claude | codex | opencode
        runmemo config set model haiku          # Claude 模型
        runmemo config set codex.model o4-mini  # Codex 概括模型（留空用默认）
        runmemo config set opencode.model openai/gpt-4o-mini
        runmemo config set feishu.webhook https://open.feishu.cn/open-apis/bot/v2/hook/xxx
        runmemo config set feishu.secret <可选签名密钥>
        runmemo config set trigger.intervalSec 45
        runmemo config set trigger.batch 8

  config unset <key>
      恢复某项配置为默认值

  open
      用默认浏览器打开本地 HTML 简报面板

  status
      查看 CC / Codex / OpenCode 安装状态、输出通道与会话统计

  doctor
      检查运行环境、本机 CLI 检测与钩子安装状态（不实际执行 CLI）

  demo [--send-feishu]
      离线模拟 CC / Codex / OpenCode 多会话与子任务（不调真实 CLI），生成预览面板与飞书卡片

  feishu-test
      向已配置的飞书 Webhook 发送一张精炼测试卡片，验证连通性与签名
`);
}

const BOOLEAN_FLAGS = new Set(["dry-run", "json", "yes", "install", "send-feishu", "help", "version"]);

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = args[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith("-") && a.length === 2) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function openFileInBrowser(filePath) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", filePath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
  }
}

function resolveTargets(rawArgs) {
  const items = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
  const tokens = items
    .flatMap((x) => String(x || "").split(/[,，]+/))
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error("请指定目标，可选：cc | codex | opencode | all");
  }

  let hasAgy = false;
  const targets = [];
  const addTarget = (id) => {
    if (!targets.includes(id)) targets.push(id);
  };

  for (const t of tokens) {
    if (t === "agy" || t === "antigravity") {
      hasAgy = true;
    } else if (t === "all") {
      addTarget("cc");
      addTarget("codex");
      addTarget("opencode");
    } else if (t === "cc" || t === "claude" || t === "claude-code") {
      addTarget("cc");
    } else if (t === "codex" || t === "openai-codex") {
      addTarget("codex");
    } else if (t === "opencode" || t === "oc") {
      addTarget("opencode");
    } else {
      throw new Error(`不支持的目标 "${t}"，可选：cc | codex | opencode | all`);
    }
  }

  return { agyNotice: hasAgy && targets.length === 0, hasAgy, targets };
}

function applyInstallTargets(targets, { scope, dir, dryRun }) {
  for (const t of targets) {
    if (t === "cc") {
      const res = installCcHooks({ scope, dir, dryRun });
      if (dryRun) {
        console.log(`[dry-run][cc] ${res.settingsPath} (新增 ${res.added} / 更新 ${res.updated})`);
        console.log(res.previewJson);
      } else {
        console.log(`✅ [Claude Code] 已安装纯旁观 Hooks (${scope})`);
        console.log(`   配置文件: ${res.settingsPath}`);
        console.log(`   挂载事件: ${res.events.join(", ")} (新增 ${res.added} / 更新 ${res.updated})`);
        if (res.backupPath) console.log(`   原配置备份: ${res.backupPath}`);
      }
    } else if (t === "codex") {
      const res = installCodexHooks({ scope, dir, dryRun });
      if (dryRun) {
        console.log(`[dry-run][codex] ${res.hooksPath} (新增 ${res.added} / 更新 ${res.updated})`);
        console.log(res.previewJson);
        if (res.featureFlagUpdated) {
          console.log(`[dry-run][codex] 将在 ${res.configTomlPath} 启用 [features] codex_hooks = true`);
        }
      } else {
        console.log(`✅ [Codex CLI] 已安装纯旁观 Hooks (${scope})`);
        console.log(`   钩子配置: ${res.hooksPath}`);
        console.log(`   挂载事件: ${res.events.join(", ")} (新增 ${res.added} / 更新 ${res.updated})`);
        if (res.backupPath) console.log(`   原配置备份: ${res.backupPath}`);
        if (res.featureFlagUpdated) {
          console.log(`   已自动开启特性: ${res.configTomlPath} (codex_hooks = true)`);
          if (res.configTomlBackupPath) console.log(`   TOML 备份: ${res.configTomlBackupPath}`);
        } else if (res.featureFlagWarning) {
          console.log(`   ⚠️  ${res.featureFlagWarning}`);
        }
      }
    } else if (t === "opencode") {
      const res = installOpencodePlugin({ scope, dir, dryRun });
      if (dryRun) {
        console.log(`[dry-run][opencode] ${res.pluginPath}`);
        console.log(res.previewCode);
      } else {
        console.log(`✅ [OpenCode] 已安装原生插件 (${scope})`);
        console.log(`   插件路径: ${res.pluginPath}`);
        if (res.overwroteUnmanaged && res.backupPath) {
          console.log(`   ⚠️  检测到原有非 runmemo 同名文件，已备份至: ${res.backupPath}`);
        } else if (res.backupPath) {
          console.log(`   原文件备份: ${res.backupPath}`);
        }
      }
    }
  }

  if (!dryRun && targets.length > 0) {
    console.log("下一步：运行 `runmemo config init` 设置 HTML/飞书输出，或直接 `runmemo open` 查看面板。");
  }
}

function applyUninstallTargets(targets, { scope, dir, dryRun }) {
  for (const t of targets) {
    if (t === "cc") {
      const res = uninstallCcHooks({ scope, dir, dryRun });
      if (!res.existed) console.log(`[Claude Code] 未找到 ${res.settingsPath}`);
      else if (res.removed === 0) console.log(`[Claude Code] 未发现 runmemo 钩子 (${res.settingsPath})`);
      else if (dryRun) console.log(`[dry-run][cc] 将移除 ${res.removed} 条 runmemo 钩子 (${res.settingsPath})`);
      else console.log(`✅ [Claude Code] 已干净移除 ${res.removed} 条 runmemo 钩子 (${res.settingsPath})`);
    } else if (t === "codex") {
      const res = uninstallCodexHooks({ scope, dir, dryRun });
      if (!res.existed) console.log(`[Codex CLI] 未找到 ${res.hooksPath}`);
      else if (res.removed === 0) console.log(`[Codex CLI] 未发现 runmemo 钩子 (${res.hooksPath})`);
      else if (dryRun) console.log(`[dry-run][codex] 将移除 ${res.removed} 条 runmemo 钩子 (${res.hooksPath})`);
      else console.log(`✅ [Codex CLI] 已干净移除 ${res.removed} 条 runmemo 钩子 (${res.hooksPath}；config.toml 保持原样未改动)`);
    } else if (t === "opencode") {
      const res = uninstallOpencodePlugin({ scope, dir, dryRun });
      if (!res.existed) console.log(`[OpenCode] 未找到 ${res.pluginPath}`);
      else if (res.skippedUnmanaged) console.log(`⚠️  [OpenCode] ${res.pluginPath} 非 runmemo 托管文件，已跳过`);
      else if (dryRun) console.log(`[dry-run][opencode] 将删除 ${res.pluginPath}`);
      else if (res.removed) console.log(`✅ [OpenCode] 已移除插件 ${res.pluginPath}`);
    }
  }
}

async function promptAgentSelection(selectableAgents, { actionLabel = "安装", defaultMode = "uninstalled-or-all" } = {}) {
  let defaultHint = `回车${actionLabel}全部 ${selectableAgents.length} 项`;
  if (defaultMode === "uninstalled-or-all") {
    const uninstalledCount = selectableAgents.filter((a) => !a.hook?.installed).length;
    if (uninstalledCount > 0 && uninstalledCount < selectableAgents.length) {
      defaultHint = `回车安装未挂载的 ${uninstalledCount} 项`;
    } else if (uninstalledCount === selectableAgents.length) {
      defaultHint = `回车安装全部 ${selectableAgents.length} 项`;
    } else {
      defaultHint = `回车重装/刷新全部 ${selectableAgents.length} 项`;
    }
  }

  const promptText = `请选择要${actionLabel}的 Agent [序号/名称，逗号分隔；${defaultHint}；q 取消]: `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let answer;
      try {
        answer = await rl.question(promptText);
      } catch {
        return { targets: [], cancelled: true, eof: true };
      }
      try {
        return parseAgentSelection(answer, selectableAgents, { defaultMode });
      } catch (err) {
        console.log(`⚠️  ${err.message}`);
        if (attempt === 2) {
          throw err;
        }
      }
    }
    return { targets: [], cancelled: true };
  } finally {
    rl.close();
  }
}

async function runInteractiveInstall(report, { scope, dir, dryRun, yes }) {
  console.log(formatDetectionReport(report, { numbered: true }));
  if (report.detected.length === 0) {
    console.log("\n未发现可自动安装的 Agent。如确定已安装，可手动指定：runmemo install <cc|codex|opencode|all>");
    return;
  }

  if (yes) {
    const targets = report.detected.map((a) => a.id);
    console.log(`\n已开启 -y，自动为检测到的 ${targets.length} 个 Agent 安装：${targets.join(", ")}`);
    applyInstallTargets(targets, { scope, dir, dryRun });
    return;
  }

  console.log("");
  const sel = await promptAgentSelection(report.detected, {
    actionLabel: "安装",
    defaultMode: "uninstalled-or-all",
  });
  if (sel.cancelled || sel.targets.length === 0) {
    console.log(
      sel.eof
        ? "未收到交互输入，已取消安装（可用 `-y` 自动安装全部已检测 Agent，或手动指定 `runmemo install <cc|codex|opencode>`）。"
        : "已取消安装。"
    );
    return;
  }

  applyInstallTargets(sel.targets, { scope, dir, dryRun });
}

async function cmdDetect(flags) {
  const scope = flags.scope === "project" ? "project" : "user";
  const dir = typeof flags.dir === "string" ? flags.dir : process.cwd();
  const cfg = loadConfig();
  const report = detectInstalledAgents({ cfg, scope, dir });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (flags.install || flags.i) {
    await runInteractiveInstall(report, {
      scope,
      dir,
      dryRun: Boolean(flags["dry-run"]),
      yes: Boolean(flags.yes || flags.y),
    });
    return;
  }

  console.log(formatDetectionReport(report, { numbered: false }));
  if (report.detected.length > 0 && report.detected.some((a) => !a.hook.installed)) {
    console.log("\n提示：运行 `runmemo install` 可交互选择上述 Agent 直接安装钩子（或 `runmemo detect --install`）。");
  } else if (report.detected.length > 0) {
    console.log("\n✅ 已检测到的 Agent 均已挂载 runmemo 钩子。");
  } else {
    console.log("\n提示：如已安装但未在 PATH 中，可手动指定安装：`runmemo install cc | codex | opencode | all`。");
  }
}

async function cmdInstall(positional, flags) {
  const scope = flags.scope === "project" ? "project" : "user";
  const dir = typeof flags.dir === "string" ? flags.dir : process.cwd();
  const dryRun = Boolean(flags["dry-run"]);
  const yes = Boolean(flags.yes || flags.y);

  if (positional.length === 0) {
    const cfg = loadConfig();
    const report = detectInstalledAgents({ cfg, scope, dir });
    await runInteractiveInstall(report, { scope, dir, dryRun, yes });
    return;
  }

  const { agyNotice, hasAgy, targets } = resolveTargets(positional);
  if (agyNotice) {
    console.log("提示：当前已支持 Claude Code (cc) / Codex (codex) / OpenCode (opencode)，Antigravity (agy) 将在后续版本接入。");
    return;
  }
  if (hasAgy) {
    console.log("提示：Antigravity (agy) 将在后续版本接入，本次将跳过 agy。");
  }
  applyInstallTargets(targets, { scope, dir, dryRun });
}

async function cmdUninstall(positional, flags) {
  const scope = flags.scope === "project" ? "project" : "user";
  const dir = typeof flags.dir === "string" ? flags.dir : process.cwd();
  const dryRun = Boolean(flags["dry-run"]);
  const yes = Boolean(flags.yes || flags.y);

  if (positional.length === 0) {
    const cfg = loadConfig();
    const report = detectInstalledAgents({ cfg, scope, dir });
    const hooked = report.agents.filter((a) => a.hook.installed);
    if (hooked.length === 0) {
      const scopeLabel = scope === "project" ? `project: ${path.resolve(dir)}` : "user (全局)";
      console.log(`当前范围 (${scopeLabel}) 未发现已安装的 runmemo 钩子。`);
      return;
    }

    const scopeLabel = scope === "project" ? `project: ${path.resolve(dir)}` : "user (全局)";
    console.log(`当前已挂载 runmemo 钩子的 Agent [${scopeLabel}]：`);
    hooked.forEach((a, i) => {
      console.log(`  [${i + 1}] ${a.name} (${a.id}) — ${a.hook.targetPath}`);
    });

    if (yes) {
      applyUninstallTargets(hooked.map((a) => a.id), { scope, dir, dryRun });
      return;
    }

    console.log("");
    const sel = await promptAgentSelection(hooked, { actionLabel: "卸载", defaultMode: "all" });
    if (sel.cancelled || sel.targets.length === 0) {
      console.log("已取消卸载。");
      return;
    }
    applyUninstallTargets(sel.targets, { scope, dir, dryRun });
    return;
  }

  const { agyNotice, targets } = resolveTargets(positional);
  if (agyNotice) {
    console.log("提示：Antigravity (agy) 尚未接入，无需卸载。");
    return;
  }
  applyUninstallTargets(targets, { scope, dir, dryRun });
}

async function cmdConfigInit() {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("runmemo 交互式配置（直接回车保留括号内默认值）\n");

    const curOut = (cfg.outputs || ["html"]).join(",");
    const ansOut = (await rl.question(`1) 输出通道 [html / feishu / html,feishu] (${curOut}): `)).trim();
    let next = cfg;
    if (ansOut) next = setConfigKey(next, "outputs", ansOut).config;

    if (next.outputs.includes("feishu")) {
      const curWh = next.feishu?.webhook ? "已配置，回车保留" : "必填";
      const ansWh = (await rl.question(`2) 飞书自定义机器人 Webhook URL (${curWh}): `)).trim();
      if (ansWh) next = setConfigKey(next, "feishu.webhook", ansWh).config;

      const curSec = next.feishu?.secret ? "已配置，回车保留" : "可选，未开启签名校验直接回车";
      const ansSec = (await rl.question(`3) 飞书签名校验 Secret (${curSec}): `)).trim();
      if (ansSec) next = setConfigKey(next, "feishu.secret", ansSec).config;
    }

    const curTool = next.summarizer?.cli?.tool || "auto";
    const ansTool = (await rl.question(`4) 概括 CLI 引擎 [auto / claude / codex / opencode] (${curTool}): `)).trim();
    if (ansTool) next = setConfigKey(next, "cli", ansTool).config;

    const activeTool = next.summarizer.cli.tool;
    if (activeTool === "codex") {
      const curM = next.summarizer.cli.codexModel || "默认";
      const ansM = (await rl.question(`5) Codex 概括模型（回车沿用默认）(${curM}): `)).trim();
      if (ansM) next = setConfigKey(next, "codex.model", ansM).config;
    } else if (activeTool === "opencode") {
      const curM = next.summarizer.cli.opencodeModel || "默认";
      const ansM = (await rl.question(`5) OpenCode 概括模型 provider/model（回车沿用默认）(${curM}): `)).trim();
      if (ansM) next = setConfigKey(next, "opencode.model", ansM).config;
    } else {
      const curM = next.summarizer.cli.model || "haiku";
      const ansM = (await rl.question(`5) Claude 概括模型 [haiku / sonnet] (${curM}): `)).trim();
      if (ansM) next = setConfigKey(next, "model", ansM).config;
    }

    const saved = saveConfig(next);
    console.log(`\n✅ 配置已保存到 ${saved}`);
    console.log(`   输出通道: ${next.outputs.join(", ")} | 概括 CLI: ${next.summarizer.cli.tool}`);
  } finally {
    rl.close();
  }
}

async function cmdConfig(positional) {
  const sub = positional[0] || "show";
  const cfg = loadConfig();

  if (sub === "show") {
    console.log(`配置文件: ${getConfigPath()}${fs.existsSync(getConfigPath()) ? "" : " (尚未写入，当前展示默认值)"}`);
    console.log(JSON.stringify(maskConfigForDisplay(cfg), null, 2));
    return;
  }
  if (sub === "init") {
    await cmdConfigInit();
    return;
  }
  if (sub === "set") {
    const key = positional[1];
    const val = positional.slice(2).join(" ");
    if (!key || !val) {
      throw new Error("用法：runmemo config set <key> <value>");
    }
    const { config: next, key: canonical, value } = setConfigKey(cfg, key, val);
    const saved = saveConfig(next);
    const displayVal = /webhook|secret|apikey/i.test(canonical) ? "***已保存***" : JSON.stringify(value);
    console.log(`✅ 已更新 ${canonical} = ${displayVal}`);
    console.log(`   文件: ${saved}`);
    if (canonical === "outputs" && value.includes("feishu") && !next.feishu?.webhook) {
      console.log("   提示：已开启飞书输出，别忘了配置 Webhook：");
      console.log("   runmemo config set feishu.webhook https://open.feishu.cn/open-apis/bot/v2/hook/<token>");
    }
    return;
  }
  if (sub === "unset") {
    const key = positional[1];
    if (!key) throw new Error("用法：runmemo config unset <key>");
    const { config: next, key: canonical, value } = unsetConfigKey(cfg, key);
    saveConfig(next);
    console.log(`✅ 已重置 ${canonical} = ${JSON.stringify(value)}`);
    return;
  }
  throw new Error(`未知 config 子命令 "${sub}"，可选：show | init | set | unset`);
}

function fmtInstallLine(label, userSt, projSt, extra = "") {
  const u = userSt.installed ? `全局 ✅` : "全局 ✗";
  const p = projSt.installed ? `项目 ✅` : "项目 ✗";
  console.log(`  ${label.padEnd(10, " ")} : ${u} | ${p}${extra}`);
}

function cmdStatus() {
  const cfg = loadConfig();
  const paths = getRuntimePaths(cfg);
  const ccU = inspectCcInstall({ scope: "user" });
  const ccP = inspectCcInstall({ scope: "project", dir: process.cwd() });
  const cxU = inspectCodexInstall({ scope: "user" });
  const cxP = inspectCodexInstall({ scope: "project", dir: process.cwd() });
  const ocU = inspectOpencodeInstall({ scope: "user" });
  const ocP = inspectOpencodeInstall({ scope: "project", dir: process.cwd() });

  let sessionCount = 0;
  if (fs.existsSync(paths.sessionsDir)) {
    sessionCount = fs.readdirSync(paths.sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  }

  console.log(`runmemo v${PKG.version} 状态总览`);
  console.log(`  数据目录   : ${paths.homeDir}`);
  console.log(`  输出通道   : ${cfg.outputs.join(", ")}`);
  console.log(`  概括 CLI   : ${cfg.summarizer.cli.tool} (claude=${cfg.summarizer.cli.model})`);
  console.log(`  飞书机器人 : ${cfg.feishu.webhook ? "已配置" + (cfg.feishu.secret ? "（含签名校验）" : "") : "未配置"}`);
  console.log(`  HTML 面板  : ${paths.dashboardHtml}${fs.existsSync(paths.dashboardHtml) ? "" : " (尚未生成)"}`);
  console.log(`  历史会话数 : ${sessionCount}`);
  fmtInstallLine("Claude", ccU, ccP);
  const flagHint = cxU.installed ? `  [codex_hooks=${cxU.featureFlagEnabled ? "on" : "off"}]` : cxP.installed ? `  [项目 codex_hooks=${cxP.featureFlagEnabled ? "on" : "off"}]` : "";
  fmtInstallLine("Codex", cxU, cxP, flagHint);
  fmtInstallLine("OpenCode", ocU, ocP);
}

function cmdDoctor() {
  const cfg = loadConfig();
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const userReport = detectInstalledAgents({ cfg, scope: "user", dir: process.cwd() });
  const projReport = detectInstalledAgents({ cfg, scope: "project", dir: process.cwd() });

  const byIdUser = Object.fromEntries(userReport.agents.map((a) => [a.id, a]));
  const byIdProj = Object.fromEntries(projReport.agents.map((a) => [a.id, a]));
  const ccInstalled = byIdUser.cc.hook.installed || byIdProj.cc.hook.installed;
  const cxInstalled = byIdUser.codex.hook.installed || byIdProj.codex.hook.installed;
  const ocInstalled = byIdUser.opencode.hook.installed || byIdProj.opencode.hook.installed;
  const anyInstalled = ccInstalled || cxInstalled || ocInstalled;

  const fmtCliDetail = (a) => {
    if (a.binFound) {
      return a.binSource === "fallback" ? `${a.binPath} (常见路径)` : a.binPath;
    }
    if (a.configDirFound) {
      return `未找到 CLI，仅发现配置目录 ${a.configDir}`;
    }
    return "未在 PATH 或常见路径找到";
  };

  const checks = [
    { ok: nodeMajor >= 18, name: "Node.js >= 18", detail: `v${process.versions.node}` },
    { ok: byIdUser.cc.binFound, name: "claude CLI (实时扫描)", detail: fmtCliDetail(byIdUser.cc) },
    { ok: byIdUser.codex.binFound, name: "codex CLI (实时扫描)", detail: fmtCliDetail(byIdUser.codex) },
    { ok: byIdUser.opencode.binFound, name: "opencode CLI (实时扫描)", detail: fmtCliDetail(byIdUser.opencode) },
    {
      ok: anyInstalled,
      name: "至少安装了一个 Agent 钩子/插件",
      detail: anyInstalled
        ? [ccInstalled ? "CC✅" : "CC✗", cxInstalled ? "Codex✅" : "Codex✗", ocInstalled ? "OpenCode✅" : "OpenCode✗"].join(
            " "
          )
        : "尚未安装，可运行 runmemo install 交互选择安装",
    },
    {
      ok: !cfg.outputs.includes("feishu") || Boolean(cfg.feishu.webhook),
      name: "飞书 Webhook 配置",
      detail: cfg.outputs.includes("feishu")
        ? cfg.feishu.webhook
          ? "已配置"
          : "已开启 feishu 输出但未设置 feishu.webhook"
        : "未启用飞书输出（跳过）",
    },
  ];

  console.log("runmemo 环境自检：");
  for (const c of checks) {
    console.log(`  ${c.ok ? "✅" : "⚠️ "} ${c.name} — ${c.detail}`);
  }
}

function cmdOpen() {
  const cfg = loadConfig();
  const htmlPath = updateHtmlSink(cfg);
  console.log(`打开 HTML 面板: ${htmlPath}`);
  openFileInBrowser(htmlPath);
}

async function cmdFeishuTest() {
  const cfg = loadConfig();
  if (!cfg.feishu.webhook) {
    throw new Error("尚未配置 feishu.webhook，请先执行：runmemo config set feishu.webhook <URL>");
  }
  const sampleSession = {
    sessionId: "feishu-test",
    agentSource: "codex",
    projectName: "runmemo-check",
    status: "idle",
    tier: "L2",
    durationSec: 18,
    subagents: [
      { agentType: "backend-coder", status: "done" },
      { agentType: "e2e-runner", status: "done" },
    ],
  };
  const sampleBrief = {
    title: "飞书简报通道连通测试成功",
    status: "ok",
    trigger: "Stop",
    bullets: [
      "卡片配色、签名校验与 Webhook 推送正常",
      "支持 CC / Codex / OpenCode 来源标识与阶段要点推送",
    ],
    files: ["src/sinks/feishu.mjs"],
    check: "Webhook 200 OK",
    alert: "",
    eventRange: [1, 2],
  };
  const res = await sendFeishuBrief(sampleSession, sampleBrief, cfg);
  if (!res.sent) {
    throw new Error(`发送失败：${res.reason}`);
  }
  console.log("✅ 飞书测试卡片发送成功，请在群里查看排版效果。");
}

async function cmdDemo(flags) {
  const sendFeishu = Boolean(flags["send-feishu"]);
  const res = await runDemo({ sendFeishu });
  console.log("✅ 离线多工具演示完成（未调用真实 CLI）");
  console.log(`   1) CC · L0 闲聊 : tier=${res.chatSnap.tier}, 简报=${res.chatSnap.briefs.length} (静默跳过)`);
  console.log(
    `   2) CC · L3 发布 : tier=${res.relSnap.tier}, 子任务=${res.relSnap.subagents.length}, 变更=${res.relSnap.counts.mutate}, 验证=${res.relSnap.counts.verify}, 简报=${res.relSnap.briefs.length}`
  );
  console.log(
    `   3) Codex · L2   : tier=${res.codexSnap.tier}, 文件=${res.codexSnap.touchedFiles.join(",")}, 验证=${res.codexSnap.counts.verify}, 简报=${res.codexSnap.briefs.length}`
  );
  console.log(
    `   4) OpenCode · L2: tier=${res.opencodeSnap.tier}, 子任务=${res.opencodeSnap.subagents.length}, 变更=${res.opencodeSnap.counts.mutate}, 验证=${res.opencodeSnap.counts.verify}, 简报=${res.opencodeSnap.briefs.length}`
  );
  console.log(`   5) HTML 面板预览: ${res.dashboardHtml}`);
  console.log(`   6) 飞书卡片预览 : ${res.feishuPreviewPath}`);
  if (sendFeishu) {
    console.log(
      res.feishuSendResult?.sent
        ? "   7) 飞书实发测试 : ✅ 发送成功"
        : `   7) 飞书实发测试 : ⚠️ ${res.feishuSendResult?.reason || "未发送"}`
    );
  }
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0];

  if (cmd === "version" || flags.version || flags.v) {
    console.log(`runmemo v${PKG.version}`);
    return;
  }
  if (!cmd || cmd === "help" || flags.help || flags.h) {
    printHelp();
    return;
  }

  switch (cmd) {
    case "detect":
      await cmdDetect(flags);
      break;
    case "install":
      await cmdInstall(positional.slice(1), flags);
      break;
    case "uninstall":
      await cmdUninstall(positional.slice(1), flags);
      break;
    case "config":
      await cmdConfig(positional.slice(1));
      break;
    case "status":
      cmdStatus();
      break;
    case "doctor":
      cmdDoctor();
      break;
    case "open":
      cmdOpen();
      break;
    case "feishu-test":
      await cmdFeishuTest();
      break;
    case "demo":
      await cmdDemo(flags);
      break;
    default:
      console.error(`未知命令 "${cmd}"，运行 runmemo --help 查看可用命令。`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exitCode = 1;
});
