import { writeFileSync } from 'node:fs'
// Valid in-scope change every iteration; the (stub) fallow gate always fails with a DIFFERENT
// timing, so only normalized-finding comparison can recognize it as the SAME finding.
writeFileSync('src/x.mjs', 'export const X = 1\n')
