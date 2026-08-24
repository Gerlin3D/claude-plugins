# codex (Claude Code plugin)

Adds `/codex:review` — a second-opinion code review of local changes, run by the
OpenAI Codex CLI and triaged by Claude Code.

## Install

```
/plugin marketplace add D:\Development\claude-plugins
/plugin install codex@gerlin-plugins
```

On another machine: clone this repo, then run the same two commands with the
local clone path.

## Usage

```
/codex:review                      # auto: dirty tree -> uncommitted, else base branch
/codex:review base dev
/codex:review commit <sha>         # bare sha or branch name also works
/codex:review проверь idempotency  # free text becomes a per-run focus
```

## Requirements

- Codex CLI: the desktop app (its version-hashed `codex.exe` is found
  automatically on Windows) or `npm i -g @openai/codex`. Override the path with
  `CODEX_BIN`.
- Node 18+ (for the wrapper script).

## Review criteria

Codex loads them itself — put cross-project rules in `~/.codex/AGENTS.md` and
project-specific ones in the repo's own `AGENTS.md`. The wrapper deliberately
sends no rules of its own, because `codex review` refuses a custom prompt
together with `--uncommitted` / `--base` / `--commit`; a per-run `--focus` is the
one exception and travels as a prompt.

## Environment

- `CODEX_BIN` — explicit path to the codex executable
- `CODEX_REVIEW_BASE` — default base branch for a clean tree (else dev/main/master)
