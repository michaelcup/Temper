// Plan handling: parse + validate the human-approved Plan, and the Research→Plan drafting step.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log, fail, commandBinary, resolvesOnPath } from './sh.mjs'
import { callCli } from './engine.mjs'

// Collapse CRLF/CR to LF so the literal-`\n` plan regexes below match CRLF files too.
const normalizeNewlines = (s) => s.replace(/\r\n?/g, '\n')

export function parsePlan(path) {
  if (!existsSync(path)) fail(`Plan not found: ${path}`)
  const raw = normalizeNewlines(readFileSync(path, 'utf8'))
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) fail('Plan must start with a `---` frontmatter block — see templates/PLAN.template.md.')
  const [, front, body] = m
  const scope = [...front.matchAll(/^\s*-\s+(.+)$/gm)].map((x) => x[1].trim().replace(/^["']|["']$/g, ''))
  const acc = front.match(/^acceptance:\s*(.+)$/m)
  const held = front.match(/^heldout:\s*(.+)$/m)
  const title = body.match(/^#\s+(.+)$/m)
  if (!scope.length) fail('Plan frontmatter must list at least one scope glob under `scope:`.')
  return {
    scope,
    acceptance: acc ? acc[1].trim().replace(/^["']|["']$/g, '') : null,
    // A hidden check the engine never sees — run only after every visible gate passes,
    // to catch work that satisfied the visible checks without satisfying the spec.
    heldout: held ? held[1].trim().replace(/^["']|["']$/g, '') : null,
    title: title ? title[1].trim() : 'temper change',
    body: body.trim(),
  }
}

// Rejects an underspecified plan before any work runs (research: a final plan has no open questions).
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
    '---\nscope:\n  - "<exact file or narrow glob to touch>"\nacceptance: "<command that exits 0 when the work is correct>"\n---\n' +
    '# <short imperative title>\n\n' +
    '## Context\n<the specific existing code this plan builds on — the files/functions involved and how they ' +
    'CURRENTLY work — and the ASSUMPTIONS this plan rests on: the things that, if wrong, would make the plan ' +
    'wrong. This is the highest-leverage section for the human to review, so make every assumption explicit.>\n\n' +
    '## Goal\n<what is true when done — behaviour, not implementation>\n\n' +
    '## Steps\n1. <precise, phased steps; which files change and how>\n\n' +
    "## What we're NOT doing\n<explicit out-of-scope boundaries>\n\n" +
    '## Verification\n- Automated: <the acceptance command>\n- Manual: <what the human checks>\n\n' +
    'Rules: list the EXACT files in `scope:` (this is the change boundary — keep it tight); ground the Context ' +
    'in code you actually read; resolve every decision (no open questions / TBD); prefer extending existing code over adding new files.\n\n' +
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
