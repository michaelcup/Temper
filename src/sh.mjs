// Shell, git, logging, and small string primitives — the foundation other modules build on.
import { execSync } from 'node:child_process'

// Cross-module MUTABLE state, held in one object because ESM can't reassign an imported binding:
//   logQuiet    — the eval harness silences per-fixture loop chatter
//   totalSleptMs — cumulative rate-limit sleep, excluded from the queue wall-clock budget
export const state = { logQuiet: false, totalSleptMs: 0 }

// Never throws on a non-zero exit; returns the code and combined output.
export function run(cmd, { env } = {}) {
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

export const log = (m) => {
  if (!state.logQuiet) console.log(m)
}
export const fail = (m) => {
  console.error(`✗ ${m}`)
  process.exit(1)
}
export const git = (args) => run(`git ${args}`).out.trim()

// The leading executable of a shell command — the rightmost pipe stage, skipping any VAR=val prefixes.
// "cat {promptFile} | claude -p" → "claude"; "npm test" → "npm"; "VAR=1 pytest -q" → "pytest".
// Best-effort, for prerequisite checks (doctor's engine check, the acceptance-command check).
export function commandBinary(command) {
  const stage = String(command).split('|').pop().trim()
  const toks = stage.split(/\s+/)
  let i = 0
  while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i])) i++ // skip leading env assignments
  return toks[i] ?? ''
}
// Does a binary resolve on PATH (or as a shell builtin)? `command -v` is a POSIX builtin.
export const resolvesOnPath = (bin) => !!bin && run(`command -v "${bin}"`).code === 0

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '') // tool color codes — noise in the log + re-prompt
// For the unchanged-finding fast-bail: strip ONLY fallow's volatile noise so a finding that differs
// merely by run-to-run jitter still counts as the SAME finding — WITHOUT collapsing meaningful
// content. Targeted on purpose (line MULTIPLICITY is preserved, so an acceptance check that prints
// fewer identical error lines as the engine makes progress is NOT mistaken for an unchanged finding):
//   • parenthesized durations like `(0.13s)` (anchored — won't touch a real `timeout 30s` token),
//   • fallow's "node_modules directory not found" warning, which it emits a VARIABLE number of times.
export const normalizeFinding = (s) =>
  stripAnsi(s)
    .split('\n')
    .map((l) => l.replace(/\(\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\)/g, '').replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l && !/node_modules directory not found/.test(l))
    .join('\n')

// Optional terminal-outcome hook (so an overnight run can tell you it finished or got stuck).
// Best-effort: a missing or failing hook never affects the run's exit code. Context goes via env.
export function notify(cfg, event, ctx = {}) {
  if (!cfg.notifyCommand) return
  run(cfg.notifyCommand, {
    env: {
      TEMPER_EVENT: event, // committed | all-green | escalated | gamed | halted | maxed | budget | error
      TEMPER_SUMMARY: ctx.summary ?? `temper: ${event}`,
      TEMPER_BRANCH: ctx.branch ?? '',
      TEMPER_BASE: ctx.base ?? '',
      TEMPER_REPORT: ctx.report ?? '',
    },
  })
}

export function requireCleanRepo() {
  if (run('git rev-parse --is-inside-work-tree').code !== 0) fail('Not inside a git repository.')
  if (git('status --porcelain')) {
    fail('Working tree is dirty. Commit or stash first — Temper needs a clean base to gate against.')
  }
}
