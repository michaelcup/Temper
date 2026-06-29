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
import { fileURLToPath } from 'node:url'
import { survivingReferences } from '../src/gates.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPER = join(HERE, '..', 'bin', 'temper.mjs')
const PLANJS = join(HERE, '..', 'src', 'plan.mjs')
const node = (args, cwd) => {
  try {
    return { code: 0, out: execFileSync('node', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

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

test('survivingReferences THROWS on an out-of-repo root instead of silently passing (no false-green)', () => {
  const { dir } = repo()
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    // `..` is outside the repo, so git grep exits 128. The term IS present in the repo; treating a failed
    // search as "no leftovers" would silently disable a safety gate, so it must throw, not return [].
    assert.throws(() => survivingReferences(['external_site.agent_handoff.create'], ['..']), /could not search/)
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validatePlan rejects a removesRoot outside the repo at preflight (the real false-green fix)', () => {
  const { dir } = repo()
  try {
    // validatePlan calls fail() -> process.exit, so exercise it in a child process and read its exit/output.
    const script = `import { validatePlan } from ${JSON.stringify(PLANJS)}; validatePlan({ scope: ['src/keep.ts'], removes: ['x'], removesRoot: ['../evil'], acceptance: null, heldout: null, title: 't', body: 'b' })`
    const r = node(['--input-type=module', '-e', script], dir)
    assert.notEqual(r.code, 0, 'a removesRoot containing .. must be rejected before the loop runs')
    assert.match(r.out, /removesRoot/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper explain removal documents the gate (the stuck banner points users here)', () => {
  const r = node([TEMPER, 'explain', 'removal'], HERE)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Removal-completeness gate/)
  assert.match(r.out, /removes:/)
})
