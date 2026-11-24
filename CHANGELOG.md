# Changelog

All notable changes to **runmemo** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-24

### Added
- **Multi-Agent Support**: Non-blocking, backup-first integration for **Claude Code** (`cc`), **OpenAI Codex CLI** (`codex`, including `[features] codex_hooks = true`), and **OpenCode** (`opencode` native ESM plugin with `parentID` subagent tracking).
- **Real-Time Agent Detection**: Added `runmemo detect` (`--json`, `--install`) and interactive `runmemo install` / `runmemo uninstall` powered by pure filesystem / `PATH` / config inspection without executing external agent binaries.
- **Zero-Server HTML Dashboard**: Local `dashboard.html` with compact `data.js` index + lazy per-session views (`views/*.js`), visibility-aware 3s incremental polling, dark/light theme, subagent filters, file-change ledger, and full action feed.
- **Feishu Bot Webhook Sink**: Telegraphic interactive cards with automatic empty-field omission, status-coded headers, source tags, per-session throttling, and HMAC-SHA256 signature support.
- **Async CLI Summarizer**: Single-flight locked summarizer reusing the local `claude`, `codex`, or `opencode` CLI (`auto` mode prefers the originating agent) with `RUNMEMO_INTERNAL=1` recursion guard, secret redaction, and `O(Δ)` byte-offset re-folding.
- **Offline Tooling & Regression Suite**: Interactive `runmemo config init`, `runmemo doctor`, offline multi-agent `runmemo demo`, `runmemo feishu-test`, and cross-platform `node --test` coverage.
