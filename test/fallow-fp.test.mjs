// fallowUnreachableNewFiles detection: it must identify a NEWLY-ADDED file that fallow reports as
// unreachable (the dynamic-load false-positive) — but NOT fire on other fallow failures (complexity),
// and NOT claim a file that isn't actually new/untracked. Runs against a real throwaway git repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { fallowUnreachableNewFiles } from '../src/gates.mjs'

function inRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-fp-'))
  const cwd = process.cwd()
  try {
    writeFileSync(join(dir, 'index.mjs'), 'export const x = 1\n')
    process.chdir(dir)
    execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=a commit -qm seed', { stdio: 'ignore' })
    return fn(dir)
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

const UNREACHABLE = 'Unused files (1)\n  plugin.mjs\n  Files not reachable from any entry point'

test('flags a new untracked file reported as unreachable', () => {
  inRepo(() => {
    writeFileSync('plugin.mjs', 'export const p = 1\n') // untracked = new this run
    assert.deepEqual(fallowUnreachableNewFiles(UNREACHABLE), ['plugin.mjs'])
  })
})

test('does NOT fire on a non-dead-code fallow failure (e.g. complexity)', () => {
  inRepo(() => {
    writeFileSync('plugin.mjs', 'export const p = 1\n')
    const complexity = 'High complexity: plugin.mjs:1 cyclomatic 12, CRAP 56'
    assert.deepEqual(fallowUnreachableNewFiles(complexity), [], 'no unreachable/unused phrase → not the FP case')
  })
})

test('does NOT claim a file that is not actually new/untracked', () => {
  inRepo(() => {
    // index.mjs is committed (tracked), so even if fallow named it, it is not a NEW file
    const namedTracked = 'Unused files (1)\n  index.mjs\n  Files not reachable from any entry point'
    assert.deepEqual(fallowUnreachableNewFiles(namedTracked), [])
  })
})

test('matches a path as a whole token (a.mjs does not match data.mjs)', () => {
  inRepo(() => {
    writeFileSync('a.mjs', 'export const a = 1\n') // new file named a.mjs
    const namesDifferentFile = 'Unused files (1)\n  data.mjs\n  Files not reachable from any entry point'
    assert.deepEqual(fallowUnreachableNewFiles(namesDifferentFile), [], 'must not substring-match a.mjs inside data.mjs')
  })
})

test('does not match a sibling-directory path (plugin.mjs vs src/plugin.mjs)', () => {
  inRepo(() => {
    writeFileSync('plugin.mjs', 'export const p = 1\n') // untracked root-level plugin.mjs
    const namesNested = 'Unused files (1)\n  src/plugin.mjs\n  Files not reachable from any entry point'
    assert.deepEqual(fallowUnreachableNewFiles(namesNested), [], 'root plugin.mjs must not claim a finding about src/plugin.mjs')
  })
})
