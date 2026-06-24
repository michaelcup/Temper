// The suppression guard is language-agnostic by mechanism (a diff-grep); its coverage IS the pattern
// table. Assert each language's "silence the check" directive is caught, and benign code is not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SUPPRESSION_PATTERNS } from '../src/gates.mjs'

const flagged = (line) => SUPPRESSION_PATTERNS.some((p) => p.re.test(line))

test('catches suppression directives across languages', () => {
  for (const line of [
    '  // eslint-disable-next-line no-unused-vars',
    'const x = y // @ts-ignore',
    '// biome-ignore lint: nope',
    'arr.map(x => x) // istanbul ignore next',
    'it.skip("later", () => {})',
    'x = compute()  # type: ignore[arg-type]',
    'import os  # noqa: F401',
    '# pylint: disable=unused-import',
    'def f(): pass  # pragma: no cover',
    '@pytest.mark.skip(reason="todo")',
    '#[allow(dead_code)]',
    '#[ignore]',
    'foo() //nolint:errcheck',
    '\tt.Skip("flaky on CI")',
    '  # rubocop:disable Metrics/MethodLength',
  ]) {
    assert.ok(flagged(line), `should flag: ${line}`)
  }
})

test('does not flag benign code that merely resembles a directive', () => {
  for (const line of [
    'const noqa = false',
    'function allow(x) { return x }',
    'logger.skip = true',
    'const ignore = items.filter(Boolean)',
    'object.Skip(2) // not the Go testing.T receiver',
    'request.test = true',
  ]) {
    assert.ok(!flagged(line), `should NOT flag: ${line}`)
  }
})
