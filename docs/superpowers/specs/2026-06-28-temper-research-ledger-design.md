# Surface A: Research ledger + trust-list for Temper's direction check

Status: design approved 2026-06-28. This is the first of two sub-projects. Surface B (a personal
research skill for any topic) is a separate later spec that reuses the format defined here.

## 1. Summary

Temper already runs an opt-in, overnight-only direction check that grounds each phase's approach
against a user-supplied source list and emits an inline log line plus a `direction` object in the run
ledger (verified: `src/engine.mjs:176-193`, `src/phases.mjs:312-336`, `src/config.mjs:70`). Surface A
turns that one-shot grounding into a living research ledger: one markdown file per repo, appended across
runs, recording each finding with a situational support level and the sources behind it, alongside a
durable trust-list the user curates. The work is a thin extension of code that already exists, with zero
new runtime dependencies and the existing fail-open guarantees intact. This spec pins the shared ledger
and trust-list format first (because A is built first and the format is shared with B), then defines the
direction-check integration that maintains it.

The two confidences the design calls for are kept in separate canonical homes, not duplicated:

- **Source trust** is durable and lives only in the trust-list and the ledger's `## Sources` table.
- **Finding support** is situational, recomputed each run, and lives on each finding bullet.

A finding cites its sources by name; the reader resolves each source's trust from the table. Nothing
copies a durable trust value onto a situational row, so re-scoring a source never leaves stale copies.

## 2. The research ledger format (shared contract)

This grammar is the shared ledger format. Surface B reuses it verbatim. Any change to it is a
format-version decision, not a change owned by A's code.

One markdown file per repo. The path is derived, not configured: `join(dirname(cfg.progressFile),
'research.md')`, the same derivation the report already uses (`join(dirname(cfg.progressFile),
'report.md')`, verified `src/phases.mjs:137`). With the default `progressFile` that is
`.temper/research.md`, a sibling of `report.md` and `progress.json`. It is appended to across runs,
never respawned, and never split into dated one-off files.

The file has a fixed header and three sections in a fixed order. Temper appends machine-written content
only: finding bullets under `## Findings`, and candidate-source bullets under `## Sources`. The header,
the `## Sources` table, and `## Open questions` are human-maintained.

Exact structure with a filled example:

```markdown
# Research ledger: <repo name>

> One living document. Appended across direction-check runs, never respawned.
> Source trust is durable and lives in the table below (and in trust-list.md).
> Finding support is per-claim and recomputed each run.

## Sources

| Source | Trust | Why trusted |
| --- | --- | --- |
| blog.maximeheckel.com (Maxime Heckel) | high | original, reproducible experiments; primary, not aggregated |
| react.dev/reference (React team) | high | official documentation; primary |
| docs/adr/0007-no-context-for-theme.md | high | our own decision record; primary for this repo |
| medium.com/@growthhacks/react-tips | low | SEO-shaped listicle; cites nothing |

## Findings

- **ReactDOM.render is removed in React 19**. Support: high. Sources: [react.dev/reference], [docs/adr/0007]. The phase planned to add a ReactDOM.render call. That API is gone in React 19, so the plan must use createRoot instead.
- **Theme should not move to Context**. Support: medium. Sources: [docs/adr/0007]. The ADR rejects Context for theme state. Only one source supports this and there is no external corroboration yet.

## Open questions

- Does the migration guide cover Suspense boundaries for the data layer? Not yet sourced.
```

**Findings-bullet grammar** (the contract Temper writes and the tests assert):

```
- **<claim>**. Support: <high|medium|low>. Sources: [<source>], [<source>]. <one or more full declarative sentences of what was learned>.
```

- **Support** is the situational finding confidence, recomputed each run: high when corroborated by two
  or more primary or trusted sources, low when it rests on a single low-trust source.
- **Sources** cites each backing source by its identifier. Trust is not repeated on the bullet; the
  reader resolves it from the `## Sources` table (or the trust-list). One source renders as
  `Sources: [a].`, several as `Sources: [a], [b].`.

The bullet uses period-separated fields and full declarative sentences, not dashes, so it reads as prose
and obeys the project voice.

## 3. The trust-list (shared format, A-local file)

**File.** A separate file the user curates, path derived the same way:
`join(dirname(cfg.progressFile), 'trust-list.md')`, i.e. `.temper/trust-list.md` by default. It is
durable and human-owned. Temper reads it and never writes it.

The map confirms no standalone trust-list file exists today; the grounding sources live inline as
`directionCheck.sources` in `temper.config.json` (verified `src/config.mjs:70`, `src/engine.mjs:182`).
This spec keeps that inline array as the operational input the check grounds against, and adds the
durable markdown file as the place where trust compounds with a written rationale.

**Schema.** The same `| Source | Trust | Why trusted |` table as the ledger's `## Sources` section, so
the two files are visually identical and a confirmed candidate is a copy-paste:

```markdown
# Trust-list

> Sources I trust to ground direction checks. Durable; I own this list.
> A high-trust source added here compounds across every run.

| Source | Trust | Why trusted |
| --- | --- | --- |
| blog.maximeheckel.com (Maxime Heckel) | high | original, reproducible experiments; primary, not aggregated |
| react.dev/reference | high | official documentation; primary |
| docs/adr/ | high | our own decision records; primary for this repo |
```

Rows are local paths, path prefixes, URLs, or URL prefixes, plus a free-text "why". `Trust` is one of
`high | medium | low`. Temper does not parse this table programmatically; it reads the file as text and
passes it into the prompt (see §4), so a hand-formatted table with pipes in the "why" cell is never a
parsing hazard.

**The expertise rubric.** A source is scored against demonstrated expertise, not surface polish:

| Axis | Earns HIGH | Earns LOW |
| --- | --- | --- |
| Authorship | named expert with a track record | anonymous or pseudonymous |
| Primacy | primary source (the project's own docs, the author's own experiments) | aggregated, rehashed, syndicated |
| Reproducibility | claims you can re-run or verify | assertion with no method shown |
| Backing | book-, talk-, or spec-backed | SEO-shaped, citation-free, ad-driven |

A source scoring high on authorship and primacy, plus reproducibility or backing, is proposed as `high`.
A source that is anonymous and citation-free is `low`. Mixed signals land at `medium`.

**The propose-to-add flow.** The trust-list never grows automatically. When a run leans on a source not
already trusted, Temper appends it as a candidate bullet under `## Sources` in the ledger, clearly
marked:

```markdown
## Sources

<!-- CANDIDATE: proposed by the direction check. Verify against the rubric, then move into the table above and into trust-list.md to confirm. -->
- candidate: kentcdodds.com (Kent C. Dodds) | high | named expert; primary, reproducible posts

| Source | Trust | Why trusted |
...
```

A candidate is a bullet, not a table row, so appending it needs no table-row positioning. The user
reviews candidates and, for any that hold up, hand-moves the row into the `## Sources` table and into
`trust-list.md`. Confirmation is a manual edit, by design. Temper never writes `trust-list.md`.

**Shared by format, not by file.** This trust-list lives under `.temper/`, which is per-repo and
gitignored. That is correct for A. Surface B will keep its own trust-list in its own location (a
user-global or `docs/` path) and share only this format, not this file. B must not assume it can read
A's `.temper/trust-list.md`.

## 4. Surface A integration

**Config: one new key, OFF by default.** Extend the existing `directionCheck` block (verified
`src/config.mjs:70`), which is already deep-merged (verified `src/config.mjs:84`):

```js
directionCheck: {
  enabled: false,
  sources: [],
  every: 1,
  onMiss: 'warn',
  ledger: false,   // NEW, opt-in: maintain the research ledger + read the trust-list
}
```

`ledger` is the only new key. The ledger and trust-list paths are derived from
`dirname(cfg.progressFile)` exactly like `report.md`, so they always sit beside the other runtime files
and a user who relocates `progressFile` does not get a stray ledger outside `.temper/`. No path is
configurable: a configurable path would invite pointing the ledger outside `.temper/`, where the
gitignore and scope-gate guarantees (verified `src/gates.mjs:114`, `.temper/` excluded) no longer hold.

The ledger is maintained only when `directionCheck.enabled && directionCheck.sources.length &&
directionCheck.ledger`. When `ledger:false`, the direction check behaves exactly as it does today.

**File I/O lives in one module.** `src/phases.mjs` already owns every `.temper/` write (`writeReport`,
`progress.json`; verified `src/phases.mjs:137,218`). It also owns the new reads and the new write, so
`src/engine.mjs` stays prompt-only and a single module owns the file format:

- `src/phases.mjs`, before calling the check, reads `trust-list.md` and the current `research.md` (each
  if present) as strings.
- It passes them into the check: `runDirectionCheck(cfg, plan, { trustList, priorLedger })`.
- After the check returns, it calls the new deterministic helper `appendResearch(...)` to write.

**`src/engine.mjs` `runDirectionCheck` (verified `176-193`): prompt-only extension.** Today it embeds
`cfg.directionCheck.sources` into the prompt and returns `{ sound, concern, source }`. When the caller
passes `trustList` / `priorLedger`, it additionally:

1. Embeds the trust-list text (bias the judgment toward trusted sources) and the prior ledger (do not
   repeat findings already recorded) into the prompt. No file reads happen here; the strings arrive from
   `phases.mjs`.
2. Extends the requested JSON contract with optional ledger material:
   ```json
   {
     "sound": true,
     "concern": "...",
     "source": "...",
     "findings": [{ "claim": "...", "support": "high", "sources": ["a", "b"], "note": "..." }],
     "candidateSources": [{ "source": "...", "trust": "high", "why": "..." }]
   }
   ```
   `sources` and the candidate fields are arrays/strings the deterministic layer renders; `support` and
   `trust` are one of `high|medium|low`.
3. Returns `{ sound, concern, source, findings, candidateSources }`.

**The verdict stays authoritative and fail-open is unchanged.** This is the load-bearing safety rule.
Verdict acceptance is exactly as today: the check honors the verdict only when `typeof v.sound ===
'boolean'` (verified `src/engine.mjs:191`), otherwise it fails open to `{ sound: true }`. `findings` and
`candidateSources` are strictly best-effort and parsed independently: missing or non-array means treat
as empty (append nothing); each element is validated and a malformed one is dropped. A garbled or bloated
findings payload can never downgrade a valid `sound:false` verdict and can never block the queue. A run
that returns only `{ sound }` still works and simply records nothing.

**`appendResearch(ledgerPath, repoName, findings, candidateSources)`: a thin, deterministic writer.**

- If the ledger file is absent or does not contain the marker line `# Research ledger:`, seed it from a
  fixed header template (title, the `>` notes, the three empty sections) before appending.
- Insert rendered finding bullets immediately after the `## Findings` line, newest first. Insert rendered
  candidate bullets (each preceded by the `<!-- CANDIDATE ... -->` comment) immediately after the
  `## Sources` line. Both are single-line-locator splices: find the header line, insert after it. There
  is no markdown-table parsing and no rewriting of existing content.
- If a section header is missing (a user mangled the file), append a fresh section with that header at
  end of file rather than losing data.
- **Sanitize every engine-supplied string before writing.** Reuse the existing `mdCell` discipline
  (verified `src/phases.mjs:89`: collapse newlines, escape `|`, neutralize backticks) for any value, and
  additionally strip leading `#` and ``` fences from claim/note text so the engine cannot inject a
  heading or code fence into the document. The claim and note are plain text, not inline code.
- It never deletes or rewrites existing bullets, and never touches `trust-list.md`.

**Trust-list reuse vs introduction.** The inline `directionCheck.sources` array stays the operational
pointer the engine grounds against (verified embedded at `src/engine.mjs:182`). The new
`.temper/trust-list.md` is the durable, human-owned, rubric-scored record with the rationale and trust
levels the flat array cannot hold. The array is the runtime input; the markdown file is where trust
compounds and where the propose-to-add flow lands.

## 5. Data flow

A single direction-check run with `ledger:true`:

1. `runPhases()` reaches phase `n`; the existing guard fires (`opts.overnight && dc.enabled &&
   dc.sources.length && n % dc.every === 0`; verified `src/phases.mjs:312`).
2. `runPhases` reads `.temper/trust-list.md` and `.temper/research.md` (each if present) as strings.
3. `runDirectionCheck(cfg, plan, { trustList, priorLedger })` builds the prompt: the existing direction
   instructions, plus the trust-list (bias toward trusted sources), plus the prior ledger (do not repeat
   recorded findings). The critic grounds the phase's approach against the sources (reading local paths
   directly, fetching URLs only if it already has web tools; verified `src/engine.mjs:180-181`) and
   returns the extended JSON.
4. `runDirectionCheck` parses with the existing `lastJsonObject` (verified `src/engine.mjs:190`) and
   returns the verdict plus best-effort `findings` and `candidateSources`. Malformed output fails open to
   `{ sound:true }` with empty arrays.
5. **Immediately after the call (before the `if (!d.sound)` block), `runPhases` calls
   `appendResearch(...)`.** This placement is required: the pause path calls `process.exit(7)` inside
   that block (verified `src/phases.mjs:333`), so a write placed after the block would be skipped on a
   pause, which is the most consequential run. Appending before the block means sound, warn, and pause
   all record their findings.
6. The existing warn/pause logic then runs unchanged on `sound` (verified `src/phases.mjs:312-336`).
7. Later, the user reviews candidate bullets and hand-moves any that hold up into the `## Sources` table
   and `trust-list.md`, where they compound on every subsequent run.

## 6. Error handling and edge cases

- **No trust-list yet.** `trust-list.md` absent is a normal, supported state, not a misconfiguration.
  The check still runs on the inline `directionCheck.sources` (verified `src/engine.mjs:182`); the prompt
  omits the trust-list block; any source used can still surface as a candidate.
- **Brand-new topic (no ledger yet).** `research.md` absent: `appendResearch` seeds the fixed header and
  three empty sections, then appends. No dated file is ever created.
- **Low-support-only finding.** A `support: low` finding is still recorded; it is never dropped. The
  verdict is independent: the existing rule flags `sound:false` only on a concrete, sourced wrong
  direction (verified `src/engine.mjs:183-185`), so a low-support finding informs the ledger without
  forcing a pause.
- **Malformed ledger material.** Per §4: the verdict is honored if `sound` is a boolean; `findings` /
  `candidateSources` are best-effort; non-array means append nothing; malformed elements are dropped. A
  valid `sound:false` with a garbled findings array still pauses. Non-JSON fails open to `sound:true` and
  appends nothing. A garbled run never corrupts the ledger.
- **Injection via engine text.** All engine strings are sanitized before writing (§4), so a `|`, a
  newline, a `#` heading, or a ``` fence in a claim, note, or candidate can never break the table or
  inject document structure.
- **Reruns and growth.** Findings are append-only. Two guards keep this from becoming noise: the prior
  ledger is fed into the prompt with an instruction not to repeat recorded findings (a soft, free
  dedup, asserted as a prompt expectation in tests), and the growth is an owned non-goal: Temper never
  auto-prunes the ledger; the user curates it by hand, exactly like the trust-list. There is no
  programmatic finding or candidate dedup, by deliberate choice (§7).
- **Gitignored.** The ledger and trust-list live under `.temper/`, which is gitignored and must stay so;
  Temper already fails a run if `.temper/` is not ignored (per the map; `.gitignore` carries `/.temper/`).
  The scope gate excludes `.temper/` (verified `src/gates.mjs:114`), so ledger writes can never trip it.
  To commit research, the user copies it out of `.temper/`; Temper does not manage that.

## 7. What we are NOT doing (YAGNI)

- No programmatic dedup of findings or candidate sources. The user curates the ledger and trust-list by
  hand and removes duplicates in the same pass where they confirm candidates. Soft dedup via the prompt
  is enough; a markdown-table parser to dedup rows is not worth its cost or failure modes.
- No automated or numeric trust scoring. The rubric is applied by the engine and the user.
- No link-fetching or crawling pipeline. URL fetching stays exactly as today, only if the engine already
  has web tools (verified `src/engine.mjs:180-181`). Zero new runtime dependency.
- No database, index, or embeddings. One markdown ledger and one trust-list per repo.
- No auto-confirmation of candidates into the trust-list. Confirmation is a manual edit.
- No new engine invocation. The ledger reuses the single existing critic call.
- No second configurable path and no extra config keys beyond `ledger`.
- No change to the warn/pause/exit-7 behavior, the ledger-entry `direction` object, or the morning
  report's direction block (verified `src/phases.mjs:184-188, 312-339`).
- **Surface B is out of scope.** A personal skill that runs this discipline for any topic, keeping a
  per-topic ledger with no Temper dependency, is a separate later spec. It reuses this format only.

## 8. Testing

Follow the existing throwaway-git-repo + fake-engine pattern (verified `test/onboarding.test.mjs`,
`test/modeb.test.mjs`, `test/audit.test.mjs`). The fake critic is a stub that echoes a fixed JSON line,
so output is deterministic.

**`test/research-ledger.test.mjs` (new)** unit-tests the deterministic `appendResearch` directly (the
style of `test/removal-gate.test.mjs`):

- *Seeds on first run.* No `research.md`: after one append the file exists with the marker header and all
  three sections.
- *Append, not respawn.* Append twice with different findings; both finding bullets are present and the
  `# Research ledger:` header appears exactly once.
- *Support recorded, trust not duplicated.* Given `{ support:'high', sources:['a','b'] }`, the bullet
  contains `Support: high` and `Sources: [a], [b]` and contains no per-bullet `trust:` field.
- *Candidate appended and marked.* A candidate is written as a bullet preceded by the `<!-- CANDIDATE`
  comment, under `## Sources`, not as a table row.
- *Sanitization / injection.* A finding note containing `|`, a newline, a leading `#`, and a ``` fence is
  written without breaking the table or introducing a heading or fence (assert the rendered line is one
  line and the document still has exactly three `##` section headers).
- *Malformed element skipped.* A finding object missing `claim` is not written; prior content is intact.
- *Trust-list untouched.* `trust-list.md` content is unchanged across appends.

**`test/modeb.test.mjs` (extend)** integration with a fake critic returning the extended JSON:

- With `directionCheck.ledger:true`, after an overnight run `.temper/research.md` exists and contains the
  expected finding rendered per the grammar.
- With `ledger:false`, no ledger file is created (opt-in OFF).
- The existing warn/pause assertions still pass unchanged (no regression to `src/phases.mjs:312-336`).
- *Fail-open, verdict preserved.* A critic that returns valid `sound:false` with a garbled `findings`
  value still pauses (verdict honored), and the ledger gains no malformed content.
- *Fail-open, non-JSON.* A critic that emits non-JSON: the run completes, the verdict is `sound:true`,
  and the ledger is absent or unchanged.

Every assertion is on file content the stub fully controls. No real engine, no network.

## 9. Touch-point checklist

| File | Change |
| --- | --- |
| `src/config.mjs` | Add `ledger: false` to `DEFAULTS.directionCheck` (line 70); the deep-merge at line 84 already covers nested keys. Update the surrounding comment (lines 61-69). No path keys. |
| `src/engine.mjs` | Extend `runDirectionCheck(cfg, plan, opts)` (lines 176-193): accept `{ trustList, priorLedger }`, embed them in the prompt, extend the requested JSON with optional `findings` + `candidateSources`, keep the verdict-only fail-open exactly as today. No file I/O added here. |
| `src/phases.mjs` | When `cfg.directionCheck.ledger`: read trust-list + prior ledger as strings, pass them into `runDirectionCheck`, and call the new `appendResearch(...)` immediately after the call and BEFORE the `if (!d.sound)` block (line 314, before the pause exit at 333). Add `appendResearch` (seed-or-locate header, insert-after-header, `mdCell` sanitize, never touch `trust-list.md`). Leave warn/pause/report logic (lines 312-336, 184-188) unchanged. |
| `bin/temper.mjs` | Required: extend the `EXPLAIN['direction']` entry to name the research ledger and trust-list and the propose-to-add flow. Do not add a new explain key. Do not add a doctor check (an absent trust-list is a normal state). |
| `README.md` | Required: add `ledger: true` to the `directionCheck` config example, and a short "Research ledger" section describing the format, the support-vs-trust split, and the propose-to-add flow. |
| `templates/PLAN.template.md` | No change (the direction check is config-level, not Plan frontmatter). |
| `.gitignore` / `temper.config.json` | No change; `.temper/` is already ignored, covering both files. |
| `test/research-ledger.test.mjs` | New unit test for `appendResearch` (see §8). |
| `test/modeb.test.mjs` | Extend with the ledger integration, opt-in-OFF, and two fail-open assertions (see §8). |

All current-behavior claims above carry the `src/...:line` the grounding pass verified. The one item the
grounding pass flagged rather than re-read: the exact `.temper/`-must-be-gitignored enforcement line in
`src/phases.mjs`; the implementer should confirm it when wiring the helper. The `EXPLAIN` and README
edits are new prose, so their final wording is settled at implementation time.
