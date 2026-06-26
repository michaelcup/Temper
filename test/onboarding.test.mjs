// Onboarding UX: the run-time preflight that kills the #1 fallow footgun before it costs an
// escalation, and `temper explain`. Each test drives the real CLI in a throwaway git repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'temper.mjs')
const APPEND = `sh -c 'echo "// touched $RANDOM" >> src/v.mjs'`

function temper(dir, args) {
  try {
    const out = execFileSync('node', [TEMPER, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

// A repo with a TRACKED test file (so projectHasTests() is true), optionally a fallow config and a
// stub engine. The tracked test file is what makes the fallow footgun apply.
function repo({ fallowConfig = false, stub = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'temper-onboarding-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, 'src', 'v.test.mjs'), 'import "./v.mjs"\n')
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n`)
  if (fallowConfig) writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["**/*.test.mjs"]}\n')
  if (stub) writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { stub: { engine: APPEND, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off' }, null, 2))
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  return dir
}

test('temper run preflights the #1 footgun: tests but no fallow config → scaffolds + stops', () => {
  const dir = repo() // tests present, no fallow config
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'should stop before the loop, not run into the footgun')
    assert.match(r.out, /onboarding footgun/, 'explains the footgun')
    assert.match(r.out, /scaffolded/, 'tells the user it scaffolded the config')
    assert.ok(existsSync(join(dir, '.fallowrc.json')), 'the fallow config now exists, ready to commit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run checks for a clean tree BEFORE the preflight scaffolds (no config written into a dirty tree)', () => {
  const dir = repo() // tests present, no fallow config → the preflight would otherwise scaffold + abort
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 1 // uncommitted edit\n') // dirty the tree
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'a dirty tree must stop the run')
    assert.doesNotMatch(r.out, /onboarding footgun/, 'the clean-repo guard fires before the preflight')
    assert.ok(!existsSync(join(dir, '.fallowrc.json')), 'nothing scaffolded into a dirty tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run does NOT preflight-fail once a fallow config exists (it runs to a green gate)', () => {
  const dir = repo({ fallowConfig: true, stub: true })
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // preflight is a no-op; the stub run commits
    assert.doesNotMatch(r.out, /onboarding footgun/, 'no footgun stop when a fallow config is present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper explain <gate> gives what/why/fix; bare or unknown lists the gates', () => {
  const dir = repo({ fallowConfig: true })
  try {
    const one = temper(dir, ['explain', 'fallow-audit'])
    assert.equal(one.code, 0, one.out)
    assert.match(one.out, /Dead-code/, 'explains the fallow gate')
    assert.match(one.out, /How to clear/, 'gives the fix')

    assert.match(temper(dir, ['explain']).out, /Gates and verdicts/, 'bare explain lists the gates')
    assert.match(temper(dir, ['explain', 'nope']).out, /Gates and verdicts/, 'an unknown gate lists the gates')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper explain accepts the words the failure banners print (HALT → halted)', () => {
  const dir = repo({ fallowConfig: true })
  try {
    const r = temper(dir, ['explain', 'HALT'])
    assert.match(r.out, /halted/, 'HALT resolves to the halted verdict')
    assert.match(r.out, /Reuse-critic halt/, 'shows the explanation, not the usage dump')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper doctor checks the engine binary, not just git + fallow', () => {
  const dir = repo({ fallowConfig: true })
  try {
    assert.match(temper(dir, ['doctor']).out, /engine binary on PATH/, 'doctor now checks the engine binary resolves')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run fails fast when the acceptance command binary is not runnable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-acc-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "definitelynotacmd_zzz --run"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'a non-runnable acceptance command stops before the loop')
    assert.match(r.out, /isn't runnable|not on your PATH/, 'flags the non-runnable acceptance command')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run fails fast when the acceptance command has a shell syntax error (nested quotes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-accsyn-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  // an inline `node -e "…"` with NESTED escaped quotes — exactly what dogfood #3's drafter produced. parsePlan
  // strips the OUTER quotes but leaves the inner \" literal, so /bin/sh chokes at run time and the loop misreads
  // it as a failing test, burning iterations to an escalation. Catch it at validation instead.
  const acc = 'acceptance: "node -e \\"import {x} from \'./src/v.mjs\'; console.log(\'ok\')\\""'
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\n${acc}\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'a malformed acceptance command stops before the loop')
    assert.match(r.out, /shell syntax error/, 'flags the broken acceptance at validation, not after escalating')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run fails fast when the engine binary is not on PATH (preflight, not a stuck escalation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-eng-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { bad: { engine: 'definitely_not_a_binary_zzz {promptFile}', critic: 'true' } }, engine: 'bad', fallowCommand: 'true', criticMode: 'off' }))
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "true"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'aborts before the loop')
    assert.match(r.out, /not on your PATH/, 'names the missing engine binary instead of burning iterations')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run surfaces a failed engine call instead of mislabeling it as no-changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-engfail-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { failing: { engine: "sh -c 'echo boom>&2; exit 1'", critic: 'true' } }, engine: 'failing', fallowCommand: 'true', criticMode: 'off', maxIterations: 3 }))
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "true"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'a failed engine call ends the run')
    assert.match(r.out, /engine command failed/, 'surfaces the engine failure as itself')
    assert.match(r.out, /boom/, "shows the engine's own output")
    assert.doesNotMatch(r.out, /STUCK/, 'does not burn iterations into a stuck no-changes escalation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run on a config-only dirty tree gives the exact commit one-liner (the init->run unblock)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-cfg-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  writeFileSync(join(dir, '.gitignore'), 'PLAN.md\n')
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "true"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ fallowCommand: 'true' })) // now the only dirt
  try {
    const r = temper(dir, ['run', 'PLAN.md'])
    assert.notEqual(r.code, 0, 'still aborts (clean base required)')
    assert.match(r.out, /Commit Temper's scaffolded config/, 'recognizes the config-only dirty case')
    assert.match(r.out, /git add .*temper\.config\.json/, 'gives the exact commit command, not a blanket abort')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejecting git hook does not produce a false-green commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-hook-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{ "entry": ["src/**"] }\n')
  writeFileSync(join(dir, '.gitignore'), '.temper/\nPLAN.md\n')
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { stub: { engine: APPEND, critic: 'true' } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off' }))
  writeFileSync(join(dir, 'PLAN.md'), '---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n')
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n') // hook rejects every commit
  chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755)
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub', '--max-iterations', '1'])
    assert.notEqual(r.code, 0, 'a rejected commit must not exit committed')
    assert.match(r.out, /commit FAILED/, 'reports the failed commit honestly')
    const after = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(after, before, 'HEAD must not have advanced (no phantom commit)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live lock blocks a second concurrent run; a stale (dead-pid) lock is taken over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-lock-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{ "entry": ["src/**"] }\n')
  writeFileSync(join(dir, '.gitignore'), '.temper/\nPLAN.md\n')
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ engines: { stub: { engine: APPEND, critic: 'true' } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off' }))
  writeFileSync(join(dir, 'PLAN.md'), '---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n')
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    // a LIVE lock (this test's own pid) must block a run — the lock lives in the git dir, never the tree
    writeFileSync(join(dir, '.git', 'temper-lock'), String(process.pid))
    const r1 = temper(dir, ['run', 'PLAN.md', '--engine', 'stub', '--max-iterations', '1'])
    assert.notEqual(r1.code, 0, 'a run must refuse while another holds the lock')
    assert.match(r1.out, /Another temper run is active/)
    // a STALE lock (a dead pid) must be taken over so the run proceeds
    writeFileSync(join(dir, '.git', 'temper-lock'), '999999') // above macOS/Linux max pid → guaranteed dead
    const r2 = temper(dir, ['run', 'PLAN.md', '--engine', 'stub', '--max-iterations', '1'])
    assert.equal(r2.code, 0, r2.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper init writes the full key set (not just a 4-key stub)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-init-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  try {
    temper(dir, ['init'])
    const cfg = JSON.parse(readFileSync(join(dir, 'temper.config.json'), 'utf8'))
    for (const k of ['criticEngine', 'checkCompleteness', 'maxQueueSeconds', 'maxQueueIterations', 'notifyCommand']) {
      assert.ok(k in cfg, `init config should expose the ${k} knob`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper init --agents wires the Skill + a sentinel-delimited AGENTS.md block, idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-agents-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  try {
    const r = temper(dir, ['init', '--agents'])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'temper', 'SKILL.md')), 'copies the Claude Code Skill into the project')
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.match(agents, /temper:integrate-start/, 'writes the sentinel-delimited block')
    assert.match(agents, /temper overnight/, 'the block routes batch work to overnight')
    // Idempotent: a second run must refresh in place, not append a duplicate block.
    temper(dir, ['init', '--agents'])
    const agents2 = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.equal((agents2.match(/temper:integrate-start/g) || []).length, 1, 'block not duplicated on re-run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper init --no-agents leaves the agent surface untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-noagents-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  try {
    temper(dir, ['init', '--no-agents'])
    assert.ok(!existsSync(join(dir, '.claude')), 'no skill written')
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'no AGENTS.md written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper doctor warns about the no-entry-point bootstrap risk, and goes quiet once an entry exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-bootstrap-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  // fallowCommand 'true' resolves on PATH (so the entropy gate is "available"); no tests, no package entry.
  writeFileSync(join(dir, 'temper.config.json'), JSON.stringify({ fallowCommand: 'true', engines: { stub: { engine: 'true', critic: 'true' } }, engine: 'stub' }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' })) // no exports/main/bin
  try {
    const r1 = temper(dir, ['doctor'])
    assert.match(r1.out, /No fallow entry points yet/, 'warns when fallow has no root to measure reachability')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module', main: 'index.mjs' })) // add an entry
    const r2 = temper(dir, ['doctor'])
    assert.doesNotMatch(r2.out, /No fallow entry points yet/, 'silent once an entry point exists')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run does NOT false-fail a subshell acceptance command (it runs to a green gate)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-subshell-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  writeFileSync(
    join(dir, 'temper.config.json'),
    JSON.stringify({ engines: { stub: { engine: APPEND, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off' }, null, 2),
  )
  // A parenthesized subshell — the binary-parse would have extracted "(node" and wrongly rejected it.
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "(node --check src/v.mjs)"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.doesNotMatch(r.out, /isn't runnable/, 'a subshell acceptance must not be rejected as non-runnable')
    assert.equal(r.code, 0, r.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run skips the fallow gate gracefully when fallow is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-nofallow-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  // fallowCommand points at a binary that does not exist → the gate is SKIPPED, not failed.
  writeFileSync(
    join(dir, 'temper.config.json'),
    JSON.stringify({ engines: { stub: { engine: APPEND, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'definitelynotfallow_zzz', criticMode: 'off' }, null, 2),
  )
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // commits via the other gates; the entropy gate is skipped, not failed
    assert.match(r.out, /entropy gate not runnable/, 'notes that the entropy gate is missing')
    assert.match(r.out, /skipping the dead-code/, 'and that the entropy gate is skipped')
    assert.doesNotMatch(r.out, /entropy gate failed/, 'a missing entropy gate must NOT count as a violation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('temper run uses a custom entropyGate command when set (any language/tool)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temper-entropygate-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  writeFileSync(join(dir, '.fallowrc.json'), '{"entry":["src/**"]}\n')
  // entropyGate overrides the default fallow command — here a stand-in that prints + passes.
  writeFileSync(
    join(dir, 'temper.config.json'),
    JSON.stringify({ engines: { stub: { engine: APPEND, critic: "echo '{}'" } }, engine: 'stub', fallowCommand: 'true', criticMode: 'off', entropyGate: "sh -c 'echo CUSTOM-ENTROPY-GATE'" }, null, 2),
  )
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.equal(r.code, 0, r.out) // the custom gate passes (exit 0) → commits
    assert.match(r.out, /CUSTOM-ENTROPY-GATE/, 'the configured entropyGate command is the one that runs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the bundled doc-sprawl recipe (examples/doc-gate.mjs) rejects a new markdown file via entropyGate', () => {
  const DOCGATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'doc-gate.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'temper-docgate-'))
  const g = (a) => execFileSync('git', a, { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'v.mjs'), 'export const V = 0\n')
  // stub "engine" that spawns a NEW doc — exactly the sprawl the recipe should catch.
  const MAKE_DOC = `sh -c 'mkdir -p docs && echo "# extra" > docs/extra.md'`
  writeFileSync(
    join(dir, 'temper.config.json'),
    JSON.stringify({ engines: { stub: { engine: MAKE_DOC, critic: "echo '{}'" } }, engine: 'stub', criticMode: 'off', maxUnchangedRetries: 1, entropyGate: `node ${DOCGATE} {base}` }, null, 2),
  )
  writeFileSync(join(dir, 'PLAN.md'), `---\nscope:\n  - "docs/**"\n  - "src/**"\nacceptance: "node --check src/v.mjs"\n---\n# t\nx\n`)
  g(['init', '-q'])
  g(['config', 'user.email', 'a@b.c'])
  g(['config', 'user.name', 'a'])
  g(['add', '-A'])
  g(['commit', '-qm', 'seed'])
  try {
    const r = temper(dir, ['run', 'PLAN.md', '--engine', 'stub'])
    assert.notEqual(r.code, 0, 'a net-new doc must not be committed — the recipe rejects it') // escalates, not commits
    assert.match(r.out, /doc sprawl/, 'the bundled doc-gate fires on the new markdown file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
