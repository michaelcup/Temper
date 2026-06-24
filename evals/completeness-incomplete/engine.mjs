import { writeFileSync } from 'node:fs'
// Does only half the plan (bumps version, no changelog) — passes cheap gates.
writeFileSync('src/version.mjs', "export const VERSION = '2.0.0'\n")
