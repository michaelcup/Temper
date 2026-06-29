// Plan handling: parse + validate the human-approved Plan, and the Research→Plan drafting step.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log, fail, commandBinary, resolvesOnPath, runArgs } from './sh.mjs'
import { callCli } from './engine.mjs'

// Collapse CRLF/CR to LF so the literal-`\n` plan regexes below match CRLF files too.
const normalizeNewlines = (s) => s.replace(/\r\n?/g, '\n')

// Strip ONE surrounding quote pair, but only when the first and last char are the SAME quote (length >= 2).
// The old positional /^["']|["']$/ stripped a lone leading-or-trailing quote and mismatched a "…' pair —
// the parser-side analogue of the quote-aware commandBinary fix.
const unquote = (s) => (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] ? s.slice(1, -1) : s)

export function parsePlan(path) {
  if (!existsSync(path)) fail(`Plan not found: ${path}`)
  const raw = normalizeNewlines(readFileSync(path, 'utf8'))
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) fail('Plan must start with a `---` frontmatter block — see templates/PLAN.template.md.')
  const [, front, body] = m
  // Read ONLY the bullets directly under a given key (the scope allowlist is the primary containment boundary).
  // Reading every `- ` in the frontmatter let a stray bullet under another key (reviewers:, tags:, notes:) —
  // or a sneaked `- "**"` in an engine-drafted, skim-reviewed plan — silently widen scope to the whole repo.
  const listBlock = (key) => {
    const b = front.match(new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+-[ \\t]+.+\\n?)+)`, 'm'))
    return b ? [...b[1].matchAll(/^[ \t]+-[ \t]+(.+)$/gm)].map((x) => unquote(x[1].trim())) : []
  }
  const scope = listBlock('scope')
  // `removes:` — literal identifiers/paths that must NOT survive anywhere after this change (the deletion-side
  // mirror of scope). `removesRoot:` optionally narrows where to search (default: the whole repo).
  const removes = listBlock('removes')
  const removesRoot = listBlock('removesRoot')
  const acc = front.match(/^acceptance:\s*(.+)$/m)
  const held = front.match(/^heldout:\s*(.+)$/m)
  const title = body.match(/^#\s+(.+)$/m)
  if (!scope.length) fail('Plan frontmatter must list at least one scope glob under `scope:`.')
  return {
    scope,
    removes,
    removesRoot,
    acceptance: acc ? unquote(acc[1].trim()) : null,
    // A hidden check the engine never sees — run only after every visible gate passes,
    // to catch work that satisfied the visible checks without satisfying the spec.
    heldout: held ? unquote(held[1].trim()) : null,
    title: title ? title[1].trim() : 'temper change',
    body: body.trim(),
  }
}

// Rejects an underspecified plan before any work runs (research: a final plan has no open questions).
// Syntax-check a shell command WITHOUT running it: `-n` parses (catching nested/unbalanced quotes — an inline
// `node -e "…\"…\""` that survived parsePlan's outer-quote strip) but executes nothing — command
// substitutions, redirections and globs are all parse-only, so it is safe on an engine-drafted string.
// Invokes `/bin/sh` by absolute path — the SAME interpreter the loop's run()=execSync uses — so a pass here
// provably matches what will run it (a `sh` shim earlier on PATH could be a different shell). Best-effort: it
// reflects THIS host's /bin/sh, so a bashism valid on macOS may still fail on a dash-based Linux runner.
// Returns the last error line, or null if the command parses cleanly (or the shell couldn't be spawned — a
// real syntax error always writes to stderr, so empty output means a spawn failure: fail open, don't reject).
export function shellSyntaxError(command) {
  const { code, out } = runArgs('/bin/sh', ['-n', '-c', command])
  if (code === 0) return null
  const msg = out.trim()
  if (!msg) return null // no stderr ⇒ /bin/sh didn't run (ENOENT/sandbox), not a syntax error — don't false-reject
  return msg.split('\n').filter(Boolean).pop() || `/bin/sh -n exited ${code}`
}

export function validatePlan(plan) {
  const markers = ['TBD', '???', 'open question', 'decide later', 'figure out later', 'not sure']
  const lower = plan.body.toLowerCase()
  const hit = markers.find((m) => lower.includes(m.toLowerCase()))
  if (hit) {
    fail(`Plan has an unresolved decision (found "${hit}"). Resolve every open question before running — a vague plan produces vague code.`)
  }
  if (!plan.acceptance) {
    log('⚠  No `acceptance` command — the loop will gate on fallow + scope only.\n')
    return
  }
  // Catch a mis-wired acceptance command BEFORE the loop: a non-runnable command (typo'd binary, wrong
  // tool) exits non-zero and reads as a failing test, so the loop re-prompts the engine to "fix" correct
  // code and burns iterations until it escalates. Check the binary resolves (not that the test passes —
  // a real test can legitimately be red on the clean base).
  // Only check when we extracted a plausible binary NAME — skip shell grouping like `(cd … && npm test)`
  // so a valid command is never false-failed (best-effort: catch a typo'd binary, never block a real one).
  const bin = commandBinary(plan.acceptance)
  if (bin && /^[\w./-]/.test(bin) && !resolvesOnPath(bin)) {
    fail(`Acceptance command isn't runnable: \`${plan.acceptance}\` (\`${bin}\` is not on your PATH). Fix it — the loop would read this as a failing test and burn iterations.`)
  }
  // A command whose binary resolves but is MALFORMED (nested/unbalanced quotes — e.g. an inline
  // `node -e "…\"…\""`) slips past the binary check, then fails at RUN time as a shell syntax error the loop
  // misreads as a failing test, burning iterations to an escalation. Catch it here, before the night.
  const accSyntax = shellSyntaxError(plan.acceptance)
  if (accSyntax) {
    fail(
      `Acceptance command has a shell syntax error — it would fail every iteration as a "failing test":\n  ${accSyntax}\n  → \`${plan.acceptance}\`\n` +
        '  Keep `acceptance` a SIMPLE command (e.g. `node --test`) and put assertions in a TEST FILE listed in `scope:` — an inline `node -e "…"` with nested quotes breaks under /bin/sh.'
    )
  }
  // Same guard for the held-out command — a broken one is WORSE: a non-zero exit reads as GAMED, so it
  // would falsely reject correct work as reward-hacking. (A syntax error inside the command still slips
  // past a binary check — the loop now surfaces the held-out's output so that case is self-diagnosing.)
  if (plan.heldout) {
    const hbin = commandBinary(plan.heldout)
    if (hbin && /^[\w./-]/.test(hbin) && !resolvesOnPath(hbin)) {
      fail(`Held-out command isn't runnable: \`${plan.heldout}\` (\`${hbin}\` is not on your PATH). Fix it — a broken held-out reads as GAMED and rejects correct work.`)
    }
    const heldSyntax = shellSyntaxError(plan.heldout)
    if (heldSyntax) {
      fail(`Held-out command has a shell syntax error — a non-zero exit reads as GAMED and would reject correct work:\n  ${heldSyntax}\n  → \`${plan.heldout}\`\n  Prefer a held-out command in a FILE over an inline one with nested quotes.`)
    }
  }
}

// --- plan drafting (Research → Plan) ---
// The upstream gate the research calls highest-leverage ("reviewing the plan gives more
// leverage than reviewing the code"). The engine explores the repo and DRAFTS a structured
// Plan; the human reviews/approves it, then runs `temper run`. Drafting is genuine judgment,
// so it is a legitimate LLM step — Temper does not gate or commit here.
function planDraftPrompt(task) {
  return (
    'You are drafting an implementation Plan for the task below, to be executed by an automated, gated loop.\n\n' +
    'FIRST explore this repository (read the relevant files) so the plan is grounded in the real code.\n' +
    'THEN output the Plan and NOTHING ELSE — no preamble or trailing commentary, and do NOT wrap the whole ' +
    'plan in a code fence (short code snippets INSIDE the plan are fine) — in EXACTLY this format:\n\n' +
    '---\nscope:\n  - "<exact file or narrow glob to touch>"\nacceptance: "<SIMPLE command that exits 0 when correct, e.g. node --test>"\n---\n' +
    '# <short imperative title>\n\n' +
    '## Context\n<the specific existing code this plan builds on — the files/functions involved and how they ' +
    'CURRENTLY work — and the ASSUMPTIONS this plan rests on: the things that, if wrong, would make the plan ' +
    'wrong. This is the highest-leverage section for the human to review, so make every assumption explicit.>\n\n' +
    '## Goal\n<what is true when done — behaviour, not implementation>\n\n' +
    '## Steps\n1. <precise, phased steps; which files change and how>\n\n' +
    "## What we're NOT doing\n<explicit out-of-scope boundaries>\n\n" +
    '## Verification\n- Automated: <the acceptance command>\n- Manual: <what the human checks>\n\n' +
    'Rules: list the EXACT files in `scope:` (this is the change boundary — keep it tight); ground the Context ' +
    'in code you actually read; resolve every decision (no open questions / TBD); prefer extending existing code over adding new files. ' +
    'Keep `acceptance:` a SIMPLE shell command (`node --test`, `npm test`, or the repo test runner) and put real assertions in a TEST FILE listed in `scope:` — NEVER an inline `node -e "…"` with nested quotes (it runs through /bin/sh and breaks).\n\n' +
    `TASK: ${task}\n`
  )
}

// Extract the Plan from the engine's raw draft output: slice from the frontmatter start (dropping any
// preamble or a leading wrapper fence), then — only if the ``` fence markers are UNBALANCED (an odd
// count) — drop from the last marker onward (a wrapping ``` the engine added, plus any trailing prose).
// Balanced fences are legitimate code snippets INSIDE the plan (Context/Steps) and are KEPT — a greedy
// "strip from the first fence to EOF" used to truncate any plan that contained a code block.
export function extractPlanDraft(raw) {
  const text = normalizeNewlines(raw)
  const start = text.indexOf('---\n')
  const lines = (start >= 0 ? text.slice(start) : text).split('\n')
  let fences = 0
  let lastFence = -1
  lines.forEach((l, idx) => {
    if (/^```/.test(l)) {
      fences++
      lastFence = idx
    }
  })
  const kept = fences % 2 === 1 ? lines.slice(0, lastFence) : lines
  return kept.join('\n').trimEnd() + '\n'
}

// Draft a Plan for `task` via the READ-ONLY critic command (explores the repo but cannot edit it, so
// drafting never mutates the tree), returning the extracted plan text. Shared by `temper plan` (one task)
// and `temper tasks` (a batch).
export function draftPlan(cfg, task) {
  const { out: raw } = callCli(cfg.criticCommand, planDraftPrompt(task), cfg)
  return extractPlanDraft(raw)
}

// Fast lane: drop the PLAN template (no engine) so you can fill in scope + acceptance and `temper run` in a
// single round-trip when you already know the change, instead of waiting on a full engine draft.
export function writePlanTemplate(outPath, force) {
  const out = typeof outPath === 'string' ? outPath : join(process.cwd(), 'PLAN.md')
  if (existsSync(out) && !force) fail(`${out} already exists. Pass --force to overwrite, or --out <path> to write elsewhere.`)
  writeFileSync(out, readFileSync(new URL('../templates/PLAN.template.md', import.meta.url), 'utf8'))
  log(`✓ wrote ${out} from the template. Fill in scope + acceptance + the spec, then run \`temper run${typeof outPath === 'string' ? ` ${out}` : ''}\`.`)
}

export function runPlanDraft(cfg, task, outPath, force) {
  if (!task) fail('Usage: temper plan "<task description>" [--out <path>] [--force]')
  const out = typeof outPath === 'string' ? outPath : join(process.cwd(), 'PLAN.md')
  if (existsSync(out) && !force) {
    fail(`${out} already exists — pass --force to overwrite, or --out <path> to write elsewhere.`)
  }
  log(`▶ drafting a Plan for: ${task}\n`)
  const planText = draftPlan(cfg, task)
  writeFileSync(out, planText)
  log(`✓ draft written to ${out}`)
  // Validate the way the runner will (frontmatter with a scope list) so the check agrees with parsePlan.
  const fm = normalizeNewlines(planText).match(/^---\n([\s\S]*?)\n---/)
  if (fm && /\bscope:/.test(fm[1]) && /^\s*-\s+\S/m.test(fm[1])) {
    log('  Looks well-formed — review the scope + acceptance and resolve any open questions, then run it.')
  } else {
    log('  ⚠ draft is missing a scope/frontmatter block — edit it into shape before running.')
  }
  log(`\nThen: temper run ${out}`)
}
