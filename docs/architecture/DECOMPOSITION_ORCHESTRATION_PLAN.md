# Decomposition-First Orchestration — Implementation Plan

**Status (2026-07-03): PLANNED — design-first, pre-build.** This is the detailed engineering plan for
the reframe recorded in [`SELF_ORCHESTRATION_PLAN.md`](./SELF_ORCHESTRATION_PLAN.md) §1 + Sprint OL-7:
move econ's orchestration from a **whole-turn risk-escalation veto** to a **conductor-led cost-optimal
decomposition** in which risk is one feature among several, adaptive reasoning is applied where it
pays, and verification (not fear of failure) is what makes "default cheap" safe. It supersedes the
earlier Phase-2 framing ("escalate the hard hop"). Nothing here is shipped yet; validate design-first
(the worked example in §4.4) before committing build effort.

**Owner:** econ core.
**Companion plan (the shipped waves this builds on):** [`SELF_ORCHESTRATION_PLAN.md`](./SELF_ORCHESTRATION_PLAN.md).
**System design (design-only, no phasing):** [`ECON_ARCHITECTURE.md`](./ECON_ARCHITECTURE.md).
**Model configuration (tiers, capabilities, cost):** [`../strategy/MODEL_SELECTION.md`](../strategy/MODEL_SELECTION.md)
→ authoritative registry `packages/code-intelligence/src/model-registry.ts`.

> This doc holds the *phasing + build substance* for the decomposition rework. The design narrative
> stays in `ECON_ARCHITECTURE.md`; per-feature build detail also lands in the owning
> [`docs/features/`](../features/README.md) docs as each sprint starts. This is a plan, not a design
> narrative — no production code, only pseudo where an algorithm needs pinning.

---

## 1. Thesis — why the whole agent moves off risk-as-the-decision

econ's shipped router (OL-3) escalates a **monolithic turn** to one tier on a single
**code-structural risk** score (blast-radius / fan-in / centrality). That was the correct MVP and it
beat task-class routing, but it is a **defensive cascade** — "use the big model only when the cheap one
looks dangerous" — and it optimizes the wrong variable.

The savings identity is `reduction ≈ f × (1 − 1/r)`, where **f is the boring share** (fraction of work
on cheap tiers) and **r is the price ratio** (frontier ÷ cheap). Two consequences:

1. **A whole-turn risk score does not change f.** It picks a tier for a monolith. On a long-horizon
   task it is blunt: score the whole migration high → everything runs on the oracle (savings gone);
   score it low → the hard core collapses (quality gone). Neither wins.
2. **What raises f is decomposition.** Split a task into typed slices; run the high-volume boring
   share (mechanical edits, caller propagation, recon) on cheap tiers and reserve the expensive tier
   for the small irreducible-hard core. f goes from ~0 (monolith on one tier) to ~0.8–0.9.

So the reframe is a re-architecture of the *whole* orchestration loop, not a new escalation rule:

| | **Risk-veto (shipped OL-3)** | **Decomposition-first (this plan, OL-7)** |
|---|---|---|
| Unit of decision | the whole turn | each slice in a plan DAG |
| Primary cost lever | escalation trigger | **the decomposition (raises f)** |
| Role of risk | *the* decision | *one feature* in per-slice allocation |
| Expensive tier used when | blast radius high | a slice is *irreducibly hard* (design/algorithm) |
| Cheap tier used for | low-risk turns | the boring share, **then verified** |
| Failure handling | pre-emptive escalation on fear | **execute cheap → verify → escalate only failures** |
| Reasoning | none on conductor | **adaptive, at the decomposition step** |

**Risk-routing is not discarded — it is the degenerate single-slice case.** A short turn ("rename this
var") is not decomposed; it is routed, and the OL-3 signal is a fine per-slice tier-picker. This plan
*generalises* OL-3 from "the whole-turn decision" to "one input to per-slice allocation."

**The north-star framing.** Our oracle (GLM-5.2, ~78% SWE-Verified) is *below* Opus on a single hard
slice — with just orchestration we cannot beat Opus head-to-head on an irreducible problem. We match it
on the *whole task* by making Opus's structural advantage — holding the entire hard problem in one
context — unnecessary: good decomposition + cheap verified boring-share + oracle on the small core +
QE/verification. The orchestration *is* the product; landing between Opus and Fable in quality at a
fraction of the cost is exactly the decomposition ratio at work.

---

## 2. Research basis — why decomposition + adaptive reasoning + verification, not risk alone

Three web-research passes (model capability · orchestrator-level reasoning · cost/quality of reasoning),
2026-07-03, plus the routing-literature scan already in `SELF_ORCHESTRATION_PLAN.md` §8. *Some findings
postdate the assistant knowledge cutoff (Jan 2026) or come from mixed-quality aggregators — treat exact
numbers as directional; the load-bearing structural facts are cross-checked.*

| # | Finding | Source class | Design consequence |
|---|---|---|---|
| F1 | **Frontier orchestrators do NOT reason every turn.** Claude Opus 4.8 uses *adaptive thinking* — it decides per-turn whether to reason; Anthropic warns against reasoning on "simple single-tool calls" and "real-time applications." | Anthropic adaptive/extended-thinking docs | "Match Opus" = *reason when it helps*, not always. → OL-7.5 adaptive plan-time reasoning, not always-on. |
| F2 | **Plan/execute consensus: reasoning on the planner, cheap on the executor.** LLM Compiler (6.7× cheaper), ADaPT, PLAN-AND-ACT all concentrate reasoning at decomposition, not the execution loop. | 2024–25 agent-planning papers | Conductor reasons at *decomposition*; executor/junior run scoped slices cheaply. → OL-7.1/7.5. |
| F3 | **Reasoning helps most at planning, least at mechanical execution** (structural evidence: planning = decomposition + tool-selection + stop-criteria; execution is mechanical). | Agent-planning benchmark work | Spend capability on the split, not on every keystroke. → typed slices with per-type capability need. |
| F4 | **Always-on reasoning costs 3–10× tokens (typ. 4–6×) + 5–15 s latency per turn**; reasoning tokens bill at the *output* rate on OpenRouter/Anthropic/DeepSeek/Qwen. | Pricing/latency write-ups; OpenRouter reasoning-token docs | Always-on conductor reasoning breaks both the cost thesis and interactive UX. → reasoning gated to complex-task decomposition only. |
| F5 | **Selective escalation is the measured cost/quality frontier** — adaptive routing ~29% cheaper *and* more accurate at parity; "price-reversal": a cheaper model can end up **up to 28× more expensive** via retries. | Agentic-router research; price-reversal paper | Execute-cheap-then-verify + escalate only failures; but a *too-cheap planner* is the real risk → justify plan-time reasoning + a strong verification gate. |
| F6 | **`deepseek-v4-flash` (conductor) is a HYBRID model** — thinking is a toggle (`disabled/high/max`), not a separate model; exposed on OpenRouter. | DeepSeek V4 docs / OpenRouter card | Turning conductor reasoning on is a *config flip*, not a model swap. → OL-7.5 is cheap to build. |
| F7 | **QE (quality-estimation) veto — self-consistency across a couple of samples — is standard 2026 cascade SOTA**; self-reported abstention alone misses *silent* quality cliffs (confidently-wrong cheap output). | Cascade literature (FrugalGPT lineage, "Confident or Seek Stronger") | Verification must catch silent-wrong, or "default cheap" is unsafe. → promote QE veto (OL-3.5a) from deferred to a dependency of OL-7.3. |
| F8 | **Difficulty/confidence routing beats task-class routing; code-structural risk routing is novel** (no direct academic precedent). | Routing literature (`SELF_ORCHESTRATION_PLAN.md` §8) | Keep code-structural risk — but as a *per-slice allocation feature*, protect it as an econ contribution. |

**Net:** the research says the cost/quality frontier is *decompose → allocate on difficulty (not task
class) → execute cheap → verify with QE, not just self-report → escalate only what fails → reason only
where it pays (the plan).* econ already has most primitives (tiers, task tool, todo tool, verification
prompt, compiled brief, risk signal); this plan wires them into that frontier instead of the monolithic
risk-veto.

---

## 3. Target architecture — the end-to-end loop

```
 user prompt
     │
     ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │ CONDUCTOR  (deepseek-v4-flash, hybrid)                                  │
 │                                                                        │
 │  1. META-PLAN  — what is really being asked + approach (OL-1.1, live)  │
 │       │                                                                │
 │       ├─ trivial / single-slice? ──► route via OL-3 per-slice picker ──┐│
 │       │                                                                ││
 │  2. DECOMPOSE (OL-7.1)  ── reason IFF complex (OL-7.5 adaptive think) ─┐││
 │       │   task ─► DAG of TYPED slices                                  │││
 │       │        design │ mechanical │ recon │ verify                    │││
 │       ▼                                                                │││
 │  3. ALLOCATE (OL-7.2)  ── per slice, cheapest tier clearing its NEED ──┤││
 │       │   features: type · difficulty · risk(per-slice) · reversibility│││
 │       │             · context-size vs tier contextWindow              │││
 │       ▼                                                                │││
 │  4. EXECUTE-CHEAP-THEN-VERIFY (OL-7.3)  per slice, default cheap       │││
 │       │   ┌──────────────┬───────────────┬───────────────┐            │││
 │       │   │ recon→junior │ mechanical→   │ design→ORACLE │            │││
 │       │   │              │ executor      │ (compiled     │            │││
 │       │   │              │               │  brief OL-2.2)│            │││
 │       │   └──────┬───────┴───────┬───────┴───────┬───────┘            │││
 │       │          ▼               ▼               ▼                    │││
 │       │      VERIFY gate (OL-1.4) + QE veto (OL-3.5a, self-consistency)│││
 │       │          │  pass ─► accept slice                              │││
 │       │          │  fail ─► ESCALATE only this slice (one tier up)    │││
 │       ▼                                                                │││
 │  5. CONSOLIDATE ─► integrate digests ─► respond ◄──────────────────────┘││
 └───────────────────────────────────────────────────────────────────────┘│
        net-savings receipt (f, per-tier share, double-pay, cache-hit) ◄────┘
```

Key properties: the expensive tier is touched **only** by the design slice (fed a compiled brief, not
the transcript) and by **verification failures** — never by the mechanical bulk. Reasoning is spent
**once**, at the decomposition step, and only when the task is complex.

---

## 4. The four mechanisms in detail

### 4.1 Typed decomposition (OL-7.1)

The conductor's meta-plan (already live) is extended to emit a **DAG of typed slices**, each tagged with
a *capability need*. Slice types and their default tier floor:

| Slice type | What it is | Default tier | Why |
|---|---|---|---|
| `design` | new interface, algorithm, cross-module decision | **oracle** (glm-5.2) | irreducible reasoning; small share |
| `mechanical` | apply a decided change across N sites, caller/import propagation, codemod | **executor** (gpt-oss-20b) | high-volume, low-difficulty, verifiable |
| `recon` | find call sites, map usages, read-only investigation | **junior/executor** | read-only, cheap |
| `verify` | typecheck + targeted tests + lint; QE self-consistency | **junior/executor** | mechanical checking |

This is **prompt-driven** (an extension of the OL-1 conductor delta) plus a light schema on the todo
tool so slices carry a `type` and `need`. No new engine.

### 4.2 Per-slice allocation (OL-7.2) — where risk becomes a feature

For each slice, pick the **cheapest tier whose capability clears the slice's need**. The allocation
function consumes features (risk is now *one* of them):

```
need(slice) = f(type, difficulty, risk_perslice, reversibility, context_size)
tier(slice) = cheapest t in tiers where capability(t) >= need(slice)
              and contextWindow(t) >= context_size(slice)     # registry lookup
```

- **type** — the floor from the table above.
- **difficulty** — how hard to get right (distinct from risk; a leaf algorithm is hard but low-risk).
- **risk_perslice** — `computeTurnRisk` run over *this slice's* entities (reuse the shipped signal, now
  scoped to a slice, not the whole turn). A high-risk mechanical slice → stronger tier *or* mandatory
  verification, not an automatic oracle hop.
- **reversibility** — if verification can cheaply catch a mistake, prefer cheap + verify over escalate.
- **context_size vs `contextWindow(tier)`** — never route a slice larger than a tier's window (registry
  gives the ceiling per tier).

Implementation reuses `code-intelligence/router.ts` as a **per-slice tier picker** (its pure
`routeTurn` already maps a risk/force signal to a tier) rather than a whole-turn decision. The tier→model
resolution goes through the model registry (`tierModelRef`), so a model swap stays a one-line change.

### 4.3 Execute-cheap-then-verify + QE (OL-7.3, depends on OL-3.5a)

Each slice runs on its allocated (default cheap) tier as a sub-agent (`tool/task.ts`), fed a **brief**,
not the transcript (OL-5.1, live). Then the **verification gate** (OL-1.4) runs — and critically, a
**QE veto** (OL-3.5a, promoted from deferred): self-consistency across a couple of cheap samples catches
*silent-wrong* output that never abstains (research F7). A slice is accepted only if it passes; on
failure it **escalates one tier up** (executor→oracle) — and *only that slice*, carrying the failure as
context. This is the mechanism that makes "default cheap" safe and turns escalation from *pre-emptive
fear* into *pay-for-what-actually-needed-it* (research F5).

```
for slice in topo_order(dag):
    out = run(tier(slice), brief(slice))
    if verify(out) and not qe_low(out):      # qe_low := inconsistent samples / low estimator
        accept(out)
    else:
        out2 = run(escalate(tier(slice)), brief(slice) + failure(out))   # one tier up, this slice only
        accept(out2)                          # double-pay recorded (OL-3.6) so savings stay NET
```

### 4.4 Adaptive plan-time reasoning (OL-7.5) — the answer to "should the conductor reason?"

The conductor is a **hybrid model** (research F6): reasoning is a toggle. We gate it to the **single
highest-leverage decision — the decomposition** — and only when the task is complex. This is econ's
analog of Opus's adaptive thinking (research F1): off/low on routine turns, high when the meta-plan
decomposes a hard/long task. The trigger reuses the existing turn-open risk/complexity probe
(`tier-router.ts`) to set the conductor's per-turn `reasoning.effort`.

**Why this is the right amount of reasoning** (research F2–F5): a bad split costs more than a cheap
monolith (price-reversal, F5), so the decomposition deserves reasoning — but reasoning *every* turn
costs 4–6× tokens + 5–15 s latency (F4) and is what frontier agents explicitly avoid (F1). Reason once,
where the whole cost model rides.

**Worked example — "migrate the auth middleware to add token refresh, propagate to all callers"**
(directional; registry tier rates; ~50k output tokens of work):

| Slice | Share | Tier | Rate (out $/1M) |
|---|---|---|---|
| Design the refresh interface | ~10% (5k) | oracle glm-5.2 | $4.40 |
| Propagate signature to ~40 callers | ~80% (40k) | executor gpt-oss-20b | ~$0.20 |
| Recon + final verify | ~10% (5k) | junior/executor | ~$0.20 |

- **Risk-veto (today):** hub touched → risk>70 → whole 50k on the oracle → 50k×$4.40/1M ≈ **$0.22**.
- **Decompose (OL-7):** 5k oracle + 45k cheap → 5k×$4.40 + 45k×$0.20 (÷1M) ≈ **$0.031** — **~7× cheaper,
  same quality** (design still oracle; mechanical bulk cheap *and* verified). The win is the **f ≈ 0.9**
  boring share, which whole-turn risk-routing cannot produce.

---

## 5. Implementation sprints & tasks

Builds on the shipped waves (OL-1 conductor loop, OL-2 briefs, OL-3 router, OL-4 no-manual-switch, OL-5
context, OL-M models, OL-6 validation — all live per `SELF_ORCHESTRATION_PLAN.md`). This plan is
**Sprint OL-7**, expanded. Task IDs match the companion plan.

### Phase A — Decomposition & allocation (the core reframe)

- **OL-7.1 — Typed decomposition.** Extend the conductor delta + todo schema so a complex task becomes a
  DAG of `design|mechanical|recon|verify` slices, each with a `need`. Prompt + light schema. Anchor:
  `session/system.ts` `TIER_DELTA`, `tool/todo.ts`.
  *Done-when:* a complex prompt's trace shows a typed slice DAG before execution; a trivial prompt skips
  decomposition (single-slice path).
- **OL-7.2 — Per-slice tier allocation.** Reuse `routeTurn` as a per-slice picker over
  `{type, difficulty, risk_perslice, reversibility, context_size}`; resolve tier→model via the registry;
  enforce `contextWindow` ceilings. Anchor: `code-intelligence/router.ts`, `session/tier-router.ts`,
  `tool/task.ts` (spawn with an allocated model). Risk is demoted here — assert in a test that a
  high-risk *mechanical* slice does **not** auto-route to oracle when verification covers it.
  *Done-when:* each slice in the trace carries an allocated tier; most slices land cheap; allocation is
  unit-tested on synthetic slice sets.

### Phase B — Safe cheap execution (makes default-cheap correct)

- **OL-3.5a — QE veto (PROMOTED from deferred).** Add a self-consistency / confidence veto that can
  reject a cheap-tier slice *before* acceptance, independent of self-reported abstention. Start with
  cheap self-consistency (a couple of samples, agreement check) before any trained estimator. Anchor:
  `code-intelligence/abstention.ts` + a new QE module; wire into the slice loop.
  *Done-when:* a seeded silent-wrong cheap output is vetoed and escalated on a fixture; latency/cost of
  the veto is measured and bounded.
- **OL-7.3 — Execute-cheap-then-verify per slice.** Run each slice cheap → verify (OL-1.4) + QE
  (OL-3.5a) → escalate *only* failures/irreducible-hard one tier up, recording double-pay (OL-3.6) so
  the receipt stays NET. The escalated design slice is fed the compiled brief (OL-2.2). Anchor:
  `tool/task.ts`, the OL-1.4 verify sub-agent, `code-intelligence/brief.ts`, `double-pay.ts`.
  *Done-when:* a hard task's trace shows cheap execution, per-slice verify, and escalation confined to
  failed/hard slices; the receipt shows a NET saving vs the risk-veto baseline on the same task.

### Phase C — Adaptive reasoning & the oracle brief wire

- **OL-7.5 — Adaptive plan-time reasoning.** Gate the conductor's hybrid thinking to the decomposition
  step on complex tasks; set per-turn `reasoning.effort` from the complexity/risk probe. Config-first
  (the model is already hybrid). Anchor: `session/tier-router.ts` → per-turn model options;
  `opencode.json` conductor reasoning block (currently absent → add, driven per-turn).
  *Done-when:* a complex task shows the conductor reasoning at plan-time (reasoning tokens > 0, trace
  hidden) while a trivial task shows none; latency delta only on complex turns.
- **OL-2.2 (live wire) — Compiled brief on the escalated slice.** Finish wiring `brief.ts` so an
  escalated `design` slice sends a compiled brief (goal + focus entities + prior digests), not the
  transcript — now unblocked because escalation is a *per-slice sub-agent spawn*, not an in-place
  whole-turn reassignment (which is why it was infra-blocked before). Anchor: `code-intelligence/brief.ts`,
  `tool/task.ts`.
  *Done-when:* an oracle escalation's input is a fraction of the full transcript; oracle cache-hit-rate
  (OL-3.7) holds because the brief prefix is stable.

### Phase D — Validation

- **OL-7.4 — Decomposition-quality eval.** Extend the loop-adherence eval (OL-1.5) to score the
  *decomposition*: split correctness (no missed dependency / over-fragmentation), f maximised, per-slice
  allocation matched need, verification caught seeded errors. Anchor: `packages/eval`.
  *Done-when:* the eval scores decomposition on a labelled set and gates regressions in CI.
- **OL-7.6 — A/B vs the risk-veto baseline.** On a fixed real-repo task set, compare decomposition-first
  vs the shipped whole-turn risk-veto on **net cost, quality (pass rate after verify), latency**. Ship
  behind a flag (`ECON_ORCHESTRATION=decompose|risk-veto`) so the comparison is live and reversible.
  Anchor: `packages/eval`, `cli/cmd/run.ts` flag, receipt.
  *Done-when:* decomposition-first shows materially lower net cost at ≥ parity quality on the set; the
  flag defaults flip only after the numbers clear.

### Sequencing & dependencies

```
OL-7.1 ─► OL-7.2 ─► OL-7.3 ─► OL-7.4 ─► OL-7.6
                 ▲   ▲   ▲
        OL-3.5a ─┘   │   └─ OL-2.2 (brief wire)
        OL-7.5 ──────┘
```
OL-7.1→7.2→7.3 is the critical path; OL-3.5a (QE) and OL-2.2 (brief) gate 7.3; OL-7.5 (reasoning) can
land in parallel once 7.1 exists. OL-3 (whole-turn risk router) stays as the single-slice fast path
throughout — **do not delete it**, it is the degenerate case and the A/B control.

---

## 6. What changes in code (seams)

| Seam | File | Change |
|---|---|---|
| Conductor delta (decompose + typed slices) | `session/system.ts` `TIER_DELTA` | prompt: emit typed slice DAG on complex tasks |
| Todo schema (slice `type` + `need`) | `tool/todo.ts` | light schema addition |
| Per-slice allocation | `code-intelligence/router.ts`, `session/tier-router.ts` | reuse `routeTurn` per slice; risk = one feature |
| Slice spawn with allocated model | `tool/task.ts` | accept an allocated model + brief per slice |
| QE veto | `code-intelligence/abstention.ts` + new QE module | self-consistency check in the slice loop |
| Brief on escalated slice | `code-intelligence/brief.ts` | live-wire `compileBrief`/`briefFromContext` |
| Adaptive conductor reasoning | `session/tier-router.ts`, `opencode.json` | per-turn `reasoning.effort` on conductor |
| Double-pay on per-slice escalation | `code-intelligence/double-pay.ts`, `cost_breakdown` | record discarded cheap spend per slice |
| Decomposition eval | `packages/eval` | score split quality |
| A/B flag | `cli/cmd/run.ts` | `ECON_ORCHESTRATION=decompose|risk-veto` |

Tier→model resolution everywhere goes through `model-registry.ts` (`tierModelRef`/`contextWindow`), so
the executor swap to Nemotron 3 (OL-M.1, post-POC) and any reasoner separation remain one-line changes.

---

## 7. Metrics & validation

- **f (boring share)** — fraction of output tokens on cheap tiers. The primary lever; target ≥ 0.8 on
  multi-slice tasks. Surface in the receipt.
- **Net savings vs risk-veto baseline** — same task, both modes (OL-7.6), NET of double-pay (OL-3.6).
- **Quality after verify** — pass rate on the eval set post verification/QE; must hold ≥ parity with
  the risk-veto control (and vs a frontier-only control from OL-6.2).
- **Decomposition quality** (OL-7.4) — split correctness, allocation-match, verify catch-rate.
- **Per-slice escalation rate** — how often cheap→oracle fires; too high ⇒ executor too weak (revisit
  OL-M.1) or verify too strict; too low ⇒ QE missing silent-wrong.
- **Oracle cache-hit-rate** (OL-3.7/OL-M.4) — the brief must be prefix-stable so escalated design
  slices hit the GLM-5.2 cache (−81% on its un-shoppable price).
- **Plan-time reasoning latency** — added only on complex turns; trivial turns unchanged.

---

## 8. Risks & open decisions

- **Decomposition overhead / bad splits.** A missed dependency or over-fragmentation costs more than a
  cheap monolith. Mitigation: plan-time reasoning (OL-7.5) on the split + the decomposition eval
  (OL-7.4) as a regression gate. This is the single biggest risk of the reframe.
- **Verification is now load-bearing, not optional.** "Default cheap, escalate failures" only works if
  verify + QE reliably catch silent-wrong. If the gate is weak, quality leaks. Hence QE (OL-3.5a) is
  promoted to a *dependency*, not a nice-to-have.
- **Executor weakness (gpt-oss-20b ~60.7% SWE-Verified).** More cheap execution ⇒ more exposure to the
  weak tier. Mitigation for POC: verify + QE absorb it; post-POC swap to Nemotron 3 (OL-M.1) behind an
  eval. Watch the per-slice escalation rate as the signal.
- **Per-slice risk vs whole-turn risk.** Scoping `computeTurnRisk` to a slice's entities is new; confirm
  the signal is still meaningful at slice granularity (it may be noisier). Validate before trusting it
  as an allocation feature.
- **Keep the degenerate path.** Do not delete OL-3 whole-turn routing — it is the short-turn fast path
  *and* the A/B control. Removing it would also remove the fallback if decomposition underperforms.
- **Reasoning-effort honoring.** Confirm the provider (Fireworks via OpenRouter) actually honors a
  per-call `reasoning.effort` on deepseek-v4-flash before relying on OL-7.5 (the same unverifiability
  that made OL-3.8 a won't-build for the executor floor — verify empirically first).
- **Flag default flip is one-way-ish for UX.** Ship decompose behind `ECON_ORCHESTRATION`, prove the
  numbers (OL-7.6), then flip the default; keep risk-veto reachable for a release.

---

## 9. References

- [`SELF_ORCHESTRATION_PLAN.md`](./SELF_ORCHESTRATION_PLAN.md) — the shipped waves + Sprint OL-7 summary
  (this doc is its detailed expansion); §8 routing-literature scan.
- [`ECON_ARCHITECTURE.md`](./ECON_ARCHITECTURE.md) — system-design narrative.
- [`../strategy/MODEL_SELECTION.md`](../strategy/MODEL_SELECTION.md) — tiers/capabilities/cost; registry
  `packages/code-intelligence/src/model-registry.ts` is the source of truth.
- Feature docs: [03-risk-router](../features/03-risk-router.md), [04-model-team](../features/04-model-team.md),
  [06-observability](../features/06-observability.md).
- Research (2026-07, directional; some postdate the Jan-2026 cutoff): Anthropic adaptive/extended-thinking
  docs (F1, F4); LLM Compiler / ADaPT / PLAN-AND-ACT (F2, F3); agentic-router + price-reversal work (F5);
  DeepSeek V4 / OpenRouter model cards (F6); FrugalGPT / RouteLLM / "Confident or Seek Stronger" cascade
  + QE literature (F7, F8).
