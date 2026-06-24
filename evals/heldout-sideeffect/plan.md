---
scope:
  - "src/**"
acceptance: "node --check src/x.mjs"
heldout: "node --check src/x.mjs && printf junk > out-of-scope.txt"
---
# set X
Set X to 1 in src/x.mjs.
