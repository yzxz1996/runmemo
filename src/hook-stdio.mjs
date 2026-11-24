/**
 * runmemo · Claude Code & Codex 共用零阻塞 Stdio Hook 引擎
 * 原则：零拦截、零阻塞、防递归（调用入口先于 import 检查 RUNMEMO_INTERNAL=1）、永远 exit 0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import url from "node:url";
import * as classify from "./classify.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MILESTONE_EVENTS = new Set(["SubagentStop", "TaskCompleted", "Stop"]);
const IMMEDIATE_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "TaskCompleted",
  "Stop",
]);

function readStdinWithTimeout(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function fastAppendLine(filePath, line) {
  try {
    fs.appendFileSync(filePath, line, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, line, "utf8");
    }
  }
}

function isFreshFile(filePath, maxAgeMs) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

export function normalizeStdioPayload(payload, defaultAgentSource = "cc") {
  const now = Date.now();
  let eventType = String(payload.hook_event_name || payload.event || "Unknown");
  // 将 Codex 的 SessionEnd 归一为 Stop，确保自动触发最终阶段简报
  if (eventType === "SessionEnd") eventType = "Stop";

  const sessionId = String(payload.session_id || payload.thread_id || "default-session");
  const cwd = payload.cwd ? String(payload.cwd) : "";
  const agentId = payload.agent_id ? String(payload.agent_id) : "";
  const agentType = payload.agent_type ? String(payload.agent_type) : "";
  const agentSource = payload.agent_source ? String(payload.agent_source) : defaultAgentSource;

  const base = { ts: now, sessionId, agentSource, eventType, cwd, agentId, agentType };

  if (eventType === "UserPromptSubmit") {
    return {
      ...base,
      prompt: classify.truncate(classify.redactSecrets(payload.prompt || payload.user_prompt || ""), 180),
    };
  }
  if (eventType === "PostToolUse" || eventType === "PostToolUseFailure") {
    const toolName = String(payload.tool_name || "");
    const toolInput = payload.tool_input ?? {};
    const { opClass, risk } = classify.classifyTool(toolName, toolInput);
    const target = classify.extractTarget(toolName, toolInput, cwd);
    const { ok, snippet } = classify.extractResponseSnippet(payload);
    return {
      ...base,
      toolName,
      opClass,
      risk,
      target,
      ok: eventType === "PostToolUseFailure" ? false : ok,
      snippet,
    };
  }
  if (eventType === "SubagentStart") {
    return {
      ...base,
      detail: classify.truncate(classify.redactSecrets(payload.description || payload.prompt || ""), 120),
    };
  }
  if (eventType === "SubagentStop" || eventType === "Stop") {
    const msg = payload.last_assistant_message || "";
    return msg
      ? { ...base, lastMessage: classify.truncate(classify.redactSecrets(msg), 180) }
      : base;
  }
  if (eventType === "TaskCompleted") {
    return {
      ...base,
      taskId: payload.task_id ? String(payload.task_id) : "",
      taskSubject: classify.truncate(classify.redactSecrets(payload.task_subject || payload.subject || ""), 120),
      detail: classify.truncate(classify.redactSecrets(payload.task_description || ""), 140),
    };
  }
  return base;
}

export async function runStdioHook(defaultAgentSource = "cc") {
  const raw = await readStdinWithTimeout(1500);
  if (!raw || !raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const event = normalizeStdioPayload(payload, defaultAgentSource);
  const homeDir = process.env.RUNMEMO_HOME || path.join(os.homedir(), ".runmemo");
  const safeId = event.sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const sessionDir = path.join(homeDir, "sessions", safeId);
  const eventsFile = path.join(sessionDir, "events.jsonl");
  const snapshotFile = path.join(sessionDir, "snapshot.json");
  const workerLockFile = path.join(sessionDir, "worker.lock");
  const llmLockFile = path.join(sessionDir, "llm.lock");
  const pendingFlagFile = path.join(sessionDir, "pending.flag");

  fastAppendLine(eventsFile, JSON.stringify(event) + "\n");

  const isMilestone = MILESTONE_EVENTS.has(event.eventType);
  const isImmediate = IMMEDIATE_EVENTS.has(event.eventType);

  const workerBusy = isFreshFile(workerLockFile, 12_000);
  const llmBusy = isFreshFile(llmLockFile, 90_000);

  if (isMilestone && (workerBusy || llmBusy)) {
    try {
      fs.writeFileSync(pendingFlagFile, event.eventType, "utf8");
    } catch {
      // ignore
    }
  }
  if (workerBusy) {
    return;
  }

  if (!isImmediate) {
    const fastRefreshMs = Number.parseInt(process.env.RUNMEMO_FAST_REFRESH_MS || "2000", 10) || 2000;
    if (isFreshFile(snapshotFile, fastRefreshMs)) {
      return;
    }
  }

  if (process.env.RUNMEMO_SKIP_SPAWN === "1") {
    return;
  }

  const workerScript = path.join(__dirname, "summarizer.mjs");
  const child = cp.spawn(process.execPath, [workerScript, "--session", event.sessionId, "--trigger", event.eventType], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, RUNMEMO_INTERNAL: "1" },
  });
  child.unref();
}
