#!/usr/bin/env node
// Temper — a thin, engine-agnostic, entropy-gated loop runner for AI coding.
//
// Runs in YOUR terminal, drives a subscription CLI (claude / codex), and gates
// every iteration with `fallow audit --gate new-only` so the loop can only
// commit work that introduced no new entropy. See SPEC.md and docs/adr/ for the
// reasoning. Deterministic plumbing only — the engine and critic are the sole
// LLM steps (ADR-0002).
//
// This file is the CLI surface: argument parsing, the `init`/`doctor` commands,
// and the command dispatch. The machinery lives in src/ (sh, config, gates,
// engine, plan, loop, phases, eval).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, log, fail, requireCleanRepo, commandBinary, resolvesOnPath } from '../src/sh.mjs'
import { loadConfig, resolveEngines, applyMaxIterations, applyQueueBudget, hasFallowConfig, projectHasTests, DEFAULTS } from '../src/config.mjs'
import { parsePlan, runPlanDraft } from '../src/plan.mjs'
import { runLoop } from '../src/loop.mjs'
import { runPhases, status } from '../src/phases.mjs'
import { runEval } from '../src/eval.mjs'

function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[name] = true
      else {
        flags[name] = next
        i++
      }
    } else positionals.push(argv[i])
  }
  return { positionals, flags }
}

// Ensure each Temper working artifact is gitignored so it never dirties the tree or pollutes the
// repo. Creates .gitignore if absent, appends any missing entry, no-ops on entries already present
// (matching a bare or trailing-slash form) — idempotent. Returns the labels actually added.
function ensureGitignored(gitignorePath, entries) {
  const created = !existsSync(gitignorePath)
  const existing = created ? '' : readFileSync(gitignorePath, 'utf8')
  const present = new Set(existing.split('\n').map((l) => l.trim().replace(/\/$/, '')))
  const missing = entries.filter((e) => !present.has(e.replace(/\/$/, '')))
  if (!missing.length) return []
  writeFileSync(gitignorePath, (existing ? existing.replace(/\n*$/, '\n') : '') + missing.map((e) => e + '\n').join(''))
  return created ? ['.gitignore'] : missing.map((e) => `${e} (gitignore)`)
}

// The entry-point-aware fallow config that stops the dead-code gate from flagging new exports/tests as
// unreachable "dead code". Shared by `temper init` and the `run` preflight. Writes only when no fallow
// config exists; returns true if it wrote one. The dir globs (spec/**, e2e/**, …) treat everything under
// those top-level dirs as an entry — fine for the usual test-only convention; tighten the list if you
// keep product source there. Genuinely-dead source under src/ is still flagged (entries don't swallow it).
function scaffoldFallowConfig() {
  if (hasFallowConfig()) return false
  const fallowrc = {
    entry: [
      '**/*.{test,spec}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}',
      '**/*.{cy,e2e}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}', // cypress / playwright
      '**/*_{test,spec}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}', // rspec / go-style suffix
      'test/**',
      'tests/**',
      '__tests__/**',
      'spec/**',
      'e2e/**',
      'cypress/**',
      'playwright/**',
    ],
  }
  writeFileSync(join(process.cwd(), '.fallowrc.json'), JSON.stringify(fallowrc, null, 2) + '\n')
  return true
}

// Kill the #1 onboarding footgun before it costs a ~20-minute escalation: a cold `run` / `run-phases`
// on a project that HAS tests but NO fallow config would have the dead-code gate flag new exports and
// test files as unreachable, so a new exported function escalates instead of committing. Scaffold the
// entry-aware config (the same one `temper init` writes) and stop with the one-command next step.
function preflightOnboarding() {
  if (hasFallowConfig() || !projectHasTests()) return
  scaffoldFallowConfig()
  fail(
    'This project has tests but no fallow config, so the dead-code gate would flag new exports and\n' +
      'test files as unreachable "dead code" — a new exported function would escalate instead of\n' +
      'committing (the #1 onboarding footgun). I scaffolded `.fallowrc.json` for you.\n' +
      '→ Commit it, then re-run:  git add .fallowrc.json && git commit -m "chore: add fallow config"',
  )
}

// The user-tunable keys `temper init` writes into temper.config.json — values pulled from DEFAULTS so
// they can't drift. The generated file IS the config-discovery surface, so every knob (criticEngine,
// the Mode B budget, notifyCommand) is visible to edit in place. `engines` is omitted: the defaults
// work, and the README shows how to add a preset.
const STARTER_KEYS = ['engine', 'criticEngine', 'fallowCommand', 'maxIterations', 'maxDomainRetries', 'maxUnchangedRetries', 'criticMode', 'checkCompleteness', 'commitPrefix', 'maxQueueSeconds', 'maxQueueIterations', 'notifyCommand']

// `temper init` — scaffold a project so the dead-code gate doesn't false-positive on new exports/tests.
// fallow already treats package.json exports/main/bin as entry points (the library API); this declares
// TEST files as entry points too, so adding a new exported function with a test commits, not escalates.
function runInit() {
  const cwd = process.cwd()
  const wrote = []
  const configs = []
  if (scaffoldFallowConfig()) {
    wrote.push('.fallowrc.json')
    configs.push('.fallowrc.json')
  }
  if (!existsSync(join(cwd, 'temper.config.json'))) {
    const starter = Object.fromEntries(STARTER_KEYS.map((k) => [k, DEFAULTS[k]]))
    writeFileSync(join(cwd, 'temper.config.json'), JSON.stringify(starter, null, 2) + '\n')
    wrote.push('temper.config.json')
    configs.push('temper.config.json')
  }
  // Gitignore Temper's working artifacts so they never dirty the tree (a friction hit repeatedly when
  // dogfooding): the runtime dir (.temper/ — ledger/report) and the drafted PLAN.md (regenerated each run).
  wrote.push(...ensureGitignored(join(cwd, '.gitignore'), ['.temper/', 'PLAN.md']))
  log(wrote.length ? `✓ wrote ${wrote.join(', ')}` : '✓ already configured (temper.config.json + a fallow config both present)')
  log('\nNext:')
  log('  • Make sure your public API is in package.json "exports"/"main"/"bin" (fallow treats those')
  log('    as entry points), or add globs to .fallowrc.json "entry".')
  log('  • Set "criticEngine" to the OTHER engine in temper.config.json for cross-model review.')
  logCommitHint(configs)
}

// The config files init writes (.fallowrc.json / temper.config.json) are NOT gitignored — they're meant
// to be committed. Left untracked, they dirty the tree and the next `temper run` aborts on requireCleanRepo.
// Nudge the user to commit whatever was just scaffolded; stay silent when init wrote no config files.
function logCommitHint(configs) {
  if (!configs.length) return
  const plural = configs.length > 1 ? 's' : ''
  log(`  • Commit the new config file${plural} (${configs.join(', ')}) — the next \`temper run\` requires a clean repo and will abort on these untracked files.`)
}

function doctor(cfg) {
  // Check the engine/critic BINARY resolves (the most likely first-run failure), not just git+fallow.
  // Best-effort: the binary is on PATH — not that auth works (that surfaces on the first real call).
  const engineBin = commandBinary(cfg.engineCommand)
  const criticBin = commandBinary(cfg.criticCommand)
  const checks = [
    ['inside a git repository', run('git rev-parse --is-inside-work-tree').code === 0],
    [`fallow available — optional (\`${cfg.fallowCommand}\`)`, run(`${cfg.fallowCommand} --version`).code === 0],
    [`engine binary on PATH (\`${engineBin}\`)`, resolvesOnPath(engineBin)],
  ]
  if (criticBin && criticBin !== engineBin) checks.push([`critic binary on PATH (\`${criticBin}\`)`, resolvesOnPath(criticBin)])
  for (const [name, ok] of checks) log(`${ok ? '✓' : '✗'} ${name}`)
  // fallow is OPTIONAL: missing → the entropy gate is skipped (note it). Present + tests but no config →
  // the #1 footgun (the dead-code gate flags new exports/tests as "unused"); point to `temper init`.
  if (!resolvesOnPath(commandBinary(cfg.fallowCommand))) {
    log('\nℹ fallow is optional. Without it Temper skips the dead-code/duplication gate (it still gates on')
    log('  scope, protected regions, suppression, your tests, and the reuse-critic). For the full entropy')
    log('  gate:  npm i -g fallow')
  } else if (!hasFallowConfig() && projectHasTests()) {
    log('\n⚠ No fallow config, but this project has tests. fallow\'s dead-code gate flags new')
    log('  exports / test files as "unused" without entry-point config — a new exported function')
    log('  would escalate instead of committing. Run `temper init` to scaffold one.')
  }
  // Running inside a nested / host-managed Claude session is the other classic first-run failure: the
  // child `claude -p` Temper spawns can't reach your subscription auth and 401s (ADR-0003).
  if (process.env.CLAUDE_CODE_CHILD_SESSION) {
    log('\n⚠ This looks like a nested / host-managed Claude session. Temper drives `claude -p` as a child')
    log('  process, which needs your terminal\'s real subscription auth and will likely 401 here.')
    log('  Run Temper from a plain terminal (ADR-0003).')
  }
  log(`\nengine (${cfg.engineName}): ${cfg.engineCommand}`)
  log(`critic (${cfg.criticName}): ${cfg.criticCommand}`)
  log(
    '\nVerify the engine command edits files headlessly, and that the CLIs use your\n' +
      "terminal's real subscription auth — Temper can't run inside a hosted Claude session.",
  )
}

// `temper explain <gate>` — a terse, human-facing what/why/fix for each gate failure-domain and each
// terminal verdict, so a `■ STUCK` or a non-zero exit doesn't send you to the source to decode it.
// Deterministic text, zero deps; the verbose, agent-facing finding still lands on the re-prompt.
const EXPLAIN = {
  'no-changes': ['No-changes gate', 'The engine produced no file edits.', 'Usually an engine/auth problem — confirm the engine command edits files headlessly (`temper doctor`).'],
  scope: ['Scope gate', "The change touched files outside the Plan's `scope:` allowlist.", 'Keep the work to the listed files, or widen `scope:` in the Plan if the extra files are genuinely needed.'],
  protected: ['Protected-region gate', 'The change edited inside a `temper:protect-start … temper:protect-end` region.', 'Leave the locked region alone, or remove the sentinels if it should no longer be protected.'],
  'fallow-audit': ['Dead-code / duplication / complexity gate (fallow)', 'The change introduced new entropy: unreachable code, a duplicate of something that already exists, or rising complexity.', 'Reuse the existing code, delete the dead code, or simplify. If a NEW dynamically-loaded file is wrongly flagged unreachable, add a glob to `.fallowrc.json` "entry" (or run `temper init` if you have no fallow config yet).'],
  suppression: ['Suppression guard', 'The change ADDED a suppression (fallow-ignore, eslint-disable, @ts-ignore, a skipped test) — silencing a check is not fixing it.', 'Remove the directive and fix the underlying finding.'],
  acceptance: ['Acceptance gate', "The Plan's `acceptance:` command exited non-zero (tests/build/typecheck failed).", 'Make the acceptance command pass — run it yourself to see the failure.'],
  completeness: ['Completeness check (opt-in)', 'An LLM check judged the diff did not implement every step of the Plan.', 'Finish the missing Plan steps, or correct the Plan if a step is obsolete.'],
  halted: ['Reuse-critic halt (exit 2)', 'The critic judged the change likely re-implements something that already exists (high confidence, halt mode).', 'Review the diff against the existing code it named — reuse it, or re-run if the critic is wrong.'],
  escalated: ['Stuck-domain escalation (exit 4)', 'One gate failed repeatedly without converging, so Temper stopped instead of burning iterations.', 'The plan, the gate, or the task likely needs your judgment. Read the per-iteration findings above, then fix the root cause.'],
  gamed: ['Held-out check failed (exit 5)', 'Work passed every visible gate but failed the hidden `heldout:` check — the visible gates were gamed or too weak.', 'Review the diff and strengthen the visible gates/tests. Never re-prompt against the held-out check.'],
  maxed: ['Max iterations (exit 3)', 'Hit the iteration cap without a green gate and without a single stuck domain.', 'Review the working tree and tighten the Plan; raise --max-iterations only if the task genuinely needs more (rarely the answer).'],
  budget: ['Over budget (exit 6, Mode B)', 'The queue hit maxQueueSeconds / maxQueueIterations.', 'Re-run to continue — a resume starts a fresh budget and the ledger skips committed phases.'],
}

// Map the words the failure banners actually print (■ HALT / ■ GAMED / ■ Reached… / ■ STUCK) onto the
// EXPLAIN keys, so the obvious `temper explain HALT` from a banner resolves instead of dumping usage.
const VERDICT_ALIAS = { halt: 'halted', stuck: 'escalated', reached: 'maxed', max: 'maxed', game: 'gamed' }

function explain(gate) {
  const raw = (gate ?? '').toLowerCase()
  const key = EXPLAIN[raw] ? raw : VERDICT_ALIAS[raw] ?? raw
  const e = EXPLAIN[key]
  if (!e) {
    log('Usage: temper explain <gate>\n\nGates and verdicts:')
    for (const [k, [what]] of Object.entries(EXPLAIN)) log(`  ${k.padEnd(13)} ${what}`)
    return
  }
  const [what, why, fix] = e
  log(`${key} — ${what}\n`)
  log(`Why it fires:  ${why}`)
  log(`How to clear:  ${fix}`)
}

function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const [cmd, arg] = positionals
  const cfg = loadConfig()
  if (cmd === 'run') {
    if (!arg) fail('Usage: temper run <plan.md> [--engine <name>] [--max-iterations <n>]')
    requireCleanRepo() // before the preflight: never scaffold a config into a dirty tree
    preflightOnboarding()
    resolveEngines(cfg, flags.engine)
    applyMaxIterations(cfg, flags)
    log(`engine: ${cfg.engineName}   critic: ${cfg.criticName}\n`)
    runLoop(cfg, parsePlan(arg))
  } else if (cmd === 'plan') {
    resolveEngines(cfg, flags.engine)
    log(`drafting engine: ${cfg.criticName} (read-only)\n`)
    runPlanDraft(cfg, arg, flags.out, 'force' in flags)
  } else if (cmd === 'run-phases') {
    requireCleanRepo() // before the preflight: never scaffold a config into a dirty tree
    preflightOnboarding()
    resolveEngines(cfg, flags.engine)
    applyMaxIterations(cfg, flags)
    applyQueueBudget(cfg, flags)
    log(`engine: ${cfg.engineName}   critic: ${cfg.criticName}\n`)
    runPhases(cfg, arg ?? cfg.phaseDir, { overnight: 'overnight' in flags, branch: flags.branch })
  } else if (cmd === 'status') {
    status(cfg)
  } else if (cmd === 'init') {
    runInit()
  } else if (cmd === 'explain') {
    explain(arg)
  } else if (cmd === 'eval') {
    const r = runEval(cfg, {
      filter: typeof flags.filter === 'string' ? flags.filter : undefined,
      updateBaseline: 'update-baseline' in flags,
      force: 'force' in flags,
    })
    process.exit(r.regressions.length ? 1 : r.failed ? 2 : 0)
  } else if (cmd === 'doctor') {
    resolveEngines(cfg, flags.engine)
    doctor(cfg)
  } else {
    log(
      'Temper — entropy-gated loop runner\n\n' +
        '  temper init                                       scaffold temper.config.json + a fallow config (entry-point aware)\n' +
        '  temper plan "<task>" [--out <path>]               draft a Plan from the codebase for you to approve\n' +
        '  temper run <plan.md> [--engine <name>] [--max-iterations <n>]  run one approved Plan to a green gate\n' +
        '  temper run-phases <dir> [--overnight] [--branch b] [--max-iterations n] [--max-queue-seconds n] [--max-queue-iterations n]\n' +
        '                          run ordered phase Plans, gated per phase (resumable); --overnight = Mode B (own branch + report)\n' +
        '  temper status                                     summarize the current/last queue from the ledger\n' +
        '  temper explain <gate>                             what a gate/verdict means + how to clear it\n' +
        '  temper eval [--filter <id>] [--update-baseline]   run the golden-task regression suite\n' +
        '  temper doctor [--engine <name>]                   check prerequisites\n\n' +
        '  --overnight isolates the queue on its own branch (never main, never merged) + writes a report.\n\n' +
        'Engines live in temper.config.json (default presets: claude, codex).\n' +
        'Set "criticEngine" to a different engine for cross-model review.\n',
    )
  }
}

main()
