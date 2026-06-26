// The deterministic gate primitives: scope allowlist, within-file protected regions, the
// suppression guard, and the git-diff helpers the gates and critic read from.
import { readFileSync } from 'node:fs'
import { run, runArgs } from './sh.mjs'

// Gate-gaming guard: directives an agent adds to SILENCE a check instead of fixing it. Newly-added
// occurrences are treated as violations ("suppression is not resolution"). Language-agnostic by
// design — the mechanism is a diff-grep, so coverage is just this table. Add a row to cover a language.
export const SUPPRESSION_PATTERNS = [
  // JavaScript / TypeScript
  { name: 'fallow-ignore', re: /fallow-ignore/ },
  { name: 'eslint-disable', re: /eslint-disable/ },
  { name: 'biome-ignore', re: /biome-ignore/ },
  { name: '@ts-ignore', re: /@ts-ignore/ },
  { name: '@ts-expect-error', re: /@ts-expect-error/ },
  { name: 'istanbul ignore', re: /istanbul\s+ignore/ },
  { name: 'c8 ignore', re: /c8\s+ignore/ },
  { name: 'skipped/focused JS test', re: /\b(?:it|test|describe)\.(?:skip|only)\b|\bx(?:it|describe|test)\b/ },
  // Python
  { name: 'type: ignore', re: /#\s*type:\s*ignore/ },
  { name: 'noqa', re: /#\s*noqa/ },
  { name: 'pylint disable', re: /#\s*pylint:\s*disable/ },
  { name: 'pragma: no cover', re: /#\s*pragma:\s*no cover/ },
  { name: 'pytest/unittest skip', re: /@(?:pytest\.mark\.skip|unittest\.skip)|\bpytest\.skip\(/ },
  // Rust
  { name: 'rust #[allow]', re: /#\[\s*allow\s*\(/ },
  { name: 'rust #[ignore]', re: /#\[\s*ignore\b/ },
  // Go
  { name: 'go nolint', re: /\/\/\s*nolint/ },
  { name: 'go t.Skip', re: /\bt\.Skip(?:Now)?\(/ },
  // Ruby
  { name: 'rubocop disable', re: /#\s*rubocop:disable/ },
]

// --- scope allowlist (glob → regexp) ---
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]\\/'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}
export const inScope = (file, scope) => scope.some((g) => globToRegExp(g).test(file))

// R4: within-file protection. Regions are marked in the source with paired sentinel
// comments `temper:protect-start [label]` … `temper:protect-end`, located in the BASE
// (committed) version so line numbers map to a stable reference. A change is rejected
// if any diff hunk's old-side range overlaps a protected region.
function protectedRegions(baseSha, file) {
  const base = runArgs('git', ['show', `${baseSha}:${file}`]) // argv array, NO shell: filename can't inject
  if (base.code !== 0) return [] // file is new this run — nothing committed to protect
  const regions = []
  const open = []
  // Sentinels must be effectively alone on a comment line (a leading comment marker,
  // only an optional label + comment-close after) so prose/string mentions don't parse.
  base.out.split('\n').forEach((l, idx) => {
    const s = l.match(/^\s*(?:\/\/|#|\/\*\*?|\*|--|<!--)\s*temper:protect-start(?:\s+([\w.-]+))?\s*(?:\*\/|-->)?\s*$/)
    const isEnd = /^\s*(?:\/\/|#|\/\*\*?|\*|--|<!--)\s*temper:protect-end\s*(?:\*\/|-->)?\s*$/.test(l)
    if (s) open.push({ label: (s[1] || 'region').trim(), start: idx + 1 })
    else if (isEnd) {
      const o = open.pop()
      regions.push(o ? { ...o, end: idx + 1 } : { malformed: true, line: idx + 1 })
    }
  })
  for (const o of open) regions.push({ malformed: true, label: o.label, line: o.start })
  return regions
}

function hunkHitsRegion(oldStart, oldLen, r) {
  if (oldLen === 0) return oldStart >= r.start && oldStart < r.end // insertion inside the fences
  return oldStart <= r.end && oldStart + oldLen - 1 >= r.start // inclusive overlap (locks the sentinels too)
}

export function protectionViolations(baseSha, plan, changed) {
  const out = []
  for (const file of changed) {
    if (!inScope(file, plan.scope)) continue
    const regions = protectedRegions(baseSha, file)
    if (!regions.length) continue
    const bad = regions.find((r) => r.malformed)
    if (bad) {
      out.push(`Unbalanced temper:protect sentinels in ${file} (near line ${bad.line}). Fix the guard.`)
      continue
    }
    const diff = runArgs('git', ['diff', '--unified=0', baseSha, '--', file]).out // argv, NO shell
    for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
      const oldStart = +m[1]
      const oldLen = m[2] === undefined ? 1 : +m[2]
      const hit = regions.find((r) => !r.malformed && hunkHitsRegion(oldStart, oldLen, r))
      if (hit) out.push(`Changed protected region "${hit.label}" in ${file} (locked by temper:protect). Revert those lines; make your change outside the region.`)
    }
  }
  return [...new Set(out)]
}

// --- git-diff helpers ---
export function changedFiles(baseSha) {
  const tracked = run(`git diff --name-only ${baseSha}`).out.split('\n').filter(Boolean)
  const untracked = run('git ls-files --others --exclude-standard').out.split('\n').filter(Boolean)
  return [...new Set([...tracked, ...untracked])]
}

// fallow's dead-code gate flags a NEW file as unused / "not reachable from any entry point" — the
// classic dynamic-load FALSE-POSITIVE: a fixture, plugin, or dynamic-import / require-by-string target
// that IS used, just not via a static import fallow can follow. Returns the newly-added (untracked)
// files named in such a finding, so the loop can hand the engine an actionable fix and escalate fast
// instead of letting it flail against a gate it cannot satisfy in scope. Empty for any other failure
// (e.g. complexity), so it never mislabels a real finding.
export function fallowUnreachableNewFiles(auditOutput) {
  if (!/not reachable from any entry point|unused files?/i.test(auditOutput)) return []
  const added = run('git ls-files --others --exclude-standard').out.split('\n').filter(Boolean)
  // Match each repo-relative path as a whole token bounded by line-start/whitespace (fallow indents
  // its file list with spaces) so neither `a.mjs`↔`data.mjs` nor `plugin.mjs`↔`src/plugin.mjs` collide.
  return added.filter((f) => new RegExp(`(^|\\s)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(auditOutput))
}

// Scans added lines (modified files) + whole new files for suppression directives.
export function addedSuppressions(baseSha) {
  const added = run(`git diff ${baseSha}`)
    .out.split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
  for (const f of run('git ls-files --others --exclude-standard').out.split('\n').filter(Boolean)) {
    try {
      added.push(...readFileSync(f, 'utf8').split('\n'))
    } catch {}
  }
  const hits = new Set()
  for (const text of added) {
    const m = SUPPRESSION_PATTERNS.find((p) => p.re.test(text))
    if (m) hits.add(`${m.name} (\`${text.trim().slice(0, 70)}\`)`)
  }
  return [...hits]
}

// Full change picture for the critic: tracked diff + the contents of new untracked files
// (plain `git diff` omits untracked files, which left the critic blind to brand-new modules).
export function fullDiff(baseSha) {
  let diff = run(`git diff ${baseSha}`).out
  for (const f of run('git ls-files --others --exclude-standard').out.split('\n').filter(Boolean)) {
    try {
      diff += `\n--- NEW FILE: ${f} ---\n${readFileSync(f, 'utf8')}`
    } catch {}
  }
  return diff
}
