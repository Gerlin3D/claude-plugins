# gerlin-plugins — a Claude Code plugin marketplace

Personal Claude Code tooling, installable per plugin:

| Plugin | What it adds | Details |
| --- | --- | --- |
| `codex` | `/codex:review`, `/codex:plan-review` — second-opinion code and plan review through the OpenAI Codex CLI | [codex/README.md](codex/README.md) |
| `pipeline` | `/pipeline:implement`, `/pipeline:batch` — plan → implement → review → fix pipeline, every stage on the model that fits it | [pipeline/README.md](pipeline/README.md) |

You install only the plugins you want. Adding the marketplace makes them visible;
nothing is active until you install it.

## Install

All commands are typed inside a Claude Code session.

### 1. Add the marketplace

From GitHub:

```
/plugin marketplace add Gerlin3D/claude-plugins
```

From a local clone (for example on the machine where you develop the plugins):

```
/plugin marketplace add D:\Development\claude-plugins
```

Claude Code clones or links the repository into its own plugin cache. You do
not need to clone it yourself for the GitHub form.

### 2. Install the plugin(s) you need

```
/plugin install codex@gerlin-plugins
/plugin install pipeline@gerlin-plugins
```

`gerlin-plugins` is the marketplace name from `.claude-plugin/marketplace.json`.
You can also browse and install from the `/plugin` menu.

### 3. Start a new session

Plugin agents, commands and workflows load at session start. After installing or
updating a plugin, start a new Claude Code session before using it.

## Update

```
/plugin marketplace update gerlin-plugins
/plugin update codex
/plugin update pipeline
```

Then start a new session. A session started before the update keeps using the
previous version of the plugin.

## Uninstall

```
/plugin uninstall codex
/plugin uninstall pipeline
/plugin marketplace remove gerlin-plugins
```

## Requirements per plugin

**codex**

- OpenAI Codex CLI: the Codex desktop app, or `npm i -g @openai/codex`.
  Override the executable path with `CODEX_BIN`.
- Node 18+ for the wrapper script.
- A Codex account; reviews consume its usage limits.

**pipeline**

- Workflows enabled in Claude Code (paid plans and API access; Pro users turn on
  "Dynamic workflows" in `/config`). `disableWorkflows` /
  `CLAUDE_CODE_DISABLE_WORKFLOWS` must not be set.
- Access to the `haiku`, `sonnet`, `opus` and `fable` model tiers, which the
  stages are pinned to.
- In the current Claude Code build the plugin's workflow scripts are not found by
  name; copy them into the project once and the commands fall back to that path:

  ```
  mkdir .local/pipeline
  cp <plugin cache>/pipeline/workflows/*.js .local/pipeline/
  ```

  See [pipeline/README.md](pipeline/README.md), section "Running the workflows".

## Project rules stay in the project

Both plugins are project-agnostic. They read the conventions of the repository
they run in — `AGENTS.md`, `CLAUDE.md`, the documents those point to, and
`.claude/skills/`. Put review criteria and coding rules there, not in the plugins.

## Repository layout

```
.claude-plugin/marketplace.json   # the marketplace manifest: one entry per plugin
codex/                            # plugin: .claude-plugin/plugin.json, commands/, scripts/
pipeline/                         # plugin: .claude-plugin/plugin.json, agents/, commands/, workflows/
```

Each plugin is self-contained in its folder and versioned in its own
`plugin.json`.
