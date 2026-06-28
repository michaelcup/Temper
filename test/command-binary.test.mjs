// commandBinary extracts the leading executable of a shell command for best-effort prerequisite
// checks (doctor's engine check, the acceptance-command preflight). A `|` inside a quoted grep/sed
// pattern is a regex alternation — an argument, not a shell pipe — and must not be mis-read as one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandBinary } from '../src/sh.mjs'

test('commandBinary takes the leading binary, skipping env assignments', () => {
  assert.equal(commandBinary('npm test'), 'npm')
  assert.equal(commandBinary('node --check src/v.mjs'), 'node')
  assert.equal(commandBinary('VAR=1 OTHER=2 pytest -q'), 'pytest')
})

test('commandBinary follows a real shell pipe to the rightmost stage', () => {
  assert.equal(commandBinary('cat {promptFile} | claude -p'), 'claude')
  assert.equal(commandBinary('echo hi | tee log | wc -l'), 'wc')
})

test('commandBinary does not treat a | inside quotes as a shell pipe', () => {
  // Regression: an acceptance like `... && ! grep -Eq "a|anpa -- maintenance" src` was mis-split on the
  // pattern's `|`, extracting `anpa` as the binary and false-failing the preflight ("anpa not on PATH").
  assert.equal(commandBinary('npm run typecheck && ! grep -Eq "alpha|anpa -- maintenance" src scripts'), 'npm')
  assert.equal(commandBinary("grep -E 'foo|bar' file"), 'grep')
  // A real pipe after a quoted | still wins; the quoted | is ignored.
  assert.equal(commandBinary('cat "a|b.txt" | claude -p'), 'claude')
})
