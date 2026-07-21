# 08 — The signal bus & round-F variance hardening

**Status:** IMPLEMENTED (2026-07-14, commit `3a1f4802e`) — all waves landed: bus core
(SB-1), producer wiring (SB-2), deferral consumer (SB-3), RF-2..RF-7, T1; verified by
tsgo + 692 targeted tests + CLI smoke. This doc is the build plan + record
for the round-F wave: the unified signal bus, the hard-tail deferral consumer, and the
seven deterministic conversions from the
[variance forensics](../testing/HARNESS_AND_VARIANCE_REPORT.md) Part V, shaped by
[path-to-85](../design/path-to-85.md) §3/§5. Every seam below was re-verified at HEAD
`acb49dee5` by recon before design.

**The problem in one line** (forensics headline): all 8 fleet instance-failures ran 100%
conductor-inline — every right advisory signal fired, and **nothing consumed any of it
for routing**; recon confirmed zero references from orchestration code to
probe-gate/unverified/hub-bounce state.

---

## 1. Architecture — three layers, one bus, no advisory-only signals

```
LAYER 1 — PRODUCERS (existing detection logic, unchanged)
  M4 probe gate · S3/wave-10 unverified · F18 seen-red · F11/F16 regression
  · S2 repro deadline · repro drift · fidelity judge · hub bounce
  · convention divergence · S4 gate blocks · oracle-inversion detector (new)
  · interpreter-mismatch detector (new)
        │  each publishes ONE typed signal (in addition to its existing event)
        ▼
LAYER 2 — THE BUS  (packages/opencode/src/session/signal-bus.ts, new)
  per-session ring buffer + ONE structured log line per publish:
  [signal] name=… severity=… decision=… step=… evidence.…=…
        ▼
LAYER 3 — CONSUMERS (pure code; environment picks the route)
  CONVERT  → the existing bounded corrective nudges (now recorded on the bus)
  DEFER    → NEW: hard-tail signal plants a one-shot escalation pre-pass slice
             (reasoner-tier author via the existing allocator), once per turn
  SURFACE  → interactive sessions: the existing question.ask fork
  fail-open→ decision "none-loud" is legal ONLY after the deferral budget is spent
```

**The rule that keeps it one system:** a signal either converts, defers, or surfaces —
never advisory-only (12039's `turn_completed_unverified` with landed source edits is the
named anti-pattern). Gates stay *bounded-reject-then-fail-open-loud*; the bus inserts
exactly one new rung — **deferral** — between "bounded reject exhausted" and "fail open
loud."

**Traceability contract** (the whole point of the bus):

1. Every `publishSignal` writes exactly one `[signal]` line (Effect.logInfo in Effect
   contexts; the plain Log util inside tools) — same payload keys everywhere.
2. Every consumer action writes one `[signal] consumed …` line naming the signal it
   acted on and the action taken (`nudge` / `deferral_armed` / `surface_asked` /
   `none-loud`).
3. Turn end emits `[signal] turn_summary` with per-name counts + the deferral budget
   state.
4. All pre-existing event names (`turn_probe_gate`, `repro_unresolved`, …) are kept —
   the bus wraps, never replaces. `grep '\[signal\]' engine.log` reconstructs a run's
   full decision history.

---

## 2. The bus interface (FROZEN — workers code against this verbatim)

```ts
// packages/opencode/src/session/signal-bus.ts
export type EconSignalName =
  | "probe_gate_reject"             // M4 pin ran red at finish (bounded retry)
  | "probe_gate_exhausted"          // M4 retries exhausted — HARD TAIL
  | "oracle_inversion"              // pinned red's EXPECTED contradicts issue-stated output — HARD TAIL
  | "seen_red_unresolved"           // F18 at finish (2nd arrival = tail)
  | "unverified_finish"             // S3 / wave-10 deny (exhausted = tail)
  | "regression_red"                // F11 neighbor regressed (unresolved re-arrival = tail)
  | "repro_unresolved"              // S2 deadline abstention
  | "repro_drift"                   // drift detector (kind in evidence)
  | "fidelity_gap"                  // repro-fidelity judge/teeth rejection
  | "hub_bounce"                    // hub gate 1st bounce
  | "hub_bounce_repeat"             // evidence-bearing 2nd deny — HARD TAIL
  | "convention_divergence"         // wave-11 first pause
  | "convention_divergence_repeat"  // evidenced family conflict on identical retry — HARD TAIL
  | "interpreter_mismatch"          // agent probe ran a non-project interpreter
  | "interpreter_harvested"         // F21: interpreter reused from the turn's own green test run
  | "gate_block"                    // S4 governance BLOCK ledger entry
  | "deferral_armed"                // consumer record: pre-pass planted
  | "deferral_dispatched"           // consumer record: slice actually ran
  | "surface_asked"                 // consumer record: question routed to the human

export type SignalSeverity = "info" | "tail"
export type SignalDecision = "convert" | "defer" | "surface" | "none-loud"

export interface EconSignal {
  name: EconSignalName
  sessionID: string
  step?: number
  severity: SignalSeverity
  decision: SignalDecision
  evidence: Record<string, string | number | boolean | null>
}

export function publishSignal(signal: EconSignal): void        // buffer (cap 200) + 1 log line
export function signalsFor(sessionID: string): readonly EconSignal[]
export function tailSignals(sessionID: string): readonly EconSignal[]
export function deferralAvailable(sessionID: string): boolean  // true until marked
export function markDeferralUsed(sessionID: string): void      // once per turn
export function resetSignals(sessionID: string): void          // fresh-turn open only
export function signalSummary(sessionID: string): Record<string, number>
```

Interactive detection everywhere: `process.env["OPENCODE_HEADLESS"] !== "1"` — the same
signal `slice-orchestrator.ts:2160` and `permission/index.ts` already read.

---

## 3. The deferral consumer (report item 1 — the calibrated-deferral gap)

**Trigger sites** (each is today's loud fail-open branch; recon anchors):

| Signal | Site (prompt.ts) | Today | After |
|---|---|---|---|
| `probe_gate_exhausted` | `:3001` (`turn_probe_unresolved`) | loud pass | defer once → then loud |
| `unverified_finish` exhausted | `:3236` (`turn_completed_unverified`) | loud pass | defer once → then loud |
| `regression_red` unresolved | `:3385` (`turn_regression_unresolved`) | loud pass | defer once → then loud |
| `seen_red_unresolved` 2nd arrival | `:3105` (`turn_seen_red_unverified`) | loud pass | defer once → then loud |
| `hub_bounce_repeat` | mid-loop (gate) | pass-on-retry | 2nd deny + hub-design dispatch (existing wave-7) |

**Mechanism** (reuses the grind valve's proven planting path, `prompt.ts:2686-2689`):
`maybeArmDeferral(sessionID, brief)` → plants one `DEFERRAL_PREPASS` todo (dedupe by
content), `markDeferralUsed`, publishes `deferral_armed`, injects a two-line nudge
("a verification-grade escalation slice is planted — stop editing; it will run"),
`continue`s the loop. The todo write engages `runConductorOrchestration` exactly as the
grind-valve todo does.

**The brief is compiled, not prompted**: `compileDeferralBrief()` assembles the
deterministic evidence — which gate denied and its full text, the pinned probe command +
redTail, unresolved seen-red tails, hub defining-site candidates, issue-derived
expectations (§6), enumerated sibling/variant candidates — an enumerate-then-choose
brief, never "try again harder."

**Slice shape**: seeded via `seeds.ts` `buildDeferralSliceContent(brief)` with constant
prefix `DEFERRAL_SLICE_PREFIX`; `sliceType: "design"`-shaped like
`GRIND_DESIGN_SLICE_CONTENT` so the allocator's design rule routes the author to the
**oracle** tier (`allocation.ts:259`) and `shouldOrchestrate` passes on the
reasoner-floor rule (`slice-orchestrator.ts:1931`). The degraded stand-down filter
(`slice-orchestrator.ts:2220-2221`) gets a second escape hatch:
`t.content.startsWith(DEFERRAL_SLICE_PREFIX)` alongside `GRIND_DESIGN_SLICE_CONTENT`.
Double-pay lands through the existing slice-loop ledger (`double-pay.ts:124-154`).

**Bounds**: once per turn (`deferralAvailable`); a second exhausted gate in the same
turn goes loud exactly as today. Child sessions never defer (finish gates already skip
children). Interactive sessions may still defer; oracle-inversion prefers SURFACE (§5).

---

## 4. Producer wiring map (SB-2)

| Producer site | Anchor | Signal (severity → decision) |
|---|---|---|
| M4 reject, retry available | `prompt.ts:2974-2999` | `probe_gate_reject` (info → convert) |
| M4 exhausted | `prompt.ts:3001` | `probe_gate_exhausted` (tail → defer/none-loud) |
| F18 first nudge | `prompt.ts:3079` | `seen_red_unresolved` (info → convert) |
| F18 second arrival | `prompt.ts:3105` | `seen_red_unresolved` (tail → defer/none-loud) |
| Wave-10 deny | `prompt.ts:3142` | `unverified_finish` (info → convert) |
| S3 nudge / exhausted | `prompt.ts:3207/:3236` | `unverified_finish` (info→convert / tail→defer) |
| F11 regressed | `prompt.ts:3360` | `regression_red` (info → convert; unresolved → tail) |
| S2 abstention | `prompt.ts:2220` | `repro_unresolved` (info → convert; existing localization plant IS its defer) |
| Drift detector | `prompt.ts:2291/:2266` | `repro_drift` (info → convert) |
| Fidelity gap | fidelity dispatch site | `fidelity_gap` (info → convert) |
| S4 block ledger | `prompt.ts:2148` | `gate_block` (info → convert) |
| Hub 1st bounce | `edit.ts:138` / `write.ts:98` | `hub_bounce` (info → convert) |
| Hub evidence-deny | gate (new, §7) | `hub_bounce_repeat` (tail → defer) |
| Convention 1st | `edit.ts:232` / `write.ts:147` | `convention_divergence` (info → convert) |
| Convention evidenced retry | gate (new, §7) | `convention_divergence_repeat` (tail → defer) |
| Interpreter rewrite | probe-run sites (§9) | `interpreter_mismatch` (info → convert) |
| F21 turn-harvest hit | M4 site + F11 site (§9) | `interpreter_harvested` (info → convert) |

`resetSignals` runs at fresh-turn open next to `resetResolveAttempts`
(`prompt.ts:3550-3564` region); continuation turns inherit, matching pin/arming
inheritance.

---

## 5. Oracle-inversion escape (RF-2 — the 11815 class)

**Detection is pure code**, at the M4 gate reject moment (`prompt.ts:2966+`), BEFORE the
reject-nudge: `detectOracleInversion(redTail, issueExpectations)` — true when an
issue-derived *expected* literal (§6) appears on the red's **actual** side (the code's
new behavior matches what the issue asked for) while the assertion's **expected** side
contradicts it. Both 0713 runs had exactly this string evidence in the redTail
(`actual = TextEnum['A']` — gold-correct; `expected = TextEnum('a-value')` — the bug).

**Routing on hit** (never the "STILL FAILING … do not edit the test" nudge — that text
actively instructed the 0713 retreat):

- interactive → SURFACE: *"the visible test contradicts the issue statement — which one
  is the ground-truth spec?"* via the question.ask fork.
- headless + deferral available → DEFER with the inversion verdict in the brief.
- headless + deferral spent → **loud-red finish with a stated
  `visible_test_encodes_bug` verdict** in the finish summary — explicitly allowed;
  "make the buggy assertion pass" is never an exit.

**Seed carve-out** (same class, prompt side): the *tests-are-spec* prior in `seeds.ts`
gains: *"EXCEPTION: if a visible test's expectation contradicts the issue's stated
desired output, the ISSUE is the spec — do not contort the fix to keep the contradicting
assertion green; state the conflict in your answer instead."*

---

## 6. Issue-derived expectations (T1 — mechanical, turn-open)

New pure module `packages/opencode/src/session/issue-expectations.ts`:
`extractIssueExpectations(issueText)` → `{ literals: IssueExpectation[] }`,
`IssueExpectation = { value: string; kind: "expected" | "actual" | "error"; source: string }`.
Conservative patterns only (cap 8, value length 2–120): backticked/quoted literals and
fenced-code lines adjacent to expected/should/instead-of/got/actual/returns markers;
assertion-shaped lines (`==`, `assert`, `!=`) inside code blocks; traceback last-lines.
No LLM call — recon confirmed nothing parses issue text for values today
(`extractIssueSymbols` at `graph-tools.ts:442-466` extracts graph symbols only).

**New in round F:** `extractIssueThresholds` captures sentence-scoped numeric bounds:
`IssueThreshold = { value: number, quote: string }` from patterns like "more than 50 years",
"at least N", "up to X", gated on rule-force words (must/should/interpret/treat/consider/required).
Cap 3 per issue. Extracted 11848's "more than 50 years … MUST interpret" rule. Also: prose-block
extraction via `EXPECTED_PROSE_BLOCK_RE` (lines with "would be expected:", "should be:", etc.)
and `ACTUAL_PROSE_BLOCK_RE` ("instead of:", "rather than:", "currently generates:", "will generate")
— extracts same-line-after-colon or next-non-empty-non-fence line. Captured both CREATE INDEX
variants in 12039's expected block. Fixture-tested against all 10 Mini-10 PROMPT.txt files; 0 false
fires on the 7 passing cases.

Stored at turn-open next to the pin (`turn-read-store.ts` pattern, keyed by session).
Four consumers:

1. **Repro seed contract**: skeleton build appends one line to the repro todo — *"your
   repro MUST assert these issue-stated values with typed equality: …"* (the compiled
   list). For thresholds: *"assert BOTH sides of each stated boundary"* binding preamble.
2. **Fidelity judge** (§8): the literals ride in as `requiredLiterals` — quote-coverage
   becomes deterministic, not judge discretion.
3. **Stated boundary rules rubric**: `RunReproFidelityJudgeInput.statedRules?: readonly string[]` 
   threads the threshold quotes into the judge prompt as a "Stated boundary rules" both-sides-of-boundary
   rubric (byte-identical when absent).
4. **Oracle-inversion detector** (§5).

**P5 turn-read degrade behavior**: when the LLM turn-read returns null, the mechanical
extractors still run (`extractIssueExpectations`, `extractIssueThresholds`) — literals +
thresholds are facts not guesses. The binding preamble lines are planted verbatim. Extraction
failures never block the turn.

---

## 7. Gate hatches → evidence-bearing (RF-3 — the 11848/11964-A class)

Both hatches stay bounded and fail-open; they gain exactly one evidence-bearing rung.

**Convention gate** (`convention-divergence.ts`): today one deny per session, identical
retry passes (`evaluateConventionDivergenceGate` → `"pass-retry"`). New rung: on
identical retry, if the novel method belongs to a known ambiguous **semantic family**
(first family: time/tz — `now/utcnow/localtime/today`) AND the file/function carries
opposite-member evidence (existing opposite-member call sites, or `UTC` in the edited
function's docstring — 11848 had both), deny a SECOND time quoting that evidence +
publish `convention_divergence_repeat` (tail). A third identical attempt passes
(fail-open). No family match or no evidence → passes on retry exactly as today.

**Hub gate** (`edit-governance.ts:604-617`): today re-issue passes on set membership
alone. New rung: when the resolved defining-site allowlist is **non-empty** and the
retried file is NOT in it, deny a second time naming the defining sites + publish
`hub_bounce_repeat` (tail) — this also sets the existing wave-9 flag that dispatches the
synchronous hub-design judge. Third identical attempt passes. Empty allowlist (no graph
evidence) → retry passes as today; we hold nothing without evidence.

---

## 8. Repro-fidelity teeth (RF-4 — the 11790/12039 class)

Five deterministic checks merged into the verdict exactly like the existing F14b
`applyAssertionTeethGap` (`repro-fidelity-judge.ts:178-184`), chained in order:
assertion-teeth → rendered-assert → required-literals → stringified-mirror → numeric-string-conflict:

1. **Rendered-assert detector**: substring/`assertIn` asserts against
   rendered/serialized values (`in html`-shaped, `str(…)`/f-string/`render()` on the
   compared expression) → forced gap quoting the seed's own point (2): *"assert the
   API-LEVEL value with == — rendered output hides type differences like '255' vs
   255."* This flips 11790's exact face (`'maxlength="254"' in html`, judged
   `repro_fidelity_ok` on 0713).
2. **Required-literal coverage** (§6): any §6 literal/threshold absent from the repro
   content → forced gap naming the missing literals (converts 12039's ignored
   `'"name" DESC'`-style witness into a binding requirement).
3. **Stringified-mirror tooth** (new round F; extended 2026-07-14 commit `388cf3255`
   to follow one hop of `str()` variable-indirection): `detectStringifiedMirrorAssert`
   fires when an assert's expected side stringifies the value under test (`== str(x)`,
   `assertEqual(chain, str(chain))`) — proves representation, not type. Does NOT fire on
   subject-stringify (`assert str(x) == 'literal'`), membership asserts, strftime, non-assert
   lines. Forced gap: *"the prior forbids stringifying — you are asserting the mirror"*
   (addresses 11790's typed-equality anti-pattern). Publish `STRINGIFIED_MIRROR_GAP` with
   context of the mirrored expression. **One-hop alias extension (`388cf3255`):** closes
   the gap where the `str()` call and the assert sit on separate lines —
   `expected = str(form.fields['username'].max_length)` then a plain
   `assert widget_attrs['maxlength'] == expected` evaded both the single-line `== str(`
   regex above and `detectNumericStringConflict`'s quoted-literal requirement. Mechanism:
   (1) pre-scan `IDENT = str(...)` bindings into a str-alias set, (2) new
   `extractAssertComparisonSides` extracts operands of plain `assert A ==/!= B`
   statements, (3) fire when one side is a str-or-alias and the OTHER is an
   attr/subscript chain — the asymmetric chain requirement is the false-fire guard (a
   legit aliased `__str__`, `actual = str(member); assert actual == '1'`, stays silent
   because the literal side isn't a chain; a plain-var comparison, `out3 = str(ic);
   assert out3 == expected3`, stays silent because `expected3` isn't a chain either).
   Unit-proven: 91/91 tests green (+4 fixtures), typecheck clean; full live-fire record
   in [STRICT_CYCLE.md](../testing/STRICT_CYCLE.md).
4. **Numeric-string-conflict tooth** (new RF-8, 2026-07-14): `detectNumericStringConflict`
   fires when a quoted pure-integer literal (`'150'`, `'255'`) is compared/assert-tested
   on one line while the same digit sequence appears bare elsewhere in the repro script,
   signaling an internal type conflict a `str()` fix cannot resolve. Does NOT fire on
   `\bstr\(` subject-stringify (11964/12039's legit `assert str(c) == '"name"'` shape),
   non-numeric strings (`'3.9'`, `'"name" DESC'`, `'foo'`), or repr/format tokens (`%r`,
   `%s`, `f"..."`). Forced gap: *"typed-integer literal discrepancy: you are comparing
   a quoted string where the issue and code show the unquoted number"*. Merges via
   `applyNumericStringConflictGap` alongside RF-5. `detectTypeUnfaithfulRepro` composes
   stringified-mirror + numeric-string-conflict into the high-precision subset a
   finish-time re-check gates on.

All five publish `fidelity_gap`; the LLM fidelity judge still runs for what mechanics can't
see. Gaps → existing `reproFidelityNudgeText` render, unchanged. All are converts (nudge),
never blocks.

---

## 8.1 RF-8 finish-time type-fidelity re-check (2026-07-14, IMPLEMENTED)

**The hole it closes:** the 11790 re-fire showed the agent can evade pin-time fidelity
detection by rewriting a pinned repro between judgment and finish — from `assert maxlength != 254`
(fails on `'254'` fix) into `if val != '150': failures.append(...)` form, dodging every
assert-anchored detector. The pinned-repro-judged-once-per-turn discipline meant no
re-judgment, and the M4 finish gate accepted the probe-green result with zero content
re-check. The fix adds one bounded re-check at M4 green finish inside prompt.ts (lines
3345–3358): extract the on-disk pinned repro's CURRENT content (not memory-cached),
re-run `detectTypeUnfaithfulRepro` composite (the high-precision subset), and on a
positive hit (numeric-string conflict OR stringified-mirror), deny once with a nudge
naming the offending line and demanding typed equality against the natural source.
Subsequent green finish passes loud (no re-entry wedge). One `fidelity_finish_reject`
signal publishes per turn, decision `"convert"`.

**False-fire audit (5 of 7 round-F *passing* runs logged fidelity gaps — 11815/11951/11964/11999/12050):**
all 5 gap records were either rendered-tooth static text (11815/11964/12050 — the
"'255' vs 255" line) or LLM-judge prose (11951 bulk_create, 11999 tool-batch), NOT
numeric-string or stringified-mirror conflicts — the finish-denier consumes only the
high-precision composite, so a naive all-gaps denier would have false-fired on all 5
while RF-8 fires on none. The three on-disk final repros confirm it directly: 11790 FIRES
(`field.max_length != 150` bare vs `attrs.get('maxlength') != '150'` quoted — the target),
11848 clean (asserts `datetime` objects), 12039 clean (asserts letter/quote strings plus
the protected `assert str(c) == '"name"'` subject-stringify).

**Live-validated (2026-07-14, 5-attempt strict fresh-arena re-fire hunt, binary
`388cf3255`):** 5/5 REAL PASS on django-11790; attempt 5 hit
`fidelity_finish_reject` (decision `convert`) — the finish-time re-read found
`attrs["maxlength"] == "150"` (quoted), the deny nudge fired, the agent
rewrote to typed equality against the natural source, then passed. Attribution
is honest: attempt 5's catch was the pre-existing `detectNumericStringConflict`
half of the composite, not the one-hop `str()`-alias extension above — the
indirection shape did not recur across the 5 draws. The finish-re-check +
conversion mechanism is now live-fire proven; the alias extension itself
remains unit-proven (0/5 recurrence). The gate is bidirectional (repro
integrity at pin time + content integrity at finish time); full per-attempt
record in [STRICT_CYCLE.md](../testing/STRICT_CYCLE.md).

Recon sites: `repro-fidelity-judge.ts:31-37` (mechanism documented), `prompt.ts:3345-3358`
(finish-check wiring + fidelityFinishDenied flag), `signal-bus.ts:26` (signal definition).

---

## 9. Interpreter discipline + script-path fix (RF-6 — the 11964-A/11848-B class)

F14a discovery (`regression-neighbors.ts:458-469`, `discoverProjectInterpreter`) governs
only the regression gate today; the M4 finish gate runs the pinned command **as-is**
(recon-verified: no discovery at `readPinnedReproFile`/`stepRanPinnedProbeGreen` path).
Change: one pure helper `rewriteInterpreterCommand(command, interpreter)` (swaps a bare
`python`/`python3` head token; anything else returned untouched) applied at every
ENGINE-run probe site — M4 gate run, F13d engine probe (`prompt.ts:2338`), pin re-runs —
using the turn-cached `turnDiscoveredInterpreter` (`prompt.ts:1831`). When a rewrite
changes the command, publish `interpreter_mismatch` and CONVERT-nudge the agent once to
use the discovered interpreter for its own runs (11964-A's phantom `ChoicesMeta`
TypeError came from base-conda py3.11 vs testbed py3.6).

**New in round F:** `extractScriptPath` (repro-drift.ts) replaces basename extraction in
`dispatchPinnedReproFidelity` + `toothlessPinScript`. Returns the full script token as
written, honoring absolute paths — round-F 11848's repro lived at `/var/folders/…/T/opencode/`
and the old basename-only extraction degraded to file-missing. Used by both the drift
detector and the fidelity dispatcher.

**New 2026-07-18 (F20/F21, from the shapely-2226/linkding-995 `live_verified`
forensics).** F14a governs interpreter *discovery* for the regression gate;
`harvestTurnInterpreter` (F21) now runs FIRST at both that gate and the M4 pinned-probe
site — it scans the turn's own bash executions for a green, test-shaped, python-headed
run and reuses its interpreter token before F14a's `sys.path`-stripped synthetic probe,
publishing `interpreter_harvested` on a hit (linkding-995's gate skip was exactly a
probe-miss the transcript already disproved). Sibling fix `collectGraphNeighborCandidates`
(F20) extends F11's neighbor selection itself — filename/stem rungs alone missed
shapely-2226's call-graph-only regression — by walking reverse-call edges from touched
files via the in-process graph. Full mechanism detail, caps, and degrade behavior:
[HARNESS_AND_VARIANCE_REPORT.md](../testing/HARNESS_AND_VARIANCE_REPORT.md) I.5 item 5
and Part IX.

---

## 10. Hub-design judge sanity floor (RF-7 — the 11964-A hallucination)

`runHubDesignJudge` gains the turn's issue text as input and a pure grounding check:
a verdict must share ≥1 non-trivial token (len ≥ 4) between its `entity`/`change` and
the issue text, else `DEGRADED_HUB_DESIGN` (11964-A's `Q.__invert__`/De Morgan verdict
fails trivially). The judge's user prompt is built from the stored turn-open user text —
never the running transcript — so injected meta-prompts ("ECONOMY CHECK") can't be
chewed as content (the observed `judge-degraded` face). Existing site guard
(`pathsRefer` when definingSites non-empty) stays.

---

## 11. Seed precedence + priors (RF-5) and masking audit (T0)

`prompts/seeds.ts`, four sentences (the strict cycle proved one-sentence priors steer):

1. Precedence: *"typed-mirror overrides idiom-mirror: even when a neighboring helper
   stringifies, assign/assert the TYPED value"* (11790's clause conflict, resolved).
2. The `%r`/repr line (round-E 11815 face; near-zero cost).
3. Sibling-propagation enumeration: *"when the fix changes how a construct renders,
   ENUMERATE every sibling class that renders the same construct and check each — as a
   checklist, not from memory"* (12039).
4. Tests-are-spec carve-out (§5).

**T0 verdict from recon: masking-first is already enforced** — pass order at
`compaction.ts:56` is mask → pruneStaleReads → prune, all deterministic passes complete
before any summarize call, and pinned parts are protected (`isPinnedPart`
`compaction.ts:221`, task digests `:235`). Remaining work is a regression test pinning
the ordering + pin protection so it can't silently regress.

---

## 12. Waves, ownership, verification

| Wave | Slice | Files (disjoint per slice) | Owner |
|---|---|---|---|
| A | SB-1 bus + test | `signal-bus.ts` (new), `test/session/signal-bus.test.ts` | main thread (new public interface) |
| A | W1 seeds | `prompts/seeds.ts` (§11 + §5 carve-out + `DEFERRAL_SLICE_PREFIX`/`buildDeferralSliceContent`) | worker |
| A | W3 judges | `repro-fidelity-judge.ts`, `hub-design-judge.ts`, `prompts/judges.ts` + tests (§8, §10) | worker |
| A | W4 expectations | `issue-expectations.ts` (new) + test (§6 extractor only) | worker |
| A | W5 interpreter | `regression-neighbors.ts` export + `rewriteInterpreterCommand` + test (§9 pure part) | worker |
| A | W6 masking test | `test/session/compaction.test.ts` (T0 regression test) | junior |
| B | W2 gates | `convention-divergence.ts`, `edit-governance.ts`, `edit.ts`, `write.ts`, `prompts/nudges.ts` + tests (§7; imports bus) | worker |
| B | wiring | `prompt.ts` (SB-2 §4, RF-2 §5, RF-6 §9, T1 wiring), `slice-orchestrator.ts` (§3 consumer, degraded-filter hatch, seed contract line) | main thread (cross-cutting, hot file, serialized) |
| C | verify | `tsgo --noEmit` + targeted `bun test` files + CLI smoke → commit | junior + main |
| C | docs | this doc's Status, features/docs README index rows, SWE_BENCH_TRACKER grader-artifact rows | junior |

Verification per repo rule: typecheck + targeted test files + smoke only; commit the
moment green. Live-fire (Mini-10 re-run) is a separate, later step on committed code.

**What this wave explicitly does not do** (path-to-85 §7): no blanket best-of-N, no
MCTS, no standing critic pass, no new in-loop cheap judges (the two judge changes here
narrow/ground existing judges), no LLM-summarize-first compaction, no ecosystem-adapter
work yet (that is the next feature wave, path-to-85 §4).
