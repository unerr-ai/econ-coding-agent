# econ — Frontier-parity feasibility: open weights, the Fugu precedent, sovereign fit

**Status:** research memo, written 2026-07-12 from a seven-agent web-research run (four agents on
model-cost curves + ecosystem state, three on Sakana Fugu / gap-closing recipes / sovereign buyers).
Verdicts are ours; every external number carries a source. Re-evaluate on any watch-list trigger (§9).

**The question this doc answers:** how feasible is it for econ to field (a) a coding agent on par
with **Opus 4.8** using open-weight models, and (b) anything approaching **Fable 5**-grade — following
the trail Sakana's Fugu opened — affordably, in a shape sovereign buyers (PSUs, governments, defense,
regulated enterprises, privacy-first verticals) can actually purchase?

**Verdicts up front:**

| Claim | Verdict | Confidence |
|---|---|---|
| Fable-5-quality model at 3–4× lower cost within 6 months | Likely — via Anthropic's own next Sonnet tier and/or Chinese open-weight cadence | ~70% (benchmark parity) / ~55% (per-*task* cost parity on agentic work) |
| Opus-4.8-grade model on a local device within 12 months | Optimistic — two hard gates must pass jointly | ~30–40% |
| **econ: Opus-parity coding-agent outcomes on open weights** | **Feasible — largely demonstrated; provable publicly within ~2 quarters for $10–30k compute + harness work** | ~75–85% |
| econ: a Fable-grade raw model | Not at startup budget, at any inference-cost multiplier (§5 ceiling law) | — |
| econ: Fable-*adjacent outcomes* on the verifiable coding slice | Partial — match/beat on selected agentic benchmarks, paying 5–12× tokens on the hard tail only | ~40–50% |

---

## 1. The cost-curve backdrop (the "Arav claims")

Two market claims frame the timing. **(a) "Fable 5 quality at 3–4× lower cost in <6 months":**
the precedent is strong — Claude 3 Opus ($15/$75) → Claude 3.5 Sonnet ($3/$15) delivered
equal-or-better at 5× cheaper in **3 months** ([Anthropic](https://www.anthropic.com/news/claude-3-5-sonnet));
DeepSeek V3 landed 10–50× below GPT-4o-class pricing within 8 months. Measured constant-quality
decline rates: ~10×/year ([a16z LLMflation](https://a16z.com/llmflation-llm-inference-cost/)),
50–200×/year on some benchmarks post-2024 ([Epoch](https://epoch.ai/data-insights/llm-inference-price-trends)) —
even the conservative rate implies ~3.2× in 6 months. The discount: per-**token** price ≠ per-**task**
cost — agentic workloads burn 5–30× tokens/task and one April-2026 vendor re-denomination inflated
token counts ~45% at constant output ([Altimate](https://blog.altimate.ai/the-great-token-heist-of-26)).

**(b) "Opus-4.8-grade local device in <12 months":** joint probability of (open weights closing an
~8-pt SWE-bench-Verified gap *and* a ~40-pt agentic gap) × (fitting usably on ≤$10k hardware).
Prefill speed on 100k-token agent turns is the real chokepoint, and reasoning quality degrades ~3×
faster than perplexity under Q4/Q3 quantization. We put it at 30–40%. **Strategic consequence for
econ:** both claims *pay us* when true (cheaper tiers raise `f` and `r` in `f×(1−1/r)` for one
`ECON_TIER_BINDING` edit) and neither needs to be waited on — see §6.

## 2. Where open weights actually are (July 2026)

- Best open models sit ≈**80% SWE-bench Verified** vs Opus 4.8's 88.6% and Fable 5's ~95
  (vendor-reported; aggregator-sourced, medium confidence). On **SWE-Bench Pro**: GLM-5.1 58.4%,
  MiniMax M3 59.0%, Kimi K2.6 58.6% — reportedly above Opus 4.6-class
  ([Kilo](https://kilo.ai/open-source-models), [Modal](https://modal.com/resources/best-open-source-models-swe-bench-coding-agents)).
- The **agentic gap is larger than the one-shot gap** (~40 pts on Terminal-Bench for open vs frontier;
  no open model in the agentic-leaderboard top 20) — long-horizon tool-use training signal is the
  frontier labs' real moat, not one-shot coding.
- Epoch measures the open-vs-closed lag at **~4 months and slightly widening** (3→4 months,
  Oct 2025 → May 2026) ([Epoch](https://epoch.ai/data-insights/open-closed-eci-gap)).
- Per-active-param efficiency keeps climbing (MoE activation ratios 10–15% → 3–5% in two years),
  which is what keeps the self-host economics of §8 improving. Serving economics and in-region
  hosting live in [GPU_UTILIZATION_ECONOMICS.md](./GPU_UTILIZATION_ECONOMICS.md) — not repeated here.

## 3. What Sakana Fugu actually is — and what it validates

Launched **2026-06-22**, ten days after US export controls hit Fable 5/Mythos. Despite the framing,
Fugu is **not an open model and not sovereign**. Verified reality
([release](https://sakana.ai/fugu-release/), [arXiv 2606.21228](https://arxiv.org/html/2606.21228v1),
[reverse-engineering](https://www.requesty.ai/blog/inside-sakana-fugu-ultra-multi-agent-orchestration-reverse-engineered/)):

```
            ┌────────────────────────────┐
   task ──▶ │ TRINITY  ~0.6B coordinator │      pool (CLOSED APIs):
            │ (CMA-ES-evolved router)    │ ──▶  Claude Opus 4.8
            │ Conductor ~7B (RL-trained  │ ──▶  GPT-5.5
            │ coordination strategies)   │ ──▶  Gemini 3.1 Pro
            └────────────┬───────────────┘
                         └── recursion depth = inference-time compute dial
```

- **Claims are benchmark-selective:** wins LiveCodeBench (93.2), Terminal-Bench 2.1 (78.5),
  GPQA-Diamond (~95.5); **loses SWE-Bench Pro 73.7 vs Fable's 86.0** — the benchmark closest to real
  agentic coding. All Fable baselines are Anthropic vendor-reported; no head-to-head, and **zero
  independent evals** as of 2026-07-12.
- **Cost:** 5–12× token multiplier per task (~$7–10 per complex message); hands-on reviews call it
  "cheaper and faster per wall-clock, not better" than Opus on code quality
  ([Paddo.dev](https://paddo.dev/blog/sakana-fugu-orchestration-model/)).
- **Credibility prior:** Sakana's Feb-2025 AI CUDA Engineer claim collapsed when the system was found
  gaming its own eval harness ([GIGAZINE](https://gigazine.net/gsc_news/en/20250225-sakana-ai-cuda-engineer-walks-back/)).
- **The sovereignty flaw:** the pool is US + Chinese closed APIs, anonymized per query. No weights, no
  air-gap, no audit trail of which model touched which prompt. David Ha's own framing: *"resilience,
  not independence."*

**What it validates for econ:** a small trained conductor routing over a model pool, with an
inference-time compute dial, is now a **$2.65B-credible product category**
([Series B](https://techcrunch.com/2025/11/17/sakana-ai-raises-135m-series-b-at-a-2-65b-valuation-to-continue-building-ai-models-for-japan/)) —
and it is econ's existing topology (conductor-led decomposition, tiered pool, escalation, verification;
see [ORCHESTRATION_MECHANISM.md](../architecture/ORCHESTRATION_MECHANISM.md)). econ differs in the two
properties that decide sovereign deals: **our pool is open-weight** (deployable inside the buyer's
perimeter — the buyer *owns* the intelligence as an artifact: weights on their disks, auditable,
fine-tunable, irrevocable by any foreign vendor or export control), and **our routing is logged**
(receipts; Fugu's pool is a black box). Fugu cannot add either without becoming a different product.

## 4. The recipe menu — proven lifts and what they cost

| Technique | Best published lift | Cost | Source |
|---|---|---|---|
| **Agent scaffold** (harness engineering) | same model 42%→78% SWE-bench; harness moves 5–22 pts where frontier model swaps move ~1 pt | $0 GPU | [Particula](https://particula.tech/blog/agent-scaffolding-beats-model-upgrades-swe-bench), [arXiv 2605.23950](https://arxiv.org/html/2605.23950) |
| Best-of-N + verifier reranking | +8–12 pts pass@1 | ~5× tokens (tail only) | [AwesomeAgents](https://awesomeagents.ai/leaderboards/swe-bench-coding-agent-leaderboard/) |
| AB-MCTS / multi-model search | SWE-bench 20%→50% over 80 rounds | 5–10× tokens | [Sakana AB-MCTS](https://sakana.ai/ab-mcts/) |
| RL post-training (SWE-Gym/R2E-Gym) | +19 pts on a 32B (18%→37% Verified) | DeepSWE: 9,180 H100-hrs ≈ **$18.4k** | [SWE-Gym](https://github.com/SWE-Gym/SWE-Gym), [DeepSWE](https://www.together.ai/blog/deepswe) |
| **SERA soft-verified RL** | matches DeepSWE | 960 H100-hrs ≈ **$1.9k** (9.6× cheaper) | [SERA](https://arxiv.org/pdf/2601.20789) |
| Distillation from reasoning traces | AIME 15.6%→71% (**math — coding unproven**) | SFT-only, single-H100 class | [DeepSeek-R1](https://arxiv.org/html/2501.12948v1) |

## 5. The ceiling law — why Fable-grade raw is out, and Opus-grade is in

Every technique in §4 **amplifies latent capability; none creates it**. A model whose pass@100 is
high can be lifted toward that number at pass@1 by scaffold + search + RL; a model whose pass@100 is
low cannot be search-rescued ([Pass@k training](https://arxiv.org/html/2508.10751v1)). Fable's edge is
precisely the deep single-shot reasoning that raises pass@100 — a product of frontier-scale
pretraining ($100M+ class) plus months of on-policy agentic RL. Even Fugu, *with frontier models in
its pool*, missed Fable by 12 points on SWE-Bench Pro. Hence the reframe econ sells: **verified
outcomes on the decomposable, machine-checkable slice of coding — not model parity.** On that slice,
orchestrated open models + verification already match or beat frontier single-model results (Fugu's
own Terminal-Bench/LiveCodeBench wins are the demonstration), and the 5–12× tail multiplier is cheap
in absolute terms when the base tokens are open-weight-served (see
[TOKEN_ECONOMICS.md](./TOKEN_ECONOMICS.md)).

econ's own evidence stack for the Opus-parity claim: SWE-mini-10 ran **10/10 real-graded passes at
$0.11–0.22/issue** on the current all-open-weight tier binding
([SWE_BENCH_TRACKER.md](../testing/SWE_BENCH_TRACKER.md)), including a multi-method Django bug at
$0.11 with zero escalations. What remains unproven is breadth (10 issues ≠ a 500-instance run) and
the >50-turn coherence tail — which conductor-led decomposition mitigates by design (no slice needs
100-turn coherence; see [cross-tier-context.md](../design/cross-tier-context.md)).

## 6. Follow-the-traces plan (the affordable version of Fugu, sovereign by construction)

- **Phase 1 — $0 GPU, weeks.** Keep hardening the scaffold (§4's biggest lever — it is the product).
  Add best-of-N + verifier reranking at the oracle tier for the hard tail, bounded by the existing
  double-pay accounting. Expose the **compute dial** (fast / balanced / max-quality) — Fugu's
  recursion-depth dial maps directly onto our escalation thresholds and N
  ([adaptive-compute.md](../design/adaptive-compute.md)).
- **Phase 2 — $2–20k GPU, ~one quarter.** SERA-style RL on the 32B mid tier over SWE/R2E-Gym
  (recipe + data flywheel + parity math live in
  [MODEL_TRAINING_STRATEGY.md](./MODEL_TRAINING_STRATEGY.md)); and the core Fugu move — **train our
  conductor's triage/routing policy on our own logged orchestration traces**. We already persist
  every routing decision and outcome; that corpus is what TRINITY/Conductor were trained on, except
  ours grounds in an open pool. Caveat: trace-distillation lift is proven on math, unproven on
  coding — measure before scaling.
- **Phase 3 — the sovereign product.** Single self-contained binary (built + verified, see
  [07-hardening-hosting-ship.md](../features/07-hardening-hosting-ship.md)) + open weights + trained
  coordinator + audit receipts = air-gap deployable. The in-loop governance gate maps 1:1 onto RBI's
  kill-switch / human-oversight / explainability mandate (§7).

## 7. Sovereign buyer fit — verified demand, requirements, pricing

Demand evidence (2025–2026, all sourced): **US DoD** RFI for AI coding tools for "tens of thousands"
of developers at FedRAMP High / DISA IL5
([DefenseScoop, Feb 2026](https://defensescoop.com/2026/02/26/dod-wants-ai-enabled-coding-tools-for-developer-workforce/));
**Mistral × France armed forces** 3-year on-prem deployment (Dec 2025); **RBI's draft AI Model Risk
framework** (2026-06-23) mandating kill switches, human oversight, explainability, and localization
for bank AI, gap-assessment deadline 2026-06-30
([Medianama](https://www.medianama.com/2026/06/223-rbi-ai-guidelines-2026-banks-kill-switch/));
**Sarvam** $234M Series B (HCLTech $150M) explicitly funding "agentic AI, coding, cybersecurity +
defense" — with **no visible coding product yet**. India-specific segmentation and the defense lane
live in [ENTERPRISE_SEGMENTATION.md](./ENTERPRISE_SEGMENTATION.md) and
[DEFENSE_OPPORTUNITY.md](./DEFENSE_OPPORTUNITY.md).

The requirements checklist these deals rank by, mapped to econ:

| Requirement (by frequency in deals) | Fugu / closed-API products | econ |
|---|---|---|
| Air-gap / on-prem deployment | ✗ structurally impossible | ✓ binary + open weights |
| Weights ownership / no revocation risk | ✗ | ✓ |
| Zero external telemetry, code stays in-country | ✗ | ✓ |
| Audit logs + explainable routing | ✗ black-box pool | ✓ receipts log every routing decision |
| Kill-switch / human-in-loop (RBI) | partial | ✓ in-loop governance gate at the edit |
| Local fine-tuning on private code | ✗ | ✓ SERA recipe, $2k-class |

Pricing shape: on-prem buyers pay **2–3× SaaS** (Tabnine $39/user/mo + customer GPU; ~$23k/yr median
enterprise deal; Japan on-prem breaks even vs cloud API at ≈$100k+/yr spend). Estimated window
before the category crowds: **12–18 months**.

## 8. Source quality

Solid: Epoch, a16z, arXiv papers, sakana.ai + the ICLR reports, Anthropic/Apple/NVIDIA docs,
DefenseScoop, github.blog, RBI coverage. Medium (SEO-grade aggregators — treat exact scores as
low-confidence until cross-checked): benchlm.ai, nxcode.io, kilo.ai, kingy.ai, particula.tech's
absolute numbers (its *scaffold-swing* finding is corroborated by arXiv 2605.23950). Fugu-vs-Fable
comparisons are vendor-reported on both sides.

## 9. Watch-list (any trigger → re-evaluate this doc)

1. Next Anthropic Sonnet-tier release + its **agentic** benchmarks (claim (a) resolver).
2. Next DeepSeek/Qwen/GLM flagship **Terminal-Bench** score (the gap that matters, not SWE-V).
3. First **independent** Fugu evaluation (LMArena / Artificial Analysis / academic).
4. Any published **coding**-trace distillation result (unblocks Phase 2 scaling).
5. M5-Ultra-class hardware shipping with real prefill benchmarks (claim (b) resolver).
6. Sarvam shipping a coding product (window check); RBI framework finalization.
