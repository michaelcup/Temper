import { writeFileSync } from 'node:fs'
// In-scope edit to helper. The base file's unbalanced sentinel (a `temper:protect-start` with no
// matching `temper:protect-end`) makes protectionViolations fail closed every iteration.
writeFileSync('src/core.mjs', `// temper:protect-start gate
export function gate() {
  return true
}
export function helper() {
  return 2
}
`)
