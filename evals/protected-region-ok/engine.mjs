import { writeFileSync } from 'node:fs'
// Edits helper() — OUTSIDE the protected region — which must be ALLOWED.
writeFileSync('src/core.mjs', `// temper:protect-start gate
export function gate() {
  return true
}
// temper:protect-end
export function helper() {
  return 2
}
`)
