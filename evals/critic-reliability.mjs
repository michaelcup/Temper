// Critic-reliability check — MANUAL, real-engine, NOT part of `temper eval` or `npm test`.
//
// The reuse-critic is Temper's ONE LLM-judgment gate. LLM code judges are unreliable by default
// (the literature reports 21–36% of them FLIP their verdict on a no-op refactor), so the critic's
// reliability can only be VERIFIED by running the real critic on known cases — it can't be a
// deterministic fixture. Run this before changing the critic prompt (src/engine.mjs runCritic) to
// confirm you didn't regress it. Costs real engine calls (~14 by default).
//
//   node evals/critic-reliability.mjs [--engine <name>]
//
// It must FLAG a genuine duplication-of-intent (incl. semantic — different code, same job) and must
// NOT flag a no-op refactor, a genuinely-new function, correct reuse, or a genuinely-new doc.
// Expected baseline: 8/8, 0 flips.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { loadConfig, resolveEngines } from '../src/config.mjs'
import { runCritic } from '../src/engine.mjs'

const engineArg = process.argv.indexOf('--engine')
const cfg = loadConfig()
resolveEngines(cfg, engineArg >= 0 ? process.argv[engineArg + 1] : undefined)
cfg.rateLimit = { ...cfg.rateLimit, enabled: false }

const SLUG = "export const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')\n"
const CAP = 'export function capitalize(s) {\n  return s.charAt(0).toUpperCase() + s.slice(1)\n}\n'
const CLAMP = 'export const clamp = (n, min, max) => Math.min(Math.max(n, min), max)\n'
const SETUP_DOC = '# Setup\n\nInstall the deps with `npm install`, copy `.env.example` to `.env`, then run `npm start`. The app serves on port 3000.\n'

// Each case: a committed base + an uncommitted change. expect = should the critic flag duplication?
const cases = [
  // TRUE POSITIVES — a reimplementation under a different name; must FLAG.
  { id: 'TP-slugify (verbatim dup)', expect: true, base: { 'src/slugify.mjs': SLUG }, change: { 'src/url.mjs': "export function toUrlPath(str) {\n  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')\n}\n" } },
  { id: 'TP-capitalize', expect: true, base: { 'src/text.mjs': CAP }, change: { 'src/format.mjs': 'export function upperFirst(value) {\n  return value.charAt(0).toUpperCase() + value.slice(1)\n}\n' } },
  { id: 'TP-clamp (SEMANTIC dup)', expect: true, base: { 'src/math.mjs': CLAMP }, change: { 'src/util.mjs': 'export function bound(v, lo, hi) {\n  if (v < lo) return lo\n  if (v > hi) return hi\n  return v\n}\n' } },
  // TRUE NEGATIVES — must NOT flag.
  { id: 'TN-noop-refactor (flip-prone)', expect: false, base: { 'src/calc.mjs': 'export function add(a, b) {\n  const result = a + b\n  return result\n}\n' }, change: { 'src/calc.mjs': 'export function add(a, b) {\n  const sum = a + b\n  return sum\n}\n' } },
  { id: 'TN-genuine-new', expect: false, base: { 'src/slugify.mjs': SLUG }, change: { 'src/parse.mjs': 'export function parseCsvLine(line) {\n  return line.split(",").map((c) => c.trim())\n}\n' } },
  { id: 'TN-correct-reuse', expect: false, base: { 'src/slugify.mjs': SLUG }, change: { 'src/url.mjs': "import { slugify } from './slugify.mjs'\nexport const toUrlPath = (s) => slugify(s)\n" } },
  // PROSE duplication-of-intent — the critic now also covers docs (run this before trusting it past warn-only).
  { id: 'TP-doc-dup (restates an existing doc)', expect: true, base: { 'docs/setup.md': SETUP_DOC }, change: { 'docs/getting-started.md': '# Getting Started\n\nTo set up: run `npm install`, copy `.env.example` to `.env`, then start with `npm start`. It listens on port 3000.\n' } },
  { id: 'TN-doc-new-topic', expect: false, base: { 'docs/setup.md': SETUP_DOC }, change: { 'docs/architecture.md': '# Architecture\n\nThree layers: an HTTP router, a service layer, and a Postgres data layer. Requests flow router → service → data.\n' } },
]

function critiqueOnce({ base, change }) {
  const work = mkdtempSync(join(tmpdir(), 'critic-rel-'))
  const origCwd = process.cwd()
  try {
    for (const [f, content] of Object.entries(base)) {
      mkdirSync(join(work, dirname(f)), { recursive: true })
      writeFileSync(join(work, f), content)
    }
    writeFileSync(join(work, 'package.json'), '{ "name": "fx", "type": "module" }\n')
    process.chdir(work)
    execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=a commit -qm seed', { stdio: 'ignore' })
    const baseSha = execSync('git rev-parse HEAD').toString().trim()
    for (const [f, content] of Object.entries(change)) {
      mkdirSync(join(work, dirname(f)), { recursive: true })
      writeFileSync(join(work, f), content)
    }
    return runCritic(cfg, baseSha)
  } finally {
    process.chdir(origCwd)
    rmSync(work, { recursive: true, force: true })
  }
}

console.log(`critic: ${cfg.criticName} (${cfg.criticCommand})\n`)
let correctCount = 0
for (const c of cases) {
  const v = critiqueOnce(c)
  const correct = !!v.flagged === c.expect
  if (correct) correctCount++
  console.log(`${correct ? '✓' : '✗ WRONG'} ${c.id}: expected flag=${c.expect}, got=${!!v.flagged} (${v.confidence}) — ${(v.summary || '').slice(0, 80)}`)
}

// The flip-prone no-op refactor, repeated, to measure the false-positive flip RATE (the field's 21–36%).
const noop = cases.find((c) => c.id.startsWith('TN-noop'))
let flips = 0
process.stdout.write('\nno-op refactor flip check: ')
for (let i = 0; i < 4; i++) {
  const f = !!critiqueOnce(noop).flagged
  if (f) flips++
  process.stdout.write(f ? 'FLIP ' : 'ok ')
}
console.log(`\n\n${correctCount}/${cases.length} cases correct · no-op refactor flipped ${flips}/4 extra runs (expect 0)`)
process.exit(correctCount === cases.length && flips === 0 ? 0 : 1)
