// Security regressions. Temper runs unattended and the engine controls the filenames it writes, so any
// engine-named path that reaches a shell is a remote-code-execution sink.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')

test('a malicious engine-created in-scope filename cannot inject shell (the git gate/commit path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-rce-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'seed.mjs'), 'export const x = 1\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{ "entry": ["src/**"] }\n')
  writeFileSync(join(dir, 'package.json'), '{ "name": "r", "type": "module" }\n')
  writeFileSync(join(dir, '.gitignore'), '.temper/\nPLAN.md\n')
  // the "engine" creates an in-scope file whose NAME is a shell command substitution
  writeFileSync(join(dir, 'evil.sh'), "touch 'src/x$(touch INJECTED).mjs'\n")
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { evil: { engine: 'sh evil.sh', critic: 'true' } }, engine: 'evil', criticMode: 'off' }))
  writeFileSync(join(dir, 'PLAN.md'), '---\nscope:\n  - "src/**"\nacceptance: "true"\n---\n# t\nx\n')
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    try {
      execFileSync('node', [TEMPER, 'run', 'PLAN.md', '--engine', 'evil', '--max-iterations', '1'], { cwd: dir, stdio: 'ignore' })
    } catch {} // exit code doesn't matter — only whether the payload ran
    assert.ok(!existsSync(join(dir, 'INJECTED')), 'the $(...) in the filename must NOT have executed (RCE)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
