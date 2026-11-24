# Contributing to runmemo

Thanks for your interest in improving **runmemo**!

## Design Principles

1. **Zero-block / purely passive**: Hooks (`hook-cc.mjs`, `hook-codex.mjs`, `plugin-opencode.mjs`) must never block agent execution or fail loudly. Stdio hooks always exit `0`.
2. **Zero external dependencies**: Only Node.js (`>= 18.0.0`) built-in ESM modules are allowed in `bin/` and `src/`.
3. **Hermetic tests only**: Automated tests **must never** execute real `claude`, `codex`, or `opencode` binaries, and **must never** write to `~/.claude`, `~/.codex`, `~/.config/opencode`, or `~/.runmemo`. Always isolate via `os.tmpdir()`, `RUNMEMO_HOME`, `RUNMEMO_SKIP_SPAWN`, and `--scope project --dir`.

## Repository Layout

- `bin/runmemo.mjs` — CLI entrypoint (`detect`, `install`, `uninstall`, `config`, `status`, `doctor`, `open`, `demo`, `feishu-test`)
- `src/detector.mjs` — Non-executing real-time agent & hook detector + interactive selection parser
- `src/installer.mjs` — Backup-first, idempotent config/plugin installer & uninstaller
- `src/hook-cc.mjs`, `src/hook-codex.mjs`, `src/hook-stdio.mjs`, `src/plugin-opencode.mjs` — Agent adapters with `RUNMEMO_INTERNAL=1` recursion guard
- `src/classify.mjs`, `src/core.mjs` — Pure event classifier, secret redaction, and `O(Δ)` byte-offset JSONL materializer
- `src/summarizer.mjs`, `src/cli-bin.mjs` — Single-flight milestone brief generator and cross-platform CLI runner
- `src/sinks/html.mjs`, `src/sinks/feishu.mjs` — Local HTML dashboard generator & Feishu webhook card sender
- `test/*.test.mjs` — Offline regression suite (`node --test`)

## Local Development Workflow

```bash
# Run offline unit & integration tests
npm test

# Run deterministic multi-agent demo without real CLIs
npm run demo
```

## Pull Request Checklist

- Ensure all `.mjs` files follow `.editorconfig` (UTF-8, LF, 2-space indent).
- Add regression tests under `test/` for any new CLI subcommand, parser rule, adapter behavior, or concurrency edge case.
- Keep user-facing output and briefs crisp and telegraphic.
