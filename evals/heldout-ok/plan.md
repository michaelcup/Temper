---
scope:
  - "src/**"
acceptance: "node --check src/x.mjs"
heldout: "grep -q CORRECT src/x.mjs"
---
# set X
Set X to 1 in src/x.mjs.
