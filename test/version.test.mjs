import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const bin = new URL('../bin/temper.mjs', import.meta.url).pathname
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const run = (args) => execFileSync('node', [bin, ...args], { encoding: 'utf8' }).trim()

test('temper --version and -v print exactly the package version', () => {
  assert.equal(run(['--version']), version)
  assert.equal(run(['-v']), version)
})

const runCode = (args) => {
  try {
    return { code: 0, out: execFileSync('node', [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('temper --help, -h and help print usage and exit 0', () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const r = runCode(args)
    assert.equal(r.code, 0, `${args[0]} exits 0`)
    assert.match(r.out, /entropy-gated loop runner/, `${args[0]} prints usage`)
  }
})

test('temper run --help prints usage instead of starting a run', () => {
  const r = runCode(['run', '--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /entropy-gated loop runner/)
  assert.doesNotMatch(r.out, /engine:/, 'must not reach the run preflight')
})

test('an unknown command prints usage and exits 1; bare temper exits 0', () => {
  const bad = runCode(['urn'])
  assert.equal(bad.code, 1, 'a typo must not read as success in a script')
  assert.match(bad.out, /entropy-gated loop runner/)
  const bare = runCode([])
  assert.equal(bare.code, 0)
  assert.match(bare.out, /entropy-gated loop runner/)
})
