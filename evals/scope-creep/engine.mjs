import { writeFileSync } from 'node:fs'
writeFileSync('outside.mjs', 'export const STRAY = 1\n')
