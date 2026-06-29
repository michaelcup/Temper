// The research ledger writer: a deterministic, engine-free append into one living markdown file per repo.
// It seeds a fixed header on first run, appends findings + candidate sources newest-first, sanitizes all
// engine text, validates each element, and never touches trust-list.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendResearch } from '../src/research.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'temper-research-'))
const F = (over = {}) => ({ claim: 'C', support: 'high', sources: ['a'], note: 'N', ...over })

test('appendResearch seeds the fixed header and three sections on first run', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'research.md')
    appendResearch(p, 'myrepo', [F()])
    assert.ok(existsSync(p))
    const t = readFileSync(p, 'utf8')
    assert.match(t, /^# Research ledger: myrepo/m)
    assert.match(t, /^## Sources/m)
    assert.match(t, /^## Findings/m)
    assert.match(t, /^## Open questions/m)
    assert.match(t, /- \*\*C\*\*\. Support: high\. Sources: \[a\]\. N/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendResearch appends, never respawns (both findings present, header once)', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'research.md')
    appendResearch(p, 'r', [F({ claim: 'first' })])
    appendResearch(p, 'r', [F({ claim: 'second' })])
    const t = readFileSync(p, 'utf8')
    assert.match(t, /first/)
    assert.match(t, /second/)
    assert.equal((t.match(/^# Research ledger:/gm) || []).length, 1, 'header appears exactly once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a finding records support and cites sources, with NO per-bullet trust field', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'research.md')
    appendResearch(p, 'r', [F({ claim: 'X', support: 'medium', sources: ['a', 'b'], note: 'why.' })])
    const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('- **X**'))
    assert.equal(line, '- **X**. Support: medium. Sources: [a], [b]. why.')
    assert.doesNotMatch(line, /trust/i, 'trust is resolved from the Sources table, never duplicated on a finding')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a candidate source is appended under Sources, marked, as a bullet (not a table row)', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'research.md')
    appendResearch(p, 'r', [], [{ source: 'kentcdodds.com', trust: 'high', why: 'named expert' }])
    const t = readFileSync(p, 'utf8')
    assert.match(t, /<!-- CANDIDATE/)
    assert.match(t, /- candidate: kentcdodds\.com \| high \| named expert/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('engine text is sanitized: a pipe / newline / heading / fence cannot inject structure', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'research.md')
    appendResearch(p, 'r', [F({ claim: 'Z', note: 'a | b\n## fake heading\n```evil' })])
    const t = readFileSync(p, 'utf8')
    const line = t.split('\n').find((l) => l.startsWith('- **Z**'))
    assert.ok(line && !line.includes('\n'), 'the note stays on one line')
    assert.match(line, /a \\\| b/, 'a raw pipe is escaped')
    assert.equal((t.match(/^## /gm) || []).length, 3, 'still exactly three section headings, none injected')
    assert.doesNotMatch(t, /```/, 'no code fence injected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed finding (no claim) is skipped; prior content is intact', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'research.md')
    appendResearch(p, 'r', [F({ claim: 'keep' })])
    const before = readFileSync(p, 'utf8')
    appendResearch(p, 'r', [{ support: 'high', sources: ['a'] }]) // no claim
    assert.equal(readFileSync(p, 'utf8'), before, 'nothing valid to add leaves the file untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendResearch never writes trust-list.md', () => {
  const dir = tmp()
  try {
    const trust = join(dir, 'trust-list.md')
    writeFileSync(trust, 'ORIGINAL')
    appendResearch(join(dir, 'research.md'), 'r', [F()], [{ source: 's', trust: 'high', why: 'w' }])
    assert.equal(readFileSync(trust, 'utf8'), 'ORIGINAL', 'the trust-list is human-owned and never written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import { runDirectionCheck } from '../src/engine.mjs'
import { DEFAULTS } from '../src/config.mjs'

// Build a complete cfg (real DEFAULTS so rateLimit etc. exist) with a stub critic that echoes fixed JSON.
const cfgWith = (json, ledger = true) => ({
  ...DEFAULTS,
  criticCommand: `echo '${json}'`,
  directionCheck: { ...DEFAULTS.directionCheck, enabled: true, sources: ['x'], ledger },
})

test('runDirectionCheck parses optional findings + candidateSources when ledger is on', () => {
  const json = '{"sound":true,"concern":"none","source":"none","findings":[{"claim":"C","support":"high","sources":["a"],"note":"N"}],"candidateSources":[{"source":"k","trust":"high","why":"w"}]}'
  const d = runDirectionCheck(cfgWith(json), { body: 'p' }, { trustList: '', priorLedger: '' })
  assert.equal(d.sound, true)
  assert.equal(d.findings.length, 1)
  assert.equal(d.findings[0].claim, 'C')
  assert.equal(d.candidateSources[0].source, 'k')
})

test('runDirectionCheck fail-opens to sound:true with empty arrays on non-JSON', () => {
  const d = runDirectionCheck(cfgWith('not json at all'), { body: 'p' }, {})
  assert.equal(d.sound, true)
  assert.deepEqual(d.findings, [])
  assert.deepEqual(d.candidateSources, [])
})

test('a valid sound:false verdict is honored even when findings is garbage (best-effort never downgrades the verdict)', () => {
  const json = '{"sound":false,"concern":"bad","source":"s","findings":"oops-not-an-array"}'
  const d = runDirectionCheck(cfgWith(json), { body: 'p' }, {})
  assert.equal(d.sound, false)
  assert.deepEqual(d.findings, [])
})
