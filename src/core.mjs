import fs from "node:fs";
import path from "node:path";
import { ensureDir, getRuntimePaths, loadConfig } from "./config.mjs";
import {
  classifyTool,
  extractPatchFiles,
  extractResponseSnippet,
  extractTarget,
  isWriteToolName,
  redactSecrets,
  shortPath,
  truncate,
  WRITE_TOOLS_LOWER,
} from "./classify.mjs";

export {
  classifyTool,
  extractPatchFiles,
  extractResponseSnippet,
  extractTarget,
  isWriteToolName,
  redactSecrets,
  shortPath,
  truncate,
  WRITE_TOOLS_LOWER,
};

export const SNAPSHOT_SCHEMA_VERSION = 3;

export function debugLog(msg, cfg = loadConfig()) {
  if (!cfg.debug) return;
  try {
    const { homeDir, debugLog: logPath } = getRuntimePaths(cfg);
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        ensureDir(homeDir);
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
      }
    }
  } catch {
    // 永远静默失败
  }
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return fallback;
  }
}

// 增量字节偏移读取 JSONL：仅读取 [byteOffset, EOF) 的新增字节，将 O(N) 降为 O(Δ)
// 按 0x0A ('\n') 对齐边界，保证 UTF-8 多字节字符与 JSON 行永远完整
export function readJsonlFromOffset(filePath, byteOffset = 0) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { items: [], nextOffset: 0, fileSize: 0, reset: false };
  }

  const fileSize = stat.size;
  let offset = Number(byteOffset || 0);
  let reset = false;
  if (offset < 0 || offset > fileSize) {
    offset = 0;
    reset = true;
  }
  if (fileSize === offset) {
    return { items: [], nextOffset: offset, fileSize, reset };
  }

  const len = fileSize - offset;
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(filePath, "r");
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, len, offset);
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead <= 0) {
    return { items: [], nextOffset: offset, fileSize, reset };
  }

  const slice = buf.subarray(0, bytesRead);
  const lastNl = slice.lastIndexOf(0x0a);
  if (lastNl < 0) {
    // 尚未写完完整一行，下次再读
    return { items: [], nextOffset: offset, fileSize, reset };
  }

  const text = slice.subarray(0, lastNl + 1).toString("utf8");
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // 忽略异常行
    }
  }
  return { items, nextOffset: offset + lastNl + 1, fileSize, reset };
}

export function readJsonlSafe(filePath) {
  return readJsonlFromOffset(filePath, 0).items;
}

export function appendJsonl(filePath, obj) {
  const line = JSON.stringify(obj) + "\n";
  try {
    fs.appendFileSync(filePath, line, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      ensureDir(path.dirname(filePath));
      fs.appendFileSync(filePath, line, "utf8");
    } else {
      throw err;
    }
  }
}

function createEmptySession(sessionId, firstTs = Date.now()) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId,
    agentSource: "cc",
    projectName: "",
    cwd: "",
    status: "running",
    tier: "L0",
    startedAt: firstTs,
    updatedAt: firstTs,
    durationSec: 0,
    latestPrompt: "",
    eventsByteOffset: 0,
    briefsByteOffset: 0,
    counts: {
      totalEvents: 0,
      read: 0,
      mutate: 0,
      verify: 0,
      errors: 0,
      highRisk: 0,
      subagentsTotal: 0,
      subagentsRunning: 0,
    },
    touchedFiles: [],
    subagents: [],
    ledger: [],
    timeline: [],
    briefs: [],
    latestBrief: null,
  };
}

// 增量折叠新事件与新简报到现有快照上（O(Δ) 耗时）
export function foldIntoSession(prevSnapshot, sessionId, newEvents, newBriefs, cfg = loadConfig()) {
  const isFresh = !prevSnapshot || prevSnapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION;
  const session = isFresh
    ? createEmptySession(sessionId, newEvents[0]?.ts || Date.now())
    : prevSnapshot;

  const fileSet = new Set(session.touchedFiles || []);
  const subMap = new Map();
  for (const sa of session.subagents || []) {
    subMap.set(sa.agentId, sa);
  }

  for (const ev of newEvents) {
    if (session.counts.totalEvents === 0 && ev.ts) {
      session.startedAt = ev.ts;
    }
    if (ev.ts && ev.ts > session.updatedAt) {
      session.updatedAt = ev.ts;
    }
    session.counts.totalEvents += 1;

    if (ev.agentSource) {
      session.agentSource = ev.agentSource;
    }
    if (ev.cwd && !session.cwd) {
      session.cwd = ev.cwd;
      session.projectName = path.basename(ev.cwd) || ev.cwd;
    }

    if (ev.eventType === "SessionStart") {
      session.status = "running";
    } else if (ev.eventType === "UserPromptSubmit") {
      session.status = "running";
      if (ev.prompt) session.latestPrompt = ev.prompt;
    } else if (ev.eventType === "SubagentStart") {
      const id = ev.agentId || `sub-${subMap.size + 1}`;
      const sa = subMap.get(id) || {
        agentId: id,
        agentType: ev.agentType || "subagent",
        status: "running",
        startedAt: ev.ts,
        endedAt: null,
        durationSec: 0,
        toolCount: 0,
        mutateCount: 0,
        errorCount: 0,
        lastNote: ev.detail || "",
      };
      sa.status = "running";
      if (ev.agentType) sa.agentType = ev.agentType;
      subMap.set(id, sa);
      session.ledger.push({
        ts: ev.ts,
        kind: "SUBAGENT",
        agentId: id,
        title: `启动 ${sa.agentType}`,
        target: ev.detail || id,
        ok: true,
        risk: "normal",
        snippet: "",
      });
    } else if (ev.eventType === "SubagentStop") {
      const id = ev.agentId || "subagent";
      const sa = subMap.get(id) || {
        agentId: id,
        agentType: ev.agentType || "subagent",
        status: "done",
        startedAt: ev.ts,
        endedAt: ev.ts,
        durationSec: 0,
        toolCount: 0,
        mutateCount: 0,
        errorCount: 0,
        lastNote: "",
      };
      sa.status = "done";
      sa.endedAt = ev.ts;
      sa.durationSec = Math.max(0, Math.round((ev.ts - sa.startedAt) / 1000));
      if (ev.lastMessage) sa.lastNote = ev.lastMessage;
      subMap.set(id, sa);
      session.ledger.push({
        ts: ev.ts,
        kind: "SUBAGENT",
        agentId: id,
        title: `完成 ${sa.agentType}`,
        target: `${sa.durationSec}s`,
        ok: true,
        risk: "normal",
        snippet: ev.lastMessage || "",
      });
    } else if (ev.eventType === "TaskCompleted") {
      session.ledger.push({
        ts: ev.ts,
        kind: "TASK",
        agentId: ev.agentId || "main",
        title: "里程碑",
        target: ev.taskSubject || ev.detail || "完成",
        ok: true,
        risk: "normal",
        snippet: "",
      });
    } else if (ev.eventType === "PostToolUse" || ev.eventType === "PostToolUseFailure") {
      const op = ev.opClass || "OTHER";
      if (op === "READ") session.counts.read += 1;
      else if (op === "MUTATE") session.counts.mutate += 1;
      else if (op === "VERIFY") session.counts.verify += 1;
      if (!ev.ok) session.counts.errors += 1;
      if (ev.risk === "high") session.counts.highRisk += 1;

      if (isWriteToolName(ev.toolName) && ev.target) {
        for (const part of String(ev.target).split(",")) {
          const trimmed = part.trim();
          if (trimmed) fileSet.add(shortPath(trimmed, session.cwd));
        }
      }
      if (ev.agentId && subMap.has(ev.agentId)) {
        const sa = subMap.get(ev.agentId);
        sa.toolCount += 1;
        if (op === "MUTATE") sa.mutateCount += 1;
        if (!ev.ok) sa.errorCount += 1;
        sa.durationSec = Math.max(0, Math.round((ev.ts - sa.startedAt) / 1000));
      }
      if (op === "MUTATE" || op === "VERIFY" || !ev.ok || ev.risk === "high") {
        session.ledger.push({
          ts: ev.ts,
          kind: !ev.ok ? "ERROR" : op,
          agentId: ev.agentId || "main",
          title: ev.toolName || "Tool",
          target: ev.target || "",
          ok: Boolean(ev.ok),
          risk: ev.risk || "normal",
          snippet: ev.snippet || "",
        });
      }
    } else if (ev.eventType === "Stop" || ev.eventType === "SessionEnd") {
      session.status = "idle";
    }

    session.timeline.push({
      ts: ev.ts,
      eventType: ev.eventType,
      agentId: ev.agentId || "main",
      toolName: ev.toolName || "",
      opClass: ev.opClass || "",
      ok: ev.ok ?? true,
      risk: ev.risk || "normal",
      target: ev.target || ev.prompt || ev.lastMessage || ev.taskSubject || "",
      snippet: ev.snippet || "",
    });
  }

  if (newBriefs && newBriefs.length) {
    session.briefs.push(...newBriefs);
    if (session.briefs.length > 60) {
      session.briefs = session.briefs.slice(-60);
    }
    session.latestBrief = session.briefs[session.briefs.length - 1];
  }

  session.durationSec = Math.max(0, Math.round((session.updatedAt - session.startedAt) / 1000));
  session.touchedFiles = Array.from(fileSet);
  session.subagents = Array.from(subMap.values()).sort((a, b) => a.startedAt - b.startedAt);
  session.counts.subagentsTotal = session.subagents.length;
  session.counts.subagentsRunning = session.subagents.filter((s) => s.status === "running").length;

  if (session.status === "idle") {
    for (const sa of session.subagents) {
      if (sa.status === "running") sa.status = "done";
    }
    session.counts.subagentsRunning = 0;
  }

  const totalTools = session.counts.read + session.counts.mutate + session.counts.verify;
  if (session.counts.highRisk > 0) session.tier = "L3";
  else if (session.counts.mutate > 0 || session.counts.verify > 0) session.tier = "L2";
  else if (
    session.counts.subagentsTotal > 0 ||
    totalTools >= (cfg.trigger?.l1MinTools ?? 4) ||
    session.durationSec >= (cfg.trigger?.l1MinSec ?? 25)
  ) {
    session.tier = "L1";
  } else {
    session.tier = "L0";
  }

  if (session.ledger.length > 120) session.ledger = session.ledger.slice(-120);
  if (session.timeline.length > 100) session.timeline = session.timeline.slice(-100);

  return session;
}

// 兼容全量构建接口
export function materializeSession(sessionId, events, briefs, cfg = loadConfig()) {
  return foldIntoSession(null, sessionId, events || [], briefs || [], cfg);
}
