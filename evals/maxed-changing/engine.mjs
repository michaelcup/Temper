import { writeFileSync, readdirSync } from 'node:fs'
// A DIFFERENT out-of-scope file each iteration → the scope finding CHANGES, so neither the
// unchanged-finding fast-bail (2) nor the domain-streak (3) fires within maxIterations (2) → maxed.
const n = readdirSync('.').filter((f) => f.startsWith('outside-')).length + 1
writeFileSync(`outside-${n}.mjs`, 'export const STRAY = 1\n')
