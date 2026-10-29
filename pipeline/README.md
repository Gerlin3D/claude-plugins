# pipeline (Claude Code plugin)

Adds `/pipeline:implement` — a deterministic plan → implement → review → fix
pipeline. One task is split across delegated agents, each on the model that fits
its job, and the control flow (review rounds, finding verification, fix loop)
lives in a Workflow script instead of in the session model's head.

## Install

```
/plugin marketplace add D:\Development\claude-plugins
/plugin install pipeline@gerlin-plugins
```

Workflows need a paid plan (or API access) and must not be disabled via
`disableWorkflows` / `CLAUDE_CODE_DISABLE_WORKFLOWS`.

## Usage

```
/pipeline:implement добавь rate limit на экспорт архива
```

The command starts the plugin workflow `pipeline:run` with `{ task }`. Direct
invocation also works: `/pipeline:run` with the same args.

### A series of steps in one go

```
/pipeline:batch --commit §6.1–6.3 из docs/REFACTORING_CANDIDATES.md
/pipeline:batch
  1. extract usePollingWhile hook (plan §6.2)
  2. replace hand-rolled pairKey helpers with one util (plan §6.2)
```

`/pipeline:batch` expands the argument into a list of `{ title, task, decisions? }`
steps (reading the referenced plan document if needed), shows the list, and starts
the workflow `pipeline:batch`, which runs `pipeline:run` for every step in order.

Policy inside the batch (no questions mid-run):

| Situation | Default | Flag |
| --- | --- | --- |
| Step returns `blocked` | step is skipped, its decisions are collected in the report, series continues | `--stop-on-blocked` stops instead |
| Step ends `unresolved_findings` or `approved_with_failing_checks` | series stops; later steps would build on broken code | `stopOnFailure: false` in args to continue |
| Step `approved` | changes stay in the working tree | `--commit` commits each approved step (`git add -A && git commit -m "<title>"`, hooks respected); a failed commit stops the series |

Without `--commit` every later step's reviewer sees the cumulative diff of the
earlier steps; prefer `--commit` for series longer than two steps.

After the last step the batch runs a **final review of the whole series** with no
briefs at all: the reviewer sees the combined diff (from `baseRef`, the commit the
command recorded before starting) and the project rules, and additionally hunts
for cross-step problems — duplicated helpers, a step undoing another, dead code.
Its findings are reported, not fixed. Disable with `finalReview: false` in args.

### Two review lenses and accepted risks

Every finding carries a `lens`: `brief` (the change deviates from the brief) or
`production` (it breaks in production whether or not the brief asked for it).
The reviewer answers the production question first, as if the brief did not exist.

The architect must list everything it tolerates, defers, or leaves out of scope
under `## Accepted risks`; the pipeline returns that list as `acceptedRisks`
(per step in a batch) so the user decides about them instead of discovering
them in the brief's prose.

## Stages

| # | Stage | Agent | Model | Effort | What it does |
| --- | --- | --- | --- | --- | --- |
| 1 | Discovery | `pipeline:code-mapper` | `haiku` | low | Read-only map of files, patterns, boundaries, risks. Mechanical. |
| 2 | Design | `pipeline:feature-architect` | `fable` | high | Implementation brief, verification commands, **blocking decisions**. |
| 3 | Implement | `pipeline:feature-implementer` | `sonnet` | medium | Changes strictly by the brief, tests, narrow checks. |
| 4 | Review | `pipeline:feature-reviewer` | `opus` | high | Independent read of the diff against the brief and project rules. Sees the brief and the touched-file list only, never the implementer's report. |
| 5 | Verify findings | `pipeline:finding-verifier` | `sonnet` | low | Two refuters per non-minor finding. A finding is dropped only when **both** refute it. |
| 6 | Fix | `pipeline:feature-implementer` | `sonnet` | medium | Fixes confirmed findings only, then back to stage 4. |
| 7 | Checks | `pipeline:check-runner` | `haiku` | low | Runs the brief's verification commands verbatim, reports raw pass / fail. |

Stages 4 → 5 → 6 loop at most `maxReviewRounds` times (default 2). Findings left
after the last round are returned as `unresolved`, not silently dropped.

Model and effort live in the agent frontmatter (`agents/*.md`); the workflow
(`workflows/run.js`) only references agents by type. Change the policy in one place.

Scope of this policy: it applies to the **delegated** agents only. Text and code
produced directly in the session run on whatever `/model` is set to — a plugin
cannot change the session model.

## Blocking decisions

If the architect marks a decision as blocking (data model, layers, integrations,
background-job behavior, API contracts) the workflow returns `status: "blocked"`
before any code is written. The command shows the decisions to the user and
re-runs with `args.decisions` + `resumeFromRunId`; the discovery map is reused
from cache, the architect runs again with the answers folded in.

## Result shape

```
status: approved | approved_with_failing_checks | unresolved_findings | blocked | error
brief, filesTouched, implementation, fixes[]
reviewRounds[]: { round, verdict, briefCompliance[], confirmed[], refuted[] }
unresolved[], minorFindings[]
checks[]: { command, result: pass|fail|not_run, outputTail }, checksNotRun
```

Anything with `fail` / `not_run` is reported as such — the command never
upgrades it to "passed".

## Project-agnostic by design

The agents carry no project-specific rules. They read the conventions of the repo
they run in — `AGENTS.md`, `CLAUDE.md`, and whatever architecture/state/backlog
documents those name, plus `.claude/skills/` for the touched area. Keep project
rules in the project; keep the pipeline here.

## Collisions

Installed plugin agents are addressed with the plugin namespace
(`pipeline:code-mapper`, `pipeline:feature-architect`, …). A repo that also
defines `.claude/agents/code-mapper.md` keeps its own un-namespaced copy — remove
the project copies once this plugin is installed, so one pipeline is in play.

## Running the workflows (current state)

The workflows in `workflows/` are **not** picked up by name from the installed
plugin in the current Claude Code build: `workflow('pipeline:run')` reports only
the built-in workflows. The working setup is a copy of the two scripts in the
project, outside version control:

```
mkdir .local/pipeline
cp <plugin>/workflows/run.js <plugin>/workflows/batch.js .local/pipeline/
```

and the commands fall back to `scriptPath` (`/pipeline:batch` passes the `run.js`
path as `args.runScriptPath`). Re-copy after changing the plugin. The agents, on
the other hand, do load from the plugin — after `/plugin update pipeline` and a
new session; a run made before that silently uses the previous agent definitions
(first observed run: mapper on fable, architect on opus, from v0.1.0).

## Robustness

- The architect writes the brief as free text; a haiku formatter extracts the
  structured fields. An architect that runs out of turns yields an incomplete
  brief with `status: error, stage: design` and the text so far, not a lost run.
- Every stage is wrapped: a failing agent returns `status: error` with the
  `stage` name instead of throwing out of the workflow (and out of a batch).
- One step must be one commit's worth of work. The architect is told to design
  only the first self-contained slice of an oversized task and list the rest;
  `/pipeline:batch` splits plan items into sub-steps before running.

## Known limits

- The reviewer diffs against `HEAD`, so pre-existing uncommitted changes in the
  working tree show up in its view. Start from a clean tree.
- `resumeFromRunId` is same-session only: a blocked run answered in a new
  session re-runs discovery.
