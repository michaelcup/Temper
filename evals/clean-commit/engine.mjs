import { writeFileSync } from 'node:fs'
writeFileSync('src/version.mjs', "export const VERSION = '2.0.0'\n")
