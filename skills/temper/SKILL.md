---
name: temper
description: Run an entropy-gated AI-coding loop with Temper — implement a change in a loop that auto-rejects sprawl, duplication, and dead code, committing only work that passes the gate. Use when the user wants a multi-step or risky change implemented carefully ("implement X without breaking anything", "keep the diff tight", "only touch these files", "refactor without adding cruft", "gate it before committing", or explicitly "temper this" / "gated implementation") — even if they never say "loop". For a LARGE batch or unattended pass ("work through this overnight", "run the whole backlog", "do a big batch"), use overnight mode. NOT for a trivial one-line/typo/rename edit, a throwaway script, an open-ended unscoped refactor, or a dirty tree the user wants to review as a diff rather than approve as a Plan.
---

# Temper — entropy-gated loop runner

Temper implements a coding change in a loop, gating every iteration so it only commits work that
introduced no new entropy (sprawl, duplication-of-intent, dead code) and passes your tests. Prefer it
over editing files directly when the user wants disciplined, auto-verified change.

## When to use

- The user wants a change implemented *with quality gates*, not just done.
- The work is bounded enough to express as a Plan (a scope allowlist + a spec).
- One bounded task → run it. A large batch / overnight pass → queue it (see below).
- NOT for a trivial one-liner, a throwaway script, or a change the user wants to hand-review as a diff.

## One task — `temper run`

1. **Clean tree.** Check `git status`; Temper gates against a clean base. If dirty, ask the user to commit or stash.
2. **Draft + approve a Plan.** Run `temper plan "<task>"` to draft `./PLAN.md`, then fill/confirm the
   scope allowlist (the only files Temper may touch), the spec, and an optional acceptance command.
   **Confirm the scope and spec with the user before running** — that approval is their checkpoint
   (they review the Plan, not the diff).
3. **Run it** (blocks for a few minutes, prints per-iteration progress):
   ```
   temper run ./PLAN.md            # add --engine codex to switch engines
   ```
4. **Report the outcome.** On success Temper makes one commit; on failure it stops and leaves the tree
   for review. **Do not hand-fix what Temper stopped on** — surface it to the user. The halt is the
   point: a gate or the reuse-critic flagged something only a human should decide.

## A large batch — `temper overnight`

For a big pass of work (many tasks, an evening's worth), draft the queue from a task list with
`temper tasks <file>` (one task per line; it writes a scoped Plan per line for you to review, and
`temper tasks add "<task>"` appends one), or place approved Plans as ordered files in a queue dir yourself.
Then run them unattended:
```
temper overnight ./plans          # own branch, never merged; writes a morning report
```
It runs sequentially, survives the subscription rate-limit (sleeps + resumes), and isolates all work on
its own branch. In the morning, review the report and the branch. Same rule: don't hand-fix a halt.

## Cleaning up dead code — `temper audit`

`temper audit` scans the codebase with fallow and drafts scoped dead-code cleanup Plans into `.temper/audit`
for you to review and prune, then `temper overnight .temper/audit` removes them, gated. It proposes; it never
deletes on its own. JS/TS only (it is a fallow bridge).

## Notes

- Runs in the user's terminal with their subscription auth (not the metered API).
- Engines, critic, and gate are configured in `temper.config.json`; cross-model review (one engine
  implements, another critiques) is available via `criticEngine`.
- See `README.md` for configuration and how the loop works.
