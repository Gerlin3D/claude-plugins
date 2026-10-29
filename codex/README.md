# codex (Claude Code plugin)

Adds two commands run by the OpenAI Codex CLI and triaged by Claude Code:

- `/codex:review` — second-opinion code review of local changes.
- `/codex:plan-review [focus]` — independent architecture review of Claude's
  current implementation plan before coding starts.

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
/codex:plan-review
/codex:plan-review focus on queue idempotency
```

Both commands default to `gpt-5.6-sol`, independently of the model selected in another Codex
session. `/codex:review` uses reasoning effort `high`; `/codex:plan-review` uses `medium` and a
targeted repository scope capped at 30 files. Use `--model` or `--reasoning-effort` for a one-off
override.

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
- `CODEX_REVIEW_MODEL` — code review model and fallback plan-review model (default: `gpt-5.6-sol`)
- `CODEX_REVIEW_REASONING_EFFORT` — code review reasoning effort (default: `high`)
- `CODEX_PLAN_REVIEW_MODEL` — plan-review model (default: `CODEX_REVIEW_MODEL` or `gpt-5.6-sol`)
- `CODEX_PLAN_REVIEW_REASONING_EFFORT` — plan-review reasoning effort (default: `medium`)

On Windows, the wrappers resolve `CODEX_BIN`, then PATH, then the newest installed VS Code Codex
extension CLI, and finally the Codex Desktop bundled CLI.
