# Temper

**Let your coding agent loop, and commit only what survives the gate.** The work that reaches your
git history passed a deterministic check: in scope, no dead code, no duplication, your tests green.
Queue a night of it and you wake up to review-ready commits, not a tree you have to unpick.

Temper is a thin, engine-agnostic, zero-dependency loop runner for AI coding. You approve one
*Plan*; it drives a coding agent (Claude Code or Codex, on your own subscription) in a loop and
**commits only work that introduced no new entropy**. It is not a coding agent, a node-graph, or an
API client; it buys the engine and the gate, and adds the loop.

## The loop

```
Plan (you approve)
  └─ repeat up to maxIterations:
       engine implements (claude -p / codex exec)          ← your subscription
       scope check    (git diff vs the Plan allowlist)     ← deterministic
       protect check  (no edits inside temper:protect)      ← deterministic
       gate           (fallow audit --gate new-only)       ← deterministic, regression-scoped
       suppression    (no new fallow-ignore / @ts-ignore…) ← deterministic, anti-gaming
       acceptance     (your test/command, optional)        ← deterministic
       ├─ any violation → re-prompt (fix the root cause; show evidence)
       │     └─ same domain stuck N× → escalate to you (don't burn iterations)
       └─ all green → reuse-critic (semantic, repo-searching)            ← LLM judgment
                    → held-out check (hidden command, if any)            ← deterministic, anti-gaming
                    → commit
```

Everything deterministic is code. The **engine** and the **reuse-critic** are
the only LLM steps. The critic's reliability is measured, not assumed (`npm run critic-check`).

## Run it

> ⚠️ Temper runs in **your own terminal**, where `claude` / `codex` hold real subscription
> credentials. It **cannot** run inside Claude Code's web, desktop "Remote", or Cowork sandboxes
> (they withhold your subscription auth, so the nested `claude -p` 401s) — run it from a plain
> terminal. The deterministic core is covered by `temper eval`; the engine integration is verified
> end-to-end with both Claude and Codex.

**Prerequisites:** Node 18+, `git`, and an engine (`claude` or `codex`) installed and logged in.
`fallow` is **optional** (`npm i -g fallow`) — it adds the deterministic dead-code/duplication/complexity
gate; without it, Temper runs the loop on the other gates and skips that one. `temper doctor` checks
everything.

```bash
# one-time: clone, then put `temper` on your PATH
git clone https://github.com/michaelcup/Temper && cd Temper && npm link

# then, from inside the repo you want to work on:
temper doctor                         # check prerequisites
temper init                           # scaffold config — do this FIRST (entry-point-aware fallow config)
temper plan "add a foo widget"        # draft a Plan from the codebase
$EDITOR ./PLAN.md                     # review + approve it (scope allowlist + spec + acceptance)
temper run ./PLAN.md                  # add --engine codex to switch engines
```

The working tree must be clean before a run (Temper needs a clean base to gate
against). On success it makes one commit; on failure it leaves the tree for you
to inspect and commits nothing.

## Commands

| command | what it does |
|---|---|
| `temper init` | scaffold `temper.config.json` + an **entry-point-aware** `.fallowrc.json` so the dead-code gate doesn't false-positive on new exports/tests |
| `temper plan "<task>" [--out <path>]` | the engine explores the codebase and **drafts a Plan** for you to approve (Research → Plan) |
| `temper run <plan.md>` | run one approved Plan to a green gate (Mode A) |
| `temper run-phases <dir> [--overnight] [--branch <b>]` | run ordered phase Plans (`01-*.md`, `02-*.md`), each gated against the prior commit; resumable via `.temper/progress.json`, stops on a failing phase. `--overnight` = **Mode B** (below) |
| `temper status` | summarize the current/last queue from the ledger (works mid-run, including after a detached overnight run) |
| `temper explain <gate>` | what a gate or verdict means and how to clear it (e.g. `temper explain fallow-audit`) |
| `temper eval [--filter <id>] [--update-baseline]` | run the deterministic golden-task regression suite (exit 1 on any regression) |
| `temper doctor` | check prerequisites |

All accept `--engine <name>`. Exit codes: `0` committed · `1` error · `2` critic-halt · `3` max-iterations · `4` stuck-domain escalation · `5` held-out check failed (gaming) · `6` over global budget.

## Protected regions

Lock code an agent must not touch by wrapping it in sentinel comments. Any change
whose diff overlaps the region is rejected and re-prompted. The guard is
deterministic, language-agnostic, and zero-config: it lives in the source and travels with it.

```js
// temper:protect-start auth
export function verifyToken(t) { /* … */ }
// temper:protect-end
```

## Two engines: switch, or use both

Temper is engine-agnostic. Engines are named presets in config (`claude` and
`codex` ship by default):

```jsonc
{
  "engine": "claude",        // which preset implements
  "criticEngine": "codex",   // which preset reviews — set to the OTHER engine
                             // for cross-model review (stronger than self-review)
  "fallowCommand": "npx fallow",
  "entropyGate": null,       // null = `<fallowCommand> audit --gate new-only` (JS/TS). Override with ANY
                             // command for another language (see "Languages"); `{base}` = the base SHA
  "maxIterations": 5,
  "maxDomainRetries": 3,     // escalate after N consecutive same-domain failures
  "maxUnchangedRetries": 2,  // escalate sooner when the SAME finding recurs unchanged (~1 retry)
  "criticMode": "warn",      // warn | halt | off
  "checkCompleteness": false,// opt-in: an LLM check that the diff implements the whole Plan
  "commitPrefix": "temper:",
  "maxQueueSeconds": null,   // Mode B: hard wall-clock budget for the whole queue (excl. cap-waits)
  "maxQueueIterations": null,// Mode B: hard cap on total engine iterations across all phases
  "rateLimit": {             // Mode B: survive the subscription cap (deep-merges with defaults)
    "fallbackSeconds": 1800, //   wait this long if no reset time is parseable, then retry
    "marginSeconds": 60      //   wait this much past the parsed reset, for clock skew
  },
  "notifyCommand": null,     // Mode B: shell hook on a terminal outcome (done / needs you).
                             //   gets $TEMPER_EVENT/$TEMPER_SUMMARY/$TEMPER_BRANCH/$TEMPER_REPORT.
                             //   e.g. "curl -d \"$TEMPER_SUMMARY\" ntfy.sh/my-topic"
  "engines": {
    "claude": {
      "engine": "cat {promptFile} | claude -p --permission-mode acceptEdits",
      "critic": "cat {promptFile} | claude -p"
    },
    "codex": {
      "engine": "cat {promptFile} | codex exec --sandbox workspace-write",
      "critic": "cat {promptFile} | codex exec --sandbox read-only"
    }
  }
}
```

- **Switch engines:** `temper run plan.md --engine codex`, or set `"engine"`.
- **Use both (recommended):** set `criticEngine` to the *other* engine. One model
  implements, the other reviews the diff, so the critic doesn't share the
  implementer's blind spots. Cost: it uses *both* subscriptions, so both
  rate-limit ceilings apply.
- **Other CLIs** (amp, opencode, …): add a preset under `engines`.

The default flags are best-effort. Verify your CLI's exact headless-edit flags.

## Languages

Temper is **mostly language-agnostic**. Scope-lock, protected regions, the suppression guard, your
acceptance tests, the reuse-critic, and held-out checks all work on any language. Only the **entropy
gate** (dead code / duplication / complexity) is JS/TS-specific, because it's `fallow`.

- **JS/TS:** the default — `fallow` gives the entropy gate, scoped to what the change *introduced*.
- **Any other language:** Temper runs today on the gates above (fallow is optional). To add a
  deterministic entropy gate too, set `entropyGate` to a tool of your choice — any command, where a
  non-zero exit means "new entropy." `{base}` is substituted with the base commit SHA. Caveat:
  fallow's `--gate new-only` fails only on what the change *introduced*; a tool without that scoping
  will also flag pre-existing issues, so scope it to the diff (e.g. against `{base}`).
- The **suppression guard** already covers JS/TS, Python, Rust, Go, and Ruby silencing directives;
  add a pattern in `src/gates.mjs` to cover another.

**Prose counts too.** The same anti-entropy discipline applies to docs: the engine prompt tells the
agent to update an existing doc rather than spawn a new one and to keep writing terse, and the
**reuse-critic** now also flags a new doc that restates one that already exists. For a deterministic
guard, point `entropyGate` at the bundled recipe — `"entropyGate": "node examples/doc-gate.mjs {base}"`
— which fails when a change adds a new markdown file, nudging "update, don't create."

## Overnight mode (the unattended Plan-queue)

`temper overnight <dir>` runs an ordered queue of Plans unattended and is built to survive a night.
The design follows the people who've actually shipped with overnight agents (Huntley's Ralph,
HumanLayer): **sequential, one task at a time, never parallel fan-out, and never auto-merge.** It
layers these on the resumable phase sequencer:

- **Rate-limit survival.** The subscription cap, not the clock, is the ceiling. When the engine CLI
  reports the cap, Temper parses the reset time, sleeps, and resumes. Tune via `rateLimit` in config
  (it deep-merges, so override one field freely).
- **Branch isolation, no auto-merge.** The whole queue runs on a stable `temper/<dir>` branch.
  **The base branch is never touched and nothing is merged**, and you're **restored to your base
  branch** when the run ends (the work stays on `temper/<dir>` for you to review and merge). Re-running
  resumes on the same branch, skipping what already landed.
- **A run budget.** `maxQueueSeconds` / `maxQueueIterations` (in config, or per run via
  `--max-queue-seconds` / `--max-queue-iterations`) cap a single overnight invocation (above the
  per-phase `maxIterations` + stuck-domain escalation). Over budget ⇒ stop, exit 6. The budget is
  **per invocation**: a resume starts a fresh budget, so give any auto-retry loop its own ceiling.
- **A morning report.** `.temper/report.md` (what committed, what stopped it and why,
  what's left) plus `temper status` to check progress at any time.
- **A notify hook.** Set `notifyCommand` to be pinged on the terminal outcome (done, or
  escalated/gamed/over-budget and needs you), via `$TEMPER_EVENT` / `$TEMPER_SUMMARY` /
  `$TEMPER_BRANCH` / `$TEMPER_BASE` / `$TEMPER_REPORT`. Wire it to ntfy, Slack, or `osascript`.
- **A direction check (opt-in).** The per-iteration gates check *did we do it right*; this checks
  *are we doing the right thing*. Before a phase, Temper can ground its APPROACH against a trust-list
  you supply and flag work built on a deprecated/superseded/contradicted premise before it compounds
  across the night. Off by default — see below.

**Setting up the queue.** Phase files are ordered Plans (`01-*.md`, `02-*.md`, …), each the same
format as a `temper run` Plan. Draft them with `temper plan` and `--out`:

```bash
mkdir -p .temper/phases
temper plan "phase 1: extract the slug helper"  --out .temper/phases/01-slug.md
temper plan "phase 2: use it in the router"     --out .temper/phases/02-router.md
# review each, then run the queue:
temper overnight .temper/phases
```

Run it detached in your own terminal (it needs your real subscription auth, so no cloud/host session):

```bash
# tmux survives SSH drops / closing the laptop lid (on a remote host); or use nohup
tmux new -s temper 'temper overnight .temper/phases > temper.log 2>&1'
# …in the morning:
temper status
git log temper/<branch>           # review, then merge yourself
```

The failure policy is **stop the queue**: a failing phase halts the run with earlier phases
committed; fix it and re-run (the ledger skips what already landed). Decomposition (the ordered
phase files) and the final merge stay **human jobs**, the two places judgment matters most.

**Direction check (opt-in).** For a long queue against a fast-moving framework, point it at your
trusted sources so it flags work built on a superseded approach *before* it compounds. It stays off
until you give it sources:

```jsonc
"directionCheck": {
  "enabled": true,
  "sources": ["docs/architecture.md", "https://your-framework.dev/docs/migration"], // local paths + URLs
  "every": 1,          // check every Nth phase (1 = every phase)
  "onMiss": "warn"     // "warn": flag it in the report · "pause": stop the queue before the phase (exit 7)
}
```

The check is one bounded question to the critic engine, grounded **only** in your sources (local files
are read directly; URLs are fetched only if the engine has web tools) — never the open web, so an
untrusted page can't steer it. It's fail-open (an unparseable verdict never blocks) and overnight-only.

## First-run checklist (the things most likely to bite)

0. **Run `temper init` first.** Without an entry-point-aware fallow config, the dead-code
   gate flags new **library exports** and **test files** as "unused — not reachable from an
   entry point," so *adding a new exported function escalates instead of committing*. `temper
   init` scaffolds a `.fallowrc.json` that treats tests as entry points (and fallow already
   treats `package.json` `exports`/`main`/`bin` as the library API). If you skip it, `temper run`
   now catches the gap first: on a project that has tests but no fallow config it scaffolds the
   config and stops with the one-command fix, rather than letting the gate false-positive mid-run.
   `temper doctor` warns too. **This was the #1 dogfood footgun.**
1. **Does your `engineCommand` actually edit files headlessly?** Run it by hand
   on a throwaway task first. This is the #1 *engine* failure mode.
2. **Is `fallow` resolvable?** `temper doctor` will tell you; set `fallowCommand`
   to `npx fallow` or `node_modules/.bin/fallow` if not.
3. **Subscription rate limits** are Mode B's ceiling: a long run can stall until
   your cap resets. That's the cost of avoiding the metered API (ADR-0003).
4. **Install your project's deps first** (`npm install`). fallow warns on a missing
   `node_modules`, and an over-eager agent may chase that warning *out of scope*. The
   scope gate will (correctly) reject it, but the loop won't converge.

## Use it from inside Claude Code / Codex

Temper is exposed as a **tool by wrapping its CLI**, not via an MCP server (MCP's always-on
context cost isn't worth it for a CLI-shaped tool).

- **Claude Code:** install the Skill at [`skills/temper/SKILL.md`](skills/temper/SKILL.md)
  (copy or symlink it into `~/.claude/skills/temper/` or a project `.claude/skills/`).
  It tells the agent when and how to invoke `temper` via Bash, costing ~100 tokens
  until it's actually used.
- **Codex:** see [`integrations/codex.md`](integrations/codex.md), and point its
  `AGENTS.md` / custom prompt at the same `temper` command.

The CLI is the portable, cross-client surface; both integrations just drive it.

## Status

**Mode A** (one Plan → green gate) is done and `temper eval`-covered, hardened with
stuck-domain + unchanged-finding escalation, within-file protected regions, an optional
diff-vs-Plan completeness check, held-out checks, and a repo-searching reuse-critic whose
reliability is **measured** (`npm run critic-check`: catches real + semantic duplication, 0%
flip on no-op refactors). **Mode B** (the overnight Plan-queue) is built: `run-phases --overnight`
with rate-limit survival, branch isolation, a global budget, a morning report, a notify hook, and
`temper status`, covered by `test/modeb.test.mjs` (`npm test` runs `temper eval` + the integration
suites). `temper plan` drafts Plans from the codebase, including an explicit Context/assumptions
section for you to review.

The tool is **feature-complete**: the highest-leverage work now is dogfooding and polish, not new
capability.
