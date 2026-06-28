// The removal-completeness gate's primitive: survivingReferences runs `git grep -F` (fixed strings, no
// shell) over the working tree (tracked + untracked) and returns the declared-removed terms that still
// appear. It is the deletion-side mirror of the scope allowlist — it catches string references (op-ids in
// contracts/specs/docs) that typecheck and tests cannot see.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { survivingReferences } from '../src/gates.mjs'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'temper-removal-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  const w = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  w('src/keep.ts', 'export const KEEP = 1\n')
  w('docs/contract.md', '- op: external_site.agent_handoff.create\n') // a string ref typecheck cannot see
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  w('src/untracked.ts', 'const x = external_site.agent_handoff.create\n') // not committed — must still be seen
  return { dir, w }
}

test('survivingReferences finds a removed term in tracked AND untracked files; ignores absent terms', () => {
  const { dir } = repo()
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    const hits = survivingReferences(['external_site.agent_handoff.create', 'NOT_PRESENT_ZZZ'], ['.'])
    assert.equal(hits.length, 1, 'only the present term is returned')
    assert.equal(hits[0].term, 'external_site.agent_handoff.create')
    assert.deepEqual(hits[0].files, ['docs/contract.md', 'src/untracked.ts'], 'tracked + untracked, sorted')
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('survivingReferences honors removesRoot scoping and uses fixed-string (not regex) matching', () => {
  const { dir, w } = repo()
  const cwd = process.cwd()
  try {
    w('src/literal.ts', 'const re = "a.b"\n') // `a.b` as a literal; a regex `a.b` would also match `axb`
    w('src/axb.ts', 'const other = "axb"\n')
    process.chdir(dir)
    // Scoped to docs/: the src/ hit is excluded.
    assert.deepEqual(survivingReferences(['external_site.agent_handoff.create'], ['docs']), [
      { term: 'external_site.agent_handoff.create', files: ['docs/contract.md'] },
    ])
    // Fixed-string: `a.b` matches only the literal, not `axb`.
    assert.deepEqual(survivingReferences(['a.b'], ['src']), [{ term: 'a.b', files: ['src/literal.ts'] }])
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
})
