export const meta = {
  name: 'run',
  description: 'Plan → implement → review → verify findings → fix → checks, each stage on the model that fits it',
  whenToUse: 'Started by /pipeline:implement. args: { task: string, decisions?: string, maxReviewRounds?: number }. Returns status "blocked" when the brief has open blocking decisions.',
  phases: [
    { title: 'Discovery', detail: 'read-only code map', model: 'haiku' },
    { title: 'Design', detail: 'implementation brief with blocking decisions', model: 'fable' },
    { title: 'Implement', detail: 'changes strictly by the brief', model: 'sonnet' },
    { title: 'Review', detail: 'independent review of the diff', model: 'opus' },
    { title: 'Verify findings', detail: 'two refuters per finding', model: 'sonnet' },
    { title: 'Fix', detail: 'confirmed findings only', model: 'sonnet' },
    { title: 'Checks', detail: 'project verification commands', model: 'haiku' },
  ],
}

// ---------- input ----------

const input = typeof args === 'string' ? { task: args } : (args || {})
const task = String(input.task || '').trim()
if (!task) return { status: 'error', message: 'args.task is required: { task: "<what to build>" }' }
const decisions = input.decisions ? String(input.decisions).trim() : ''
const maxRounds = Number.isInteger(input.maxReviewRounds) && input.maxReviewRounds > 0 ? input.maxReviewRounds : 2

// ---------- schemas ----------

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' } }, required: ['path', 'role'] } },
    patterns: { type: 'array', items: { type: 'string' } },
    boundaries: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'patterns', 'boundaries', 'risks', 'gaps'],
}

// The architect writes the brief as free text (no schema → no lost work when it runs out of turns);
// a cheap formatter then extracts the machine-readable fields from that text.
const BRIEF_META_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean', description: 'false when the brief text is cut off, empty, or explicitly says the investigation was unfinished.' },
    filesToChange: { type: 'array', items: { type: 'string' } },
    verificationCommands: { type: 'array', items: { type: 'string' }, description: 'Exact shell commands from the project docs to run after implementation.' },
    blockingDecisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
        },
        required: ['id', 'question', 'options', 'recommendation'],
      },
    },
    openNonBlocking: { type: 'array', items: { type: 'string' } },
  },
  required: ['complete', 'filesToChange', 'verificationCommands', 'blockingDecisions', 'openNonBlocking'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    changedFiles: { type: 'array', items: { type: 'string' } },
    testsAddedOrUpdated: { type: 'array', items: { type: 'string' } },
    checksRun: {
      type: 'array',
      items: {
        type: 'object',
        properties: { command: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'not_run'] }, notes: { type: 'string' } },
        required: ['command', 'result', 'notes'],
      },
    },
    deviations: { type: 'array', items: { type: 'string' }, description: 'Anything done differently from the brief / findings, with the reason.' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['changedFiles', 'testsAddedOrUpdated', 'checksRun', 'deviations', 'risks'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['id', 'file', 'line', 'severity', 'summary', 'evidence', 'suggestedFix'],
      },
    },
    briefCompliance: { type: 'array', items: { type: 'string' }, description: 'Brief steps or acceptance criteria that are NOT met, one per entry; empty when all met.' },
  },
  required: ['verdict', 'findings', 'briefCompliance'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
  required: ['refuted', 'reasoning'],
}

const CHECKS_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { command: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'not_run'] }, outputTail: { type: 'string' } },
        required: ['command', 'result', 'outputTail'],
      },
    },
  },
  required: ['checks'],
}

// ---------- helpers ----------

const json = (v) => JSON.stringify(v, null, 2)
const fmtFinding = (f) => `[${f.id}] ${f.severity} — ${f.file}:${f.line}\n  ${f.summary}\n  Evidence: ${f.evidence}\n  Suggested fix: ${f.suggestedFix}`

// Every stage runs through this so one failing agent produces a typed `error` result
// naming the stage, instead of an exception that kills the whole run (and any batch around it).
async function stage(name, fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    const message = e && e.message ? e.message : String(e)
    log(`Stage "${name}" failed: ${message}`)
    return { ok: false, error: { stage: name, message } }
  }
}
const fail = (r, extra) => ({ status: 'error', stage: r.error.stage, message: r.error.message, ...extra })

// ---------- 1. discovery ----------

phase('Discovery')
log('Mapping the code relevant to the task')
const mapRes = await stage('discovery', () => agent(
  `Task to be implemented in this repository:\n\n${task}\n\nProduce the read-only code map for this task.`,
  { agentType: 'pipeline:code-mapper', label: 'map', phase: 'Discovery', schema: MAP_SCHEMA },
))
// Discovery is an optimization; the architect can work without it.
const map = mapRes.ok ? mapRes.value : null
if (!mapRes.ok) log('Continuing without a discovery map')

// ---------- 2. design ----------

phase('Design')
log('Writing the implementation brief')
const briefTextRes = await stage('design', () => agent(
  [
    `Task:\n\n${task}`,
    map ? `Discovery map (evidence gathered by a read-only pass; verify before relying on it):\n${json(map)}` : 'No discovery map is available; investigate the code yourself.',
    decisions
      ? `The user has already answered the blocking decisions raised earlier. Treat these answers as settled and do not list them as blocking again:\n\n${decisions}`
      : 'No decisions have been pre-approved by the user. List every blocking decision explicitly.',
    [
      'Write the implementation brief as markdown. Your final message IS the brief; it is parsed by a formatter afterwards, so use these exact section headings:',
      '`## Goal`, `## Non-goals`, `## Files to change` (one path per line), `## Changes` (file by file), `## Contracts and invariants`, `## Steps`, `## Acceptance criteria`, `## Verification commands` (one exact command per line, taken from the project docs), `## Blocking decisions` (each: `- [id] question — options: a | b — recommendation: …`, or `none`), `## Open non-blocking points`.',
      'If you are running out of turns, stop investigating and write the brief from what you have verified, marking unverified parts as such.',
    ].join('\n'),
  ].join('\n\n'),
  { agentType: 'pipeline:feature-architect', label: 'brief', phase: 'Design' },
))
if (!briefTextRes.ok) return fail(briefTextRes, { map })
const briefText = typeof briefTextRes.value === 'string' ? briefTextRes.value.trim() : ''
if (!briefText) return { status: 'error', stage: 'design', message: 'The architect returned an empty brief (likely ran out of turns before writing it).', map }

log('Extracting the structured fields of the brief')
const metaRes = await stage('design-format', () => agent(
  [
    'Below is an implementation brief written by another agent. Extract its machine-readable fields exactly as written; do not add, infer, or reword items. Do not read the repository.',
    '`complete` is false when the brief is cut off, missing the Steps or Files to change sections, or says its investigation was unfinished.',
    `Brief:\n\n${briefText}`,
  ].join('\n\n'),
  { model: 'haiku', effort: 'low', label: 'brief fields', phase: 'Design', schema: BRIEF_META_SCHEMA },
))
if (!metaRes.ok) return fail(metaRes, { map, brief: briefText })
const brief = { ...metaRes.value, brief: briefText }
if (!brief.complete) {
  return { status: 'error', stage: 'design', message: 'The architect delivered an incomplete brief; see `brief`. Narrow the task or raise the architect turn budget.', brief: briefText, map }
}

if (brief.blockingDecisions.length > 0) {
  log(`Blocked on ${brief.blockingDecisions.length} decision(s); stopping before implementation`)
  return {
    status: 'blocked',
    message: 'The brief contains blocking decisions. Ask the user, then re-run with args.decisions holding the answers (and resumeFromRunId to reuse the discovery map).',
    blockingDecisions: brief.blockingDecisions,
    brief: brief.brief,
    openNonBlocking: brief.openNonBlocking,
    map,
  }
}

// ---------- 3. implement ----------

phase('Implement')
log('Implementing the brief')
const implRes = await stage('implement', () => agent(
  [
    'Implement the following approved brief. Do not widen its scope.',
    brief.brief,
    brief.openNonBlocking.length ? `Non-blocking open points (pick the minimal safe option and record it in deviations):\n- ${brief.openNonBlocking.join('\n- ')}` : '',
    'Run only the narrowest meaningful checks yourself; the full verification commands run in a later stage.',
  ].filter(Boolean).join('\n\n'),
  { agentType: 'pipeline:feature-implementer', label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA },
))
if (!implRes.ok) return fail(implRes, { brief: brief.brief, map, note: 'The working tree may contain partial changes from the implementer.' })
const impl = implRes.value
if (!impl) return { status: 'error', stage: 'implement', message: 'The implementer returned nothing.', brief: brief.brief, map }

let touched = Array.from(new Set([...(impl.changedFiles || []), ...(impl.testsAddedOrUpdated || [])]))

// ---------- 4–6. review → verify → fix loop ----------

const rounds = []
const fixes = []
const minors = []
let approved = false
let unresolved = []

for (let round = 1; round <= maxRounds; round++) {
  phase('Review')
  log(`Review round ${round}/${maxRounds}`)
  const reviewRes = await stage(`review-${round}`, () => agent(
    [
      `Independent review, round ${round}. You are reviewing an implementation of the brief below.`,
      `Files the implementation reports as touched (verify against git; look for changes outside this list too):\n- ${touched.join('\n- ') || '(none reported)'}`,
      `Brief:\n\n${brief.brief}`,
      round > 1 ? 'Earlier rounds already requested changes; the diff now includes the fixes. Re-review the whole change, not just the fixes.' : '',
    ].filter(Boolean).join('\n\n'),
    { agentType: 'pipeline:feature-reviewer', label: `review r${round}`, phase: 'Review', schema: REVIEW_SCHEMA },
  ))
  const review = reviewRes.ok ? reviewRes.value : null
  if (!review) { rounds.push({ round, error: reviewRes.ok ? 'reviewer returned nothing' : reviewRes.error.message }); break }

  const serious = review.findings.filter((f) => f.severity !== 'minor')
  minors.push(...review.findings.filter((f) => f.severity === 'minor').map((f) => ({ ...f, round })))

  if (serious.length === 0) {
    rounds.push({ round, verdict: review.verdict, briefCompliance: review.briefCompliance, confirmed: [], refuted: [] })
    approved = review.briefCompliance.length === 0
    if (!approved) unresolved = review.briefCompliance.map((c) => ({ id: `compliance-${round}`, severity: 'major', summary: c, file: '', line: 0, evidence: '', suggestedFix: '' }))
    log(approved ? 'No serious findings; approved' : 'No code findings, but the brief is not fully met')
    if (approved) break
  }

  let confirmed = []
  const refuted = []
  if (serious.length > 0) {
    phase('Verify findings')
    log(`Verifying ${serious.length} finding(s) with two refuters each`)
    // Barrier is intentional: the fix stage needs the full confirmed list at once.
    // A refuter that errors out resolves to null and is simply not counted as a vote.
    const judged = await parallel(serious.map((f) => () =>
      parallel([0, 1].map((i) => () =>
        agent(
          [
            `Refuter ${i + 1} of 2. Try to prove this review finding wrong. If you cannot do so confidently, answer refuted=false.`,
            fmtFinding(f),
            `Brief the change was judged against:\n\n${brief.brief}`,
          ].join('\n\n'),
          { agentType: 'pipeline:finding-verifier', label: `verify ${f.id} #${i + 1}`, phase: 'Verify findings', schema: VERDICT_SCHEMA },
        ),
      )).then((votes) => ({ f, votes: votes.filter(Boolean) })),
    ))
    for (const j of judged.filter(Boolean)) {
      const refutes = j.votes.filter((v) => v.refuted).length
      if (j.votes.length > 0 && refutes === j.votes.length) {
        refuted.push({ ...j.f, refutation: j.votes.map((v) => v.reasoning) })
      } else {
        confirmed.push({ ...j.f, disputed: refutes > 0, verifierNotes: j.votes.map((v) => v.reasoning) })
      }
    }
    log(`${confirmed.length} confirmed, ${refuted.length} refuted`)
  }

  if (serious.length > 0 || review.briefCompliance.length > 0) {
    const complianceItems = review.briefCompliance.map((c, k) => ({ id: `compliance-r${round}-${k + 1}`, file: '', line: 0, severity: 'major', summary: c, evidence: 'Reviewer: brief step / acceptance criterion not met', suggestedFix: 'Complete the brief step', disputed: false, verifierNotes: [] }))
    confirmed = [...confirmed, ...complianceItems]
    rounds.push({ round, verdict: review.verdict, briefCompliance: review.briefCompliance, confirmed, refuted })
  }

  if (confirmed.length === 0) { approved = true; break }

  if (round === maxRounds) {
    unresolved = confirmed
    log(`Review budget exhausted; ${confirmed.length} finding(s) left unresolved`)
    break
  }

  phase('Fix')
  log(`Fixing ${confirmed.length} confirmed finding(s)`)
  const fixRes = await stage(`fix-${round}`, () => agent(
    [
      'Fix exactly the following confirmed review findings. Do not touch anything else. If a finding is wrong, leave the code and explain in deviations.',
      confirmed.map(fmtFinding).join('\n\n'),
      `Brief for context (do not widen scope beyond it):\n\n${brief.brief}`,
    ].join('\n\n'),
    { agentType: 'pipeline:feature-implementer', label: `fix r${round}`, phase: 'Fix', schema: IMPL_SCHEMA },
  ))
  const fix = fixRes.ok ? fixRes.value : null
  if (!fix) { rounds.push({ round, error: fixRes.ok ? 'fixer returned nothing' : fixRes.error.message }); unresolved = confirmed; break }
  fixes.push({ round, ...fix })
  touched = Array.from(new Set([...touched, ...(fix.changedFiles || []), ...(fix.testsAddedOrUpdated || [])]))
}

// ---------- 7. checks ----------

phase('Checks')
let checks = null
if (brief.verificationCommands.length > 0) {
  log(`Running ${brief.verificationCommands.length} verification command(s)`)
  const checksRes = await stage('checks', () => agent(
    `Run these commands from the repository root, one by one, and report raw results:\n\n${brief.verificationCommands.map((c) => `- ${c}`).join('\n')}`,
    { agentType: 'pipeline:check-runner', label: 'checks', phase: 'Checks', schema: CHECKS_SCHEMA },
  ))
  checks = checksRes.ok ? checksRes.value : null
} else {
  log('The brief lists no verification commands; checks stage skipped')
}

const checksFailed = checks ? checks.checks.filter((c) => c.result !== 'pass') : []

return {
  status: approved && checksFailed.length === 0 ? 'approved' : approved ? 'approved_with_failing_checks' : 'unresolved_findings',
  task,
  brief: brief.brief,
  filesTouched: touched,
  implementation: impl,
  fixes,
  reviewRounds: rounds,
  unresolved,
  minorFindings: minors,
  checks: checks ? checks.checks : [],
  checksNotRun: brief.verificationCommands.length === 0 ? 'brief listed no verification commands' : (checks ? '' : 'check-runner returned nothing'),
}
