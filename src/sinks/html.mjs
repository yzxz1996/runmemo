import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, ensureDir, getRuntimePaths, loadConfig, safeSessionId, sleepSync } from "../config.mjs";
import { readJsonSafe } from "../core.mjs";

const TEMPLATE_VERSION = "2.2.1";

function toIndexEntry(snap) {
  return {
    sessionId: snap.sessionId,
    safeId: safeSessionId(snap.sessionId),
    agentSource: snap.agentSource || "cc",
    projectName: snap.projectName || "",
    status: snap.status || "idle",
    tier: snap.tier || "L0",
    updatedAt: snap.updatedAt || 0,
    durationSec: snap.durationSec || 0,
    latestTitle: snap.latestBrief?.title || "",
    latestPrompt: snap.latestPrompt || "",
    mutate: snap.counts?.mutate || 0,
    verify: snap.counts?.verify || 0,
    subagentsTotal: snap.counts?.subagentsTotal || 0,
    briefCount: snap.briefs?.length || 0,
  };
}

function writeSessionViewJs(htmlViewsDir, snap) {
  const safeId = safeSessionId(snap.sessionId);
  const viewPath = path.join(htmlViewsDir, `${safeId}.js`);
  const content =
    `window.__RUNMEMO_VIEWS__=window.__RUNMEMO_VIEWS__||{};` +
    `window.__RUNMEMO_VIEWS__[${JSON.stringify(snap.sessionId)}]=${JSON.stringify(snap)};\n`;
  atomicWriteFile(viewPath, content);
}

function bootstrapIndexFromDisk(cfg) {
  const { sessionsDir, htmlViewsDir } = getRuntimePaths(cfg);
  if (!fs.existsSync(sessionsDir)) return [];
  ensureDir(htmlViewsDir);

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const snaps = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const snap = readJsonSafe(path.join(sessionsDir, ent.name, "snapshot.json"), null);
    if (snap && snap.sessionId) snaps.push(snap);
  }
  snaps.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const kept = snaps.slice(0, cfg.maxSessions || 30);

  for (const snap of kept) {
    const viewPath = path.join(htmlViewsDir, `${safeSessionId(snap.sessionId)}.js`);
    if (!fs.existsSync(viewPath)) {
      writeSessionViewJs(htmlViewsDir, snap);
    }
  }
  return kept.map(toIndexEntry);
}

function buildHtmlTemplate() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="runmemo-template-version" content="${TEMPLATE_VERSION}" />
  <title>runmemo · AI 工作简报</title>
  <style>
    :root {
      --bg: #f7f8fa;
      --surface: #ffffff;
      --subtle: #f2f4f7;
      --border: #e5e7eb;
      --text: #111827;
      --text-2: #374151;
      --muted: #6b7280;
      --accent: #2563eb;
      --accent-bg: rgba(37, 99, 235, 0.08);
      --ok: #15803d;
      --ok-bg: rgba(21, 128, 61, 0.10);
      --warn: #b45309;
      --warn-bg: rgba(180, 83, 9, 0.10);
      --err: #b91c1c;
      --err-bg: rgba(185, 28, 28, 0.10);
      --purple: #6d28d9;
      --purple-bg: rgba(109, 40, 217, 0.10);
    }
    [data-theme="dark"] {
      --bg: #0c0e13;
      --surface: #141720;
      --subtle: #1b202c;
      --border: #252c3b;
      --text: #f3f4f6;
      --text-2: #d1d5db;
      --muted: #8b95a7;
      --accent: #60a5fa;
      --accent-bg: rgba(96, 165, 250, 0.12);
      --ok: #4ade80;
      --ok-bg: rgba(74, 222, 128, 0.12);
      --warn: #fbbf24;
      --warn-bg: rgba(251, 191, 36, 0.13);
      --err: #f87171;
      --err-bg: rgba(248, 113, 113, 0.13);
      --purple: #a78bfa;
      --purple-bg: rgba(167, 139, 250, 0.13);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .topbar {
      position: sticky; top: 0; z-index: 20;
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
      padding: 11px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
    .dot-live { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
    .controls { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
    .btn {
      border: 1px solid var(--border); background: var(--surface); color: var(--text-2);
      border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }

    .shell { display: grid; grid-template-columns: 272px 1fr; min-height: calc(100vh - 48px); }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); max-height: 230px; }
    }
    .sidebar {
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 14px 12px;
      overflow-y: auto;
    }
    .side-label { font-size: 11.5px; font-weight: 600; color: var(--muted); padding: 0 6px 8px; display: flex; justify-content: space-between; }
    .sess {
      padding: 10px 11px; border-radius: 9px; margin-bottom: 6px;
      border: 1px solid transparent; cursor: pointer;
      transition: background 0.14s, border-color 0.14s;
    }
    .sess:hover { background: var(--subtle); }
    .sess.active { background: var(--accent-bg); border-color: var(--accent); }
    .sess-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .sess-proj { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sess-title { font-size: 12.5px; color: var(--text-2); margin: 4px 0 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sess-foot { font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; }

    .main { padding: 20px 26px; max-width: 960px; width: 100%; }
    .pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
      background: var(--subtle); color: var(--muted);
    }
    .pill.ok, .pill.L2, .pill.running { background: var(--ok-bg); color: var(--ok); }
    .pill.warn, .pill.MUTATE { background: var(--warn-bg); color: var(--warn); }
    .pill.err, .pill.L3, .pill.ERROR, .pill.high { background: var(--err-bg); color: var(--err); }
    .pill.L1, .pill.VERIFY { background: var(--accent-bg); color: var(--accent); }
    .pill.SUBAGENT, .pill.TASK { background: var(--purple-bg); color: var(--purple); }
    .pill.src { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); font-weight: 600; }

    .head-bar { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
    .head-bar h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
    .goal { color: var(--muted); font-size: 13px; margin: 2px 0 0; }

    .hero {
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 3.5px solid var(--accent);
      border-radius: 11px;
      padding: 16px 20px;
      margin-bottom: 16px;
    }
    .hero.ok { border-left-color: var(--ok); }
    .hero.warn { border-left-color: var(--warn); }
    .hero.err { border-left-color: var(--err); }
    .hero-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .hero-title { font-size: 16px; font-weight: 700; margin: 0; }
    .bullets { margin: 11px 0 0; padding: 0; list-style: none; }
    .bullets li { position: relative; padding-left: 15px; margin: 5px 0; color: var(--text-2); }
    .bullets li::before { content: "•"; position: absolute; left: 2px; color: var(--muted); font-weight: 700; }

    .meta-strip {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
      margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);
      font-size: 12.5px; color: var(--text-2);
    }
    .meta-label { color: var(--muted); font-weight: 600; margin-right: 4px; }
    .alert-bar {
      margin-top: 10px; padding: 7px 11px; border-radius: 7px;
      background: var(--warn-bg); color: var(--warn); font-size: 12.5px; font-weight: 500;
    }
    .alert-bar.err { background: var(--err-bg); color: var(--err); }

    .sub-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .sub-chip {
      display: inline-flex; align-items: center; gap: 7px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 6px 11px; font-size: 12.5px; cursor: pointer;
    }
    .sub-chip:hover, .sub-chip.active { border-color: var(--accent); background: var(--accent-bg); }

    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 11px; padding: 14px 18px; }
    .tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 12px; }
    .tab {
      border: none; background: transparent; color: var(--muted);
      padding: 5px 11px; border-radius: 7px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .tab.active { background: var(--subtle); color: var(--text); }

    .tl { position: relative; padding-left: 18px; }
    .tl::before { content: ""; position: absolute; left: 5px; top: 8px; bottom: 8px; width: 1.5px; background: var(--border); }
    .tl-item { position: relative; padding-bottom: 16px; }
    .tl-item:last-child { padding-bottom: 2px; }
    .tl-dot {
      position: absolute; left: -17px; top: 6px;
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--accent); border: 2px solid var(--surface);
    }
    .tl-dot.ok { background: var(--ok); }
    .tl-dot.warn { background: var(--warn); }
    .tl-dot.err { background: var(--err); }
    .tl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .tl-title { font-weight: 600; font-size: 13.5px; }
    .tl-sub { font-size: 12px; color: var(--muted); }
    .tl-bullets { margin: 5px 0 0; padding-left: 15px; color: var(--text-2); font-size: 13px; }
    .tl-bullets li { margin: 2px 0; }
    .tl-tags { margin-top: 5px; display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }

    .row {
      display: flex; align-items: baseline; gap: 9px;
      padding: 7px 2px; border-bottom: 1px solid var(--border); font-size: 12.5px;
    }
    .row:last-child { border-bottom: none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, Menlo, monospace; font-size: 12px; }
    .code-tag {
      background: var(--subtle); border-radius: 5px; padding: 1px 6px;
      font-family: ui-monospace, SFMono-Regular, Consolas, Menlo, monospace; font-size: 11.5px;
    }
    .empty { padding: 32px 12px; text-align: center; color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="dot-live"></span>
      <span>runmemo</span>
      <span class="pill" id="top-stats">等待数据</span>
    </div>
    <div class="controls">
      <span id="updated-at">-</span>
      <button class="btn on" id="btn-auto">自动刷新 3s</button>
      <button class="btn" id="btn-now">刷新</button>
      <button class="btn" id="btn-theme">明暗</button>
    </div>
  </header>

  <div class="shell">
    <aside class="sidebar">
      <div class="side-label"><span>最近会话</span><span id="sess-count">0</span></div>
      <div id="sess-list"></div>
    </aside>
    <main class="main" id="main">
      <div class="empty">还没有捕获到会话。安装插件/钩子后正常使用 Claude Code、Codex 或 OpenCode，或运行 <code>runmemo demo</code> 查看效果。</div>
    </main>
  </div>

  <script>
    const S = {
      index: null,
      lastIndexGen: 0,
      sid: null,
      tab: "briefs",
      agent: "all",
      auto: true,
      timer: null,
      viewVersions: {}, // sessionId -> "updatedAt:briefCount"
      lastRenderedMainKey: "",
    };

    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = localStorage.getItem("runmemo-theme") || (prefersDark ? "dark" : "light");

    document.getElementById("btn-theme").onclick = () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("runmemo-theme", next);
    };
    document.getElementById("btn-auto").onclick = (e) => {
      S.auto = !S.auto;
      e.target.classList.toggle("on", S.auto);
      e.target.textContent = S.auto ? "自动刷新 3s" : "已暂停";
      if (S.auto) startPoll(); else clearInterval(S.timer);
    };
    document.getElementById("btn-now").onclick = () => {
      S.lastIndexGen = 0;
      loadIndex();
    };
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && S.auto) loadIndex();
    });

    const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const fmtT = (ts) => ts ? new Date(ts).toTimeString().slice(0, 8) : "-";
    const fmtD = (sec) => { sec = Number(sec || 0); return sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m" + (sec % 60 ? (sec % 60) + "s" : ""); };
    const trigName = (t) => ({ Stop: "本轮完成", SubagentStop: "子任务完成", TaskCompleted: "里程碑", PostToolUse: "阶段更新" }[t] || t || "阶段更新");
    const srcLabel = (s) => ({ cc: "CC", codex: "Codex", opencode: "OpenCode" }[s] || s || "CC");

    function loadScript(id, src, onload, onerror) {
      const old = document.getElementById(id);
      if (old) old.remove();
      const el = document.createElement("script");
      el.id = id;
      el.src = src;
      el.onload = onload;
      if (onerror) el.onerror = onerror;
      document.body.appendChild(el);
    }

    function loadIndex() {
      loadScript("runmemo-index-script", "./data.js?t=" + Date.now(), () => {
        const idx = window.__RUNMEMO_INDEX__;
        if (!idx) return;
        // 脏检查：索引未变时跳过全部渲染，空闲 CPU 为 0
        if (idx.generatedAt === S.lastIndexGen) return;
        S.lastIndexGen = idx.generatedAt;
        S.index = idx;
        renderSidebar();
        ensureSelectedViewLoaded();
      });
    }

    function ensureSelectedViewLoaded(forceRender = false) {
      const list = S.index?.sessions || [];
      if (!list.length) return;
      const meta = list.find((x) => x.sessionId === S.sid) || list[0];
      S.sid = meta.sessionId;
      const ver = meta.updatedAt + ":" + meta.briefCount;
      const cached = window.__RUNMEMO_VIEWS__ && window.__RUNMEMO_VIEWS__[meta.sessionId];

      if (cached && S.viewVersions[meta.sessionId] === ver) {
        if (forceRender) renderMain(cached);
        return;
      }
      loadScript(
        "runmemo-view-script",
        "./views/" + meta.safeId + ".js?t=" + meta.updatedAt + "_" + meta.briefCount,
        () => {
          const snap = window.__RUNMEMO_VIEWS__ && window.__RUNMEMO_VIEWS__[meta.sessionId];
          if (snap) {
            S.viewVersions[meta.sessionId] = ver;
            renderMain(snap);
          }
        },
        () => {
          // 瞬时写入冲突导致视图脚本加载失败时复位生成时间戳，下一轮 3s 自动重试
          S.lastIndexGen = 0;
        }
      );
    }

    function startPoll() {
      clearInterval(S.timer);
      S.timer = setInterval(() => {
        // 标签页在后台时自动暂停轮询，切回立刻刷新
        if (S.auto && !document.hidden) loadIndex();
      }, 3000);
    }

    function renderSidebar() {
      const d = S.index;
      if (!d) return;
      const list = d.sessions || [];
      document.getElementById("updated-at").textContent = "更新 " + fmtT(d.generatedAt);
      document.getElementById("sess-count").textContent = list.length;

      const running = list.filter((x) => x.status === "running").length;
      const muts = list.reduce((a, x) => a + (x.mutate || 0), 0);
      document.getElementById("top-stats").textContent = (running ? "运行中 " + running + " · " : "") + list.length + " 会话 · " + muts + " 变更";

      if (!list.length) {
        document.getElementById("sess-list").innerHTML = '<div class="empty">暂无记录</div>';
        return;
      }
      if (!S.sid || !list.some((x) => x.sessionId === S.sid)) S.sid = list[0].sessionId;

      const listEl = document.getElementById("sess-list");
      listEl.innerHTML = list.map((s) => {
        const active = s.sessionId === S.sid ? "active" : "";
        const title = s.latestTitle || s.latestPrompt || "等待简报…";
        return (
          '<div class="sess ' + active + '" data-sid="' + esc(s.sessionId) + '">' +
            '<div class="sess-top">' +
              '<span class="sess-proj">' + esc(s.projectName || s.sessionId.slice(0, 12)) + "</span>" +
              '<span style="display:flex;gap:4px;align-items:center;">' +
                '<span class="pill src">' + esc(srcLabel(s.agentSource)) + "</span>" +
                '<span class="pill ' + esc(s.tier) + '">' + esc(s.tier) + "</span>" +
              "</span>" +
            "</div>" +
            '<div class="sess-title">' + esc(title) + "</div>" +
            '<div class="sess-foot">' +
              "<span>" + (s.status === "running" ? "● 运行中" : "已结束") + (s.subagentsTotal ? " · " + s.subagentsTotal + " 子任务" : "") + "</span>" +
              "<span>" + fmtD(s.durationSec) + "</span>" +
            "</div>" +
          "</div>"
        );
      }).join("");
      listEl.querySelectorAll(".sess").forEach((el) => {
        el.onclick = () => {
          S.sid = el.dataset.sid;
          S.agent = "all";
          S.lastRenderedMainKey = "";
          renderSidebar();
          ensureSelectedViewLoaded(true);
        };
      });
    }

    function renderMain(cur) {
      if (!cur) return;
      const renderKey = [cur.sessionId, cur.updatedAt, cur.briefs?.length || 0, S.tab, S.agent].join("|");
      if (renderKey === S.lastRenderedMainKey) return;
      S.lastRenderedMainKey = renderKey;

      const latest = cur.latestBrief;
      let heroHtml = "";
      if (latest) {
        const bullets = (latest.bullets || []).map((b) => "<li>" + esc(b) + "</li>").join("");
        const metaParts = [];
        if (latest.check) metaParts.push('<span><span class="meta-label">验证</span>' + esc(latest.check) + "</span>");
        if (latest.files?.length) {
          metaParts.push('<span><span class="meta-label">改动</span>' + latest.files.map((f) => '<span class="code-tag">' + esc(f) + "</span>").join(" ") + "</span>");
        }
        heroHtml =
          '<section class="hero ' + esc(latest.status || "ok") + '">' +
            '<div class="hero-top">' +
              '<h2 class="hero-title">' + esc(latest.title) + "</h2>" +
              '<span class="pill">' + esc(trigName(latest.trigger)) + " · " + fmtT(latest.ts) + "</span>" +
            "</div>" +
            (bullets ? '<ul class="bullets">' + bullets + "</ul>" : "") +
            (metaParts.length ? '<div class="meta-strip">' + metaParts.join("") + "</div>" : "") +
            (latest.alert ? '<div class="alert-bar ' + (latest.status === "err" ? "err" : "") + '">⚠️ ' + esc(latest.alert) + "</div>" : "") +
          "</section>";
      } else {
        heroHtml =
          '<section class="hero">' +
            '<div class="hero-top"><h2 class="hero-title">' + (cur.tier === "L0" ? "轻量问答（已静默跳过概括）" : "等待阶段简报…") + "</h2></div>" +
          "</section>";
      }

      const subHtml = cur.subagents?.length
        ? '<div class="sub-strip">' +
            '<div class="sub-chip ' + (S.agent === "all" ? "active" : "") + '" data-agent="all">全部 (' + cur.subagents.length + " 子任务)</div>" +
            cur.subagents.map((sa) => (
              '<div class="sub-chip ' + (S.agent === sa.agentId ? "active" : "") + '" data-agent="' + esc(sa.agentId) + '">' +
                "<span>" + (sa.status === "done" ? "✅" : "🔄") + "</span>" +
                "<strong>" + esc(sa.agentType) + "</strong>" +
                '<span class="tl-sub">' + fmtD(sa.durationSec) + (sa.errorCount ? " · 错" + sa.errorCount : "") + "</span>" +
              "</div>"
            )).join("") +
          "</div>"
        : "";

      let bodyHtml = "";
      if (S.tab === "briefs") {
        const items = [...(cur.briefs || [])].reverse();
        bodyHtml = items.length
          ? '<div class="tl">' + items.map((b) => {
              const tags = [];
              if (b.check) tags.push("验证: " + b.check);
              if (b.files?.length) tags.push("改动: " + b.files.join(", "));
              if (b.alert) tags.push("⚠️ " + b.alert);
              return (
                '<div class="tl-item">' +
                  '<span class="tl-dot ' + esc(b.status || "ok") + '"></span>' +
                  '<div class="tl-head">' +
                    '<span class="tl-title">' + esc(b.title) + "</span>" +
                    '<span class="tl-sub">' + esc(trigName(b.trigger)) + " · " + fmtT(b.ts) + "</span>" +
                  "</div>" +
                  ((b.bullets || []).length ? '<ul class="tl-bullets">' + b.bullets.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") +
                  (tags.length ? '<div class="tl-tags">' + tags.map((t) => "<span>" + esc(t) + "</span>").join("<span>·</span>") + "</div>" : "") +
                "</div>"
              );
            }).join("") + "</div>"
          : '<div class="empty">暂无历史阶段简报</div>';
      } else if (S.tab === "ledger") {
        const rows = [...(cur.ledger || [])].reverse().filter((r) => S.agent === "all" || r.agentId === S.agent);
        bodyHtml = rows.length
          ? rows.map((r) => (
              '<div class="row">' +
                '<span class="mono tl-sub" style="width:62px;flex-shrink:0;">' + fmtT(r.ts) + "</span>" +
                '<span class="pill ' + esc(r.kind) + '" style="flex-shrink:0;">' + esc(r.kind) + "</span>" +
                (r.risk === "high" ? '<span class="pill high" style="flex-shrink:0;">高影响</span>' : "") +
                '<span class="mono" style="flex:1;word-break:break-all;"><strong>' + esc(r.title) + "</strong> " + esc(r.target) + (r.snippet ? ' <span class="tl-sub">— ' + esc(r.snippet) + "</span>" : "") + "</span>" +
              "</div>"
            )).join("")
          : '<div class="empty">暂无变更或验证记录</div>';
      } else {
        const rows = [...(cur.timeline || [])].reverse().filter((r) => S.agent === "all" || r.agentId === S.agent);
        bodyHtml = rows.length
          ? rows.map((r) => (
              '<div class="row">' +
                '<span class="mono tl-sub" style="width:62px;flex-shrink:0;">' + fmtT(r.ts) + "</span>" +
                '<span class="pill ' + esc(r.ok ? r.opClass || "" : "ERROR") + '" style="flex-shrink:0;">' + esc(r.toolName || r.eventType) + "</span>" +
                '<span class="mono" style="flex:1;word-break:break-all;">' + esc(r.target || "-") + "</span>" +
              "</div>"
            )).join("")
          : '<div class="empty">暂无时间线</div>';
      }

      const mainEl = document.getElementById("main");
      mainEl.innerHTML =
        '<div class="head-bar">' +
          "<div>" +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
              "<h1>" + esc(cur.projectName || cur.sessionId) + "</h1>" +
              '<span class="pill src">' + esc(srcLabel(cur.agentSource)) + "</span>" +
              '<span class="pill ' + esc(cur.tier) + '">' + esc(cur.tier) + "</span>" +
              '<span class="pill ' + esc(cur.status) + '">' + (cur.status === "running" ? "运行中" : "已结束") + "</span>" +
            "</div>" +
            (cur.latestPrompt ? '<p class="goal">' + esc(cur.latestPrompt) + "</p>" : "") +
          "</div>" +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<span class="pill">' + fmtD(cur.durationSec) + "</span>" +
            '<span class="pill MUTATE">变更 ' + (cur.counts?.mutate || 0) + "</span>" +
            '<span class="pill VERIFY">验证 ' + (cur.counts?.verify || 0) + "</span>" +
            ((cur.counts?.errors || 0) > 0 ? '<span class="pill ERROR">报错 ' + cur.counts.errors + "</span>" : "") +
          "</div>" +
        "</div>" +
        heroHtml +
        subHtml +
        '<section class="panel">' +
          '<div class="tabs">' +
            '<button class="tab ' + (S.tab === "briefs" ? "active" : "") + '" data-tab="briefs">阶段简报 (' + (cur.briefs?.length || 0) + ")</button>" +
            '<button class="tab ' + (S.tab === "ledger" ? "active" : "") + '" data-tab="ledger">变更台账 (' + (cur.ledger?.length || 0) + ")</button>" +
            '<button class="tab ' + (S.tab === "timeline" ? "active" : "") + '" data-tab="timeline">全部动作 (' + (cur.timeline?.length || 0) + ")</button>" +
          "</div>" +
          bodyHtml +
        "</section>";

      mainEl.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => { S.tab = b.dataset.tab; renderMain(cur); }; });
      mainEl.querySelectorAll("[data-agent]").forEach((b) => { b.onclick = () => { S.agent = b.dataset.agent; renderMain(cur); }; });
    }

    loadIndex();
    startPoll();
  </script>
</body>
</html>
`;
}

function tryAcquireIndexLock(lockFile, staleMs = 5_000) {
  for (let i = 0; i <= 6; i++) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, String(process.pid), "utf8");
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") {
        ensureDir(path.dirname(lockFile));
        continue;
      }
      if (err.code !== "EEXIST") return false;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        // ignore
      }
      if (i < 6) sleepSync(20);
    }
  }
  return false;
}

function releaseIndexLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // ignore
  }
}

export function updateHtmlSink(cfg = loadConfig(), updatedSession = null) {
  const { htmlDir, htmlViewsDir, sessionsIndexFile, indexLockFile, dashboardHtml, dashboardDataJs } =
    getRuntimePaths(cfg);
  ensureDir(htmlViewsDir);

  if (updatedSession && updatedSession.sessionId) {
    writeSessionViewJs(htmlViewsDir, updatedSession);
  }

  const gotLock = tryAcquireIndexLock(indexLockFile);
  try {
    let indexList = readJsonSafe(sessionsIndexFile, null);
    if (!Array.isArray(indexList)) {
      indexList = bootstrapIndexFromDisk(cfg);
    }

    if (updatedSession && updatedSession.sessionId) {
      const entry = toIndexEntry(updatedSession);
      const idx = indexList.findIndex((x) => x.sessionId === entry.sessionId);
      if (idx >= 0) indexList[idx] = entry;
      else indexList.push(entry);
      indexList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (indexList.length > (cfg.maxSessions || 30)) {
        indexList = indexList.slice(0, cfg.maxSessions || 30);
      }
    } else {
      indexList = bootstrapIndexFromDisk(cfg);
    }

    atomicWriteFile(sessionsIndexFile, JSON.stringify(indexList));

    const indexPayload = {
      generatedAt: Date.now(),
      sessions: indexList,
    };
    atomicWriteFile(dashboardDataJs, `window.__RUNMEMO_INDEX__=${JSON.stringify(indexPayload)};\n`);
  } finally {
    if (gotLock) releaseIndexLock(indexLockFile);
  }

  let needWrite = !fs.existsSync(dashboardHtml);
  if (!needWrite) {
    try {
      if (!fs.readFileSync(dashboardHtml, "utf8").includes(`content="${TEMPLATE_VERSION}"`)) {
        needWrite = true;
      }
    } catch {
      needWrite = true;
    }
  }
  if (needWrite) {
    atomicWriteFile(dashboardHtml, buildHtmlTemplate());
  }
  return dashboardHtml;
}
