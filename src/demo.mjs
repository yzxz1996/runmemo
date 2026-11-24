import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSessionPaths, loadConfig, PACKAGE_ROOT } from "./config.mjs";
import { readJsonSafe } from "./core.mjs";
import { RunmemoPlugin } from "./plugin-opencode.mjs";
import { buildFeishuCardPayload, sendFeishuBrief } from "./sinks/feishu.mjs";
import { updateHtmlSink } from "./sinks/html.mjs";

export async function runDemo({ sendFeishu = false } = {}) {
  const cfg = loadConfig();
  const demoHome = path.join(PACKAGE_ROOT, "demo-output");
  fs.rmSync(demoHome, { recursive: true, force: true });

  const env = {
    ...process.env,
    RUNMEMO_HOME: demoHome,
    RUNMEMO_OUTPUTS: "html,feishu",
    RUNMEMO_MOCK_LLM: "1",
    RUNMEMO_DISABLE_FEISHU: "1",
    RUNMEMO_SKIP_SPAWN: "1", // 演示由 runSum 同步确定性驱动，不拉起冗余后台进程
  };

  const ccHook = path.join(PACKAGE_ROOT, "src", "hook-cc.mjs");
  const codexHook = path.join(PACKAGE_ROOT, "src", "hook-codex.mjs");
  const sumScript = path.join(PACKAGE_ROOT, "src", "summarizer.mjs");

  const sendHook = (script, payload) => {
    const res = spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env,
    });
    if (res.status !== 0) {
      throw new Error(`${path.basename(script)} 退出异常 (${res.status}): ${res.stderr}`);
    }
  };

  const runSum = (sessionId, trigger) => {
    const res = spawnSync(
      process.execPath,
      [sumScript, "--session", sessionId, "--trigger", trigger, "--mock-llm", "--no-feishu"],
      { encoding: "utf8", env }
    );
    if (res.status !== 0) {
      throw new Error(`summarizer 退出异常 (${res.status}): ${res.stderr}`);
    }
  };

  // 会话 1 (CC)：L0 日常问答（应静默跳过概括）
  const chatId = "demo-chat-l0";
  sendHook(ccHook, { hook_event_name: "SessionStart", session_id: chatId, cwd: "/workspace/order-svc" });
  sendHook(ccHook, {
    hook_event_name: "UserPromptSubmit",
    session_id: chatId,
    cwd: "/workspace/order-svc",
    prompt: "HTTP 429 和 Retry-After 怎么配合使用？",
  });
  sendHook(ccHook, { hook_event_name: "Stop", session_id: chatId, cwd: "/workspace/order-svc" });
  runSum(chatId, "Stop");

  // 会话 2 (CC)：L3 多子 Agent（改代码 + Staging 部署 + Playwright E2E 先败后过）
  const relId = "demo-order-release";
  const cwd = "/workspace/order-svc";
  sendHook(ccHook, { hook_event_name: "SessionStart", session_id: relId, cwd });
  sendHook(ccHook, {
    hook_event_name: "UserPromptSubmit",
    session_id: relId,
    cwd,
    prompt: "修复订单超时取消锁并发布 Staging，跑通结账 E2E 回归",
  });
  sendHook(ccHook, {
    hook_event_name: "PostToolUse",
    session_id: relId,
    cwd,
    tool_name: "Read",
    tool_input: { file_path: `${cwd}/src/order/timeout.ts` },
    tool_response: { stdout: "ok" },
  });
  sendHook(ccHook, {
    hook_event_name: "SubagentStart",
    session_id: relId,
    cwd,
    agent_id: "sub-backend",
    agent_type: "backend-coder",
    description: "修复幂等锁并补单测",
  });
  sendHook(ccHook, {
    hook_event_name: "PostToolUse",
    session_id: relId,
    cwd,
    agent_id: "sub-backend",
    tool_name: "Edit",
    tool_input: { file_path: `${cwd}/src/order/timeout.ts` },
    tool_response: { stdout: "updated 18 lines" },
  });
  sendHook(ccHook, {
    hook_event_name: "PostToolUse",
    session_id: relId,
    cwd,
    agent_id: "sub-backend",
    tool_name: "Bash",
    tool_input: { command: "npm test -- order-timeout" },
    tool_response: { exitCode: 0, stdout: "18/18 passed" },
  });
  sendHook(ccHook, {
    hook_event_name: "SubagentStop",
    session_id: relId,
    cwd,
    agent_id: "sub-backend",
    agent_type: "backend-coder",
    last_assistant_message: "修复 timeout.ts 幂等锁边界，补 4 条单测全过",
  });
  runSum(relId, "SubagentStop");

  sendHook(ccHook, {
    hook_event_name: "SubagentStart",
    session_id: relId,
    cwd,
    agent_id: "sub-deploy",
    agent_type: "staging-deployer",
    description: "升级 Staging Helm 并检查健康探针",
  });
  sendHook(ccHook, {
    hook_event_name: "PostToolUse",
    session_id: relId,
    cwd,
    agent_id: "sub-deploy",
    tool_name: "Bash",
    tool_input: { command: "helm upgrade order-svc ./charts/order-svc -n staging --wait" },
    tool_response: { exitCode: 0, stdout: "Revision 42 deployed" },
  });
  sendHook(ccHook, {
    hook_event_name: "PostToolUse",
    session_id: relId,
    cwd,
    agent_id: "sub-deploy",
    tool_name: "Bash",
    tool_input: { command: "curl -sf https://staging.internal/orders/health" },
    tool_response: { exitCode: 0, stdout: "200 OK" },
  });
  sendHook(ccHook, {
    hook_event_name: "SubagentStop",
    session_id: relId,
    cwd,
    agent_id: "sub-deploy",
    agent_type: "staging-deployer",
    last_assistant_message: "发布 Staging Helm Rev.42，健康探针 200 OK",
  });
  runSum(relId, "SubagentStop");

  sendHook(ccHook, {
    hook_event_name: "SubagentStart",
    session_id: relId,
    cwd,
    agent_id: "sub-e2e",
    agent_type: "e2e-runner",
    description: "跑结账 E2E",
  });
  sendHook(ccHook, {
    hook_event_name: "PostToolUseFailure",
    session_id: relId,
    cwd,
    agent_id: "sub-e2e",
    tool_name: "Bash",
    tool_input: { command: "npx playwright test tests/e2e/checkout.spec.ts" },
    error: "checkout-cancel banner timeout (retry 1)",
  });
  sendHook(ccHook, {
    hook_event_name: "PostToolUse",
    session_id: relId,
    cwd,
    agent_id: "sub-e2e",
    tool_name: "Bash",
    tool_input: { command: "npx playwright test tests/e2e/checkout.spec.ts --trace on" },
    tool_response: { exitCode: 0, stdout: "12/12 passed" },
  });
  sendHook(ccHook, {
    hook_event_name: "SubagentStop",
    session_id: relId,
    cwd,
    agent_id: "sub-e2e",
    agent_type: "e2e-runner",
    last_assistant_message: "结账 E2E 重跑 12/12 通过，已落盘 Trace",
  });
  sendHook(ccHook, { hook_event_name: "Stop", session_id: relId, cwd });
  runSum(relId, "Stop");

  // 会话 3 (Codex)：apply_patch 修改文件 + pytest 验证
  const codexId = "demo-codex-patch";
  const codexCwd = "/workspace/auth-gateway";
  sendHook(codexHook, { hook_event_name: "SessionStart", session_id: codexId, cwd: codexCwd });
  sendHook(codexHook, {
    hook_event_name: "UserPromptSubmit",
    session_id: codexId,
    cwd: codexCwd,
    prompt: "修复 JWT 时钟偏移容错并跑通鉴权测试",
  });
  sendHook(codexHook, {
    hook_event_name: "PostToolUse",
    session_id: codexId,
    cwd: codexCwd,
    tool_name: "apply_patch",
    tool_input: {
      input: [
        "*** Begin Patch",
        "*** Update File: src/auth/jwt.ts",
        "@@",
        "- const leeway = 0;",
        "+ const leeway = 30;",
        "*** End Patch",
      ].join("\n"),
    },
    tool_response: { output: "Success. Updated 1 file." },
  });
  sendHook(codexHook, {
    hook_event_name: "PostToolUse",
    session_id: codexId,
    cwd: codexCwd,
    tool_name: "shell",
    tool_input: { command: "pytest tests/test_jwt.py -q" },
    tool_response: { exitCode: 0, stdout: "24 passed in 1.4s" },
  });
  sendHook(codexHook, {
    hook_event_name: "Stop",
    session_id: codexId,
    cwd: codexCwd,
    last_assistant_message: "已更新 jwt.ts leeway=30s，pytest 24/24 全过",
  });
  runSum(codexId, "Stop");

  // 会话 4 (OpenCode)：进程内直接驱动 RunmemoPlugin（含 parentID 子任务与 Playwright）
  const opencodeId = "demo-opencode-e2e";
  const ocChildId = "demo-opencode-child-qa";
  const ocCwd = "/workspace/web-pilot";

  const prevHome = process.env.RUNMEMO_HOME;
  const prevOutputs = process.env.RUNMEMO_OUTPUTS;
  const prevMock = process.env.RUNMEMO_MOCK_LLM;
  const prevDisableFeishu = process.env.RUNMEMO_DISABLE_FEISHU;
  const prevSkipSpawn = process.env.RUNMEMO_SKIP_SPAWN;

  process.env.RUNMEMO_HOME = demoHome;
  process.env.RUNMEMO_OUTPUTS = "html,feishu";
  process.env.RUNMEMO_MOCK_LLM = "1";
  process.env.RUNMEMO_DISABLE_FEISHU = "1";
  process.env.RUNMEMO_SKIP_SPAWN = "1";

  let dashboardHtml = "";
  let chatSnap = null;
  let relSnap = null;
  let codexSnap = null;
  let opencodeSnap = null;
  let feishuPreviewPath = "";

  try {
    const hooks = await RunmemoPlugin({ directory: ocCwd, worktree: ocCwd });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: opencodeId, title: "web-pilot login fix" } } } });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_u1", sessionID: opencodeId, role: "user", summary: { title: "修复登录重定向并跑通 Playwright 冒烟" } } },
      },
    });
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: opencodeId, callID: "call_oc_1" }, { args: { filePath: `${ocCwd}/src/login.ts` } });
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: opencodeId, callID: "call_oc_1" }, { title: "edit src/login.ts", output: "ok" });

    // 子任务通过 parentID 挂接到父会话
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: ocChildId, parentID: opencodeId, title: "playwright-qa" } } },
    });
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: ocChildId, callID: "call_oc_2" },
      { args: { command: "npx playwright test tests/login.spec.ts" } }
    );
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: ocChildId, callID: "call_oc_2" },
      { title: "playwright login.spec.ts", output: "8 passed (6.2s)" }
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: ocChildId } } });
    runSum(opencodeId, "SubagentStop");

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: opencodeId } } });
    runSum(opencodeId, "Stop");

    const demoCfg = loadConfig();
    dashboardHtml = updateHtmlSink(demoCfg);
    chatSnap = readJsonSafe(getSessionPaths(chatId, demoCfg).snapshotFile);
    relSnap = readJsonSafe(getSessionPaths(relId, demoCfg).snapshotFile);
    codexSnap = readJsonSafe(getSessionPaths(codexId, demoCfg).snapshotFile);
    opencodeSnap = readJsonSafe(getSessionPaths(opencodeId, demoCfg).snapshotFile);
    feishuPreviewPath = getSessionPaths(relId, demoCfg).feishuPreviewFile;
  } finally {
    const restore = (k, v) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("RUNMEMO_HOME", prevHome);
    restore("RUNMEMO_OUTPUTS", prevOutputs);
    restore("RUNMEMO_MOCK_LLM", prevMock);
    restore("RUNMEMO_DISABLE_FEISHU", prevDisableFeishu);
    restore("RUNMEMO_SKIP_SPAWN", prevSkipSpawn);
  }

  let feishuSendResult = null;
  if (sendFeishu && relSnap?.latestBrief) {
    feishuSendResult = await sendFeishuBrief(relSnap, relSnap.latestBrief, cfg);
  }

  return {
    dashboardHtml,
    feishuPreviewPath,
    feishuCardSample: relSnap?.latestBrief ? buildFeishuCardPayload(relSnap, relSnap.latestBrief, "") : null,
    feishuSendResult,
    chatSnap,
    relSnap,
    codexSnap,
    opencodeSnap,
  };
}
