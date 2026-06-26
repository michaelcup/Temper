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
