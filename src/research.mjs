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
