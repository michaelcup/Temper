// The entropy-gated loop: runPlan drives the engine and the deterministic gates, returning a
// structured verdict; runLoop is the thin Mode-A wrapper that maps the verdict to an exit code.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, runArgs, log, git, requireCleanRepo, acquireLock, stripAnsi, normalizeFinding, notify, commandBinary, resolvesOnPath } from './sh.mjs'
import { changedFiles, inScope, protectionViolations, addedSuppressions, fallowUnreachableNewFiles, survivingReferences } from './gates.mjs'
import { callCli, enginePrompt, runCritic, runCompletenessCheck } from './engine.mjs'
import { validatePlan } from './plan.mjs'

// The stable failure categories a re-prompt loop can get stuck on (R2). The category,
// not the (drifting) message text, is the signal that the loop is not converging.
const ALL_DOMAINS = ['no-changes', 'scope', 'protected', 'fallow-audit', 'suppression', 'acceptance', 'removal', 'completeness']

// Run the deterministic gates against the working tree, in cheapest-first order. Returns the
// violation messages plus, per failure-domain, the head message (for telemetry) and a NORMALIZED
// message (for unchanged-finding detection), and the gated `changed` file set the commit will use.
function runGates(cfg, plan, baseSha) {
  const violations = []
  const fired = new Map() // failure-domain -> head message, this iteration only
  const firedFull = new Map() // failure-domain -> NORMALIZED message, for unchanged-finding detection
  const flag = (domain, msg) => {
    violations.push(msg)
    fired.set(domain, msg.split('\n')[0].slice(0, 160))
    firedFull.set(domain, normalizeFinding(msg)) // normalized so volatile timings (fallow) don't defeat the fast-bail
  }

  let deadNewFiles = []
  let outOfScope = []
  const changed = changedFiles(baseSha)
  if (!changed.length) {
    flag('no-changes', 'Your previous attempt made no file changes. Implement the task by editing files within scope.')
  } else {
    outOfScope = changed.filter((f) => !inScope(f, plan.scope))
    if (outOfScope.length) flag('scope', `Files changed outside the allowed scope: ${outOfScope.join(', ')}. Revert them. If the task genuinely needs them, do NOT edit them: say which one blocks you, and the human will add it to the Plan's scope.`)

    for (const pv of protectionViolations(baseSha, plan, changed)) flag('protected', pv)

    if (cfg.entropyGateEnabled) {
      const entropyCmd = cfg.entropyCommand.replaceAll('{base}', baseSha)
      log(`• gate: ${entropyCmd}…`)
      const audit = run(entropyCmd, { env: { FALLOW_AUDIT_BASE: baseSha } })
      if (audit.code !== 0) {
        const out = stripAnsi(audit.out).trim()
        deadNewFiles = fallowUnreachableNewFiles(out)
        flag('fallow-audit', `entropy gate failed — you introduced new entropy:\n${out}${deadNewFiles.length ? dynamicLoadHint(deadNewFiles) : ''}`)
      }
    }

    if (cfg.forbidSuppressions) {
      const supp = addedSuppressions(baseSha)
      if (supp.length) {
        flag('suppression', `You silenced a check instead of fixing it (suppression is not resolution). Remove these and fix the root cause: ${supp.join('; ')}`)
      }
    }

    if (plan.acceptance) {
      log(`• acceptance: ${plan.acceptance}`)
      const a = run(plan.acceptance)
      if (a.code !== 0) flag('acceptance', `Acceptance check failed (\`${plan.acceptance}\`):\n${stripAnsi(a.out).trim().slice(-1500)}`)
    }

    // Removal-completeness gate: literal identifiers/paths the Plan declared as `removes:` must not survive
    // anywhere (the deletion-side mirror of scope). A cheap, deterministic git-grep that catches the string
    // references in contracts/specs/docs that typecheck and tests cannot see.
    if (plan.removes.length) {
      const leftovers = survivingReferences(plan.removes, plan.removesRoot.length ? plan.removesRoot : ['.'])
      if (leftovers.length) {
        flag('removal', `These identifiers were declared removed (\`removes:\`) but still appear — delete every reference:\n${leftovers.map((l) => `  • "${l.term}" in ${l.files.join(', ')}`).join('\n')}`)
      }
    }

    // Diff-vs-Plan completeness — only when the cheap gates already passed (don't waste a model call).
    if (cfg.checkCompleteness && violations.length === 0) {
      log('• completeness: does the diff implement the Plan?')
      const comp = runCompletenessCheck(cfg, plan, baseSha)
      if (!comp.complete) flag('completeness', `The change does not fully implement the Plan — still missing: ${comp.missing}. Complete it.`)
    }
  }
  return { violations, fired, firedFull, changed, deadNewFiles, outOfScope }
}

// The actionable fix for a fallow dynamic-load false-positive, handed to the engine on re-prompt: a
// new file fallow can't see as reachable is either genuinely dead (remove it) or dynamically loaded
// (needs a .fallowrc.json entry — which is out of scope here, so stop). This keeps the engine from
// the no-win cascade the dogfood caught: trying to add lint config, getting it scope-rejected, reverting.
function dynamicLoadHint(files) {
  const isAre = files.length > 1 ? 'are NEW files' : 'is a NEW file'
  return (
    `\n\nNOTE: ${files.join(', ')} ${isAre} this change added that fallow reports as unreachable. Resolve it HONESTLY — do NOT silence the linter:\n` +
    '  • If genuinely unused, remove it (it may not belong in this Plan).\n' +
    '  • If it is loaded DYNAMICALLY (a fixture, plugin, or dynamic import) and must stay, it needs a `.fallowrc.json` "entry" glob — but editing lint config is OUT OF SCOPE here and the scope/suppression gates will reject it. In that case STOP and let a human add the entry.'
  )
}

// Track, per failure-domain, the consecutive-fail streak and how many of those were the IDENTICAL
// finding (a stronger "the engine can't fix it" signal than the domain merely recurring).
function updateStreaks(domainStreaks, repeatStreaks, prevFiredFull, fired, firedFull) {
  for (const d of ALL_DOMAINS) {
    domainStreaks.set(d, fired.has(d) ? (domainStreaks.get(d) ?? 0) + 1 : 0)
    if (fired.has(d) && firedFull.get(d) === prevFiredFull.get(d)) repeatStreaks.set(d, (repeatStreaks.get(d) ?? 0) + 1)
    else repeatStreaks.set(d, fired.has(d) ? 1 : 0)
  }
}

// Commit ONLY the gated files (the `changed` set the gates validated) — NEVER `git add -A`, which
// would sweep in any ungated file a held-out command (or anything else) dropped in the tree.
function commitGatedChange(cfg, plan, changed) {
  const before = git('rev-parse HEAD')
  const msgFile = join(tmpdir(), `temper-msg-${process.pid}.txt`)
  writeFileSync(msgFile, `${cfg.commitPrefix} ${plan.title}\n`)
  const add = runArgs('git', ['add', '--', ...changed]) // argv array, NO shell: an engine-named file can't inject
  const commit = run(`git commit -F "${msgFile}"`)
  const after = git('rev-parse HEAD')
  // A rejecting git hook (pre-commit/commit-msg) leaves HEAD UNMOVED while run() swallows the non-zero exit.
  // NEVER report a phantom commit: it would record a false-green in the Mode B ledger, build the next phase
  // on the wrong base, and the dirty tree is never re-caught (requireCleanRepo runs once, at queue start).
  if (add.code !== 0 || commit.code !== 0 || after === before) {
    return { ok: false, error: stripAnsi(commit.out || add.out || 'commit did not advance HEAD').trim() }
  }
  return { ok: true, sha: after }
}

// A fallow dynamic-load false-positive can't be fixed by re-prompting (the file IS used; fallow just
// can't see it), and the engine's attempts to work around it produce DIFFERENT findings each iteration
// (fallow → out-of-scope config → fallow), which evades the per-domain stuck/unchanged bails. So we
// track the flagged FILE across NON-consecutive iterations and escalate it directly, with the fix.
function escalateDeadFile(files, baseSha, runStart, elapsed) {
  log(`\n■ STUCK — fallow keeps reporting new file(s) as unreachable dead code: ${files.join(', ')}.`)
  log('  This is the dynamic-load false-positive: the file is used, but not via a static import fallow')
  log('  can follow (a fixture / plugin / dynamic import), so the engine cannot satisfy it in scope.')
  log('  → If the file belongs, add a glob for it to .fallowrc.json "entry" and re-run; if it is truly')
  log('    unused, drop it from the Plan.')
  log('  → `temper explain fallow-audit` covers this gate in more detail.')
  log(`\n  Nothing committed. Review the working tree; diff against ${baseSha.slice(0, 9)}.`)
  log(`⏱ total ${elapsed(runStart)}`)
}

// R2: a failure-domain that fails N iterations in a row is not converging — surface
// a structured summary to the human instead of silently burning the iteration budget.
function escalateStuck(domain, streak, history, baseSha, runStart, elapsed, outOfScopeFiles = []) {
  log(`\n■ STUCK — failure-domain "${domain}" failed ${streak} iterations in a row. Escalating instead of burning iterations.`)
  log('  This is not converging; it needs your judgment — the plan, the gate, or the task may be wrong.')
  log(`  → \`temper explain ${domain}\` says what this gate checks and how to clear it.`)
  if (domain === 'no-changes') log("  → no edits usually means the engine isn't editing headlessly — run `temper doctor`.")
  if (domain === 'scope') {
    log("  → the engine kept editing files outside the Plan scope. If they genuinely need the change, add them to the Plan's scope list and re-run.")
    const entries = [...new Set(outOfScopeFiles)].sort()
    if (entries.length) {
      log('  files the change needed but the Plan did not allow:')
      for (const f of entries) log(`    - "${f}"`)
    }
  }
  if (domain === 'acceptance') log('  → if the SAME error recurred while the code changed, the acceptance COMMAND is likely wrong (not the code) — run it against the working tree to check.')
  for (const h of history.filter((h) => h.msgs[domain])) {
    log(`   iter ${h.i} (${(h.ms / 1000).toFixed(1)}s): ${h.msgs[domain]}`)
  }
  log(`\n  Nothing committed. Review the working tree; diff against ${baseSha.slice(0, 9)}.`)
  log(`⏱ total ${elapsed(runStart)}`)
}

// Runs one Plan from `baseSha`, RETURNING a structured verdict instead of exiting.
// This is the reusable core shared by Mode A (runLoop) and phase sequencing (runPhases)
// and is what the eval harness scores. It commits on success; it never calls process.exit.
export function runPlan(cfg, plan, { baseSha }) {
  log(`▶ "${plan.title}"  base ${baseSha.slice(0, 9)}  (≤ ${cfg.maxIterations} iterations)\n`)
  const runStart = performance.now()
  const elapsed = (since) => `${((performance.now() - since) / 1000).toFixed(1)}s`

  // The entropy gate (dead code / duplication / complexity) is the deterministic check on what the
  // change introduced. It is PLUGGABLE (cfg.entropyGate, default fallow for JS/TS) and OPTIONAL: if its
  // command isn't installed, run the other gates and skip it (noted once) rather than failing the loop
  // on a "command not found". Detected once, reused across phases. The eval's stub command resolves, so
  // fixtures still exercise the gate.
  if (cfg.entropyGateEnabled === undefined) {
    // --production-dupes excludes test/story/dev files from the DUPLICATION check. Test files are idiomatically
    // repetitive (per-test setup boilerplate), so adding a test would otherwise count as new duplication and
    // trip the new-only gate (a dogfood caught this). Dead-code and complexity still cover test files.
    cfg.entropyCommand = cfg.entropyGate || `${cfg.fallowCommand} audit --gate new-only --production-dupes`
    cfg.entropyGateEnabled = resolvesOnPath(commandBinary(cfg.entropyCommand))
    if (!cfg.entropyGateEnabled) {
      log(`⚠ entropy gate not runnable (\`${commandBinary(cfg.entropyCommand)}\`) — skipping the dead-code/duplication gate.`)
      log('  The loop still gates on scope, protected regions, suppression, your tests, and the reuse-critic.')
      log('  Install fallow (`npm i -g fallow`) for JS/TS, or set `entropyGate` to your language\'s tool.\n')
    }
  }

  const domainStreaks = new Map()
  const repeatStreaks = new Map() // consecutive iterations a domain fired with the IDENTICAL finding
  const deadFileHits = new Map() // new file -> TOTAL iterations fallow flagged it unreachable (non-resetting)
  const outOfScopeSeen = new Set() // UNION of out-of-scope files across iterations, for the scope-escalation hint
  let prevFiredFull = new Map()
  const history = []
  let prevViolations = []
  for (let i = 1; i <= cfg.maxIterations; i++) {
    const iterStart = performance.now()
    log(`── iteration ${i} ──`)
    log('• engine: implementing…')
    const eng = callCli(cfg.engineCommand, enginePrompt(plan, prevViolations), cfg)

    const { violations, fired, firedFull, changed, deadNewFiles, outOfScope } = runGates(cfg, plan, baseSha)
    for (const f of outOfScope) outOfScopeSeen.add(f)

    // An engine call that exits non-zero AND changed nothing is almost always infra (auth 401, network, a
    // broken engine command), not the model declining to edit. Surface its OWN output so this self-diagnoses
    // instead of masquerading as a no-changes violation that burns iterations to a misleading escalation.
    if (eng.code !== 0 && !changed.length) {
      const out = stripAnsi(eng.out || '').trim()
      log(`\n■ engine command failed (exit ${eng.code}) and changed nothing — usually auth or a network/CLI error, not a gate.`)
      if (out) log(out.split('\n').slice(-8).map((l) => '    ' + l).join('\n'))
      log(`  Command: ${cfg.engineCommand}`)
      log('  If it is auth, run from a plain terminal where `claude` / `codex` hold your subscription, then `temper doctor`.')
      log(`⏱ iteration ${i} took ${elapsed(iterStart)}  •  total ${elapsed(runStart)}`)
      return { status: 'error', sha: baseSha, iterations: i, seconds: elapsed(runStart), violations: [`engine command failed (exit ${eng.code})`] }
    }

    // R2 telemetry: per-iteration timing + which domains fired, plus the consecutive-fail streaks.
    history.push({ i, ms: performance.now() - iterStart, msgs: Object.fromEntries(fired) })
    updateStreaks(domainStreaks, repeatStreaks, prevFiredFull, fired, firedFull)
    for (const f of deadNewFiles) deadFileHits.set(f, (deadFileHits.get(f) ?? 0) + 1)
    prevFiredFull = firedFull

    if (violations.length) {
      log(`✗ ${violations.length} violation(s):`)
      // Show the FULL captured finding (capped), indented — so the human can diagnose without
      // re-running the gate by hand (Anthropic: gate errors must be specific + actionable).
      for (const v of violations) {
        const capped = v.length > 1200 ? v.slice(0, 1200).trimEnd() + '\n… (truncated)' : v
        log(capped.split('\n').map((line, idx) => (idx === 0 ? `   • ${line}` : `     ${line}`)).join('\n'))
      }
      log('  → re-prompting\n')
      log(`⏱ iteration ${i} took ${elapsed(iterStart)}\n`)
      // A fallow dynamic-load false-positive on a NEW file can't be fixed in scope — escalate it
      // directly (tracked across non-consecutive iterations, so the work-around cascade can't evade it).
      const stuckFiles = [...deadFileHits.keys()].filter((f) => deadFileHits.get(f) >= cfg.maxUnchangedRetries)
      if (stuckFiles.length) {
        escalateDeadFile(stuckFiles, baseSha, runStart, elapsed)
        return { status: 'escalated', sha: baseSha, iterations: i, seconds: elapsed(runStart), violations, stuckDomain: 'fallow-audit' }
      }
      // R2: a domain that recurs is not converging — escalate, don't burn iterations. Bail SOONER
      // when the SAME finding recurs unchanged (the engine made zero progress on an identical finding).
      const stuck = [...fired.keys()].find((d) => domainStreaks.get(d) >= cfg.maxDomainRetries || repeatStreaks.get(d) >= cfg.maxUnchangedRetries)
      if (stuck) {
        escalateStuck(stuck, domainStreaks.get(stuck), history, baseSha, runStart, elapsed, [...outOfScopeSeen])
        return { status: 'escalated', sha: baseSha, iterations: i, seconds: elapsed(runStart), violations, stuckDomain: stuck }
      }
      prevViolations = violations
      continue
    }

    // Capture the critic verdict so it reaches the verdict (and the morning report). A warn-level
    // flag on a phase that still COMMITS otherwise only ever hits stdout, so a possible duplication
    // the loop let through would be invisible the morning after — the proven review bottleneck.
    let critic = null
    if (cfg.criticMode !== 'off') {
      const c = runCritic(cfg, baseSha)
      if (c.flagged) {
        log(`⚠ reuse-critic flagged (${c.confidence}): ${c.summary}`)
        critic = { flagged: true, confidence: c.confidence, summary: c.summary }
        // Duplication-of-intent is an intent call — escalate, don't auto-fix.
        if (cfg.criticMode === 'halt' && c.confidence === 'high') {
          log('\n■ HALT — possible duplication-of-intent needs your decision. Nothing committed; review the diff.')
          log('  → `temper explain halted`')
          log(`⏱ iteration ${i} took ${elapsed(iterStart)}  •  total ${elapsed(runStart)}`)
          return { status: 'halted', sha: baseSha, iterations: i, seconds: elapsed(runStart), violations, critic }
        }
      }
    }

    // Held-out check: the agent never saw this, so passing the visible gates but failing
    // here means the gates were gamed or insufficient. One-shot: escalate, never re-prompt
    // (the research warns iterating against a hidden check just teaches gaming).
    if (plan.heldout) {
      log(`• held-out check: ${plan.heldout}`) // announce the moat ran (it never reaches the engine — temper's stdout is the user's)
      const h = run(plan.heldout)
      if (h.code === 126 || h.code === 127) {
        // Command-not-found / not-executable is an infra error, NOT gaming — don't mislabel it.
        log(`\n■ held-out command could not execute (exit ${h.code}): \`${plan.heldout}\`. Fix the command.`)
        return { status: 'error', sha: baseSha, iterations: i, seconds: elapsed(runStart), violations: [`held-out command not executable: ${plan.heldout}`] }
      }
      if (h.code !== 0) {
        const out = stripAnsi(h.out || '').trim()
        log(`\n■ GAMED — work passed every visible gate but FAILED the held-out check \`${plan.heldout}\`.`)
        if (out) log(out.split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'))
        log('  The agent never saw this check; the visible gates were gamed or insufficient. Nothing committed; review.')
        log('  → If that output is a command/shell error (not a check failure), your held-out command itself is broken — run it by hand.')
        log('  → `temper explain gamed`')
        log(`⏱ iteration ${i} took ${elapsed(iterStart)}  •  total ${elapsed(runStart)}`)
        return { status: 'gamed', sha: baseSha, iterations: i, seconds: elapsed(runStart), violations: [`held-out check failed: ${plan.heldout}`] }
      }
    }

    const c = commitGatedChange(cfg, plan, changed)
    if (!c.ok) {
      log(`\n■ commit FAILED — a git hook likely rejected it. Nothing committed (no false green).`)
      log(c.error.split('\n').slice(0, 4).map((l) => '    ' + l).join('\n'))
      return { status: 'error', sha: baseSha, iterations: i, seconds: elapsed(runStart), violations: [`commit failed: ${c.error.split('\n')[0]}`] }
    }
    log(`\n✓ gate green — committed "${cfg.commitPrefix} ${plan.title}"`)
    log(`⏱ iteration ${i} took ${elapsed(iterStart)}  •  total ${elapsed(runStart)}`)
    return { status: 'committed', sha: c.sha, iterations: i, seconds: elapsed(runStart), violations: [], critic, heldout: !!plan.heldout }
  }

  log(`\n■ Reached ${cfg.maxIterations} iterations without a green gate (no single failure-domain stuck). Nothing committed; review the working tree.`)
  log('  → `temper explain maxed`')
  log(`⏱ total ${elapsed(runStart)}`)
  return { status: 'maxed', sha: baseSha, iterations: cfg.maxIterations, seconds: elapsed(runStart), violations: prevViolations }
}

// Mode A: one Plan to a green gate. Thin wrapper mapping the verdict to exit codes.
export function runLoop(cfg, plan) {
  validatePlan(plan)
  requireCleanRepo()
  acquireLock()
  const v = runPlan(cfg, plan, { baseSha: git('rev-parse HEAD') })
  notify(cfg, v.status, { summary: `temper run "${plan.title}": ${v.status}` })
  if (v.status === 'committed') return
  // Mode A leaves the failed attempt in the working tree (overnight resets on exit), so tell the user how to
  // discard it; otherwise the next `temper run` aborts on the leftover dirty tree.
  log('\nTo discard this attempt and return to a clean base (after reviewing the diff): git restore . && git clean -fd')
  if (v.status === 'halted') process.exit(2)
  if (v.status === 'escalated') process.exit(4)
  if (v.status === 'gamed') process.exit(5)
  if (v.status === 'error') process.exit(1)
  process.exit(3)
}
