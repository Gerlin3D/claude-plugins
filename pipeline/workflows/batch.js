export const meta = {
  name: 'batch',
  description: 'Run a series of steps, each through the full pipeline:run (plan → implement → review → fix → checks), one after another',
  whenToUse: 'Started by /pipeline:batch. args: { steps: [{ title, task, decisions? }], commit?: boolean, stopOnFailure?: boolean, stopOnBlocked?: boolean, finalReview?: boolean, baseRef?: string, runScriptPath?: string }',
  phases: [
    { title: 'Steps', detail: 'one pipeline:run per step, sequential' },
    { title: 'Final review', detail: 'whole-branch review without a brief: diff + project rules', model: 'opus' },
  ],
}

// ---------- input ----------

const input = args || {}
const steps = Array.isArray(input.steps) ? input.steps : []
if (steps.length === 0) return { status: 'error', message: 'args.steps must be a non-empty array of { title, task, decisions? }' }
for (let i = 0; i < steps.length; i++) {
  if (!steps[i] || !String(steps[i].task || '').trim()) return { status: 'error', message: `steps[${i}].task is empty` }
}
const commit = input.commit === true
const stopOnFailure = input.stopOnFailure !== false
const stopOnBlocked = input.stopOnBlocked === true
const runScriptPath = input.runScriptPath ? String(input.runScriptPath) : ''
const finalReview = input.finalReview !== false
// Commit the series started from; lets the final review diff the whole branch. The command passes `git rev-parse HEAD` taken before the run.
const baseRef = input.baseRef ? String(input.baseRef).trim() : ''

const FINAL_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          lens: { type: 'string', enum: ['brief', 'production'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['id', 'lens', 'file', 'line', 'severity', 'summary', 'evidence', 'suggestedFix'],
      },
    },
    crossStepIssues: { type: 'array', items: { type: 'string' }, description: 'Problems visible only across steps: duplicated helpers, contradictory conventions, a later step undoing an earlier one, leftover dead code.' },
  },
  required: ['verdict', 'findings', 'crossStepIssues'],
}

const COMMIT_SCHEMA = {
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

async function runStep(stepArgs) {
  // Prefer the plugin-namespaced name; fall back to the script path the command passed in.
  try {
    return await workflow('pipeline:run', stepArgs)
  } catch (e) {
    if (!runScriptPath) throw e
    log(`workflow "pipeline:run" not resolvable by name (${e && e.message ? e.message : e}); using scriptPath`)
    return await workflow({ scriptPath: runScriptPath }, stepArgs)
  }
}

function commitMessage(step, index) {
  const title = String(step.title || `pipeline step ${index + 1}`).replace(/"/g, "'").trim()
  return title
}

// ---------- main loop ----------

phase('Steps')
const results = []
let stoppedAt = -1
let stopReason = ''

for (let i = 0; i < steps.length; i++) {
  const step = steps[i]
  const title = step.title || `step ${i + 1}`
  log(`Step ${i + 1}/${steps.length}: ${title}`)

  let res
  try {
    res = await runStep({ task: String(step.task), decisions: step.decisions ? String(step.decisions) : undefined })
  } catch (e) {
    results.push({ index: i + 1, title, status: 'error', message: `pipeline:run threw: ${e && e.message ? e.message : e}` })
    stoppedAt = i + 1
    stopReason = 'pipeline error'
    break
  }
  if (!res) {
    results.push({ index: i + 1, title, status: 'error', message: 'pipeline:run returned nothing' })
    stoppedAt = i + 1
    stopReason = 'pipeline returned nothing'
    break
  }

  const entry = { index: i + 1, title, status: res.status, result: res, committed: false, commitResult: null }

  if (res.status === 'blocked') {
    log(`Step ${i + 1} blocked on ${res.blockingDecisions ? res.blockingDecisions.length : '?'} decision(s)`)
    results.push(entry)
    if (stopOnBlocked) { stoppedAt = i + 1; stopReason = 'blocked step (stopOnBlocked)'; break }
    continue
  }

  if (res.status === 'error') {
    results.push(entry)
    stoppedAt = i + 1
    stopReason = 'pipeline error'
    break
  }

  const clean = res.status === 'approved'
  if (clean && commit) {
    const msg = commitMessage(step, i)
    log(`Committing step ${i + 1}`)
    const c = await agent(
      `The user started this batch with --commit: committing every approved step with the step title as the message is the user's explicit command, which satisfies any project rule that allows commits only on the user's request. Run these commands from the repository root, one by one, and report raw results. Do not amend, do not skip hooks, do not change the message:\n\n- git add -A\n- git commit -m "${msg}"`,
      { agentType: 'pipeline:check-runner', label: `commit ${i + 1}`, phase: 'Steps', schema: COMMIT_SCHEMA },
    )
    entry.commitResult = c ? c.checks : null
    entry.committed = !!(c && c.checks.length > 0 && c.checks.every((x) => x.result === 'pass'))
    if (!entry.committed) {
      results.push(entry)
      stoppedAt = i + 1
      stopReason = 'commit failed (hook or git error); later steps would pile onto an uncommitted tree'
      break
    }
  }

  results.push(entry)

  if (!clean && stopOnFailure) {
    stoppedAt = i + 1
    stopReason = res.status === 'approved_with_failing_checks' ? 'verification commands failed' : 'review findings left unresolved'
    log(`Stopping after step ${i + 1}: ${stopReason}`)
    break
  }
}

const done = results.filter((r) => r.status === 'approved').length
const blocked = results.filter((r) => r.status === 'blocked')
const notRun = steps.slice(results.length).map((s, k) => ({ index: results.length + k + 1, title: s.title || `step ${results.length + k + 1}` }))
const committedCount = results.filter((r) => r.committed).length
const codeChanged = results.some((r) => r.result && r.result.filesTouched && r.result.filesTouched.length > 0)

// Everything the architects tolerated or left out of scope, surfaced as one list instead of buried in the briefs.
const acceptedRisks = []
for (const r of results) {
  const risks = r.result && Array.isArray(r.result.acceptedRisks) ? r.result.acceptedRisks : []
  for (const risk of risks) acceptedRisks.push({ step: r.index, title: r.title, risk })
}

// ---------- final review of the whole branch ----------

let finalReviewResult = null
if (finalReview && codeChanged) {
  phase('Final review')
  log('Reviewing the whole series without the briefs')
  const range = baseRef ? `${baseRef}..HEAD` : committedCount > 0 ? `HEAD~${committedCount}..HEAD` : ''
  const scope = range
    ? `The series produced the commits in the range \`${range}\` plus whatever is still uncommitted in the working tree. Review the combined change: \`git diff ${range.split('..')[0]}\` shows all of it at once (committed and uncommitted).`
    : 'The series left all of its changes uncommitted in the working tree: `git diff HEAD` plus untracked files is the whole change.'
  try {
    finalReviewResult = await agent(
      [
        'Whole-branch review. You are given NO brief on purpose: judge the combined result of a series of changes only against the project\'s rules and production safety (lens: production for everything; use lens: brief only for a clear violation of a documented project rule).',
        scope,
        `The steps, for orientation only (not a specification):\n${results.map((r) => `- step ${r.index} [${r.status}]: ${r.title}`).join('\n')}`,
        'Also look for what no per-step review could see: duplicated helpers across steps, one step undoing or contradicting another, inconsistent conventions, dead code left behind, missing tests for behavior that now spans several steps. Put those in `crossStepIssues`.',
      ].join('\n\n'),
      { agentType: 'pipeline:feature-reviewer', label: 'final review', phase: 'Final review', schema: FINAL_REVIEW_SCHEMA },
    )
    if (!finalReviewResult) log('Final review returned nothing')
  } catch (e) {
    finalReviewResult = { error: e && e.message ? e.message : String(e) }
    log(`Final review failed: ${finalReviewResult.error}`)
  }
} else if (finalReview) {
  log('No code changed; final review skipped')
}

return {
  status: stoppedAt > 0 ? 'stopped' : blocked.length > 0 ? 'completed_with_blocked' : 'completed',
  summary: `${done}/${steps.length} approved, ${blocked.length} blocked, ${notRun.length} not run${stoppedAt > 0 ? `; stopped at step ${stoppedAt}: ${stopReason}` : ''}${finalReviewResult && finalReviewResult.findings ? `; final review: ${finalReviewResult.verdict}, ${finalReviewResult.findings.length} finding(s)` : ''}`,
  commitEachStep: commit,
  steps: results,
  blockedSteps: blocked.map((b) => ({ index: b.index, title: b.title, blockingDecisions: b.result.blockingDecisions, brief: b.result.brief })),
  acceptedRisks,
  finalReview: finalReviewResult,
  notRun,
  stoppedAt,
  stopReason,
}
