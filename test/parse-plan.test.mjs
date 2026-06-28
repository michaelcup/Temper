import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePlan, extractPlanDraft } from '../src/plan.mjs'

const FM = '---\nscope:\n  - "a.mjs"\nacceptance: "npm test"\n---\n# Title\n'

test('extractPlanDraft KEEPS a code block inside the plan body (no greedy truncation)', () => {
  // The bug: a plan whose Context contains a ```ts snippet used to be truncated at the first fence.
  const raw = FM + '\n## Context\n```ts\nconst PER = Number(x)\n```\nmore context after the block.\n'
  const out = extractPlanDraft(raw)
  assert.match(out, /const PER = Number\(x\)/, 'the inner code block must survive')
  assert.match(out, /more context after the block/, 'content after the code block must survive')
})

test('extractPlanDraft strips a wrapping ``` fence, preamble, and trailing prose', () => {
  const raw = 'Here is the plan:\n```markdown\n' + FM + 'body line.\n```\nLet me know if you want changes.\n'
  const out = extractPlanDraft(raw)
  assert.match(out, /^---\nscope:/, 'starts at the frontmatter (preamble + wrapper-open dropped)')
  assert.match(out, /body line\./)
  assert.doesNotMatch(out, /Let me know/, 'trailing prose after the wrapper is dropped')
  assert.doesNotMatch(out, /```/, 'the unbalanced wrapper fence is dropped')
})

test('extractPlanDraft drops the wrapper but keeps a balanced inner code block', () => {
  const raw = '```markdown\n' + FM + '```ts\ncode\n```\ndone.\n```\n'
  const out = extractPlanDraft(raw)
  assert.match(out, /\ncode\n/, 'inner block kept')
  assert.match(out, /done\./)
  assert.equal((out.match(/^```/gm) || []).length, 2, 'only the inner balanced fences remain (wrapper dropped)')
})

test('parsePlan tolerates CRLF line endings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-parseplan-'))
  try {
    const plan = ['---', 'scope:', '  - "src/x.mjs"', 'acceptance: "node --test"', '---', '# Title'].join('\r\n')
    const path = join(dir, 'plan.md')
    writeFileSync(path, plan)
    const parsed = parsePlan(path)
    assert.deepEqual(parsed.scope, ['src/x.mjs'])
    assert.equal(parsed.acceptance, 'node --test')
    assert.equal(parsed.title, 'Title')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parsePlan reads removes: and removesRoot: as literal-term lists, defaulting to []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-removes-'))
  try {
    const withR = ['---', 'scope:', '  - "src/x.mjs"', 'acceptance: "node --test"', 'removes:', '  - "external_site.agent_handoff.create"', '  - "/admin/site/anpa-external-workflows"', 'removesRoot:', '  - "src"', '  - "docs"', '---', '# Title'].join('\n')
    const p1 = join(dir, 'r.md')
    writeFileSync(p1, withR)
    const a = parsePlan(p1)
    assert.deepEqual(a.removes, ['external_site.agent_handoff.create', '/admin/site/anpa-external-workflows'])
    assert.deepEqual(a.removesRoot, ['src', 'docs'])
    const p2 = join(dir, 'n.md')
    writeFileSync(p2, FM)
    const b = parsePlan(p2)
    assert.deepEqual(b.removes, [], 'removes defaults to empty when absent')
    assert.deepEqual(b.removesRoot, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parsePlan unquotes single quotes and preserves inner quotes (quote-aware unquote)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-unquote-'))
  try {
    // A single-quoted acceptance wrapping a grep pattern with inner double-quotes and a | (the Stage-E case).
    const plan = ['---', 'scope:', '  - "src/x.mjs"', `acceptance: 'node --test && ! grep -Eq "a|b" src'`, '---', '# Title'].join('\n')
    const p = join(dir, 'q.md')
    writeFileSync(p, plan)
    assert.equal(parsePlan(p).acceptance, 'node --test && ! grep -Eq "a|b" src', 'outer single-quotes stripped, inner double-quotes kept')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
