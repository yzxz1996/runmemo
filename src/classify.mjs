// 超轻量纯函数分类/脱敏模块（零 Node I/O 依赖，兼容 Claude Code / Codex / OpenCode）

export function truncate(str, maxLen = 140) {
  if (str == null) return "";
  const s = String(str).replace(/\s+/g, " ").trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

export function redactSecrets(input) {
  if (input == null) return "";
  return String(input)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "***"
    )
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)([^\s"',;]+)/gi, "$1***");
}

export function shortPath(rawPath, cwd = "") {
  if (!rawPath) return "";
  let p = String(rawPath).replace(/\\/g, "/");
  if (cwd) {
    const normCwd = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
    if (normCwd && p.toLowerCase().startsWith((normCwd + "/").toLowerCase())) {
      p = p.slice(normCwd.length + 1);
    }
  }
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 3 ? parts.join("/") : parts.slice(-3).join("/");
}

const VERIFY_CMD_RE =
  /\b(pytest|vitest|jest|mocha|playwright|cypress|k6|locust|wrk|artillery|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|npm\s+(?:run\s+)?(?:test|e2e|lint|typecheck|check|build)|pnpm\s+(?:test|e2e|lint|build)|yarn\s+(?:test|e2e|lint|build)|tsc\s+--noEmit|eslint|ruff|flake8|mypy|curl\s+.*(?:health|ready|ping|status))\b/i;

const READ_CMD_RE =
  /^\s*(ls|dir|pwd|cat|head|tail|less|more|grep|rg|find|fd|wc|stat|file|which|where|echo|env|printenv|git\s+(?:status|log|diff|branch|show|rev-parse)|kubectl\s+(?:get|describe|logs|top)|helm\s+(?:list|status|history|diff)|terraform\s+(?:plan|show|state\s+list)|docker\s+(?:ps|logs|images|inspect)|ps|top|df|du|Get-ChildItem|Get-Content|Select-String)\b/i;

const HIGH_RISK_RE =
  /\b(kubectl\s+(?:apply|delete|rollout|scale|patch)|helm\s+(?:upgrade|install|uninstall|rollback)|terraform\s+(?:apply|destroy)|docker\s+(?:push|compose\s+up|deploy)|ansible-playbook|flyctl\s+deploy|vercel\s+--prod|rm\s+-rf|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE\s+TABLE|migrate|production|prod\b)\b/i;

export const WRITE_TOOLS_LOWER = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "write_file",
  "edit_file",
  "apply_patch",
  "patch",
  "replace_file_content",
]);

const READ_TOOLS_LOWER = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "list",
  "webfetch",
  "websearch",
  "read_file",
  "view_file",
  "find_by_name",
  "grep_search",
]);

const SHELL_TOOLS_LOWER = new Set(["bash", "shell", "local_shell", "shell_command", "exec_command", "run_command"]);

export function isWriteToolName(toolName) {
  return WRITE_TOOLS_LOWER.has(String(toolName || "").toLowerCase());
}

export function extractPatchFiles(patchText, cwd = "") {
  if (!patchText || typeof patchText !== "string") return [];
  const files = [];
  const re = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(patchText)) !== null) {
    const f = shortPath(m[1].trim(), cwd);
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

function extractCommandString(toolInput) {
  if (!toolInput) return "";
  if (typeof toolInput === "string") return toolInput;
  const cmd = toolInput.command ?? toolInput.cmd ?? toolInput.CommandLine;
  if (Array.isArray(cmd)) return cmd.join(" ");
  return String(cmd || "");
}

export function classifyTool(toolName, toolInput) {
  const lower = String(toolName || "").toLowerCase();
  if (WRITE_TOOLS_LOWER.has(lower)) {
    let target = "";
    if (lower === "apply_patch" || lower === "patch") {
      const raw = typeof toolInput === "string" ? toolInput : toolInput?.input || toolInput?.patch || toolInput?.patchText || "";
      target = extractPatchFiles(raw).join(" ") || String(toolInput?.filePath || toolInput?.file_path || "");
    } else {
      target = String(toolInput?.filePath || toolInput?.file_path || toolInput?.path || toolInput?.notebook_path || "");
    }
    const isHigh = /\.(env|sql|tf|ya?ml)$|migration|deploy|prod|k8s|helm/i.test(target);
    return { opClass: "MUTATE", risk: isHigh ? "high" : "normal" };
  }
  if (READ_TOOLS_LOWER.has(lower)) return { opClass: "READ", risk: "normal" };
  if (SHELL_TOOLS_LOWER.has(lower)) {
    const cmd = extractCommandString(toolInput).trim();
    const risk = HIGH_RISK_RE.test(cmd) ? "high" : "normal";
    if (VERIFY_CMD_RE.test(cmd)) return { opClass: "VERIFY", risk };
    if (READ_CMD_RE.test(cmd) && !/[>|&;].*(?:rm|mv|cp|tee|apply|deploy|curl\s+-X\s+(?:POST|PUT|DELETE|PATCH))/i.test(cmd)) {
      return { opClass: "READ", risk: "normal" };
    }
    return { opClass: "MUTATE", risk };
  }
  if (/^(agent|task|spawn_agent|subagent)$/i.test(lower)) return { opClass: "SUBAGENT", risk: "normal" };
  if (/(get|list|read|search|query|describe|inspect|fetch|view)/i.test(lower)) return { opClass: "READ", risk: "normal" };
  if (/(test|verify|check|assert|playwright|e2e|health|smoke|audit|scan)/i.test(lower)) return { opClass: "VERIFY", risk: "normal" };
  if (/(deploy|apply|delete|drop|migrate|create|update|write|publish|release|push|exec)/i.test(lower)) {
    return { opClass: "MUTATE", risk: /(deploy|delete|drop|migrate|prod|release)/i.test(lower) ? "high" : "normal" };
  }
  return { opClass: "OTHER", risk: "normal" };
}

export function extractTarget(toolName, toolInput, cwd = "") {
  const lower = String(toolName || "").toLowerCase();
  if (lower === "apply_patch" || lower === "patch") {
    const raw = typeof toolInput === "string" ? toolInput : toolInput?.input || toolInput?.patch || toolInput?.patchText || "";
    const files = extractPatchFiles(raw, cwd);
    if (files.length) return files.slice(0, 3).join(", ");
  }
  if (!toolInput || typeof toolInput !== "object") {
    return truncate(redactSecrets(toolInput || ""), 110);
  }
  if (SHELL_TOOLS_LOWER.has(lower)) {
    return truncate(redactSecrets(extractCommandString(toolInput)), 110);
  }
  const fileVal = toolInput.filePath || toolInput.file_path || toolInput.path || toolInput.notebook_path;
  if (fileVal) return shortPath(fileVal, cwd);
  if (toolInput.pattern) {
    return truncate(`${toolInput.pattern}${toolInput.path ? ` (${shortPath(toolInput.path, cwd)})` : ""}`, 90);
  }
  if (toolInput.url) return truncate(redactSecrets(toolInput.url), 90);
  if (toolInput.description || toolInput.prompt) {
    return truncate(redactSecrets(toolInput.description || toolInput.prompt), 90);
  }
  return truncate(redactSecrets(JSON.stringify(toolInput)), 90);
}

export function extractResponseSnippet(payload) {
  if (payload?.error) {
    return { ok: false, snippet: truncate(redactSecrets(payload.error), 140) };
  }
  const resp = payload?.tool_response ?? payload?.output;
  if (resp == null) return { ok: true, snippet: "" };
  if (typeof resp === "string") {
    const failed = /\b(error|failed|exception|traceback|exit code [1-9])\b/i.test(resp);
    return { ok: !failed, snippet: truncate(redactSecrets(resp), 140) };
  }
  if (typeof resp === "object") {
    const exitCode = resp.exitCode ?? resp.exit_code ?? resp.code;
    const isErr = Boolean(resp.is_error || resp.isError || (typeof exitCode === "number" && exitCode !== 0));
    const raw = resp.stderr || resp.error || resp.stdout || resp.output || resp.message || resp.content || "";
    return {
      ok: !isErr,
      snippet: truncate(redactSecrets(typeof raw === "string" ? raw : JSON.stringify(raw)), 140),
    };
  }
  return { ok: true, snippet: "" };
}
