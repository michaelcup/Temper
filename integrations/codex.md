# Using Temper from Codex

Codex has no Skills mechanism, so wire Temper in through instructions Codex
already reads (its `AGENTS.md` or a custom prompt) pointing at the **same CLI**
the Claude Code Skill uses. The CLI is the portable, cross-client integration
surface.

Add to the project's `AGENTS.md` (or a Codex custom prompt):

> **Implementing with quality gates — use Temper, don't edit directly.**
> When a task should be implemented with entropy gates, use Temper:
> 1. Ensure the working tree is clean.
> 2. Write an approved Plan from `templates/PLAN.template.md` (scope allowlist +
>    spec + optional acceptance) and confirm the scope with the user.
> 3. Run `temper run ./PLAN.md` in the shell (use `--engine codex` to self-drive).
> 4. Report the commit or the halt. Do not hand-fix what Temper stopped on.

That's the whole integration: no MCP server, no extra process. Make `temper`
available on `PATH` (`npm link` in the Temper repo) so the bare command works.
