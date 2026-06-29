// Config: engine presets, defaults, loading/merging, engine resolution, and fallow-config detection.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, fail } from './sh.mjs'

// Named engine presets. {promptFile} is replaced with a path holding the prompt.
// `engine` MUST be able to edit files headlessly; `critic` must NOT edit.
// These flags are best-effort defaults — verify them for your CLI version.
const ENGINES = {
  claude: {
    engine: 'cat {promptFile} | claude -p --permission-mode acceptEdits',
    critic: 'cat {promptFile} | claude -p',
  },
  codex: {
    engine: 'cat {promptFile} | codex exec --sandbox workspace-write',
    critic: 'cat {promptFile} | codex exec --sandbox read-only',
  },
}

export const DEFAULTS = {
  engine: 'claude', // which preset implements (override per-run with --engine)
  criticEngine: null, // which preset reviews; defaults to `engine`. Set to the
  //                     OTHER engine for stronger cross-model review.
  engines: ENGINES,
  fallowCommand: 'fallow', // e.g. "npx fallow" or "node_modules/.bin/fallow"
  // The deterministic ENTROPY GATE command (dead code / duplication / complexity). null = the default
  // `<fallowCommand> audit --gate new-only` (JS/TS). Set this to ANY command for another language or
  // tool — a non-zero exit is treated as "new entropy" and re-prompts the engine. `{base}` is replaced
  // with the base commit SHA. Caveat: fallow's `--gate new-only` only fails on what the change
  // INTRODUCED; a tool without that scoping will also flag pre-existing issues, so scope it to the diff.
  entropyGate: null,
  maxIterations: 5,
  criticMode: 'warn', // 'warn' | 'halt' | 'off'
  forbidSuppressions: true, // reject diffs that ADD fallow-ignore / eslint-disable / @ts-ignore / skipped tests
  maxDomainRetries: 3, // consecutive iterations a single failure-domain may recur before escalating (Factor 9)
  maxUnchangedRetries: 2, // escalate sooner when the SAME finding recurs UNCHANGED (an identical deterministic finding = the engine can't fix it; ~1 retry, per Factor 9)
  checkCompleteness: false, // opt-in LLM check that the diff implements every step of the Plan (diff-vs-Plan)
  commitPrefix: 'temper:',
  phaseDir: '.temper/phases', // default dir of ordered phase Plans for `run-phases`
  progressFile: '.temper/progress.json', // on-disk ledger of committed phases (enables resume)
  // Mode B (overnight). The subscription cap — not the clock — is the throughput ceiling,
  // so the queue must survive it: detect the cap in engine output, sleep to
  // reset, resume. Plus a hard global budget so a bad night is bounded.
  rateLimit: {
    enabled: true,
    // Phrases that BEGIN a cap line (matched at line-start, case-insensitive — see hitRateLimit).
    // Line-anchored so the engine/critic merely *mentioning* a cap phrase in prose (or this repo's
    // own source) doesn't trigger a spurious wait. Tune per CLI.
    patterns: ['claude usage limit reached', 'claude ai usage limit reached', 'usage limit reached', '5-hour limit reached', "you've reached your usage limit", 'you have reached your usage limit', 'out of extra usage'],
    marginSeconds: 60, // wait this much PAST the parsed reset, for clock skew
    fallbackSeconds: 1800, // if no reset time is parseable, wait this long, then re-check
    maxWaitSeconds: 21600, // cap a SINGLE wait at this (6h)
    maxQueueWaitSeconds: 28800, // cap CUMULATIVE cap-waiting across the whole run at this (8h), then give up
  },
  maxQueueSeconds: null, // overnight: wall-clock budget for ONE run-phases invocation (a resume starts fresh), excluding rate-limit sleeps; null = off
  maxQueueIterations: null, // overnight: cap on engine iterations within ONE run-phases invocation (a resume starts fresh); null = off
  // Optional shell hook fired on a TERMINAL outcome (so an overnight run can tell you it's done or
  // needs you). Best-effort; receives TEMPER_EVENT / TEMPER_SUMMARY / TEMPER_BRANCH / TEMPER_BASE /
  // TEMPER_REPORT as env vars. e.g. "curl -d \"$TEMPER_SUMMARY\" ntfy.sh/my-topic". null = off.
  notifyCommand: null,
  // Direction check (overnight, opt-in, OFF by default). The per-iteration gates check "did we do it
  // RIGHT"; this checks "are we doing the RIGHT thing" BEFORE each phase — grounding the phase's APPROACH
  // against a TRUST-LIST you supply (local doc paths and/or URLs: official docs, a migration guide, your
  // ADRs/SPEC). Catches work built on a deprecated/superseded/contradicted premise before it compounds
  // across an unattended queue. The check is an LLM/web judgment delegated to the critic engine (zero new
  // dep: it reads local source files directly, and fetches URLs only if the engine has web tools). Fires
  // ONLY when `enabled` AND `sources` is non-empty, on a deterministic cadence (every Nth phase, 0-indexed
  // so phase 1 is always checked). onMiss: 'warn' (surface in the morning report) | 'pause' (stop the queue
  // before the phase). Fail-OPEN: an unparseable verdict never blocks.
  // ledger: true (opt-in) maintains a living research ledger at .temper/research.md, biased to .temper/trust-list.md.
  directionCheck: { enabled: false, sources: [], every: 1, onMiss: 'warn', ledger: false },
}

export function loadConfig() {
  const path = join(process.cwd(), 'temper.config.json')
  if (!existsSync(path)) return { ...DEFAULTS }
  try {
    const user = JSON.parse(readFileSync(path, 'utf8'))
    // Merge nested presets so overriding one field doesn't drop the rest (engines, rateLimit).
    return {
      ...DEFAULTS,
      ...user,
      engines: { ...DEFAULTS.engines, ...(user.engines ?? {}) },
      rateLimit: { ...DEFAULTS.rateLimit, ...(user.rateLimit ?? {}) },
      directionCheck: { ...DEFAULTS.directionCheck, ...(user.directionCheck ?? {}) },
    }
  } catch (e) {
    fail(`Could not parse temper.config.json: ${e.message}`)
  }
}

// Resolves which preset implements and which reviews, supporting cross-model
// review (e.g. claude implements, codex critiques). Sets engineCommand/criticCommand.
export function resolveEngines(cfg, engineOverride) {
  const engineName = (typeof engineOverride === 'string' ? engineOverride : null) ?? cfg.engine
  const criticName = cfg.criticEngine ?? engineName
  const known = Object.keys(cfg.engines).join(', ')
  const e = cfg.engines[engineName]
  const c = cfg.engines[criticName]
  if (!e) fail(`Unknown engine "${engineName}". Known engines: ${known}.`)
  if (!c) fail(`Unknown critic engine "${criticName}". Known engines: ${known}.`)
  cfg.engineCommand = e.engine
  cfg.criticCommand = c.critic
  cfg.engineName = engineName
  cfg.criticName = criticName
}

// Per-invocation override of cfg.maxIterations (mutates cfg, like resolveEngines).
// String() funnels both a bare `--max-iterations` (stored as `true` → "true" → NaN) and any
// non-integer/non-positive value into the single rejection, before any loop starts.
export function applyMaxIterations(cfg, flags) {
  if (!('max-iterations' in flags)) return
  const raw = flags['max-iterations']
  const n = Number(String(raw))
  if (!Number.isInteger(n) || n < 1) fail(`--max-iterations must be a positive integer (got "${raw}").`)
  cfg.maxIterations = n
}

// Per-invocation Mode B budget overrides (--max-queue-seconds / --max-queue-iterations), symmetric with
// applyMaxIterations — so bounding one overnight run doesn't mean editing + committing the config first.
export function applyQueueBudget(cfg, flags) {
  for (const [flag, key] of [
    ['max-queue-seconds', 'maxQueueSeconds'],
    ['max-queue-iterations', 'maxQueueIterations'],
  ]) {
    if (!(flag in flags)) continue
    const n = Number(String(flags[flag]))
    if (!Number.isInteger(n) || n < 1) fail(`--${flag} must be a positive integer (got "${flags[flag]}").`)
    cfg[key] = n
  }
}

const FALLOW_CONFIGS = ['.fallowrc.json', '.fallowrc.jsonc', 'fallow.toml', '.fallow.toml']
export const hasFallowConfig = () => FALLOW_CONFIGS.some((f) => existsSync(join(process.cwd(), f)))
// Heuristic: does the repo contain test files (which fallow's dead-code gate would flag as "unused")?
export const projectHasTests = () =>
  /(?:^|\/)[^/\n]*[._](?:test|spec|cy|e2e)\.|(?:^|\/)(?:tests?|__tests__|spec|e2e|cypress|playwright)\//m.test(run('git ls-files').out)

// Does package.json declare a fallow entry point — the library API (exports/main/bin)? fallow measures
// dead code FROM entry points, so a repo with none (no package entry AND no tests) gives fallow no root:
// pre-existing unused code is invisible until the first change adds an entry, then shows up as "introduced".
export const hasPackageEntry = () => {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    return Boolean(pkg.exports || pkg.main || pkg.bin)
  } catch {
    return false
  }
}
