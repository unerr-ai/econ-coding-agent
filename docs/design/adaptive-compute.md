# econ — Adaptive Compute: cost-division by default, accuracy-multiplication on demand

**Status:** Drafted 2026-07-01. How econ borrows orchestration mechanisms from **Sakana Fugu**
without inheriting its economics, and how econ deliberately **dials compute *up*** — ensembles,
debate, verifier reranking, extended reasoning — for the small fraction of problems hard enough to
justify it. Companion to [ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md) (router, governance gate,
context engine), [models.md](./models.md) (the tiers) and
[COMPETITORS.md §4](../strategy/positioning.md) (the Fugu teardown this builds on).

> **One-line thesis.** econ is not "the cheap agent that gives up on hard problems." It is a
> **compute dial**: it *divides* cost on the common path (route each slice to the cheapest capable
> tier) and *multiplies* accuracy on the rare hard tail (convene more models, reason longer, verify
> harder) — and the **router deciding *when* to spend is itself the product.** Sakana Fugu sits
> permanently at the "multiply" end; econ travels the whole dial and knows where each task belongs.

---

## 0. The core idea — one dial, two directions

```
        CHEAP  ◀──────────────── the compute dial ────────────────▶  ACCURATE
        cost-division                                        accuracy-multiplication
        (default, ~99% of tasks)                             (on-demand, <1% of tasks)

  single cheap tier ── mid tier ── mid + test-verify loop ── oracle escalation ──
      ── plan-then-execute ── self-consistency (best-of-N) ── MoA ensemble + synthesis ──
          ── debate / critic ── verifier rerank ── human gate
   1×          ~1×            ~1–2×                 ~3–5×                 ~5–15× cost
```

**In plain terms.** Every task enters at the cheap end. The **risk-escalation router** (see
[ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md)) decides how far right to turn the dial based on
*code-structural risk* and *observed difficulty*. Most tasks never leave the left third. A few —
high-blast-radius edits, novel algorithms, repeated failures — get walked rightward one detent at a
time, each detent buying accuracy at a known cost multiple, stopping the moment the task is resolved.

**Why the blended cost still stays low.** The savings identity `reduction ≈ 1 − large-tier token
share` (full derivation in [economics.md](../strategy/economics.md)) means what matters is not the
*peak* cost of the expensive modes but their *token share*. Blended cost is `Σ (share_i × cost_i)`,
and it is dominated by the cheap common path:

```
   mode           share    cost mult    contribution
   ───────────────────────────────────────────────────
   cheap/normal    ~90%       1×            0.90
   oracle+verify   ~9%        4×            0.36
   full multiply   ~1%       12×            0.12
   ───────────────────────────────────────────────────
   blended                                 ~1.4× a single cheap call
                                           (vs Fugu's flat ~3×+ on EVERY call)
```

A 12× "Fugu-grade" mode fired on 1% of tasks adds ~0.12 to the blend. Fugu pays ~3×+ on *everything*.
That gap is econ's whole position: **near-frontier accuracy where it counts, at a fraction of the
cost, because we spend big rarely and on purpose.**

---

# Part A — Features to borrow from Sakana

Borrow the **mechanisms**, bend each toward cost-division. Anything that raises large-tier token
share on the *common* path is disqualified by the `fct` note above.

## A1. Adopt now — cheap, high-fit, on-thesis

| # | Borrow | econ adaptation (cost-optimal) | Plugs into |
|---|---|---|---|
| 1 | **MoA verification — the scalpel** | Fugu fans every prompt to 3 models + synthesizes. econ does this **only on the ~1% of edits the router flags high-blast-radius**: 2–3 models vote/synthesize *before the edit commits*. | in-loop **governance gate** |
| 2 | **Disagreement-as-confidence** | Fugu treats agreement as quality; invert it — when the gate's small ensemble **disagrees**, fire **abstain / escalate / human-review**. Nearly free (outputs already computed in #1). | **abstention path** + gate |
| 3 | **"System *as a model*" packaging** | The tiering (junior/worker/oracle across [the 3 finalized models](./models.md)) is **invisible**: the buyer talks to "econ," never reasons about routing. Costs nothing. | product surface / UX |

## A2. Grow into — Phase-N, powered by econ's data moat

| # | Borrow | econ adaptation | Plugs into |
|---|---|---|---|
| 4 | **Learned orchestration** (their TRINITY + Conductor papers) | Upgrade the **heuristic** router (blast-radius/fan-in/centrality) to a **learned** one, trained on econ's own **per-customer outcome data** (did the edit pass tests + the gate?). Trained to route to the **cheapest tier that will pass** — not to convene everyone. Turns the accumulated-context moat into a **routing moat**. | risk-escalation **router** |
| 5 | **Learned team assembly** (Conductor "assemble the experts") | Dynamically **size the team** per task: skip the oracle on easy tasks, convene more on novel/high-risk work — directly serving `reduction ≈ 1 − large-tier token share`. | router + tier convening |

## A3. Explore later — speculative

| # | Borrow | econ adaptation | Note |
|---|---|---|---|
| 6 | **Sakana's cheap adaptation** (evolutionary model merging, Text-to-LoRA) | Generate **task/domain-specific adapters** to specialize the executor tier for a customer's stack **without training a model**. Ties to the "own a small model via post-training as Phase-N vertical integration" thread. | research-heavy; park until #4 ships |

## A4. Do **not** take

```
✗ always-on 3× frontier ensemble  → detonates the cost identity (this is Fugu's whole point)
✗ closed US frontier substrate     → forfeits open-weight + sovereignty (DPDP/RBI, EU)
✗ accuracy-max as the north-star   → wrong metric; econ optimizes cost-per-resolved-task + eligibility
```

---

# Part B — Accuracy-multiplication mode: how econ dials UP for complex problems

The right end of the dial. These are the **accuracy multipliers** — techniques that push *realized*
accuracy toward (and occasionally past a single model's single-shot output) — each with its cost and
its firing condition. **None run on the common path;** all are gated by the triggers in §B0.

## B0. Triggers — when econ enters accuracy-multiplication mode

The router turns the dial right on any of:

- **Structural risk** — high blast-radius / fan-in / centrality edit (the existing router signal).
- **Observed difficulty** — repeated test/typecheck failures on the same task (self-repair not
  converging), or low first-pass confidence.
- **Ensemble disagreement** — the cheap gate check (A1 #2) came back split.
- **Novelty** — new public interface, new algorithm, architecture decision (no close precedent in the
  code graph).
- **Explicit request** — user asks for "hard mode" / a high-stakes change / a critical path.
- **Value-at-risk** — the task touches security, money, migrations, or data integrity.

Absent a trigger, the dial stays left. **The trigger economics are the point:** you pay the
multiplier only when the *cost of being wrong* exceeds the *cost of the extra compute*.

## B1. The multipliers (accuracy / reasoning power)

| Technique | What it does | Cost | Fire when |
|---|---|---|---|
| **Extended reasoning (test-time compute)** | Give the **oracle** a larger reasoning-token budget — think longer on one hard step. Single model, no ensemble. | ~1.5–3× | novel logic; a hard single decision |
| **Plan-then-execute (escalate the *plan*)** | Escalate only the **planning** step to the oracle; keep execution on cheap tiers (Magnitude-style split). Reasoning power exactly where it matters, cost where it doesn't. | ~1.5–2× | multi-step / multi-file tasks |
| **Self-consistency (best-of-N, one model)** | Sample the **same** tier N times, vote / pick the majority or verifier-preferred answer. Cheaper than multi-model — reuses one model + warm cache. | ~N× on that step | ambiguous single-shot output |
| **MoA ensemble + synthesis** (Fugu core) | N **different** models, same prompt, synthesize a combined answer. Diversity catches model-specific blind spots. | ~3–5× | critical edit at the governance gate |
| **Debate / generator–critic** | One model proposes, an **adversarial critic** model tries to refute, iterate to convergence. Catches failure modes redundancy can't. | ~3–6× | security-critical / subtle-logic |
| **Verifier / reward-model rerank** | Generate N candidates, **rank by a judge** and keep the best. | ~N× + judge | when a good judge exists |

## B2. The efficiency lever — multiply accuracy *without* linear cost

The techniques above cost tokens. These make the dial **cheap to turn**, and are what keep the
blended cost near 1.4× rather than 5×:

- **Execution-grounded verification (the best verifier is free-ish and deterministic).** For code,
  don't rank candidates with an expensive judge model — **run the tests / typecheck / linter**. The
  compiler is a perfect, cheap verifier. A generate → run → feed-failures-back → repeat **self-repair
  loop** is accuracy-multiplication whose "reward model" is deterministic, not another LLM. *This is
  econ's highest-leverage accuracy technique — use it before any LLM-ensemble multiplier.*
- **Cascade / early-exit (the efficiency spine).** Always try **cheap → verify → escalate only on
  failure.** Self-consistency on the *mid* tier first; escalate to the oracle *only if the mid tier
  can't agree with itself or pass the tests.* Most hard-looking tasks resolve one detent in.
- **Self-consistency before multi-model.** Getting one cheap model to agree with itself N times is
  cheaper than convening N different models — try it first; reserve true MoA for the gate.
- **Sticky mid tier + warm cache.** Per the topology `dec` note (mid-32B default, oracle stateless on
  the hard tail, **sticky mid keeps cache warm**), keeping the reasoner resident means the extra
  reasoning passes reuse cache instead of re-paying prefix cost.
- **Right-slice context (the second pillar).** Fewer, better-targeted tokens per step
  ([ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md) context engine) means every multiplier operates on
  a lean prompt — the multiplier's cost is *N × a small number*, not *N × the whole repo*.

## B3. The honest ceiling

Two limits to state plainly so we don't oversell the right end of the dial:

1. **A router/ensemble cannot exceed its best component.** The accuracy ceiling is the **strongest
   model econ can call** (the oracle). Multipliers push *realized* accuracy toward that ceiling and
   can beat a single model's *single-shot* output — they do **not** manufacture capability the oracle
   lacks. If the ceiling is too low for a class of problems, the fix is a better oracle, not more
   ensembling.
2. **Diminishing returns.** Best-of-16 is not twice best-of-8. Each multiplier has a knee; past it
   you burn tokens for noise. The router must cap N and stop at "resolved," not "maximally verified."

---

# Part C — The control policy (how the router sets the dial)

| Difficulty / risk | Compute mode | Techniques engaged | ~Cost | ~Share |
|---|---|---|---|---|
| **Trivial** | single junior/executor, no verify | — | 1× | high |
| **Normal** | mid tier + **test-verify loop** | execution-grounded self-repair | ~1–2× | ~90% |
| **Hard / risky** | **oracle escalation** + **plan-then-execute** + test loop | extended reasoning; cascade | ~3–5× | ~9% |
| **Critical / novel** | **full accuracy-multiplication** | MoA ensemble + debate + verifier rerank + **human gate** | ~5–15× | <1% |

Control rules:

1. **Enter left, move right only on a trigger (§B0).** Never start at the expensive end.
2. **Cascade: cheap → verify → escalate on failure.** Deterministic verification (tests) before any
   LLM multiplier.
3. **Stop at resolved.** The goal is a passing, safe change — not maximal verification. Cap N.
4. **Log the spend.** Every dial-up emits a savings/receipt event (observability is the product
   surface) so the *cost of accuracy* is visible per task.
5. **Phase 2 — calibrated deferral as the trigger signal.** Replace/augment heuristic triggers
   with a UCCI-style calibrated scalar: token-margin uncertainty at the decision point, isotonic
   regression fit on our own labeled live-fire outcomes, defer to the bigger tier only below the
   calibrated threshold (~31% cost cut at fixed quality in published production cascades; raw
   entropy and verbalized confidence are both unreliable without the calibration fit). First step
   is plumbing, not modeling: verify logprob availability on our provider path, then log margins +
   outcomes so the curve can be fit. Adoption decision + literature map:
   [failure-taxonomy.md §6.x](./failure-taxonomy.md).

---

# Part D — Why this is a feature, not a contradiction

The earlier tension — "econ divides cost, Fugu multiplies it" — is resolved by making
**multiplication a *mode*, not the *default*.** This is strategically stronger than either pole:

- **vs Fugu:** econ matches Fugu-grade accuracy on the tasks that need it (same MoA/debate/verifier
  machinery at the gate) while costing a fraction on everything else. econ can *become* Fugu for one
  edit; Fugu cannot *stop being* Fugu for the other 99%.
- **vs cheap single models (MiniMax/Kimi et al.):** those have no dial — one model, one shot. econ
  adds an accuracy ceiling-raiser they don't have, exactly when the problem is hard.
- **vs frontier SaaS (Cursor/Copilot/Claude Code):** they spend frontier-per-token on everything;
  econ spends cheap-per-token by default and frontier-grade compute only on the hard tail — a
  structurally lower blended cost at comparable resolved-task quality.

> **The product is the judgment about *when* to spend, not the ability to spend.** Anyone can burn
> tokens; econ's router knowing which 1% of tasks deserve 12× compute — and proving the savings on
> the other 99% — is the defensible thing. Sakana proved the multiply-machine works; econ wraps it in
> a dial and a router that decides when to pull it.

---

## E. Anchoring to econ's components

| Technique | Lives in / extends |
|---|---|
| Trigger detection, dial position | **risk-escalation router** ([ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md)) |
| MoA / debate / verifier ensemble | **in-loop governance gate** (fires at the edit) |
| Extended reasoning, plan-then-execute | **oracle tier** ([models.md](./models.md)) |
| Execution-grounded self-repair | tool loop (tests/typecheck/lint) |
| Lean prompts under every multiplier | **context engine** (the second pillar) |
| Long-horizon hard tasks | **checkpointing** (state outside the window) |
| Learned router (A2 #4) | router + **per-customer outcome data** (the moat) |

---

## F. Sources & lineage

- **Sakana Fugu** — sakana.ai/fugu (MoA "system as a model"; TRINITY + Conductor ICLR 2026 learned
  orchestration); arxiv.org/abs/2606.21228 (technical report). Full teardown in
  [COMPETITORS.md §4](../strategy/positioning.md).
- **Accuracy-multiplication techniques** — self-consistency, best-of-N, generator–critic debate,
  verifier/reward reranking, test-time compute: established inference-scaling literature; here bent to
  **execution-grounded** (tests-as-verifier) form for code and **gated** by econ's risk router.
- **Plan/execute split** — Magnitude's planner/executor model split (cited in
  [ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md)).
- **Cost identity & topology** — econ savings model `reduction ≈ 1 − large-tier token share` (see
  [economics.md](../strategy/economics.md)); mid-tier default reasoner + stateless oracle on the hard
  tail ([ECON_ARCHITECTURE.md §12](../architecture/ECON_ARCHITECTURE.md)).
