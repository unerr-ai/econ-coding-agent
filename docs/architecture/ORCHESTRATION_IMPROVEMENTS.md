# Orchestration improvements — working proposal

**Status: IMPLEMENTED except P11 (2026-07-10) — all Q-table recommendations accepted by
the user ("implement all"); landed wave by wave.** W1: **P6a/b/c + P7(b)** (core
`229a9303a`, wiring `5ce310868`), **P8, P9, P10, P12** (`229a9303a`, resolve-first
residual case `5ce310868`). W2: **P1-alt + P2a + P5** — the merged temp-0 turn-read,
code-decided arming, regex shadow taxonomy deleted (`48a3499ce`). W3: **P3 + P4** —
research/refactor shapes, no-edits gate, continuation turns (`e372a3c1d`). In progress:
**P11** (model-initiated tier delegation, W4). The accepted designs are folded into
[ORCHESTRATION_MECHANISM.md](./ORCHESTRATION_MECHANISM.md) — mechanism truth lives there;
this doc keeps the decision trail. Benchmark-driven tuning is logged in
[SWE_BENCH_TRACKER.md](../testing/SWE_BENCH_TRACKER.md).

Origin: user questions (2026-07-10) — (a) merge the turn-open LLM reads into one
temperature-0 call? (b) does the goal-shape taxonomy cover all real prompt styles
(research, web lookups, refactors)? Plus a web-research pass (§4.0, [sources](#sources)).

---

## The full journey of a prompt through econ (the round's opening audit)

Reference map as verified on 2026-07-10, **before** the waves landed — kept as the baseline
the proposals were judged against. Where a P-status below says IMPLEMENTED, the folded-in
current mechanism lives in [ORCHESTRATION_MECHANISM.md](./ORCHESTRATION_MECHANISM.md)
(notably: item 1's three reads are now ONE turn-read + a code table, and the regex shape
guess is deleted).

1. **Three reads + a risk probe** (turn open, `session/prompt.ts` ~1771). A free regex
   shape guess (`classifyTurnShape` — the fallback today; P5 proposes retiring it); one LLM extraction
   (`runTurnTriage`): up to 7 goals as verbatim quotes + constraints + confidence, low
   confidence re-runs once on the reasoner; one LLM judgment (`judgeArming`): do we know
   WHERE the fix goes, how hard, how ambiguous — fails over to `heuristicArming`. The graph
   risk probe (`probeTurnRisk`) un-mutes the conductor's thinking for plan steps; the lead
   model never swaps at turn open.
2. **Prompt assembly** (`session/llm/request.ts` + `session/prompts/`). Shared base + tier
   delta + tool block generated from the live tool list + repo instructions; the turn
   preamble (goals, constraints) rides the system tail so the cached prefix stays stable.
3. **Inline by default.** The conductor solves the turn itself unless one of three holds:
   real parallelism, work too big for one context (~6+ slices), or a risky change needing
   an isolated verify lane. Typing a todo (`sliceType`) is the explicit opt-in to
   orchestration; untyped todos are just a checklist.
4. **Gates before spend** (`runConductorOrchestration`, slice-orchestrator.ts:1838).
   Resolution gate on ambiguous/hard turns: decompose-now, resolve-first (gather facts,
   stand down), or ask-user. Then todos → dependency DAG (`todosToLoopSlices`), then the
   benefit gate (`shouldOrchestrate`) bails if orchestrating wouldn't pay.
5. **Two-axis allocation per slice** (`allocation.ts`). Generator tier ← difficulty
   (design → reasoner; mechanical+testable → executor; arming hardness sets a floor).
   Verifier rung ← consequence (testable → run the tests; high coupling/risk → cross-model
   judge). `evaluate()` (evaluator.ts, five rules) can round down only when verification is
   strong AND containment exists; hysteresis stops tier ping-pong. Tiers become models only
   in `model-registry.ts`.
6. **Slices run as interns.** Executor slices get a persona (explorer/runner/applier/
   author/researcher/procedure) with reduced tools and a zero-context brief; a step-budget
   watchdog caps runaways; a shadow-git snapshot auto-reverts rejected work.
7. **Failure path.** Retry same tier ×2 (squeeze) → climb exactly one rung, only if
   critical (`slice-loop.ts`) → suspicious-green gets a second opinion → coverage gaps
   trigger a bounded re-plan seed. A stuck supervisor nudges the conductor's own inline
   loops (repeated red, test-edit, re-reading).
8. **Close.** Outcomes settle todos (stragglers swept to failed); a synthesis hop compiles
   slice digests; the M4 prove-it gate blocks a fix-shaped turn from concluding while its
   pinned reproduction is still red or a guarded test was edited.

What fires per prompt type:

| Prompt | Fires | Skipped |
|---|---|---|
| Code question | triage → `qa`; answer inline | slices, ladder, gates |
| Grounded trivial fix | arming: localized, no pre-pass; M4 probe gate | decomposition |
| Vague bug | arming arms → one localize-fix-verify writer slice | blanket reasoner pin (difficulty decides) |
| Compound build | skeleton per goal → typed DAG → parallel waves → synthesis | — |
| Ambiguous compound | low-confidence triage → reasoner re-run; resolution gate: resolve-first or ask-user | blind spend |

---

## 0. Principles we judge proposals by

1. **Semantics in the LLM, policy in code.** Small models read well and apply rule tables
   badly. A decision expressible as a pure function over extracted evidence belongs in
   code: deterministic, table-testable, auditable.
2. **One job per small-model call — but a round trip is also a cost.** Single-job prompts
   were deliberate discipline; merging trades interference risk against a network round
   trip and a duplicate prompt ingestion. The rig measures this trade; intuition doesn't.
3. **Degrade-open means the turn proceeds — not that a shadow implementation impersonates
   the LLM.** A wrong heuristic guess steers the conductor worse than no guess. Prefer
   redundancy on a *different failure domain* (a cross-tier re-ask) and then neutral
   degrade (no steering) over maintaining a parallel heuristic taxonomy. (Rewritten by P5;
   originally "every LLM read keeps a free fallback".)
4. **A taxonomy class must change policy.** New shapes earn their place only if the
   playbook/casting/verifier differs AND the class boundary is crisp — fuzzy classes tax
   extraction accuracy on every class.
5. **Determinism claims stay honest.** Temp 0 shrinks variance; batched inference and MoE
   routing still jitter. Validators and retries stay regardless.

---

## 1. Turn-open facts the proposals change

> Baseline of 2026-07-10, since replaced: P1-alt/P2a/P5 (W2, `48a3499ce`) collapsed reads
> #1–#3 into one temperature-0 turn-read with no regex fallback.

| # | Read | Produces | Cost / latency | Fallback |
|---|------|----------|----------------|----------|
| 1 | `classifyTurnShape` (regex) | heuristic shape | free | — (is the fallback) |
| 2 | `runTurnTriage` — LLM #1, conductor | goals + constraints + confidence | ~1.9 s med / 7.7 s max, 10 s cap | 1 retry → regex shape |
| 3 | `judgeArming` — LLM #2, conductor | armLocalization, hardness, ambiguity | ~1.3 s med / 2.4 s max, 12 s cap | 1 retry → `heuristicArming` |
| 4 | `probeTurnRisk` + `planRaiseForTurn` | reasoning un-mute | in-process | risk 0 → no raise |

- Calls #2 and #3 are **sequential** (#3 consumes #2's verdict as advisory evidence) and
  **both re-send the same user prompt**. Stacked: ~3.2 s median; caps stack to 22 s.
- The arming judge has **one** production call site (prompt.ts:1826). The todowrite door
  reads the **stored** decision (arming-store.ts); `JudgeArmingInput.todos` is unwired.
- **Neither call sets `temperature`** (only the verifier judge and confidence probe are
  temp-0: prompt.ts:2205, 2432). Observed flake: identical prompts → goalCount 2/null/3.
- Escalation asymmetry: triage re-runs on the reasoner at low confidence; arming only
  degrades to the heuristic.

```
today:       prompt ─► regex (free) ─► triage LLM (~2s) ─► arming LLM (~1.3s) ─► turn
P1/P1-alt:   prompt ─► regex (free) ─► ONE turn-read LLM call (~2s, temp 0) ─► turn
P1+P5:       prompt ─► ONE turn-read call ─► [null? reasoner re-ask → neutral degrade] ─► turn
```

---

## 2. P1 — One merged "turn-read" call

> **Status: IMPLEMENTED as P1-alt (W2, `48a3499ce`).** One temp-0 conductor turn-read
> (`TURN_READ_SYSTEM_PROMPT`, `prompts/judges.ts`); arming decided in code (`decideArming`,
> `arming-judge.ts`); old triage/arming dispatches deleted, no shims; all rig rows
> reproduce from evidence + table.

Replace the two turn-open LLM calls with a single conductor-tier, forced-JSON, temp-0 call:

```json
{
  "goals":       [{"quote":"...","shape":"...","deliverable":"...","dependsOn":[0],"needsPlan":false}],
  "constraints": [{"quote":"...","kind":"..."}],
  "confidence":  "high",
  "arming":      {"armLocalization":true,"localized":false,"hardness":"moderate",
                  "ambiguity":"clear","evidence":"..."}
}
```

The system prompt keeps the jobs visibly sectioned (JOB 1 extract / JOB 2 judge) so the
single-job discipline survives as internal structure.

**Why it works:** same tier, same input, both forced-JSON — the merge removes one round
trip and one duplicate ingestion (~3.2 s → ~2 s median; 22 s worst-case → 12 s). JOB 2 reads
JOB 1's output in-context — fresher than today's relay, and the judge can no longer
contradict the extractor. The coupling is already proven: `heuristicArming` derives arming
*from* triage shapes.

**P1-alt (recommended) — extract evidence, decide in code.** Plain P1 still has the model
*apply* the arming rule table ("file named ⇒ localized unless hard…") — prose rules in
`ARMING_SYSTEM_PROMPT` that drift with prompt edits. Principle 1 says: the call extracts
facts per diagnosis goal — `locationNamed` (quote), `fixSpecified` (quote) — plus the two
genuinely judged fields (`hardness`, `ambiguity`). `armLocalization` becomes a pure
function (today's `heuristicArming` upgraded):
`arm = diagnosisShaped && !fixSpecified && (!locationNamed || hardness === "hard")`.
Misapplied rules (the django-12039 class) become structurally impossible; rig decision
tests become table tests; policy changes become code review. If a corpus nuance resists
extraction into a fact field, that's evidence it is genuine judgment — it stays LLM-side.

**Does NOT merge:** the regex fallback (stays until P5 retires it — §4c); the
low-confidence reasoner re-run (now covers both sections); any future todowrite-door
re-judge (different evidence, different timing).

**Validation semantics (Q-B):** validate as two independent sections — goals invalid →
regex shape; arming invalid → decision table over surviving goals. All-or-nothing would
make one call more fragile than two.

**Risks:** (1) task interference on a muted small model — the real risk, measurable
offline on the rig before any live wiring; (2) longer no-think output (~60 extra tokens) —
re-probe the 12 s cap; (3) the stub/rig recognize calls by marker (`prompts/judges.ts`) —
one new marker + rig update.

**Validation:** extend the arming rig (test/arming-rig/, corpus in
[PROMPT_SLICING_CORPUS.md](../testing/PROMPT_SLICING_CORPUS.md)): arming parity on every
row (0 new over-fires), goal parity, parse-fail rate ≤ today's two-call product, live
latency probe. Then live-fire per
[TIER_FIRING_CHECKLIST.md](../testing/TIER_FIRING_CHECKLIST.md).

**Done when:** one call at turn open; fallbacks, re-run, store, difficulty floor,
resolution gate, preamble byte-compatible on the corpus; old dispatches deleted (no shims).

---

## 3. P2 — Temperature 0 on the extraction call(s)

> **Status: P2a IMPLEMENTED (W2, `48a3499ce`)** — the merged turn-read dispatches at
> temperature 0. P2b (provider JSON mode) stays deferred per Q-F; the brace-matching
> extractor (`util/json-extract.ts`) remains.

Set `temperature: 0` on the turn-open extraction dispatch (both calls if P1 is rejected,
the merged call if accepted). Already the recorded open candidate after the goalCount
2/null/3 flake — sampling diversity has no value in a validator-gated extraction; every
flake costs a retry or silently degrades decomposition to the regex path.

- **P2a:** thread `temperature: 0` through the dispatch; verify the option survives the
  litellm → fireworks path (day-0-gate class check).
- **P2b (optional):** provider-side JSON mode if the gateway supports it on the conductor
  binding; the brace-matching extractor (`util/json-extract.ts`) stays regardless.

**Expectation (principle 5):** the flake shrinks substantially, not to zero — batching and
MoE routing still jitter. Validator + retry + fallback stay. If variance still hurts after
temp 0, the next dial is P1-alt (fewer judged fields), not more sampling knobs.

---

## 4. P3 — Upgrade the goal-shape taxonomy

> **Status: IMPLEMENTED (W3, `e372a3c1d`).** `research` + `refactor` shapes with their
> discriminators in the turn-read prompt (no regex keywords anywhere — P5 had already
> deleted the shadow taxonomy, so change-inventory item 4 never happened); `no-edits`
> constraint kind → a hard deny at the edit/write tool boundary; research turns auto-cast
> the researcher persona on recon slices and pin `testStrength:"untestable"` (citation
> check, no verify/probe); RESEARCH/REFACTOR playbooks in `triagePreamble`.

### 4.0 What the research says

Published taxonomies of what developers actually ask ([sources](#sources)):

- **Developer↔chat studies** (DevGPT; Hao et al. 2024, 580 real PR/issue conversations):
  16 inquiry types — code generation (20–27%), conceptual (14–18%), how-to (13–22%), issue
  resolving (12–14%), review, comprehension, documentation, translation, data
  generation/formatting/analysis, math, execution, prompt engineering, and more. Plus 7
  multi-turn roles, led by **iterative follow-up at 33–40% of all prompts**.
- **Production coding-agent traffic** (REAP 2026): a 17-category taxonomy **partitioned
  testable vs untestable** — testable: bug fix, feature request, refactoring, type fixes,
  build/lint fixes, dead-code removal; untestable: docs-only, code explanation, UI-only.
  Distribution: **refactoring and feature requests lead; no category exceeds 25%; bug
  fixes are a smaller share than issue-derived benchmarks imply.**
- **Anthropic Economic Index:** debugging ≈6%+6% of API usage; trend toward larger
  program-creation chunks.
- **Classic SE:** Swanson/ISO 14764 maintenance types; Treude et al. Q&A types; Barke et
  al.'s acceleration (clear goal) vs exploration (unsure) modes.

Three structural takeaways: REAP's testable/untestable split independently validates
econ's `testStrength` axis; Barke's two modes are econ's ambiguity axis; the biggest thing
econ does NOT model is the **follow-up turn** (→ P4).

Mapping — universe category → econ today → verdict:

| Universe category (source) | econ today | Verdict |
|---|---|---|
| Bug fix / debugging (REAP, C4, AEI) | `diagnosis-vague/grounded` | Covered. |
| Feature / code generation (REAP, C1) | `build` | Covered. |
| **Refactoring, dead-code removal, type fixes (REAP — leading production category)** | `build` (mislabeled) | **Admit `refactor`** (below). |
| Build/lint/environment fixes (REAP) | `diagnosis-*` | Covered — the probe machinery pins the failing build command like a failing test; add corpus rows, no new shape. |
| Docs-only (REAP, C8) | `build` | Covered as a shape; flags an allocation nuance — "unbacked mechanical untestable → reasoner" over-prices docs slices. Note as follow-up observation. |
| Explain / conceptual / how-to (C2, C3, C6) | `qa` | Covered. |
| Review / preventive (C5; Swanson) | `audit` | Covered. |
| External research / lookup | — | **Admit `research`** (below). |
| Execute-and-report (C15) | `run-only` | Covered. |
| UI-only (REAP) | `build` | Covered; visual verification out of scope this round. |
| Data formatting / translation / math (C7, C10–C12, C16) | `build`/`run-only` | Out of scope as shapes — chat-era categories with no policy delta. |
| Plan/design-only | — | `no-edits` **constraint**, not a shape (below). |
| **Follow-up / refinement / feedback turns (M1+M3+M6+M7 ≈ half of multi-turn prompts)** | not modeled | **P4** (below). |

**Deliverable vs sub-step:** a shape labels the *deliverable*, not the activities.
"Research which lib to use" needs a shape; "fix the bug" that requires reading docs
mid-flight is still a diagnosis turn — the conductor already spawns a `researcher`
side-task for that (rule 3). Only deliverable-level gaps justify shapes.

### 4.1 Proposed changes

- **`research` — admit.** Deliverable = externally sourced knowledge (docs, changelogs,
  web), not a repo change. Crisp boundary with `qa`: answerable from this repo's code vs
  needs external sources. Policy: playbook = cited digest, fan out parallel `researcher`
  slices when questions are independent; auto-cast the `researcher` persona (shape-scoped
  reversal of the explicit-only rule — Q-D); verifier = citation check, never the test
  rung; arming N/A; heuristic mapping = stand down.
- **`refactor` — admit (upgraded 2026-07-10 from HOLD by the research pass).** First
  draft held it on boundary-fuzziness; REAP showing refactoring as a *leading* production
  category changed the cost-benefit — mislabeling it as `build` systematically misprices
  one of the most common turn types. Policy: done-when = suite green + no public-signature
  breaks (the governance gate is the natural in-loop verifier); slices default
  `mechanical` (executor-priced; the suite is the safety net); arming N/A. Fuzziness is
  handled, not ignored: one crisp discriminator in the extraction prompt — *adds behavior
  (build) vs restructures without changing behavior (refactor)* — compound prompts carry
  both goals separately, and corpus rows land first so confusion is measured (rollback if
  the extractor can't hold the boundary).
- **`plan-only` — NOT a shape; it's a constraint.** "Propose, don't code" is a
  build/diagnosis goal with an edit prohibition. Add a `no-edits` **constraint kind** — the
  constraint axis already arms hard gates (`no-test-edit`, `no-new-files`) and composes:
  "plan the migration, don't code it" = `build` + `no-edits` + `needsPlan`. (Corrects this
  doc's own first draft.)

### 4.2 Change inventory

1. `turn-triage.ts` — shape union + set; constraint kind enum for `no-edits`.
2. `prompts/judges.ts` — shape definitions in `TRIAGE_SYSTEM_PROMPT`; `ARMING_SYSTEM_PROMPT`
   SCOPE line (shapes localization does not apply to).
3. `prompts/preambles.ts` — one ≤4-line playbook per new shape; align the regex-fallback
   enum (`run-only` is missing from `CATEGORY_PREAMBLE` today).
4. `slice-orchestrator.ts` — skeleton shape→seed mapping, `autoTypeTodos` casting;
   `classifyTurnShape` keywords ONLY if P5 is rejected (Q-I decides before P3 starts).
5. `arming-judge.ts` — `heuristicArming` mapping.
6. `evaluator.ts` — `DECISION_SHAPED_TRIAGE_SHAPES` membership (research: no).
7. `prompts/roles.ts` — rule 2b if research auto-casts the researcher persona.
8. `prompt.ts` — gate-arming for `no-edits` (same seam as the no-test-edit gate).
9. Tests + rig corpus rows per addition
   ([PROMPT_SLICING_CORPUS.md](../testing/PROMPT_SLICING_CORPUS.md)).

---

## 4b. P4 — Model the follow-up turn (research-driven)

> **Status: IMPLEMENTED (W3, `e372a3c1d`).** `TurnRole` fresh|continuation on the verdict
> (zero goals valid only on continuations); pre-LLM short-circuit for short code-free acks
> on sessions with prior turns; a continuation inherits the stored verdict/preamble/arming
> decision/M4 pin (`turn-read-store.ts`) and stands down the resolution gate, skeleton
> reseed, and P10 reset; `turnContinuations` telemetry. Proposal piece 2 (feed the judge
> session state via `JudgeArmingInput.todos`) was mooted by P1-alt — the judge LLM call no
> longer exists; the no-re-arm rule holds through inheritance + the settled-seed dedup
> instead, validated on the continuation rig rows.

**Finding:** continuation-style prompts (follow-up, refinement, feedback, clarification)
are half or more of real multi-turn traffic. econ treats every root message as a fresh
turn: triage re-extracts from the new text alone, arming re-judges, the skeleton considers
reseeding.

**What happens today:**

- *"go ahead"* — no extractable goals → triage null → an LLM call (plus retry) burned →
  regex fallback. Harmless, wasteful, every time.
- *"still broken"* — may re-extract as fresh `diagnosis-vague` → the judge may **re-arm a
  localization pre-pass even though the session already localized the bug** — it never
  sees prior arming or settled todos (its todo channel is unwired).
- *"now also handle the empty case"* — genuine new work; fresh triage is correct. Any
  follow-up handling must not swallow this.

**Proposal (two pieces):**

1. **Recognize continuations cheaply** — a `follow-up` outcome in the turn-read call
   (post-P1), or a pre-LLM short-circuit (short prompt, no extractable goals, anaphora).
   On continuation: skip the skeleton reseed, inherit the stored arming decision
   (arming-store.ts already persists it), stand the resolution gate down.
2. **Give the judge session state** for non-trivial follow-ups: pass existing todos +
   prior arming as advisory evidence (`JudgeArmingInput.todos` exists, unwired). Decision-
   table rule: a re-fired diagnosis with a settled localization slice does NOT re-arm — it
   routes to re-verify.

**Why P4, not a P3 shape:** follow-up is a turn *role*, orthogonal to deliverable shapes
(the research keeps the M-series and C-series as separate axes; a follow-up can continue a
build, a diagnosis, or a research turn).

**Change inventory:** turn-read schema, prompt.ts turn-open short-circuit + inherit path,
`buildArmingUser` todos wiring, decision-table rule, corpus rows for the three cases,
telemetry (continuation rate — checks the 33–40% literature number on econ's own traffic).

---

## 4c. P5 — Retire the regex shadow taxonomy (user-driven, steelmanned)

> **Status: IMPLEMENTED (W2, `48a3499ce`)** — executed WITH P1-alt rather than after it
> (one rewrite instead of two): cross-tier reasoner re-ask on null, neutral degrade
> (nothing planted), `classifyTurnShape`/`CATEGORY_PREAMBLE`/`categoryPreamble`/legacy
> null-seed block/`triage_vs_heuristic` all deleted (24+ symbols, net −440 lines);
> M4 probe-gate arming re-homed onto the verdict's diagnosis goals; the
> `turnReadNulls`/`turnReads` counter landed in the same commit — the <2% acceptance gate
> is measured in the benchmark phase, not pre-landing.

**The user's argument:** if the conductor tier / LLM infra is down, the whole app is down —
a regex fallback that only matters then is pointless complexity.

**The correction that makes it stronger:** the fallback's dominant firing mode today is
NOT infra-down. `runTurnTriage` nulls on (a) extraction flake on healthy infra (the
observed 2/null/3 goal nondeterminism), (b) timeout on a slow-but-alive gateway (10 s cap;
the main turn has no such cap), (c) a transient error on that one call. In all three the
turn proceeds fine — so the regex fires regularly and removing it *today* would leave real
turns shapeless daily. The honest case for removal is different and better:

1. **A wrong guess steers worse than no guess.** The regex produces a *possibly-wrong
   shape*; a mis-guessed preamble ("a localization pre-pass frames this turn" on a build
   prompt) actively misleads the conductor. Neutral (no preamble, no skeleton) is safer.
2. **It is a shadow taxonomy with a permanent alignment tax.** Its enum has already
   drifted (`run-only` missing from `CATEGORY_PREAMBLE`), and every P3 shape would need
   mirrored regex keywords forever.
3. **Real redundancy for "the conductor misbehaves" is a different model family, not a
   regex.** The reasoner is a different provider/family — a genuinely independent failure
   domain. A cross-tier re-ask covers the case the user worries about far better.

**Proposal:**

1. **Cross-tier fallback:** turn-read null after its one same-tier retry → one re-ask on
   the reasoner (reuses the existing low-confidence re-run machinery, now also on null).
2. **Neutral degrade:** still null → the turn proceeds with NO preamble, NO skeleton, and
   arming stands down (`heuristicArming`'s no-verdict posture already does this). No
   guesses.
3. **Delete the shadow taxonomy:** `classifyTurnShape`, `CATEGORY_PREAMBLE` +
   `categoryPreamble`, the legacy null-path seed block (prompt.ts ~1882-1893), and the
   `triage_vs_heuristic` telemetry (superseded by the rig corpus + a null-rate counter).
4. **Re-home the two things the regex secretly powers:** M4 probe-gate arming (fix-shape
   detection) derives from the turn-read verdict (a diagnosis-shaped goal present) instead
   of the regex — turn-read failed ⇒ no probe gate that turn (slice rungs still verify);
   and the disagreement telemetry is replaced by a plain **null-rate counter** (nulls per
   100 turns), which is also P5's gate.
5. **Gate:** land only after P1+P2, when the measured null rate is low (proposed: <2% of
   turns after the cross-tier re-ask). The counter lands with P1 so the number exists.

**Interaction with P3:** decide P5 before implementing P3 — if P5 is accepted, P3 skips
adding regex keywords for the new shapes (change-inventory item 4 shrinks) instead of
adding patterns that P5 then deletes.

**Cost:** the rare double-flake path gains one reasoner call (~2 s). **Benefit:** an entire
parallel taxonomy and its alignment tax deleted; no more wrong-guess steering; the
fallback now actually covers a conductor-tier failure.

---

## 4d. P6 — Goal & slice relations: derive, don't extract

> **Status: IMPLEMENTED (W1 core `229a9303a`, opencode wiring `5ce310868`).** P6a blocked
> state (cascading, settles todos `cancelled`, feeds re-decomposition per Q-J); P6b
> `serializeOverlappingScopes` (fixpoint, add-only, read-only exempt); P6c venue inputs
> live (`editScopeOf` from `extractSliceFiles`, `requestingTier` "conductor").

**What exists:** goal-level `dependsOn` (triage) orders the skeleton; slice-level `deps`
build the DAG (`planWaves`: parallel within a wave, series across); dependents receive
upstream outputs inline (`withUpstreamContext`).

**Verified gaps (2026-07-10):**

1. **No dep-failure propagation** (`slice-loop.ts:1224-1231`): every wave dispatches
   regardless of earlier failures — a terminally-failed slice's dependents still run at
   full cost, "building on" a failure note against a reverted tree.
2. **File-disjointness is prompt discipline only.** Nothing checks that "independent"
   slices touch disjoint files before running them concurrently; the evaluator's venue
   input `sameFilesInScope` is hardcoded `false` (`slice-loop.ts:915`) — rule 4 is starved.
3. No alternative/mutually-exclusive relation — **keep it that way**: rare in dev prompts,
   an extraction field would tax every extraction (principle 4), and choosing between
   alternatives is genuine conductor judgment.

**Proposal (extends principle 1 — relations you can compute are never asked for):**

- **P6a — dep-failure policy.** In `runWaves`: a dep that ends terminal-failed marks its
  dependents `blocked` — not dispatched, surfaced in outcomes/todos as blocked-by, folded
  into re-decomposition input. Pure code; the cheapest cost win in this round (an entire
  dependent chain of a failed slice becomes free).
- **P6b — graph-predicted edit-scope overlap.** Before waves, probe each editing slice's
  predicted file scope (the graph layer already powers coupling probes); two same-wave
  slices with overlapping scope get an implicit dep (serialize) instead of concurrent
  same-file edits. Read-only slices exempt. One-directional by design: overlap only ever
  ADDS ordering — a declared dep is never dropped on disjoint scope, because deps carry
  information flow (`withUpstreamContext` feeds upstream output into the dependent's
  brief), not just file ordering. Parallelism itself already exists: same-wave slices
  dispatch via `Promise.all` (slice-loop.ts:1230); P6b makes the "no overlap" premise a
  computed fact instead of prompt discipline.
- **P6c — un-starve the venue input.** The same scope signal feeds `sameFilesInScope` in
  `buildEvalContext`, activating the evaluator's inline-vs-child affinity rule as designed.

**Change inventory:** `slice-loop.ts` (runWaves blocked-state, buildEvalContext),
`graph-tools.ts` (scope probe), `slice-orchestrator.ts` (blocked → todo status + re-decomposition
signal), outcome/telemetry types, rig/unit rows (blocked chain, overlap serialization).

---

## 4e. Stages 4–8 audit — what checked out clean (2026-07-10)

Verified against code the same day; recorded so the round shows its negative results too.

- **Stage 4 (gates).** The earlier-recorded trap — resolution gate re-resolving even when
  a valid todo plan exists — is **fixed**: `requireNodeFields: false` is threaded at the
  call site (slice-orchestrator.ts:1786) and `resolutionDecision` honors it
  (resolution-phase.ts). Benefit gate confirmed (slice-orchestrator.ts:1583): orchestrate
  iff ≥6 slices, any reasoner+ slice, ≥2 goals, or any parallel wave.
- **Stage 7 (failure path) is in good shape.** Squeeze is convergence-gated
  (`SAME_TIER_RETRY_BUDGET` 2/tier, reset per climb; a stalled squeeze forces the climb);
  read-only slices get 1 attempt, no ladder; the escalation brief (slice-loop.ts:541)
  carries the prior attempt's digest, an "already read" file list, and the reverted diff
  labeled as failed-approach context — the rescue doesn't re-pay recon. Loop wall-clock
  budget fails loud. Remaining known gap is external: the posterior second opinion runs on
  verbalized confidence because gateway logprobs are blocked (#62) — no proposal, waiting
  on infra.

Four real gaps found → P7–P10 below.

---

## 4f. P7 — Venue verdict: consume it or call it telemetry

> **Status: option (b) IMPLEMENTED (W1, `229a9303a`/`5ce310868`)** — P6c un-starved the
> inputs; the verdict is now honest telemetry that will prove or kill per-slice inline
> execution with data (Q-K).

**Verified:** the evaluator's rule 4 decides `inline|child` per slice
(evaluator.ts:154–172, two live inline branches: same-tier+same-files, small same-tier
batch) — but the only consumer is the `onEvaluation` telemetry callback
(slice-loop.ts:632, 947). **Dispatch always spawns a child.** The real inline decision is
upstream and coarse: `autoTypeTodos` stands down on small typed-candidate sets
(slice-orchestrator.ts:1336) so the whole batch stays untyped and the conductor works
inline. The rule's inputs are also starved: `sameFilesInScope` hardcoded false,
`requestingTier` hardcoded "conductor" (slice-loop.ts:913–917) — so "tier differs → child"
fires for nearly every slice regardless.

Same disease as the deleted cache rule (U5): a rule whose inputs/outputs aren't wired.
Options:

- **(a) Build per-slice inline execution** — run a venue-inline slice on the parent
  thread. True to the affinity design (mechanism doc §4.2), but a new execution path:
  the biggest diff for the least-proven benefit (the coarse stand-down already captures
  small batches wholesale).
- **(b) Fold into P6 (recommended).** P6c feeds `sameFilesInScope` from the scope probe;
  pass the real requesting tier. The verdict becomes *honest telemetry* that measures how
  often inline would have fired — evidence to justify (a) later, or to delete the rule
  (U5 precedent) if it stays near-zero.
- **(c) Delete rule 4 now.** Premature — unlike the cache rule, its inputs are one P6c
  diff away from being real.

---

## 4g. P8 — Difficulty-aware step budgets

> **Status: IMPLEMENTED (W1, `229a9303a`).** `sliceStepBudget(persona, sliceId, opts)` —
> `ceil(base × 1.5)` when `sliceType === "design"`, the turn's arming hardness is `hard`,
> or the dispatch is an escalated rescue (Q-L: both). Table-tested.

**Verified:** slice step budgets key on **persona only** (slice-orchestrator.ts:257 —
explorer 30, runner 25, applier 45, author 45, researcher 15, procedure 60; call site
prompt.ts:2349). Difficulty, tier, and escalation don't move them. Escalated rescues get
×1.5 **wall-clock** (`ESCALATION_TIMEOUT_FACTOR`) but the same step cap as the failed
attempt.

**Why it bites:** exhaustion isn't graceful — the `[BUDGET EXHAUSTED]` digest fails
verification, and the ladder double-pays a full retry or climb. The code already documents
the failure mode: the localization pre-pass at 15 steps "burned out with NOTHING
delivered" in live fire and was raised to 45 (`FRAME_SLICE_STEP_BUDGET` comment). Paying
+50% steps up front on the hard tail is cheaper than paying a whole rescue attempt.

**Proposal:** `sliceStepBudget(persona, sliceId, opts)` — `ceil(budget × 1.5)` when the
slice's allocation difficulty is design/hard **or** the dispatch is an escalated rescue.
Pure code, table-testable; telemetry counts exhaustion-then-fail before/after.

---

## 4h. P9 — Synthesis tier follows the synthesis job, not the max tier touched

> **Status: IMPLEMENTED (W1, `229a9303a`).** Synthesis defaults to the reasoner; the
> oracle fires only on mixed outcomes — an `unverified` or (since P6a) `blocked` slice
> among the done needing arbitration (Q-M). `synthesis_dispatched` logs the tier.

**Verified:** the closing synthesis hop runs on **oracle if any slice touched oracle,
else reasoner** (prompt.ts:2617–2620), over per-slice digests capped at 1500 chars.

**Why that's the wrong axis:** the synthesis prompt is faithful assembly — "cite the
concrete evidence… invent nothing beyond them". That's a writing job whose difficulty
doesn't change because one slice escalated; the oracle's insight is already captured in
its own digest. One escalated slice makes the entire closing hop (all digests + prompt)
pay oracle rates — the same category error the two-axis split removed from allocation
(generator ← difficulty, not ← who-was-involved).

**Proposal:** default the synthesis hop to **reasoner always**. Escalate to oracle only
when the synthesis is genuinely judgment work: mixed outcomes (some slices
failed/blocked among done) that need arbitration into one honest answer. Small diff, one
conditional; telemetry keeps `synthesisTier` so the receipt shows the saving.

---

## 4i. P10 — Resolution budget: bound the turn, not the session

> **Status: IMPLEMENTED (W1, `229a9303a`).** `resetResolveAttempts(sessionID)` at every
> FRESH turn open (per-turn reset only, Q-N); a continuation turn (P4, W3) skips the reset
> — the same task's recursion bound holds across the follow-up.

**Verified:** the resolve-attempts counter (resolution-store.ts) is keyed by sessionID
and "only ever grows" — no reset anywhere. `MAX_RESOLVE_ATTEMPTS` (2) exists to bound the
recursive resolve-then-recheck loop, but the loop it must bound is **per task**; the
counter's scope is the **session's lifetime**.

**Why it bites:** in a long interactive session, the first ambiguous turn that burns both
passes disables resolution for every later turn — a brand-new hard task on turn 12 goes
straight to "decompose-now, best-effort" with no resolution pass and no signal to the
user. Worse, re-decomposition (#55) shares the same counter, so one mid-turn re-plan also
drains the budget. The quality regression is invisible: nothing logs "resolution skipped,
budget spent three turns ago".

**Proposal:** reset the counter at turn open (a new user turn is a new task — the user
intervened, new information exists). Termination still holds: within one turn the
resolve→recheck→re-decompose recursion stays bounded at 2. One line at the turn-open
seam + a store `resetResolveAttempts(sessionID)`; unit row: two hard turns in one
session each get their own resolution pass.

---

## 4j. P11 — Model-initiated tier delegation (user-driven, 2026-07-10)

> **Status: IN PROGRESS (W4)** — the delegate tool is being built now.

**Framing — two orchestration levels** (the organizing idea behind P11):

| Level | Splits what | Who owns it | Exists today? |
|---|---|---|---|
| **Goal-level** | the user's prompt → goals → slice DAG → waves | **code** (triage extraction, gates, allocation, planWaves) | yes — econ's differentiator |
| **Intra-goal** | one slice's work → sub-tasks, discovered at runtime | **the model holding the slice** (Claude-Code-style sub-agents) | only for the conductor (`task` tool); blocked for children |

Same principle at both levels: the model names the work, code picks the tier. econ's
intra-goal version differs from Claude Code's in exactly the ways the mechanism doc calls
our differentiator: sub-agents get a **tier dial** (cheapest capable model, not
same-model), and every delegate runs **verified + contained + metered** (Claude Code
merges sub-agent work on trust).

**What exists (verified):** tier access is asymmetric across the three directions.

| Direction | Today |
|---|---|
| Conductor ↓ executor | **Exists twice**: allocation defaults mechanical+testable → executor; the always-on `task` tool defaults sub-agents to the executor tier (`tool/task.ts:375` — "never to whatever model the parent/lead" uses). |
| Conductor ↑ reasoner/oracle | Exists via ONE todowrite: a lone design todo allocates to the reasoner and alone passes `shouldOrchestrate` (any reasoner+ slice). Full safety stack rides along (evaluator, verify, ledger). No raw "consult" tool — deliberate (escalation must not be vibes). |
| Reasoner/oracle child ↓ executor | **Blocked**: `childSlicePermission` denies `task` unconditionally ("delegation is the conductor's job alone" — the star topology). Mechanical residue discovered mid-slice runs at the expensive tier or waits for post-slice re-decomposition. |

Also verified: the raw `task` tool spawns children **outside** the slice safety stack — no
verifier, no snapshot bracket, no double-pay ledger entry. Fine for read-only recon (its
dominant use); edit-work delegated that way is unverified.

**Proposal (keeps "semantics in LLM, policy in code" — the model names the work, code
picks the tier):**

- **P11a — upward stays gated; make it discoverable.** No new consult tool. One conductor
  doctrine line: "need higher judgment → type a design todo (dispatches a reasoner)".
- **P11b — high-tier seats become depth-1 sub-planners (Claude-Code-style sub-agents with
  a tier dial).** A reasoner/oracle slice that received a big item ("implement payment
  rails") plans it, then **delegates its own sub-items downward, case by case** — exactly
  the parent Agent-tool pattern, one level deep. Example: reasoner designs the rails →
  fires "billing migration", "webhook endpoint", "config wiring" to the executor (in
  parallel — independent, scope-checked within the parent slice's own file scope) and
  "review error-path copy" to the conductor → integrates the digests against its own
  design → returns one outcome.
  Guardrails: the child *describes* each sub-task, `allocateSlice`+`evaluate()` pick the
  tier (semantics in LLM, policy in code; a design-shaped request is refused — "that's
  your job"); **down-only** (below the caller's tier — executor or conductor from a
  reasoner); dispatch runs through the **slice pipeline** (persona, step budget, verify,
  snapshot, ledger), never raw spawn; delegates get no `delegate`/`task` tool (**depth 1**,
  no grandchildren); bounded per slice; sub-items recorded as child todos under the goal
  item that spawned them — written by the **tool handler**, not the model, and settled
  when the delegate's verification settles (the parent item completes only when its own
  slice does). Wiring caveat (verified): `parentID` is skeleton-only today — the
  todo→slice seam drops it (`todosToPlanNodes`: "parentId is always omitted") — so P11b
  must thread it through, or delegates render as a flat list instead of a tree.
  **This deliberately revises the star-topology decision** (mechanism doc: "sub-plans fold
  back through the hub"): the star guarded against judgment fragmentation and recursive
  sprawl — down-only + depth-1 + evaluator-gating keep both protections while removing the
  hub round-trip that idles the expensive tier and loses the designer as integrator.
  **Every tier delegates except the executor** (ladder `executor → conductor → reasoner →
  oracle`, slice-loop.ts:370): it is the floor (nothing below), and delegation IS
  decomposition — the skill the executor tier was measured to lack (the Q1 triage
  decision). Its path is report-up, not spawn-down: return with the oversized discovery
  declared → re-decomposition (#55) re-plans through the hub.
- **P11c — edit-capable raw-task hygiene.** The conductor's `task` tool stays for
  read-only recon; delegation that *edits* routes through slice dispatch (verify +
  snapshot + ledger), not raw spawn.

**Alternative considered:** hub-only (child finishes, declares follow-up items,
re-decomposition #55 reseeds) — already exists, preserves the star, but only fires
post-slice; a child needing the *result* of grunt work to continue is stuck, and the
expensive tier idles through a hub round-trip.

---

## 4k. P12 — A real plan seed for hard builds (corpus-audit finding, 2026-07-10)

> **Status: IMPLEMENTED (W1, `229a9303a`; resolve-first residual case `5ce310868`).**
> `PLAN_SLICE_CONTENT`/`PLAN_PREPASS_TODO` planted on the non-diagnosis `needsPlan` branch
> (and by the resolve-first pass when the turn isn't an armed diagnosis);
> `diagnosisPrepassSeed()` deleted; the rig gained the seed-kind column (wrong-seed
> scoring), Q-Q's seed-not-gate decision held.

**Verified:** the corpus doc promises a "PLANNER" pre-pass, but code has **one** frame
seed: `diagnosisPrepassSeed()` returns `LOCALIZATION_PREPASS_TODO` unconditionally, and
`buildTriageTodoSkeleton` plants it for BOTH armed diagnosis goals and `needsPlan`
non-diagnosis goals (`isDiagnosis ? arming.armLocalization : goal.needsPlan`,
slice-orchestrator.ts:1137). The seed text is hard-wired diagnosis language: "You OWN
this bug end to end… trace the failure path from symptom to CAUSE… RUN the
failing/pinned test." A hard build (`build-dark-mode`) receives a bug-hunt brief for a
feature with no bug and no failing test — the slice burns budget looking for a defect or
reports "cannot localize" as instructed. The arming rig can't see this: it scores "any
pre-pass armed" and only recognizes the localization content (seed-kind-blind), so all
PLANNER rows pass green. (The single-seed collapse itself is CORRECT for diagnosis turns
— the 12050 double-seed regression; P12 doesn't reopen it.)

**Proposal:** a second frame seed, `PLAN_SLICE_CONTENT` — forward-looking, edit-free,
shaped like the re-plan seed but for fresh work: "produce the implementation plan as a
DAG of typed slices (content, sliceType, need, deps) for the conductor to dispatch; no
code." Planted only on the non-diagnosis `needsPlan` branch; sliceType `design`, so
allocation floors it to the reasoner with no special-casing. Content distinct from both
existing seeds (the dedup-by-content rule). `FRAME_SEED_CONTENTS` gains it (rewrite
protection); the rig gains a seed-kind assertion so planner-vs-localizer is tested.
Diagnosis turns are untouched.

---

## 5. Open questions — decide before implementation

| # | Question | Recommendation |
|---|----------|----------------|
| Q-A | P1 (merged call, LLM decides arming), P1-alt (call extracts evidence, code decides), or two calls + P2 only? | **P1-alt** — latency/cost win AND deterministic, table-testable arming (principle 1). Plain P1 is the fallback if evidence fields can't capture the prose rules. |
| Q-B | Merged-call validation: partial-accept per section, or all-or-nothing? | Partial-accept — each section keeps today's independent fallback. |
| Q-C | Which taxonomy changes land? | `research` + `refactor` shapes (refactor upgraded to ADMIT by production data, §4.0); `no-edits` as a constraint kind; chat-era categories stay out. |
| Q-D | `research` auto-casts the `researcher` persona (reversing explicit-only for one shape)? | Yes — shape-scoped; rule 2b updated. |
| Q-E | Research turns decompose by default? | No special path — preamble suggests fan-out for independent questions; the benefit gate decides. |
| Q-F | P2b provider JSON mode now or later? | Defer until gateway support is verified; temp 0 addresses the observed flake. |
| Q-G | P1-alt: which fields are extracted facts vs judged? Any prose rule that resists evidence + table? | Walk the rig corpus row by row first; any irreproducible row = missing evidence field or genuine judgment that stays LLM-side. |
| Q-H | P4: pre-LLM short-circuit, turn-read outcome, or both? Does a continuation inherit the previous preamble? | Both pieces (§4b); inherit the preamble unchanged — a continuation continues the same goal tree. Validate the no-re-arm rule on corpus rows first. |
| Q-I | P5: accept the cross-tier re-ask + neutral degrade, and the <2% null-rate gate? Move probe-gate arming onto the turn-read verdict? | Yes to both — but only decide-now, execute after P1+P2 (the counter must exist and the flake rate must actually drop). Decide before P3 so no regex keywords are added for new shapes. |
| Q-J | P6: does a `blocked` dependent fail the goal (sweep to failed) or wait for re-decomposition to re-plan it? And does P6b serialize on overlap, or block the wave and ask the conductor to re-plan? | Blocked feeds re-decomposition (it IS a coverage gap — the machinery exists); overlap serializes silently (an implicit dep), no conductor round-trip. |
| Q-K | P7: build per-slice inline execution (a), fold venue into P6 as honest telemetry (b), or delete rule 4 (c)? | **(b)** — one P6c diff makes the inputs real; the telemetry then proves or kills (a) with evidence instead of intuition. |
| Q-L | P8: which slices get the ×1.5 step bump — hard/design allocation, escalated rescues, or both? | Both — same failure mode (cap starves the exact slices most likely to double-pay); one function, one table test. |
| Q-M | P9: reasoner-always for synthesis, or keep an oracle path for mixed outcomes? | Reasoner default + oracle only on mixed done/failed outcomes needing arbitration. Pure "oracle never synthesizes" is simpler but loses the one case where judgment is real. |
| Q-N | P10: reset the resolve counter per turn, or split it (resolution vs re-decomposition budgets)? | Per-turn reset only — one shared budget of 2 per turn stays a tight bound; splitting adds a knob with no observed need. |
| Q-O | P11b: accept depth-1 sub-planner delegation (revising the star), or keep hub-only (post-slice re-decomposition)? Per-slice delegate bound? | Accept — down-only + depth-1 + evaluator-gating keep the star's real protections (no judgment fragmentation, no recursive sprawl) while the designer stays the integrator. Bound: ≤4 delegates per slice (mirrors 3–5 branching discipline). |
| Q-P | P11c: keep the raw `task` tool for edit work, or force edit-capable delegation through slice dispatch? | Force through slice dispatch — unverified, un-snapshotted edits are how false-greens happen; raw task stays for read-only recon. |
| Q-Q | P12: new plan seed content, or route `needsPlan` builds through the resolution gate's resolve-first pass instead? | New seed — resolve-first is for *uncertainty* (fix an approach), the plan seed is for *decomposition* of a decided build; conflating them re-couples two gates that were deliberately split. Seed + rig seed-kind assertion. |

## 6. Sequencing & validation

1. **P2a** (temp 0) — smallest diff; rig re-run for parity.
2. **Q-G corpus walk** (zero code) — factor the arming prose rules into evidence + table;
   check every corpus row reproduces. Decides P1 vs P1-alt with evidence.
3. **P1/P1-alt** — behind the rig gate (arming parity, goal parity, parse-fail rate,
   latency); live-fire per the checklist; delete old dispatches on acceptance (no shims).
4. **P3** — `research`, `refactor`, `no-edits` as separate commits, each with corpus rows,
   playbook, casting, heuristic mapping; live-fire one canonical prompt per addition.
   Refactor's corpus rows land first; the shape rolls back if build/refactor confusion is
   high (admission stays evidence-gated).
5. **P4** — short-circuit + judge session-state wiring, corpus rows for the three §4b
   cases, continuation-rate telemetry.
6. **P5** — executes last, gated on the null-rate counter (lands with P1) reading <2%
   after the cross-tier re-ask: delete the shadow taxonomy, re-home probe-gate arming onto
   the turn-read verdict, neutral degrade replaces the regex guess. Decided up front
   (Q-I) so P3 never invests in regex keywords.
7. **P6 (+P7)** — independent of P1–P5; P6a (dep-failure blocking) can land any time —
   smallest cost win in the round; P6b/P6c together (both consume the same scope probe),
   unit + rig rows before live-fire. P7 rides P6c: same diff feeds the venue inputs, then
   the verdict telemetry decides inline execution's fate with data.
8. **P8 + P9 + P10** — three small independent diffs, land any time (no dependency on
   P1–P7). P8: budget function + table test + exhaustion-rate telemetry. P9: one
   conditional at the synthesis dispatch + `synthesisTier` on the receipt. P10: per-turn
   counter reset + unit row (two hard turns each get a resolution pass).
9. **P11** — last and largest; lands after P6b (delegates reuse the scope probe to stay
   inside the parent slice's file scope) and P8 (a delegating seat spends steps on
   delegate calls). P11a is a one-line doctrine change, any time. P11b: `delegate` tool +
   permission carve-out for reasoner/oracle seats + child-todo recording + ledger rows;
   rig case = the sub-planner example (design → parallel executor delegates → integrate);
   live-fire a payment-rails-shaped task before de-flagging. P11c rides P11b (same
   dispatch seam).
10. **P12** — small, independent, land with the P8–P10 batch: new seed constant + the
    skeleton branch + rig seed-kind assertion; live-fire one hard-build prompt
    (dark-mode-shaped) and check the pre-pass output is a plan, not a bug hunt.

Each stage folds its accepted design into
[ORCHESTRATION_MECHANISM.md](./ORCHESTRATION_MECHANISM.md); this doc records the decisions.

---

## Sources

Research pass of 2026-07-10:

- Hao et al., *An Empirical Study on Developers' Shared Conversations with ChatGPT in
  GitHub Pull Requests and Issues* — 16 inquiry types + 7 multi-turn roles:
  <https://arxiv.org/html/2403.10468>
- Xiao et al., *DevGPT: Studying Developer-ChatGPT Conversations* (the corpus):
  <https://arxiv.org/abs/2309.03914>
- *REAP: Automatic Curation of Coding Agent Benchmarks from Interactive Production Usage* —
  17 testable/untestable categories + production distribution:
  <https://arxiv.org/pdf/2604.01527>
- Anthropic Economic Index: <https://www.anthropic.com/news/the-anthropic-economic-index>
  and <https://www.anthropic.com/research/economic-index-june-2026-report>
- Treude, Barzilay, Storey, *How Do Programmers Ask and Answer Questions on the Web?*:
  <https://ctreude.ca/wp-content/uploads/2011/02/how-do-programmers-ask-and-answer-questions-on-the-web.pdf>
- Barke, James, Polikarpova, *Grounded Copilot* (acceleration vs exploration) — via the
  empirical-study literature above.
- Swanson / ISO-IEC 14764 maintenance taxonomy (corrective, adaptive, perfective,
  preventive) — classic SE literature.
