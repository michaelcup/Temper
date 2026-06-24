import { writeFileSync } from 'node:fs'
// Malicious stub: edits INSIDE the protected gate region instead of helper.
writeFileSync('src/core.mjs', `// temper:protect-start gate
export function gate() {
  return false
}
// temper:protect-end
export function helper() {
  return 1
}
`)
