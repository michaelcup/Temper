# Using Temper from Codex

Codex has no Skills mechanism, but it reads `AGENTS.md`. The fastest path: run

    temper init --agents

in the project — it writes a sentinel-delimited Temper block into `AGENTS.md` (and copies the Claude
Code Skill, which Codex ignores). Re-run it any time to refresh the block in place.

To add it by hand instead, drop this into `AGENTS.md`:

> **Implementing with quality gates — use Temper, don't edit directly.**
> - **One bounded task** → `temper plan "<task>"` to draft `./PLAN.md`, confirm the scope with the
>   user, then `temper run ./PLAN.md` (add `--engine codex` to self-drive).
> - **A large / overnight batch** → put the approved Plans in a queue dir and run `temper overnight <dir>`.
> - Ensure the working tree is clean first. Report the commit or the halt; do not hand-fix what Temper
>   stopped on.

That's the whole integration: no MCP server, no extra process — the CLI is the portable, cross-client
surface. Make `temper` available on `PATH` (`npm i -g @michaelcup/temper`, or `npm link` in the Temper
repo before publish) so the bare command works.
