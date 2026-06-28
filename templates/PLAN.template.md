---
# Exact files Temper may touch. Prefer specific files / narrow globs over broad
# ones. The tighter this list, the tighter the sprawl gate.
scope:
  - "src/feature/thing.ts"
  - "test/feature/thing.test.ts"
# Automated verification: a command that must exit 0 for the work to be accepted.
# (Manual / human verification — UI, UX, performance — goes in the body below.)
acceptance: "npm test -- thing"
# Optional removal-completeness gate: literal identifiers / op-ids / paths that must NOT survive anywhere
# after this change (the deletion-side mirror of scope). A green gate proves none remain, checked with
# `git grep -F` (fixed strings — no regex, no shell). Caveat: matching is substring, so pick distinctive terms.
# removes:
#   - "external_site.agent_handoff.create"
#   - "/admin/site/anpa-external-workflows"
# removesRoot:  # optional; narrows where to search (default: the whole repo)
#   - "src"
#   - "docs"
# Optional held-out check: run ONLY after every visible gate passes, and never shown
# to the engine. If the work passes the visible gates but fails this, it's treated as
# gaming: rejected and escalated. Use a check distinct from `acceptance`.
# heldout: "npm run test:integration -- thing"
---
# Short title — becomes the commit subject

## Context
The existing code this builds on: the files/functions involved and how they CURRENTLY work,
plus the **assumptions** this plan rests on (the things that, if wrong, would make the plan wrong).
Review this section first. A wrong assumption compounds into wrong code.

## Goal
What is true when this is done? Describe behaviour, not implementation.

## Steps
1. Precise, phased steps — which file changes, and how.
2. …

## What we're NOT doing
Explicit scope boundaries: things deliberately left out of this task.

## Verification
- **Automated** (Temper runs `acceptance`): the tests above pass; build / typecheck clean.
- **Manual** (you check): e.g. the page renders correctly, the flow feels right.

<!-- A final plan has NO open questions. Decide everything before running —
     Temper refuses a plan containing TBD / ??? / "open question". -->
