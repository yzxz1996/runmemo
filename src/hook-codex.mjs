#!/usr/bin/env node
/**
 * runmemo · OpenAI Codex CLI 纯旁观 Hook 入口（零导入早退）
 */
if (process.env.RUNMEMO_INTERNAL === "1") {
  process.exit(0);
}

const { runStdioHook } = await import("./hook-stdio.mjs");
runStdioHook("codex").catch(() => {}).finally(() => process.exit(0));
