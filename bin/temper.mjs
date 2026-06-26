#!/usr/bin/env node
// Temper — a thin, engine-agnostic, entropy-gated loop runner for AI coding.
//
// Runs in YOUR terminal, drives a subscription CLI (claude / codex), and gates
// every iteration with `fallow audit --gate new-only` so the loop can only
// commit work that introduced no new entropy. See the README for the reasoning.
// Deterministic plumbing only — the engine and critic are the sole LLM steps.
//
// This file is the CLI surface: argument parsing, the `init`/`doctor` commands,
// and the command dispatch. The machinery lives in src/ (sh, config, gates,
// engine, plan, loop, phases, eval).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { run, log, fail, requireCleanRepo, commandBinary, resolvesOnPath } from '../src/sh.mjs'
import { loadConfig, resolveEngines, applyMaxIterations, applyQueueBudget, hasFallowConfig, projectHasTests, hasPackageEntry, DEFAULTS } from '../src/config.mjs'
import { parsePlan, runPlanDraft } from '../src/plan.mjs'
import { runLoop } from '../src/loop.mjs'
import { runPhases, status, planCheck, runTasks, addTask } from '../src/phases.mjs'
import { runEval } from '../src/eval.mjs'
import { runAudit } from '../src/audit.mjs'

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

// The AGENTS.md block Temper writes so a Codex-style agent (anything that reads AGENTS.md) knows when to
// reach for the CLI. Sentinel-delimited so `temper init` can refresh it in place without clobbering the
// rest of the file. The SAME routing the Skill uses: one task → run, a batch → overnight.
const AGENTS_START = '<!-- temper:integrate-start -->'
const AGENTS_END = '<!-- temper:integrate-end -->'
const AGENTS_BLOCK = `${AGENTS_START}
## Temper — gated implementation

When a change should be implemented with quality gates (not just done), drive it through Temper instead
of editing files directly:

- **One bounded task** → \`temper plan "<task>"\` to draft \`./PLAN.md\`, confirm the scope with the user,
  then \`temper run ./PLAN.md\`.
- **A large batch / overnight pass** → put the approved Plans in a queue dir and run \`temper overnight <dir>\`.
- **A single trivial edit** (typo, one-liner) → just do it directly; Temper is for changes worth gating.

Temper needs a clean tree, makes one commit per green gate, and stops (without hand-fixing) when a gate or
the reuse-critic flags something only a human should decide. Report the commit or the halt — do not
hand-fix what Temper stopped on.
${AGENTS_END}`

// Wire the agent integration: copy the Claude Code Skill into .claude/skills/temper/ and write/refresh the
// AGENTS.md block. Idempotent — re-running overwrites the skill copy and replaces the AGENTS.md block in
// place (string-sliced between sentinels, no regex). Returns the labels actually written.
function wireAgents(cwd) {
  const wrote = []
  const skillDir = join(cwd, '.claude', 'skills', 'temper')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), readFileSync(new URL('../skills/temper/SKILL.md', import.meta.url), 'utf8'))
  wrote.push('.claude/skills/temper/SKILL.md')
  const agentsPath = join(cwd, 'AGENTS.md')
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : ''
  const s = existing.indexOf(AGENTS_START)
  const e = existing.indexOf(AGENTS_END)
  let next
  if (s !== -1 && e !== -1) next = existing.slice(0, s) + AGENTS_BLOCK + existing.slice(e + AGENTS_END.length)
  else next = (existing ? existing.replace(/\n*$/, '\n\n') : '') + AGENTS_BLOCK + '\n'
  writeFileSync(agentsPath, next)
  wrote.push(s !== -1 ? 'AGENTS.md (refreshed Temper block)' : existing ? 'AGENTS.md (added Temper block)' : 'AGENTS.md')
  return wrote
}

// `temper init` — scaffold a project so the dead-code gate doesn't false-positive on new exports/tests,
// and (with --agents, or when this repo already uses an agent) wire the Skill + AGENTS.md so the agent
// reaches for Temper. fallow already treats package.json exports/main/bin as entry points (the library
// API); this declares TEST files as entry points too, so adding a new exported function with a test
// commits, not escalates.
function runInit(flags = {}) {
  const cwd = process.cwd()
  const wrote = []
  const configs = []
  if (scaffoldFallowConfig()) {
    wrote.push('.fallowrc.json')
    configs.push('.fallowrc.json')
  }
  if (!existsSync(join(cwd, 'temper.config.json'))) {
    const starter = Object.fromEntries(STARTER_KEYS.map((k) => [k, DEFAULTS[k]]))
    // Prefer a project-local fallow over the bare `fallow` default: JS/TS projects commonly pin it as a dev
    // dep rather than installing globally, and the pinned version is more reproducible. Falls back to PATH.
    if (existsSync(join(cwd, 'node_modules', '.bin', 'fallow'))) starter.fallowCommand = 'node_modules/.bin/fallow'
    writeFileSync(join(cwd, 'temper.config.json'), JSON.stringify(starter, null, 2) + '\n')
    wrote.push('temper.config.json')
    configs.push('temper.config.json')
  }
  // Gitignore Temper's working artifacts so they never dirty the tree (a friction hit repeatedly when
  // dogfooding): the runtime dir (.temper/ — ledger/report) and the drafted PLAN.md (regenerated each run).
  wrote.push(...ensureGitignored(join(cwd, '.gitignore'), ['.temper/', 'PLAN.md']))
  // Agent wiring: --agents forces it, --no-agents skips it; a bare `temper init` auto-wires when this repo
  // already uses an agent (.claude/ or AGENTS.md present), so it "just sets me up" without surprising a
  // project that doesn't.
  const wantAgents = 'agents' in flags ? true : 'no-agents' in flags ? false : existsSync(join(cwd, '.claude')) || existsSync(join(cwd, 'AGENTS.md'))
  if (wantAgents) wrote.push(...wireAgents(cwd))
  log(wrote.length ? `✓ wrote ${wrote.join(', ')}` : '✓ already configured (temper.config.json + a fallow config both present)')
  log('\nNext:')
  log('  • Make sure your public API is in package.json "exports"/"main"/"bin" (fallow treats those')
  log('    as entry points), or add globs to .fallowrc.json "entry".')
  log('  • Set "criticEngine" to the OTHER engine in temper.config.json for cross-model review.')
  if (wantAgents) log('  • Your agent now knows Temper — Claude Code via the Skill, Codex via AGENTS.md. Commit AGENTS.md.')
  else log('  • Run `temper init --agents` to wire the Claude Code / Codex skill so your agent reaches for Temper.')
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
  const entropyBin = commandBinary(cfg.entropyGate || cfg.fallowCommand)
  const checks = [
    ['inside a git repository', run('git rev-parse --is-inside-work-tree').code === 0, true],
    [`entropy gate — optional (\`${entropyBin}\`)`, resolvesOnPath(entropyBin), false],
    [`engine binary on PATH (\`${engineBin}\`)`, resolvesOnPath(engineBin), true],
  ]
  if (criticBin && criticBin !== engineBin) checks.push([`critic binary on PATH (\`${criticBin}\`)`, resolvesOnPath(criticBin), true])
  for (const [name, ok] of checks) log(`${ok ? '✓' : '✗'} ${name}`)
  const requiredFailed = checks.some(([, ok, required]) => required && !ok) // git repo + engine (+ critic): the run cannot work without these
  // fallow is OPTIONAL: missing → the entropy gate is skipped (note it). Present + tests but no config →
  // the #1 footgun (the dead-code gate flags new exports/tests as "unused"); point to `temper init`.
  if (!resolvesOnPath(entropyBin)) {
    log('\nℹ the entropy gate is optional. Without it Temper skips the dead-code/duplication gate (it still')
    log('  gates on scope, protected regions, suppression, your tests, and the reuse-critic). Install fallow')
    log('  (`npm i -g fallow`) for JS/TS, or set `entropyGate` to your language\'s tool.')
    if (existsSync(join(process.cwd(), 'node_modules', '.bin', 'fallow'))) log('  → fallow is already in node_modules; set "fallowCommand": "node_modules/.bin/fallow" for the cheapest fix.')
  } else if (!cfg.entropyGate && !hasFallowConfig() && projectHasTests()) {
    log('\n⚠ No fallow config, but this project has tests. fallow\'s dead-code gate flags new')
    log('  exports / test files as "unused" without entry-point config — a new exported function')
    log('  would escalate instead of committing. Run `temper init` to scaffold one.')
  }
  // Bootstrap risk: no entry points at all (no tests, no package exports/main/bin) → fallow has no root to
  // measure reachability, so the FIRST change that adds an entry can flag pre-existing unused code as
  // newly-dead ("introduced"). With entry points present, fallow attributes inherited dead code correctly.
  if (!cfg.entropyGate && resolvesOnPath(entropyBin) && !projectHasTests() && !hasPackageEntry()) {
    log('\nℹ No fallow entry points yet (no tests, no package.json exports/main/bin). fallow measures dead')
    log('  code from entry points, so the first change that adds one can flag pre-existing unused code as')
    log('  "introduced". Add an entry point (a test, or package.json exports/main/bin) before your first run.')
  }
  // Running inside a nested / host-managed agent session is the other classic first-run failure: the
  // child `claude -p` Temper spawns may not reach your terminal's subscription auth (it can 401).
  if (process.env.CLAUDE_CODE_CHILD_SESSION || process.env.CLAUDECODE) {
    log('\nℹ This looks like a nested / host-managed agent session. Temper drives `claude -p` as a child')
    log('  process; depending on the host it may not reach your terminal\'s subscription auth. If a run')
    log('  fails to authenticate, run it from a plain terminal instead.')
  }
  log(`\nengine (${cfg.engineName}): ${cfg.engineCommand}`)
  log(`critic (${cfg.criticName}): ${cfg.criticCommand}`)
  log(
    '\nVerify the engine command edits files headlessly, and that the CLIs use your\n' +
      "terminal's real subscription auth — Temper can't run inside a hosted Claude session.",
  )
  // Exit non-zero on a required failure (not the optional entropy gate), so `temper doctor && temper run` is safe.
  if (requiredFailed) {
    log('\n✗ A required check failed above — fix it before a run (this makes `temper doctor && temper run` safe).')
    process.exit(1)
  }
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
  acceptance: ['Acceptance gate', "The Plan's `acceptance:` command exited non-zero (tests/build/typecheck failed).", 'Run the acceptance command yourself against the working tree. If it fails the SAME way no matter what the engine changes (e.g. "command/module not found"), the command itself is wrong, not the code — e.g. use `node --test`, not `node --test <dir>/`.'],
  completeness: ['Completeness check (opt-in)', 'An LLM check judged the diff did not implement every step of the Plan.', 'Finish the missing Plan steps, or correct the Plan if a step is obsolete.'],
  halted: ['Reuse-critic halt (exit 2)', 'The critic judged the change likely re-implements something that already exists (high confidence, halt mode).', 'Review the diff against the existing code it named — reuse it, or re-run if the critic is wrong.'],
  escalated: ['Stuck-domain escalation (exit 4)', 'One gate failed repeatedly without converging, so Temper stopped instead of burning iterations.', 'The plan, the gate, or the task likely needs your judgment. Read the per-iteration findings above, then fix the root cause.'],
  gamed: ['Held-out check failed (exit 5)', 'Work passed every visible gate but failed the hidden `heldout:` check — the visible gates were gamed or too weak.', 'Review the diff and strengthen the visible gates/tests — never re-prompt against the held-out. Caveats: the held-out is hidden from the engine PROMPT but lives in the plan file on disk, so a repo-exploring engine can read it (it deters an honest-but-weak engine, not an adversarial one); and if the GAMED output looked like a command/shell error, your held-out command itself is broken, not the work.'],
  maxed: ['Max iterations (exit 3)', 'Hit the iteration cap without a green gate and without a single stuck domain.', 'Review the working tree and tighten the Plan; raise --max-iterations only if the task genuinely needs more (rarely the answer).'],
  budget: ['Over budget (exit 6, Mode B)', 'The queue hit maxQueueSeconds / maxQueueIterations.', 'Re-run to continue — a resume starts a fresh budget and the ledger skips committed phases.'],
  direction: ['Direction check paused the queue (exit 7, overnight)', "A pre-phase direction check found the upcoming phase's APPROACH contradicts a trusted source (deprecated / superseded / wrong premise) and directionCheck.onMiss is \"pause\".", 'Review the approach against the cited source, fix the Plan, then resume. Set directionCheck.onMiss to "warn" to flag it in the report instead of pausing.'],
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
  // `--version`/`-v` before any config load, so it works outside a repo. Read package.json relative to THIS
  // script (not the cwd) — temper runs inside the user's project, where ./package.json is theirs, not ours.
  if (flags.version || positionals[0] === '-v') {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(version)
    process.exit(0)
  }
  const [cmd, arg] = positionals
  const cfg = loadConfig()
  if (cmd === 'run') {
    if (!arg) fail('Usage: temper run <plan.md> [--engine <name>] [--max-iterations <n>]')
    requireCleanRepo() // before the preflight: never scaffold a config into a dirty tree
    preflightOnboarding()
    resolveEngines(cfg, flags.engine)
    if (!resolvesOnPath(commandBinary(cfg.engineCommand))) fail(`engine \`${commandBinary(cfg.engineCommand)}\` is not on your PATH. Install it or fix "engine" in temper.config.json, then run \`temper doctor\`.`)
    applyMaxIterations(cfg, flags)
    log(`engine: ${cfg.engineName}   critic: ${cfg.criticName}\n`)
    runLoop(cfg, parsePlan(arg))
  } else if (cmd === 'plan') {
    resolveEngines(cfg, flags.engine)
    log(`drafting engine: ${cfg.criticName} (read-only)\n`)
    runPlanDraft(cfg, arg, flags.out, 'force' in flags)
  } else if (cmd === 'tasks') {
    resolveEngines(cfg, flags.engine)
    log(`drafting engine: ${cfg.criticName} (read-only)\n`)
    const queueDir = typeof flags.dir === 'string' ? flags.dir : cfg.phaseDir
    if (arg === 'add') addTask(cfg, positionals[2], queueDir, 'reconcile' in flags)
    else runTasks(cfg, arg, queueDir)
  } else if (cmd === 'audit') {
    runAudit(cfg, arg)
  } else if (cmd === 'overnight' || cmd === 'run-phases') {
    requireCleanRepo() // before the preflight: never scaffold a config into a dirty tree
    preflightOnboarding()
    resolveEngines(cfg, flags.engine)
    if (!resolvesOnPath(commandBinary(cfg.engineCommand))) fail(`engine \`${commandBinary(cfg.engineCommand)}\` is not on your PATH. Install it or fix "engine" in temper.config.json, then run \`temper doctor\`.`)
    applyMaxIterations(cfg, flags)
    applyQueueBudget(cfg, flags)
    log(`engine: ${cfg.engineName}   critic: ${cfg.criticName}\n`)
    // `temper overnight` defaults the unattended path ON (own branch + morning report — the safe default
    // for a queue you walk away from); the older `run-phases` keeps requiring an explicit --overnight.
    runPhases(cfg, arg ?? cfg.phaseDir, { overnight: cmd === 'overnight' || 'overnight' in flags, branch: flags.branch })
  } else if (cmd === 'status') {
    status(cfg)
  } else if (cmd === 'plan-check') {
    if ('reconcile' in flags) resolveEngines(cfg, flags.engine)
    process.exit(planCheck(cfg, arg ?? cfg.phaseDir, 'reconcile' in flags) ? 1 : 0)
  } else if (cmd === 'init') {
    runInit(flags)
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
        '  temper run <plan.md>          run one approved Plan to a green gate\n' +
        '  temper overnight <dir>        work an ordered queue of Plans unattended — own branch + morning report\n\n' +
        '  temper plan "<task>"          draft a Plan from the codebase for you to approve\n' +
        '  temper tasks <file>           draft a scoped Plan per task line into the queue (add "<task>" to append one)\n' +
        '  temper audit [dir]            scan with fallow + draft dead-code cleanup Plans into .temper/audit\n' +
        '  temper init [--agents]        scaffold config; --agents wires the Claude Code / Codex skill\n' +
        '  temper status                 summarize the current/last queue from the ledger\n' +
        '  temper plan-check <dir>       flag plans whose scopes claim the same file (--reconcile adds an LLM suggestion)\n' +
        '  temper explain <gate>         what a gate/verdict means + how to clear it\n' +
        '  temper doctor                 check prerequisites\n' +
        '  temper eval                   run the golden-task regression suite\n' +
        '  temper --version              print the version\n\n' +
        'Flags: --engine <name>, --max-iterations <n>; overnight adds --branch <b>, --max-queue-seconds/-iterations <n>.\n' +
        'overnight isolates the queue on its own branch (never main, never merged) + writes a report.\n' +
        'Engines live in temper.config.json (presets: claude, codex); set "criticEngine" for cross-model review.\n',
    )
  }
}

main()
