#!/bin/sh
# Build the Recipe B demo repo (see docs/demo.md): the Plan forces an edit inside a temper:protect
# region, so the protected-region gate rejects every attempt and escalates — guaranteed on camera. Usage:
#   sh docs/demo-setup-b.sh [dir]   # default ./temper-demo-b
# Then record:
#   cd <dir> && asciinema rec demo.cast -c "temper run PLAN.md"
set -eu

command -v temper >/dev/null 2>&1 || { echo "temper is not on your PATH (npm i -g @michaelrowejones/temper)"; exit 1; }
dir="${1:-temper-demo-b}"
[ -e "$dir" ] && { echo "$dir already exists — pick another dir"; exit 1; }

mkdir -p "$dir" && cd "$dir" && git init -q
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

echo
echo "✓ demo repo ready in $dir"
echo "Record it (ends in an escalation — that is the story):"
echo "  cd $dir && asciinema rec demo.cast -c \"temper run PLAN.md\""
echo "  agg demo.cast demo.gif"
