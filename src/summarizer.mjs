#!/usr/bin/env node
/**
 * runmemo · 异步阶段概括与多通道分发 Worker（增量 O(Δ) 优化版）
 * 优化点：
 *   1. O(Δ) 增量字节偏移读取与状态折叠：不再每次重读全量 events.jsonl
 *   2. 消除 3x 重复物化：单次物化复用，仅在确实有变更或新增简报时写盘与刷新 HTML
 *   3. worker.lock 尾排空（Trailing Drain）：吸收并发钩子合并的增量事件，彻底消灭进程风暴
 *   4. 连续 READ 折叠压缩：喂给 claude -p 的增量 Prompt 体积再降 30%~50%
 *   5. claude CLI 路径缓存：避免每次扫描 Windows PATH 目录
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, ensureDir, getSessionPaths, loadConfig, sleepSync } from "./config.mjs";
import { resolveCliBin, resolveClaudeBin, spawnCliWithStdin } from "./cli-bin.mjs";
import {
  appendJsonl,
  debugLog,
  foldIntoSession,
  isWriteToolName,
  readJsonlFromOffset,
  readJsonSafe,
  shortPath,
  SNAPSHOT_SCHEMA_VERSION,
  truncate,
} from "./core.mjs";
import { updateHtmlSink } from "./sinks/html.mjs";
import { buildFeishuCardPayload, sendFeishuBrief } from "./sinks/feishu.mjs";

export { resolveCliBin, resolveClaudeBin };

const MILESTONE_TRIGGERS = new Set(["SubagentStop", "TaskCompleted", "Stop"]);

function parseArgs(argv) {
  const out = {
    sessionId: "",
    trigger: "Manual",
    mockLlm: process.env.RUNMEMO_MOCK_LLM === "1",
    sendFeishu: process.env.RUNMEMO_DISABLE_FEISHU !== "1",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session" && argv[i + 1]) out.sessionId = argv[++i];
    else if (a === "--trigger" && argv[i + 1]) out.trigger = argv[++i];
    else if (a === "--mock-llm") out.mockLlm = true;
    else if (a === "--no-feishu") out.sendFeishu = false;
  }
  return out;
}

function acquireLock(lockFile, staleMs) {
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, String(process.pid), "utf8");
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      ensureDir(path.dirname(lockFile));
      return acquireLock(lockFile, staleMs);
    }
    if (err.code !== "EEXIST") return false;
    try {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > staleMs) {
        fs.unlinkSync(lockFile);
        const fd = fs.openSync(lockFile, "wx");
        fs.writeFileSync(fd, String(process.pid), "utf8");
        fs.closeSync(fd);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // ignore
  }
}

function acquireLockWithRetry(lockFile, staleMs, retries = 5, delayMs = 25) {
  for (let i = 0; i <= retries; i++) {
    if (acquireLock(lockFile, staleMs)) return true;
    if (i < retries) sleepSync(delayMs * (i + 1));
  }
  return false;
}

// 折叠连续只读探测，大幅降低喂给小模型的 Token 数与延迟
function formatDeltaLines(deltaEvents) {
  const lines = [];
  let readBurstCount = 0;
  let readBurstSample = "";
  let readBurstTime = "";
  let readBurstWho = "";

  const flushReads = () => {
    if (readBurstCount === 0) return;
    if (readBurstCount === 1) {
      lines.push(`[${readBurstTime}][${readBurstWho}][READ] ${readBurstSample}`);
    } else {
      lines.push(`[${readBurstTime}][${readBurstWho}][READ×${readBurstCount}] 连续只读探测（如 ${readBurstSample}）`);
    }
    readBurstCount = 0;
    readBurstSample = "";
  };

  for (const ev of deltaEvents) {
    const t = new Date(ev.ts).toTimeString().slice(0, 8);
    const who = ev.agentId ? `sub:${ev.agentId}` : "main";

    if (ev.eventType === "PostToolUse" && ev.opClass === "READ" && ev.ok !== false) {
      if (readBurstCount === 0) {
        readBurstTime = t;
        readBurstWho = who;
        readBurstSample = `${ev.toolName} ${truncate(ev.target, 48)}`;
      }
      readBurstCount += 1;
      continue;
    }

    flushReads();

    if (ev.eventType === "UserPromptSubmit") {
      lines.push(`[${t}][${who}] 需求: ${ev.prompt}`);
    } else if (ev.eventType === "SubagentStart") {
      lines.push(`[${t}][${who}] 起子任务(${ev.agentType}): ${ev.detail || ""}`);
    } else if (ev.eventType === "SubagentStop") {
      lines.push(`[${t}][${who}] 子任务完成(${ev.agentType}): ${ev.lastMessage || ""}`);
    } else if (ev.eventType === "TaskCompleted") {
      lines.push(`[${t}][${who}] 里程碑: ${ev.taskSubject || ev.detail || ""}`);
    } else if (ev.eventType === "PostToolUse" || ev.eventType === "PostToolUseFailure") {
      const tag = `${ev.opClass}${ev.risk === "high" ? "!" : ""}/${ev.ok ? "OK" : "FAIL"}`;
      const snip = ev.snippet ? ` -> ${truncate(ev.snippet, 80)}` : "";
      lines.push(`[${t}][${who}][${tag}] ${ev.toolName} ${ev.target}${snip}`);
    }
  }
  flushReads();

  if (lines.length > 36) {
    return [...lines.slice(0, 6), `...略去中间 ${lines.length - 36} 步...`, ...lines.slice(-30)].join("\n");
  }
  return lines.join("\n");
}

function buildConcisePrompt(session, deltaEvents, trigger) {
  const prev = session.latestBrief
    ? `上一条简报：${session.latestBrief.title}（${(session.latestBrief.bullets || []).join("；")}）`
    : "（首条简报）";

  return [
    "你是“电报式”AI 工程进度简报员。给极忙的工程师写 3 秒能扫完的中文阶段简报。",
    "硬性风格要求：",
    "1. 极度精炼、直奔结果，严禁写长段落、严禁套话（如“本阶段完成了”“通过分析发现”）、严禁重复表述。",
    "2. 严格只输出一个 JSON 对象，不要 Markdown 代码块，不要额外说明，不要调用任何工具。",
    "3. 字段上限（务必遵守）：",
    '   - "title": 18字以内，一眼看清本阶段结果',
    '   - "status": "ok" | "warn" | "err"（仅报错填 err，重试/高影响部署填 warn，其余 ok）',
    '   - "bullets": 1~3 条字符串，每条不超过 28 字，动词开头直述事实',
    '   - "files": 最多 4 个简短路径或资源名（无则 []）',
    '   - "check": 1 行极短验证结论（如 "单测 18/18 · E2E 12/12"，没有验证务必返回 ""）',
    '   - "alert": 仅在有失败/重试/高影响外部变更时写 1 句提醒（≤34字），否则务必返回 ""',
    "",
    `触发点: ${trigger} | 项目: ${session.projectName || "未知"}`,
    `目标: ${session.latestPrompt || "未知"}`,
    prev,
    "",
    "本阶段新增动作：",
    formatDeltaLines(deltaEvents),
  ].join("\n");
}

function sanitizeBrief(raw, cwd = "") {
  const status = ["ok", "warn", "err"].includes(raw?.status) ? raw.status : "ok";
  const bullets = (Array.isArray(raw?.bullets) ? raw.bullets : [])
    .map((x) => truncate(String(x || "").replace(/^[•\-*\d.\s]+/, ""), 36))
    .filter(Boolean)
    .slice(0, 3);
  const files = Array.from(
    new Set(
      (Array.isArray(raw?.files) ? raw.files : [])
        .map((f) => shortPath(f, cwd))
        .filter(Boolean)
    )
  ).slice(0, 4);

  let check = truncate(raw?.check || "", 44);
  if (/^(暂无|无|没有|none|n\/a)/i.test(check)) check = "";

  let alert = truncate(raw?.alert || "", 48);
  if (/^(无|没有|暂无|无明显风险|none|n\/a)/i.test(alert)) alert = "";

  return { title: truncate(raw?.title || "阶段进展更新", 24), status, bullets, files, check, alert };
}

function parseLlmJson(text, cwd) {
  const s = String(text || "").trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  const i = candidate.indexOf("{");
  const j = candidate.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      return sanitizeBrief(JSON.parse(candidate.slice(i, j + 1)), cwd);
    } catch {
      // fall through
    }
  }
  const firstLine = s.split(/\r?\n/).find((l) => l.trim()) || "阶段进展更新";
  return sanitizeBrief({ title: firstLine, status: "ok", bullets: [truncate(s, 36)] }, cwd);
}

const SHELL_NAMES = new Set(["bash", "shell", "local_shell", "shell_command", "exec_command", "run_command"]);

function buildConciseRuleBrief(session, deltaEvents, trigger) {
  const mutates = deltaEvents.filter((e) => e.opClass === "MUTATE");
  const verifies = deltaEvents.filter((e) => e.opClass === "VERIFY");
  const errs = deltaEvents.filter((e) => e.ok === false);
  const highRisk = deltaEvents.filter((e) => e.risk === "high");
  const subDone = deltaEvents.filter((e) => e.eventType === "SubagentStop");

  const fileList = [];
  for (const m of mutates) {
    if (isWriteToolName(m.toolName) && m.target) {
      for (const part of String(m.target).split(",")) {
        const p = shortPath(part.trim(), session.cwd);
        if (p && !fileList.includes(p)) fileList.push(p);
      }
    }
  }
  const files = fileList.slice(0, 4);

  const lastSub = subDone[subDone.length - 1];
  let title = "推进阶段任务";
  if (lastSub) title = `${lastSub.agentType} 完成阶段任务`;
  else if (trigger === "Stop") title = errs.length ? "本轮结束（含异常）" : "本轮任务完成";
  else if (highRisk.length) title = "执行外部环境变更";
  else if (files.length) title = `更新 ${files[0]} 等 ${files.length} 文件`;

  const bullets = [];
  if (lastSub?.lastMessage) bullets.push(truncate(lastSub.lastMessage, 36));
  for (const m of mutates) {
    if (bullets.length >= 3) break;
    if (SHELL_NAMES.has(String(m.toolName || "").toLowerCase())) {
      bullets.push(`执行 ${truncate(m.target, 30)}`);
    } else if (!bullets.some((b) => b.includes(m.target))) {
      bullets.push(`修改 ${shortPath(m.target, session.cwd)}`);
    }
  }
  if (!bullets.length && verifies.length) {
    const v = verifies[verifies.length - 1];
    bullets.push(`${v.ok ? "通过" : "失败"}：${truncate(v.target, 30)}`);
  }
  if (!bullets.length) bullets.push(`完成 ${deltaEvents.length} 项分析与探测动作`);

  const passV = verifies.filter((v) => v.ok).length;
  const failV = verifies.filter((v) => !v.ok).length;
  let check = "";
  if (verifies.length) {
    const lastV = verifies[verifies.length - 1];
    check =
      failV > 0 && passV > 0
        ? `重试通过（${passV} 过 / ${failV} 败）`
        : failV > 0
        ? `验证失败（${failV} 项）`
        : `验证通过（${passV} 项）${lastV.snippet ? " · " + truncate(lastV.snippet, 16) : ""}`;
  }

  let alert = "";
  let status = "ok";
  if (errs.length && verifies.every((v) => !v.ok)) {
    status = "err";
    alert = truncate(errs[errs.length - 1].snippet || errs[errs.length - 1].target, 42);
  } else if (highRisk.length || errs.length) {
    status = "warn";
    const parts = [];
    if (highRisk.length) parts.push(`含 ${highRisk.length} 条高影响变更`);
    if (errs.length) parts.push(`过程中有 ${errs.length} 次失败/重试`);
    alert = parts.join("；");
  }

  return sanitizeBrief({ title, status, bullets, files, check, alert }, session.cwd);
}

async function invokeClaudeCli(prompt, cwd, cfg) {
  const cliCfg = cfg.summarizer?.cli || {};
  const { bin, needsShell } = resolveCliBin(cliCfg.bin || "claude", cfg);
  const model = cliCfg.model || "haiku";
  const timeoutMs = Number(cliCfg.timeoutMs || 45_000);
  const disallowed = "Bash,Edit,Write,MultiEdit,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,NotebookEdit";
  const args = ["-p", "--model", model, "--no-session-persistence", "--output-format", "text", "--disallowedTools", disallowed];

  debugLog(`invoke claude CLI: ${bin} --model ${model} (shell=${needsShell})`, cfg);
  const { stdout } = await spawnCliWithStdin({ bin, args, needsShell, prompt, cwd, timeoutMs, label: "claude CLI" });
  if (!stdout) throw new Error("claude CLI 返回空输出");
  return stdout;
}

async function invokeCodexCli(prompt, cwd, cfg) {
  const cliCfg = cfg.summarizer?.cli || {};
  const { bin, needsShell } = resolveCliBin(cliCfg.codexBin || "codex", cfg);
  const model = cliCfg.codexModel || "";
  const timeoutMs = Number(cliCfg.timeoutMs || 45_000);
  const tmpOutFile = path.join(os.tmpdir(), `runmemo-codex-${process.pid}-${crypto.randomBytes(4).toString("hex")}.txt`);

  const args = ["exec", "-", "--ephemeral", "--output-last-message", tmpOutFile];
  if (model) args.push("--model", model);

  debugLog(`invoke codex CLI: ${bin} ${model ? `--model ${model}` : "(default)"} (shell=${needsShell})`, cfg);
  try {
    const { stdout } = await spawnCliWithStdin({ bin, args, needsShell, prompt, cwd, timeoutMs, label: "codex CLI" });
    let text = "";
    try {
      text = fs.readFileSync(tmpOutFile, "utf8").trim();
    } catch {
      text = "";
    }
    const result = text || stdout;
    if (!result) throw new Error("codex CLI 返回空输出");
    return result;
  } finally {
    try {
      fs.unlinkSync(tmpOutFile);
    } catch {
      // ignore
    }
  }
}

async function invokeOpencodeCli(prompt, cwd, cfg) {
  const cliCfg = cfg.summarizer?.cli || {};
  const { bin, needsShell } = resolveCliBin(cliCfg.opencodeBin || "opencode", cfg);
  const model = cliCfg.opencodeModel || "";
  const timeoutMs = Number(cliCfg.timeoutMs || 45_000);

  const args = ["run"];
  if (model) args.push("--model", model);
  args.push("Output one valid JSON brief from stdin only. Do not call any tools.");

  debugLog(`invoke opencode CLI: ${bin} ${model ? `--model ${model}` : "(default)"} (shell=${needsShell})`, cfg);
  const { stdout } = await spawnCliWithStdin({ bin, args, needsShell, prompt, cwd, timeoutMs, label: "opencode CLI" });
  if (!stdout) throw new Error("opencode CLI 返回空输出");
  return stdout;
}

function getCliBinName(tool, cfg) {
  const cliCfg = cfg.summarizer?.cli || {};
  if (tool === "codex") return cliCfg.codexBin || "codex";
  if (tool === "opencode") return cliCfg.opencodeBin || "opencode";
  return cliCfg.bin || "claude";
}

function getCliModelLabel(tool, cfg) {
  const cliCfg = cfg.summarizer?.cli || {};
  if (tool === "codex") return cliCfg.codexModel || "default";
  if (tool === "opencode") return cliCfg.opencodeModel || "default";
  return cliCfg.model || "haiku";
}

export function selectSummarizerCli(session, cfg) {
  const configured = String(cfg.summarizer?.cli?.tool || "auto").toLowerCase();
  if (configured === "claude" || configured === "codex" || configured === "opencode") {
    return configured;
  }
  const sourceMap = { cc: "claude", codex: "codex", opencode: "opencode" };
  const preferred = sourceMap[session?.agentSource] || "claude";
  const candidates = Array.from(new Set([preferred, "claude", "codex", "opencode"]));
  for (const candidate of candidates) {
    if (resolveCliBin(getCliBinName(candidate, cfg), cfg).found) {
      return candidate;
    }
  }
  return preferred;
}

async function invokeSelectedCli(tool, prompt, cwd, cfg) {
  if (tool === "codex") return invokeCodexCli(prompt, cwd, cfg);
  if (tool === "opencode") return invokeOpencodeCli(prompt, cwd, cfg);
  return invokeClaudeCli(prompt, cwd, cfg);
}

function shouldGenerateBrief(session, meta, deltaEvents, trigger, cfg) {
  if (!deltaEvents.length) return false;
  if (cfg.trigger?.skipL0 !== false && session.tier === "L0") return false;

  const significant = deltaEvents.filter(
    (e) =>
      e.opClass === "MUTATE" ||
      e.opClass === "VERIFY" ||
      e.ok === false ||
      e.eventType === "SubagentStop" ||
      e.eventType === "TaskCompleted"
  ).length;

  if (MILESTONE_TRIGGERS.has(trigger)) {
    return significant > 0 || deltaEvents.length >= 2;
  }
  if (significant >= (cfg.trigger?.batch ?? 8)) return true;

  const baseTs = Number(meta.lastSummaryAt || session.startedAt || 0);
  const elapsedSec = baseTs > 0 ? (Date.now() - baseTs) / 1000 : 0;
  return elapsedSec >= (cfg.trigger?.intervalSec ?? 45) && significant >= 2;
}

function shouldPushFeishu(brief, meta, trigger, cfg) {
  if (!cfg.outputs?.includes("feishu")) return false;
  if (MILESTONE_TRIGGERS.has(trigger) || brief.status === "err") return true;
  const elapsedSec = (Date.now() - Number(meta.lastFeishuPushAt || 0)) / 1000;
  return elapsedSec >= (cfg.feishu?.minIntervalSec ?? 60);
}

// 增量物化：仅读新增字节，仅在数据确有变化时写盘与刷新 HTML
function incrementalMaterialize(sessionId, cfg, forceRefresh = false) {
  const sp = getSessionPaths(sessionId, cfg);
  let prev = readJsonSafe(sp.snapshotFile, null);
  if (!prev || prev.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    prev = null;
  }

  let evRead = readJsonlFromOffset(sp.eventsFile, prev ? prev.eventsByteOffset : 0);
  let brRead = readJsonlFromOffset(sp.briefsFile, prev ? prev.briefsByteOffset : 0);

  // 文件被外部截断时安全回退全量重建
  if (prev && (evRead.reset || brRead.reset)) {
    prev = null;
    if (!evRead.reset) evRead = readJsonlFromOffset(sp.eventsFile, 0);
    if (!brRead.reset) brRead = readJsonlFromOffset(sp.briefsFile, 0);
  }

  const hasChanges = !prev || evRead.items.length > 0 || brRead.items.length > 0;
  let session = prev;

  if (hasChanges) {
    session = foldIntoSession(prev, sessionId, evRead.items, brRead.items, cfg);
    session.eventsByteOffset = evRead.nextOffset;
    session.briefsByteOffset = brRead.nextOffset;
    atomicWriteFile(sp.snapshotFile, JSON.stringify(session));

    if (cfg.outputs?.includes("html")) {
      updateHtmlSink(cfg, session);
    }
  } else if (forceRefresh && session && cfg.outputs?.includes("html")) {
    updateHtmlSink(cfg, session);
  }

  return { session, sp, hasChanges };
}

async function runBriefPass(sessionId, trigger, opts, cfg, preloadedSession = null) {
  const sp = getSessionPaths(sessionId, cfg);
  let session = preloadedSession;
  if (!session) {
    session = incrementalMaterialize(sessionId, cfg).session;
  }
  if (!session) return session;

  const meta = readJsonSafe(sp.metaFile, {
    lastSummarizedByteOffset: 0,
    lastSummarizedEventCount: 0,
    lastSummaryAt: 0,
    lastFeishuPushAt: 0,
  });

  // 先清除进入本轮概括前的旧 pending 标记（本轮将读取到当前最新 EOF；若概括期间再有新事件进来会重写该标记）
  try {
    fs.unlinkSync(sp.pendingFlagFile);
  } catch {
    // ignore
  }

  // 增量字节读取自上次概括以来的新增事件（O(Δ)，不重读历史前缀）
  const deltaRead = readJsonlFromOffset(sp.eventsFile, meta.lastSummarizedByteOffset || 0);
  const deltaEvents = deltaRead.items;

  if (!shouldGenerateBrief(session, meta, deltaEvents, trigger, cfg)) {
    return session;
  }

  let briefCore = null;
  const selectedTool = selectSummarizerCli(session, cfg);
  let source = `${selectedTool}-cli`;
  let usedModel = getCliModelLabel(selectedTool, cfg);

  if (opts.mockLlm) {
    source = "mock";
    usedModel = "mock";
    briefCore = buildConciseRuleBrief(session, deltaEvents, trigger);
  } else {
    const prompt = buildConcisePrompt(session, deltaEvents, trigger);
    try {
      const raw = await invokeSelectedCli(selectedTool, prompt, sp.dir, cfg);
      briefCore = parseLlmJson(raw, session.cwd);
    } catch (err) {
      debugLog(`cli summarize (${selectedTool}) failed, fallback: ${err.message}`, cfg);
      source = "fallback";
      briefCore = buildConciseRuleBrief(session, deltaEvents, trigger);
    }
  }

  if (!briefCore) return session;

  const startIdx = Number(meta.lastSummarizedEventCount || 0) + 1;
  const endIdx = startIdx + deltaEvents.length - 1;

  const entry = {
    id: `br_${Date.now()}`,
    ts: Date.now(),
    trigger,
    source,
    model: usedModel,
    eventRange: [startIdx, endIdx],
    ...briefCore,
  };

  appendJsonl(sp.briefsFile, entry);

  // 在短周期 worker.lock 保护下重新增量物化，避免用旧快照覆盖 LLM 耗时期间并发写入的新事件
  const gotShortLock = acquireLockWithRetry(sp.workerLockFile, 12_000, 6, 25);
  try {
    session = incrementalMaterialize(sessionId, cfg, true).session;
  } finally {
    if (gotShortLock) releaseLock(sp.workerLockFile);
  }

  const nextMeta = {
    ...meta,
    lastSummarizedByteOffset: deltaRead.nextOffset,
    lastSummarizedEventCount: endIdx,
    lastSummaryAt: Date.now(),
  };

  if (cfg.outputs?.includes("feishu")) {
    const previewCard = buildFeishuCardPayload(session, entry, "");
    atomicWriteFile(sp.feishuPreviewFile, JSON.stringify(previewCard, null, 2));

    if (opts.sendFeishu && cfg.feishu?.webhook && shouldPushFeishu(entry, meta, trigger, cfg)) {
      const res = await sendFeishuBrief(session, entry, cfg);
      if (res.sent) {
        nextMeta.lastFeishuPushAt = Date.now();
      }
    }
  }

  atomicWriteFile(sp.metaFile, JSON.stringify(nextMeta, null, 2));
  return session;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.sessionId) return;

  const cfg = loadConfig();
  const sp = getSessionPaths(opts.sessionId, cfg);

  // 第 1 步：抢占短周期 worker.lock 合并快速刷新；若抢不到说明已有同会话 worker 在跑，直接退出
  const gotWorkerLock = acquireLock(sp.workerLockFile, 12_000);
  if (!gotWorkerLock) {
    if (MILESTONE_TRIGGERS.has(opts.trigger)) {
      try {
        fs.writeFileSync(sp.pendingFlagFile, opts.trigger, "utf8");
      } catch {
        // ignore
      }
    }
    return;
  }

  let session = null;
  try {
    // 仅执行 1 次增量物化
    session = incrementalMaterialize(opts.sessionId, cfg).session;
  } finally {
    releaseLock(sp.workerLockFile);
  }

  // 第 2 步：抢占单飞 llm.lock 执行异步概括
  if (!acquireLock(sp.llmLockFile, cfg.lockStaleMs || 90_000)) {
    if (MILESTONE_TRIGGERS.has(opts.trigger)) {
      try {
        fs.writeFileSync(sp.pendingFlagFile, opts.trigger, "utf8");
      } catch {
        // ignore
      }
    }
    return;
  }

  try {
    session = await runBriefPass(opts.sessionId, opts.trigger, opts, cfg, session);

    // 尾排空：消费概括期间新到的 pending 里程碑或被合并的新增事件
    for (let i = 0; i < 2; i++) {
      if (fs.existsSync(sp.pendingFlagFile)) {
        let pending = "Stop";
        try {
          pending = fs.readFileSync(sp.pendingFlagFile, "utf8").trim() || "Stop";
          fs.unlinkSync(sp.pendingFlagFile);
        } catch {
          break;
        }
        const gotWL = acquireLockWithRetry(sp.workerLockFile, 12_000, 4, 20);
        try {
          session = incrementalMaterialize(opts.sessionId, cfg).session;
        } finally {
          if (gotWL) releaseLock(sp.workerLockFile);
        }
        session = await runBriefPass(opts.sessionId, pending, opts, cfg, session);
        continue;
      }
      // 即使没有 pending 里程碑，若期间有被 coalescing 合并进来的新事件，也顺手增量物化一次刷新 HTML
      try {
        const curSize = fs.statSync(sp.eventsFile).size;
        if (session && curSize > session.eventsByteOffset) {
          const gotWL = acquireLockWithRetry(sp.workerLockFile, 12_000, 4, 20);
          try {
            session = incrementalMaterialize(opts.sessionId, cfg).session;
          } finally {
            if (gotWL) releaseLock(sp.workerLockFile);
          }
        }
      } catch {
        // ignore
      }
      break;
    }
  } finally {
    releaseLock(sp.llmLockFile);
  }
}

const entryArg = process.argv[1] ? path.resolve(process.argv[1]) : "";
const selfPath = path.resolve(fileURLToPath(import.meta.url));
const isDirectRun =
  Boolean(entryArg) &&
  (process.platform === "win32" ? entryArg.toLowerCase() === selfPath.toLowerCase() : entryArg === selfPath);
if (isDirectRun) {
  main().catch((err) => debugLog(`summarizer error: ${err?.message || err}`));
}
