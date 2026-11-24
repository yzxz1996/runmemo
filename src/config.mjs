import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "..");

// 零 CPU 空转休眠缓冲区（替代 while 忙等待）
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

export function getHomeDir() {
  return process.env.RUNMEMO_HOME || path.join(os.homedir(), ".runmemo");
}

export function getConfigPath() {
  return path.join(getHomeDir(), "config.json");
}

export const DEFAULT_CONFIG = {
  version: 1,
  outputs: ["html"], // 可选组合: ["html"] | ["feishu"] | ["html", "feishu"]
  summarizer: {
    provider: "cli", // v1 支持 "cli"；已预留 "api" 扩展位
    cli: {
      tool: "auto", // "auto" | "claude" | "codex" | "opencode"
      bin: "claude",
      model: "haiku",
      codexBin: "codex",
      codexModel: "",
      opencodeBin: "opencode",
      opencodeModel: "",
      timeoutMs: 45_000,
    },
    api: {
      baseUrl: "",
      apiKey: "",
      model: "",
    },
  },
  html: {
    dir: "", // 留空则默认写入 ~/.runmemo/
  },
  feishu: {
    webhook: "",
    secret: "",
    minIntervalSec: 60,
  },
  trigger: {
    intervalSec: 45,
    batch: 8,
    fastRefreshMs: 2_000,
    skipL0: true,
    l1MinTools: 4,
    l1MinSec: 25,
  },
  maxSessions: 30,
  lockStaleMs: 90_000,
  debug: false,
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function atomicWriteFile(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(tmp, content, "utf8");
    } else {
      throw err;
    }
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      if ((err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") && attempt < 3) {
        sleepSync(12 * (attempt + 1));
        continue;
      }
      try {
        fs.writeFileSync(filePath, content, "utf8");
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
      return;
    }
  }
}

export function loadConfig() {
  const cfgPath = getConfigPath();
  let userCfg = null;
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    userCfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    userCfg = null;
  }
  const merged = userCfg ? deepMerge(structuredClone(DEFAULT_CONFIG), userCfg) : structuredClone(DEFAULT_CONFIG);

  if (process.env.RUNMEMO_OUTPUTS) {
    merged.outputs = normalizeOutputs(process.env.RUNMEMO_OUTPUTS);
  }
  if (process.env.RUNMEMO_CLI_TOOL) merged.summarizer.cli.tool = process.env.RUNMEMO_CLI_TOOL;
  if (process.env.RUNMEMO_CLAUDE_BIN) merged.summarizer.cli.bin = process.env.RUNMEMO_CLAUDE_BIN;
  if (process.env.RUNMEMO_CLAUDE_MODEL) merged.summarizer.cli.model = process.env.RUNMEMO_CLAUDE_MODEL;
  if (process.env.RUNMEMO_CODEX_BIN) merged.summarizer.cli.codexBin = process.env.RUNMEMO_CODEX_BIN;
  if (process.env.RUNMEMO_CODEX_MODEL) merged.summarizer.cli.codexModel = process.env.RUNMEMO_CODEX_MODEL;
  if (process.env.RUNMEMO_OPENCODE_BIN) merged.summarizer.cli.opencodeBin = process.env.RUNMEMO_OPENCODE_BIN;
  if (process.env.RUNMEMO_OPENCODE_MODEL) merged.summarizer.cli.opencodeModel = process.env.RUNMEMO_OPENCODE_MODEL;
  if (process.env.RUNMEMO_FEISHU_WEBHOOK) merged.feishu.webhook = process.env.RUNMEMO_FEISHU_WEBHOOK;
  if (process.env.RUNMEMO_FEISHU_SECRET) merged.feishu.secret = process.env.RUNMEMO_FEISHU_SECRET;
  if (process.env.RUNMEMO_DEBUG === "1") merged.debug = true;

  return merged;
}

export function saveConfig(cfg) {
  const cfgPath = getConfigPath();
  atomicWriteFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return cfgPath;
}

export function getRuntimePaths(cfg = loadConfig()) {
  const homeDir = getHomeDir();
  const htmlDir = cfg.html?.dir ? path.resolve(cfg.html.dir) : homeDir;
  return {
    homeDir,
    configPath: getConfigPath(),
    sessionsDir: path.join(homeDir, "sessions"),
    sessionsIndexFile: path.join(homeDir, "sessions-index.json"),
    indexLockFile: path.join(homeDir, "index.lock"),
    binCacheFile: path.join(homeDir, ".bin-cache.json"),
    htmlDir,
    htmlViewsDir: path.join(htmlDir, "views"),
    dashboardHtml: path.join(htmlDir, "dashboard.html"),
    dashboardDataJs: path.join(htmlDir, "data.js"),
    debugLog: path.join(homeDir, "debug.log"),
  };
}

export function safeSessionId(sessionId) {
  return String(sessionId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getSessionPaths(sessionId, cfg = loadConfig()) {
  const { sessionsDir, htmlViewsDir } = getRuntimePaths(cfg);
  const safeId = safeSessionId(sessionId);
  const dir = path.join(sessionsDir, safeId);
  return {
    safeId,
    dir,
    eventsFile: path.join(dir, "events.jsonl"),
    briefsFile: path.join(dir, "briefs.jsonl"),
    snapshotFile: path.join(dir, "snapshot.json"),
    metaFile: path.join(dir, "meta.json"),
    workerLockFile: path.join(dir, "worker.lock"),
    llmLockFile: path.join(dir, "llm.lock"),
    pendingFlagFile: path.join(dir, "pending.flag"),
    feishuPreviewFile: path.join(dir, "feishu-card-preview.json"),
    viewJsFile: path.join(htmlViewsDir, `${safeId}.js`),
  };
}

export function normalizeOutputs(raw) {
  const str = String(raw || "").trim().toLowerCase();
  if (str === "both" || str === "all") return ["html", "feishu"];
  const parts = str
    .split(/[,\s+]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = [];
  for (const p of parts) {
    if (p !== "html" && p !== "feishu") {
      throw new Error(`不支持的输出通道 "${p}"，可选值：html、feishu、html,feishu（或 both）`);
    }
    if (!valid.includes(p)) valid.push(p);
  }
  if (!valid.length) {
    throw new Error("至少需要启用一个输出通道（html 或 feishu）");
  }
  return valid;
}

const KEY_ALIASES = {
  output: "outputs",
  outputs: "outputs",
  summarizer: "summarizer.provider",
  "summarizer.provider": "summarizer.provider",
  provider: "summarizer.provider",
  cli: "summarizer.cli.tool",
  "cli.tool": "summarizer.cli.tool",
  "summarizer.cli.tool": "summarizer.cli.tool",
  model: "summarizer.cli.model",
  "claude.model": "summarizer.cli.model",
  "cli.model": "summarizer.cli.model",
  "summarizer.cli.model": "summarizer.cli.model",
  "claude.bin": "summarizer.cli.bin",
  "cli.bin": "summarizer.cli.bin",
  "summarizer.cli.bin": "summarizer.cli.bin",
  "codex.bin": "summarizer.cli.codexBin",
  "summarizer.cli.codexBin": "summarizer.cli.codexBin",
  "codex.model": "summarizer.cli.codexModel",
  "summarizer.cli.codexModel": "summarizer.cli.codexModel",
  "opencode.bin": "summarizer.cli.opencodeBin",
  "summarizer.cli.opencodeBin": "summarizer.cli.opencodeBin",
  "opencode.model": "summarizer.cli.opencodeModel",
  "summarizer.cli.opencodeModel": "summarizer.cli.opencodeModel",
  "claude.timeoutMs": "summarizer.cli.timeoutMs",
  "cli.timeoutMs": "summarizer.cli.timeoutMs",
  "summarizer.cli.timeoutMs": "summarizer.cli.timeoutMs",
  "api.baseUrl": "summarizer.api.baseUrl",
  "api.apiKey": "summarizer.api.apiKey",
  "api.model": "summarizer.api.model",
  "summarizer.api.baseUrl": "summarizer.api.baseUrl",
  "summarizer.api.apiKey": "summarizer.api.apiKey",
  "summarizer.api.model": "summarizer.api.model",
  "html.dir": "html.dir",
  "feishu.webhook": "feishu.webhook",
  "feishu.secret": "feishu.secret",
  "feishu.minIntervalSec": "feishu.minIntervalSec",
  "trigger.intervalSec": "trigger.intervalSec",
  "trigger.batch": "trigger.batch",
  "trigger.skipL0": "trigger.skipL0",
  debug: "debug",
};

function parseBool(v) {
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  throw new Error(`期望布尔值 true/false，实际收到 "${v}"`);
}

function parsePositiveInt(v, name) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} 必须是非负整数，实际收到 "${v}"`);
  }
  return n;
}

export function setConfigKey(cfg, rawKey, rawValue) {
  const canonical = KEY_ALIASES[rawKey];
  if (!canonical) {
    const supported = [
      "output (html | feishu | html,feishu)",
      "summarizer (cli)",
      "cli (auto | claude | codex | opencode)",
      "claude.model / codex.model / opencode.model",
      "claude.bin / codex.bin / opencode.bin",
      "html.dir",
      "feishu.webhook",
      "feishu.secret",
      "feishu.minIntervalSec",
      "trigger.intervalSec",
      "trigger.batch",
      "trigger.skipL0",
      "debug",
    ];
    throw new Error(`未知配置项 "${rawKey}"。\n常用配置项：\n  - ${supported.join("\n  - ")}`);
  }

  let value = rawValue;
  if (canonical === "outputs") {
    value = normalizeOutputs(rawValue);
  } else if (canonical === "summarizer.provider") {
    const p = String(rawValue || "").trim().toLowerCase();
    if (p === "api") {
      throw new Error(
        "当前版本暂仅支持 CLI 概括引擎（summarizer=cli，可选 auto/claude/codex/opencode）；API 接入配置位（api.baseUrl / api.apiKey / api.model）已预留，将在下一版开放。"
      );
    }
    if (p !== "cli") {
      throw new Error(`不支持的概括引擎 "${rawValue}"，可选值：cli`);
    }
    value = "cli";
  } else if (canonical === "summarizer.cli.tool") {
    const t = String(rawValue || "").trim().toLowerCase();
    const map = { cc: "claude", claude: "claude", codex: "codex", opencode: "opencode", oc: "opencode", auto: "auto" };
    if (!map[t]) {
      throw new Error(`不支持的 CLI 工具 "${rawValue}"，可选值：auto | claude | codex | opencode`);
    }
    value = map[t];
  } else if (canonical === "feishu.webhook") {
    const url = String(rawValue || "").trim();
    if (url && !/^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/.+/i.test(url)) {
      throw new Error("飞书 Webhook 格式不正确，应类似 https://open.feishu.cn/open-apis/bot/v2/hook/<token>");
    }
    value = url;
  } else if (
    canonical === "feishu.minIntervalSec" ||
    canonical === "trigger.intervalSec" ||
    canonical === "trigger.batch" ||
    canonical === "summarizer.cli.timeoutMs"
  ) {
    value = parsePositiveInt(rawValue, canonical);
  } else if (canonical === "trigger.skipL0" || canonical === "debug") {
    value = parseBool(rawValue);
  } else {
    value = String(rawValue ?? "").trim();
  }

  const next = structuredClone(cfg);
  const parts = canonical.split(".");
  let cursor = next;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") {
      cursor[parts[i]] = {};
    }
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
  return { config: next, key: canonical, value };
}

export function unsetConfigKey(cfg, rawKey) {
  const canonical = KEY_ALIASES[rawKey];
  if (!canonical) {
    throw new Error(`未知配置项 "${rawKey}"`);
  }
  const parts = canonical.split(".");
  let defVal = DEFAULT_CONFIG;
  for (const p of parts) defVal = defVal?.[p];

  const next = structuredClone(cfg);
  let cursor = next;
  for (let i = 0; i < parts.length - 1; i++) cursor = cursor[parts[i]];
  cursor[parts[parts.length - 1]] = structuredClone(defVal);
  return { config: next, key: canonical, value: defVal };
}

function maskTail(s, visiblePrefix = 0, visibleSuffix = 4) {
  if (!s) return "(未配置)";
  if (s.length <= visiblePrefix + visibleSuffix + 3) return "***";
  return s.slice(0, visiblePrefix) + "***" + s.slice(-visibleSuffix);
}

export function maskConfigForDisplay(cfg) {
  const copy = structuredClone(cfg);
  if (copy.feishu?.webhook) {
    const idx = copy.feishu.webhook.lastIndexOf("/");
    copy.feishu.webhook =
      idx > 0
        ? copy.feishu.webhook.slice(0, idx + 1) + maskTail(copy.feishu.webhook.slice(idx + 1), 4, 4)
        : maskTail(copy.feishu.webhook, 8, 4);
  }
  if (copy.feishu?.secret) copy.feishu.secret = maskTail(copy.feishu.secret, 2, 2);
  if (copy.summarizer?.api?.apiKey) copy.summarizer.api.apiKey = maskTail(copy.summarizer.api.apiKey, 3, 4);
  return copy;
}
