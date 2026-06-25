// Trigger-routing check — MANUAL, real-engine, NOT part of `temper eval` or `npm test`.
//
// The Skill `description` is the ONLY surface that makes an agent reach for Temper (and route a single
// task to `run` vs a batch to `overnight`). Description quality can't be unit-tested deterministically —
// it IS the live model's matcher. So, like the critic, it's verified by running the real engine on
// labeled prompts: it must FIRE on gated-implementation intent (including indirect phrasings), route a
// batch to `overnight`, and NOT misfire on a trivial edit or a question. Run before changing the
// description (skills/temper/SKILL.md). Costs ~12 real engine calls.
//
//   node evals/trigger-routing.mjs [--engine <name>]
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveEngines } from '../src/config.mjs'
import { callCli } from '../src/engine.mjs'

const cfg = loadConfig()
const engineArg = process.argv.indexOf('--engine')
resolveEngines(cfg, engineArg >= 0 ? process.argv[engineArg + 1] : undefined)
cfg.rateLimit = { ...cfg.rateLimit, enabled: false }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const desc = readFileSync(join(root, 'skills/temper/SKILL.md'), 'utf8').match(/description: (.*)/)[1]

const cases = [
  // SHOULD FIRE → run (one bounded task, incl. indirect phrasings that never say "loop")
  { p: 'implement a rate limiter without breaking the existing middleware', fire: true, mode: 'run' },
  { p: "refactor the auth module and don't add cruft", fire: true, mode: 'run' },
  { p: 'add CSV export, and only touch the export module', fire: true, mode: 'run' },
  { p: 'temper this: migrate the config loader to the new schema', fire: true, mode: 'run' },
  { p: 'gate this change before committing it', fire: true, mode: 'run' },
  // SHOULD FIRE → overnight (a batch / unattended pass)
  { p: 'work through this backlog of eight tasks overnight', fire: true, mode: 'overnight' },
  { p: 'do a big batch of cleanup across the whole repo tonight, unattended', fire: true, mode: 'overnight' },
  { p: 'run the whole refactor queue while I sleep', fire: true, mode: 'overnight' },
  // SHOULD NOT FIRE (near-misses: trivial edit, a question, throwaway, a rename)
  { p: 'fix this typo in the README', fire: false },
  { p: 'what does this function do?', fire: false },
  { p: 'write a quick throwaway script to poke the API', fire: false },
  { p: 'just rename getUser to fetchUser everywhere', fire: false },
]

const ask = (p) =>
  'You are an AI coding agent deciding whether to invoke a Skill for the user request below. Here is the Skill:\n\n' +
  `name: temper\ndescription: ${desc}\n\n` +
  `User request: "${p}"\n\n` +
  'Based ONLY on the description, decide whether the temper skill should fire, and if so which mode the ' +
  'description routes this to (a single bounded task = run; a large/overnight batch = overnight). Reply with ' +
  'ONLY a JSON object as the LAST line: {"fire": boolean, "mode": "run"|"overnight"|"none"}.'

function lastJson(out) {
  const m = out.match(/\{[\s\S]*?\}/g) || []
  for (let i = m.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(m[i])
    } catch {}
  }
  return null
}

console.log(`trigger routing: ${cfg.criticName} (${cfg.criticCommand})\n`)
let correct = 0
for (const c of cases) {
  const { out } = callCli(cfg.criticCommand, ask(c.p), cfg)
  const v = lastJson(out) || {}
  const ok = !!v.fire === c.fire && (!c.fire || v.mode === c.mode)
  if (ok) correct++
  console.log(`${ok ? '✓' : '✗ WRONG'} [want ${c.fire ? c.mode : 'no-fire'}] "${c.p.slice(0, 52)}" → fire=${v.fire} mode=${v.mode}`)
}
console.log(`\n${correct}/${cases.length} correct`)
process.exit(correct === cases.length ? 0 : 1)
