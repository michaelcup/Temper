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
  phases.forEach(([name, body], i) => {
    const fm = `---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# ${name}\n${body}\n`
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
