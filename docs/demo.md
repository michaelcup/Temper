# Recording the hero demo

A short terminal GIF for the top of the README is the highest-value asset for a CLI tool. For Temper
it should **show a gate catching bad work** — that is the whole point, and it is invisible in prose.

The catch: Temper's gates are a safety net that rarely fires when the engine does a good job, so a
random recording just shows a clean commit. The two recipes below deliberately set up a scene where a
gate *will* fire on camera. **A** is the impressive one (not 100% guaranteed); **B** fires every time.

## Prerequisites

- `temper` on your PATH (`cd /path/to/Temper && npm link`).
- `fallow` installed and resolvable (`temper doctor` will confirm).
- A logged-in engine (`claude` or `codex`) in this terminal — Temper uses your real subscription.
- The recorder: `brew install asciinema agg` (`asciinema` records; `agg` renders the cast to a GIF).

## Recipe A — the reuse-critic halts on a hidden duplicate (the differentiator)

The agent re-implements something that already exists under a new name; Temper's semantic critic
catches it after every deterministic gate has passed.

```bash
mkdir temper-demo && cd temper-demo && git init -q
git config user.email demo@local && git config user.name demo
mkdir src test
cat > src/text.mjs <<'EOF'
export function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
EOF
cat > test/text.test.mjs <<'EOF'
import { test } from 'node:test'; import assert from 'node:assert'
import { slugify } from '../src/text.mjs'
test('slugify', () => assert.equal(slugify('Hello World!'), 'hello-world'))
EOF
git add -A && git commit -qm "seed: text utils"

temper init                                   # entry-aware fallow config (avoids the new-export footgun)
sed -i.bak 's/"criticMode": "warn"/"criticMode": "halt"/' temper.config.json && rm -f temper.config.json.bak
git add -A && git commit -qm "chore: temper config (criticMode: halt)"

cat > PLAN.md <<'EOF'
---
scope:
  - "src/url.mjs"
  - "test/url.test.mjs"
acceptance: "node --test test/url.test.mjs"
---
# Add a URL-path helper
## Goal
Add `toUrlPath(title)` in src/url.mjs that lowercases a page title and turns spaces and
punctuation into single hyphens (no leading/trailing hyphens). Add a test in test/url.test.mjs.
## Steps
1. Create src/url.mjs exporting toUrlPath.
2. Add test/url.test.mjs covering it.
EOF
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
mkdir temper-demo-b && cd temper-demo-b && git init -q
git config user.email demo@local && git config user.name demo
mkdir src test
cat > src/pricing.mjs <<'EOF'
// temper:protect-start formula
export function total(items) {
  return items.reduce((sum, i) => sum + i.price, 0)
}
// temper:protect-end
EOF
cat > test/pricing.test.mjs <<'EOF'
import { test } from 'node:test'; import assert from 'node:assert'
import { total } from '../src/pricing.mjs'
test('total', () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5))
EOF
temper init && git add -A && git commit -qm "seed: pricing with a locked formula"

cat > PLAN.md <<'EOF'
---
scope:
  - "src/pricing.mjs"
acceptance: "node --test test/pricing.test.mjs"
---
# Rewrite total() as a for-loop
## Goal
Rewrite `total` in src/pricing.mjs to use an explicit for-loop instead of reduce.
## Steps
1. Replace the reduce with a for-loop in total().
EOF

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
