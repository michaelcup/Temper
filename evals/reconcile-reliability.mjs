// Reconcile-reliability check — MANUAL, real-engine, NOT part of `temper eval` or `npm test`.
//
// The reconcile critic (src/engine.mjs runReconcile) is the ONE LLM judgment in task orchestration —
// advisory, fired only when the deterministic detector finds two plans claiming a common file. Its quality
// can only be VERIFIED by running the real engine on known pairs (it's not a deterministic fixture). Run it
// before changing runReconcile, to confirm the critic still: defers a genuine contradiction to the human
// (consult), spots two halves of one change (merge), and does NOT over-flag coincidental hub-file sharing
// (independent). The drop↔merge boundary is genuinely fuzzy, so those cases accept either. ~4 engine calls.
//
//   node evals/reconcile-reliability.mjs [--engine <name>]
import { loadConfig, resolveEngines } from '../src/config.mjs'
import { runReconcile } from '../src/engine.mjs'

const cfg = loadConfig()
const engineArg = process.argv.indexOf('--engine')
resolveEngines(cfg, engineArg >= 0 ? process.argv[engineArg + 1] : undefined)
cfg.rateLimit = { ...cfg.rateLimit, enabled: false }

const plan = (title, scope, body) => ({ title, scope, body })

// expect = the acceptable resolution(s). independent | drop | merge | consult.
const cases = [
  {
    id: 'INDEPENDENT — shared hub file, unrelated edits',
    expect: ['independent'],
    a: plan('Add a lint script to package.json', ['package.json'], 'Add a "lint" entry to package.json scripts that runs eslint.'),
    b: plan('Add a test:watch script to package.json', ['package.json'], 'Add a "test:watch" entry to package.json scripts that runs the tests in watch mode.'),
  },
  {
    id: 'CONSULT — genuine contradiction, human must decide',
    expect: ['consult'],
    a: plan('Add email+password login to src/auth.mjs', ['src/auth.mjs'], 'Implement email+password login in src/auth.mjs.'),
    b: plan('Rewrite src/auth.mjs to OAuth-only', ['src/auth.mjs'], 'Replace all of src/auth.mjs with an OAuth-only flow and remove password login entirely.'),
  },
  {
    id: 'MERGE — two halves of one change',
    expect: ['merge', 'drop'],
    a: plan('Add stricter email validation to the booking handler', ['src/booking.mjs'], 'Tighten the email validation in handleBooking in src/booking.mjs.'),
    b: plan('Extract booking validation into a reusable validator', ['src/booking.mjs'], 'Pull the validation logic in src/booking.mjs out into a reusable validator function.'),
  },
  {
    id: 'DROP/MERGE — one is a strict subset of the other',
    expect: ['drop', 'merge'],
    a: plan('Add a slugify helper to src/util.mjs', ['src/util.mjs'], 'Add a slugify(str) helper to src/util.mjs.'),
    b: plan('Add slugify and truncate helpers to src/util.mjs', ['src/util.mjs'], 'Add both slugify(str) and truncate(str, n) helpers to src/util.mjs.'),
  },
]

console.log(`reconcile: ${cfg.criticName} (${cfg.criticCommand})\n`)
let correct = 0
for (const c of cases) {
  const v = runReconcile(cfg, c.a, c.b)
  const ok = c.expect.includes(v.resolution)
  if (ok) correct++
  console.log(`${ok ? '✓' : '✗ WRONG'} ${c.id}: expected ${c.expect.join('|')}, got=${v.resolution} — ${(v.why || '').slice(0, 75)}`)
}
console.log(`\n${correct}/${cases.length} correct`)
process.exit(correct === cases.length ? 0 : 1)
