# Research Ledger + Trust-List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Temper's opt-in overnight direction check into a living research ledger: one appended-not-respawned markdown file per repo that records each finding's support level and sources, plus a durable user-curated trust-list the check is biased toward.

**Architecture:** A new deterministic module `src/research.mjs` owns the ledger format and the append writer. `src/engine.mjs`'s existing `runDirectionCheck` gains an optional, best-effort findings/candidate-sources contract (the verdict stays authoritative and fail-open is unchanged). `src/phases.mjs` reads the trust-list and prior ledger, passes them into the check, and calls the new writer immediately after the check and before the pause-exit, so every run (sound, warn, or pause) records. Opt-in via one config key; all paths derived under `.temper/`.

**Tech Stack:** Node.js ESM, zero runtime dependencies, `node:test` + `node:assert/strict`. Tests use the existing throwaway-git-repo + fake-engine (stub critic that `echo`s a fixed JSON line) pattern.

## Global Constraints

- Zero new runtime dependencies. Reuse `node:fs` / `node:path` and existing helpers only.
- Opt-in and OFF by default: `directionCheck.ledger` defaults to `false`; behavior is byte-identical to today when off.
- The direction verdict stays authoritative. `findings` / `candidateSources` are strictly best-effort: missing or non-array means empty; a malformed payload never downgrades a valid `sound:false` and never blocks the queue. Verdict acceptance stays `typeof v.sound === 'boolean'`, else fail-open to `{ sound: true }`.
- Paths are derived, not configured: ledger = `join(dirname(cfg.progressFile), 'research.md')`, trust-list = `join(dirname(cfg.progressFile), 'trust-list.md')`. No new path config keys.
- Temper never writes `trust-list.md`. The writer only ever writes the ledger.
- All engine-supplied text is sanitized before it enters the ledger (escape `|`, collapse newlines, neutralize backticks and fences, strip a leading heading marker), so it can never corrupt the table or inject document structure.
- The suite must stay green at every commit. Run `npm test` before each commit.
- Prose voice in code comments, docs, and the ledger format: plain declarative sentences. No em dashes, no rhetorical questions, no sentence-fragment asides.

---

### Task 1: Move `mdCell` to `src/sh.mjs` so the ledger writer can reuse it

`mdCell` (markdown-cell sanitization) currently lives in `src/phases.mjs:89`. The new `src/research.mjs` must reuse it, but `phases.mjs` will import `research.mjs`, so `mdCell` must live in a module both can import without a cycle. `src/sh.mjs` is the shared-primitives module and the correct home. This task has no behavior change; the existing report tests are its gate.

**Files:**
- Modify: `src/sh.mjs` (add and export `mdCell`)
- Modify: `src/phases.mjs:7` (import `mdCell` from `./sh.mjs`), `src/phases.mjs:89` (remove the local definition)

**Interfaces:**
- Produces: `export const mdCell = (s) => string` in `src/sh.mjs` — one-line, pipe-escaped, fence-safe markdown cell text.

- [ ] **Step 1: Add `mdCell` to `src/sh.mjs`**

Add near the other string helpers (after the `run`/`runArgs` block is fine):

```js
// Neutralize markdown-structure chars so arbitrary text (a plan title, command output, an engine
// finding) can't break a table or inject headings/fences. One line, no raw pipes, no backticks.
export const mdCell = (s) => String(s).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'")
```

- [ ] **Step 2: Import it in `src/phases.mjs` and delete the local copy**

Change the `./sh.mjs` import (line 7) to include `mdCell`:

```js
import { run, runArgs, log, git, fail, requireCleanRepo, acquireLock, notify, state, mdCell } from './sh.mjs'
```

Delete the local definition (the comment block and the `const mdCell = ...` line at `src/phases.mjs:87-89`).

- [ ] **Step 3: Run the suite to verify no regression**

Run: `npm test`
Expected: PASS, same count as before this task (the report tests exercise `mdCell` and must stay green).

- [ ] **Step 4: Commit**

```bash
git add src/sh.mjs src/phases.mjs
git commit -m "refactor: move mdCell to sh.mjs so the research writer can share it"
```

---

### Task 2: `src/research.mjs` — the deterministic ledger writer

The core of the feature: a pure, engine-free module that seeds and appends the ledger. Fully unit-tested.

**Files:**
- Create: `src/research.mjs`
- Test: `test/research-ledger.test.mjs`

**Interfaces:**
- Consumes: `mdCell` from `src/sh.mjs` (Task 1).
- Produces: `export function appendResearch(ledgerPath, repoName, findings = [], candidateSources = [])` — appends valid findings under `## Findings` and valid candidate sources under `## Sources`, seeding the file from a fixed header if absent. Returns nothing. A finding needs a non-empty string `claim`; a candidate needs a non-empty string `source`. `finding` shape: `{ claim, support: 'high'|'medium'|'low', sources: string[], note }`. `candidate` shape: `{ source, trust: 'high'|'medium'|'low', why }`.

- [ ] **Step 1: Write the failing test**

Create `test/research-ledger.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/research-ledger.test.mjs`
Expected: FAIL with a module-not-found error for `../src/research.mjs`.

- [ ] **Step 3: Write the implementation**

Create `src/research.mjs`:

```js
// The research ledger: one living markdown file per repo that the opt-in direction check appends to.
// Deterministic and engine-free. It seeds a fixed header on first run, inserts findings + candidate
// sources newest-first under their section headers, sanitizes every engine-supplied string, validates
// each element, and never rewrites prior content or touches trust-list.md.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { mdCell } from './sh.mjs'

// The seed-vs-append decision keys off this stable marker, not the (variable) title line.
const LEDGER_MARKER = '# Research ledger:'

const seedLedger = (repoName) =>
  `# Research ledger: ${mdCell(repoName)}\n\n` +
  '> One living document. Appended across direction-check runs, never respawned.\n' +
  '> Source trust is durable and lives in the table below (and in trust-list.md).\n' +
  '> Finding support is per-claim and recomputed each run.\n\n' +
  '## Sources\n\n' +
  '| Source | Trust | Why trusted |\n| --- | --- | --- |\n\n' +
  '## Findings\n\n' +
  '## Open questions\n'

// mdCell handles pipes/newlines/backticks; additionally drop a leading heading marker and any fence so
// engine text can never inject document structure into a bullet.
const clean = (s) => mdCell(s).replace(/^#+\s*/, '').replace(/```/g, "'''")
const level = (v) => (/^(high|medium|low)$/.test(v) ? v : 'low')

const renderFinding = (f) => {
  const sources = (Array.isArray(f.sources) ? f.sources : []).map((s) => `[${clean(s)}]`).join(', ')
  const note = f.note ? ` ${clean(f.note)}` : ''
  return `- **${clean(f.claim)}**. Support: ${level(f.support)}.${sources ? ` Sources: ${sources}.` : ''}${note}`
}

const renderCandidate = (c) =>
  '<!-- CANDIDATE: proposed by the direction check. Verify against the rubric, then move into the table above and into trust-list.md to confirm. -->\n' +
  `- candidate: ${clean(c.source)} | ${level(c.trust)} | ${clean(c.why ?? '')}`

// Insert block immediately after the line that exactly matches header (newest-first). If the header is
// absent (a hand-mangled file), append a fresh section at end of file so nothing is lost.
const insertAfterHeader = (text, header, block) => {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trim() === header)
  if (i === -1) return `${text.replace(/\n*$/, '')}\n\n${header}\n\n${block}\n`
  lines.splice(i + 1, 0, '', block)
  return lines.join('\n')
}

export function appendResearch(ledgerPath, repoName, findings = [], candidateSources = []) {
  const goodFindings = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f.claim === 'string' && f.claim.trim())
  const goodCandidates = (Array.isArray(candidateSources) ? candidateSources : []).filter((c) => c && typeof c.source === 'string' && c.source.trim())
  if (!goodFindings.length && !goodCandidates.length) return // nothing valid to record (e.g. a fail-open verdict)
  let text = seedLedger(repoName)
  if (existsSync(ledgerPath)) {
    const existing = readFileSync(ledgerPath, 'utf8')
    if (existing.includes(LEDGER_MARKER)) text = existing
  }
  for (const f of goodFindings) text = insertAfterHeader(text, '## Findings', renderFinding(f))
  for (const c of goodCandidates) text = insertAfterHeader(text, '## Sources', renderCandidate(c))
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileSync(ledgerPath, text)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/research-ledger.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (prior count + 7).

- [ ] **Step 6: Commit**

```bash
git add src/research.mjs test/research-ledger.test.mjs
git commit -m "feat: research ledger writer (appendResearch) with seed/append/sanitize"
```

---

### Task 3: Extend `runDirectionCheck` with the optional ledger contract

The single existing critic call gains an optional findings/candidate-sources output, only when `directionCheck.ledger` is on. The verdict stays authoritative and fail-open is unchanged.

**Files:**
- Modify: `src/engine.mjs:176-193` (`runDirectionCheck`)
- Test: `test/research-ledger.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `runDirectionCheck(cfg, plan, { trustList = '', priorLedger = '' } = {})` now returns `{ sound, concern, source, findings: object[], candidateSources: object[] }`. `findings` / `candidateSources` are always arrays (empty when off or fail-open).

- [ ] **Step 1: Write the failing tests**

Append to `test/research-ledger.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/research-ledger.test.mjs`
Expected: FAIL — the current `runDirectionCheck` returns no `findings` / `candidateSources` keys, so `d.findings.length` throws / `deepEqual` fails.

- [ ] **Step 3: Implement the extension**

Replace `runDirectionCheck` in `src/engine.mjs` (lines 176-193) with:

```js
export function runDirectionCheck(cfg, plan, { trustList = '', priorLedger = '' } = {}) {
  const dc = cfg.directionCheck
  const trustBlock = dc.ledger && trustList
    ? 'You also have a curated TRUST-LIST (durable per-source trust). Prefer these sources and respect their levels:\n' + trustList + '\n\n'
    : ''
  const ledgerBlock = dc.ledger && priorLedger
    ? 'These findings are ALREADY in the research ledger. Do NOT repeat them; add only new findings:\n' + priorLedger + '\n\n'
    : ''
  const ledgerAsk = dc.ledger
    ? ' In the SAME JSON object also include "findings": an array of {"claim": "...", "support": "high|medium|low", "sources": ["id", ...], "note": "one sentence"} for what you learned, and "candidateSources": an array of {"source": "id", "trust": "high|medium|low", "why": "..."} for any source you leaned on that is not already trusted. Use [] for either if you have nothing to add.'
    : ''
  const prompt =
    'You are checking whether a planned change takes the RIGHT APPROACH, not whether it is well-written, but' +
    'whether its PREMISE is sound and current. Below is the PLAN for an upcoming task.\n\n' +
    'Ground your judgment ONLY in these trusted sources (read local file paths directly; fetch URLs only if you ' +
    'have web tools). Do NOT free-browse the open web. If the sources are silent on this plan, return sound:true:\n' +
    dc.sources.map((s) => `  - ${s}`).join('\n') + '\n\n' +
    trustBlock +
    ledgerBlock +
    'Flag a direction-miss ONLY if a trusted source shows the plan relies on something deprecated, superseded, ' +
    'removed, or contradicted (a gone API, an outdated pattern, a false assumption). NEVER flag style, scope, ' +
    'naming, or "could be better"; flag only a concrete, sourced wrong-direction.\n\n' +
    'Reply with ONLY a JSON object as the LAST line, no prose: ' +
    '{"sound": boolean, "concern": "one sentence, or none", "source": "which trusted source shows it, or none"}.' + ledgerAsk + '\n\n' +
    `PLAN:\n${plan.body}\n`
  const { out } = callCli(cfg.criticCommand, prompt, cfg)
  const v = lastJsonObject(out)
  if (v && typeof v.sound === 'boolean') {
    return {
      sound: v.sound,
      concern: v.concern ?? 'none',
      source: v.source ?? 'none',
      findings: Array.isArray(v.findings) ? v.findings : [],
      candidateSources: Array.isArray(v.candidateSources) ? v.candidateSources : [],
    }
  }
  return { sound: true, concern: 'none', source: 'none', findings: [], candidateSources: [] } // fail-OPEN
}
```

When `dc.ledger` is false, `trustBlock` / `ledgerBlock` / `ledgerAsk` are all empty and the prompt is identical to today; the two extra empty-array return fields are ignored by the existing caller.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/research-ledger.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the full suite (the existing direction-check tests must stay green)**

Run: `npm test`
Expected: PASS. The Mode B warn/pause direction tests still pass because the verdict path is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/engine.mjs test/research-ledger.test.mjs
git commit -m "feat: optional best-effort ledger contract in runDirectionCheck (verdict unchanged)"
```

---

### Task 4: Wire the ledger into the queue + add the config key

Add the opt-in key, read the trust-list and prior ledger, pass them into the check, and append the result before the pause-exit.

**Files:**
- Modify: `src/config.mjs:70` (add `ledger: false`)
- Modify: `src/phases.mjs:10` (import `appendResearch`), `src/phases.mjs:306-336` (the direction-check block)
- Test: `test/modeb.test.mjs` (extend)

**Interfaces:**
- Consumes: `appendResearch` (Task 2), `runDirectionCheck(cfg, plan, { trustList, priorLedger })` (Task 3).
- Produces: an opt-in `directionCheck.ledger` that maintains `.temper/research.md` during an overnight run.

- [ ] **Step 1: Write the failing integration tests**

Append to `test/modeb.test.mjs`:

```js
test('overnight with directionCheck.ledger writes a research ledger; ledger:false writes none', () => {
  const critic = `echo '{"sound":true,"concern":"none","source":"none","findings":[{"claim":"createRoot replaces ReactDOM.render","support":"high","sources":["react.dev"],"note":"verified."}],"candidateSources":[]}'`
  const on = setup(
    baseCfg({ engines: { stub: { engine: APPEND_ENGINE, critic } }, directionCheck: { enabled: true, sources: ['docs/api.md'], every: 1, onMiss: 'warn', ledger: true } }),
    [['one', 'x']],
  )
  try {
    const r = temper(on, ['overnight', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out)
    const ledger = join(on, '.temper', 'research.md')
    assert.ok(existsSync(ledger), 'ledger:true writes the research ledger')
    assert.match(readFileSync(ledger, 'utf8'), /createRoot replaces ReactDOM\.render/)
    assert.match(readFileSync(ledger, 'utf8'), /Support: high\. Sources: \[react\.dev\]/)
  } finally {
    rmSync(on, { recursive: true, force: true })
  }
  const off = setup(
    baseCfg({ engines: { stub: { engine: APPEND_ENGINE, critic } }, directionCheck: { enabled: true, sources: ['docs/api.md'], every: 1, onMiss: 'warn' } }),
    [['one', 'x']],
  )
  try {
    temper(off, ['overnight', '.temper/phases', '--engine', 'stub'])
    assert.ok(!existsSync(join(off, '.temper', 'research.md')), 'ledger is opt-in: OFF writes no file')
  } finally {
    rmSync(off, { recursive: true, force: true })
  }
})

test('with ledger on, a valid pause verdict still pauses (exit 7) and records the finding before exit', () => {
  const critic = `echo '{"sound":false,"concern":"superseded pattern","source":"SPEC.md","findings":[{"claim":"pattern X is superseded","support":"high","sources":["SPEC.md"],"note":"use Y."}]}'`
  const dir = setup(
    baseCfg({ engines: { stub: { engine: APPEND_ENGINE, critic } }, directionCheck: { enabled: true, sources: ['SPEC.md'], every: 1, onMiss: 'pause', ledger: true } }),
    [['one', 'x'], ['two', 'y']],
  )
  try {
    const r = temper(dir, ['overnight', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 7, r.out) // verdict still authoritative
    assert.match(readFileSync(join(dir, '.temper', 'research.md'), 'utf8'), /pattern X is superseded/, 'the paused phase still recorded its finding (write precedes the exit)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with ledger on, non-JSON critic output fails open (commits) and writes no ledger content', () => {
  const dir = setup(
    baseCfg({ engines: { stub: { engine: APPEND_ENGINE, critic: `echo 'totally not json'` } }, directionCheck: { enabled: true, sources: ['docs/api.md'], every: 1, onMiss: 'pause', ledger: true } }),
    [['one', 'x']],
  )
  try {
    const r = temper(dir, ['overnight', '.temper/phases', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // fail-open: a glitch never blocks the queue
    assert.ok(!existsSync(join(dir, '.temper', 'research.md')), 'a fail-open verdict appends nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/modeb.test.mjs`
Expected: FAIL — `research.md` is never written (no wiring yet), so the first two tests fail on the `existsSync` / `match` assertions.

- [ ] **Step 3: Add the config key**

In `src/config.mjs`, change line 70 to:

```js
  directionCheck: { enabled: false, sources: [], every: 1, onMiss: 'warn', ledger: false },
```

The existing deep-merge at line 84 already covers the nested key. Update the comment block above (lines 61-69) to add one sentence: `ledger: true (opt-in) maintains a living research ledger at .temper/research.md, biased to .temper/trust-list.md.`

- [ ] **Step 4: Import the writer in `src/phases.mjs`**

Add to the imports (after line 11):

```js
import { appendResearch } from './research.mjs'
```

- [ ] **Step 5: Wire the reads, the pass-through, and the append**

Replace the direction-check block body in `src/phases.mjs` (lines 312-314, from the `if (opts.overnight ...)` opener through the `const d = runDirectionCheck(cfg, plan)` line) with:

```js
    if (opts.overnight && dc.enabled && dc.sources.length && n % dc.every === 0) {
      log(`• direction check: grounding the approach against ${dc.sources.length} trusted source(s)…`)
      const researchPath = join(dirname(cfg.progressFile), 'research.md')
      let trustList = ''
      let priorLedger = ''
      if (dc.ledger) {
        const trustPath = join(dirname(cfg.progressFile), 'trust-list.md')
        trustList = existsSync(trustPath) ? readFileSync(trustPath, 'utf8') : ''
        priorLedger = existsSync(researchPath) ? readFileSync(researchPath, 'utf8') : ''
      }
      const d = runDirectionCheck(cfg, plan, { trustList, priorLedger })
      // Append BEFORE the pause branch below: the pause path calls process.exit(7), so a write placed
      // after it would skip the very phase that triggered the concern. Runs on sound, warn, and pause alike.
      if (dc.ledger) appendResearch(researchPath, basename(process.cwd()), d.findings, d.candidateSources)
```

Leave the rest of the block (`if (!d.sound) { ... }` through its close) exactly as it is. `existsSync`, `readFileSync`, `join`, `dirname`, and `basename` are already imported (lines 4-5).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/modeb.test.mjs`
Expected: PASS (prior count + 3).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.mjs src/phases.mjs test/modeb.test.mjs
git commit -m "feat: wire the research ledger into the overnight direction check (opt-in)"
```

---

### Task 5: Document the feature (EXPLAIN + README)

Make the feature discoverable and explain it where users already look.

**Files:**
- Modify: `bin/temper.mjs` (the `EXPLAIN['direction']` entry)
- Modify: `README.md` (the `directionCheck` config example + a short "Research ledger" section)
- Test: `test/research-ledger.test.mjs` (extend with a `temper explain direction` assertion)

**Interfaces:**
- Consumes: nothing. Documentation only.

- [ ] **Step 1: Write the failing test**

Append to `test/research-ledger.test.mjs` (reuse the existing `execFileSync` import; add a small CLI runner):

```js
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')
const runCli = (args) => {
  try {
    return { code: 0, out: execFileSync('node', [TEMPER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('temper explain direction mentions the research ledger and trust-list', () => {
  const r = runCli(['explain', 'direction'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /research ledger/i)
  assert.match(r.out, /trust-list/i)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/research-ledger.test.mjs`
Expected: FAIL — the current `EXPLAIN['direction']` does not mention the ledger or trust-list.

- [ ] **Step 3: Extend the EXPLAIN entry**

In `bin/temper.mjs`, replace the `direction` EXPLAIN entry with:

```js
  direction: ['Direction check paused the queue (exit 7, overnight)', "A pre-phase direction check found the upcoming phase's APPROACH contradicts a trusted source (deprecated / superseded / wrong premise) and directionCheck.onMiss is \"pause\".", 'Review the approach against the cited source, fix the Plan, then resume. Set directionCheck.onMiss to "warn" to flag it in the report instead of pausing. With directionCheck.ledger on, each run also appends findings and proposed sources to a living research ledger at .temper/research.md, biased to the sources you curate in .temper/trust-list.md.'],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/research-ledger.test.mjs`
Expected: PASS.

- [ ] **Step 5: Update the README**

In `README.md`, find the `directionCheck` config example and add `"ledger": true` to it. Then add this section after the direction-check description:

```markdown
### Research ledger (opt-in)

With `directionCheck.ledger: true`, each overnight direction check appends to one living research
document at `.temper/research.md` instead of producing throwaway notes. Every finding records a
situational **support** level and cites its **sources**; durable per-source **trust** lives in a
`## Sources` table and in `.temper/trust-list.md`, a list you curate. When a run leans on a source you
have not yet trusted, it is proposed as a marked candidate for you to confirm by hand. Temper never
writes the trust-list. The ledger is appended, never respawned, and you prune it yourself.
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bin/temper.mjs README.md test/research-ledger.test.mjs
git commit -m "docs: explain the research ledger in temper explain direction + README"
```

---

## Self-Review

**Spec coverage** (each spec section maps to a task):
- §2 ledger format → Task 2 (`seedLedger`, `renderFinding`, the grammar) + tested.
- §3 trust-list + rubric + propose-to-add → Task 2 (`renderCandidate`, the candidate marker), Task 4 (the check reads the trust-list), Task 5 (README documents the rubric/flow). The rubric prose lives in the README and the engine prompt, not in code, by design.
- §4 integration (one config key, derived paths, file I/O in phases, prompt-only engine, verdict fail-open, insertion before pause-exit, sanitization) → Tasks 3 + 4.
- §5 data flow → Task 4 wiring.
- §6 edge cases (no trust-list, no ledger, low-support, malformed, injection, growth, gitignored) → Task 2 tests (malformed, injection), Task 4 tests (fail-open, opt-in-off), and `.temper/` derivation (Task 4). Growth is an owned non-goal (no prune code).
- §7 YAGNI (no dedup, no scoring, no fetch pipeline) → honored: no dedup code, no new deps.
- §8 testing → Tasks 2-5 tests.
- §9 touch-points → Tasks 1-5 cover every file, with the one refinement that `appendResearch` lives in a new `src/research.mjs` (focused, testable) rather than inside `phases.mjs`, and `mdCell` moves to `sh.mjs` to support that.

**Placeholder scan:** none. Every code step shows complete code; every run step shows the command and expected result.

**Type consistency:** `appendResearch(ledgerPath, repoName, findings, candidateSources)` is defined in Task 2 and called with that exact arity in Task 4. `runDirectionCheck(cfg, plan, { trustList, priorLedger })` is defined in Task 3 and called with that shape in Task 4. Finding shape `{ claim, support, sources, note }` and candidate shape `{ source, trust, why }` are identical in the engine contract (Task 3), the writer (Task 2), and the integration fixtures (Task 4). `mdCell` is produced in Task 1 and consumed in Task 2.
