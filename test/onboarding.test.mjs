// Onboarding UX: the run-time preflight that kills the #1 fallow footgun before it costs an
// escalation, and `temper explain`. Each test drives the real CLI in a throwaway git repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')
const APPEND = `sh -c 'echo "// touched $RANDOM" >> src/v.mjs'`

function temper(dir, args) {
  try {
    const out = execFileSync('node', [TEMPER, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

// A repo with a TRACKED test file (so projectHasTests() is true), optionally a fallow config and a
// stub engine. The tracked test file is what makes the fallow footgun apply.
function repo({ fallowConfig = false, stub = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-onboarding-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, 'src', 'v.test.mjs'), 'import "./v.mjs"\n')
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n`)
  if (fallowConfig) writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["**/*.test.mjs"]}\n')
  if (stub) writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { stub: { engine: APPEND, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off' }, null, 2))
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  return dir
}

test('temper run preflights the #1 footgun: tests but no fallow config → scaffolds + stops', () => {
  const dir = repo() // tests present, no fallow config
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'should stop before the loop, not run into the footgun')
    assert.match(r.out, /onboarding footgun/, 'explains the footgun')
    assert.match(r.out, /scaffolded/, 'tells the user it scaffolded the config')
    assert.ok(existsSync(join(dir, '.fallowrc.json')), 'the fallow config now exists, ready to commit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run checks for a clean tree BEFORE the preflight scaffolds (no config written into a dirty tree)', () => {
  const dir = repo() // tests present, no fallow config → the preflight would otherwise scaffold + abort
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 1 // uncommitted edit\n') // dirty the tree
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'a dirty tree must stop the run')
    assert.doesNotMatch(r.out, /onboarding footgun/, 'the clean-repo guard fires before the preflight')
    assert.ok(!existsSync(join(dir, '.fallowrc.json')), 'nothing scaffolded into a dirty tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run does NOT preflight-fail once a fallow config exists (it runs to a green gate)', () => {
  const dir = repo({ fallowConfig: true, stub: true })
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // preflight is a no-op; the stub run commits
    assert.doesNotMatch(r.out, /onboarding footgun/, 'no footgun stop when a fallow config is present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper explain <gate> gives what/why/fix; bare or unknown lists the gates', () => {
  const dir = repo({ fallowConfig: true })
  try {
    const one = temper(dir, ['explain', 'fallow-audit'])
    assert.equal(one.code, 0, one.out)
    assert.match(one.out, /Dead-code/, 'explains the fallow gate')
    assert.match(one.out, /How to clear/, 'gives the fix')

    assert.match(temper(dir, ['explain']).out, /Gates and verdicts/, 'bare explain lists the gates')
    assert.match(temper(dir, ['explain', 'nope']).out, /Gates and verdicts/, 'an unknown gate lists the gates')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper explain accepts the words the failure banners print (HALT → halted)', () => {
  const dir = repo({ fallowConfig: true })
  try {
    const r = temper(dir, ['explain', 'HALT'])
    assert.match(r.out, /halted/, 'HALT resolves to the halted verdict')
    assert.match(r.out, /Reuse-critic halt/, 'shows the explanation, not the usage dump')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper doctor checks the engine binary, not just git + fallow', () => {
  const dir = repo({ fallowConfig: true })
  try {
    assert.match(temper(dir, ['doctor']).out, /engine binary on PATH/, 'doctor now checks the engine binary resolves')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run fails fast when the acceptance command binary is not runnable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-acc-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "definitelynotacmd_zzz --run"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'a non-runnable acceptance command stops before the loop')
    assert.match(r.out, /isn't runnable|not on your PATH/, 'flags the non-runnable acceptance command')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper init writes the full key set (not just a 4-key stub)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-init-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  try {
    temper(dir, ['init'])
    const cfg = JSON.parse(readFileSync(join(dir, 'temper.config.json'), 'utf8'))
    for (const k of ['criticEngine', 'checkCompleteness', 'maxQueueSeconds', 'maxQueueIterations', 'notifyCommand']) {
      assert.ok(k in cfg, `init config should expose the ${k} knob`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run does NOT false-fail a subshell acceptance command (it runs to a green gate)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-subshell-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  writeFileSync(
    join(dir, 'temper.config.json'),
    JSON.stringify({ engines: { stub: { engine: APPEND, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off' }, null, 2),
  )
  // A parenthesized subshell — the binary-parse would have extracted "(node" and wrongly rejected it.
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "(node --check src/v.mjs)"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.doesNotMatch(r.out, /isn't runnable/, 'a subshell acceptance must not be rejected as non-runnable')
    assert.equal(r.code, 0, r.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run skips the fallow gate gracefully when fallow is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-nofallow-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  // fallowCommand points at a binary that does not exist → the gate is SKIPPED, not failed.
  writeFileSync(
    join(dir, 'temper.config.json'),
    JSON.stringify({ engines: { stub: { engine: APPEND, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'definitelynotfallow_zzz', criticMode: 'off' }, null, 2),
  )
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // commits via the other gates; fallow is skipped, not failed
    assert.match(r.out, /fallow not found/, 'notes that fallow is missing')
    assert.match(r.out, /skipping the dead-code/, 'and that the entropy gate is skipped')
    assert.doesNotMatch(r.out, /fallow audit failed/, 'a missing fallow must NOT count as a violation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
