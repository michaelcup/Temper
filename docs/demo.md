# Recording the hero demo

A short terminal GIF for the top of the README is the highest-value asset for a CLI tool. For Temper
it should **show a gate catching bad work** — that is the whole point, and it is invisible in prose.

The catch: Temper's gates are a safety net that rarely fires when the engine does a good job, so a
random recording just shows a clean commit. The two recipes below deliberately set up a scene where a
gate *will* fire on camera. **A** is the impressive one (not 100% guaranteed); **B** fires every time.
Each has a one-command setup script; run it, then record.

## Prerequisites

- `temper` on your PATH (`npm i -g @michaelrowejones/temper`).
- `fallow` installed and resolvable (`temper doctor` will confirm).
- A logged-in engine (`claude` or `codex`) in this terminal — Temper uses your real subscription.
- The recorder: `brew install asciinema agg` (`asciinema` records; `agg` renders the cast to a GIF).

## Recipe A — the reuse-critic halts on a hidden duplicate (the differentiator)

The agent re-implements something that already exists under a new name; Temper's semantic critic
catches it after every deterministic gate has passed.

```bash
sh docs/demo-setup-a.sh ~/tmp/temper-demo    # seeds slugify + a Plan that tempts a re-implementation
cd ~/tmp/temper-demo
```

Record the full reject → fix → commit arc in one cast:

```
asciinema rec demo.cast
#   temper run PLAN.md      → gates pass, then the reuse-critic HALTS: "duplicates slugify"
#   $EDITOR PLAN.md         → add a line: "Reuse the existing slugify from src/text.mjs."
#   temper run PLAN.md      → clean commit
#   exit
agg demo.cast demo.gif
```

> Honest caveat: Temper's engine explores the repo, so a sharp model may *reuse* slugify on its own
> and never trip the halt. That is a good outcome but a worse demo — record a couple of takes, or use B.

## Recipe B — protected region blocks the agent (deterministic, fires every time)

You ask the agent to rewrite a function that is locked behind a `temper:protect` sentinel. The task
*forces* editing the locked code, so the gate rejects every attempt and Temper escalates to you.

```bash
sh docs/demo-setup-b.sh ~/tmp/temper-demo-b   # seeds a locked total() + a Plan that must edit it
cd ~/tmp/temper-demo-b
asciinema rec demo.cast -c "temper run PLAN.md"
#   → the engine edits total() (inside temper:protect) → the protected-region gate REJECTS every
#     attempt → Temper escalates: "you asked me to change locked code." Guaranteed on camera.
agg demo.cast demo.gif
```

It ends in an escalation rather than a commit, which is its own strong story:
*"I told the agent to rewrite locked code; Temper refused and handed it back to me."*

## Which to use

Lead the README with **A** if you land a clean take — reject → fix → commit is the ideal arc. Keep
**B** as the dependable backup: it cannot fail to show a gate doing its job. Drop the resulting
`demo.gif` under the hero in the README.
