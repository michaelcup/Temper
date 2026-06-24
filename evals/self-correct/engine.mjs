import { readFileSync, writeFileSync } from 'node:fs'
const cur = readFileSync('src/version.mjs', 'utf8')
const next = cur.includes('8.8.8') ? '9.9.9' : '8.8.8'
writeFileSync('src/version.mjs', `export const VERSION = '${next}'\n`)
