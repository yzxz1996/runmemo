import crypto from "node:crypto";
import { debugLog } from "../core.mjs";

export function generateFeishuSign(secret, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac("sha256", stringToSign).update("").digest("base64");
  return { timestamp, sign };
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m${rem}s` : `${m}m`;
}

function sourceLabel(src) {
  const map = { cc: "Claude Code", codex: "Codex", opencode: "OpenCode" };
  return map[src] || src || "Claude Code";
}

function triggerLabel(trigger) {
  const map = {
    Stop: "本轮完成",
    SubagentStop: "子任务完成",
    TaskCompleted: "里程碑完成",
    PostToolUse: "阶段更新",
    PostToolUseFailure: "异常更新",
    Manual: "手动触发",
  };
  return map[trigger] || trigger || "阶段更新";
}

function headerTemplate(brief, session) {
  if (brief.status === "err") return "red";
  if (brief.status === "warn" || session.tier === "L3") return "orange";
  if (brief.trigger === "Stop" || session.status === "idle") return "green";
  return "blue";
}

function statusIcon(brief, session) {
  if (brief.status === "err") return "🔴";
  if (brief.status === "warn") return "🟠";
  if (brief.trigger === "Stop" || session.status === "idle") return "✅";
  return "🔵";
}

export function buildFeishuCardPayload(session, brief, secret = "") {
  const project = session.projectName || session.sessionId.slice(0, 12);
  const titleText = `${statusIcon(brief, session)} ${project} · ${brief.title}`;

  const bulletLines = (brief.bullets || []).slice(0, 3).map((b) => `• ${b}`);
  const elements = [];

  if (bulletLines.length) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: bulletLines.join("\n"),
      },
    });
  }

  // 紧凑元信息区：只输出非空字段，彻底拒绝“暂无/无”占位废话
  const metaLines = [];
  if (brief.check) {
    metaLines.push(`**验证**　${brief.check}`);
  }
  if (brief.files?.length) {
    const fileText = brief.files.slice(0, 4).map((f) => `\`${f}\``).join(" · ");
    metaLines.push(`**改动**　${fileText}`);
  }
  if (session.subagents?.length) {
    const subText = session.subagents
      .slice(0, 5)
      .map((sa) => `${sa.status === "done" ? "✅" : "🔄"} ${sa.agentType}`)
      .join(" · ");
    metaLines.push(`**子任务**　${subText}`);
  }

  if (metaLines.length) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: metaLines.join("\n"),
      },
    });
  }

  if (brief.alert) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `⚠️ **留意**：${brief.alert}`,
      },
    });
  }

  const footerParts = [
    sourceLabel(session.agentSource),
    session.tier,
    fmtDuration(session.durationSec),
    triggerLabel(brief.trigger),
  ];
  if (brief.eventRange) {
    footerParts.push(`#${brief.eventRange[0]}~#${brief.eventRange[1]}`);
  }
  footerParts.push("runmemo");

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: footerParts.join(" · "),
      },
    ],
  });

  const payload = {
    msg_type: "interactive",
    card: {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: headerTemplate(brief, session),
        title: {
          tag: "plain_text",
          content: titleText,
        },
      },
      elements,
    },
  };

  if (secret) {
    const { timestamp, sign } = generateFeishuSign(secret);
    payload.timestamp = timestamp;
    payload.sign = sign;
  }

  return payload;
}

export async function sendFeishuBrief(session, brief, cfg) {
  const webhook = cfg.feishu?.webhook;
  if (!webhook) {
    return { sent: false, reason: "feishu.webhook 未配置" };
  }

  const payload = buildFeishuCardPayload(session, brief, cfg.feishu?.secret || "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
    const ok = res.ok && (!json || json.code === 0 || json.StatusCode === 0);
    if (!ok) {
      const msg = json?.msg || json?.StatusMessage || `HTTP ${res.status}: ${text.slice(0, 120)}`;
      debugLog(`feishu send failed: ${msg}`, cfg);
      return { sent: false, reason: msg, payload };
    }
    return { sent: true, payload };
  } catch (err) {
    debugLog(`feishu send error: ${err.message}`, cfg);
    return { sent: false, reason: err.message, payload };
  } finally {
    clearTimeout(timer);
  }
}
