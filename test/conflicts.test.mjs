// Deterministic scope-conflict detection (src/conflicts.mjs) + the `temper plan-check` gate. The detector
// is a conservative TRIGGER, not a verdict: it must catch two plans that claim a common file, and must NOT
// false-fire across disjoint scopes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globsOverlap, broadScopes, detectScopeConflicts } from '../src/conflicts.mjs'

test('globsOverlap: literals, nested globs, hub files, disjoint dirs', () => {
  assert.equal(globsOverlap('src/x.mjs', 'src/x.mjs'), true, 'identical')
  assert.equal(globsOverlap('src/x.mjs', 'src/y.mjs'), false, 'two different literals')
  assert.equal(globsOverlap('src/x.mjs', 'src/**'), true, 'a literal inside a glob')
  assert.equal(globsOverlap('src/x.mjs', 'test/**'), false, 'a literal outside a glob')
  assert.equal(globsOverlap('src/**', 'src/a/*.mjs'), true, 'nested glob prefixes overlap')
  assert.equal(globsOverlap('src/**', 'test/**'), false, 'disjoint top-level dirs')
  assert.equal(globsOverlap('package.json', '**/*.json'), true, 'a hub file matched by a recursive glob')
  assert.equal(globsOverlap('src/a/*.mjs', 'src/b/*.mjs'), false, 'sibling dirs do not overlap')
})

test('broadScopes flags only repo-wide globs; per-dir recursive globs are fine', () => {
  assert.deepEqual(broadScopes(['**']), ['**'])
  assert.deepEqual(broadScopes(['*']), ['*'])
  assert.deepEqual(broadScopes(['src/**', 'test/**', 'src/util.mjs']), [], 'per-dir recursive + literal scopes are not flagged')
})

test('shared workspace globs (both `test/**`) do not false-conflict; only a shared specific file does', () => {
  const shared = [
    { file: '01.md', plan: { scope: ['src/loop.mjs', 'test/**'] } },
    { file: '02.md', plan: { scope: ['src/engine.mjs', 'test/**'] } },
  ]
  assert.equal(detectScopeConflicts(shared).conflicts.length, 0, 'different src files + a shared test/** = no conflict')
  const contend = [
    { file: '01.md', plan: { scope: ['src/loop.mjs', 'test/**'] } },
    { file: '02.md', plan: { scope: ['src/loop.mjs', 'test/**'] } },
  ]
  assert.equal(detectScopeConflicts(contend).conflicts.length, 1, 'same src file = conflict, despite the shared test/**')
})

test('detectScopeConflicts flags the overlapping pair and ignores disjoint scopes', () => {
  const phases = [
    { file: '01-a.md', plan: { scope: ['src/loop.mjs'] } },
    { file: '02-b.md', plan: { scope: ['src/loop.mjs', 'test/**'] } },
    { file: '03-c.md', plan: { scope: ['docs/**'] } },
  ]
  const { conflicts } = detectScopeConflicts(phases)
  assert.equal(conflicts.length, 1, 'only 01 ↔ 02 overlap (on src/loop.mjs)')
  assert.equal(conflicts[0].a, '01-a.md')
  assert.equal(conflicts[0].b, '02-b.md')
})

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')
function planCheck(dir) {
  try {
    return { code: 0, out: execFileSync('node', [TEMPER, 'plan-check', dir], { encoding: 'utf8' }) }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
function queue(plans) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-planchk-'))
  mkdirSync(join(dir, 'phases'))
  plans.forEach(([name, scope], i) => {
    const sc = scope.map((s) => `  - "${s}"`).join('\n')
    writeFileSync(join(dir, 'phases', `0${i + 1}-${name}.md`), `---\nscope:\n${sc}\nacceptance: "true"\n---\n# ${name}\nx\n`)
  })
  return join(dir, 'phases')
}

test('temper plan-check exits non-zero and names the overlap when two plans claim a file', () => {
  const dir = queue([
    ['one', ['src/loop.mjs']],
    ['two', ['src/loop.mjs']],
  ])
  try {
    const r = planCheck(dir)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /scope overlap/)
    assert.match(r.out, /src\/loop\.mjs/)
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true })
  }
})

test('temper plan-check passes (exit 0) when scopes are disjoint', () => {
  const dir = queue([
    ['one', ['src/loop.mjs']],
    ['two', ['src/engine.mjs']],
  ])
  try {
    const r = planCheck(dir)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /no scope conflicts/)
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true })
  }
})
