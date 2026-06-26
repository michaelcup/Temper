// `temper audit` is a thin bridge: fallow's dead-code JSON becomes scoped, reviewable cleanup Plans. These
// tests use a FAKE fallow (a node script that prints fixture JSON) so the suite never needs the real binary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')

const temper = (dir, args) => {
  try {
    return { code: 0, out: execFileSync('node', [TEMPER, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function setup(fixture, { withTest = true, fallowCommand } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-audit-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const x = 1\n')
  writeFileSync(join(dir, '.gitignore'), '.temper/\n')
  // fake fallow: prints the fixture as JSON, ignores the dead-code args (like `fallow dead-code --format json`)
  const stub = join(dir, 'fake-fallow.mjs')
  writeFileSync(stub, `console.log(${JSON.stringify(JSON.stringify(fixture))})\n`)
  const cfg = { fallowCommand: fallowCommand ?? `node ${stub}`, engine: 'stub', engines: { stub: { engine: 'true', critic: 'true' } } }
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify(cfg))
  if (withTest) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', type: 'module', scripts: { test: 'node --test' } }))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  return dir
}

const plans = (dir) => readdirSync(join(dir, '.temper', 'audit')).filter((n) => n.endsWith('.md'))
const read = (dir, name) => readFileSync(join(dir, '.temper', 'audit', name), 'utf8')

test('temper audit turns fallow dead-code findings into scoped cleanup Plans (one per file)', () => {
  const dir = setup({
    unused_exports: [{ path: 'src/a.mjs', export_name: 'unusedThing', is_type_only: false, line: 2 }],
    unused_files: [{ path: 'src/orphan.mjs' }],
  })
  try {
    const r = temper(dir, ['audit'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Audit found 1 unused export\(s\) and 1 unused file\(s\)/, 'reports true totals')
    assert.match(r.out, /review each before running/, 'tells the user to review the Plans before running')
    assert.match(r.out, /fallow dupes/, 'points at fallow for duplication/complexity rather than auto-proposing risky refactors')
    const files = plans(dir)
    assert.equal(files.length, 2, 'one Plan per file with dead code')
    const bodies = files.map((f) => read(dir, f))
    const exportPlan = bodies.find((p) => /Remove unused exports/.test(p))
    assert.match(exportPlan, /"src\/a\.mjs"/, 'scoped to the file')
    assert.match(exportPlan, /unusedThing/, 'names the dead export')
    assert.match(exportPlan, /acceptance: "npm test"/, 'acceptance is the repo test command, so a breaking removal fails the gate')
    assert.match(exportPlan, /VERIFY/, 'carries the conservative verify nudge for fallow false positives')
    const filePlan = bodies.find((p) => /Delete unused file/.test(p))
    assert.match(filePlan, /"src\/orphan\.mjs"/, 'the file-delete Plan is scoped to the orphan')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit separates likely false positives (scripts/examples/etc) from cleanup Plans', () => {
  const dir = setup({
    unused_exports: [{ path: 'src/real.mjs', export_name: 'deadReal', is_type_only: false, line: 1 }],
    unused_files: [{ path: 'scripts/seed-dev.mjs' }, { path: 'examples/demo/app.mjs' }],
  })
  try {
    const r = temper(dir, ['audit'])
    assert.equal(r.code, 0, r.out)
    const files = plans(dir)
    assert.equal(files.length, 1, 'only the regular-source finding becomes a cleanup Plan')
    assert.match(read(dir, files[0]), /"src\/real\.mjs"/)
    assert.match(r.out, /Likely false positives/, 'the FP-class findings are surfaced separately')
    assert.match(r.out, /scripts\/seed-dev\.mjs/)
    assert.match(r.out, /examples\/demo\/app\.mjs/)
    assert.doesNotMatch(files.map((f) => read(dir, f)).join('\n'), /seed-dev|examples/, 'no deletion Plan is generated for the FP-class files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit reports nothing to do on a clean codebase', () => {
  const dir = setup({ unused_exports: [], unused_files: [] })
  try {
    const r = temper(dir, ['audit'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /No dead code found/)
    assert.ok(!existsSync(join(dir, '.temper', 'audit')) || plans(dir).length === 0, 'writes no Plans')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit warns and asks for an acceptance command when the repo has no test script', () => {
  const dir = setup({ unused_exports: [{ path: 'src/a.mjs', export_name: 'dead', is_type_only: false, line: 1 }], unused_files: [] }, { withTest: false })
  try {
    const r = temper(dir, ['audit'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /No test command was detected/)
    assert.match(read(dir, plans(dir)[0]), /set `acceptance`/, 'the Plan asks the human to set an acceptance command')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit fails clearly when fallow is not installed', () => {
  const dir = setup({ unused_exports: [], unused_files: [] }, { fallowCommand: 'definitely_not_fallow_zzz' })
  try {
    const r = temper(dir, ['audit'])
    assert.notEqual(r.code, 0)
    assert.match(r.out, /fallow not found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
