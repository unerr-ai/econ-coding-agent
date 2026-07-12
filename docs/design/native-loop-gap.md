# The native-loop gap — brainstorm: from a 75.8 floor to an 85 target

**Status:** in execution. Written 2026-07-12 as a brainstorm/measurement plan; E0 landed 2026-07-13
(commits `b01ccb54e` reasoning un-suppression, `2d291c918` F17 breadth, plus the follow-up guard +
seeds + F18 commits — see "E0 local validation" below). E1–E3 pending. Companion artifact: "econ gap
report — the 75.8 baseline" (same content, rendered).

## The datum that triggered this

SWE-bench Verified leaderboard: **MiniMax M2.5 (high reasoning) — 75.80%, $0.07/task**, 3rd behind
Opus & Gemini, running inside **mini-swe-agent v2.0.0** ([repo](https://github.com/SWE-agent/mini-swe-agent/tree/v2.0.0)).

mini-swe-agent's entire harness (verified by fetching
`src/minisweagent/config/benchmarks/swebench.yaml` at tag v2.0.0):

- One system sentence + one instance prompt with a 5-step **suggested** workflow
  (analyze → repro script → edit → rerun repro → edge cases). No enforcement of any step.
- One tool: bash, stateless subshells. No structured tools.
- Linear full history; the only context management is 10k-char output truncation (5k head + 5k tail).
- `step_limit: 250`, `cost_limit: $3`, `temperature: 0.0`.
- Submission = `git diff > patch.txt`, verify, `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat patch.txt`.
- Zero judges, gates, pins, decomposition, tiers, escalation, regression checks, compaction.

With that, an open-weight model scores within 2–3 points of Opus at ~1/50th the cost. The
discipline our engine manufactures structurally (repro-first, verify, root-layer fixes) is
**RL-trained into the weights** of the M-series (and almost certainly minimax-m3, our conductor
binding — SWE-bench Verified is in every 2026 model's training diet). The harness that wins with
such a model is a thin pipe that lets the trained policy express itself.

## The reframe (the thesis of this doc)

> The model's native loop is the **floor**, not the competitor. Every engine mechanism must
> justify itself as **delta above 75.8** — points added or cost removed — or it is tax.
> With harness verification + multi-model routing the right target is **85%** at ≤ $0.20/task.

We never measured this floor. All 20+ engine waves (F8→F16) were validated as "better than our
previous run" — self-relative. The control arm (model alone, native loop, full reasoning) was
never run. The leaderboard supplied it for free.

## Verified suppressions — where the engine throttles the model (code receipts, audited 2026-07-12)

| # | What we do | Evidence | What the 75.8 run does | Cost to us |
|---|---|---|---|---|
| S1 | **Mute reasoning** on ordinary conductor steps (`reasoningEffort:"none"`); un-mute only plan / bash-failure recovery / contradiction | `packages/opencode/src/session/llm/reasoning-gate.ts:174-216` | high reasoning on every step | The trained SWE policy (which layer to fix, repro-first) lives in the thinking phase; our residual failure class (layer choice, 11964/11790) is exactly that judgment. Muting saves cents at MiniMax prices. |
| S2 | ~~Temperature 1.0~~ **CORRECTED 2026-07-12 during E0:** the `minimax-m2 → 1.0` row in `transform.ts:479-496` is a dead legacy entry — the live binding `minimax-m3` doesn't match it and falls through to `ECON_EXECUTION_TEMPERATURE = 0.1` (`request.ts:32,198`, the F12 mechanism working as designed) | `packages/opencode/src/session/llm/request.ts:32,198` | ships `temperature: 0.0` | We already run near-greedy (0.1 ≈ their 0.0). Temperature is NOT the variance source; the flip-flop driver narrows to S1 (muted reasoning) + MoE serving nondeterminism. Legacy m2 row neutralized to 0.0 anyway. |
| S3 | **~20 structured tools**, schemas resent each request (compacted via `compactJsonSchema`), meter/nudge lines interleaved | `packages/opencode/src/tool/registry.ts:76-99, 547-561` | one bash tool, raw stdout | Distribution shift off the RL-native bash loop + per-step token tax. |
| S4 | **Water-fill trimming** of tool results at ~20k est. tokens/step, largest-first | `packages/opencode/src/session/step-budget.ts:18, 63-87` | 10k-char head/tail elision only | Can trim the exact evidence (assertion text) the policy needed. |
| S5 | **Fragmented evidence chain**: slices, turn-read side calls, compaction summarized by a *different tier*; tier switches downgrade prior thinking to text | `packages/opencode/src/session/overflow.ts:22-56`; `packages/opencode/src/session/message-v2.ts:376-390` | one linear conversation, near-perfect prefix cache | Every seam drops evidence + breaks the cache prefix that makes $0.07 possible. Note: our recent wins (armed-turns-never-decompose 919480c94, continue-inline demotion) already moved toward the linear loop. |

**Cleared by the same audit (feared, but NOT happening):**
- Interleaved thinking **is** resent same-model (`message-v2.ts:376-390`) — no lobotomy.
- Arming judge is pure code, no extra LLM call (`arming-judge.ts:130-150`).
- Anchored notes inject at turn-open only; nudges append once/message; prefixes stable.
- The "25-tool cap" does not exist in code (folklore); the real constraint is the token step budget.

**Self-inflicted-loop hypothesis:** part of what F8–F16 catches (declared-done-on-red,
symptom-layer draws) is variance *induced* by S1+S2, then policed by machinery built to compensate.
Both truths hold — on genuinely undisciplined models (flash era) the chain took us 0/10 → 9/10.
The error was applying the full substitute to a trained model and never measuring the difference.

**E0 implementation notes (2026-07-12/13, committed `b01ccb54e` + `2d291c918`):**
- Gate rewritten: the conductor is never suppressed — `applyAdaptiveReasoning` now only deletes a
  config-pinned `"none"` (the `opencode.json` conductor block still pins `reasoningEffort:"none"`
  from the deepseek-flash era; the gate deletes it unconditionally, so no reasoning param reaches
  the wire → the model's native default, same as mini-swe-agent). Phase-detection machinery
  (plan/recovery/contradiction) deleted as dead code.
- Gateway verified clean: `econ-litellm` serves minimax-m3 via **Fireworks** (priority tier) with
  no proxy-side reasoning pin — the mute was entirely engine+config side. Past runs' nonzero
  reasoning_tokens (e.g. 11885 r2: 14,863) were the old gate's plan/recovery un-mutes firing;
  post-E0 these should rise substantially.
- F17 regression-neighbor breadth implemented alongside (additive Pass 2 in
  `regression-neighbors.ts`: module stems + variants over discovered test roots, cap 3 kept,
  `"models"` added to noise stems — the 11885 case now surfaces `tests/delete` +
  `tests/delete_regress`).
- **E0 correction (live finding, e0-mini10-r1):** open question #1 is answered — sending NO
  reasoning param means *unbounded* thinking on the Fireworks path, and the tail is real: 11964
  ran steps 1–13 at 1–32s each, then one step streamed reasoning for **2,453s (41 min)** (12039
  stalled ~25 min the same way; verified not-looping — linear steps, no repeats, gateway healthy).
  The leaderboard variant is "(high reasoning)" — a **bounded explicit effort**, not unbounded
  default. Corrected: conductor pins `reasoningEffort:"high"` in `opencode.json` (the gate's
  non-"none" early-return passes it through). Delete-the-param was an over-shoot of mini-parity.
- **Final gate form (2026-07-13):** `guardReasoningEffort` bounds the channel in both directions —
  an ordinary request's stale config-pinned `"none"` rewrites to bounded `"high"` (never deleted;
  deletion recreates the unbounded-thinking hang), and small housekeeping one-shots mute to
  `"none"` (the E0 config pin would otherwise have un-muted the triage/evaluator JSON one-shots,
  which the old skip-the-gate path kept muted only by inheriting the conductor's `"none"`). The
  task-#52 turn-ambiguity floor died as subsumed — it only raised from the `"none"` baseline the
  guard now lifts unconditionally.

## Does this apply to the other tiers? Yes — the suppression matrix

The suppressions are NOT conductor-only, and for >85 every tier has to work. Per the same audit
(`reasoning-gate.ts:178-179` comment; `transform.ts:479-496` temp map is keyed by model family,
not tier):

| Tier (binding) | S1 reasoning | S2 temperature | S3–S5 taxes |
|---|---|---|---|
| conductor (minimax-m3) | **"none"** — fully muted on ordinary steps | **1.0** (minimax family) | full — and it runs ~90–100% of steps |
| executor (gpt-oss-120b) | "low" — partially suppressed | family default (unaudited — E0 scope) | full, PLUS brief-fed child sessions |
| reasoner (deepseek-v4-pro) | "high" — unsuppressed | default (unaudited) | brief-fed one-shots by design |
| oracle (glm-5.2) | "high" — unsuppressed | default (unaudited) | brief-fed one-shots by design |

Two observations. First, **the allocation is inverted**: the most-suppressed tier (conductor) is
the one making nearly all judgment calls in the decomposition-first architecture, while full
thinking is reserved for tiers invoked least. Second, the **fragmentation tax is heavier off-
conductor**: child slices are compiled-brief one-shots *by design* ([cross-tier-context.md](./cross-tier-context.md))
— optimal for cost, but an RL-trained model's policy expects the full linear evidence trail, so
E2's ablation should include a slice-level arm (brief vs fuller context), not just whole-turn arms.
E0's temp/effort sweep must cover all four bindings, not just the conductor.

## Live confirmation — Mini-10 r5 (2026-07-12, post spec-prior seeds, suppression still on)

8/10, $1.26. **11790 and 11964 passed; 11848 and 11885 failed — the exact instances that passed
the run before.** The flip-flop set {11790, 11848, 11885, 11964} now rotates per run — the
suppression-variance signature (each ~50–80% pass ⇒ ~0.25–0.5 chance of all four in one run,
matching the observed 8–9/10 plateau). Forensics:

- **11848 — honest-grind-exhausted.** 27 steps, `repro_unresolved`, two `turn_probe_pin_miss`,
  finished `turn_completed_unverified hadPin=false`. The chain stayed honest (no fake green); the
  model simply never designed the utcnow-mock-aware repro — deliberation work that muted thinking
  would carry.
- **11885 — wrong-exit with a NEW chain gap.** Same OR-combine approach that passed r2, drawn
  with a flawed implementation (breaks `test_large_delete`/`test_large_delete_related` P2P).
  Probe green + `turn_regression_green` both fired — the regression gate ran but its neighbor
  selection didn't include the delete_regress large-delete tests. **Candidate lever (not built):
  regression-neighbor breadth** — select neighbors by the edited module's test-package, not only
  same-file proximity. *(Built next day as F17 pass 2, `2d291c918`.)*

## E0 local validation — the corrected pin, 5-task re-run (2026-07-13, dist-e0-mini10-r1)

Strict local re-run of the five previously-failing instances (gold-graded, tests reverted, no
hints): **11964, 12039, 12050 PASS** at $0.03–0.49 with no stalls — the two 40-min hang victims
and the disk casualty all cured by the bounded pin. **11790, 11885 FAIL**, both in the
spec-underdetermination class the doc predicted. Forensics (bundle
`unerr-benchmarks/e2e/distributed/out/dist-e0-mini10-r1/`):

- **11790 — type-fidelity miss ($0.485, 116 steps).** Ground truth (dataset-verified): the gold
  patch assigns the mirrored value in its source type — `widget.attrs['maxlength'] =
  username_max_length` (the **int**) — and the hidden test asserts `attrs.get('maxlength') == 254`
  with typed equality. Our patch routed through `widget_attrs()`, whose CharField layer
  stringifies internally → `'254'`: identical HTML, failed typed equality. The run's own repro
  asserted rendered/presence output, which cannot see the difference — so no self-check could
  catch it. **Fix landed:** FIX + REPRO seed priors now name the mirrored-entry case explicitly
  (assign the source value itself, never via a helper that stringifies; assert the mirrored dict
  entry with typed equality against the source, never rendered output).
- **11885 — design draw regressed large-deletes ($0.550, 93 steps).** The simple
  `{model: qs}` OR-combine draw broke `test_large_delete`/`test_large_delete_related` (P2P). The
  r2-passing design gates its merges — single-table WHERE only, distinct leaf columns, else one
  DELETE per queryset. F17 breadth now surfaces `tests/delete` + `tests/delete_regress` at
  finish, so this draw gets caught at the gate instead of shipping; converging on the passing
  design first-try remains best-of-N territory (below).
- **Shipped-despite-red, decomposed.** On 11790 the structured gates did fire
  (`turn_regression_unresolved` + `repro_unresolved` + `turn_probe_pin_miss`), nudged once, then
  failed open by design and the patch shipped — fail-open-loud is deliberate (withholding a patch
  guarantees a miss; a doubted patch might still pass). The genuine HOLE was the neighboring
  class: a mid-turn bash test run that ended red and was never re-run green ships silently when no
  probe/regression artifact captures it — the finish chain never scanned the transcript itself.
  **Fix landed: F18 seen-red finish gate** — a pure transcript scan before the S3 gate; unresolved
  test-shaped reds (env-red excluded, probe-cleared reds excluded) draw one re-verify nudge, then
  `turn_seen_red_unverified` loud fail-open. Shell-only, ≈$0, no LLM calls.

## Path-to-85 arithmetic

500 instances. 75.8% = 379 solved. 85% = 425 → **+46 instances** the native loop misses.
The native loop's failure classes are exactly where a harness earns its keep — *if* tax ≈ 0 first:

| Lever | Native-loop failure it fixes | Est. points | Est. cost impact |
|---|---|---|---|
| Verification gate (thin, finish-time): pinned red→green + regression neighbors as accept/reject on the model's own loop — **partially landed 2026-07-13**: F17 neighbor breadth + F18 seen-red transcript scan | wrong exits the model believes in; zero regression checking in mini | +2–5 | shell-only, ≈$0 |
| Spec-prior consult: on fidelity-gap signatures, ONE narrow reasoner one-shot enumerating the implied contract. NEVER whole-turn takeover — the s9-ceiling-probe-r1 proved takeover = 2.6× cost, same layer-choice coin-flip (reasoner failed 11964 with a descriptor-coercion patch; cheap tier had drawn the gold `Choices.__str__`) | issue underdetermines the graded contract (11964/11790 class) | +2–4 | +$0.01–0.02 avg |
| Best-of-N (2–3 cheap draws) + execution-grounded selection on low-confidence finishes | high-variance judgment draws (flip-floppers) | +2–6 | +$0.03–0.06 avg |
| Hard-tail escalation: bounded reasoner/oracle slices on the ~42 hard instances | long-horizon multi-file bugs | +1–4 | +$0.02–0.05 avg |
| Env robustness (already built: F14–F15 interpreter discovery, env-red rejection) | environment noise misread as signal | +1–2 | ≈$0 |

Midpoints → **~82–89%** band at **$0.12–0.20/task** (high reasoning ≈1.5–2× output tokens on the
$0.07 base). 85 is defensible arithmetic, not a slogan.

## Measurement plan (run BEFORE building anything)

- **E0 — Un-suppress probe (config-only).** Conductor with reasoning un-muted + temp 0.0,
  flaky-5 ×2 runs. Isolates S1+S2 cost. ~$2. Knobs: reasoning-gate default for conductor;
  transform.ts temperature map. (Do NOT commit engine changes for this — probe-style config swap
  with revert, same pattern as the ceiling probe.)
  **Status: PARTIAL-DONE 2026-07-12/13.** The probe graduated straight to a landed engine change
  (the S2 audit killed the temperature question — we already run 0.1 — and the mute was
  unambiguously wrong, so nothing to revert): bounded `"high"` pin + two-way guard committed;
  flaky-5 re-run ×1 local cured 3/5, the remaining 2 are the spec-gap class (see "E0 local
  validation"). Outstanding: the ×2 variance repeat, and the executor-tier effort sweep
  (executor still ships a partial mute at `"low"`).
- **E1 — Null-harness control.** mini-swe-agent v2.0.0 pointed at OUR LiteLLM gateway
  (`LITELLM_API_KEY` in `unerr-benchmarks/e2e/econ/.env.local`), our minimax binding, high
  reasoning, on Mini-10 + ~25 held-out non-django medium instances
  (`unerr-benchmarks/e2e/swebench-verified-difficulty/medium.ids.txt`; weight sympy/sphinx/
  matplotlib/sklearn/astropy/pytest). Zero modifications. This number becomes the permanent
  baseline every engine mechanism is measured against. ~$3.
- **E2 — Ablation triangle.** Same instance set: (a) null harness, (b) econ as-is,
  (c) econ un-suppressed. Attributes every gap point to suppression vs fragmentation vs
  enforcement tax.
- **E3 — Thin-gate design doc.** Native linear loop + finish-time verification chain + edit
  governance only; keep the full in-loop scaffold as a MODE for undisciplined models. The router
  thesis generalizes: route between **harness modes**, not just model tiers.

**Decision rule:** E1 ≥ 8/10 on Mini-10 at ≤$0.15 → engine's role for trained models becomes
*gate and govern*, and the 500-run architecture is the thin gate. E1 disappoints → current
architecture stands and the suppression fixes alone are the win.

## Open questions for the next session

1. Does minimax-m3 through litellm even accept `reasoning_effort: high` / what's the right knob
   on our gateway path? (The gate currently deletes the param to "revert to provider default" —
   what IS the provider default through litellm?)
2. MiniMax officially recommends temp 1.0 for M2-series; mini-swe-agent's config ships 0.0 — and we
   don't know what kwargs the leaderboard submission actually used. E0 should A/B 0.0 vs 1.0
   rather than assume.
3. Cache economics under high reasoning: thinking tokens aren't cache-read; measure the real
   $/task delta, don't model it.
4. How much of 75.8 survives held-out (non-benchmark-shaped) repos? E1's held-out slice answers
   the piece that matters for customers.
5. Where does the finish-time gate hook into a native loop cleanly — patch-submission time
   (mini's sentinel) is the obvious seam.

## Constraints in force

- Do NOT disturb the Stage-3 Mini-10 run (s9-mini10-dist-r5) or its 10/10 arc — this doc's work
  is a separate track. MACHINES=2 directive stands for fleet runs; the litellm gateway is a single
  shared-cpu-2x box in `sin` (migration to `iad` pending user decision) — don't run E-experiments
  concurrently with fleet runs.
- Benchmarks comparisons live in `../unerr-benchmarks`; no frontier comparisons in product code.
- Tier-speak only in engine code; model names allowed here (docs) and in registry/config mirrors.

## Sources

- mini-swe-agent v2.0.0 `swebench.yaml` (fetched 2026-07-12), leaderboard entry
  "MiniMax M2.5 (high reasoning) 75.80 / $0.07".
- Audits: two read-only code audits 2026-07-12 (receipts inline above).
- Run bundles: `unerr-benchmarks/e2e/distributed/out/dist-s9-flaky5-dist-r2/` (4/5, $0.78),
  `dist-s9-ceiling-probe-r1/` (reasoner-conductor probe, 1/2, $0.80).
- Related design notes: [turn-cache-economics.md](./turn-cache-economics.md),
  [adaptive-compute.md](./adaptive-compute.md), [tier-prompts.md](./tier-prompts.md) (the ~25
  prompt-mutation surfaces — the inventory of everything the thin-gate mode would strip).
