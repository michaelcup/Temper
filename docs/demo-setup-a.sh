#!/bin/sh
# Build the Recipe A demo repo (see docs/demo.md): a seeded slugify helper plus a Plan that tempts
# the agent to re-implement it, so the reuse-critic halts on camera. Usage:
#   sh docs/demo-setup-a.sh [dir]   # default ./temper-demo
# Then record:
#   cd <dir> && asciinema rec demo.cast
set -eu

command -v temper >/dev/null 2>&1 || { echo "temper is not on your PATH (npm i -g @michaelrowejones/temper)"; exit 1; }
dir="${1:-temper-demo}"
[ -e "$dir" ] && { echo "$dir already exists — pick another dir"; exit 1; }

mkdir -p "$dir" && cd "$dir" && git init -q
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

temper init
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

echo
echo "✓ demo repo ready in $dir"
echo "Record the reject → fix → commit arc in one cast:"
echo "  cd $dir && asciinema rec demo.cast"
echo "  temper run PLAN.md     # gates pass, then the reuse-critic HALTS: duplicates slugify"
echo "  \$EDITOR PLAN.md        # add: 'Reuse the existing slugify from src/text.mjs.'"
echo "  temper run PLAN.md     # clean commit"
echo "  exit                   # stop recording, then: agg demo.cast demo.gif"
