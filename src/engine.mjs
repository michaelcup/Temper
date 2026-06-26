// The only LLM steps: driving the engine/critic CLI, the rate-limit guard that
// lets an overnight run survive the subscription cap, and the reuse + completeness critics.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, log, state } from './sh.mjs'
import { fullDiff } from './gates.mjs'

// --- rate-limit resilience (Mode B) ---
// The subscription cap is the overnight ceiling. When the engine/critic
// CLI reports it, sleep to the reset and resume — the shipped pattern from practitioners.
function sleepSeconds(s) {
  const ms = Math.max(0, Math.round(s * 1000))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) // synchronous; the runner is sync by design
  state.totalSleptMs += ms
}

function hitRateLimit(cfg, out) {
  if (!cfg?.rateLimit?.enabled) return false
  // Match per LINE, anchored to the line start (after stripping quote/bullet noise). A real cap
  // BANNER begins with one of these phrases; the engine/critic merely *mentioning* a phrase in
  // prose — or this repo's own source containing the strings — does NOT start a line with it.
  const pats = cfg.rateLimit.patterns.map((p) => p.toLowerCase())
  return out
    .toLowerCase()
    .split('\n')
    .some((line) => {
      const t = line.replace(/^[\s"'>*•\-]+/, '')
      return pats.some((p) => t.startsWith(p))
    })
}

// Best-effort: seconds until a "resets 3pm" / "resets at 11:30" style time in the message.
// null when nothing parseable OR the parsed time is implausibly far off (a misparse / wrong
// day-rollover), so the caller falls back to periodic re-checks instead of one giant overshoot.
function parseResetSeconds(text, now = new Date()) {
  const m = text.match(/reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && hour < 12) hour += 12
  if (ap === 'am' && hour === 12) hour = 0
  if (hour > 23 || min > 59) return null
  const target = new Date(now)
  target.setHours(hour, min, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1) // next occurrence
  const secs = Math.round((target - now) / 1000)
  return secs > 6 * 3600 ? null : secs // a reset >6h out is almost certainly a misparse → fall back
}

export function callCli(template, promptText, cfg) {
  const promptFile = join(tmpdir(), `temper-prompt-${process.pid}-${Math.round(performance.now())}.txt`)
  writeFileSync(promptFile, promptText)
  const cmd = template.replace('{promptFile}', promptFile)
  for (;;) {
    const r = run(cmd)
    if (!hitRateLimit(cfg, r.out)) return r
    const rl = cfg.rateLimit
    // Bound CUMULATIVE cap-waiting across the WHOLE run (state.totalSleptMs is global), so a persistent
    // cap can't compound to maxIterations × maxWaitSeconds. Once spent, stop waiting everywhere.
    const globalLeftSec = (rl.maxQueueWaitSeconds ?? Infinity) - state.totalSleptMs / 1000
    const wait = Math.min((parseResetSeconds(r.out) ?? rl.fallbackSeconds) + rl.marginSeconds, rl.maxWaitSeconds, globalLeftSec)
    if (wait <= 0) {
      log(`⚠ rate-limit: cumulative cap-wait ceiling (${rl.maxQueueWaitSeconds}s) reached — giving up the wait; review the run.`)
      return r
    }
    log(`\n⏸ subscription cap hit at ${new Date().toLocaleTimeString()}. Sleeping ${wait < 90 ? Math.round(wait) + 's' : Math.round(wait / 60) + 'm'} for reset, then resuming…`)
    sleepSeconds(wait)
  }
}

// Extract a JSON object from model output. The prompt asks for it as the LAST line, so try lines
// from the end first (robust to braces inside string values, which a regex span is not); fall back
// to a first-{ to last-} span for multi-line JSON. Returns null if nothing parses.
function lastJsonObject(out) {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') && lines[i].endsWith('}')) {
      try {
        return JSON.parse(lines[i])
      } catch {
        /* try an earlier line */
      }
    }
  }
  const s = out.indexOf('{')
  const e = out.lastIndexOf('}')
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(out.slice(s, e + 1))
    } catch {
      /* fall through */
    }
  }
  return null
}

export function enginePrompt(plan, violations) {
  let p = 'You are implementing one task in this repository.\n\n'
  p += 'Work ONLY within these files/globs:\n'
  p += plan.scope.map((s) => `  - ${s}`).join('\n') + '\n\n'
  p += 'Rules: extend existing code rather than duplicating it; delete what you replace '
  p += '(no dead or commented-out code); never modify code inside a `temper:protect-start … '
  p += 'temper:protect-end` region; do the task and nothing more.\n'
  p += 'Writing: do NOT create new docs or markdown files unless a scope path names one — update the '
  p += 'nearest existing file instead. Be terse — cut any line whose removal would not cause a mistake; '
  p += 'no preamble, no restating the task. Match the register of what you edit: user-facing copy is '
  p += 'confident, specific, and minimal — concrete details over generic filler, no developer commentary, '
  p += 'no "note that…", no decorative emoji or emoji-as-icons, no empty superlatives ("seamlessly", '
  p += '"elevate", "unlock"). Comments explain only what the code cannot.\n\n'
  p += `# Task\n${plan.body}\n`
  if (violations.length) {
    p += '\n# Your previous attempt was REJECTED. Fix the ROOT CAUSE of each item below.\n'
    p += 'Do NOT suppress findings, skip or weaken tests, or silence checks — fix the underlying issue.\n'
    p += 'Show the command(s) you ran and their output as evidence the fix works.\n\n'
    p += violations.map((v) => `- ${v}`).join('\n') + '\n'
  }
  return p
}

export function runCritic(cfg, baseSha) {
  const diff = fullDiff(baseSha)
  if (!diff.trim()) return { flagged: false, confidence: 'low', summary: 'empty diff' }
  const prompt =
    'You are a skeptical senior reviewer with READ access to this repository (use your search/read tools).\n' +
    'Your ONE job: detect DUPLICATION-OF-INTENT — code OR documentation in the change below that reimplements ' +
    'or restates something that ALREADY EXISTS elsewhere in this repo and should have reused, extended, or ' +
    'UPDATED it in place instead of adding a parallel copy.\n\n' +
    'Method: for each new function / module / helper, SEARCH the existing codebase for code that already does ' +
    'that job. For each new or grown doc / markdown file, SEARCH for an existing doc covering the same ground ' +
    'that should have been updated in place. Flag only genuine same-responsibility duplication; ignore style ' +
    'and naming, and NEVER suggest writing more prose. Code that imports, calls, delegates to, or re-exports ' +
    'an existing implementation is CORRECT REUSE, not duplication — never flag it; that is the outcome you want.\n\n' +
    'Respond with ONLY a JSON object as the LAST line: ' +
    '{"flagged": boolean, "confidence": "low"|"medium"|"high", "summary": "what duplicates what, citing files"}.\n\n' +
    `CHANGE (diff + new files):\n${diff}\n`
  const { out } = callCli(cfg.criticCommand, prompt, cfg)
  const v = lastJsonObject(out)
  if (v && typeof v.flagged === 'boolean') return v
  return { flagged: false, confidence: 'low', summary: 'critic returned no usable JSON' } // safe default: don't halt
}

// Diff-vs-Plan completeness (opt-in). Catches work that passes the gates but doesn't actually
// implement everything the Plan asked for (silent partial completion). Fail-OPEN: an unparseable
// or absent verdict never blocks — an LLM glitch must not stop legitimate work.
export function runCompletenessCheck(cfg, plan, baseSha) {
  const diff = fullDiff(baseSha)
  const prompt =
    'You are verifying that a change FULLY implements its Plan. Below are the PLAN and the DIFF.\n' +
    'Does the diff implement EVERY step the Plan requires? Flag ONLY genuinely missing or only-partially-done ' +
    'work the Plan explicitly asked for — not style, not extra polish.\n\n' +
    'Reply with ONLY a JSON object as the LAST line: {"complete": boolean, "missing": "one sentence on what is missing, or none"}.\n\n' +
    `PLAN:\n${plan.body}\n\nDIFF:\n${diff}\n`
  const { out } = callCli(cfg.criticCommand, prompt, cfg)
  const v = lastJsonObject(out)
  if (v && typeof v.complete === 'boolean') return v
  return { complete: true, missing: 'none' } // fail-OPEN: no usable verdict must never block legit work
}

// Direction check (overnight, opt-in). The per-iteration gates check "did we do it RIGHT"; this checks
// "are we doing the RIGHT thing" BEFORE a phase runs — grounding the phase's APPROACH against a user-supplied
// trust-list (local doc paths the engine reads directly; URLs it fetches only if it has web tools). Flags
// ONLY a concrete, SOURCED wrong-direction (deprecated / superseded / removed / contradicted premise), never
// style or scope. Fail-OPEN: no usable verdict ⇒ sound (must never block an unattended queue on an LLM glitch).
export function runDirectionCheck(cfg, plan) {
  const prompt =
    'You are checking whether a planned change takes the RIGHT APPROACH — not whether it is well-written, but ' +
    'whether its PREMISE is sound and current. Below is the PLAN for an upcoming task.\n\n' +
    'Ground your judgment ONLY in these trusted sources (read local file paths directly; fetch URLs only if you ' +
    'have web tools). Do NOT free-browse the open web. If the sources are silent on this plan, return sound:true:\n' +
    cfg.directionCheck.sources.map((s) => `  - ${s}`).join('\n') + '\n\n' +
    'Flag a direction-miss ONLY if a trusted source shows the plan relies on something deprecated, superseded, ' +
    'removed, or contradicted (a gone API, an outdated pattern, a false assumption). NEVER flag style, scope, ' +
    'naming, or "could be better" — only a concrete, sourced wrong-direction.\n\n' +
    'Reply with ONLY a JSON object as the LAST line, no prose: ' +
    '{"sound": boolean, "concern": "one sentence, or none", "source": "which trusted source shows it, or none"}.\n\n' +
    `PLAN:\n${plan.body}\n`
  const { out } = callCli(cfg.criticCommand, prompt, cfg)
  const v = lastJsonObject(out)
  if (v && typeof v.sound === 'boolean') return { sound: v.sound, concern: v.concern ?? 'none', source: v.source ?? 'none' }
  return { sound: true, concern: 'none', source: 'none' } // fail-OPEN: no usable verdict must never block the queue
}

// Reconcile critic — the ONE judgment call in task orchestration. Invoked ONLY when the deterministic
// detector finds two plans whose scopes claim a common file. It sees ONLY the two plans' titles + scope +
// goal (never the code — context-thrift), and judges whether they truly contend and how to resolve it.
// ADVISORY: the verdict is surfaced for the human, NEVER auto-applied (Temper never drops/merges a Plan
// for you). Fail-OPEN to "consult" — defer to the human on any glitch.
export function runReconcile(cfg, a, b) {
  const one = (p) => `  title: ${p.title}\n  scope: ${p.scope.join(', ')}\n  goal: ${p.body.replace(/\s+/g, ' ').slice(0, 400)}`
  const prompt =
    'Two planned tasks have OVERLAPPING file scopes — they may edit the same file in sequence. Judge whether ' +
    'they genuinely CONTEND for the same behavior or just coincidentally share a file, and if they contend, how ' +
    'to resolve it. You see ONLY the two plans below (titles, scopes, goals) — not the code.\n\n' +
    `PLAN A:\n${one(a)}\n\nPLAN B:\n${one(b)}\n\n` +
    'Reply with ONLY a JSON object as the LAST line, no prose: ' +
    '{"resolution": "independent"|"drop"|"merge"|"consult", "which": "A"|"B"|"both", "why": "one sentence"}.\n' +
    'independent = same file, no real contention, run both. drop = one is redundant/superseded (name which). ' +
    'merge = they should be one task (which absorbs which). consult = genuinely ambiguous, the human decides. ' +
    'When unsure, choose consult.'
  const { out } = callCli(cfg.criticCommand, prompt, cfg)
  const v = lastJsonObject(out)
  if (v && typeof v.resolution === 'string') return { resolution: v.resolution, which: v.which ?? 'both', why: v.why ?? '' }
  return { resolution: 'consult', which: 'both', why: 'no usable verdict' } // fail-OPEN: defer to the human
}
