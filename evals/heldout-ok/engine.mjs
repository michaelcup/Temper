import { writeFileSync } from 'node:fs'
writeFileSync('src/x.mjs', 'export const X = 1 // CORRECT\n')
