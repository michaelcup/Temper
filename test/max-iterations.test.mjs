// `--max-iterations <n>` per-invocation override tests. Drives the real CLI in a throwaway git
// repo: a stub engine makes a real in-scope change each call and an always-failing acceptance keeps
// the loop running to the cap, so the reported iteration count reveals which budget was honored.
// Run: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')

// Stub engine: append a unique in-scope line so every call is a real change (the loop never
// short-circuits on "no changes") and the acceptance gate re-runs each iteration.
const ENGINE = `sh -c 'echo "// touched $$-$RANDOM-$(date +%s)" >> src/v.mjs'`

// Seed a clean repo with one never-green plan: acceptance prints a growing line count then exits 1,
// so the finding differs every iteration (no unchanged-finding fast-bail) and the loop runs to the
// cap. The plan lives under gitignored .temper/ so the working tree stays clean for requireCleanRepo.
function seedRepo(maxIterations) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-maxiter-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, '.temper'), { recursive: true })
  writeFileSync(join(dir, '.gitignore'), '.temper/\n')
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(
    join(dir, 'temper.config.json'),
    JSON.stringify({
      engines: { stub: { engine: ENGINE, critic: "echo '{}'" } },
      engine: 'stub',
      fallowCommand: 'true',
      criticMode: 'off',
      maxIterations,
    }),
  )
  writeFileSync(
    join(dir, '.temper', 'plan.md'),
    `---\nscope:\n  - "src/**"\nacceptance: "sh -c 'wc -l < src/v.mjs; exit 1'"\n---\n# never-green\nx\n`,
  )
  for (const a of [
    ['init', '-q'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['add', '-A'],
    ['commit', '-qm', 'seed'],
  ])
    spawnSync('git', a, { cwd: dir })
  return dir
}

// spawnSync never throws on a non-zero exit, so status/output read directly (no try/catch needed).
function runTemper(dir, ...args) {
  const r = spawnSync('node', [TEMPER, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` }
}

test('--max-iterations overrides cfg.maxIterations for the invocation', () => {
  const dir = seedRepo(5)
  try {
    const r = runTemper(dir, 'run', '.temper/plan.md', '--engine', 'stub', '--max-iterations', '2')
    assert.equal(r.code, 3, r.out) // maxed → exit 3
    assert.match(r.out, /Reached 2 iterations/, r.out)
    assert.doesNotMatch(r.out, /5 iterations/, 'the config value must NOT be used')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--max-iterations rejects a non-positive-integer value before the loop starts', () => {
  const dir = seedRepo(5)
  try {
    for (const bad of ['0', 'abc']) {
      const r = runTemper(dir, 'run', '.temper/plan.md', '--engine', 'stub', '--max-iterations', bad)
      assert.notEqual(r.code, 0, `--max-iterations ${bad} should be rejected: ${r.out}`)
      assert.match(r.out, /must be a positive integer/, r.out)
      assert.doesNotMatch(r.out, /── iteration 1 ──/, 'the loop must not start on a bad value')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
