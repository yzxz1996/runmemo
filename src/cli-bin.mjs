import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteFile, getRuntimePaths } from "./config.mjs";
import { readJsonSafe, truncate } from "./core.mjs";

export function quoteWindowsCmdArg(arg) {
  const s = String(arg ?? "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (!/[\s,;=&|<>()%!^"]/.test(s)) return s;
  const escaped = s
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export function isExecutableFile(filePath, platform = process.platform) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform !== "win32") {
      return (stat.mode & 0o111) !== 0;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveCliBin(binName, cfg = null, opts = {}) {
  const targetPlatform = opts.platform || process.platform;
  if (!binName || typeof binName !== "string") {
    return { bin: "", found: false, needsShell: targetPlatform === "win32" };
  }

  if (path.isAbsolute(binName)) {
    if (isExecutableFile(binName, targetPlatform)) {
      return { bin: binName, found: true, needsShell: targetPlatform === "win32" && /\.(cmd|bat)$/i.test(binName) };
    }
    return { bin: binName, found: false, needsShell: targetPlatform === "win32" };
  }

  const useCache = Boolean(cfg && !opts.ignoreCache);
  let cachePath = "";
  let cacheMap = {};
  if (useCache) {
    cachePath = getRuntimePaths(cfg).binCacheFile;
    const rawCache = readJsonSafe(cachePath, null);
    if (rawCache && typeof rawCache === "object" && !rawCache.name) {
      cacheMap = rawCache;
    } else if (rawCache?.name && rawCache?.bin) {
      cacheMap = { [rawCache.name]: { bin: rawCache.bin, needsShell: Boolean(rawCache.needsShell) } };
    }
    const hit = cacheMap[binName];
    if (hit && hit.bin && isExecutableFile(hit.bin, targetPlatform)) {
      return { bin: hit.bin, found: true, needsShell: Boolean(hit.needsShell) };
    }
  }

  const delimiter = targetPlatform === process.platform ? path.delimiter : targetPlatform === "win32" ? ";" : ":";
  const rawPath = opts.pathEnv !== undefined ? opts.pathEnv : process.env.PATH || "";
  const pathEntries = rawPath
    .split(delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const exts = targetPlatform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  const lowerBin = binName.toLowerCase();

  for (const dir of pathEntries) {
    for (const ext of exts) {
      const fileName = ext && !lowerBin.endsWith(ext) ? binName + ext : binName;
      const candidate = path.join(dir, fileName);
      if (isExecutableFile(candidate, targetPlatform)) {
        const res = { bin: candidate, found: true, needsShell: targetPlatform === "win32" && ext !== ".exe" };
        if (cachePath) {
          try {
            cacheMap[binName] = { bin: res.bin, needsShell: res.needsShell };
            atomicWriteFile(cachePath, JSON.stringify(cacheMap));
          } catch {
            // ignore
          }
        }
        return res;
      }
    }
  }
  return { bin: binName, found: false, needsShell: targetPlatform === "win32" };
}

export const resolveClaudeBin = resolveCliBin;

export function spawnCliWithStdin({ bin, args, needsShell, prompt, cwd, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const useWinCmd = process.platform === "win32" && needsShell;
    const spawnCmd = useWinCmd ? process.env.ComSpec || "cmd.exe" : bin;
    const spawnArgs = useWinCmd
      ? ["/d", "/s", "/c", `"${[quoteWindowsCmdArg(bin), ...args.map(quoteWindowsCmdArg)].join(" ")}"`]
      : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      shell: false,
      windowsVerbatimArguments: useWinCmd,
      windowsHide: true,
      env: { ...process.env, RUNMEMO_INTERNAL: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`${label} 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${label} 退出 ${code}: ${truncate(stderr || stdout, 120)}`));
    });

    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  });
}
