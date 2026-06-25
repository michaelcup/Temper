// The golden-fixture eval harness (R1). Each fixture under evals/<id>/ runs the REAL runPlan
// with a deterministic STUB engine (no LLM) in an isolated temp repo, scored by final state,
// so Temper's orchestration (the gates + the commit-vs-reject decision) never silently regresses.
// It does NOT test the LLM critic's judgment (irreducible); fixtures run with it off.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, log, fail, git, state } from './sh.mjs'
import { DEFAULTS } from './config.mjs'
import { parsePlan } from './plan.mjs'
import { runPlan } from './loop.mjs'

function discoverFixtures(dir, filter) {
  if (!existsSync(dir)) fail(`No evals/ directory at ${dir}.`)
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => !filter || id.includes(filter))
    .sort()
    .map((id) => {
      const path = join(dir, id)
      return { id, path, expected: JSON.parse(readFileSync(join(path, 'expected.json'), 'utf8')) }
    })
}

// Score by FINAL STATE: the verdict enum, what the committed tree contains/omits,
// and which substrings the surfaced violations must contain.
function scoreFixture(fx, actual, work) {
  const exp = fx.expected
  const no = (why) => ({ id: fx.id, pass: false, why, status: actual.status })
  if (actual.status !== exp.verdict) return no(`verdict ${actual.status} ≠ ${exp.verdict}${actual.error ? ' (' + actual.error + ')' : ''}`)
  if (exp.iterations !== undefined && actual.iterations !== exp.iterations)
    return no(`stopped at iteration ${actual.iterations}, expected ${exp.iterations}`)
  for (const [f, want] of Object.entries(exp.finalFiles ?? {})) {
    const got = run(`git -C "${work}" show "HEAD:${f}"`) // what was COMMITTED, not the working tree
    const committed = got.code === 0
    if (want.absent && committed) return no(`${f} should not be committed`)
    if (want.contains && (!committed || !got.out.includes(want.contains))) return no(`${f} missing "${want.contains}"`)
  }
  for (const r of exp.rejectedReasons ?? []) {
    if (!(actual.violations ?? []).some((v) => v.includes(r))) return no(`no violation contained "${r}"`)
  }
  return { id: fx.id, pass: true, status: actual.status }
}

export function runEval(cfg, opts) {
  const dir = join(process.cwd(), 'evals')
  const fixtures = discoverFixtures(dir, opts.filter)
  if (!fixtures.length) fail('No fixtures matched.')
  const baseFile = join(dir, 'baseline.json')
  const baseline = existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, 'utf8')) : {}
  const origCwd = process.cwd()
  const results = []
  for (const fx of fixtures) {
    const work = mkdtempSync(join(tmpdir(), `temper-eval-${fx.id}-`))
    cpSync(join(fx.path, 'repo'), work, { recursive: true })
    const plan = parsePlan(join(fx.path, 'plan.md'))
    // Base on DEFAULTS (never the developer's merged config) so a fixture verdict can
    // NEVER move because of a local temper.config.json. Every verdict-affecting knob is
    // pinned here, overridable only by the fixture's own expected.json.
    const fxCfg = {
      ...DEFAULTS,
      engines: cfg.engines,
      engineCommand: `node "${join(fx.path, 'engine.mjs')}"`,
      criticCommand: existsSync(join(fx.path, 'critic.json'))
        ? `cat "${join(fx.path, 'critic.json')}"`
        : `echo '{"flagged":false}'`,
      // fallow is STUBBED so the suite is deterministic and needs no real fallow binary:
      // default `true` (gate passes); a fixture sets `false` to make the gate fail.
      fallowCommand: fx.expected.fallowCommand ?? 'true',
      criticMode: fx.expected.criticMode ?? 'off',
      maxIterations: fx.expected.maxIterations ?? DEFAULTS.maxIterations,
      maxDomainRetries: fx.expected.maxDomainRetries ?? DEFAULTS.maxDomainRetries,
      maxUnchangedRetries: fx.expected.maxUnchangedRetries ?? DEFAULTS.maxUnchangedRetries,
      forbidSuppressions: fx.expected.forbidSuppressions ?? DEFAULTS.forbidSuppressions,
      checkCompleteness: fx.expected.checkCompleteness ?? DEFAULTS.checkCompleteness,
      rateLimit: { ...DEFAULTS.rateLimit, enabled: false }, // never sleep in the deterministic suite
    }
    let actual
    process.chdir(work)
    state.logQuiet = true
    try {
      run('git init -q')
      run('git add -A')
      run('git -c user.email=eval@temper.test -c user.name=eval commit -qm seed')
      actual = runPlan(fxCfg, plan, { baseSha: git('rev-parse HEAD') })
    } catch (e) {
      actual = { status: 'error', error: e.message, violations: [] }
    } finally {
      state.logQuiet = false
      process.chdir(origCwd)
    }
    const result = scoreFixture(fx, actual, work)
    rmSync(work, { recursive: true, force: true })
    results.push(result)
  }
  const regressions = results.filter((r) => baseline[r.id] === true && !r.pass)
  log('\n── temper eval ──')
  for (const r of results) {
    const reg = baseline[r.id] === true && !r.pass ? '  ⚠ REGRESSION' : ''
    log(`${r.pass ? '✓' : '✗'} ${r.id}${r.pass ? '' : '  — ' + r.why}${reg}`)
  }
  const passed = results.filter((r) => r.pass).length
  log(`\n${passed}/${results.length} passed${regressions.length ? `  •  ${regressions.length} REGRESSION(S)` : ''}`)
  if (opts.updateBaseline) {
    if (regressions.length && !opts.force) {
      log(`\n✗ refusing to update baseline: ${regressions.length} regression(s) present. Fix them, or re-run with --force.`)
    } else {
      writeFileSync(baseFile, JSON.stringify(Object.fromEntries(results.map((r) => [r.id, r.pass])), null, 2) + '\n')
      log(`baseline updated → ${baseFile}`)
    }
  }
  return { results, regressions, failed: results.filter((r) => !r.pass).length }
}
