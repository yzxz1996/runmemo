import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { quoteWindowsCmdArg, spawnCliWithStdin } from "../src/cli-bin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("quoteWindowsCmdArg safely quotes commas, spaces, empty strings, and embedded quotes", () => {
  assert.equal(quoteWindowsCmdArg("plain"), "plain");
  assert.equal(quoteWindowsCmdArg(""), '""');
  assert.equal(quoteWindowsCmdArg("Bash,Edit,Write"), '"Bash,Edit,Write"');
  assert.equal(quoteWindowsCmdArg("C:\\tmp dir\\out file.txt"), '"C:\\tmp dir\\out file.txt"');
  assert.equal(quoteWindowsCmdArg('say "hi"'), '"say \\"hi\\""');
});

test(
  "spawnCliWithStdin preserves commas, spaces, stdin, RUNMEMO_INTERNAL=1 and emits zero DEP0190 on Windows .cmd",
  { skip: process.platform !== "win32" },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo cmd space "));
    try {
      const echoScript = path.join(tmp, "echo.mjs");
      const shimCmd = path.join(tmp, "fake cli.cmd");
      fs.writeFileSync(
        echoScript,
        [
          'import fs from "node:fs";',
          'const stdin = fs.readFileSync(0, "utf8");',
          'console.log(JSON.stringify({ argv: process.argv.slice(2), internal: process.env.RUNMEMO_INTERNAL, stdin }));',
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        shimCmd,
        `@echo off\r\n"${process.execPath}" "${echoScript}" %*\r\n`,
        "utf8"
      );

      const args = ["--disallowedTools", "Bash,Edit,Write,Read", "--output", "C:\\temp dir\\out file.txt"];
      const prompt = "中文提示词：测试 stdin 透传与逗号参数完整性";
      const res = await spawnCliWithStdin({
        bin: shimCmd,
        args,
        needsShell: true,
        prompt,
        cwd: tmp,
        timeoutMs: 10_000,
        label: "fake-cmd",
      });

      const parsed = JSON.parse(res.stdout);
      assert.deepEqual(parsed.argv, args);
      assert.equal(parsed.internal, "1");
      assert.equal(parsed.stdin, prompt);
      assert.ok(!res.stderr.includes("DEP0190"), `unexpected DEP0190 in stderr: ${res.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test("importing summarizer.mjs does not auto-execute main() even with --session in argv", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "runmemo-import-guard-"));
  try {
    const sumUrl = pathToFileURL(path.join(ROOT, "src/summarizer.mjs")).href;
    const code = `await import(${JSON.stringify(sumUrl)}); console.log("IMPORTED_CLEANLY");`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", "--session", "should-not-run"], {
      encoding: "utf8",
      env: { ...process.env, RUNMEMO_HOME: tmpHome },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes("IMPORTED_CLEANLY"));
    assert.equal(fs.existsSync(path.join(tmpHome, "sessions/should-not-run")), false);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
