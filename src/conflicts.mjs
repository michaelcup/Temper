// Deterministic scope-conflict detection for the overnight queue. Two phase Plans "conflict" when their
// `scope:` allowlists can claim a common file. This is a conservative TRIGGER, never a verdict: same-file
// overlap does not prove a real conflict (a shared hub file is usually benign), so it only surfaces pairs
// for a human to review — or, inside a run, gates the single reconcile call. Pure functions over the
// parsed plans; no engine, no I/O. Biased to FALSE-YES (a spurious flag beats a missed silent clobber).
import { globToRegExp } from './gates.mjs'

const hasWildcard = (g) => /[*?]/.test(g)
const literalPrefix = (g) => {
  const i = g.search(/[*?]/)
  return i === -1 ? g : g.slice(0, i)
}

// Could globs `a` and `b` ever match a common path? A literal path overlaps a glob iff it matches it; two
// wildcard globs overlap iff one's literal prefix is a string-prefix of the other's (conservative — this
// over-reports across sibling dirs like `src/a*` vs `src/ab/*`, which is the intended safe bias).
export function globsOverlap(a, b) {
  if (a === b) return true
  if (!hasWildcard(a)) return globToRegExp(b).test(a)
  if (!hasWildcard(b)) return globToRegExp(a).test(b)
  const pa = literalPrefix(a)
  const pb = literalPrefix(b)
  return pa.startsWith(pb) || pb.startsWith(pa)
}

// A recursive directory glob (`**`, `*`, or `<dir>/**`) denotes a SHARED WORKSPACE, not a specific file.
const RECURSIVE = /^(\*\*?|[^/*?]+\/\*\*)$/
// Repo-wide globs (`*`, `**`) claim the whole tree — too broad to conflict-check precisely.
const REPO_WIDE = /^\*\*?$/

// The overlapping (a-glob, b-glob) pairs between two scope allowlists; empty ⇒ disjoint. A pair where BOTH
// globs are recursive dir globs is EXCLUDED: two plans both declaring `test/**` are sharing a workspace
// (they'll write different files), not contending — counting that would false-conflict almost every pair.
// A real conflict needs at least one SPECIFIC claim (a literal path, or a glob narrow enough to denote one).
export function scopesOverlap(scopeA, scopeB) {
  const pairs = []
  for (const a of scopeA) for (const b of scopeB) {
    if (globsOverlap(a, b) && !(RECURSIVE.test(a) && RECURSIVE.test(b))) pairs.push([a, b])
  }
  return pairs
}

// A scope so broad it claims the whole repo (`*`, `**`) — flag it so the author narrows it. Per-directory
// recursive globs (`test/**`, `docs/**`) are fine and common, so they are NOT linted; the shared-workspace
// rule above already keeps them from false-conflicting.
export const broadScopes = (scope) => scope.filter((g) => REPO_WIDE.test(g))

// Pairwise scope conflicts across an ordered list of phases [{ file, plan: { scope } }]. Returns the pairs
// whose scopes can claim a common file (the conservative trigger set) + any broad-scope lints.
export function detectScopeConflicts(phases) {
  const conflicts = []
  for (let i = 0; i < phases.length; i++) {
    for (let j = i + 1; j < phases.length; j++) {
      const globs = scopesOverlap(phases[i].plan.scope, phases[j].plan.scope)
      if (globs.length) conflicts.push({ a: phases[i].file, b: phases[j].file, globs })
    }
  }
  const broad = phases.map((p) => ({ file: p.file, globs: broadScopes(p.plan.scope) })).filter((x) => x.globs.length)
  return { conflicts, broad }
}
