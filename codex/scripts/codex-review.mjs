import { spawnSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import os from 'os'
import path from 'path'

// Runs `codex review` (OpenAI Codex CLI) over the local changes of whatever repo
// it is invoked in. Backs the /codex:review slash command of the "codex" plugin
// and can also be run directly.
//
// Review criteria are NOT defined here: Codex loads the project's own AGENTS.md
// (and ~/.codex/AGENTS.md for cross-project rules) by itself. This script only
// resolves the binary, picks the review target, and passes an optional per-run
// focus.

const USAGE = `
Usage: node codex-review.mjs [target] [options] [focus text]

Target (pick one, default = auto):
  --uncommitted | uncommitted    staged + unstaged + untracked changes
  --base <branch> | base <b>     diff against a base branch
  --commit <sha> | commit <sha>  changes introduced by one commit
  <sha> | <branch>               bare sha -> --commit, known ref -> --base
  (auto)                         --uncommitted if the tree is dirty, otherwise
                                 the base branch (CODEX_REVIEW_BASE, else the
                                 first of dev / main / master that exists)

Options:
  --model <name>         override the Codex model
  --reasoning-effort <level>
                         override reasoning effort (minimal/low/medium/high/xhigh)
  --title <text>         title shown in the review summary
  --focus "<text>"       per-run focus; any other free text is treated as focus
  --print-prompt         print what would be sent and exit
  --help

Review rules come from the project AGENTS.md plus ~/.codex/AGENTS.md, which Codex
loads on its own. A focused run passes a prompt instead of the target flags,
because "codex review" refuses a prompt together with --uncommitted / --base /
--commit.

Environment:
  CODEX_BIN              explicit path to the codex executable
  CODEX_REVIEW_BASE      default base branch used for a clean tree
  CODEX_REVIEW_MODEL     review model (default: gpt-5.6-sol)
  CODEX_REVIEW_REASONING_EFFORT
                         review reasoning effort (default: high)
`

// ── args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE.trim())
  process.exit(0)
}

// The review target is the repo the command was invoked in, not the plugin's own
// directory — this script lives outside the project it reviews.
const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
})
if (topLevel.status !== 0 || !topLevel.stdout.trim()) {
  console.error(
    `Error: not a git repository (${process.cwd()}). Codex reviews a diff, so run this from inside a repo.`,
  )
  process.exit(1)
}
const repoRoot = topLevel.stdout.trim()

const flag = name => {
  const i = argv.indexOf(name)
  if (i === -1) return null
  const value = argv[i + 1]
  if (!value || value.startsWith('--')) {
    console.error(`Error: ${name} requires a value`)
    process.exit(1)
  }
  return value
}

const model = flag('--model') ?? process.env.CODEX_REVIEW_MODEL ?? 'gpt-5.6-sol'
const reasoningEffort =
  flag('--reasoning-effort') ??
  process.env.CODEX_REVIEW_REASONING_EFFORT ??
  'high'
const reasoningEfforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])
if (!reasoningEfforts.has(reasoningEffort)) {
  console.error(
    `Error: --reasoning-effort must be one of: ${[...reasoningEfforts].join(', ')}`,
  )
  process.exit(1)
}
const title = flag('--title')
const printPromptOnly = argv.includes('--print-prompt')

let wantsUncommitted = argv.includes('--uncommitted')
let base = flag('--base')
let commit = flag('--commit')
let focus = flag('--focus')

const git = args => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

// Positional forms, so the slash command (and a human) can type the target
// directly: `uncommitted`, `base <branch>`, `commit <sha>`, a bare sha or branch
// name, or free-form focus text.
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    if (
      [
        '--base',
        '--commit',
        '--model',
        '--reasoning-effort',
        '--title',
        '--focus',
      ].includes(arg)
    ) {
      i += 1
    }
    continue
  }
  positional.push(arg)
}

if (positional.length > 0) {
  const [head, ...rest] = positional
  const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(head)
  const knownRef = () =>
    git(['rev-parse', '--verify', '--quiet', head]).status === 0

  if (head === 'uncommitted') {
    wantsUncommitted = true
    if (rest.length > 0) focus ??= rest.join(' ')
  } else if (head === 'base' && rest.length > 0) {
    base ??= rest[0]
    if (rest.length > 1) focus ??= rest.slice(1).join(' ')
  } else if (head === 'commit' && rest.length > 0) {
    commit ??= rest[0]
    if (rest.length > 1) focus ??= rest.slice(1).join(' ')
  } else if (rest.length === 0 && (looksLikeSha || knownRef())) {
    if (looksLikeSha) commit ??= head
    else base ??= head
  } else {
    focus ??= positional.join(' ')
  }
}

const targets = [wantsUncommitted, base, commit].filter(Boolean)
if (targets.length > 1) {
  console.error(
    'Error: --uncommitted, --base and --commit are mutually exclusive',
  )
  process.exit(1)
}

// ── locate the codex executable ───────────────────────────────────────────────

const isWindows = process.platform === 'win32'
const exeName = isWindows ? 'codex.exe' : 'codex'

const newestIn = dir => {
  if (!existsSync(dir)) return null
  const candidates = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const candidate = entry.isDirectory()
      ? path.join(dir, entry.name, exeName)
      : entry.name === exeName
        ? path.join(dir, entry.name)
        : null
    if (candidate && existsSync(candidate)) {
      candidates.push({ candidate, mtime: statSync(candidate).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.candidate ?? null
}

const fromPath = () => {
  const probe = spawnSync(isWindows ? 'where' : 'which', [exeName], {
    encoding: 'utf8',
  })
  if (probe.status !== 0) return null
  return (
    probe.stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(Boolean) ?? null
  )
}

const resolveCodex = () => {
  if (process.env.CODEX_BIN) {
    if (!existsSync(process.env.CODEX_BIN)) {
      console.error(
        `Error: CODEX_BIN points to a missing file: ${process.env.CODEX_BIN}`,
      )
      process.exit(1)
    }
    return process.env.CODEX_BIN
  }

  const onPath = fromPath()
  if (onPath) return onPath

  const home = os.homedir()
  if (isWindows) {
    const extensionsDir = path.join(home, '.vscode', 'extensions')
    const platformDir =
      process.arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64'
    if (existsSync(extensionsDir)) {
      const vscodeCandidates = readdirSync(extensionsDir, {
        withFileTypes: true,
      })
        .filter(
          entry =>
            entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'),
        )
        .map(entry =>
          path.join(
            extensionsDir,
            entry.name,
            'bin',
            platformDir,
            exeName,
          ),
        )
        .filter(candidate => existsSync(candidate))
        .map(candidate => ({ candidate, mtime: statSync(candidate).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (vscodeCandidates[0]) return vscodeCandidates[0].candidate
    }
  }
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  // The Codex desktop app installs into a version-hashed directory that is not
  // on PATH, so pick the newest binary found there.
  const searchDirs = isWindows
    ? [
        path.join(localAppData, 'OpenAI', 'Codex', 'bin'),
        path.join(home, '.codex', 'bin'),
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.codex', 'bin'),
        '/usr/local/bin',
      ]

  for (const dir of searchDirs) {
    const found = newestIn(dir)
    if (found) return found
  }

  console.error(
    [
      'Error: Codex CLI not found.',
      'Install it (Codex desktop app or `npm i -g @openai/codex`), or set CODEX_BIN to the executable path.',
      `Looked in: ${searchDirs.join(', ')}`,
    ].join('\n'),
  )
  process.exit(1)
}

// ── target resolution ─────────────────────────────────────────────────────────

const uncommittedTarget = {
  flags: ['--uncommitted'],
  scope: 'the staged, unstaged and untracked changes in the working tree',
}

const baseTarget = branch => ({
  flags: ['--base', branch],
  scope: `the changes of this branch against base branch \`${branch}\``,
})

const resolveFallbackBase = () => {
  const candidates = process.env.CODEX_REVIEW_BASE
    ? [process.env.CODEX_REVIEW_BASE]
    : ['dev', 'main', 'master']
  return (
    candidates.find(
      ref => git(['rev-parse', '--verify', '--quiet', ref]).status === 0,
    ) ?? candidates[0]
  )
}

let target
if (wantsUncommitted) {
  target = uncommittedTarget
} else if (base) {
  target = baseTarget(base)
} else if (commit) {
  target = {
    flags: ['--commit', commit],
    scope: `the changes introduced by commit \`${commit}\``,
  }
} else {
  const status = git(['status', '--porcelain'])
  const dirty = status.status === 0 && status.stdout.trim().length > 0
  target = dirty ? uncommittedTarget : baseTarget(resolveFallbackBase())
}

// ── per-run focus ─────────────────────────────────────────────────────────────

// `codex review` rejects a prompt together with --uncommitted/--base/--commit,
// so a focused run has to carry its scope inside the prompt text.
const focusPrompt = focus
  ? [
      `Review ${target.scope} of this repo. Get the diff with git yourself.`,
      '',
      'Follow the review priorities and reporting rules from AGENTS.md if the repo has one.',
      '',
      `Extra focus for this run: ${focus}`,
    ].join('\n')
  : null

// ── run ───────────────────────────────────────────────────────────────────────

const configArgs = [
  '-c',
  `model=${JSON.stringify(model)}`,
  '-c',
  `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
]
const titleArgs = title ? ['--title', title] : []
const codexArgs = focusPrompt
  ? ['review', ...configArgs, ...titleArgs, focusPrompt]
  : ['review', ...configArgs, ...titleArgs, ...target.flags]

const branch =
  git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim() || 'unknown'
const codexBin = resolveCodex()

if (printPromptOnly) {
  console.log(
    `codex ${codexArgs.slice(0, focusPrompt ? -1 : undefined).join(' ')}  (repo: ${repoRoot}, branch: ${branch})`,
  )
  console.log(`codex: ${codexBin}`)
  console.log(
    focusPrompt
      ? `\nprompt:\n${focusPrompt}`
      : '\nno prompt — review rules come from AGENTS.md; pass --focus to add per-run instructions',
  )
  process.exit(0)
}

console.log(
  `codex review${focusPrompt ? ` (focused, scope: ${target.scope})` : ` ${target.flags.join(' ')}`}  (repo: ${repoRoot}, branch: ${branch})`,
)
console.log(`codex: ${codexBin}\n`)

const result = spawnSync(codexBin, codexArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Error: failed to run Codex: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
