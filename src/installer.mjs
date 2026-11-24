import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { atomicWriteFile, PACKAGE_ROOT } from "./config.mjs";

// ---------------- Claude Code ----------------
const CC_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "TaskCompleted",
  "Stop",
];
const CC_HOOK_MARKER = "hook-cc.mjs";

export function getCcHookCommand() {
  const scriptPath = path.join(PACKAGE_ROOT, "src", "hook-cc.mjs").replace(/\\/g, "/");
  return `node "${scriptPath}"`;
}

export function resolveCcSettingsPath({ scope = "user", dir = process.cwd(), homeDir = os.homedir() } = {}) {
  if (scope === "project") {
    return path.join(path.resolve(dir), ".claude", "settings.json");
  }
  return path.join(homeDir, ".claude", "settings.json");
}

function makeIsManagedHandler(marker) {
  return (handler) => Boolean(handler && typeof handler.command === "string" && handler.command.includes(marker));
}

function makeIsManagedGroup(isManagedHandler) {
  return (group) => Boolean(group && Array.isArray(group.hooks) && group.hooks.some(isManagedHandler));
}

function readJsonObjectFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, data: {}, raw: "" };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const clean = raw.replace(/^\uFEFF/, "");
  try {
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("根结构不是 JSON 对象");
    }
    return { exists: true, data: parsed, raw };
  } catch (err) {
    throw new Error(`无法解析 ${filePath}：${err.message}（为安全起见已中止写入）`);
  }
}

export function installCcHooks({ scope = "user", dir = process.cwd(), dryRun = false } = {}) {
  const settingsPath = resolveCcSettingsPath({ scope, dir });
  const command = getCcHookCommand();
  const { exists, data, raw } = readJsonObjectFile(settingsPath);
  const isManaged = makeIsManagedHandler(CC_HOOK_MARKER);
  const isManagedGroup = makeIsManagedGroup(isManaged);

  const next = structuredClone(data);
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) {
    next.hooks = {};
  }

  let added = 0;
  let updated = 0;

  for (const eventName of CC_HOOK_EVENTS) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    const existingIdx = groups.findIndex(isManagedGroup);
    const handler = { type: "command", command, timeout: 5 };

    if (existingIdx >= 0) {
      const oldGroup = groups[existingIdx];
      const otherHandlers = (oldGroup.hooks || []).filter((h) => !isManaged(h));
      groups[existingIdx] = {
        ...oldGroup,
        matcher: oldGroup.matcher || "*",
        hooks: [...otherHandlers, handler],
      };
      updated += 1;
    } else {
      groups.push({ matcher: "*", hooks: [handler] });
      added += 1;
    }
    next.hooks[eventName] = groups;
  }

  const nextText = JSON.stringify(next, null, 2) + "\n";
  let backupPath = null;

  if (!dryRun) {
    if (exists && raw !== nextText) {
      backupPath = `${settingsPath}.runmemo.bak`;
      fs.writeFileSync(backupPath, raw, "utf8");
    }
    atomicWriteFile(settingsPath, nextText);
  }

  return {
    settingsPath,
    command,
    events: CC_HOOK_EVENTS,
    added,
    updated,
    backupPath,
    dryRun,
    previewJson: nextText,
  };
}

export function uninstallCcHooks({ scope = "user", dir = process.cwd(), dryRun = false } = {}) {
  const settingsPath = resolveCcSettingsPath({ scope, dir });
  const { exists, data, raw } = readJsonObjectFile(settingsPath);
  if (!exists) return { settingsPath, removed: 0, existed: false, dryRun };

  const isManaged = makeIsManagedHandler(CC_HOOK_MARKER);
  const next = structuredClone(data);
  if (!next.hooks || typeof next.hooks !== "object") {
    return { settingsPath, removed: 0, existed: true, dryRun };
  }

  let removed = 0;
  for (const [eventName, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const before = group.hooks.length;
      const keptHandlers = group.hooks.filter((h) => !isManaged(h));
      removed += before - keptHandlers.length;
      if (keptHandlers.length > 0) {
        keptGroups.push({ ...group, hooks: keptHandlers });
      }
    }
    if (keptGroups.length > 0) next.hooks[eventName] = keptGroups;
    else delete next.hooks[eventName];
  }

  if (Object.keys(next.hooks).length === 0) delete next.hooks;

  const nextText = JSON.stringify(next, null, 2) + "\n";
  let backupPath = null;

  if (!dryRun && removed > 0) {
    backupPath = `${settingsPath}.runmemo.bak`;
    fs.writeFileSync(backupPath, raw, "utf8");
    atomicWriteFile(settingsPath, nextText);
  }

  return { settingsPath, removed, existed: true, backupPath, dryRun };
}

export function inspectCcInstall({ scope = "user", dir = process.cwd(), homeDir = os.homedir() } = {}) {
  const settingsPath = resolveCcSettingsPath({ scope, dir, homeDir });
  if (!fs.existsSync(settingsPath)) {
    return { settingsPath, installed: false, complete: false, count: 0, total: CC_HOOK_EVENTS.length, command: "" };
  }
  const isManaged = makeIsManagedHandler(CC_HOOK_MARKER);
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    const hooks = data?.hooks || {};
    let count = 0;
    let command = "";
    for (const ev of CC_HOOK_EVENTS) {
      const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
      for (const g of groups) {
        for (const h of g?.hooks || []) {
          if (isManaged(h)) {
            count += 1;
            if (!command) command = h.command;
          }
        }
      }
    }
    return {
      settingsPath,
      installed: count > 0,
      complete: count === CC_HOOK_EVENTS.length,
      count,
      total: CC_HOOK_EVENTS.length,
      command,
    };
  } catch (err) {
    return { settingsPath, installed: false, complete: false, count: 0, total: CC_HOOK_EVENTS.length, error: err.message };
  }
}

// ---------------- OpenAI Codex CLI ----------------
const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
];
const CODEX_HOOK_MARKER = "hook-codex.mjs";

export function resolveCodexDir({ scope = "user", dir = process.cwd(), homeDir = os.homedir(), env = process.env } = {}) {
  if (scope === "project") {
    return path.join(path.resolve(dir), ".codex");
  }
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, ".codex");
}

export function getCodexHookCommand() {
  const scriptPath = path.join(PACKAGE_ROOT, "src", "hook-codex.mjs").replace(/\\/g, "/");
  return `node "${scriptPath}"`;
}

function hasCodexHooksFlagEnabled(tomlText) {
  if (!tomlText) return false;
  // 匹配 [features] 表中的 codex_hooks = true 或 hooks = true，或内联表 features = { ... codex_hooks = true ... }
  if (/^\s*features\s*=\s*\{[^}]*\b(?:codex_hooks|hooks)\s*=\s*true\b[^}]*\}/im.test(tomlText)) {
    return true;
  }
  const lines = tomlText.replace(/^\uFEFF/, "").split(/\r?\n/);
  let inFeatures = false;
  for (const line of lines) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    const sec = trimmed.match(/^\[([^\]]+)\]$/);
    if (sec) {
      inFeatures = sec[1].trim() === "features";
      continue;
    }
    if (inFeatures && /^(?:codex_hooks|hooks)\s*=\s*true\b/i.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function ensureCodexFeatureFlag(configTomlPath, { dryRun = false } = {}) {
  const exists = fs.existsSync(configTomlPath);
  const raw = exists ? fs.readFileSync(configTomlPath, "utf8") : "";
  const clean = raw.replace(/^\uFEFF/, "");

  if (hasCodexHooksFlagEnabled(clean)) {
    return { configTomlPath, updated: false, enabled: true, backupPath: null, warning: "" };
  }

  // 安全检查：若存在内联 features = { ... }，避免直接正则改写破坏复杂 TOML 结构
  if (/^\s*features\s*=\s*\{/im.test(clean)) {
    return {
      configTomlPath,
      updated: false,
      enabled: false,
      backupPath: null,
      warning: `检测到 ${configTomlPath} 使用了内联 features = { ... } 表，请手动加入 codex_hooks = true`,
    };
  }

  const newline = clean.includes("\r\n") ? "\r\n" : "\n";
  const lines = clean ? clean.split(/\r?\n/) : [];
  let featuresIdx = -1;
  let featuresEndIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/#.*$/, "").trim();
    const sec = t.match(/^\[([^\]]+)\]$/);
    if (sec) {
      if (featuresIdx >= 0) {
        featuresEndIdx = i;
        break;
      }
      if (sec[1].trim() === "features") {
        featuresIdx = i;
      }
    }
  }

  let nextText = "";
  if (featuresIdx >= 0) {
    let hasCodexHooksLine = false;
    for (let i = featuresIdx + 1; i < featuresEndIdx; i++) {
      if (/^\s*codex_hooks\s*=\s*(?:true|false)\b/i.test(lines[i])) {
        hasCodexHooksLine = true;
        if (/false/i.test(lines[i])) {
          lines[i] = lines[i].replace(/false/i, "true");
        }
      } else if (/^\s*hooks\s*=\s*false\b/i.test(lines[i])) {
        lines[i] = lines[i].replace(/false/i, "true");
      }
    }
    if (!hasCodexHooksLine) {
      lines.splice(featuresIdx + 1, 0, "codex_hooks = true");
    }
    nextText = lines.join(newline);
    if (!nextText.endsWith("\n")) nextText += newline;
  } else {
    const prefix = clean.trim().length > 0 ? clean.replace(/\s*$/, "") + newline + newline : "";
    nextText = `${prefix}[features]${newline}codex_hooks = true${newline}`;
  }

  let backupPath = null;
  if (!dryRun) {
    if (exists && raw !== nextText) {
      backupPath = `${configTomlPath}.runmemo.bak`;
      fs.writeFileSync(backupPath, raw, "utf8");
    }
    atomicWriteFile(configTomlPath, nextText);
  }

  return { configTomlPath, updated: true, enabled: true, backupPath, warning: "", previewToml: nextText };
}

export function installCodexHooks({ scope = "user", dir = process.cwd(), dryRun = false } = {}) {
  const codexDir = resolveCodexDir({ scope, dir });
  const hooksPath = path.join(codexDir, "hooks.json");
  const configTomlPath = path.join(codexDir, "config.toml");
  const command = getCodexHookCommand();
  const { exists, data, raw } = readJsonObjectFile(hooksPath);
  const isManaged = makeIsManagedHandler(CODEX_HOOK_MARKER);
  const isManagedGroup = makeIsManagedGroup(isManaged);

  // Codex 严格校验 hooks.json 顶层结构：只允许包含 "hooks"，绝不注入 $schema 或 description
  const rawHooks = data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks) ? data.hooks : {};
  const nextHooks = structuredClone(rawHooks);

  let added = 0;
  let updated = 0;

  for (const eventName of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : [];
    const existingIdx = groups.findIndex(isManagedGroup);
    const handler = { type: "command", command, timeout: 5 };
    const useMatcher = eventName === "PostToolUse";

    if (existingIdx >= 0) {
      const oldGroup = groups[existingIdx];
      const otherHandlers = (oldGroup.hooks || []).filter((h) => !isManaged(h));
      const updatedGroup = useMatcher
        ? { ...oldGroup, matcher: oldGroup.matcher || ".*", hooks: [...otherHandlers, handler] }
        : { ...oldGroup, hooks: [...otherHandlers, handler] };
      groups[existingIdx] = updatedGroup;
      updated += 1;
    } else {
      groups.push(useMatcher ? { matcher: ".*", hooks: [handler] } : { hooks: [handler] });
      added += 1;
    }
    nextHooks[eventName] = groups;
  }

  const next = { hooks: nextHooks };
  const nextText = JSON.stringify(next, null, 2) + "\n";
  let backupPath = null;

  if (!dryRun) {
    if (exists && raw !== nextText) {
      backupPath = `${hooksPath}.runmemo.bak`;
      fs.writeFileSync(backupPath, raw, "utf8");
    }
    atomicWriteFile(hooksPath, nextText);
  }

  const tomlRes = ensureCodexFeatureFlag(configTomlPath, { dryRun });

  return {
    hooksPath,
    configTomlPath,
    featureFlagUpdated: tomlRes.updated,
    featureFlagEnabled: tomlRes.enabled,
    featureFlagWarning: tomlRes.warning,
    configTomlBackupPath: tomlRes.backupPath,
    command,
    events: CODEX_HOOK_EVENTS,
    added,
    updated,
    backupPath,
    dryRun,
    previewJson: nextText,
  };
}

export function uninstallCodexHooks({ scope = "user", dir = process.cwd(), dryRun = false } = {}) {
  const codexDir = resolveCodexDir({ scope, dir });
  const hooksPath = path.join(codexDir, "hooks.json");
  const { exists, data, raw } = readJsonObjectFile(hooksPath);
  if (!exists) return { hooksPath, removed: 0, existed: false, dryRun };

  const isManaged = makeIsManagedHandler(CODEX_HOOK_MARKER);
  const rawHooks = data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks) ? data.hooks : null;
  if (!rawHooks) return { hooksPath, removed: 0, existed: true, dryRun };

  const nextHooks = structuredClone(rawHooks);
  let removed = 0;

  for (const [eventName, groups] of Object.entries(nextHooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const before = group.hooks.length;
      const keptHandlers = group.hooks.filter((h) => !isManaged(h));
      removed += before - keptHandlers.length;
      if (keptHandlers.length > 0) {
        keptGroups.push({ ...group, hooks: keptHandlers });
      }
    }
    if (keptGroups.length > 0) nextHooks[eventName] = keptGroups;
    else delete nextHooks[eventName];
  }

  const next = { hooks: nextHooks };
  const nextText = JSON.stringify(next, null, 2) + "\n";
  let backupPath = null;

  if (!dryRun && removed > 0) {
    backupPath = `${hooksPath}.runmemo.bak`;
    fs.writeFileSync(backupPath, raw, "utf8");
    atomicWriteFile(hooksPath, nextText);
  }

  return { hooksPath, removed, existed: true, backupPath, dryRun };
}

export function inspectCodexInstall({ scope = "user", dir = process.cwd(), homeDir = os.homedir(), env = process.env } = {}) {
  const codexDir = resolveCodexDir({ scope, dir, homeDir, env });
  const hooksPath = path.join(codexDir, "hooks.json");
  const configTomlPath = path.join(codexDir, "config.toml");
  const featureFlagEnabled = fs.existsSync(configTomlPath)
    ? hasCodexHooksFlagEnabled(fs.readFileSync(configTomlPath, "utf8"))
    : false;

  if (!fs.existsSync(hooksPath)) {
    return {
      hooksPath,
      configTomlPath,
      featureFlagEnabled,
      installed: false,
      complete: false,
      count: 0,
      total: CODEX_HOOK_EVENTS.length,
      command: "",
    };
  }
  const isManaged = makeIsManagedHandler(CODEX_HOOK_MARKER);
  try {
    const data = JSON.parse(fs.readFileSync(hooksPath, "utf8").replace(/^\uFEFF/, ""));
    const hooks = data?.hooks || {};
    let count = 0;
    let command = "";
    for (const ev of CODEX_HOOK_EVENTS) {
      const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
      for (const g of groups) {
        for (const h of g?.hooks || []) {
          if (isManaged(h)) {
            count += 1;
            if (!command) command = h.command;
          }
        }
      }
    }
    return {
      hooksPath,
      configTomlPath,
      featureFlagEnabled,
      installed: count > 0,
      complete: count === CODEX_HOOK_EVENTS.length,
      count,
      total: CODEX_HOOK_EVENTS.length,
      command,
    };
  } catch (err) {
    return {
      hooksPath,
      configTomlPath,
      featureFlagEnabled,
      installed: false,
      complete: false,
      count: 0,
      total: CODEX_HOOK_EVENTS.length,
      error: err.message,
    };
  }
}

// ---------------- OpenCode ----------------
const OPENCODE_MANAGED_MARKER = "// managed-by: runmemo";

export function resolveOpencodePluginPath({ scope = "user", dir = process.cwd(), homeDir = os.homedir(), env = process.env } = {}) {
  if (scope === "project") {
    return path.join(path.resolve(dir), ".opencode", "plugins", "runmemo.js");
  }
  const configRoot = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(homeDir, ".config");
  return path.join(configRoot, "opencode", "plugins", "runmemo.js");
}

export function buildOpencodeShim() {
  const pluginFile = path.join(PACKAGE_ROOT, "src", "plugin-opencode.mjs");
  const pluginUrl = url.pathToFileURL(pluginFile).href;
  return (
    `${OPENCODE_MANAGED_MARKER}\n` +
    `process.env.RUNMEMO_NODE_BIN ||= ${JSON.stringify(process.execPath)};\n` +
    `export { RunmemoPlugin } from ${JSON.stringify(pluginUrl)};\n`
  );
}

export function installOpencodePlugin({ scope = "user", dir = process.cwd(), dryRun = false } = {}) {
  const pluginPath = resolveOpencodePluginPath({ scope, dir });
  const shimContent = buildOpencodeShim();
  const exists = fs.existsSync(pluginPath);
  const raw = exists ? fs.readFileSync(pluginPath, "utf8") : "";
  const overwroteUnmanaged = exists && !raw.includes(OPENCODE_MANAGED_MARKER);

  let backupPath = null;
  if (!dryRun) {
    if (exists && raw !== shimContent) {
      backupPath = `${pluginPath}.runmemo.bak`;
      fs.writeFileSync(backupPath, raw, "utf8");
    }
    atomicWriteFile(pluginPath, shimContent);
  }

  return {
    pluginPath,
    updated: exists && raw !== shimContent,
    unchanged: exists && raw === shimContent,
    overwroteUnmanaged,
    backupPath,
    dryRun,
    previewCode: shimContent,
  };
}

export function uninstallOpencodePlugin({ scope = "user", dir = process.cwd(), dryRun = false } = {}) {
  const pluginPath = resolveOpencodePluginPath({ scope, dir });
  if (!fs.existsSync(pluginPath)) {
    return { pluginPath, existed: false, removed: false, dryRun };
  }
  const raw = fs.readFileSync(pluginPath, "utf8");
  if (!raw.includes(OPENCODE_MANAGED_MARKER)) {
    return {
      pluginPath,
      existed: true,
      removed: false,
      skippedUnmanaged: true,
      dryRun,
    };
  }
  if (!dryRun) {
    fs.unlinkSync(pluginPath);
  }
  return { pluginPath, existed: true, removed: true, dryRun };
}

export function inspectOpencodeInstall({ scope = "user", dir = process.cwd(), homeDir = os.homedir(), env = process.env } = {}) {
  const pluginPath = resolveOpencodePluginPath({ scope, dir, homeDir, env });
  if (!fs.existsSync(pluginPath)) {
    return { pluginPath, installed: false };
  }
  try {
    const raw = fs.readFileSync(pluginPath, "utf8");
    return {
      pluginPath,
      installed: raw.includes(OPENCODE_MANAGED_MARKER),
      unmanagedConflict: !raw.includes(OPENCODE_MANAGED_MARKER),
    };
  } catch (err) {
    return { pluginPath, installed: false, error: err.message };
  }
}
