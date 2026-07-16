# Path to 85 — can the hardened harness consistently hit 85% on SWE-bench, beyond Django, at econ cost?

**Question** (2026-07-14): with the round-F fixes from the
[variance forensics](../testing/HARNESS_AND_VARIANCE_REPORT.md), can we consistently
reach 85% on SWE-bench Verified — and generalize to any language, any repository, and
human-in-the-loop coding — while holding the cost axis?

**Standing constraint** (user decision, 2026-07-14): **blanket best-of-N is ruled
out.** Cost is co-equal with score. The variance answer is ranked: deterministic
conversion first, signal-gated redundancy on the hard tail only, blanket N-draws never.

Companions: [HARNESS_AND_VARIANCE_REPORT.md](../testing/HARNESS_AND_VARIANCE_REPORT.md)
(what fails today and why), [native-loop-gap.md](./native-loop-gap.md) (the thin-pipe
baseline), [STRICT_CYCLE.md](../testing/STRICT_CYCLE.md) (the iteration log).

---

## 0. Verdict up front

1. **85% expected-value on SWE-bench Verified: plausible with the round-F conversions
   + deferral, unproven until measured on the full 500.** The tier stack's native
   ceiling is ~80% (reasoner-tier model publishes 80.6% Verified; the conductor-tier
   M-series claims ~80.5% under a thin harness — user-supplied, unverified by our
   research pass). The harness must add ~5pp net. The 0713 forensics show it currently
   *subtracts* on identifiable classes (oracle inversion, gate hatches) — so the first
   +2-4pp is removing own-goals, which is cheaper than adding machinery.
2. **"Consistently 85%" (every run ≥85%) has a benchmark noise floor of roughly
   2–5pp** that no harness work removes: published false-pass/misgrading rates run up
   to ~11% of reported successes (arXiv:2511.16858), OpenAI has publicly deprecated
   Verified over instance quality (59.4% of audited problems had material issues), and
   we found two grading artifacts ourselves in just 8 failures (subTest line-gluing on
   11848/11964). The honest target: **expected ≥85% with a run-to-run band of ±2pp**,
   i.e. worst runs land ≥83%. The frontier plateau at 88.6–88.7% is itself evidence of
   an effective ceiling near 90.
3. **"85% for any language" is not a near-term target for anyone.** The
   Python→multilingual drop is ~20–32pp *for frontier models too* (Claude 3.7: 63%→43%
   on SWE-bench Multilingual; Kimi K2.6: 65.8%→47.3%; pattern is model-agnostic —
   arXiv:2504.02605, swebench.com/multilingual). The right goal on multilingual sets is
   **relative position** — within a few points of frontier at a fraction of the cost —
   and that requires the ecosystem-adapter layer in §4, which is real new work.
4. Everything recommended below is **cost-neutral or cost-negative except the deferral
   tail** (one extra constrained draw on the ~10–20% of instances where a deterministic
   failure signal fires — the double-pay ledger already accounts for exactly this
   shape).
5. **The cost axis is not in trouble — we start from ~3.8× ahead, and that changes the
   risk appetite here.** Real-graded mini-10: econ ~$2.35–2.47 @ 9-solid vs Opus $9.03 @
   10/10 (Sonnet $5.81 @ 9/10 — see
   [ECON_VS_CLAUDE_MODELS.md](../testing/ECON_VS_CLAUDE_MODELS.md)). A 2026-07-15
   investigation into apparent *cost parity* with Opus turned out to be chasing a
   contaminated baseline (an unstripped, self-reported 07-03 reference); the honest gap is
   3.8×. Two consequences for this plan: (a) **score is the scarce axis, not cost** — pp
   are worth more than pennies, so a Tier-1 mechanism that buys accuracy at ~$0 is
   strictly better than a cost mechanism that risks it; and (b) any future *cost*
   mechanism carries the burden of proof, because it is trimming a tail on a winning
   position (the turn-economy wave in §3 Tier 0 was the first test of this rule —
   verdict: the block regressed, two mechanisms survived; the escalation gate in §3
   Tier 0 was the second, larger test — verdict: PASSED, shipped `247cf53b3`; report
   Part VIII.6).

---

## 1. The arithmetic

500 instances; 85% = 425 resolved, 75 failures allowed.

```
native tier-stack policy (thin pipe)        ~80%          (≈100 failures)
− benchmark noise floor (misgrade/flaky)    2–5pp burned  (unfixable by us)
+ remove harness own-goals (report items 2,3)  +2–4pp     (11815-class, hatch-class)
+ witness upgrades (typed asserts, sibling enum, item 4–5) +1–3pp  (11790/12039-class)
+ deferral: hard-tail second draw (item 1)  +1–3pp        (tail-only cost)
────────────────────────────────────────────────────────────
plausible band                              83–88% expected
```

Each increment is grounded in an observed failure class with a counted frequency in
our own runs (8 fleet failures: ≥6 were deterministic-convertible). The band's floor
crosses 85% only if all three buckets land — hence the measurement plan in §6.

Reference points for what buys what at the top (research pass, 2026-07-14):
pass@1→pass@3 ≈ +5pp (Verdent); 5-sample majority ≈ +8–12pp at 5× cost (OpenHands) —
**declined** per the standing constraint; critic-model pass ≈ +3–6pp at +15–20% tokens;
Anthropic high-compute ≈ +5pp over baseline. The deferral design targets the same tail
those buy, paying only on signal.

---

## 2. What the round-F fixes cover (from the forensics report)

| Report item | Failure class it converts | Cost shape |
|---|---|---|
| 1. Hard-tail signals → deterministic escalation/decomposition | 8/8 reds ran 0-escalation; denied finishes discarded | tail-only spend |
| 2. Oracle-inversion escape **(IMPLEMENTED + live-validated 2/2, `1270cbccd`)** | 11815 ×2 (gold fix squeezed out by pin + no-test-edit) — both trajectories now convert to a general fix (report III.1 / V.2) | ~$0 |
| 3. Close gate hatches (evidence-bearing retry) | 11848 ×2, 11964-A (identical-retry / re-issue walk-throughs) | ~$0 |
| 4. Repro-fidelity teeth (typed asserts enforced) | 11790, 12039 (rendered/print witnesses) | ~$0 |
| 5. Seed precedence + %r + sibling-enumeration priors | 11790 clause conflict, 11815-E, 12039 | ~$0 |
| 6. Interpreter discipline for agent repros | 11964-A wrong-python, 11848-B missing deps | ~$0 |
| 7. Hub-judge sanity floor | 11964-A hallucinated verdict | ~$0 |

These are necessary but **not sufficient** for §0.1 — the additions below close the
rest, in cost order.

---

## 3. What research adds, ranked by cost shape

### Tier 0 — cost-NEGATIVE (do these regardless of the 85% goal)

- **Observation masking over LLM summarization.** JetBrains (SWE-bench Verified, Dec
  2025): mechanical rolling-window masking of old tool *results* (calls stay visible)
  cut tokens >50% **and improved solve rate +2.6pp**; LLM summarization *lengthened*
  trajectories 13–15% by erasing stopping signals. The rule: **masking is the primary
  line of defense; LLM summarization is strictly the catastrophic-overflow fallback**,
  never the first response to pressure. Our compaction stack already carries masking
  machinery (`session/compaction.ts:42-85` — mask floor, protected region, step
  interval) plus an inherited summarize path (`core/src/session/compaction.ts:12-15`);
  the audit item is to verify the ordering enforces masking-first and that summaries
  can never erase the evidence chain of the active pin/probe (the S5
  evidence-fragmentation suspect). This is the rare knob that is cheaper AND better.
- **Issue-relevant regression selection (TestPrune-style).** Selecting existing tests
  by relevance to the issue cut SWE-Agent cost 23% *and* reduced false positives
  (arXiv:2510.18270). Our F11 neighbor machinery already selects; tightening selection
  to issue-relevance is a refinement, not new spend.
- **The turn-economy wave (2026-07-15, ⧗ UNCOMMITTED — IN VALIDATION, mixed).** Seven
  always-on, inert-by-signature mechanisms attacking *turns* rather than tokens: a compiled
  brief + a 12-step cap for first-hop reasoner/oracle slices (an above-conductor slice is an
  adviser, not a second agent), a cascade-failed inline latch, a direct-first valve,
  identical-run dedupe, an env-blocked probe writeoff, and hub-gate turn-bounce memory.
  Mechanism map: [HARNESS_AND_VARIANCE_REPORT.md](../testing/HARNESS_AND_VARIANCE_REPORT.md)
  Part I (⧗ anchors) · rationale + live-fire: Part VII. **Live-fire verdict (5 instances,
  2026-07-15): the wave as a block is a COST REGRESSION — $1.44 → $1.95 (+36%), 287 → 376
  turns (+31%)** — while improving correctness 4/5 → 5/5. It does **not** ship as a block.
  Per-mechanism: the compiled brief + 12-step cap are the survivors (two specimens —
  11999's above-conductor turns 55 → 6 at −70% cost; 11790's escalated draw held to 6
  above-conductor turns vs a historical 31–42); post-green convergence is **dropped** as
  actively harmful (it nudges a finish the M4 gate then rejects, burning bounded retries
  into the deferral cliff — 12050 +1053%); the env-blocked writeoff is **defective** (its
  regex never matched its own motivating case); and the cascade latch, direct-first valve,
  identical-run dedupe and hub turn-bounce memory **never fired on any of the five** — no
  evidence either way. The premise that provoked the wave was itself false (§0.5). Two
  lessons feed the rest of this plan: **(a) bound escalation *rungs*, not just steps** —
  11880 burned 62 above-conductor turns as six judge rungs of ~10, every slice obeying the
  cap; **(b) don't build mechanisms against n=1 pathologies** — four of seven targeted
  single prior observations that never recurred.

- **Deterministic, conductor-biased escalation gate (2026-07-15, VALIDATED 2026-07-16, shipped `247cf53b3`).**
  Band forensics (report Part VIII) found the orchestration-benefit gate was effectively
  a coin flip: same binary, same instance, identical triage verdict produced
  `slices=5`/146t/$0.6639 one round and conductor-only/25t/$0.0670 the next (9.9×, both
  PASS, same patch) — because the old gate keyed on the *allocated* tier, which derives
  from conductor-authored `sliceType`/`need` plus a probe default that floors unbacked
  mechanical slices to reasoner. The suite-level consequence: the ten-instance aggregate
  swings 1.55× between draws — single runs are not measurements even in aggregate.
  **The rewrite:** the gate opens only on harness-seeded escape hatches (derived from
  seed content, never a model-writable field), ≥6-slice breadth, triage goal-width ≥2,
  or probe-derived coupling/risk; reverses run-21. Framing for this plan: this is the
  largest single cost lever found so far — bigger than everything in the turn-economy
  wave combined — because escalated and conductor-only routes differ 4–10× for
  identical outcomes on this class. **Risk (resolved):** it was the first Tier-0 item
  that could plausibly cost score (if escalation was load-bearing on
  11815/11848/11880/11885, conductor-bias shows up as new failures), so it shipped under
  the full §6.6 burden. **Verdict (two mini-10 rounds + failed-pair rerun, report Part
  VIII.6): aggregate cost band 1.55× → 1.02× at ~35% below the old gate's expensive
  draw; three fails (11964 ×2, 11885 ×1) all in route-immune variance classes, none
  gate-attributable, and both instances passed a same-binary rerun** — 11880 even passed
  a *declined* draw at $0.0565, its cheapest ever. Residual: the `goal-width` trigger is
  the one remaining LLM-fed escalation channel (11951's 8.3× swing). It enforces the
  companion rule from §5: the escalation decision is now a CONVERT-shaped consumer of
  deterministic signals (probe coupling/risk, triage width) instead of an advisory read
  of the model's self-report.

- **Shape-gate the fix machinery by the turn-read verdict (2026-07-15, IMPLEMENTED).**
  The harness armed on *every* turn, so a read-only turn (a question, an audit, a
  research lookup, a command-run) paid the full fix apparatus — decomposing a question
  into tiered reasoner/oracle slices, authoring a repro, editing a test — before
  answering. Now a high-confidence all-read-only verdict (`verdictIsReadOnly`,
  arming-judge.ts) stands the fix machinery down on three seams: `degraded:true` arming
  (answer inline, no decomposition, no repro pre-pass), `bugShaped=false` (the S3/wave-10
  finish gates stop nudging an empty-finish question to "author a repro" — their
  `testEditGateArmed` disjunct had made a plain Q&A bug-shaped), and a `READ_ONLY_PLAYBOOK`
  preamble that steers answer-and-stop. The deterministic `nonFixQaShortCircuit`
  (turn-triage.ts) skips the LLM turn-read entirely for a plain question — cheaper still.
  This is strictly cost-negative on read-only turns and *provably inert* on fix work: a
  compound turn carrying even one diagnosis/build/refactor goal is not read-only, so the
  full harness stays armed (the fix reproduction still arms — unit-verified, and a live
  compound probe planted repro + localization seeds). Live result: the same
  "where is resolve_redirects" Q&A went 31 turns / $0.17 → 3 conductor steps / $0.0056. It leverages the turn-read
  classifier and goal-split we already run: the initial LLM call decides *what kind of
  task this is*, and the harness arms to match instead of assuming every turn is a fix.
  This is the rare harness knob that is cheaper with no accuracy cost — the mirror image
  of the observation-masking item above.

### Tier 1 — ≈$0 marginal (prompt/gate/code changes)

- The round-F list (§2).
- **Issue-derived assert compilation — T1 extractor coverage (2026-07-14, IMPLEMENTED).** Every "expected"/"actual" string, value, or error trace quoted in the issue becomes an executable assert in the pinned repro (12039's `'"name" DESC'` was sitting in the issue's expected block; 11790's typed `254`). Extraction is **mechanical and happens at turn-open** — alongside the M4 probe derivation (`prompt.ts:3634-3643`), the turn-read's verbatim-quote discipline already isolates the candidate strings — and the compiled asserts ride the repro seed's contract so the fidelity judge enforces their presence, not just their spirit. This is the spec-inference angle the literature flags as underexploited — no system publishes extraction accuracy, but our own failures show the ceiling: 3 of 8 reds had the discriminating witness printed in the issue text and ignored it because the repro was print-and-eyeball. **New in round F:** `extractIssueExpectations` gained expected/actual prose-block regexes (EXPECTED_PROSE_BLOCK_RE / ACTUAL_PROSE_BLOCK_RE) extracting same-line-after-colon or next-non-empty line; new `extractIssueThresholds` captures sentence-scoped "more than/at least N" bounds with rule-force-word gates. Extracted 12039's two CREATE INDEX variants and 11848's "more than 50 years" threshold. Fixture-tested against all 10 Mini-10 PROMPT.txt files; 0 false fires on the 7 passing cases.
- **Finish-time type-fidelity re-check — witness-upgrade bucket completion (2026-07-14, IMPLEMENTED; stringified-mirror half extended 2026-07-14 commit `388cf3255`).** RF-4's pin-time deterministic teeth enforced typed-API asserts; RF-8 closes the evasion path: agent rewrites the pinned repro between judgment and finish (assert → if/append form, dodging detectors). Finish-time re-check re-reads the on-disk repro at M4 green, runs `detectTypeUnfaithfulRepro` (numeric-string-conflict + stringified-mirror composite), one bounded deny on hit, then loud pass-through. No false-fires on rendered-tooth or LLM-judge gaps (high-precision audit: 5 gap records, 0 numeric-string/mirror conflicts). Operationalizes §5's "no advisory-only signals" rule at the finish boundary (signal now converts at decision point, never merely logs). Commit `388cf3255` extended `detectStringifiedMirrorAssert` to follow one hop of `str()` variable-indirection (a strict fresh-arena evasion hunt reproduced the gap on 11790: `expected = str(...)` then a plain `assert chain == expected`); unit-proven 91/91. **Live-validated 2026-07-14:** a 5-attempt strict fresh-arena re-fire hunt on 11790 went 5/5 REAL PASS, and attempt 5 hit `fidelity_finish_reject` (convert) and passed after the nudge — the finish-re-check + conversion mechanism is now live-fire proven (honest attribution: attempt 5's catch was the pre-existing numeric-string-conflict half, not the same-day alias extension). **Extended again 2026-07-14 (commit `33245816e`, unit 97/97):** a strict full Mini-10 sweep drew 11790's *conditional* pinned form — `widget_maxlength = widget.attrs.get(...)` then `if widget_maxlength != str(expected):` gating an `errors.append` — which `388cf3255`'s assert-only str-alias tooth cannot see (it dodges the assert anchor and keeps `str(` off every assert line). `detectStringifiedMirrorAssert` now also scans `if`/`elif` gates (`extractConditionalComparisonSides`, sharing `splitComparisonSides`) and resolves the symmetric chain-side alias, so the mirror check fires on the conditional form alone. Isolated to the mirror detector; the 5/5 hunt sampled assert-form draws and this is the residual it left open — live re-validation on the rebuilt binary pending. Full record: [STRICT_CYCLE.md](../testing/STRICT_CYCLE.md).
- **Stale-visible-test detection as a first-class verdict.** The literature names the
  problem (gold rewrites visible tests; 21.8–33% of agent-generated tests overfit —
  arXiv:2511.16858) but has no mechanism; our oracle-inversion escape (report item 2)
  is ahead of published work. Keep the issue text as the senior oracle when the two
  conflict, and say so in the finish summary.
- **Default-on Exa-backed web search (2026-07-16, IMPLEMENTED).** Lookup-shaped tasks
  resolve on a single targeted search ~54% of the time; default-on web search replaces
  guess/recon turns on those tasks at marginal cost (~$0, 5-result default). Deterministic
  provider selection (no session coin flip — per §6.8 route-determinism rule, old
  `checksum(sessionID)%2` deleted); cost-lean defaults (5 results, 8000-char context).
  Doctrine: ONE search EARLY when task hinges on external knowledge; search → webfetch
  authoritative source; never search what repo answers. The companion deny-precedence fix
  closes a strict-benchmark integrity hole: `childSlicePermission` no longer appends
  allow rules — explicit config deny now wins by merge order. Benchmark arenas
  additionally set `OPENCODE_DISABLE_WEBSEARCH=1`. See [feature 02 §S2.3a](../features/02-context-engine.md#web-search-default-enablement--s23a).

### Tier 2 — tail-only spend (the deferral machinery)

> **Live-fire caution (2026-07-15): "tail-only" is doing a lot of work in that heading.**
> The first measured specimen of this machinery firing (django-11880, forensics report
> VII.4.1) cost **62 above-conductor turns / +$0.50 — ~10× inline retry — and shipped the
> byte-identical one-line patch the conductor had already written.** Six judge rungs
> climbed reasoner→oracle, every one logging `judge rung failed`, because the escalation
> was chasing a green pin the *arena environment* could not produce. Two design
> consequences, both now prerequisites rather than refinements: (a) **a deferral must be
> able to terminate** — escalating toward evidence the environment cannot supply is an
> unbounded loop wearing a bounded-retry costume, and the env-blocked writeoff that should
> have caught it was itself defective (VII.4.1 finding 2); (b) **the tail must be priced
> before it is widened** — this item is still the right idea (8/8 reds ran 0-escalation),
> but "tail-only spend" is a cost *shape*, not a cost *bound*, and one firing here cost
> 2× a median instance's entire budget.

- **Signal-gated second draw** (report item 1): a denied finish / unresolved repro /
  2nd hub bounce fires one constrained retry — enumerate-then-choose from named
  candidates (definition sites, sibling classes, API variants), usually one tier up.
  This is UCCI-shaped calibrated deferral with *deterministic* signals instead of
  logprobs — better calibrated than confidence, and free.
  **Gating requirement added 2026-07-15:** the retry must carry a termination condition
  that does not depend on producing evidence the environment has already refused, and its
  cost must be measured per firing, not assumed from its trigger rate.
- **Two-candidate selection, execution-free, on the tail only.** When deferral produces
  a second candidate, pick between the two with the judge tier reading both diffs
  against the issue (R4P-style patch reasoning: +6.6pp selecting from 16 at ~1s/patch;
  our case is easier — 2 candidates, evidence attached). No test-execution cost, one
  small judge call, only on the tail.

### Tier 3 — declined (documented so the decision is explicit)

- **Blanket best-of-N**: +5–12pp at 3–5× generation cost. The frontier's move, not
  ours. The tail classes it uniquely covers shrink as Tier-1 witnesses improve (a
  locally-red wrong draw self-corrects; only locally-green wrong draws need N).
- **MCTS / trajectory tree search** (SWE-Search +23% relative): cost multiplier
  undisclosed, complexity high; the deferral loop captures the high-value subset.
- **Standing critic-model pass** on every turn: +3–6pp at +15–20% tokens — poor
  trade against Tier-0/1 items; and our own record (hub-judge hallucination,
  judge-degraded rounds) plus the small-judge literature says in-loop cheap judges
  are the wrong tool except as narrowly-scoped verdicts on the tail.

### Phase-2 (post-85, or with the sovereign path)

- **Step-level DPO / trained conductor** on our logged decision pairs (hub bounces,
  deferral outcomes, gate conversions are labeled training data we already emit) —
  the highest-ceiling item in the cheap-judgment research; Fugu validates the
  trained-conductor topology.
- **Batch-invariant serving** when we host in-region: vLLM/SGLang now ship
  batch-invariant kernels (~1.6× throughput cost) — buys substrate-level determinism
  no API provider sells today. Turns "same input, same output" from hope into config.
- **AHE (harness-as-optimization-object)**: evolved harnesses transfer +5pp across
  models (arXiv:2604.25850) — aligns with our strict-cycle practice; automate later.

---

## 4. Any language, any repo — the ecosystem-adapter layer (the real new work)

The multilingual evidence says the gap is **not model capability** (frontier drops the
same ~20–32pp) — it is environment discipline + oracle parsing + localization quality.
The component is a **decoupled adapter layer**: language/ecosystem knowledge lives in
adapters with one interface (discover test command · parse red/green/error output ·
find twin tests · resolve toolchain · build step), and the gates/seeds/probes consume
that interface — **no language regex ever lives inside gate logic again**. Our harness
has Django/pytest specifics baked into exactly the places that must generalize:

| Today (Python/Django-shaped) | Generalized form |
|---|---|
| `TEST_SHAPED_COMMAND_RE`, red signatures, laundered-red regexes (`seen-red.ts:33-45`) | **Runner adapters**: per-ecosystem test-command discovery + red/green/error output parsing (pytest, jest/vitest, go test, cargo, gradle/maven, ctest). SWE-rebench V2 synthesizes parsers per repo — we can ship curated adapters for the top 6 ecosystems + an LLM-synthesized fallback (bounded, cached per repo). |
| F19 "Django exact-twin" neighbor pass, `tests/<dir>` scanning (`regression-neighbors.ts:239-341`) | Twin discovery per ecosystem convention (`__tests__/`, `_test.go`, `src/test/java`, `tests/` crates). |
| Repro seed assumes interpreted run (`repro_issue.py`) | **Build-first discipline** for compiled targets: the adapter inserts a **compilation-verification rung BEFORE any test/probe rung**, and a build/typecheck failure (`cargo check`, `go vet`, `tsc`, `mvn compile`) is a deterministic gate block — never advisory, never conflated with a test red (the ts-repair result: speculative-apply + immediate typecheck loops erase an entire variance class at compile time). |
| Python import resolution in the graph (wave-5 fixed Python specifically; edges were 30%→84.7%) | **Per-language edge parity** in BunSqliteGraph via tree-sitter + light type resolution; **measure edge-coverage per language before trusting risk signals there** — pointing the graph at a C++/Java repo without upgraded edges starves the risk router of dependency signals and the engine silently degrades to a blind, unguided cheap-model loop (wave-5's exact failure mode, rediscovered per language). Known floors: C macros (~0.58 quality), C++ templates, Java overloads. Adapter contract: an ecosystem whose edge coverage is unmeasured reports `coupling=unknown`, which routes to the judge rung — degraded-but-loud, never silent. |
| Interpreter discovery (F14a) for regression gate only | Extend to the agent's own repro/probe runs (report item 6) — per-ecosystem toolchain discovery (venv/conda, nvm, GOPATH, cargo workspace). |

Cautionary datum: graph-*guided localization* overfits (AutoCodeRover 45%→19% under
stricter tests). Our graph routes **risk and verification strictness**, not
localization — keep it that way, and validate multilingual claims on the stricter
suites (Multi-SWE-bench is human-validated).

Yardstick: SWE-bench Multilingual (300 tasks, 9 languages) as the recurring probe once
the adapter layer exists; expectation set by the frontier's own 43–47%, not by the
Python number.

---

## 5. One framework: benchmark, real repos, and human-in-the-loop

The unifying principle the 0713 forensics forced: **every mechanism publishes onto one
signal bus, and the decision layer consumes it three ways** — the same architecture
serves all three deployment modes:

```
signals (deterministic):  gate denies · unresolved repro · unpinnable red · hub bounces
                          · convention divergence · seen-red · regression red
                     │
        ┌────────────┼──────────────────┐
        ▼            ▼                  ▼
   CONVERT       DEFER                SURFACE
   (priors,      (escalate tier /     (tell the human;
   hatch-closed  constrained retry;   interactive ask-user
   gates, typed  tail-only spend)     branch already exists —
   witnesses)                         resolution-phase.ts rule 3)
```

The same signal, routed by environment context:

```
                    e.g. M4 pin deny · unresolved repro · 2nd hub bounce
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              ▼                                                   ▼
      [ headless / benchmark ]                        [ human-in-the-loop (IDE/CLI) ]
      DEFER / ESCALATE                                SURFACE / ASK-USER
      constrained retry from a lean compiled          pause the loop, render the diff
      brief; one tier up; double-pay accounted        as advice, ask the human to
                                                      arbitrate — then continue
```

- **Benchmark/headless**: SURFACE is unavailable → signals route to CONVERT then DEFER
  (this is round-F item 1).
- **Human-powered coding**: the same failure signal routes to SURFACE instead of a
  blind guess — on an oracle-inversion hit the loop pauses and asks the developer
  directly: *"the visible test contradicts the issue statement — which one is the
  ground-truth spec?"* This is strictly better economics than any automated selector:
  the human arbitration costs zero tokens, stops wheel-spinning on the exact turns
  that burn the most, and **eliminates the need for multi-candidate LLM selection in
  interactive mode entirely**. HULA's finding (feedback enriches input context and
  improves downstream success) says surfacing early beats guessing. The plumbing
  exists: `resolutionDecision`'s ask-user branch (`resolution-phase.ts:84-140`) and
  the non-blocking `question.ask` fork (`prompt.ts:4486-4495`) — the work is widening
  what may route to it beyond turn-open ambiguity.
- **Real repos**: gates stay bounded-reject-then-fail-open-loud (never wedge a human's
  session); observation masking and runner adapters serve interactive use identically —
  nothing in the plan is benchmark-only machinery. The rule that keeps it coherent:
  **no advisory-only signals** (a signal either converts, defers, or surfaces —
  12039's `turn_completed_unverified` did none, and that's the anti-pattern).

This also keeps rule 7 of the strict cycle intact: the orchestration is the product;
the thin pipe is the yardstick. Our structural advantage over mini-swe-agent is not
more machinery — it is that we *produce* deterministic hard-tail signals a thin pipe
doesn't have, and (after round F) actually consume them.

---

## 6. Measurement plan (nothing above is claimed until these run)

1. **E1 null-harness control** (still pending from native-loop-gap): thin pipe on our
   gateway/bindings = the floor every mechanism must beat.
2. **Full-500 Verified run** at post-round-F HEAD — the Mini-10 is the hard decile;
   the 85% question is unanswerable from it alone.
3. **N-run variance band**: ≥3 sequential full runs, report mean ± band per instance
   class (no leaderboard operator publishes this; we should, internally — it is the
   "consistently" in the goal).
4. **Grader-artifact audit** on every red before root-causing (two of our eight
   "failures" contained a test that actually passed).
5. **Multilingual probe** (SWE-bench Multilingual, 300 tasks) once the top-3 runner
   adapters exist — expectation: frontier-relative, not Python-parity.
6. **Cost claims need the variance band too** (added 2026-07-15). A before/after pair is
   not evidence on this distribution: per-instance cost spans ~19× on a *fixed* binary
   (11790: $0.033–$0.632 over five runs), and the turn-economy wave produced a 3.1× cost
   swing on 11880 with **no mechanism implicated in the divergence** — a pure route fork
   driven by when the conductor happened to declare an unverified finish (forensics report
   VII.4). That per-instance spread was already known; 2026-07-15 added a second
   layer — the **ten-instance aggregate** itself swings 1.55× between draws ($2.4715
   vs $3.8519, same binary class) because escalation correlates across the suite (the
   coin-flip gate in §3 Tier 0), so headline *suite* costs are draws too, not fixed
   numbers. The published $2.35–2.47 figure needs a ≥3-run band before it is quoted
   competitively — the Opus $9.03 reference (§0.5) is likewise n=1.

   Rule: a cost mechanism ships on ≥3 runs/instance across the affected class, or
   it does not ship. The cheap-and-tight instances (11790/12050) are the sensitive cells —
   their floor is narrow enough that a deviation means something.
7. **Reference runs are benchmark runs** (added 2026-07-15). Any external baseline gets
   strip-the-future + real-grading before it is quoted, or it is not a baseline. An
   unstripped, self-reported Opus reference made econ look like it was at cost parity when
   it was ~3.8× ahead, and that artifact set an engineering agenda for a day
   ([ECON_VS_CLAUDE_MODELS.md](../testing/ECON_VS_CLAUDE_MODELS.md), "Retired").
8. **Route determinism is a measurable property** (added 2026-07-15). The escalation
   gate's primary readout is per-instance route stability across 3 rounds (same
   instance → same gate decision), logged per decision (verdict + trigger + inputs) —
   a cost mechanism whose effect depends on a coin flip cannot be attributed at n=1.
   Cross-ref forensics report Part VIII.

---

## 7. Explicitly not building

Blanket best-of-N · MCTS/tree-search · standing critic pass on every turn ·
LLM-summarization-first compaction · new in-loop cheap-model judges (standing rule) ·
logprob-based deferral while the gateway drops streaming logprobs (#62 — deterministic
gate signals are better-calibrated and available today).
