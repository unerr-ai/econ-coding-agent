# Tier live-fire tests — the five doors, and how to debug a door that won't open

This is the acceptance-test playbook for econ's escalation machinery on **real repos**:
five canonical test cases, one per routing door, plus the decode/debugging discipline we
use to compare the trace we *got* against the flow we *expected* and reverse-engineer any
divergence. Run these (or tests of the same shape) after any change to routing, slice
typing, allocation, or verification. The door logic itself is owned by
[03-risk-router.md](../features/03-risk-router.md); this doc only states the trigger
conditions compactly so each test is runnable standalone.

**The one rule that explains everything:** the conductor is never swapped at turn-open
(`packages/opencode/src/session/tier-router.ts:2-8`). The only door to other tiers is the
todo list — the dispatch hook (`packages/opencode/src/session/prompt.ts` OL-7.3b) engages
only when the list holds at least one *typed, pending* slice. No todowrite → no slices →
100% conductor, no matter how hard the task.

```
prompt ──► conductor ──► todowrite? ──no──► inline answer (100% conductor)
                            │yes
                            ▼
                  autoTypeTodos (todo tool boundary)
                  ├─ audit-shaped list (no build-verb item)
                  │    judgment items ─► verify + need:reasoner   [door 2]
                  │    check-run items ─► verify (runner/executor)
                  ├─ bug-shaped build list, NO file named
                  │    append localization design slice ─► oracle [door 1]
                  └─ anything else ─► untouched (no dispatch)
                            │
                            ▼ per typed slice: allocateSlice
                  design → oracle | testable → executor (clamped)
                  untestable·high-coupling → oracle + judge rung  [door 3]
                  untestable·low-coupling·unbacked-mechanical → reasoner [door 5]
                  failed verification → escalation ladder climbs  [door 4]
```

Key seams: `autoTypeTodos` + guards (`packages/opencode/src/session/slice-orchestrator.ts:440-522`),
`allocateSlice` (`packages/code-intelligence/src/allocation.ts:132-212`),
probes (`packages/opencode/src/tool/graph-tools.ts:404-621` — coupling high needs
computeTurnRisk ≥ 50; *testable* = any of: a `*.test.*`/`*.spec.*` file mentioning the
file's stem or exports, an ancestor tsconfig for a `.ts` file, or a build/typecheck/compile
script in the owning package.json), judge tier (`resolveJudgeTier`,
`packages/code-intelligence/src/model-registry.ts`).

## Test protocol (identical for every case)

1. **Clean arena.** Fresh clone into a scratch dir, pinned commit, plant any working-tree
   state the case needs (a flawed fix, a trap). Never reuse a prior case's arena.
2. **One prompt file per turn**, run via a detached runner script + bounded watcher —
   never `tail -f`/unbounded polling (zombie trees):

   ```bash
   # runner: cd arena && opencode run "$(cat caseN-t1.txt)"; capture sid:
   sqlite3 ~/.local/share/opencode/opencode-main.db \
     "SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_created DESC LIMIT 1"
   # watcher: nohup bash runner.sh 1 & then
   for i in $(seq 1 90); do [ -f caseN-t1.done ] && exit 0; sleep 20; done
   ```
3. **Decode the session** (see toolkit below) and fill in the case's observed-trace row.
4. **Compare against the expected trace** and, on divergence, walk the checklist.

## The debug toolkit

All state lives in `~/.local/share/opencode/opencode-main.db` (message / part / session /
todo tables). Four probes answer almost every question:

- **Tier & cost rollup** — per root turn and per child session: model, steps, tokens
  (input / cache read / cache write / output / reasoning), DB cost vs ECON_COST_MATRIX
  recompute (must agree at ratio 1.00 — if not, cost accounting regressed; see
  [06-observability.md](../features/06-observability.md)). Decoder pattern: split root
  messages into turns at each user-role row; attach children by creation-time window.
- **Todowrite dump** — every list the conductor wrote, with status + any
  `sliceType`/`need`/`persona` fields, in write order:
  ```sql
  SELECT data FROM part WHERE session_id='<sid>';           -- filter type=tool, tool=todowrite
  ```
  This is the single most diagnostic artifact: door 1/2 outcomes are fully determined by
  the first list's shape (verbs, statuses, file names, typing).
- **Persisted slice meta** — what actually survived the round-trip:
  ```sql
  SELECT content, status, slice_meta FROM todo WHERE session_id='<sid>' ORDER BY position;
  ```
- **Judge / rung evidence** — grep all parts (root + children) for `judge`, `MISSING:`,
  `rmRung`, `sliceType` markers.

## Reverse-engineering checklist (why didn't the door open?)

Walk it in order; each is a divergence we have actually observed:

1. **Was todowrite called at all?** If not: the conductor answered inline. Not a routing
   bug — the task was too small/easy for decomposition, or the prompt didn't force a
   checklist. (run-22 T3; case 3 attempt A.)
2. **When was it called?** If the first list arrives with items already
   `completed`/`in_progress`, it's a retroactive progress log, not a plan — every
   pending-item guard correctly sees nothing. (case 1 attempt A: list written AFTER the
   fix, item pre-completed.)
3. **Were the trigger items `pending`?** The bug-shape guard needs a *pending* item
   opening with a repair verb. Flash marks the item it is starting `in_progress` in the
   same todowrite — a one-item list never has a pending trigger. (case 1 attempt B.)
4. **Did any active item name a file?** A file target = "localization already happened"
   → diagnosis pre-pass correctly suppressed. Note the conductor usually explores before
   writing todos, so its items often carry file names it just found.
5. **Did the items carry the right keywords?** Judgment typing needs
   audit/verdict/soundness/residual-risk/edge-cases/posture/coherence/sign-off in the
   item text; build verbs at the start of any active item switch the list to the build
   branch where only the pre-pass can fire.
6. **What did the probes return?** Testable ⇒ executor (clamped — a need hint cannot
   raise it). Coupling high needs graph score ≥ 50 AND a ready index: the probe races
   the index with a short budget and falls back to LOW on timeout — slices dispatched in
   the first seconds of a fresh arena session will read coupling=low spuriously (case 3
   attempt B: todowrite at step 1, cold index, reasoner instead of oracle+judge).
7. **Did verification pick the rung you expected?** sound (testable) / judge
   (untestable·high-coupling, or untestable·risk>tiebreak) / qe (the rest). No judge
   rung ⇒ no judge sampler, by design.
8. **Ladder silent?** The ladder only climbs on a *failed* slice attempt (red sound
   check, judge reject with `MISSING:` objective). A green-but-wrong slice never climbs —
   that is what the judge rung exists for.

## The five canonical cases

Status ledger from the 2026-07-06 live-fire series (binary 0.0.0-main-202607060605, all
cost paths verified ratio 1.00 in every run):

### Case 1 — symptom-only bug, big unfamiliar repo → door 1 (diagnosis pre-pass → oracle)

- **Arena:** django @ `fc2b1cc926` (parent of `dbcd7b064e`, the upstream
  `Choices.__str__` fix — the SWE-bench django-11964 shape).
- **Prompt:** behavior-only description of the TextChoices getter bug; **zero file
  names**; "find the root cause and fix it"; no test-file edits.
- **Expected:** first todo list is bug-shaped with no file target → localization design
  slice appended → oracle (researcher persona, read-only) localizes to
  `django/db/models/enums.py` before any edit.
- **Observed (2026-07-06, 2 attempts, binary 202607060605): door did NOT open.** Both
  attempts mis-localized exactly like the SWE-bench failures — attempt A patched
  `DeferredAttribute.__set__` (`query_utils.py`, 38 steps, $0.065), attempt B patched
  `get_default()` (`fields/__init__.py`, 28 steps, $0.057). Divergence causes:
  checklist items 2 and 3 above — flash explores ~20 steps, localizes in its head,
  then writes todos as a retro log (A) or as a single already-in_progress item (B).
  The pre-pass's trigger point (todowrite) sits downstream of the decision it was
  built to front-run. Executor fired only via voluntary side-task children
  (runner/explorer, ~$0.003).
- **Observed (2026-07-07 tierfire3, binary 202607062255): door OPENED — PASS.** The
  turn-open triage hook (U1) moved the trigger to prompt receipt, plus two same-day
  fixes: a tightened triage rubric (naming the misbehaving class/API does NOT ground a
  diagnosis) and the structural round-up net `roundUpTriageShapes`
  (slice-orchestrator.ts) — a diagnosis-grounded goal in a prompt naming no code-file
  target rounds up to diagnosis-vague. The net is load-bearing: the extractor misread
  the entity-name-only prompt in BOTH attempts and the net caught it both times
  (`triage_rounded_up` marker). Attempt B (original prompt): planner prepass → oracle
  ranked 4 candidate layers *including* `enums.py` but rejected it citing the prompt's
  own "behaves exactly like a retrieved instance" (type parity the upstream `__str__`
  fix doesn't provide) and patched `DeferredAttribute.__set__` — scored as a
  case-prompt mis-transcription of django-11964, not an engine miss; prompt corrected
  to the real str()-parity ask (`case1-t2.txt`). Attempt C (corrected prompt):
  localization slice → oracle named `django/db/models/enums.py` as the sole defect
  site before any edit; conductor verified the target and made ONE edit,
  byte-equivalent to upstream `dbcd7b064e`; no test files touched (gate armed from
  triage constraint); 411 `runtests.py` tests (python3.12) show zero regressions vs
  pristine baseline. 24 turns, $0.0808, 8 oracle turns (82% of spend, 36% of tokens),
  0 escalations, cache 78.5%.
- **Verdict:** door 1 proven end-to-end. Minor observations: attempt C's inline
  verification missed the system python3.12 that attempt B had found (behavioral
  asserts only; suite confirmed post-hoc by the harness), and the root goal todo was
  left pending at run end despite the delivered fix.

### Case 2 — multi-dimension audit of a subtly-unsound fix → door 2 (judgment typing → reasoner)

- **Arena:** zod @ `23edf484` + planted working-tree fix `checks: a._zod.def.checks`
  (keeps the receiver's refinements, silently drops `b`'s — the run-19/20 unsound shape;
  full suite stays green).
- **Prompt:** review-gate framing, four dimensions (soundness / edge cases / full suite /
  deprecation posture) + final verdict; "do not rewrite their fix".
- **Expected:** audit-shaped list → judgment items `verify+need:reasoner`, suite item →
  executor runner, oracle synthesis; the audit catches the dropped-`b` flaw.
- **Observed: door OPENED, full chain.** 5-item list written up front (item 1
  in_progress → conductor kept soundness inline; items 2–5 pending → typed). 3 reasoner
  slices ($0.33/$0.28/$0.27, 11–13 steps each — below the 25-tool cap this time), runner
  $0.0016, oracle synthesis $0.07; total **$0.99**. Verdict: "DO NOT SHIP — fix is
  unsound (partial)" with live repro evidence per operand, the observation that a green
  suite proves nothing (zero merge+refinement coverage), and the exact correct fix
  (concatenate both operands' checks). Session `ses_0c9b4395bffecT3ozWLU3F0Lvl`.
- **Verdict:** the judgment door works and pays for itself — this planted flaw shipped
  clean past the suite and was caught only here. No judge rung (slices named no files →
  untestable·low-coupling → qe): correct per matrix.

### Case 3 — audit naming untested + tangled files → door 3 (oracle residual + judge sampler)

- **Arena:** express @ `66878d3` — probe-blind by construction: plain JS (no type
  coverage), no build/typecheck script (no compile target), and the whole mocha suite
  uses `test/res.send.js`-style names the `*.test.*`/`*.spec.*` glob never sees →
  every `lib/*.js` file reads **untestable**; `lib/response.js` is the repo's fan-in hub.
- **Prompt:** proposal audit (design review of a res.status clamp change — no diff, no
  build items), each dimension a separate sign-off item, dimensions naming
  `lib/response.js` / `lib/application.js` / `lib/express.js`.
- **Observed attempt A: no todowrite** — 6-file lib, easy audit, answered inline in 7
  steps ($0.0092). Checklist item 1. Fixed by adding the explicit "one checklist item
  per dimension" instruction (legitimate: this case tests the allocation cell, not
  decomposition propensity — case 1 owns that finding).
- **Observed attempt B: chain opened, wrong cell.** Instant todowrite (step 1!) → 3
  reasoner slices + runner + oracle synthesis, $0.57 — but tier came from the
  `need:reasoner` raise off the *executor* floor, i.e. coupling read **low**, and no
  judge anywhere. Checklist item 6: dimensions 3/5 named no files, and the step-1
  dispatch raced a cold graph index (probe falls back LOW on timeout).
- **Observed attempt C: chain opened again ($0.85, 3 reasoner + runner + oracle
  synthesis + one re-engagement), STILL reasoner, zero judge markers** — with a warm
  index and `lib/application.js`/`lib/express.js` named in the slice text. The graph DB
  (`~/.local/share/opencode/graph/<hash>/graph.db`) gives the definitive cause: **55
  entities in the whole repo, 2 in `lib/response.js`** (`sendfile`, `stringify` — the
  only classic `function` declarations). Express defines its API as prototype
  assignments (`res.send = function send(...)`) and the indexer extracts no entities
  from assignment-style definitions, so the repo's real fan-in hub scores ~0 and
  coupling can never clear 50. Sibling of the run-19 probe finding (method→helper
  indirection unedged). Anomaly on this attempt worth watching for recurrence: the
  binary idled ~56 min between launch and session start (no retry noise in stderr;
  instant once the banner appeared).
- **Verdict:** the reasoner door is triple-proven on this shape; the
  oracle-residual + judge cell is **blocked by an indexer visibility gap, not by the
  allocation logic** — on classic prototype-assignment JS (express/connect-era idiom)
  the coupling probe is starved of entities. Engine follow-up: index assignment-style
  method definitions. A future attempt should use a probe-untestable repo whose hot
  file uses declaration-style functions/classes.

### Case 4 — trap fix that breaks a real test → door 4 (escalation ladder)

- **Arena:** zod @ `23edf484` + planted "receiver-wins" merge fix (shape spread
  a-over-b, catchall from `a`, checks from `a`) — deterministically fails
  `object.test.ts:406` (`catchall … toBeInstanceOf($ZodNever)`), verified red before
  the run (1 failed / 101 passed in the object tests).
- **Prompt:** same review-gate shape as case 2 with the full-suite dimension FIRST and
  per-dimension checklist items.
- **Expected:** suite runner slice hits the red test → sound rung fails → escalation
  ladder retries the slice one tier up (reasoner; oracle if it fails again) → double-pay
  ledger entry in the receipt — the only door that bills double-pay.
- **Observed attempt A ($1.21): audit flawless, ladder silent.** All three planted
  inversions caught (runtime probe proved the type/runtime divergence), red gate
  correctly reported, DO-NOT-SHIP verdict. But the suite dimension was FIRST, so flash
  marked it `in_progress` in the same todowrite → never typed → the conductor ran the
  suite inline and no runner slice existed to fail. Checklist item 3, tripped from the
  wanted-dispatch direction: **never put the item you want dispatched first.**
- **Observed attempt B ($0.84, suite as dimension 3): runner slice dispatched, met the
  red suite, reported it accurately — and PASSED its ladder. 0 escalations, $0 double-pay.**
  Root cause is structural, confirmed in code: the sound rung runs `slice.verifyCommands`
  (slice-loop.ts:310) and **the live path never populates verifyCommands** —
  todosToLoopSlices carries no command spec, so `runSoundCheck` short-circuits on every
  real slice and a "run the tests" slice *succeeds by reporting red* (QE sees a
  self-consistent report; green was never its success criterion). The ladder
  (escalateTier: executor→conductor→reasoner→oracle) is real and unit-tested but can
  only climb on a rung reject, and with sound always empty and judge gated on the
  judge cell, live rejects are near-impossible.
- **Verdict: door 4 is structurally unreachable on the live path today.** Engine
  follow-up: derive verifyCommands for verify-shaped slices (the item text names the
  suite command in every observed run), or make a red check-run result fail the slice.
  Same-arena relaunch anomaly recurred here (attempt B wedged pre-session for 20+ min
  and was killed; fresh-clone relaunch started instantly and finished in ~6 min) — now
  a reproducible pattern: cases 3C and 4B, both quick relaunches into a just-used arena.

### Case 5 — "build feature X" in an untested corner → door 5 (reasoner authors the edit)

- **Arena:** express (probe-untestable everywhere); prompt: implement a small new
  low-coupling module (no design slice preceding, nothing wired).
- **Expected per code reading:** this cell
  (low-coupling·untestable·mechanical·spec-unbacked → reasoner) is reachable **only if
  the conductor self-types a mechanical slice** — `autoTypeTodos` never types plain
  build lists, and runs 19–22 show flash essentially never fills `sliceType` on its own.
  The honest hypothesis going in: **the cell is structurally unreachable today**, and
  the run exists to confirm or refute that. A confirmed-unreachable cell is the finding.
- **Observed: hypothesis confirmed.** The conductor wrote a proper plan-first 3-item
  list (1 in_progress + 2 pending — so pending items DO exist on build tasks; the
  retro-log behavior of case 1 is specific to diagnosis tasks, where flash explores
  before planning) but typed zero items across all three todowrite calls. No dispatch,
  100% conductor, 8 steps, **$0.0063**, and a perfectly fine standalone module built
  inline. The reasoner-authors cell never had a chance.
- **Verdict: unreachable live, confirmed.** The cell activates only via conductor
  self-typing (never observed in 20+ runs) or a future structural net for build lists.

## Series scoreboard (2026-07-06)

| door | target tier | status | blocker (if closed) |
|---|---|---|---|
| 1. diagnosis pre-pass | oracle (localization) | ✗ never fired (2 attempts) | trigger sits at todowrite, downstream of flash's explore-first localization; `pending`-only guard misses in_progress items |
| 2. judgment typing | reasoner (+ oracle synthesis) | ✓ **proven 4×** (cases 2, 3B, 3C, 4B) | — |
| 3. residual cell + judge | oracle (generation) + judge sampler | ✗ (3 attempts) | indexer extracts no entities from prototype-assignment JS → coupling starved; judge cell never allocates |
| 4. escalation ladder | reasoner/oracle rescue + double-pay | ✗ (2 attempts) | `verifyCommands` never populated on live slices → sound rung always short-circuits → no rung reject to climb on |
| 5. reasoner-authors | reasoner (mechanical) | ✗ confirmed unreachable | mechanical slices require conductor self-typing, never observed |

Executor side-doors (voluntary task-tool children + check-run slices) fired in every
decomposed run and cost fractions of a cent. Every run in the series decoded at
DB ≡ matrix ≡ receipt ratio 1.00. Series total ≈ $4.9 across 10 sessions.

The engine follow-ups, in leverage order: (1) populate `verifyCommands` on
verify-shaped slices — unblocks the ladder AND makes red suites slice-failures;
(2) move the diagnosis pre-pass trigger upstream of exploration (or relax the
pending-only guard) — unblocks oracle localization on the SWE-bench shape;
(3) index assignment-style method definitions — unblocks coupling on classic-idiom
JS and with it the judge cell.

The full categorization of every issue in this series (framework vs tier behavior,
with the benchmark failures folded in and the research-backed remediation plan) lives
in [failure-taxonomy.md](../design/failure-taxonomy.md); this doc stays the test
definitions + observed-trace record.

## Where results land

Per-run cost/step tables belong in [04-model-team.md](../features/04-model-team.md)
(runs 19–22 precedent); routing mechanism changes and their post-mortems in
[03-risk-router.md](../features/03-risk-router.md); this doc owns the test definitions,
the expected traces, and the divergence checklist. Update the Observed lines here as
attempts complete — this is the living record of which doors are proven.
