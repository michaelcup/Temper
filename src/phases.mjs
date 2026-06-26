// Mode B: the overnight Plan-queue. Runs ordered phase Plans, gating each against the prior
// committed phase, with branch isolation, a resumable ledger, a global budget, and a morning
// report. Decomposition stays a human job (ordered files), not an LLM step.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { run, log, git, fail, requireCleanRepo, acquireLock, notify, state } from './sh.mjs'
import { parsePlan, validatePlan, draftPlan } from './plan.mjs'
import { runPlan } from './loop.mjs'
import { runDirectionCheck, runReconcile } from './engine.mjs'
import { detectScopeConflicts, scopesOverlap } from './conflicts.mjs'

// Shown when a queue has no phase files yet — the missing on-ramp between Mode A and Mode B.
const PHASE_HINT =
  'Phase files are ordered Plans (01-*.md, 02-*.md, …), each the same format as a `temper run` Plan.\n' +
  '  Draft one with:  temper plan "<phase 1 task>" --out .temper/phases/01-first.md'

function discoverPhases(dir) {
  const root = resolve(dir) // absolute → ledger keys are invariant to how `dir` was spelled
  if (!existsSync(root)) fail(`No phase directory at ${dir}.\n${PHASE_HINT}`)
  return readdirSync(root)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) // 1- < 2- < 10-, not lexicographic
    .map((f) => join(root, f))
}

// Load + shape-validate the on-disk ledger (a hand-edited or old-format file must not crash a run).
function loadLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object' && typeof e.file === 'string') : []
  } catch {
    log(`⚠ ignoring unreadable ledger at ${ledgerPath} (starting fresh)`)
    return []
  }
}

// Overnight isolation (Mode B): switch to the queue's OWN branch (a STABLE temper/<dir> name, so a
// resume re-enters it) — never the base branch, never auto-merged — and register an exit hook that
// ALWAYS restores `base` on ANY exit, so the next run forks from the real base (no stacked branches,
// no stranded HEAD). Returns the branch in use (== base when not isolating).
function setupBranchIsolation(opts, dir, base) {
  if (!opts.overnight && !opts.branch) return base
  const branch = typeof opts.branch === 'string' ? opts.branch : `temper/${basename(resolve(dir))}`
  if (branch === base) return base
  const exists = run(`git rev-parse --verify --quiet "refs/heads/${branch}"`).code === 0
  if (run(exists ? `git checkout --quiet "${branch}"` : `git checkout --quiet -b "${branch}"`).code !== 0) {
    fail(`Could not switch to isolation branch ${branch}.`)
  }
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    run('git reset --hard --quiet HEAD') // drop uncommitted failed-attempt changes…
    run('git clean -fdq') // …and untracked out-of-scope artifacts (gitignored files like .temper/ are kept)
    run(`git checkout --quiet "${base}"`)
  }
  process.on('exit', restore)
  // Node does NOT run 'exit' handlers when killed by a signal. Without these, a Ctrl-C on a dragging
  // overnight run — or a dropped SSH/terminal session — would strand HEAD on the isolation branch with the
  // in-flight phase's dirty tree, breaking the stated "restore base on ANY exit" invariant. The explicit
  // process.exit re-fires 'exit' but the `restored` flag makes restore() idempotent.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      restore()
      process.exit(sig === 'SIGINT' ? 130 : 143)
    })
  }
  log(`⎇ ${exists ? 'resuming the queue on' : 'isolating the queue on'} ${branch} — ${base} untouched, nothing auto-merged.`)
  return branch
}

// Resume a phase only if it committed, its plan is unchanged (fingerprint), and its commit
// (a real string sha) is in HEAD's history. An edited plan re-runs (no silent false-green).
function isResumable(prior, fingerprint) {
  return (
    prior?.status === 'committed' &&
    typeof prior.sha === 'string' &&
    prior.fingerprint === fingerprint &&
    run(`git merge-base --is-ancestor ${prior.sha} HEAD`).code === 0
  )
}

const exitCodeFor = (status) => (status === 'halted' ? 2 : status === 'escalated' ? 4 : status === 'gamed' ? 5 : status === 'error' ? 1 : 3)

// Neutralize markdown-structure chars so a plan title / violation text (which can be arbitrary
// command output) can't break the report table or inject headings/fences. One line, no pipes, no fences.
const mdCell = (s) => String(s).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'")

// The morning report (Mode B): synthesized from the ledger so it survives a detached run.
// Facts only — what committed, what stopped it and why, what's left, where the work is.
function writeReport(cfg, { dir, branch, base, ledger, phases, outcome, stoppedAt }) {
  const reportPath = join(dirname(cfg.progressFile), 'report.md')
  mkdirSync(dirname(reportPath), { recursive: true })
  const byFile = new Map(ledger.map((e) => [e.file, e]))
  const isolated = branch !== base
  const shortSha = (s) => (typeof s === 'string' ? s.slice(0, 9) : '—') // a stale/old-format ledger may lack a string sha
  const rows = phases.map(({ file, plan }, i) => {
    const e = byFile.get(file)
    const status = i + 1 <= stoppedAt ? e?.status ?? '—' : 'not run'
    // Show a commit sha ONLY for committed phases — a failed verdict carries the prior base sha.
    const sha = e?.status === 'committed' ? shortSha(e?.sha) : '—'
    // Un-run phases have no ledger entry — fall back to the parsed plan title, not the raw filename.
    return `| ${i + 1} | ${mdCell(e?.title ?? plan.title)} | ${status} | ${sha} | ${e?.iterations ?? '—'} | ${e?.seconds ?? '—'} |`
  })
  const committed = ledger.filter((e) => e.status === 'committed')
  const committedShas = committed.map((e) => e.sha).filter((s) => typeof s === 'string')
  const stopped = ledger.find((e) => e.status && e.status !== 'committed')
  const remaining = phases.length - stoppedAt
  let md = `# Temper run report\n\n`
  md += `- **Queue:** ${mdCell(dir)}\n`
  md += `- **Branch:** ${branch}${isolated ? ` (from ${base}; NOT merged)` : ''}\n`
  md += `- **Outcome:** ${outcome}\n- **Generated:** ${new Date().toISOString()}\n\n`
  md += `| # | phase | status | commit | iters | time |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n`
  md += `**Committed:** ${committed.length}/${phases.length}${committedShas.length ? ` — ${committedShas.map((s) => s.slice(0, 9)).join(', ')}` : ''}\n`
  if (stopped) {
    const gate = stopped.stuckDomain ? ` — the \`${mdCell(stopped.stuckDomain)}\` gate` : ''
    md += `\n**Stopped at phase ${stopped.phase}** "${mdCell(stopped.title)}"${gate} (${stopped.status})\n`
    if (Array.isArray(stopped.violations) && stopped.violations.length) md += stopped.violations.map((v) => `- ${mdCell(v)}`).join('\n') + '\n'
  }
  // Surface every reuse-critic flag, including a warn-level one on a phase that still COMMITTED — that
  // signal otherwise only reached stdout, so the morning report would hide a possible duplication.
  const flagged = ledger.filter((e) => e.critic?.flagged)
  if (flagged.length) {
    md += `\n**Reuse-critic flags** (possible duplication — worth a look before you merge):\n`
    md += flagged.map((e) => `- phase ${e.phase} "${mdCell(e.title)}" (${e.status}, ${mdCell(e.critic.confidence)} confidence): ${mdCell(e.critic.summary)}`).join('\n') + '\n'
  }
  // Surface every direction concern (the "wrong thing" axis) — including on a phase that still COMMITTED
  // under onMiss:'warn', so the morning report flags a possibly-misdirected approach before you merge.
  const offTrack = ledger.filter((e) => e.direction && e.direction.sound === false)
  if (offTrack.length) {
    md += `\n**Direction concerns** (approach may be on the wrong track — review before you merge):\n`
    md += offTrack.map((e) => `- phase ${e.phase} "${mdCell(e.title)}" (${e.status}, source: ${mdCell(e.direction.source)}): ${mdCell(e.direction.concern)}`).join('\n') + '\n'
  }
  if (remaining > 0) md += `\n**Not run:** ${remaining} later phase(s).\n`
  if (isolated) md += `\n**Next:** review \`${branch}\`, then (from ${base}) \`git merge --no-ff ${branch}\` if good.\n`
  writeFileSync(reportPath, md)
  return reportPath
}

export function runPhases(cfg, dir, opts = {}) {
  requireCleanRepo()
  if (run(`git check-ignore "${cfg.progressFile}"`).code !== 0) {
    fail(`Add \`.temper/\` to your .gitignore — Temper writes its phase ledger to ${cfg.progressFile} and it must not pollute the gate.`)
  }
  acquireLock() // single-writer: refuse a second concurrent run mutating this repo
  // Snapshot + validate EVERY phase on the CURRENT (base) branch BEFORE any checkout, so the queue
  // is invariant to what the isolation branch happens to contain, and a parse/validate failure
  // can't strand HEAD on the isolation branch (it fails here, before any branch switch).
  const phaseFiles = discoverPhases(dir)
  if (!phaseFiles.length) fail(`No phase plans (*.md) in ${dir}.\n${PHASE_HINT}`)
  const phases = phaseFiles.map((file) => {
    const plan = parsePlan(file)
    validatePlan(plan)
    return { file, plan, fingerprint: createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) }
  })
  // Surface scope conflicts before the run (non-blocking): two plans claiming a common file risk the second
  // silently clobbering the first. You may have sequenced them deliberately, so this warns, never stops.
  const { conflicts } = detectScopeConflicts(phases)
  if (conflicts.length) {
    log(`⚠ ${conflicts.length} scope overlap(s) in this queue — plans claiming a common file:`)
    for (const c of conflicts) log(`   ${basename(c.a)} ↔ ${basename(c.b)}`)
    log(`  Run \`temper plan-check ${dir} --reconcile\` to review before committing to the night.\n`)
  }
  const ledgerPath = cfg.progressFile
  const ledger = loadLedger(ledgerPath)
  const base = git('rev-parse --abbrev-ref HEAD')
  const branch = setupBranchIsolation(opts, dir, base)

  // Global budget: a hard ceiling on the whole queue, above the per-phase maxIterations and
  // stuck-domain escalation, so a bad night is bounded. Rate-limit sleeps don't count as work.
  const queueStart = performance.now()
  let totalIters = 0
  const overBudget = () => {
    const activeSec = (performance.now() - queueStart - state.totalSleptMs) / 1000
    if (cfg.maxQueueSeconds && activeSec > cfg.maxQueueSeconds) return `wall-clock budget (${cfg.maxQueueSeconds}s active) exceeded`
    if (cfg.maxQueueIterations && totalIters >= cfg.maxQueueIterations) return `iteration budget (${cfg.maxQueueIterations}) exceeded`
    return null
  }

  let baseSha = git('rev-parse HEAD')
  let outcome = 'all-green'
  let n = 0
  for (; n < phases.length; n++) {
    const { file, plan, fingerprint } = phases[n]
    const prior = ledger.find((e) => e.file === file)
    if (isResumable(prior, fingerprint)) {
      log(`▷ phase ${n + 1}/${phases.length} "${plan.title}" — already committed (${prior.sha.slice(0, 9)}), skipping`)
      baseSha = git('rev-parse HEAD')
      continue
    }
    const reason = overBudget()
    if (reason) {
      log(`\n■ budget reached: ${reason}. Stopping before phase ${n + 1}; ${phases.length - n} phase(s) not run.`)
      log('  (The budget bounds this run-phases invocation; a resume starts a fresh budget — give any auto-retry loop its own ceiling.)')
      outcome = 'budget'
      break
    }
    log(`\n━━ phase ${n + 1}/${phases.length}: ${plan.title} ━━  base ${baseSha.slice(0, 9)}`)
    // Direction check (opt-in, overnight only): BEFORE implementing, ground the phase's APPROACH against the
    // configured trust-list — the "are we doing the RIGHT thing" axis the per-iteration gates can't see.
    // Deterministic cadence (every Nth phase, 0-indexed so phase 1 is always checked); fail-open. 'warn'
    // surfaces in the morning report; 'pause' stops the queue before the phase so a wrong premise can't compound.
    let direction
    const dc = cfg.directionCheck
    if (opts.overnight && dc.enabled && dc.sources.length && n % dc.every === 0) {
      log(`• direction check: grounding the approach against ${dc.sources.length} trusted source(s)…`)
      const d = runDirectionCheck(cfg, plan)
      if (!d.sound) {
        direction = d
        log(`⚠ direction concern (${mdCell(d.source)}): ${mdCell(d.concern)}`)
        if (dc.onMiss === 'pause') {
          // Record the pause IN-MEMORY only (for the morning report below) — do NOT persist a
          // 'direction-paused' entry to the on-disk ledger for an UN-RUN phase: a crash mid-resume would
          // leave `temper status` asserting a phase was paused when it's actually being re-run. The earlier
          // committed phases are already on disk; this phase simply re-runs on resume, no stale entry.
          const pausedEntry = { phase: n + 1, file, title: plan.title, fingerprint, status: 'direction-paused', branch, base, direction }
          const pidx = ledger.findIndex((e) => e.file === file)
          if (pidx >= 0) ledger[pidx] = pausedEntry
          else ledger.push(pausedEntry)
          outcome = 'direction'
          log(`\n■ paused before phase ${n + 1} (directionCheck.onMiss: pause). Earlier phases are committed; ${phases.length - n} phase(s) not run.`)
          const report = writeReport(cfg, { dir, branch, base, ledger, phases, outcome, stoppedAt: n + 1 })
          log(`📋 report: ${report}`)
          if (branch !== base) log(`⎇ committed work is on ${branch}; restoring you to ${base}. Review the approach, then resume.`)
          notify(cfg, outcome, { branch, base, report, summary: `temper queue paused at phase ${n + 1} (direction concern)` })
          process.exit(7)
        }
      }
    }
    const v = runPlan(cfg, plan, { baseSha })
    totalIters += v.iterations ?? 0
    const entry = { phase: n + 1, file, title: plan.title, fingerprint, status: v.status, sha: v.sha, iterations: v.iterations, seconds: v.seconds, branch, base, stuckDomain: v.stuckDomain, critic: v.critic, direction, violations: v.status === 'committed' ? undefined : v.violations }
    const idx = ledger.findIndex((e) => e.file === file)
    if (idx >= 0) ledger[idx] = entry
    else ledger.push(entry)
    mkdirSync(dirname(ledgerPath), { recursive: true })
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
    if (v.status !== 'committed') {
      outcome = v.status
      log(`\n■ phase ${n + 1} ${v.status}. Earlier phases are committed; later phases were NOT run. See ${ledgerPath}.`)
      const report = writeReport(cfg, { dir, branch, base, ledger, phases, outcome, stoppedAt: n + 1 })
      log(`📋 report: ${report}`)
      if (branch !== base) log(`⎇ committed work is on ${branch}; restoring you to ${base}. Review + merge it yourself.`)
      notify(cfg, outcome, { branch, base, report, summary: `temper queue stopped at phase ${n + 1} (${outcome})` })
      process.exit(exitCodeFor(v.status))
    }
    baseSha = v.sha
  }
  if (outcome === 'all-green') log(`\n✓ all ${phases.length} phases green. Ledger: ${ledgerPath}`)
  const report = writeReport(cfg, { dir, branch, base, ledger, phases, outcome, stoppedAt: n })
  log(`📋 report: ${report}`)
  if (branch !== base) {
    log(`⎇ work is on ${branch}; restoring you to ${base}. Review it, then merge yourself (Temper never merges):\n    git merge --no-ff ${branch}`)
  }
  const committedCount = ledger.filter((e) => e.status === 'committed').length
  notify(cfg, outcome, { branch, base, report, summary: `temper queue ${outcome}: ${committedCount}/${phases.length} phases committed` })
  if (outcome === 'budget') process.exit(6)
}

// `temper status` — read the ledger (written per-phase) so a detached/overnight run can be
// checked at any time, including the morning after.
export function status(cfg) {
  const ledgerPath = cfg.progressFile
  if (!existsSync(ledgerPath)) return log('No queue ledger found — nothing recorded yet.')
  let ledger
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    if (!Array.isArray(parsed)) return fail(`Ledger at ${ledgerPath} is not in the expected format.`)
    ledger = parsed.filter((e) => e && typeof e === 'object')
  } catch {
    return fail(`Unreadable ledger at ${ledgerPath}.`)
  }
  // Report the branch the RUN used (from the ledger), not whatever is checked out now — an
  // overnight run restores you to the base branch, so HEAD would mislead.
  const runBranch = ledger.find((e) => e.branch)?.branch
  log(`run branch: ${runBranch ?? git('rev-parse --abbrev-ref HEAD')}`)
  const committed = ledger.filter((e) => e.status === 'committed').length
  log(`phases recorded: ${ledger.length}  •  committed: ${committed}`)
  for (const e of ledger) {
    // A commit sha ONLY for committed phases — a stopped phase's `sha` is the PRIOR base commit, not its own (matches report.md).
    log(`  ${e.status === 'committed' ? '✓' : '■'} ${e.phase ?? '?'}. ${e.title ?? '(untitled)'} — ${e.status ?? '?'}${e.status === 'committed' && typeof e.sha === 'string' ? ` (${e.sha.slice(0, 9)})` : ''}  ${e.iterations ?? '?'} iter / ${e.seconds ?? '?'}`)
  }
  const reportPath = join(dirname(ledgerPath), 'report.md')
  if (existsSync(reportPath)) log(`\n📋 full report: ${reportPath}`)
}

// `temper plan-check <dir>` — surface scope conflicts in a phase queue BEFORE an overnight run: pairs of
// Plans whose `scope:` allowlists claim a common file. Deterministic + conservative; these are DECLARED
// (un-run) overlaps, so they're POTENTIAL clobbers to review, not confirmed verdicts. Returns the count.
export function planCheck(cfg, dir, reconcile = false) {
  const phases = discoverPhases(dir).map((file) => ({ file, plan: parsePlan(file) }))
  if (!phases.length) fail(`No phase plans (*.md) in ${dir}.\n${PHASE_HINT}`)
  const { conflicts, broad } = detectScopeConflicts(phases)
  for (const b of broad) {
    log(`⚠ ${basename(b.file)}: broad scope (${b.globs.join(', ')}) — narrow it so conflict detection stays useful.`)
  }
  if (!conflicts.length) {
    log(`✓ no scope conflicts across ${phases.length} plan(s).`)
    return 0
  }
  const byFile = new Map(phases.map((p) => [p.file, p.plan]))
  log(`\n⚠ ${conflicts.length} scope overlap(s) — plans that claim a common file:`)
  for (const c of conflicts) {
    log(`  • ${basename(c.a)} ↔ ${basename(c.b)}  (${[...new Set(c.globs.flat())].join(', ')})`)
    // --reconcile: the ONE LLM judgment call, only on a detected conflict — does this pair truly contend?
    if (reconcile) {
      const v = runReconcile(cfg, byFile.get(c.a), byFile.get(c.b))
      log(`      → ${v.resolution.toUpperCase()}${v.which && v.which !== 'both' ? ` ${v.which}` : ''}: ${v.why}`)
    }
  }
  if (reconcile) {
    log('\n  Advisory only — Temper never edits or drops a Plan for you. Resolve the queue by hand.')
  } else {
    log('\n  POTENTIAL conflicts (declared scope overlap), not confirmed — review them, or re-run with')
    log('  --reconcile for an advisory drop/merge/consult suggestion on each. The per-phase gates still')
    log('  catch a real clobber at the failing test.')
  }
  return conflicts.length
}

// `temper tasks <file> [--dir <queue>]` — ingest a plain-text list of tasks (one per line; blank lines and
// `#` comments ignored), draft a numbered, scoped Plan for each into the queue dir (read-only — drafting
// never edits the repo), and immediately surface any scope conflicts. Composition of two existing
// primitives: per-line draftPlan + the deterministic detector. Decomposition stays a human job: every
// drafted Plan is reviewed/approved before `temper overnight`.
export function runTasks(cfg, taskFile, dir) {
  if (!taskFile || !existsSync(taskFile)) fail('Usage: temper tasks <file>  (a plain-text list of tasks, one per line)')
  const tasks = readFileSync(taskFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (!tasks.length) fail(`No tasks in ${taskFile} (one task per line; blank lines and # comments are ignored).`)
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir).filter((f) => f.endsWith('.md'))
  if (existing.length) fail(`${dir} already holds ${existing.length} plan(s) — clear it or pass a fresh --dir, so drafting can't clobber a queue in progress.`)
  log(`drafting ${tasks.length} task(s) into ${dir} (read-only; review + approve each before running)…\n`)
  const phases = []
  tasks.forEach((task, i) => {
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task'
    const file = join(dir, `${String(i + 1).padStart(2, '0')}-${slug}.md`)
    log(`▶ ${i + 1}/${tasks.length}: ${task}`)
    const planText = draftPlan(cfg, task)
    writeFileSync(file, planText)
    const fm = planText.match(/^---\n([\s\S]*?)\n---/)
    if (fm && /\bscope:/.test(fm[1]) && /^\s*-\s+\S/m.test(fm[1])) {
      phases.push({ file, plan: parsePlan(file) })
      log(`  ✓ ${basename(file)}`)
    } else {
      log(`  ⚠ ${basename(file)} — draft is missing a scope/frontmatter block; edit it into shape before running.`)
    }
  })
  log(`\n✓ drafted ${phases.length}/${tasks.length} Plan(s) into ${dir}. REVIEW + APPROVE each (scope + spec + acceptance), then \`temper overnight ${dir}\`.`)
  const { conflicts, broad } = detectScopeConflicts(phases)
  for (const b of broad) log(`⚠ ${basename(b.file)}: broad scope (${b.globs.join(', ')}) — narrow it.`)
  if (conflicts.length) {
    log(`\n⚠ ${conflicts.length} scope overlap(s) to resolve before running:`)
    for (const c of conflicts) log(`  • ${basename(c.a)} ↔ ${basename(c.b)}  (${[...new Set(c.globs.flat())].join(', ')})`)
  } else if (phases.length > 1) {
    log('✓ no scope conflicts across the drafted plans.')
  }
}

// `temper tasks add "<task>" [--dir <queue>] [--reconcile]` — draft ONE new task into an existing queue and
// classify its overlap with each existing plan by LEDGER status: a COMMITTED phase ⇒ the new task builds on
// done work (a note); a PENDING (queued / not-yet-committed) phase ⇒ a planned collision to review (advisory,
// plus the reconcile suggestion with --reconcile). Status is DERIVED from the ledger (no stored reservation
// or lock — adding to the dir mid-run is harmless: the running queue snapshotted its phases at start, so a
// new task simply waits for the next run/resume).
export function addTask(cfg, task, dir, reconcile = false) {
  if (!task) fail('Usage: temper tasks add "<task>" [--dir <queue>]')
  if (!existsSync(dir)) fail(`No queue at ${dir} — create one with \`temper tasks <file>\` first.`)
  const existing = discoverPhases(dir).map((file) => ({ file, plan: parsePlan(file) }))
  const committed = new Set(loadLedger(cfg.progressFile).filter((e) => e.status === 'committed').map((e) => e.file))
  const nums = existing.map((p) => parseInt(basename(p.file), 10)).filter((n) => !Number.isNaN(n))
  const next = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task'
  const file = join(dir, `${next}-${slug}.md`)
  log(`drafting: ${task}\n`)
  const planText = draftPlan(cfg, task)
  writeFileSync(file, planText)
  const fm = planText.match(/^---\n([\s\S]*?)\n---/)
  if (!(fm && /\bscope:/.test(fm[1]) && /^\s*-\s+\S/m.test(fm[1]))) {
    return log(`⚠ ${basename(file)} — draft is missing a scope/frontmatter block; edit it into shape before running.`)
  }
  const plan = parsePlan(file)
  log(`✓ added ${basename(file)} (scope: ${plan.scope.join(', ')})`)
  const hits = existing.map((p) => ({ p, globs: scopesOverlap(plan.scope, p.plan.scope) })).filter((x) => x.globs.length)
  if (!hits.length) return log('✓ no scope overlap with the existing queue.')
  log(`\n⚠ overlaps with ${hits.length} existing plan(s):`)
  for (const { p, globs } of hits) {
    const done = committed.has(p.file)
    log(`  • ${basename(p.file)} [${done ? 'DONE — your task builds on committed work' : 'QUEUED — a planned collision; review'}]  (${[...new Set(globs.flat())].join(', ')})`)
    if (reconcile && !done) {
      const v = runReconcile(cfg, plan, p.plan)
      log(`      → ${v.resolution.toUpperCase()}${v.which && v.which !== 'both' ? ` ${v.which}` : ''}: ${v.why}`)
    }
  }
}
