# Gap-closure plan — live-500 forensics → top-5 at 1/5th frontier cost

**Status:** PLAN (2026-07-19). Grounded in the first live mid-run forensics of the
four-benchmark fleet (`econ-verified-full-0719-104645`, `econ-terminal-full-0719-105337-terminal`;
traces in `unerr-benchmarks/e2e/distributed/failed-runs/<label>-midrun/`). Nothing here is
claimed shipped; every item carries its validation bar from
[path-to-85.md §6](./path-to-85.md#6-measurement-plan-nothing-above-is-claimed-until-these-run).

Companions: [path-to-85.md](./path-to-85.md) (strategy + tier ladder this plan extends),
[HARNESS_AND_VARIANCE_REPORT.md](../testing/HARNESS_AND_VARIANCE_REPORT.md) (failure taxonomy),
[graph-navigation-audit.md](./graph-navigation-audit.md) (wave G),
[models.md](./models.md) (model facts; **Part II tier table is stale — see H7**),
[09-ops-hands.md](../features/09-ops-hands.md) (F09, extended by H4).

---

## 0. Verdict up front

1. **The harness's residual failure mass has moved.** The 0713-era own-goals (oracle
   inversion, gate hatches, coin-flip escalation) are fixed and stay fixed in the live data.
   The live-500 failure classes are now: partial-witness fixes (5/9 of the first autopsy
   batch), regression-gate silent no-fire on import-time side effects (3/9, post-F20 binary),
   and **oracle-tier model quality** (escalated open-weight oracles failed 3 of 4 instances
   they touched, at $0.51–$1.31 per failed escalation).
2. **The single biggest measured waste is escalation that doesn't convert.** On the first 34
   Verified instances: oracle tier = 47% of all spend on this slice, and roughly half of that
   oracle spend sits on unresolved instances. The model-strategy move (§4) is therefore not
   "add frontier spend" — it is **re-pricing spend that already buys nothing**.
3. **Judge scaffolding beats judge model.** The one rigorous 2026 multi-model judge study
   (HackerOne) found per-model judge gaps collapse to ~98% agreement once the judge gets
   diff-aware scaffolding (before/after comparison, navigation tools). We upgrade judge
   *inputs* first (H3), and only re-bind judge *models* on the deferral tail.
4. Cost estimates (§5) are parameterized on measured numbers, not projections: mean
   $0.36/instance on the astropy-heavy head (oracle share o=0.47), $0.245/instance on the
   mini-10 (o=0.14). The frontier-oracle swap under rung-bounding models out to **+0–35%
   suite cost** — cheaper than the earlier +30–50% estimate because rung-bounding pays for
   most of the price ratio.
5. **Stop building gates; build the invariants (the kernel decision, §2.7).** Every
   mechanism we have shipped reduces to five invariants. This wave's new gates (H1, H2's
   scope rule, H8) are implemented as instances of a shared claim–evidence contract rather
   than three more bespoke gates — so the *next* failure class costs a contract entry
   (config), not a forensics cycle (code). Day-0 harness perfection doesn't exist — no
   finite enumeration covers an open task distribution, and every lab's harness is
   iterative — but the kernel is the honest version of it.

---

> **Build status (2026-07-19, wave 1 shipped + follow-ups + replay-validated):** kernel
> (claim-evidence contract) + H1 + H2 + H8 + H3 + H4 (engine gate/teeth + infra
> deadline/telemetry; SWE path deliberately excluded — see the H4 scope note) + H7 + §4.3
> ladder collapse/switches + H9 triggers + §4.4 profiles/direct-Anthropic path are ALL
> implemented and committed (`4ef0c3079`…`89db05be4` lineage; unerr-benchmarks `a19c3b4`).
> Follow-ups SHIPPED in `89db05be4`: H1 tooth-3 (finish claim = the agent's OWN
> observed-red test-id set via `checkTestSetCoverage`; never a benchmark F2P list),
> diff-aware judge inputs live at all call sites (`readTurnDiffHunks`, 200-line cap),
> ECON_JUDGE_TIER=off consumed at all three judge dispatch sites (once-loud
> `judge_tier_off`).
>
> **3-specimen hard replay (single runs — facts, not rates):** 13236 (H2) **CONVERTED** —
> fleet FAIL → real-graded RESOLVED (F2P 2/2, P2P 0 fail at gold, $0.16/40t;
> `unverifiable_regression_surface` fired; receipt = conductor+oracle only, §4.3 collapse
> live). 11265 (H9) still fails: `hub_bounce_repeat` fired at the predicted moment and was
> consumed — but read-only as scoped, run stayed all-conductor and repeated the
> symptom-layer fix; the read-only→decision flip is the evidence-backed next step. 14369
> (H1) fails UPSTREAM of witnesses: repro never pinned (`repro_drift`×3 →
> `repro_unresolved`), finish gate refused 5× (honest 0-byte patch), $1.01/188t —
> the expensive-fail class again; cost lever = abstention on `repro_unresolved` headless.
>
> **Round 2 (same day, post-replay):** H9 FLIPPED read-only → decision-influencing
> (`82434466a`): `hub_bounce_repeat` now arms the one-shot deferral escalation on the
> otherwise-CLEAN finish path (`shouldArmHubBounceDeferral` in turn-supervisor.ts, arm
> block in prompt.ts after the failure-evidence gates) — the 11265 shape: locally-green
> finish, symptom-layer fix on a high-coupling hub. `repro_unresolved` deliberately never
> arms (14369: $1.01/188t escalation landing nothing). Same commit fixes the
> prompt.test.ts loop-harness class for real: the first root cause (dispatches eat the
> scripted queue) was DISPROVEN by live debug-logging — the true mechanism was
> `bugShaped`'s null-verdict fallback riding the always-armed test-edit gate, looping the
> S3 gate on plain conversational prompts (also a live P5-degrade thrash). Fix =
> `resolveBugShapedFallback`: null verdict additionally requires turn evidence (landed
> source edit | observed red run | pinned probe); present-verdict paths byte-identical.
> prompt.test.ts 12 fail → 0. Signal-audit widened to all of src/ with corrected gate
> file targets, zero findings (`99b543323`).
>
> **Round 3 (same day, flip validation — RESOLVED as a stale-binary artifact):** three
> replays (#2, #3, #4) all appeared to show the flip not arming — replay #2 read all
> five `shouldArmHubBounceDeferral` inputs true at the finish arrival with no
> `deferral_armed`; #4 (grepped clean: `turn_regression_green` fired 15 straight-line
> lines above the H9 block, `hub_bounce_repeat` live on the same bus `turn_summary`
> reads, neither H9 log line emitted) briefly looked like an impossible control-flow
> hole. The actual cause: **`build_run_x.sh` never rebuilds the engine** — "build" in
> its name is the *arena* build; it executes whatever `packages/opencode/dist/` holds
> (`ECON_BIN` default). The dist snapshot predated the flip commit entirely: the binary
> contained no `shouldArmHubBounceDeferral`, no `resolveBugShapedFallback`, no decline
> telemetry, no O-J2. Every "mystery" (H9 silent, F11 zero branches, integration test
> passing "against unmodified code") was the same artifact. The source control flow was
> correct all along.
>
> Real fixes that DID come out of the rounds: `21a10d59c` — `h9_hub_bounce_arm_declined`
> decline telemetry + underscore repro-file exclusion (a deleted `_repro_field_error.py`
> scratch slipped both repro-path regexes and contaminated landed-source-edit evidence;
> live-confirmed) + permanent H9 integration test; `c208e2094` (O-J2) — the hub-design
> judge degraded in every replay on the stale binary's 2500-token budget (`rawHead` =
> truncated reasoning prose; one run's catch also swallowed a thrown completion) → 4096
> budget (parity with the fidelity dispatch, same tier), 180s judge-scale hang bound
> (the 12s turn-read cap would abort near-every reasoner pass), thrown path carries
> `threw: <head>`.
>
> **Round 4 — replay #5 on a marker-verified binary: 11265 CONVERTED (first ever).**
> Independently re-graded on the main thread against gold (agent test edits reverted,
> official `test_patch.diff` applied): F2P `test_with_exclude` **passes**, full
> `filtered_relation` module **32 tests OK** (1 pre-existing skip) with only the
> source-side patch applied. 195 turns / $0.9630, 65 turns above conductor (oracle
> $0.3804 = 39.5% of spend) — a ~5× cost step over the pre-fix all-conductor FAIL
> ($0.196/54t) to buy the conversion. Single run = a fact, not a rate.
>
> **The H9 arm still has NOT fired — and the decline telemetry proved why, exactly as
> designed.** Verbatim: `h9_hub_bounce_arm_declined … bugShaped=true landedSourceEdits=true
> hubBounceRepeat=true isChildSession=false deferralAvailable=false`. The conversion came
> from a DIFFERENT arm: `deferral_armed … evidence.consumed=seen_red_unresolved` spent the
> turn's one-shot deferral ~1000 log lines earlier; by the time control reached the H9
> block the budget was gone. This is CORRECT behavior, not a defect — H9 is scoped to the
> *otherwise-clean* finish, and this turn carried real failure evidence (4×
> `seen_red_unresolved`), so the stronger, earlier signal rightly won the budget and the
> escalation it bought resolved the instance. Consequence to track: H9's live reachability
> is narrower than the design implied — it can only arm on a turn where no earlier arm did,
> so it stays UNVALIDATED live (shipped, correct-by-construction, telemetry-confirmed
> evaluating with four of five inputs true).
>
> **O-J3 (`1fbde0959`) — the judge degrade root cause, finally named** by O-J2's own
> thrown-error evidence: `rawHead="threw: ProviderHeaderTimeoutError: Provider response
> headers timed out after 45000ms"`. The litellm provider's `headerTimeout: 45_000`
> (econ-defaults.ts:240) is applied inside its fetch wrapper (provider.ts:1686-1717) and
> combined with the per-call signal via `AbortSignal.any` — a per-call abort can only
> SHORTEN it, so O-J2's 180s bound was inert. A non-streaming reasoning completion returns
> no headers until it finishes thinking, which routinely exceeds 45s at a 4096-token
> budget: the reasoner-tier judges were structurally unable to survive the watchdog (and
> O-J2's 2500→4096 raise traded truncation for timeout). Fix: `reproFidelityDispatch` +
> `hubDesignDispatch` now STREAM (`streamText`), so headers arrive at the first chunk and
> `chunkTimeout`/the per-call abort become the real bounds; return semantics preserved
> byte-for-byte including the reasoning-then-text ordering the JSON parser depends on.
> The hub-design judge has never once rendered a verdict on this instance across five
> replays — O-J3 is the first build where it can.
>
> **Replay protocol (mandatory, learned the hard way):** `build_run_x.sh` builds the
> ARENA, never the engine — it executes whatever `packages/opencode/dist/` holds. Before
> attributing any behavior to code, `grep -c "<marker string from the commit>"` the
> binary. `bun run build` in `packages/opencode` refreshes dist.
>
> Remaining open: H9 arm still unexercised live (needs a turn with no earlier arm);
> O-J3 judge-verdict validation; mini-10 ×3 band + full-500 gate still ahead — no score
> claims until those run (§5.4).

## 1. Gap inventory (evidence-ranked)

| ID | Gap | Live evidence (2026-07-19) | Class |
|---|---|---|---|
| **H1** | Partial-witness repro: one-sided fixes self-verify green (missing roundtrip half, F2P subset) | astropy-14365/14598/14182/14369, django-10973 — 5/9 first-batch fails; round 2 confirms: django-10999 (lookahead half-fix + speculative locale edit), 11265 (state-copy one-liner, 22 turns) | HARNESS (convertible ~$0) |
| **H2** | Regression gate silent no-fire on import-time side-effect edits; zero-selection is silent | astropy-13236 (**644 P2P broken**, no `turn_regression` signal), 7606, 7166 — post-F20 binary | HARNESS (reach round 3) |
| **H3** | No patch-level sanity floor on escalated fixes | astropy-7166: oracle-tier patch edited `conftest.py`, unrelated to issue ($1.31, 189 turns) | HARNESS + judge scaffolding |
| **H4** | TB: no end-state finish gate; agent is clock-blind (deadline env never exported); terminal telemetry empty | TB at n=54: 13× clean-finish-reward-0; 9× AgentTimeout (16–62m — harbor enforcing the task's OWN `task.toml` budget while `ECON_TASK_DEADLINE_MS` is unset); `meta_json.telemetry` null on every TB row | HARNESS (ops) + INFRA |
| **H5** | Ecosystem-adapter layer unbuilt — gates are still Python/Django-shaped | Every new surface (shapely, linkding, TB, astropy io) costs a forensics cycle to re-learn | HARNESS (architecture) |
| **H6** | All gate coverage is post-mortem; no proactive red-team of gates | Every fix wave 0713→0719 was provoked by observed reds | PROCESS |
| **H7** | `models.md` Part II documents retired bindings (qwen3.7-plus conductor, GLM-only oracle) | Live registry: minimax-m3 / gpt-oss-120b / deepseek-v4-pro / glm-5.2 | DOC DRIFT |
| **H8** | No differential regression baseline: pre-existing env reds conflated with model-induced reds; neighbor-subset green treated as suite-level clearance | astropy-8707/8872 (round 2): arena numpy drift (`np.int` removed ≥1.20) burned turns on env noise; 8872's 3-file neighbor subset went `regression_green` while the graded suite broke **80 P2P** | HARNESS (new class) |
| **H9** | Tier-2 deferral triggers designed but never wired into the escalation gate | django-11265 (2× hub bounce on high coupling, 22-turn finish), 10097 (`probe_gate_exhausted`), 10999 (`repro_unresolved`) — all conductor-only, gate never opened | HARNESS (routing) |
| **M1** | Oracle tier model quality on the hard tail | 6 of top-8 spenders on the live run are escalated FAILS | MODEL (tier strategy, §4) |
| **M2** | Two solve rungs above conductor create rung-climbing waste | 11880: six judge rungs reasoner→oracle, byte-identical patch, +$0.50 | MODEL/ROUTING (§4.3) |

---

## 2. Implementation designs (H1–H4, H7 — this wave)

### H1 — Full-set + roundtrip witness enforcement (top priority: 5/9)

**Design.** Three additive teeth on existing machinery:

1. **All-witness single-run contract.** The repro seed contract (T1 extractor output,
   `extractIssueExpectations`/`extractIssueThresholds`, `session/prompt.ts:3634-3643`) gains a
   rule: every extracted witness is asserted in ONE `repro_issue.py` execution, each reporting
   individually (`witness[k]: PASS/FAIL`). The repro-fidelity judge
   (`session/repro-fidelity-judge.ts:175`) receives the extracted witness list and rejects a
   repro asserting a strict subset. Finish-time re-check (RF-8 seam) re-runs the all-witness
   check, not first-witness. Converts 14369 ("settled on 2/3 cases") deterministically.
2. **Roundtrip witness synthesis.** At seed time, if the focus entity's class/module exposes a
   serialize/write/format counterpart to the read/parse path being edited (graph query:
   sibling entities matching read↔write name pairs in the same file/class — BunSqliteGraph,
   no new index), the seed demands a roundtrip assert (`parse → write → parse == original`).
   Converts 14365 (parse-only fix), 14598 (inverted unescape), 14182 (param never threaded —
   write path reads it back).
3. **Deterministic full-F2P harvest when visible.** When the task carries harness-visible
   failing tests (benchmark F2P list, or a red test run the agent itself produced), the finish
   gate requires the *set*, not the first.

**Validation:** unit fixtures from the 5 live failure traces; replay the 5 instances
(strip-the-future rules); mini-10 must hold 10/10.
**Effort:** ~1–1.5 days. **Cost shape:** ~$0 (one extra repro execution per fix turn).

### H2 — Regression reach, round 3: side-effect heuristic + fail-loud + execution repricing

**Root cause.** F20 walks reverse-call edges from touched *entities*. A module-level
`DeprecationWarning` (13236) is an import-time side effect — its blast radius is "everyone who
imports the package", which the entity call graph cannot see. Zero neighbors → gate silently
passes. Same silence on 7606/7166.

**Design.** In `session/regression-neighbors.ts` (F20 seam):

1. **Import-time side-effect heuristic (deterministic AST check).** If the edit adds/changes
   module-level executable statements (warning emission, global mutation, import
   side-effects, class-decorator changes) → selection widens to the touched module's full
   test file + the package's test files, capped (e.g. 5 files).
2. **Fail-loud on zero selection.** A non-trivial code edit whose regression lane selects zero
   tests emits a converting signal (per the no-advisory-signals rule,
   [path-to-85 §5](./path-to-85.md#5-one-framework-benchmark-real-repos-and-human-in-the-loop)):
   fall back to the touched file's sibling test file, or surface "unverifiable regression
   surface" into the finish summary.
3. **Reprice execution.** Test *selection* was optimized as if running tests were expensive —
   but execution costs CPU-seconds, not tokens, and it is the cheapest verification we own.
   New default: when in doubt, run more tests. Bound by wall-clock (e.g. 120s selection
   budget), never by "cleverness of selection".

4. **Subset-green is bounded evidence, never suite clearance (round-2 addendum).** 8872's
   3-file neighbor subset went `regression_green` while the graded suite broke 80 P2P tests.
   When the edit class is high-P2P-breadth (module-level change, dtype/default-behavior
   change, base-class edit), a green neighbor subset upgrades selection to the package level
   (bounded) instead of promoting to green — and the finish summary states the verified scope
   ("N files checked"), never an implied "no regressions".

**Validation:** 13236 replay must go red at the gate; 7606 replay must catch
`test_compose_roundtrip`; 8872 replay must not promote on the 3-file subset;
shapely/linkding re-fire (still pending from F20/F21) rides along.
**Effort:** ~1 day. **Cost shape:** ~$0 tokens; +seconds of CPU per fix turn.

### H8 — Differential regression baseline (env-red ≠ model-red) — NEW, round 2

**Root cause (astropy-8707/8872).** The arena testbed itself was broken (numpy ≥1.20 removed
`np.int`; astropy's `_np_utils.pyx` fails at import). The agent conflated pre-existing env
reds with its own change — burning escalated turns chasing noise (8707, $1.01) — and the
gate had no way to distinguish "was already red" from "I broke it".

**Design.** When the regression lane first selects its test set for a turn, run that set ONCE
**before any edit is applied** (interpreter via F21 harvest; CPU-seconds, zero tokens). Cache
the pre-edit verdict per test. The gate's post-edit verdict becomes **differential**:
`new_reds = post_reds − pre_reds`. Pre-existing reds are reported to the model once, loudly,
as environment facts ("these N tests fail before your change — not yours to fix unless the
issue says so"), and excluded from deny decisions. Seam: `session/regression-neighbors.ts` +
the F11 gate consumer; storage rides the existing turn-state.

**Validation:** 8707 replay (agent must not chase `np.int`); false-fire audit on 5 resolved
astropy passes (baseline must not excuse genuinely model-induced reds — the subtraction is
per-test-id, not per-file). **Effort:** ~1 day. **Cost shape:** ~$0 tokens, +one extra test
run per turn (CPU).

### H9 — Wire the Tier-2 deferral triggers into the escalation gate — NEW, round 2

**Evidence.** Three conductor-only fails carried live structural-risk signals the gate never
consumed: 11265 bounced the hub edit-gate twice on high coupling and finished in 22 turns;
10097 hit `probe_gate_exhausted`; 10999 finished with `repro_unresolved`. The
[path-to-85 Tier-2 design](./path-to-85.md#tier-2--tail-only-spend-the-deferral-machinery)
(signal-gated second draw on denied-finish / unresolved-repro / 2nd-hub-bounce) names exactly
these triggers — they were never added to the deterministic escalation gate's trigger set.

**Design.** Add three deterministic triggers to the gate (`247cf53b3` lineage): (a) second
hub-gate bounce on the same turn, (b) `probe_gate_exhausted`, (c) `repro_unresolved` at
finish-intent. Each opens ONE bounded oracle draw (compiled brief + 12-step cap, §4.3) with
the termination rule from the Tier-2 caution (never chase evidence the environment refused —
H8's baseline supplies that fact). Route-determinism logging per §5.4.

**Validation:** 11265/10097/10999 replay (gate must open; conversion measured per firing);
trigger-rate audit on the 26 resolved instances (must stay rare — target ≤15% extra
escalations). **Effort:** ~0.5–1 day. **Cost shape:** tail-only; priced per firing.

### H3 — Patch-level sanity floor on escalated fixes (+ judge scaffolding upgrade)

**Design.** Two parts:

1. **Deterministic floor.** At escalated-patch acceptance: `files(patch) ∩ (files/symbols
   named in issue ∪ localization-probe candidates)` — empty intersection ⇒ one bounded deny
   with an enumerate-then-choose nudge (named definition sites). Test-infrastructure files
   (`conftest.py`, `setup.py`, CI configs) additionally require an explicit issue-text
   justification to be the *only* edited files. Would have stopped 7166's $1.31 hallucination
   at ~$0. Extends the V.7 hub-judge sanity floor to patch level; seam: the finish/hub gate
   neighborhood in `session/prompt.ts` (same injection pattern as the fidelity nudges).
2. **Judge scaffolding upgrade (before any judge-model upgrade).** Per the HackerOne finding
   (98% cross-model agreement once scaffolded): the cross-model verifier (`judge.ts:88`), the
   hub-design judge (`hub-design-judge.ts:211`) and the repro-fidelity judge get diff-aware
   inputs — unified before/after hunks, the issue's quoted expected/actual block, and the
   witness list from H1 — instead of prose summaries. This is prompt-side work on existing
   judges, no new calls.

**Validation:** 7166 replay; zero new denies across the 21 resolved instances' patches
(false-fire audit). **Effort:** ~0.5–1 day. **Cost shape:** ~$0.

### H4 — Terminal-Bench: end-state gate, time-budget teeth, telemetry

1. **End-state finish gate (ops-shaped turns).** At turn-open, derive a deliverable checklist
   from the instruction (deterministic extraction of file paths/artifacts/commands named as
   deliverables + turn-read goals). Before a final finish on `run-only`/`build` goal shapes
   (`turn-triage.ts:25-33`), verify each deliverable exists and, where the instruction names a
   check command, that it exits 0. Gate is bounded-reject-then-fail-open-loud. Targets the
   10× clean-finish-reward-0 class.
2. **Time-budget teeth.** `timeBudgetLine()` (`session/prompts/preambles.ts`, F09) currently
   informs. Add a T-minus checkpoint: at ~20% budget remaining, inject a converting nudge —
   "checkpoint now: make the current best end-state verifiable and stop exploring". Also close
   the F09 residual: `OPS_PLAYBOOK` must ride the null-turn-read path exactly as the deadline
   line does ([09-ops-hands.md](../features/09-ops-hands.md), degrade-path fix precedent).
3. **Terminal telemetry fix (infra, unerr-benchmarks repo).** TB rows ship empty
   `meta_json.telemetry` — the terminal adapter (`e2e/distributed/tools/harness_terminal.py` /
   worker artifact reader) never harvests the econ event stream. Until fixed, TB cost and tier
   attribution are blind. Small, but blocks all TB cost claims.
4. **Deadline wire (round-2 finding — converts the whole timeout class).** The TB timeouts
   are harbor enforcing each task's OWN declared budget (`task.toml [agent] timeout_sec`,
   typically 900s) — not a raisable config. Our gap: `harness_terminal.py` computes
   `timeout_s` (line ~423) but **never exports `ECON_TASK_DEADLINE_MS`**, so the agent runs
   blind to the clock — no `timeBudgetLine()`, no pacing, no checkpoint (9 of 23 TB fails).
   Fix is one line: `env["ECON_TASK_DEADLINE_MS"] = now_ms + min(timeout_s, task_hint)·1000`
   — set it to the TASK budget, not the outer grace ceiling, so items 1–2 above actually
   activate under it.

**Validation:** replay 3 reward-0 TB tasks + build-pmars regression (must stay 4/4); telemetry
non-null on the next TB smoke. **Effort:** ~1–1.5 days across both repos.

> **Scope note (2026-07-19, investigated):** the deadline wire is **TB-only by design**. The
> SWE resolve path deliberately enforces NO per-instance wall-clock (`PER_INSTANCE_TIMEOUT`
> is a never-binding 24h grade-side cap; `run-benchmark.py --timeout` is dead code; the agent
> owns its own watchdog) — there is no real external budget to pace against, so exporting
> `ECON_TASK_DEADLINE_MS` there would be synthetic pacing pressure tied to no scoring rule.
> Do not "fix" this again.

### H7 — models.md drift (30 min)

Rewrite Part II §1/§3 tables to match the live registry (`model-registry.ts`,
`ECON_TIER_BINDING`): conductor=minimax-m3, executor=gpt-oss-120b, reasoner=deepseek-v4-pro,
oracle=glm-5.2, judge=`ECON_VERIFIER_JUDGE` (default reasoner, OFF-able). One home per fact:
the registry is the source of truth; models.md narrates it.

### 2.7 — The kernel decision: invariants, not gates (2026-07-19)

**The observation that forced it.** The harness has felt like endless reactive scaffolding
because each failure class got a bespoke mechanism at a bespoke seam. But laid side by side,
every mechanism we have ever shipped reduces to **five invariants**:

| Invariant | Existing mechanisms that are instances of it |
|---|---|
| **Evidence must cover the claim's scope** ("fixed" ⇒ all witnesses, both directions) | H1 witness breadth + roundtrip, RF-4/RF-8 typed fidelity, H2.4 subset-scope rule, H4 end-state gate |
| **Attribute only what your change caused** | H8 differential baseline, strip-the-future discipline, env-red vs model-red |
| **Every signal changes something** (convert / defer / surface, never advisory) | H9, no-advisory rule (path-to-85 §5), H2.2 fail-loud on zero selection, escalation gate |
| **Escalation is bounded and terminates** | rung caps, 12-step compiled brief, Tier-2 termination rule |
| **The verifier is never the producer** | cross-family judge tier (§4.3), H3 patch sanity floor, oracle-inversion escape |

**The decision.** Implement this wave's new gates as instances of a minimal shared
**claim–evidence contract**, not as three more standalone gates: an agent claim ("fixed",
"no regressions", "done", "addresses the issue") is a typed object carrying typed evidence,
and the gate check is generic — *does the evidence's scope cover the claim's scope?* H1's
witness list, H2/H8's verified-test scope, and H4's deliverable checklist are the first three
contract types. This is ~0.5 day of shape-work inside Days 1–2, **not** a framework rewrite —
the kernel ships as the shape of H1/H2/H8, or it doesn't ship.

**Why this is the honest "day-0" answer.** A harness encodes what counts as sufficient
verification over an open-ended task distribution; no finite up-front enumeration covers
that (every frontier lab's harness — including the one this repo forked — was built
iteratively). What CAN be had from day 0 is the kernel + the §3 proactive audits, so a new
failure mode lands as a new contract entry instead of a new mechanism. Our own history is
the proof of cost: regression reach took three rounds because each round patched an
instance of an invariant instead of the invariant.

**Durability rule (standing).** Every mechanism gets tagged one of two ways:
**model-agnostic verification** (execution, differential, masking, scope-checking — survives
every model upgrade; invest freely) or **cheap-model compensation** (exists only because the
current tier under-verifies; build reluctantly, delete eagerly as models improve). The
bitter-lesson trendline deletes the second category every few quarters — the first category
is the moat, and it is also exactly what transfers when the harness runs frontier models
(the model-agnostic-harness positioning).

**The generic layers above the kernel** (in order of arrival): the metamorphic-relation
library (§3 — covers failure *families* per relation, any ecosystem, via the H5 adapter
interface) → harness-as-optimization-object + step-level DPO on our logged decision pairs
(phase-2, [path-to-85](./path-to-85.md#phase-2-post-85-or-with-the-sovereign-path) — the
signal bus has been accumulating the labeled training data all along; the endpoint where
hand-coding judgment stops entirely).

---

## 3. Scheduled next (not this wave)

- **H5 — ecosystem-adapter layer** ([path-to-85 §4](./path-to-85.md#4-any-language-any-repo--the-ecosystem-adapter-layer-the-real-new-work)
  is the design): runner adapters (test-command discovery + red/green parsing), twin
  discovery, build-first discipline, per-language edge parity. This is the structural fix for
  "every new surface costs a forensics cycle". ~3–5 days; schedule immediately after this
  wave — it is the highest-leverage *non-reactive* item on the board.
- **H6 — proactive coverage (three mechanisms, upgraded from "red-team harness")**:
  1. **Gate red-team**: mutate gold patches into plausible one-sided/wrong-layer/env-conflated
     fixes (the live failure shapes are the mutation catalog) and assert the gates catch
     them. ~2 days; deferrable behind H5.
  2. **Signal-consumer audit (cheap, do with this wave)**: a static checklist/script over the
     signal bus asserting three invariants — every deterministic signal has a consumer
     (convert/defer/surface, the no-advisory rule); every gate has a fail-loud zero/exhausted
     path; every green verdict states its verified scope. Both round-2 classes would have
     been found by this audit *before* a benchmark found them: H9 is literally
     "signal designed, consumer never wired", H2's zero-selection silence is a missing
     fail-loud, and 8872's subset-promotion is an unscoped green. ~0.5 day, repeatable on
     every wave.
  3. **Failure-corpus CI**: freeze every autopsied specimen (27 and counting: 14 Verified +
     TB replays + shapely/linkding) as a standing replay corpus; every engine change runs the
     corpus and reports per-class conversion — in-sample by construction, but it turns
     "fixed" into a regression-guarded property instead of a claim.
- **Metamorphic-relation library (generalizes H1.2 beyond one hand-coded relation)**: a
  small catalog of relations — roundtrip (parse↔serialize, encode↔decode), idempotence,
  invariance-under-refactor, add↔remove symmetry — that the witness synthesizer draws from,
  keyed by the touched API's shape via the H5 adapter interface. One relation covers a
  failure *family* in any ecosystem, forever; H1.2's parse↔write rule becomes the first
  catalog entry rather than a special case. ~1–2 days, after H5's adapter interface exists.

---

## 4. Model strategy — tiers, judges, and the reasoner/oracle question

### 4.1 Current bindings (live registry, 2026-07-19)

| Tier | Model | Blended $/Mtok (10:1) | Role today |
|---|---|---|---|
| conductor | minimax/minimax-m3 | ~$1.63 (cached-in $0.06) | drives every turn |
| executor | openai/gpt-oss-120b | ~$0.63 | mechanical slices |
| reasoner | deepseek/deepseek-v4-pro | (verify price) | judge tier + solve rung |
| oracle | z-ai/glm-5.2 | ~$4.9 (GLM-4.7 proxy) | hard-tail solver |
| judge | `ECON_VERIFIER_JUDGE` → reasoner | — | cross-model verifier |

Measured spend split (live-500 head, n=40): conductor 52% / oracle 47% / executor 1%;
18/40 instances escalated (45%); 37% of oracle spend sits on unresolved instances. Repo
split at n=40: django 15/19 resolved (79%) at $0.27 mean vs astropy 11/21 (52%) at $0.46 —
the head is astropy-skewed; the full-500 lands between. Mini-10 regime: oracle share 14%.

### 4.2 What stays (evidence says don't touch)

- **Conductor = minimax-m3.** Conductor-only passes at $0.07–0.14 are the whole cost engine;
  its $0.06 cached-input price is the cheapest in the candidate set and most conductor volume
  is cache re-reads. No observed conductor-attributable failure class this run.
- **Executor = gpt-oss-120b.** 1% of spend; zero attributed failures; cheapest blended rate
  in the stack.
- **Deterministic-first judging.** The standing rule holds (cheap-judgment research,
  [path-to-85 §7](./path-to-85.md#7-explicitly-not-building)): no new in-loop cheap-model
  judges; deterministic gates convert, LLM judges verify narrow verdicts on the tail.

### 4.3 One solver + one judge — not two solve rungs (answers the reasoner/oracle question)

Do we need both reasoner and oracle? **As solve rungs, no. As functional slots, yes — with
different jobs.** The evidence:

- The intermediate solve rung is where rung-climbing waste lives (11880: six judge rungs
  reasoner→oracle for a byte-identical patch; the report's "bound rungs, not steps" lesson).
- The reasoner's *live* function is already cross-family judging (`ECON_VERIFIER_JUDGE`
  defaults to it; hub-design + repro-fidelity run there). A judge from a different model
  family than the solver is load-bearing — same-family self-preference is the classic failure
  (52pp self-preference in the judge literature).
- models.md already documents the slot-merge precedent (reasoner→oracle same model, kept as a
  slot for one-line re-separation).

**Decision:**

1. **Collapse the solve ladder to one hop: conductor → oracle.** The deterministic escalation
   gate (`247cf53b3`) already decides escalation on harness-seeded signals; route its "open"
   verdict straight to the oracle with a bounded draw (compiled brief + 12-step cap — the two
   turn-economy survivors). No intermediate maybe-rung.
2. **Keep the reasoner slot, re-scoped as the judge tier only** (cross-family verification:
   hub-design, repro-fidelity, cross-model verifier, H3 scaffolded judges). It never solves.
3. **Per-tier disable switches.** `ECON_VERIFIER_JUDGE=OFF` already exists; add the same
   config surface for the oracle (degrade = conductor-only + surface unresolved) and the
   judge tier (degrade = deterministic gates only). Four slots stay in the registry —
   disabling is config, re-binding is one line, no re-plumbing (the models.md reversibility
   principle).

### 4.4 The oracle swap (the one model change the data demands)

Escalated open-weight oracles (glm-5.2 + deepseek-v4-pro rungs) failed 3 of 4 touched
instances; ~half of oracle spend bought nothing. Swap the **oracle binding only** to a
frontier model, benchmark-matched per the tail-swap research (Opus-class for
Verified/Pro patch work — also the only judge with 100% verdict consistency in the HackerOne
study; GPT-5.5-class for Terminal-Bench, where it leads at 82.0%):

| Candidate oracle | Blended $/Mtok | vs glm-4.7 proxy (r) | Notes |
|---|---|---|---|
| Claude Opus 4.8 | $8.14 ($1.36 @ 90% cache-hit) | ~1.7 (≤1 cached) | needs explicit `cache_control` on our gateway path |
| GPT-5.5 | $11.00 | ~2.3 | TB leader; verdict-consistency concerns as judge |
| Claude Sonnet 4.6 | $4.64 | ~0.95 | cost-neutral hedge; weaker tail reach |
| Gemini 3.1 Pro | ~$2.91 | ~0.6 | **price-parity ≠ capability-parity**: 80.6% Verified / 46.1% Pro — the same ~80 plateau our current oracle sits on; a lateral solve-capability move that doesn't address the observed conversion failure |
| Grok-4.x | ~$2.25 | ~0.5 | same plateau caveat on Verified (72–75%, self-report); but strong TB self-report (83.3%) at 1/5th GPT-5.5's price → **legitimate A/B arm for the TB oracle binding only**; verify current model id/pricing before binding |

**Price-parity frontier ≠ capability-parity frontier.** The frontier-lab models at
open-weight prices (Gemini Pro, Grok) sit on the same ~80% capability plateau as the
open-weight oracles that just failed 3 of 4 escalations — cheaper lateral moves, not tail
fixes. The swap's justification is the 88-class (Opus/GPT-5.5), and with rung-bounding +
caching the Opus arm nets out ≈ cost-neutral anyway (§5.1) — so effective price, not list
price, is the deciding column.

**Per-benchmark oracle binding (decision, 2026-07-19).** The oracle is bound per surface,
through the registry (a named binding profile per run config; only the registry maps
profiles to model ids — tier-speak rule; the drift test must recognize the override
surface, no ad-hoc env hacks):

| Surface | Oracle | Status |
|---|---|---|
| SWE-bench Verified / Pro / Live + interactive product | **Claude Opus 4.8** | decided, pending swap A/B; **prerequisite resolved: bind direct-to-Anthropic, not via the gateway** — see the cache_control resolution below |
| Terminal-Bench | **Grok-4.x pending A/B vs GPT-5.5** on the 23-task TB fail replay set — bind Grok if within ~2pp (cost doctrine); its 83.3% TB is self-reported, so it is not bound on faith (§5.4 rules); verify current model id/pricing first | A/B in Day 4–5 validation |
| Sovereign / air-gapped lane | GLM-class (open-weight) binding stays available as a profile — the in-region path requires an all-open-weight stack; config choice, not a deleted code path | standing |

Cross-family check: the judge tier (deepseek-v4-pro) is cross-family against both oracle
arms — the verifier-independence invariant (§2.7) holds with no judge re-binding.

**cache_control resolution (researched 2026-07-19): direct Anthropic, not LiteLLM.**

- *Why nothing caches today:* OpenCode's `applyCaching`
  (`packages/opencode/src/provider/transform.ts:323`) already emits `cache_control` for
  anthropic/openrouter/bedrock providers, but the gate at `transform.ts:433-445` skips any
  provider with `api.npm === "@ai-sdk/gateway"` — and every econ tier is
  `providerID: "litellm"`. The gateway config
  (`unerr-benchmarks/infra/litellm/config.yaml`) is a dumb pipe with no
  `cache_control_injection_points`. Neither side emits a marker.
- *LiteLLM pathway — possible but disqualified on accounting.* The proxy does forward
  explicit `cache_control` (both wire formats) and can auto-inject via
  `cache_control_injection_points`, but cache accounting through it is broken per open
  issues: `cache_read_input_tokens` never normalized into OpenAI-format `cached_tokens`
  (BerriAI/litellm#27763), cached-token cost miscalculation (#11364, #9812), and an
  injection bug that stamps every content block and trips Anthropic's 4-breakpoint limit
  (#15696). Observability is the product surface and the Opus arm's cost-neutrality claim
  rests on measured cache reads — un-meterable caching fails the same day-0 gate that
  caught the OpenRouter bug.
- *Direct pathway — chosen, near-zero code.* Bind the Opus profile in `model-registry.ts`
  with `providerID: "anthropic"` (npm `@ai-sdk/anthropic`); the transform gate then passes
  and `applyCaching` fires natively. Telemetry needs no change — `ai-sdk.ts:64` reads both
  `cached_tokens` and `cache_read_input_tokens` — and $-metering is engine-side (registry
  cost keys), so bypassing the gateway loses no accounting.
- *Anthropic facts (mid-2026):* explicit `cache_control` still required (plus a newer
  top-level auto-moving-breakpoint mode); 5-min TTL = 1.25× write / 0.1× read, 1-hour =
  2× write / 0.1× read; min cacheable prefix 1024 tokens on Opus/Sonnet; max 4
  breakpoints per request. Benchmark turn cadence sits well under 5 minutes, so the
  default ephemeral TTL suffices — no 1h beta header needed.
- *TB arms need no marker wiring:* OpenAI (GPT-5.5) and xAI (Grok) prompt caching is
  implicit server-side — no `cache_control` equivalent to thread through.
- *Residual work:* `ANTHROPIC_API_KEY` on fleet workers + a 1-instance smoke asserting
  nonzero `cacheRead` in the receipt before the swap A/B.

**Prerequisite: rung-bounding (§4.3) ships first** — one strong bounded draw replaces today's
multi-rung climb, which is where the price ratio gets paid back.

### 4.5 Judge assignments after this plan

| Judge | Model/tier | Change |
|---|---|---|
| turn-read (`turn-triage.ts:648`) | conductor | none — per-turn, must stay cheap |
| hub-design, repro-fidelity, cross-model verifier | judge tier (deepseek-v4-pro) | H3 scaffolding upgrade (diff-aware inputs) |
| deferral-tail patch selection (two-candidate) | oracle (frontier, post-swap) | fires only on deferral, ~$0.01–0.05/instance amortized |
| M4/fidelity/regression/escalation gates | deterministic | unchanged — primary line of defense |

---

## 5. Cost model & estimates

### 5.1 Suite-cost multiplier (parameterized on measurements)

`M = (1−o) + o·r·u` — o = oracle spend share, r = frontier/current oracle price ratio,
u = turn-efficiency factor from rung-bounding (fraction of today's escalated turns a single
bounded draw uses).

| Scenario | o | r | u | M |
|---|---|---|---|---|
| mini-10 regime, Opus oracle, bounded | 0.14 | 1.7 | 0.6 | **1.00** (cost-neutral) |
| full-500 mid estimate, Opus, bounded | 0.30 | 1.7 | 0.6 | **1.01** |
| full-500 mid, Opus, no bounding | 0.30 | 1.7 | 1.0 | 1.21 |
| astropy-head worst case, Opus, no bounding | 0.47 | 1.7 | 1.0 | 1.33 |
| GPT-5.5 oracle, mid, bounded | 0.30 | 2.3 | 0.6 | 1.11 |

Honest range: **+0–35%**, with the bounded-Opus cases ≈ cost-neutral because rung-bounding
refunds the price ratio. Anthropic caching (90% off cached input) can push r below 1 on our
cache-heavy profile — but only after explicit `cache_control` is wired on the gateway path
(known gap). All figures need the §5.4 validation before being quoted.

### 5.2 Per-instance and per-run projections

| | Measured now | Post-wave (H1–H4 + swap) | Frontier-agent reference |
|---|---|---|---|
| $/instance (Verified) | $0.245 (mini-10) – $0.36 (astropy head) | ~$0.25–0.45 | Opus mini-10: $0.90/inst; public frontier agents ~$1.5–2.5 |
| Full-500 run | ~$120–180 | ~$130–220 | ~$750–1,250 |
| Score trajectory | 62% @ n=34 (head-skewed, climbing) | mid-80s target (H1+H2 convert 4–6 of 9 observed fail classes; oracle swap targets the rest) | 88.6–88.7 plateau |

The strategic frame holds: **~1/5th of frontier-agent cost at a top-5 score** is the design
point; H1–H4 buy pp at ~$0, the swap buys the tail at ≈ cost-neutral-to-+35%.

**Expected-gain attribution (in-sample, head n=40 — replay validation gives the real
number).** Bucketing the 14 autopsied fails by conversion confidence: ~6 high (mechanism
directly closes the observed gap: 14369, 14365, 14598, 7606, 10999, 10097), ~6 moderate
(mechanism fires, model must still land a nontrivial fix: 13236, 14182, 8872, 11265, 7166,
10973), ~2 low (13398 frontier-tail, 8707 env/grader-uncertain). Expected converts
≈ 6·0.8 + 6·0.5 + 2·0.25 ≈ **8 of 14** → head 65% → ~85%. Suite-wide, discounted for
in-sample optimism and the django middle already resolving at 79% untreated: **+6–10pp
expected on Verified** (per-class: H1 +3–4, H2+H8 +2–3, H9+swap +2–3, H3 +0.5–1, overlaps
netted), landing in path-to-85's 83–88 expected band with the 2–5pp benchmark noise floor
capping "consistently". TB: deadline wire + end-state gate target 22 of 23 observed fails;
**+10–15pp expected** (57% → high-60s/low-70s), more uncertain because reward-0 tasks are
domain-capability-heavy.

### 5.3 Engineering + validation spend

| Item | Effort | Validation spend |
|---|---|---|
| Kernel shape (claim–evidence contract, §2.7) | 0.5 d (inside H1/H2/H8 days) | rides their replays |
| H1 witness breadth | 1–1.5 d | 5-instance replay + mini-10 ×1 ≈ $4–6 |
| H2 regression reach | 1 d | 3-instance replay + shapely/linkding re-fire ≈ $3–5 |
| H3 sanity floor + judge scaffolding | 0.5–1 d | 7166 replay + 21-patch false-fire audit ≈ $2–3 |
| H4 TB gate + telemetry + deadline wire | 1–1.5 d | 3 TB replays + build-pmars ≈ $3–5 (unknown until telemetry lands) |
| H8 differential regression baseline | 1 d | 8707 replay + 5-pass false-fire audit ≈ $3–5 |
| H9 deferral triggers → escalation gate | 0.5–1 d | 11265/10097/10999 replay + trigger-rate audit ≈ $4–6 |
| §4.3 ladder collapse + switches | 0.5 d | rides the swap A/B |
| §4.4 oracle swap (flagged) | 0.5 d | 13-fail replay A/B ×2 draws ≈ $15–25 |
| Full validation gate | — | mini-10 ×3 band ($8–11) + full-500 ×1 ($130–220) |
| **Total wave** | **~7–9.5 days** | **~$180–300** |

### 5.4 Measurement rules (inherited, binding)

Per [path-to-85 §6](./path-to-85.md#6-measurement-plan-nothing-above-is-claimed-until-these-run):
≥3-run bands for any cost claim; route determinism logged per decision; reference runs get
strip-the-future + real grading; single runs are smoke. The oracle swap additionally reports
per-firing cost (not trigger-rate assumptions) and conversion rate on the replayed fail set.

---

## 6. Sequencing (one week, agent-built)

```
Day 0     H4.4 deadline wire (one line, unerr-benchmarks) — before the next TB campaign
Day 1     H1 (witness breadth) + H7 (models.md)          [worker-tier slices]
Day 1–2   Kernel shape (§2.7): H1/H2/H8 land as claim–evidence contract instances
Day 2     H2 (regression round 3, incl. subset-scope rule) + H8 (differential baseline)
Day 3     H3 (sanity floor) + H9 (deferral triggers)
Day 3–4   H4 (TB end-state gate + telemetry, both repos)
Day 4–5   §4.3 ladder collapse + disable switches; oracle swap behind flag
Day 5–6   Validation: replays (now 14 specimens), mini-10 ×3, TB smoke; swap A/B on fail set
Next week H5 adapter layer (3–5 d); H6 red-team harness (2 d, deferrable)
Gate      Full-500 at new HEAD + band → only then quote numbers
```

## 7. Explicitly declined (this round)

Blanket best-of-N (standing) · per-turn frontier judge (cost, and H3's scaffolding finding
makes it unnecessary) · judge-model upgrade before judge-scaffolding upgrade · a fifth tier
slot ("verifier-oracle") — the four slots + switches cover it · trained conductor (phase-2,
unchanged) · **a standalone kernel-framework project** — the §2.7 kernel ships only as the
shape of H1/H2/H8 (~0.5 d); an up-front contract-system rewrite before those gates exist
would be architecture ahead of evidence, the exact failure mode this plan bans · the
thin-pipe pivot (no-harness maximalism) — only works at frontier capability, i.e. the
anti-economics choice; E1 stays the yardstick, not the design.
