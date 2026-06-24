import { writeFileSync, readdirSync } from 'node:fs'
// Always writes OUTSIDE scope, a DIFFERENT file each iteration, so the scope domain recurs with a
// CHANGING finding — exercising the domain-streak escalation (not the unchanged-finding fast-bail).
const n = readdirSync('.').filter((f) => f.startsWith('outside-')).length + 1
writeFileSync(`outside-${n}.mjs`, 'export const STRAY = 1\n')
