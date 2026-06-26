// Mode B (overnight Plan-queue) integration tests. `temper eval` covers runPlan (the gate
// logic) with golden fixtures; this covers the orchestration AROUND it — run-phases branch
// isolation, the global budget, the rate-limit guard, status, and the stop-the-queue policy.
// Each test drives the real CLI in a throwaway git repo. Run: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')

// A stub engine that appends a unique in-scope comment — a real, gate-passing change per call.
const APPEND_ENGINE = `sh -c 'echo "// touched $$-$RANDOM-$(date +%s)" >> src/v.mjs'`

function setup(config, phases) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-modeb-'))
  const g = (args) => execFileSync('git', args, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, '.temper', 'phases'), { recursive: true })
  writeFileSync(join(dir, '.gitignore'), '.temper/\n')
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify(config, null, 2))
  phases.forEach(([name, body, scope, acceptance, heldout], i) => {
    const sc = (scope ?? ['src/**']).map((s) => `  - "${s}"`).join('\n')
    const held = heldout ? `heldout: "${heldout}"\n` : ''
    const fm = `---\nscope:\n${sc}\nacceptance: "${acceptance ?? 'node --check src/v.mjs'}"\n${held}---\n# ${name}\n${body}\n`
    writeFileSync(join(dir, '.temper', 'phases', `0${i + 1}-${name}.md`), fm)
  })
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  return dir
}

// Run the CLI; return { code, out } without throwing on non-zero exit.
function temper(dir, args) {
  try {
    const out = execFileSync('node', [TEMPER, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const baseCfg = (extra = {}) => ({
  engines: { stub: { engine: APPEND_ENGINE, critic: "echo '{}'" } },
  engine: 'stub',
  fallowCommand: 'true',
  criticMode: 'off',
  ...extra,
})

const gitOut = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

test('overnight isolates the queue on temper/<dir>, restores you to the base branch, and never advances it', () => {
  const dir = setup(baseCfg(), [['one', 'x'], ['two', 'y']])
  try {
    const start = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const startCommits = gitOut(dir, ['rev-list', '--count', start])

    const r = temper(dir, ['run-phases', '.temper/phases', '--overnight', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)

    // Restored to the base branch (not left on the isolation branch).
    assert.equal(gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), start)
    // The base branch must not have advanced — nothing auto-merged into it.
    assert.equal(gitOut(dir, ['rev-list', '--count', start]), startCommits)
    // The work lives on the stable isolation branch, with two phase commits.
    assert.equal(gitOut(dir, ['rev-parse', '--verify', 'temper/phases']).length, 40)
    const log = execFileSync('git', ['log', '--oneline', 'temper/phases'], { cwd: dir, encoding: 'utf8' })
    assert.equal((log.match(/temper:/g) || []).length, 2, log)
    assert.ok(existsSync(join(dir, '.temper', 'report.md')), 'a report should be written')
    assert.match(readFileSync(join(dir, '.temper', 'report.md'), 'utf8'), /Committed:\*\* 2\/2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a queue with two plans claiming the SAME file warns about the conflict before running (non-blocking)', () => {
  const dir = setup(baseCfg(), [
    ['one', 'x', ['src/v.mjs']],
    ['two', 'y', ['src/v.mjs']],
  ])
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.match(r.out, /declared scope overlap/, 'warns about the same-file conflict before running')
    assert.equal(r.code, 0, r.out) // non-blocking: both phases still run + commit
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the morning report confirms an ADDITIVE same-file overlap as harmless, not a real conflict', () => {
  const dir = setup(baseCfg(), [
    ['one', 'x', ['src/v.mjs']],
    ['two', 'y', ['src/v.mjs']], // both APPEND to src/v.mjs → additive build, no clobber
  ])
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)
    const report = readFileSync(join(dir, '.temper', 'report.md'), 'utf8')
    assert.match(report, /confirmed harmless/, 'the declared overlap is confirmed benign against actual edits')
    assert.match(report, /additive/, 'the per-pair benign note explains WHY it was harmless (additive)')
    assert.doesNotMatch(report, /\*\*Scope conflicts\*\*/, 'no real conflict surfaced for an additive build')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the morning report FLAGS a real conflict when a later phase rewrites a shared file', () => {
  const OVERWRITE = `sh -c 'echo "export const V = $RANDOM" > src/v.mjs'` // replaces the file → deletes prior lines
  const dir = setup(baseCfg({ engines: { stub: { engine: OVERWRITE, critic: 'true' } } }), [
    ['one', 'x', ['src/v.mjs']],
    ['two', 'y', ['src/v.mjs']],
  ])
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)
    const report = readFileSync(join(dir, '.temper', 'report.md'), 'utf8')
    assert.match(report, /\*\*Scope conflicts\*\*/, 'a rewrite of a shared file is a real conflict')
    assert.match(report, /changed lines/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a passing held-out check is announced in the live log AND confirmed in the morning report', () => {
  const dir = setup(baseCfg(), [
    ['one', 'x', ['src/v.mjs'], 'node --check src/v.mjs', 'true'], // a held-out (moat) that passes
  ])
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /held-out check: true/, 'the moat is announced in the live log, not silent on success')
    const report = readFileSync(join(dir, '.temper', 'report.md'), 'utf8')
    assert.match(report, /Held-out moat:/, 'the morning report (what an overnight user reads) confirms the moat ran')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a FAILING held-out check rejects the phase as GAMED (exit 5) and commits nothing — the moat', () => {
  const dir = setup(baseCfg(), [
    ['one', 'x', ['src/v.mjs'], 'node --check src/v.mjs', 'false'], // visible gates pass; the hidden held-out fails
  ])
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 5, 'a failed held-out exits 5 (gamed)')
    assert.match(r.out, /GAMED/, 'the run reports the visible gates were gamed')
    assert.match(r.out, /Nothing committed/, 'no false-green commit on a gamed phase')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the morning report flags a declared overlap as NOT confirmed when a phase in it did not commit', () => {
  const dir = setup(baseCfg(), [
    ['one', 'x', ['src/v.mjs']],
    ['two', 'y', ['src/v.mjs'], 'false'], // phase 2 escalates: acceptance always fails → never commits
  ])
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.notEqual(r.code, 0, 'phase 2 does not commit (escalates/maxes)')
    const report = readFileSync(join(dir, '.temper', 'report.md'), 'utf8')
    // the 01↔02 overlap can't be confirmed (phase 2 has no diff) — it must be SURFACED, not silently dropped
    assert.match(report, /NOT confirmed/, 'an unconfirmable overlap on a failed run is named, not dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ledger resets for a different queue, so temper status reflects the last run not a stale queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-q9-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, '.temper', 'qa'), { recursive: true })
  mkdirSync(join(dir, '.temper', 'qb'), { recursive: true })
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.gitignore'), '.temper/\n')
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { stub: { engine: APPEND_ENGINE, critic: 'true' } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off' }))
  const fm = `---\nscope:\n  - "src/v.mjs"\nacceptance: "node --check src/v.mjs"\n---\n`
  writeFileSync(join(dir, '.temper', 'qa', '01-alpha.md'), fm + '# alpha\nx\n')
  writeFileSync(join(dir, '.temper', 'qb', '01-beta.md'), fm + '# beta\nx\n')
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    assert.equal(temper(dir, ['overnight', '.temper/qa']).code, 0)
    assert.equal(temper(dir, ['overnight', '.temper/qb']).code, 0)
    const s = temper(dir, ['status'])
    assert.match(s.out, /beta/, 'status shows the most recent queue')
    assert.doesNotMatch(s.out, /alpha/, 'status does not conflate the earlier, different queue')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('`temper overnight <dir>` is the alias — isolates on temper/<dir> + writes a report, no --overnight flag needed', () => {
  const dir = setup(baseCfg(), [['one', 'x']])
  try {
    const start = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const r = temper(dir, ['overnight', '.temper/phases', '--engine', 'stub']) // no --overnight flag
    assert.equal(r.code, 0, r.out)
    assert.equal(gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), start, 'restored to the base branch')
    assert.equal(gitOut(dir, ['rev-parse', '--verify', 'temper/phases']).length, 40, 'work isolated on temper/phases')
    assert.ok(existsSync(join(dir, '.temper', 'report.md')), 'overnight defaults the morning report ON')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overnight direction check (warn) surfaces a concern in the report without blocking the commit', () => {
  const dir = setup(
    baseCfg({
      engines: { stub: { engine: APPEND_ENGINE, critic: `echo '{"sound":false,"concern":"relies on a removed API","source":"docs/api.md"}'` } },
      directionCheck: { enabled: true, sources: ['docs/api.md'], every: 1, onMiss: 'warn' },
    }),
    [['one', 'x']],
  )
  try {
    const r = temper(dir, ['overnight', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // warn does NOT block — the phase still commits
    assert.match(r.out, /direction concern/, 'logs the concern')
    const report = readFileSync(join(dir, '.temper', 'report.md'), 'utf8')
    assert.match(report, /Direction concerns/, 'report surfaces the concern block')
    assert.match(report, /relies on a removed API/, 'with the concern text + its source')
    const gitLog = execFileSync('git', ['log', '--oneline', 'temper/phases'], { cwd: dir, encoding: 'utf8' })
    assert.equal((gitLog.match(/temper:/g) || []).length, 1, 'phase still committed despite the warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overnight direction check (pause) stops the queue BEFORE the phase — nothing committed (exit 7)', () => {
  const dir = setup(
    baseCfg({
      engines: { stub: { engine: APPEND_ENGINE, critic: `echo '{"sound":false,"concern":"superseded pattern","source":"SPEC.md"}'` } },
      directionCheck: { enabled: true, sources: ['SPEC.md'], every: 1, onMiss: 'pause' },
    }),
    [['one', 'x'], ['two', 'y']],
  )
  try {
    const r = temper(dir, ['overnight', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 7, r.out) // paused before phase 1
    assert.match(r.out, /paused before phase 1/, 'stops at the first phase, before running it')
    const gitLog = execFileSync('git', ['log', '--oneline', 'temper/phases'], { cwd: dir, encoding: 'utf8' })
    assert.equal((gitLog.match(/temper:/g) || []).length, 0, 'no phase committed — paused before running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('direction check is OFF without a trust-list — overnight runs normally even with enabled:true', () => {
  const dir = setup(
    baseCfg({
      engines: { stub: { engine: APPEND_ENGINE, critic: `echo '{"sound":false,"concern":"x","source":"y"}'` } },
      directionCheck: { enabled: true, sources: [], every: 1, onMiss: 'pause' }, // enabled but NO sources
    }),
    [['one', 'x']],
  )
  try {
    const r = temper(dir, ['overnight', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // no sources → check never fires → normal commit
    assert.doesNotMatch(r.out, /direction concern/, 'an empty trust-list keeps the feature dormant')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stopped overnight queue resumes on the same isolation branch after the plan is fixed', () => {
  const dir = setup(baseCfg({ maxIterations: 2 }), [['one', 'x'], ['two', 'y']])
  const p2 = join(dir, '.temper', 'phases', '02-two.md')
  writeFileSync(p2, `---\nscope:\n  - "src/**"\nacceptance: "false"\n---\n# two\nx\n`) // phase 2 fails
  try {
    const r1 = temper(dir, ['run-phases', '.temper/phases', '--overnight', '--engine', 'stub'])
    assert.equal(r1.code, 4, r1.out) // phase 2 escalates (identical acceptance failure → fast-bail)
    assert.ok(!gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).startsWith('temper/'), 'restored to base on failure')

    writeFileSync(p2, `---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# two\nx\n`) // fix it
    const r2 = temper(dir, ['run-phases', '.temper/phases', '--overnight', '--engine', 'stub'])
    assert.equal(r2.code, 0, r2.out)
    assert.match(r2.out, /resuming the queue on/, 'should re-enter the same stable branch')
    assert.match(r2.out, /already committed/, 'phase 1 should resume-skip')
    const log = execFileSync('git', ['log', '--oneline', 'temper/phases'], { cwd: dir, encoding: 'utf8' })
    assert.equal((log.match(/temper:/g) || []).length, 2, log) // phase 1 (from run 1) + phase 2 (from run 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the run budget stops the queue and exits 6, leaving later phases unrun', () => {
  const dir = setup(baseCfg({ maxQueueIterations: 1 }), [['one', 'x'], ['two', 'y']])
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 6, r.out)
    assert.match(r.out, /budget reached/)
    const report = readFileSync(join(dir, '.temper', 'report.md'), 'utf8')
    assert.match(report, /not run/, 'the second phase should be marked not run')
    assert.doesNotMatch(report, /02-two/, 'an un-run phase shows its plan title, not the raw filename')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cap phrase mentioned mid-prose on a successful run does NOT trigger a false rate-limit wait', () => {
  // The engine narrates a cap phrase inside a sentence AND does real work in the same call.
  // Anchored detection must NOT treat the mid-prose mention as a cap. Bounded so a regression
  // can't hang the suite (it would give up after maxQueueWaitSeconds and still trip the assert).
  const engine = `sh -c 'echo "I added handling for when usage limit reached is logged"; echo "// work $RANDOM" >> src/v.mjs'`
  const dir = setup(
    {
      engines: { stub: { engine, critic: "echo '{}'" } },
      engine: 'stub',
      fallowCommand: 'true',
      criticMode: 'off',
      rateLimit: { marginSeconds: 0, fallbackSeconds: 2, maxQueueWaitSeconds: 4 },
    },
    [['p', 'x']],
  )
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /subscription cap hit/, 'a prose mention must not trip the guard')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a subscription cap is detected and the run sleeps then resumes', () => {
  // Engine reports the cap on its first call (via a per-run marker), then does real work.
  const marker = join(mkdtempSync(join(tmpdir(), 'temper-rlmark-')), 'm')
  const engine = `sh -c 'if [ -f ${marker} ]; then echo "// work $RANDOM" >> src/v.mjs; else touch ${marker}; echo "Claude usage limit reached. Try again later."; fi'`
  const dir = setup(
    {
      engines: { stub: { engine, critic: "echo '{}'" } },
      engine: 'stub',
      fallowCommand: 'true',
      criticMode: 'off',
      rateLimit: { marginSeconds: 0, fallbackSeconds: 1 }, // deep-merged with default patterns
    },
    [['rl', 'work']],
  )
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /subscription cap hit/, 'the cap should be detected')
    assert.match(r.out, /all 1 phases green/, 'it should resume and commit after the wait')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(marker), { recursive: true, force: true })
  }
})

test('status summarizes the ledger after a run', () => {
  const dir = setup(baseCfg(), [['one', 'x']])
  try {
    temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    const r = temper(dir, ['status'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /committed: 1/)
    assert.match(r.out, /✓ 1\. one/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status shows a commit sha only for committed phases, not stopped ones', () => {
  // A stopped phase's ledger `sha` is the PRIOR base commit, not one it made — status must not imply it committed.
  const dir = setup(baseCfg({ maxIterations: 2 }), [['one', 'x'], ['two', 'y']])
  writeFileSync(join(dir, '.temper', 'phases', '02-two.md'), `---\nscope:\n  - "src/**"\nacceptance: "false"\n---\n# two\nx\n`)
  try {
    temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub']) // phase 1 commits; phase 2 fails → escalates
    const r = temper(dir, ['status'])
    assert.match(r.out, /✓ 1\. one — committed \([0-9a-f]{9}\)/, 'a committed phase shows its sha')
    assert.match(r.out, /■ 2\. two — escalated/, 'the stopped phase is listed')
    assert.doesNotMatch(r.out, /escalated \([0-9a-f]/, 'a stopped phase must NOT display a (prior) commit sha')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing phase stops the queue (stop-the-queue policy) and writes a report', () => {
  // Acceptance always fails → the phase never goes green → maxed (exit 3); later phases do not run.
  const dir = setup(baseCfg({ maxIterations: 2 }), [['bad', 'x'], ['after', 'y']])
  // Override phase 1's acceptance to a guaranteed failure (the plan dir is gitignored and
  // read from disk, so no commit is needed and the tree stays clean for requireCleanRepo).
  writeFileSync(
    join(dir, '.temper', 'phases', '01-bad.md'),
    `---\nscope:\n  - "src/**"\nacceptance: "false"\n---\n# bad\nx\n`,
  )
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 4, r.out) // escalates (identical acceptance failure → unchanged-finding fast-bail)
    assert.match(r.out, /later phases were NOT run/)
    assert.ok(existsSync(join(dir, '.temper', 'report.md')))
    assert.match(readFileSync(join(dir, '.temper', 'report.md'), 'utf8'), /the `acceptance` gate/, 'the report names the gate that stopped the phase')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the report surfaces a warn-level reuse-critic flag on a phase that still committed', () => {
  // A warn-mode flag lets the phase commit but otherwise only hits stdout — the report must carry it,
  // since the morning-after review is where a possible duplication has to be caught.
  const dir = setup(
    {
      engines: { stub: { engine: APPEND_ENGINE, critic: `echo '{"flagged":true,"confidence":"medium","summary":"reimplements existing helper"}'` } },
      engine: 'stub',
      fallowCommand: 'true',
      criticMode: 'warn',
    },
    [['one', 'x']],
  )
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // warn mode: the phase still commits
    const report = readFileSync(join(dir, '.temper', 'report.md'), 'utf8')
    assert.match(report, /Reuse-critic flags/, 'the report surfaces the critic flag')
    assert.match(report, /reimplements existing helper/, 'with the critic summary')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the --max-queue-iterations flag bounds the queue without a config edit', () => {
  const dir = setup(baseCfg(), [['one', 'x'], ['two', 'y']]) // no budget in the config
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--max-queue-iterations', '1', '--engine', 'stub'])
    assert.equal(r.code, 6, r.out)
    assert.match(r.out, /budget reached/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run-phases on an empty queue dir teaches the phase-file format', () => {
  const dir = setup(baseCfg(), [['one', 'x']])
  rmSync(join(dir, '.temper', 'phases', '01-one.md')) // empty the queue dir
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.notEqual(r.code, 0, r.out)
    assert.match(r.out, /temper plan.*--out .temper\/phases/, 'teaches how to draft a phase file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale/old-format ledger entry does not crash the report or strand HEAD', () => {
  // A committed entry from an OLD format (uses `commit`, lacks a string `sha`) for a phase no
  // longer in the queue must not crash writeReport (which would strand HEAD on the iso branch).
  const dir = setup(baseCfg(), [['one', 'x']])
  writeFileSync(
    join(dir, '.temper', 'progress.json'),
    JSON.stringify([{ file: '/gone/old-phase.md', title: 'old', status: 'committed', fingerprint: 'x', commit: 'deadbeef' }]),
  )
  try {
    const start = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const r = temper(dir, ['run-phases', '.temper/phases', '--overnight', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // no crash
    assert.doesNotMatch(r.out, /TypeError|is not a function/, r.out)
    assert.equal(gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), start, 'restored to base, not stranded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the notify hook fires on a terminal outcome with TEMPER_* context', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'temper-notify-')), 'event')
  const dir = setup(
    baseCfg({ notifyCommand: `printf '%s|%s|%s' "$TEMPER_EVENT" "$TEMPER_SUMMARY" "$TEMPER_BRANCH" > ${out}` }),
    [['one', 'x']],
  )
  try {
    const r = temper(dir, ['run-phases', '.temper/phases', '--overnight', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)
    const fired = readFileSync(out, 'utf8')
    assert.match(fired, /^all-green\|/, `event should be all-green: ${fired}`)
    assert.match(fired, /1\/1 phases committed/, `summary present: ${fired}`)
    assert.match(fired, /temper\/phases/, `branch in context: ${fired}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(out), { recursive: true, force: true })
  }
})

test('the notify hook fires with the failure event when a phase stops the queue', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'temper-notify-')), 'event')
  const dir = setup(baseCfg({ maxIterations: 2, notifyCommand: `printf '%s' "$TEMPER_EVENT" > ${out}` }), [['bad', 'x']])
  writeFileSync(join(dir, '.temper', 'phases', '01-bad.md'), `---\nscope:\n  - "src/**"\nacceptance: "false"\n---\n# bad\nx\n`)
  try {
    temper(dir, ['run-phases', '.temper/phases', '--engine', 'stub'])
    assert.equal(readFileSync(out, 'utf8'), 'escalated', 'failure event should be the verdict (escalated via fast-bail)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(out), { recursive: true, force: true })
  }
})

test('a failed overnight phase is cleaned up: HEAD restored to base and the tree left clean', () => {
  // The engine drops an OUT-OF-SCOPE untracked artifact → scope violation → maxed. The exit-restore
  // must reset + clean it and return to base, so the next run starts from a clean base tree.
  const engine = `sh -c 'echo junk > out-of-scope.txt'`
  const dir = setup(
    { engines: { stub: { engine, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off', maxIterations: 2 },
    [['p', 'x']],
  )
  try {
    const start = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const r = temper(dir, ['run-phases', '.temper/phases', '--overnight', '--engine', 'stub'])
    assert.notEqual(r.code, 0, r.out) // the phase fails (out of scope)
    assert.equal(gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), start, 'restored to base')
    assert.equal(gitOut(dir, ['status', '--porcelain']), '', 'base tree clean — the out-of-scope artifact was removed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
