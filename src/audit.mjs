import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { log, fail, runArgs, resolvesOnPath } from './sh.mjs'

// A cleanup queue you can actually review in one sitting. Findings past this are reported, never silently dropped.
const MAX_GROUPS = 25

// The repo's test command becomes each cleanup Plan's acceptance, so a removal that breaks something fails the
// gate and never commits. Prefer the package's own `test` script; null means "none found, ask the human to set one."
const repoTestCommand = (root) => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (pkg.scripts && pkg.scripts.test) return 'npm test'
  } catch {}
  return null
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

// Locations fallow conventionally reports as "unused" because a project's entry config rarely lists them:
// one-off CLI / maintenance scripts, example apps, public/browser assets, service workers, and re-export
// barrels (a public API surface). These are usually an ENTRY-CONFIG gap, not dead code, so the audit lists
// them for review instead of proposing deletion. The real fix is adding them to the fallow `entry` list.
const LIKELY_FP = [
  /(^|\/)scripts\//,
  /(^|\/)examples\//,
  /(^|\/)public\//,
  /(^|\/)(sw|service-worker)\.[mc]?[jt]sx?$/,
  /\.worker\.[mc]?[jt]sx?$/,
  /(^|\/)index\.[mc]?[jt]sx?$/,
]
const isLikelyFalsePositive = (path) => LIKELY_FP.some((re) => re.test(path))

// One reviewable Plan per file. Each carries the conservative VERIFY nudge for fallow's known false positive
// (public API or config-loaded code flagged "unused"): the human prunes those before the loop ever runs.
function planFor(g, acc) {
  const acceptance = acc ? `acceptance: "${acc}"\n` : ''
  const head = `---\nscope:\n  - "${g.path}"\n${acceptance}---\n`
  const noTest = acc ? '' : '\nNo test command was detected; set `acceptance` to your test or build command so a breaking change is caught.\n'
  if (g.file) {
    return (
      head +
      `# Delete unused file ${g.path}\n` +
      `fallow reports \`${g.path}\` as unreachable from any entry point. Delete it.\n\n` +
      'Before deleting, VERIFY it is not loaded dynamically (require / import() by string), referenced by config ' +
      'or scripts, or an intentional standalone entry such as a recipe, a CLI, or a generated artifact. If it is ' +
      'any of those, do not delete it; add it to the fallow entry config instead and skip this task.\n' +
      noTest
    )
  }
  const list = g.exports.map((e) => `\`${e.name}\` (line ${e.line})`).join(', ')
  return (
    head +
    `# Remove unused exports from ${g.path}\n` +
    `fallow reports these exports in \`${g.path}\` as unreachable from any entry point: ${list}. The EXPORT is unused, but the symbol may still be used inside this file. For each, remove it from the public API by dropping the \`export\` keyword; then, only if the declaration is no longer referenced anywhere in the file, delete it entirely. Do NOT delete a declaration still used inside the file (that would break it).\n\n` +
    "Before removing, VERIFY none is part of this package's public API (consumed outside this repo) or referenced " +
    'dynamically by string. For any that is public API, do not remove it; add this file to the fallow entry config instead.\n' +
    noTest
  )
}

// Turn fallow's full dead-code report into reviewable, scoped cleanup Plans. A THIN bridge: fallow finds the
// entropy, the human approves the list, the gated loop removes it safely. v1 covers dead code (unused exports
// and unused files), the clearest and most verifiable cleanup. It PROPOSES and never runs the cleanup itself.
export function runAudit(cfg, dir) {
  const root = dir && dir !== '.' ? dir : process.cwd()
  if (!cfg.fallowCommand) {
    fail('`temper audit` needs fallow for JS/TS dead-code analysis. Install it (`npm i -g fallow`), then `temper init` (or `fallow init`) to add an entry-aware config.')
  }
  // Full project (not changed-only), JSON for parsing. argv path: no shell, so fallow + flags + paths stay inert.
  const parts = cfg.fallowCommand.trim().split(/\s+/)
  const bin = parts[0]
  if (!existsSync(bin) && !resolvesOnPath(bin)) fail(`fallow not found (\`${bin}\`). Install it (\`npm i -g fallow\`), then \`temper init\`.`)
  const r = runArgs(bin, [...parts.slice(1), 'dead-code', '--format', 'json', '--quiet', '--root', root])
  // fallow exits 1 when it finds dead code, so parse stdout (not the stdout+stderr blob) regardless of exit code.
  let report
  try {
    report = JSON.parse(r.stdout)
  } catch {
    fail(`Could not parse fallow's output. Is fallow set up in this repo (a \`.fallowrc.json\`)? Run \`temper init\`.\n${(r.stderr || r.stdout || '').slice(0, 400)}`)
  }

  const rawExports = (report.unused_exports || []).filter((e) => !e.is_type_only) // value exports; type-only is lower-stakes, deferred
  const rawFiles = report.unused_files || []
  const byFile = new Map()
  const group = (path) => {
    if (!byFile.has(path)) byFile.set(path, { path, exports: [], file: false })
    return byFile.get(path)
  }
  for (const e of rawExports) group(e.path).exports.push({ name: e.export_name, line: e.line })
  for (const f of rawFiles) group(f.path).file = true // a dead file subsumes its exports: one delete covers them

  const groups = [...byFile.values()]
  if (!groups.length) {
    log('✓ No dead code found. Nothing to clean.')
    return
  }
  // Two buckets. High-confidence findings (regular source) become cleanup Plans; conventional false-positive
  // locations are listed for review and never proposed as deletions, since they are usually an entry-config gap.
  const real = groups.filter((g) => !isLikelyFalsePositive(g.path))
  const suspect = groups.filter((g) => isLikelyFalsePositive(g.path))
  const kept = real.slice(0, MAX_GROUPS)
  const dropped = real.length - kept.length
  const acc = repoTestCommand(root)

  if (kept.length) {
    const outDir = join(root, '.temper', 'audit')
    mkdirSync(outDir, { recursive: true })
    for (const n of readdirSync(outDir)) if (/^\d\d-.*\.md$/.test(n)) rmSync(join(outDir, n)) // clear a prior audit; leave anything else
    kept.forEach((g, i) => {
      const name = `${String(i + 1).padStart(2, '0')}-${slug(g.file ? `delete-${basename(g.path)}` : `clean-${basename(g.path)}`)}.md`
      writeFileSync(join(outDir, name), planFor(g, acc))
    })
  }

  log(`\n■ Audit found ${rawExports.length} unused export(s) and ${rawFiles.length} unused file(s) across ${groups.length} file(s).`)
  if (kept.length) {
    log(`  High-confidence cleanups: wrote ${kept.length} Plan(s) to .temper/audit/${dropped ? ` (of ${real.length}; ${dropped} over the cap, re-run for the rest)` : ''}. Each carries a VERIFY nudge; review each before running.`)
  } else {
    log('  No high-confidence cleanups: every finding is in a likely-false-positive location (below).')
  }
  if (suspect.length) {
    log(`  Likely false positives: ${suspect.length} finding(s) in scripts / examples / public / workers / barrels, usually a fallow entry-config gap. Add them to your \`.fallowrc\` entry list rather than deleting:`)
    for (const g of suspect.slice(0, 12)) log(`    - ${g.path}`)
    if (suspect.length > 12) log(`    …and ${suspect.length - 12} more`)
  }
  if (!acc) log('  No test command was detected, so each Plan asks you to set an acceptance command: a removal with no test to catch it is risky.')
  // Dead code is the verifiable cleanup (delete, gate confirms, entropy drops). Duplication and complexity are
  // judgment-heavy refactors that fit the gated loop poorly, so the audit points at fallow rather than auto-proposing them.
  log('  For duplication and complexity, run `fallow dupes` and `fallow health` directly; those are judgment refactors, not the verifiable deletions this audit targets.')
  if (kept.length) log('  Then: temper overnight .temper/audit')
}
