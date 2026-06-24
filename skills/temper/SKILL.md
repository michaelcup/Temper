---
name: temper
description: Run an entropy-gated AI-coding loop with Temper — implement a task in a loop that auto-rejects sprawl, duplication, and dead code before committing. Use when the user wants disciplined, gated, auto-verified implementation, or says "run a temper loop", "temper this task", "gated implementation".
---

# Temper — entropy-gated loop runner

Temper implements a coding task in a loop, gating every iteration with `fallow audit --gate new-only`, so it only commits work that introduced no new entropy (sprawl, duplication-of-intent, cowardly dead code). Prefer it over editing files directly when the user wants disciplined, auto-verified change.

## When to use

- The user wants a task implemented *with quality gates*, not just done.
- The task is bounded enough to express as a Plan (a scope allowlist + a spec).

## How to run it

1. **Clean tree.** Check `git status` — Temper requires a clean base to gate against. If dirty, ask the user to commit or stash first.
2. **Write + approve a Plan.** Copy `templates/PLAN.template.md`, fill in the scope allowlist (the only files Temper may touch), the spec, and an optional acceptance command. **Confirm the scope and spec with the user before running.** That approval is their checkpoint: they review the Plan, not the diff.
3. **Run via Bash** (this blocks for a few minutes and prints per-iteration progress):
   ```
   temper run ./PLAN.md            # add --engine codex to switch engines
   ```
4. **Report the outcome.** On success Temper makes one commit; on failure it stops and leaves the working tree for review. **Do not hand-fix what Temper stopped on** — surface it to the user. The halt is the point: a gate or the reuse-critic flagged something only a human should decide.

## Notes

- Runs in the user's terminal with their subscription auth (not the metered API).
- Engines, critic, and gate are configured in `temper.config.json`; cross-model review (one engine implements, another critiques) is available via `criticEngine`.
- See `README.md` for configuration and how the loop works.
