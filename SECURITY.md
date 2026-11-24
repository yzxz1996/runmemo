# Security Policy

## Architectural Safety Guarantees

- **Recursion Guard**: Any child CLI spawned by `runmemo` sets `RUNMEMO_INTERNAL=1`. Hook entrypoints check this variable immediately before importing runtime modules to prevent infinite self-triggering loops.
- **Non-Executing Detection**: `runmemo detect` and `runmemo doctor` inspect binary existence and configuration directories strictly via filesystem metadata calls and never execute detected third-party binaries.
- **Secret Redaction**: Before prompts/snippets are sent to the summarizer or persisted to the HTML dashboard / Feishu cards, common secret patterns (`Bearer` tokens, `sk-...`, `ghp_...`, `github_pat_...`, `AKIA...`, `xox[baprs]-...`, and credential assignments) are masked with `***`.
- **Backup-First Config Edits**: Before modifying existing Claude Code, Codex CLI, or OpenCode files, `runmemo` writes a `.runmemo.bak` copy and performs atomic writes. `runmemo config show` masks webhook URLs and secrets by default.

## Reporting a Vulnerability

If you discover a security issue (such as credential leakage in redaction, unsafe shell argument quoting, or config clobbering), please **do not post raw credentials or exploits in a public issue**.

Open a [GitHub Security Advisory](https://github.com/yzxz1996/runmemo/security/advisories/new) or open an issue describing the reproduction pattern with synthetic placeholders.
