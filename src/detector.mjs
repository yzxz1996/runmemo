import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isExecutableFile, resolveCliBin } from "./cli-bin.mjs";
import {
  inspectCcInstall,
  inspectCodexInstall,
  inspectOpencodeInstall,
  resolveCcSettingsPath,
  resolveCodexDir,
  resolveOpencodePluginPath,
} from "./installer.mjs";

export const SUPPORTED_AGENTS = [
  {
    id: "cc",
    name: "Claude Code",
    aliases: ["cc", "claude", "claude-code"],
    binConfigKey: "bin",
    defaultBin: "claude",
  },
  {
    id: "codex",
    name: "Codex CLI",
    aliases: ["codex", "openai-codex"],
    binConfigKey: "codexBin",
    defaultBin: "codex",
  },
  {
    id: "opencode",
    name: "OpenCode",
    aliases: ["opencode", "oc"],
    binConfigKey: "opencodeBin",
    defaultBin: "opencode",
  },
];

function isExistingDir(dirPath) {
  if (!dirPath) return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getFallbackBinCandidates(agentId, { homeDir, env, platform, includeSystemFallbacks }) {
  const candidates = [];
  if (agentId === "cc") {
    if (platform === "win32") {
      candidates.push(
        path.join(homeDir, ".local", "bin", "claude.exe"),
        path.join(homeDir, ".claude", "local", "claude.exe")
      );
      if (env.LOCALAPPDATA) {
        candidates.push(path.join(env.LOCALAPPDATA, "Programs", "claude", "claude.exe"));
      }
      if (env.APPDATA) {
        candidates.push(path.join(env.APPDATA, "npm", "claude.cmd"));
      }
    } else {
      candidates.push(
        path.join(homeDir, ".local", "bin", "claude"),
        path.join(homeDir, ".claude", "local", "claude")
      );
      if (includeSystemFallbacks) {
        candidates.push("/usr/local/bin/claude", "/opt/homebrew/bin/claude");
      }
    }
  } else if (agentId === "codex") {
    if (platform === "win32") {
      if (env.APPDATA) {
        candidates.push(path.join(env.APPDATA, "npm", "codex.cmd"));
      }
      candidates.push(path.join(homeDir, ".local", "bin", "codex.exe"));
    } else {
      candidates.push(path.join(homeDir, ".local", "bin", "codex"));
      if (includeSystemFallbacks) {
        candidates.push("/usr/local/bin/codex", "/opt/homebrew/bin/codex");
      }
    }
  } else if (agentId === "opencode") {
    if (platform === "win32") {
      candidates.push(path.join(homeDir, ".opencode", "bin", "opencode.exe"));
      if (env.APPDATA) {
        candidates.push(path.join(env.APPDATA, "npm", "opencode.cmd"));
      }
      candidates.push(path.join(homeDir, ".local", "bin", "opencode.exe"));
    } else {
      candidates.push(
        path.join(homeDir, ".opencode", "bin", "opencode"),
        path.join(homeDir, ".local", "bin", "opencode")
      );
      if (includeSystemFallbacks) {
        candidates.push("/usr/local/bin/opencode", "/opt/homebrew/bin/opencode");
      }
    }
  }
  return [...new Set(candidates)];
}

function getConfigDirCandidates(agentId, { homeDir, env }) {
  if (agentId === "cc") {
    return [path.join(homeDir, ".claude")];
  }
  if (agentId === "codex") {
    return [env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, ".codex")];
  }
  if (agentId === "opencode") {
    const configRoot = env.XDG_CONFIG_HOME
      ? path.resolve(env.XDG_CONFIG_HOME)
      : path.join(homeDir, ".config");
    return [path.join(configRoot, "opencode"), path.join(homeDir, ".opencode")];
  }
  return [];
}

function inspectHookStatus(agentId, { scope, dir, homeDir, env }) {
  if (agentId === "cc") {
    const st = inspectCcInstall({ scope, dir, homeDir });
    return {
      installed: Boolean(st.installed),
      complete: Boolean(st.complete),
      targetPath: st.settingsPath || resolveCcSettingsPath({ scope, dir, homeDir }),
      ...(st.error ? { error: st.error } : {}),
    };
  }
  if (agentId === "codex") {
    const st = inspectCodexInstall({ scope, dir, homeDir, env });
    return {
      installed: Boolean(st.installed),
      complete: Boolean(st.complete),
      targetPath: st.hooksPath || path.join(resolveCodexDir({ scope, dir, homeDir, env }), "hooks.json"),
      featureFlagEnabled: Boolean(st.featureFlagEnabled),
      ...(st.error ? { error: st.error } : {}),
    };
  }
  if (agentId === "opencode") {
    const st = inspectOpencodeInstall({ scope, dir, homeDir, env });
    return {
      installed: Boolean(st.installed),
      complete: Boolean(st.installed),
      targetPath: st.pluginPath || resolveOpencodePluginPath({ scope, dir, homeDir, env }),
      ...(st.unmanagedConflict ? { unmanagedConflict: true } : {}),
      ...(st.error ? { error: st.error } : {}),
    };
  }
  return { installed: false, complete: false, targetPath: "" };
}

/**
 * 实时、纯文件系统扫描本机已安装的 Coding Agent（绝不执行外部 CLI 二进制）。
 */
export function detectInstalledAgents(options = {}) {
  const {
    cfg = null,
    scope = "user",
    dir = process.cwd(),
    pathEnv,
    homeDir = os.homedir(),
    env = process.env,
    platform = process.platform,
    includeSystemFallbacks,
  } = options;

  const effectivePath = pathEnv !== undefined ? pathEnv : (env.PATH ?? env.Path ?? "");
  const useSystemFallbacks = includeSystemFallbacks !== undefined ? includeSystemFallbacks : pathEnv === undefined;

  const agents = [];
  for (const spec of SUPPORTED_AGENTS) {
    const binName = cfg?.summarizer?.cli?.[spec.binConfigKey] || spec.defaultBin;
    const isAbs = path.isAbsolute(binName);
    const resolved = resolveCliBin(binName, null, {
      pathEnv: effectivePath,
      platform,
      ignoreCache: true,
    });

    let binFound = resolved.found;
    let binPath = resolved.found ? resolved.bin : "";
    let binSource = resolved.found ? (isAbs ? "custom" : "path") : "";

    if (!binFound && !isAbs) {
      const fallbacks = getFallbackBinCandidates(spec.id, {
        homeDir,
        env,
        platform,
        includeSystemFallbacks: useSystemFallbacks,
      });
      for (const candidate of fallbacks) {
        if (isExecutableFile(candidate, platform)) {
          binFound = true;
          binPath = candidate;
          binSource = "fallback";
          break;
        }
      }
    }

    const configCandidates = getConfigDirCandidates(spec.id, { homeDir, env });
    const existingConfigDir = configCandidates.find((d) => isExistingDir(d));
    const configDirFound = Boolean(existingConfigDir);
    const configDir = existingConfigDir || configCandidates[0] || "";

    const hook = inspectHookStatus(spec.id, { scope, dir, homeDir, env });
    const detected = binFound || configDirFound;
    const status = binFound ? "installed" : configDirFound ? "config-only" : "not-found";

    agents.push({
      id: spec.id,
      name: spec.name,
      aliases: spec.aliases,
      supported: true,
      detected,
      status,
      binFound,
      binPath,
      binSource,
      configDirFound,
      configDir,
      hook,
    });
  }

  const detected = agents.filter((a) => a.detected);
  const notDetected = agents.filter((a) => !a.detected);

  // 仅作信息提示：检测尚未接入但用户本机可能已有的规划 Agent（如 Antigravity）
  const unsupportedDetected = [];
  const agyResolved = resolveCliBin("agy", null, {
    pathEnv: effectivePath,
    platform,
    ignoreCache: true,
  });
  const agyConfigDir = path.join(homeDir, ".gemini", "antigravity");
  const agyHooksFile = path.join(homeDir, ".gemini", "config", "hooks.json");
  const agyConfigFound = isExistingDir(agyConfigDir) || isExistingFile(agyHooksFile);
  if (agyResolved.found || agyConfigFound) {
    unsupportedDetected.push({
      id: "agy",
      name: "Antigravity",
      supported: false,
      binFound: agyResolved.found,
      binPath: agyResolved.found ? agyResolved.bin : "",
      configDirFound: agyConfigFound,
      configDir: agyConfigDir,
      status: agyResolved.found ? "installed" : "config-only",
    });
  }

  return {
    detectedAt: new Date().toISOString(),
    scope,
    dir: path.resolve(dir),
    agents,
    detected,
    notDetected,
    unsupportedDetected,
  };
}

/**
 * 解析用户选择的 Agent（支持序号、别名、逗号/空格分隔、回车默认值、q 取消）。
 */
export function parseAgentSelection(input, selectableAgents, { defaultMode = "uninstalled-or-all" } = {}) {
  if (!Array.isArray(selectableAgents) || selectableAgents.length === 0) {
    return { targets: [], cancelled: true, isDefault: false };
  }

  const raw = String(input ?? "").trim().toLowerCase();
  if (raw === "") {
    if (defaultMode === "uninstalled-or-all") {
      const uninstalled = selectableAgents.filter((a) => !a.hook?.installed);
      const chosen = uninstalled.length > 0 ? uninstalled : selectableAgents;
      return { targets: chosen.map((a) => a.id), cancelled: false, isDefault: true };
    }
    return { targets: selectableAgents.map((a) => a.id), cancelled: false, isDefault: true };
  }

  if (["q", "quit", "exit", "n", "no", "none", "0"].includes(raw)) {
    return { targets: [], cancelled: true, isDefault: false };
  }

  if (["all", "a", "*"].includes(raw)) {
    return { targets: selectableAgents.map((a) => a.id), cancelled: false, isDefault: false };
  }

  const tokens = raw.split(/[,，\s]+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("未输入有效序号或 Agent 名称");
  }

  const picked = [];
  const seen = new Set();
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const idx = Number.parseInt(tok, 10);
      if (idx < 1 || idx > selectableAgents.length) {
        throw new Error(`序号 "${tok}" 超出范围 (1-${selectableAgents.length})`);
      }
      const id = selectableAgents[idx - 1].id;
      if (!seen.has(id)) {
        seen.add(id);
        picked.push(id);
      }
      continue;
    }

    const matched = selectableAgents.find(
      (a) => a.id === tok || (Array.isArray(a.aliases) && a.aliases.includes(tok))
    );
    if (!matched) {
      const names = selectableAgents.map((a) => a.id).join(" / ");
      throw new Error(`无法识别选项 "${tok}"，请输入序号 1-${selectableAgents.length} 或 (${names})`);
    }
    if (!seen.has(matched.id)) {
      seen.add(matched.id);
      picked.push(matched.id);
    }
  }

  return { targets: picked, cancelled: false, isDefault: false };
}

function formatHookBadge(agent) {
  if (agent.hook?.unmanagedConflict) return "[钩子: 非 runmemo 托管 ⚠️]";
  if (agent.hook?.error) return "[钩子: 配置读取失败 ⚠️]";
  if (agent.hook?.installed) {
    if (agent.id === "codex" && agent.hook.featureFlagEnabled === false) {
      return "[钩子: 已装但缺 codex_hooks ⚠️]";
    }
    return "[钩子: 已安装 ✅]";
  }
  return "[钩子: 未安装]";
}

/**
 * 格式化实时检测报告，便于终端直接阅读与交互挑选。
 */
export function formatDetectionReport(report, { numbered = false } = {}) {
  const scopeLabel = report.scope === "project" ? `project: ${report.dir}` : "user (全局)";
  const lines = [
    `实时检测到 ${report.detected.length}/${report.agents.length} 个受支持 Agent [范围: ${scopeLabel}]：`,
  ];

  report.detected.forEach((agent, idx) => {
    const prefix = numbered ? `  [${idx + 1}]` : "  •";
    const statusText = agent.binFound
      ? `已安装 (${agent.binPath})`
      : `仅发现配置目录 (${agent.configDir})`;
    lines.push(`${prefix} ${agent.name} (${agent.id}) — ${statusText}  ${formatHookBadge(agent)}`);
  });

  if (report.detected.length === 0) {
    lines.push("  (未在 PATH、常见安装路径或配置目录检测到支持的 Coding Agent)");
  }

  if (report.notDetected.length > 0) {
    const missingText = report.notDetected.map((a) => `${a.name} (${a.id})`).join("、");
    lines.push(`未检测到: ${missingText}（如已安装可手动 \`runmemo install <id>\`）`);
  }

  if (report.unsupportedDetected.length > 0) {
    const extraText = report.unsupportedDetected.map((a) => `${a.name} (${a.id})`).join("、");
    lines.push(`暂未支持（后续版本规划）: ${extraText}`);
  }

  return lines.join("\n");
}
