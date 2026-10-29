export const meta = {
  name: 'batch',
  description: 'Run a series of steps, each through the full pipeline:run (plan → implement → review → fix → checks), one after another',
  whenToUse: 'Started by /pipeline:batch. args: { steps: [{ title, task, decisions? }], commit?: boolean, stopOnFailure?: boolean, stopOnBlocked?: boolean, runScriptPath?: string }',
  phases: [{ title: 'Steps', detail: 'one pipeline:run per step, sequential' }],
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

return {
  status: stoppedAt > 0 ? 'stopped' : blocked.length > 0 ? 'completed_with_blocked' : 'completed',
  summary: `${done}/${steps.length} approved, ${blocked.length} blocked, ${notRun.length} not run${stoppedAt > 0 ? `; stopped at step ${stoppedAt}: ${stopReason}` : ''}`,
  commitEachStep: commit,
  steps: results,
  blockedSteps: blocked.map((b) => ({ index: b.index, title: b.title, blockingDecisions: b.result.blockingDecisions, brief: b.result.brief })),
  notRun,
  stoppedAt,
  stopReason,
}
