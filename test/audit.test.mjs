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

function setup(fixture, { withTest = true, fallowCommand, extraFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-audit-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const x = 1\n')
  for (const [rel, body] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
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

test('temper audit quarantines a dynamically-imported file (fallow false-positive) instead of proposing its deletion', () => {
  const dir = setup(
    { unused_exports: [], unused_files: [{ path: 'src/Widget.mjs' }] },
    { extraFiles: { 'src/Widget.mjs': 'export const Widget = () => null\n', 'src/host.mjs': "export const w = () => import('./Widget')\n" } },
  )
  try {
    const r = temper(dir, ['audit'])
    assert.equal(r.code, 0, r.out)
    // fallow flagged Widget.mjs as unused, but it is loaded via import('./Widget'); deleting it would break the dynamic import.
    assert.match(r.out, /Likely false positives/, 'the dynamic-import target is surfaced as a likely FP, not a cleanup Plan')
    assert.match(r.out, /dynamically imported/, 'the message explains the dynamic-import reason')
    const proposed = (existsSync(join(dir, '.temper', 'audit')) ? plans(dir) : []).map((f) => read(dir, f)).join('\n')
    assert.doesNotMatch(proposed, /Widget/, 'no deletion Plan is generated for the dynamically-imported file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit caps Plans at 25 by default; --all and --limit lift the cap', () => {
  const unused_files = Array.from({ length: 30 }, (_, i) => ({ path: `src/orphan${i}.mjs` }))
  const dir = setup({ unused_exports: [], unused_files })
  try {
    const def = temper(dir, ['audit'])
    assert.equal(def.code, 0, def.out)
    assert.equal(plans(dir).length, 25, 'default caps at 25')
    assert.match(def.out, /temper audit --all/, 'tells the user to run --all for the rest, not to re-run')

    const all = temper(dir, ['audit', '--all'])
    assert.equal(all.code, 0, all.out)
    assert.equal(plans(dir).length, 30, '--all writes a Plan for every finding')

    const limited = temper(dir, ['audit', '--limit', '5'])
    assert.equal(limited.code, 0, limited.out)
    assert.equal(plans(dir).length, 5, '--limit n writes n Plans')
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

test('temper audit --json prints machine-readable findings and writes no Plans', () => {
  const dir = setup({
    unused_exports: [{ path: 'src/real.mjs', export_name: 'deadReal', is_type_only: false, line: 1 }],
    unused_files: [{ path: 'scripts/seed-dev.mjs' }],
  })
  try {
    const r = temper(dir, ['audit', '--json'])
    assert.equal(r.code, 0, r.out)
    const out = JSON.parse(r.out)
    assert.equal(out.unused_exports, 1)
    assert.equal(out.unused_files, 1)
    assert.equal(out.files_with_findings, 2)
    assert.deepEqual(out.high_confidence_cleanups, [{ path: 'src/real.mjs', exports: ['deadReal'] }])
    assert.deepEqual(out.likely_false_positives, [{ path: 'scripts/seed-dev.mjs' }])
    assert.ok(!existsSync(join(dir, '.temper', 'audit')) || plans(dir).length === 0, 'writes no Plans')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit --json on a clean codebase prints valid empty JSON, not the log line', () => {
  const dir = setup({ unused_exports: [], unused_files: [] })
  try {
    const r = temper(dir, ['audit', '--json'])
    assert.equal(r.code, 0, r.out)
    const out = JSON.parse(r.out)
    assert.equal(out.unused_exports, 0)
    assert.equal(out.unused_files, 0)
    assert.equal(out.files_with_findings, 0)
    assert.deepEqual(out.high_confidence_cleanups, [])
    assert.deepEqual(out.likely_false_positives, [])
    assert.doesNotMatch(r.out, /No dead code found/)
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

test('temper audit --acceptance overrides each Plan gate and probes a GREEN baseline', () => {
  const dir = setup({ unused_exports: [{ path: 'src/a.mjs', export_name: 'dead', is_type_only: false, line: 1 }], unused_files: [] })
  try {
    const r = temper(dir, ['audit', '--acceptance', 'true'])
    assert.equal(r.code, 0, r.out)
    assert.match(read(dir, plans(dir)[0]), /acceptance: "true"/, 'the override becomes each Plan gate (not the detected npm test)')
    assert.match(r.out, /probing the acceptance baseline/, 'it probes the baseline')
    assert.match(r.out, /Then: temper overnight/, 'green baseline still suggests overnight')
    assert.doesNotMatch(r.out, /already FAILING/, 'green baseline raises no warning')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit warns when the acceptance baseline is already RED (overnight would skip everything)', () => {
  const dir = setup({ unused_exports: [{ path: 'src/a.mjs', export_name: 'dead', is_type_only: false, line: 1 }], unused_files: [] })
  try {
    const r = temper(dir, ['audit', '--acceptance', 'false'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /already FAILING/, 'a red baseline gets a prominent warning')
    assert.doesNotMatch(r.out, /Then: temper overnight/, 'and does NOT suggest overnight, which would skip every Plan')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit --acceptance rejects a non-runnable override before scanning', () => {
  const dir = setup({ unused_exports: [{ path: 'src/a.mjs', export_name: 'dead', is_type_only: false, line: 1 }], unused_files: [] })
  try {
    const r = temper(dir, ['audit', '--acceptance', 'definitelynotacmd_zzz --x'])
    assert.notEqual(r.code, 0)
    assert.match(r.out, /isn't runnable|not on your PATH/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper audit --acceptance with no command is rejected (a bare flag would make every Plan always-green)', () => {
  const dir = setup({ unused_exports: [{ path: 'src/a.mjs', export_name: 'dead', is_type_only: false, line: 1 }], unused_files: [] })
  try {
    const r = temper(dir, ['audit', '--acceptance'])
    assert.notEqual(r.code, 0)
    assert.match(r.out, /needs a command/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
