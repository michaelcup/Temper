#!/usr/bin/env node
// Example BYO doc-sprawl gate — opt-in, not part of Temper core. Wire it as the entropy gate for prose:
//
//   "entropyGate": "node examples/doc-gate.mjs {base}"
//
// It fails (exit 1) when the change ADDS a new markdown file, nudging "update an existing doc, don't
// create another one." Deterministic, zero-dependency. Edit ALLOW for docs your project legitimately
// adds, or name the path in the Plan's scope when a new doc is genuinely intended.
import { execSync } from 'node:child_process'

const base = process.argv[2] || process.env.FALLOW_AUDIT_BASE || 'HEAD'
const ALLOW = [/^README\.md$/i, /^CHANGELOG\.md$/i, /(^|\/)LICENSE(\.md)?$/i]
const lines = (cmd) => execSync(cmd, { encoding: 'utf8' }).split('\n').filter(Boolean)

// New markdown: tracked-added since the base + brand-new untracked files (git diff omits untracked).
const added = [...new Set([...lines(`git diff --name-only --diff-filter=A ${base}`), ...lines('git ls-files --others --exclude-standard')])].filter(
  (f) => /\.(md|markdown)$/i.test(f) && !ALLOW.some((re) => re.test(f)),
)

if (added.length) {
  console.log('doc sprawl: new markdown file(s) added — update an existing doc instead, or add the path to ALLOW / the Plan scope:')
  for (const f of added) console.log(`  ${f}`)
  process.exit(1)
}
