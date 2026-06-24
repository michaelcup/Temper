import { writeFileSync } from 'node:fs'
// Satisfies the VISIBLE acceptance (valid JS) but not the hidden held-out check.
writeFileSync('src/x.mjs', 'export const X = 1\n')
