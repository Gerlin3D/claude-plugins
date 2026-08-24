# pipeline (Claude Code plugin)

Adds `/pipeline:implement` — a plan-to-implementation handoff that splits one task
across three delegated agents, each on the model that fits its job.

## Install

```
/plugin marketplace add D:\Development\claude-plugins
/plugin install pipeline@gerlin-plugins
```

## Usage

```
/pipeline:implement добавь rate limit на экспорт архива
```

## Model policy

| Stage | Agent | Model | Why |
| --- | --- | --- | --- |
| Discovery | `code-mapper` | `fable` | Read-only sweep over files and conventions — cheap and fast, no judgment calls. |
| Design | `feature-architect` | `opus` | Where the expensive thinking belongs: layer boundaries, invariants, blocking decisions. |
| Implementation | `feature-implementer` | `sonnet` | Executes a brief that already states what to change; strong-model reasoning adds little. |

Scope of this policy: it applies to the **delegated** agents only. Code you write
directly in the session runs on whatever `/model` is set to — a plugin cannot
change the session model.

`maxTurns` is capped per stage (12 / 22 / 32) so a stuck agent fails visibly
instead of burning the budget.

## Project-agnostic by design

The agents carry no project-specific rules. They read the conventions of the repo
they run in — `AGENTS.md`, `CLAUDE.md`, and whatever architecture/state/backlog
documents those name, plus `.claude/skills/` for the touched area. Keep project
rules in the project; keep the pipeline here.

## Collisions

If a repo also defines `.claude/agents/code-mapper.md` (or the other two), the
project-level file and this plugin claim the same agent name. Keep one — remove
the project copies once the plugin is installed.
