import { writeFileSync } from 'node:fs'
writeFileSync('src/orphan.mjs', 'export const ORPHAN = 42\n')
