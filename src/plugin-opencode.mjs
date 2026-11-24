/**
 * runmemo · OpenCode 原生插件（零外部依赖，支持 Bun / Node ESM）
 * 注意：仅使用具名导出 `RunmemoPlugin`，严禁同时 `export default`，避免 OpenCode 插件加载器双倍注册回调！
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

function setBounded(map, key, value, max = 200) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

export async function RunmemoPlugin(ctx) {
  // 递归防爆：runmemo 调 `opencode run` 概括时直接返回空插件对象
  if (process.env.RUNMEMO_INTERNAL === "1") {
    return {};
  }

  const cwd = ctx?.worktree || ctx?.directory || process.cwd();
  const callArgs = new Map();
  const childToParent = new Map();
  const childMeta = new Map();
  const userMsgIds = new Map();
  const seenPromptIds = new Map();

  function resolveRoot(sid) {
    let cur = sid;
    const guard = new Set();
    while (cur && childToParent.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      cur = childToParent.get(cur);
    }
    return cur || sid || "opencode-session";
  }

  function emitEvent(rawSessionId, partial) {
    try {
      const rootSessionId = resolveRoot(rawSessionId);
      const isChild = Boolean(rawSessionId && rawSessionId !== rootSessionId);
      const event = {
        ts: Date.now(),
        sessionId: rootSessionId,
        agentSource: "opencode",
        cwd,
        agentId: partial.agentId ?? (isChild ? String(rawSessionId) : ""),
        agentType: partial.agentType ?? (isChild ? childMeta.get(rawSessionId) || "subagent" : ""),
        ...partial,
      };

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
      if (workerBusy) return;

      if (!isImmediate) {
        const fastRefreshMs = Number.parseInt(process.env.RUNMEMO_FAST_REFRESH_MS || "2000", 10) || 2000;
        if (isFreshFile(snapshotFile, fastRefreshMs)) return;
      }

      if (process.env.RUNMEMO_SKIP_SPAWN === "1") return;

      const workerScript = path.join(__dirname, "summarizer.mjs");
      const nodeBin = process.env.RUNMEMO_NODE_BIN || "node";
      const child = cp.spawn(nodeBin, [workerScript, "--session", event.sessionId, "--trigger", event.eventType], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, RUNMEMO_INTERNAL: "1" },
      });
      child.unref();
    } catch {
      // 永远 fail-open，绝不影响 OpenCode 主流程
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      try {
        const callID = input?.callID;
        if (!callID) return;
        const args = output?.args ?? input?.args;
        if (args !== undefined) {
          setBounded(callArgs, callID, args);
        }
      } catch {
        // never throw
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const toolName = String(input?.tool || "unknown");
        const rawSid = String(input?.sessionID || output?.sessionID || "opencode-session");
        const callID = input?.callID;
        const cachedArgs = callID && callArgs.has(callID) ? callArgs.get(callID) : undefined;
        if (callID) callArgs.delete(callID);

        const toolInput = cachedArgs ?? input?.args ?? output?.metadata?.args ?? {};
        const { opClass, risk } = classify.classifyTool(toolName, toolInput);
        let target = classify.extractTarget(toolName, toolInput, cwd);
        if (!target && output?.title) {
          target = classify.truncate(classify.redactSecrets(output.title), 100);
        }
        const { ok, snippet } = classify.extractResponseSnippet({ output: output?.output, error: output?.error });

        emitEvent(rawSid, {
          eventType: "PostToolUse",
          toolName,
          opClass,
          risk,
          target,
          ok,
          snippet,
        });
      } catch {
        // never throw
      }
    },

    event: async ({ event }) => {
      try {
        if (!event || !event.type) return;
        const props = event.properties || {};

        if (event.type === "session.created") {
          const info = props.info || props;
          const sid = info?.id ? String(info.id) : "";
          if (!sid) return;

          if (info.parentID) {
            const root = resolveRoot(String(info.parentID));
            const title = classify.truncate(info.title || "subagent", 48);
            setBounded(childToParent, sid, root);
            setBounded(childMeta, sid, title);
            emitEvent(root, {
              eventType: "SubagentStart",
              agentId: sid,
              agentType: title,
              detail: classify.truncate(info.title || "", 120),
            });
          } else {
            emitEvent(sid, {
              eventType: "SessionStart",
              agentId: "",
              agentType: "",
            });
          }
          return;
        }

        if (event.type === "session.idle") {
          const sid = String(props.sessionID || props.info?.id || "");
          if (!sid) return;
          if (childToParent.has(sid)) {
            const root = resolveRoot(sid);
            emitEvent(root, {
              eventType: "SubagentStop",
              agentId: sid,
              agentType: childMeta.get(sid) || "subagent",
              lastMessage: "",
            });
          } else {
            emitEvent(sid, {
              eventType: "Stop",
              agentId: "",
              agentType: "",
            });
          }
          return;
        }

        if (event.type === "session.error") {
          const sid = String(props.sessionID || props.info?.id || "opencode-session");
          const errText =
            props.error?.data?.message ||
            props.error?.message ||
            props.message ||
            (typeof props.error === "string" ? props.error : "OpenCode session error");
          emitEvent(sid, {
            eventType: "PostToolUseFailure",
            toolName: "session",
            opClass: "OTHER",
            risk: "normal",
            target: "session.error",
            ok: false,
            snippet: classify.truncate(classify.redactSecrets(errText), 140),
          });
          return;
        }

        if (event.type === "message.updated") {
          const info = props.info || {};
          if (info.role === "user" && info.id) {
            const msgId = String(info.id);
            const sid = String(info.sessionID || "");
            setBounded(userMsgIds, msgId, sid);
            if (!seenPromptIds.has(msgId)) {
              const text =
                info.summary?.title ||
                (Array.isArray(props.parts)
                  ? props.parts.find((p) => p?.type === "text" && p?.text)?.text
                  : "") ||
                "";
              if (sid && text) {
                setBounded(seenPromptIds, msgId, true);
                emitEvent(sid, {
                  eventType: "UserPromptSubmit",
                  prompt: classify.truncate(classify.redactSecrets(text), 180),
                });
              }
            }
          }
          return;
        }

        if (event.type === "message.part.updated") {
          const part = props.part || {};
          const msgId = part.messageID ? String(part.messageID) : "";
          const isUser =
            props.role === "user" ||
            part.role === "user" ||
            Boolean(msgId && userMsgIds.has(msgId));
          const sid = String(part.sessionID || (msgId ? userMsgIds.get(msgId) : "") || "");
          if (part.type === "text" && part.text && isUser && msgId && sid && !seenPromptIds.has(msgId)) {
            setBounded(seenPromptIds, msgId, true);
            emitEvent(sid, {
              eventType: "UserPromptSubmit",
              prompt: classify.truncate(classify.redactSecrets(part.text), 180),
            });
          }
        }
      } catch {
        // never throw
      }
    },
  };
}
