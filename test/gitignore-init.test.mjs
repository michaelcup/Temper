// `temper init` auto-gitignore tests. Drives the real CLI in a throwaway temp dir (init needs no git
// repo) and inspects the resulting .gitignore: created when absent, appended when missing the entry,
// and left byte-identical when a `.temper/` (or bare `.temper`) line already exists.
// Run: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')

function runInit(dir) {
  const r = spawnSync('node', [TEMPER, 'init', '-q'], { cwd: dir, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` }
}

const countTemper = (s) => (s.match(/\.temper/g) || []).length

test('init creates .gitignore with .temper/ when none exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-gi-'))
  try {
    runInit(dir)
    const path = join(dir, '.gitignore')
    assert.ok(existsSync(path), '.gitignore should be created')
    assert.match(readFileSync(path, 'utf8'), /^\.temper\/$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init appends .temper/ to an existing .gitignore that lacks it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-gi-'))
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    runInit(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.match(content, /^node_modules$/m, 'original line preserved')
    assert.match(content, /^\.temper\/$/m, '.temper/ line added')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init does not duplicate existing entries (idempotent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-gi-'))
  try {
    const original = 'node_modules\n.temper/\nPLAN.md\n'
    writeFileSync(join(dir, '.gitignore'), original)
    runInit(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.equal(content, original, 'content unchanged when both entries already present')
    assert.equal(countTemper(content), 1, 'no duplicate .temper line')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init gitignores PLAN.md (the drafted-plan working artifact)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-gi-'))
  try {
    runInit(dir)
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^PLAN\.md$/m, 'PLAN.md should be ignored so plan→run does not dirty the tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init prints a hint to commit the scaffolded config files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-gi-'))
  try {
    const { out } = runInit(dir)
    assert.match(out, /commit/i, 'output should tell the user to commit')
    assert.match(out, /\.fallowrc\.json/, 'names .fallowrc.json')
    assert.match(out, /temper\.config\.json/, 'names temper.config.json')
    assert.match(out, /clean repo/i, 'explains the next run needs a clean repo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init treats a bare .temper line as already-ignored (no second entry)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-gi-'))
  try {
    writeFileSync(join(dir, '.gitignore'), '.temper\n')
    runInit(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.equal(countTemper(content), 1, 'bare .temper should not get a second entry')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
