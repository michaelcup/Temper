# Releasing Temper

The deterministic suite runs in CI, but the reuse-critic's reliability cannot: it needs a real
engine on a real subscription. So a release is gated by this checklist, run in your own terminal.

## Before every `npm publish`

1. **`npm test`** — the golden-task evals plus the unit suite. CI runs the same thing; both must be green.
2. **`npm run critic-check`** — the real-engine critic reliability check (about 14 engine calls).
   Expect 8/8 correct and 0/4 no-op flips. A green run writes `evals/critic-check-last-pass.json`;
   commit it. This is the drift guard: a model update can silently change the critic's judgment,
   and this file is the dated evidence it was still sound at release time.
3. **`npm run trigger-check` and `npm run reconcile-check`** if the routing or reconcile prompts changed.
4. Bump `version` in `package.json`.
5. Commit, then tag and push: `git tag v<version> && git push && git push --tags`.
6. `npm publish` (the scoped package is public; publishing uses the granular npm token).
7. Sanity-check the artifact: `npx -y @michaelrowejones/temper@latest --version` prints the new version.

## When is critic-check mandatory?

Any release where one of these changed since the last recorded pass:

- the critic prompt (`runCritic` in `src/engine.mjs`)
- the default engine presets, or the model behind them (a CLI update counts)
- `criticMode` defaults or how verdicts are parsed

If none of those changed and `evals/critic-check-last-pass.json` is recent, steps 1 and 4 through 7 suffice.
