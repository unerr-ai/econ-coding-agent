# econ — Model Training Strategy (Phase 2)

> **Status:** Drafted 2026-07-02. The strategy for training econ's *own* open-weight
> reasoner — the Phase-2 model that slots into the mid tier of the router. Complements
> [MODEL_SELECTION.md](./MODEL_SELECTION.md) (which *rented/open* models we run in Phase 1)
> and [POSITIONING.md](./POSITIONING.md) (why a custom model is justified). Grounded in seven
> research passes (2026-07-02) + the current codebase. §6–7 add the serving economics (the
> CAPEX→OPEX transfer) and the cheap-model distillation/triage tier. Phase-2 is a *post-funding,
> high-volume* move — this doc is the plan, not a committed build.

This doc answers one question: **once Phase 1 has proven the framework's value, how do we train
our own model in India, cheaply, and keep improving it until it is Claude-Code-usable for our
buyers?**

---

## 0. The thesis in one line

**Spend the training budget on reasoning + procedure — the parametric core that cannot be
retrieved — keep parametric *knowledge* deliberately thin, and serve repo-context, library-docs,
and latest-APIs on the fly through econ's context layer.**

This maps directly onto the orchestrator topology econ already commits to: a **mid-tier ~32B
reasoner** does the boring 80–90% of turns cheaply; a **stateless oracle** catches the hard tail.
The Phase-2 model *is* that mid tier. We do not out-reason the frontier head-on — we route the
hard tail up and specialise the mid tier down.

### Why the thesis holds (the evidence)

| Claim | Evidence |
|---|---|
| Training buys *procedure*, not facts | **Ruis et al. (2024)** — for reasoning tasks, the influential pretraining docs are *procedural* (worked examples, code, derivations) and generalise across structurally-similar problems; facts, by contrast, are looked up from a few specific documents. |
| A small model + retrieval matches a huge model on knowledge | **RETRO** — a 7.5B model + retrieval matched 175B GPT-3 on knowledge tasks (25× fewer params); retrieval and parametric scaling are *complementary* and retrieval keeps improving as the datastore grows, decoupled from model size. |
| A coding agent is mostly procedure | **~70–80% procedure / 20–30% knowledge.** DeepSWE (Qwen3-32B, *pure RL*, 4,500 trajectories) hit **59% SWE-Verified** learning only the loop — explore→plan→edit→test→repair, self-correction, adaptive thinking budget — with no distillation and no memorised repos. |
| Train the model to *fetch* docs, not memorise them | **Gorilla** — *retriever-aware training* lets a 7B model match frontier accuracy by learning to fetch live API docs. **Self-RAG** — models learn *when* to retrieve via reflection tokens. |

### The hard limit (load-bearing)

**Reasoning stays parametric.** Even perfect retrieval is useless if the model can't interpret
what it pulled, doesn't know what to retrieve, or can't plan multi-step over it. So we max
reasoning, thin the knowledge, and **never go too small**: the 7B "matches frontier" results are
for *tool-use / function-calling*, not hard SWE. **32B is the floor** for long-horizon,
multi-file reasoning. The better the model reasons, the better the entire response — retrieval
amplifies a strong reasoner; it cannot rescue a weak one.

---

## 1. How the cheap labs actually did it (transferable vs not)

The honest read first: the famous **"$5.5M" DeepSeek-V3 figure is the *marginal final-run*
rental cost only** — it excludes ~$500M+ of cumulative R&D, ablations, and failed runs. "Cheap"
= genuine algorithmic efficiency **+** accounting that shows only the last run **+** cheap
power/labour we can't copy. Separating those:

**Algorithmic levers we CAN use with 100–300 H100-equivalents:**

| Lever | Win | Notes |
|---|---|---|
| MoE sparsity | ~30% compute cut | DeepSeek 671B/37B-active; Qwen3-Next 80B/**3B-active** (<10% of dense cost). In vLLM/DeepSpeed, no custom silicon |
| FP8 mixed-precision | ~50% cost | Native on H100/H200; the tax is stability tuning |
| MLA / linear attention | memory & FLOPs ↓ | DeepSeek KV-cache compression; MiniMax lightning attention (25–50% FLOPs at long generation) |
| Efficient RL (GRPO / CISPO) | 2× wall-clock | CISPO matched perf at 50% steps; papers public and reproducible |
| Distillation from a strong teacher | 4–8× | Highest impact-per-dollar; also how we bootstrap (§3 flywheel) |

**NOT transferable — do not plan around these:** DualPipe/custom kernels at 500+ GPU scale,
Huawei-Ascend independence, hyperscale ablation budgets, and China's $0.05/kWh power + $22k/yr
ops labour. Renting H100s at $2–4/hr eats margin — which is why *serving* economics (not
training) is where India's cost base and the
[GPU-utilization playbook](./GPU_UTILIZATION_ECONOMICS.md) matter, and where a cheap-power
sovereign rack later changes the equation (see [SOVEREIGN_HOSTING.md](./SOVEREIGN_HOSTING.md)).

**Takeaway:** the algorithmic efficiency is genuinely democratised. What a seed team lacks is
cumulative R&D budget and cheap infrastructure — neither of which is needed **because we
post-train an already-pretrained open base rather than pretrain from scratch.**

---

## 2. How far post-training reaches, and the cost

We do **not** pretrain. We take an Apache-2.0 base and post-train. Reference points:

| Effort | Base | Method | Result | Compute |
|---|---|---|---|---|
| **DeepSWE** | Qwen3-32B | pure agentic RL, 4.5k trajectories | 59% pass@16 / 42% pass@1 Verified | 64×H100 × 6d ≈ **$2–6k** |
| SWE-Gym | 32B | SFT, <500 trajectories | **+14%** over base | ~$300–1.5k |
| SWE-RL (Meta) | Llama-70B | RL + GRPO | 41% | larger |

**Realistic budget for a 5–10 person team:** **~$5k–$20k cloud compute** + 3–6 months
engineering + eval discipline. (The upper bound of ~$0.1M–$2M applies only if you buy dedicated
cluster time and run many iterations; the floor is low because the base is free and RL is
data-efficient.)

**The bottleneck is trajectory *quality*, not quantity** — <500 good trajectories already move a
32B model +14%, with diminishing returns past ~4k. **Build a private held-out eval** from
customer repos: public SWE-bench Verified is contamination-compromised (OpenAI stopped trusting
it), and Scale's SWE-bench Pro exists precisely to separate memorised public scores from
held-out generalisation.

---

## 3. The training recipe

Four stages. Stages 2–4 all train the model **on econ's own tool surface** — the non-obvious
unlock (Gorilla): a model RL'd on *your exact tools* beats a bigger model that never saw them.

**Base:** Qwen3-32B (dense) or Qwen3-Next-80B-A3B (MoE, 3B-active) — Apache-2.0, matches the
"mid 32B reasoner" tier. **Pick MoE only if you'll run at concurrency** — MoE *loses* to a dense
70B on single-stream, bursty edits; the win needs saturation (see
[GPU_UTILIZATION_ECONOMICS.md](./GPU_UTILIZATION_ECONOMICS.md)). Decide by your serving load.

- **Stage 0 — light continue-pretrain (optional, cheap).** A *small* dose of high-quality
  *procedural* data — code with worked reasoning, edit-test-repair traces — **not** knowledge
  dumps. Ruis et al. shows procedure generalises from few tokens; don't bloat it.
- **Stage 1 — SFT bootstrap.** A few hundred–2k *high-quality* agent trajectories to teach the
  loop shape. Source: R2E-Gym / SWE-Gym synthetic + distilled from a strong teacher (the Phase-1
  oracle) *running on our harness*.
- **Stage 2 — agentic RL (the money stage).** GRPO/CISPO with **execution rewards from econ's
  real tools** — tests pass, plus `guardrail.ts` (no breaking change) and `fidelity.ts` as
  reward shaping, plus a **cost-aware term (solve at fewer tokens)** — nobody else optimises that
  denominator. Teaches self-correction and adaptive thinking budget.
- **Stage 3 — retrieval-aware training (makes "serve data on demand" real).** Self-RAG /
  Gorilla-style: train the model to *call* econ's graph tools + web-doc fetch, *decide when* to
  retrieve, and *judge* what it got. `abstention.ts`'s `[[ABSTAIN]]`/`[[UNSURE]]` signal is the
  natural reflection-token analog and doubles as the escalation + retrieval trigger.

### The data flywheel (how we keep improving)

1. Phase 1 ships the framework on *rented* open weights + a strong oracle. Every real customer
   session logs a trajectory: task → tool calls → oracle's successful patch.
2. Those trajectories are our **proprietary training set** — real customer repos, oracle patches
   as distillation targets, tests as ground-truth reward. **No competitor has this data.**
3. Retrain the mid-tier on them → it absorbs more of the tail → oracle-escalation rate drops →
   cost/task falls → the `double-pay` ledger + telemetry we already have measure the gain
   directly.
4. A private held-out eval from held-back customer repos guards against contamination and
   overfitting. Loop.

---

## 4. The parity math

The most important finding: **the harness swings more than a model-tier upgrade.**

- Same model, different harness: **+23–26 points** observed (GPT-5.5: 61.5%→87.2%;
  Opus 4.5: 38.4%→61.7% base→Latch harness).
- Code-graph context (RepoGraph): **+32.8% relative**.
- Best open raw model today: ~69–74% (Qwen3-Coder, Kimi K2, GLM-4.7); best-open frontier ~80.6%
  (DeepSeek V4 / Qwen3.7). Closed ceiling: Opus 4.8 at 88.6%.

The parity arithmetic for econ:

```
  ~70%   post-trained 32B open base (procedure via agentic RL)
  +~5%   strong agentic harness (modules already exist)
  +~3%   code-graph context engineering (RepoGraph-grade retrieval already exists)
  ─────
  ~75–77%  → usable Claude-Code-class parity on most real tasks
  ~11pt gap on the hardest tail → route UP to the oracle
```

**What harness/context does NOT close:** raw reasoning on novel hard bugs (long-horizon,
multi-file, semantic-breakage), and vendor tuning (+3–5 pts from Anthropic/Zhipu corpus-scale
SFT). We don't beat that head-on — we **route around it** (oracle tier) and **specialise below
it** (our own domain).

---

## 5. Grounded in the codebase

**Already built — the inference-time "serve data on demand" layer is essentially done:**

- `packages/code-intelligence/src/bun-sqlite-graph.ts` + `tools.ts` + `webfetch/bm25.ts` — the
  code-graph + web-doc retrieval that supplies knowledge on the fly. *This is the mechanism the
  thesis needs; no new inference build.*
- `router.ts` + `risk.ts` — assign mid-reasoner vs oracle. The trained model **drops into the
  mid tier**.
- `guardrail.ts`, `fidelity.ts`, `abstention.ts`, `double-pay.ts`, `telemetry.ts` — become **RL
  reward channels + the improvement dashboard**.
- `packages/eval` harness — the scaffold to extend into the RL *environment*.

**To build for Phase 2:**

1. **RL environment wrapper** — turn econ's tool surface into a gym env (verl/rLLM-compatible)
   so the model trains against the *same* tools it serves on.
2. **Trajectory-harvest pipeline** — capture Phase-1 sessions → (task, tools, oracle patch, test
   result) records.
3. **Retrieval-aware training data** — traces where the model must call the graph/web tools and
   is rewarded for retrieving the *right* slice.
4. **Cost-aware reward term** — wire `double-pay` / token counts into the RL reward.

Plus the still-open Phase-1 integration gaps (multi-tier turn loop into the live session; UDS
sidecar invocation) — these must land **first**, because they *produce the trajectories* the
model trains on. See [features/README.md](../features/README.md) for seam status.

---

## 6. The serving economics — the CAPEX→OPEX transfer

The thesis (§0) trades *expensive training* for *cheap-per-request serving of in-flight data*.
That is a **CAPEX→OPEX transfer**, and the key result is that the cost **shrinks by 1–2 orders of
magnitude in the transfer** — it does not move 1:1. But the favourability is *manufactured* by
three multipliers and **inverts** the moment any of them breaks.

### The analogy that makes it intuitive

Before coding agents, a developer didn't hold every API in their head — they *searched* docs /
Stack Overflow when they needed a call, then reasoned about what they found. That is
**just-in-time knowledge vs. just-in-case memorization.** econ rebuilds it: the model holds
*reasoning + procedure* (how to evaluate and act); it *fetches* the facts. This is **not
token-efficient** (input bulges) but **capital-efficient** (training gets cheap). The question is
only whether the OPEX taken on is smaller than the CAPEX shed.

### What actually transfers

Not "econ's training → econ's inference." It's **the frontier lab's ~$150M knowledge-packing
pretraining CAPEX → econ's per-request serving OPEX** — because econ never pretrains to memorize
the world (it post-trains *procedure*, §3).

| | Frontier "pack the data in" | econ "serve the data in-flight" |
|---|---|---|
| Knowledge acquisition | Pretraining CAPEX **~$150M+** (they pay; you rent at $5/Mtok) | Post-training **~$5–20k**, packs *procedure* not knowledge |
| Per-request knowledge | $0 extra (in weights) — billed at frontier input rates | Fetch **~$0.001–0.006** + input tokens, then multiplier-crushed |
| Freshness | Stale at cutoff; updating = a retrain ($$$) | Always current; updating = a re-index (~free) |

The freshness row is a *structural* win: a frontier model is stale between retrains; econ is fresh
by construction. On fast-moving APIs that alone justifies the architecture.

### The three multipliers that make the OPEX tiny

The input bulge is real in **token count** but cheap in **dollars**, because three effects stack:

1. **Caching — ~90% off reads.** Cache-read is 0.1× input on Anthropic/OpenAI; DeepSeek is a
   50–120× spread ($0.0028 cached vs $0.14 fresh on V4 Flash). The bulge is *mostly cached* input
   — repo context and injected notes are written once, read every turn. Per the recorded
   orchestrator-topology decision, **econ's sticky mid-tier keeps that cache warm** — the bulge
   *amplifies* the caching discount instead of fighting it.
2. **Cheap model — ~36× lower input rate.** DeepSeek Flash input $0.14/Mtok vs Opus $5.
3. **Bounded context — 5–20× smaller before it hits the model.** Don't dump the 100k-token repo;
   the code-graph + markdown extraction (raw HTML 16k → markdown 3k, ~80% cut) + BM25 passage
   rerank hand the model the *right slice*.

### The estimate — per-turn, and the crossover

One read-heavy coding turn (50k cached context + 5k fresh injected slice + 1k output):

| Path | Input | Output | + Fetch | **$/turn** |
|---|---|---|---|---|
| Frontier, naive dump (55k fresh, Opus, no cache) | $0.275 | $0.025 | — | **~$0.30** |
| Frontier, well-cached (Opus) | $0.025 | $0.025 | — | **~$0.050** |
| **econ (cheap + cached + bounded)** | $0.0008 | $0.0003 | ~$0.0004 | **~$0.0015** |

econ is **~33× cheaper than a *well-cached* frontier** and **~200× cheaper than a naive dump**.
The bulge that costs $300k/mo at 1M turns on naive-Opus costs **~$1,500/mo** on econ.

**Crossover:** econ's post-training CAPEX is only ~$5–20k; against a frontier-cached alternative
it saves ~$48k/mo at 1M turns → **break-even in well under a month** (matches the on-prem
literature: a 32B model breaks even vs Opus in ~0.3 months). Inference dominates training
industry-wide (OpenAI ~$2.3B/yr inference vs ~$150–200M/model training, ~11–15×) — which is
exactly *why* making inference cheap-per-request is the whole game.

### Where it inverts (the boundary box)

Favourable only inside `{warm cache, cheap model, bounded context, engineered fetch}`. It breaks
when:

- **Cold / low-hit cache** — first turn on a fresh repo pays full fresh input; high-churn repos
  keep invalidating; a fleet serving thousands of *uncorrelated* repos concurrently has a
  cache-capacity + eviction problem the sticky-single-repo model doesn't solve for free.
- **Latency, not dollars, is the binding constraint** — live fetch+extract is **3.4s P95** (10s+
  on JS-heavy sites) against a ~1s TTFT budget. You cannot synchronously fetch every turn: cache
  docs, pre-warm, fetch **speculatively/async**. This is the "real engineering effort" of the
  in-flight data layer, and it is the moat — anyone can rent a cheap model; few build the
  fetch+extract+cache+rerank layer that makes the bulge cheap *and* fast *and* reliable.
- **Reliability** — 4–40% of naive fetches fail (bot-blocking, JS, stale data) → wrong data →
  wrong patch. Hardening (retries, residential proxies, fallback chains) is a 2–4 week to 1–2
  month tax; extraction itself is cheap (~$0.001–0.006/fetch, Firecrawl-class).
- **Output-heavy turns** — caching only discounts *input*. Generation-heavy work is output-bound;
  the cheap model still wins (~90× on output) but the caching lever doesn't apply. The bulge
  thesis is strongest for **read/understand-heavy** work — which is most of coding (explore ≫ write).
- **Below ~10M tok/mo** the CAPEX won't amortize — but since econ's CAPEX is $5–20k, not $150M,
  that floor is trivially low.

**Bottom line:** the dollars are decisively favourable; the hard part is not the economics, it's
the latency-and-reliability engineering of the in-flight data layer.

---

## 7. The distillation / triage tier

The multiplier "the bulge is only ever paid by the cheapest model" is made *robust* by an explicit
tier: **a cheap model reads the raw fetched data, distills it to a compiled brief, and sends the
brief up to the reasoner or oracle.** This extends the recorded discipline — *the large tier is
fed a compiled brief, not the raw transcript* — from the transcript path to the **data** path.

Why the shape is right: **extraction + summarization is a high-input / low-output task** — read
80k tokens of noisy HTML/repo chunks, emit a 2k brief. That read:write asymmetry is the ideal
cheap-model job; the expensive tier then pays input tokens only on clean, dense signal.

### The sharp rule: distill before the *oracle*, not reflexively before the mid tier

Distill hop = 80k raw → 2k brief on a cheap model (~$0.14/$0.28 per Mtok) ≈ **$0.012/turn**.
What it saves the consumer (now sees 2k instead of 80k = 78k input saved):

- Consumer = **frontier oracle** ($5/Mtok): saves **$0.39** → **~32× ROI.** ✅
- Consumer = **mid-32B reasoner** (~$0.14/Mtok): saves **$0.011** → **~break-even.** ⚠️

So: **distill when the consumer is expensive, or when the brief is reused across many turns.**
Before the mid-tier, the mechanical bounded-context (graph slice + BM25) is already cheap enough
that a model hop can cost more than it saves. **Always cache the brief** (keyed by repo-state +
query class) so the reasoner reads it across turns — that turns break-even into a clear win.

### It doubles as the first triage gate

```
  fetch/graph  ─▶  cheap DISTILLER  ─▶  MID reasoner  ─▶  ORACLE
  (raw, noisy)     read 80k, emit 2k     reasons over        hard tail only
                   ├─ can it answer? ─▶ DONE (never hit reasoner)
                   └─ else: brief up    └─ abstain? ─▶ escalate with brief
```

The distiller isn't only a compressor — if the cheap model can answer from what it read, the turn
exits before paying the reasoner. That is the adaptive-compute dial
([design/adaptive-compute.md](../design/adaptive-compute.md)) with a data-gathering front-end.

### Three risks, each mitigated by an existing component

1. **Lossy distillation** (the brief drops the one load-bearing token — an exact type signature,
   an off-by-one). → **Keep code/identifiers verbatim, summarize only prose**, and carry
   **citations / a `cache_ref`** so the reasoner can pull the raw span through when it needs the
   detail. `fidelity.ts` guards that the brief didn't lose signal.
2. **Latency hop** (+200–800ms in the critical path). → distill **async/speculatively** and cache;
   never block the turn on it.
3. **Error propagation** (distiller misreads → reasoner reasons over wrong facts). → the
   distiller's `abstention.ts` `[[UNSURE]]` signal escalates *with the raw attached*, not the brief.

### Grounding

- The **Assistant tier (gpt-oss-20b)** in [MODEL_SELECTION.md](./MODEL_SELECTION.md) is the
  distiller — extract-and-brief is exactly its "simple repetitive, read-heavy" role.
- `shell-compress` + `webfetch/bm25` are the **mechanical pre-filter** feeding the distiller
  (bound its input before the cheap model reads); model-based semantic distillation is the step
  *above* lexical ranking.
- `router.ts` orchestrates the escalation; `fidelity.ts` / `abstention.ts` guard the brief; the
  oracle **compiled-brief pattern already exists** — this reuses it.
- **To build:** the distiller as an explicit turn-loop stage + a brief-cache keyed by repo-state,
  wired into the live turn loop (the same integration gap as §5).

---

## 8. The honest limits

- **Retrieval quality becomes the single point of failure.** The context layer is both the moat
  and the risk — a wrong slice compounds into a wrong patch. The graph + BM25 + guardrail must be
  excellent; this is where engineering effort concentrates.
- **Don't go too small.** 32B is the floor for hard SWE; reasoning is parametric and can't be
  retrieved.
- **Owning weights pays off on control / sovereignty / accuracy-on-our-harness, not day-one
  cost** — and only at real volume (~hundreds of M tok/mo). Until then, rent open weights and let
  the flywheel accumulate data.
- **Parity is "usable-parity on most tasks," not "beats Opus."** We win by routing the hard tail
  up and specialising the mid tier down — never by out-reasoning the frontier head-on.

---

## 9. Go / no-go for Phase 2

Trigger the custom-model build only when **all** hold:

1. Phase 1 has shipped and produced a **cost-normalised eval number** ("$X/task at Y% resolved on
   open weights") — the fundraise artifact.
2. Sustained volume approaches **~hundreds of M tokens/month** (owning weights beats renting).
3. We hold **proprietary agent-trajectory data** from Phase-1 customers.

Path once triggered: post-train an Apache-2.0 base per §3; spend the real money on **data
curation + a private held-out eval**, not raw compute; justify on **sovereignty + accuracy +
high-volume unit economics**, not day-one savings.

---

## 10. Sources

**Procedure vs knowledge / retrieval decoupling**
- Ruis et al., *Procedural Knowledge in Pretraining Drives Reasoning in LLMs* — arXiv 2411.12580
- DeepMind, *Improving language models by retrieving from trillions of tokens (RETRO)*
- *Self-RAG* (selfrag.github.io); *Gorilla* (github.com/ShishirPatil/gorilla); *ToolLLM*; *xLAM* (arXiv 2409.03215)

**Post-training coding agents**
- DeepSWE — together.ai/blog/deepswe ; SWE-RL — arXiv 2502.18449 ; SWE-Gym — ICML 2025 ; R2E-Gym — COLM 2025
- OpenAI, *Why we no longer evaluate SWE-bench Verified* (contamination) ; SWE-bench Pro leaderboard (Scale)

**Cheap-training levers**
- DeepSeek-V3 Technical Report — arXiv 2412.19437 ; SemiAnalysis, *DeepSeek Debates* (true cost)
- MiniMax-M1 (lightning attention + CISPO) — arXiv 2506.13585 ; Introl, *Chinese AI efficiency & infrastructure economics*

**Parity / harness decomposition**
- RepoGraph — arXiv 2410.14684 ; Agentless — arXiv 2407.01489 ; ContextBench — arXiv 2602.05892
- *Agent Harnesses Beat Model Upgrades* (mindstudio) ; Harness-Bench — arXiv 2605.27922

**Live-docs / freshness**
- Context Hub (Andrew Ng's team, 2026) ; Context7 (documentation context layer for coding agents)

**Serving economics — caching, extraction, capex/opex** (§6–7)
- Prompt caching across providers — artificialanalysis.ai/models/caching ; *Anthropic vs OpenAI
  prompt caching cost math (2026)* ; DeepSeek API pricing (V4 cache hit/miss) — costgoat.com / cloudzero
- Long context vs RAG cost — sitepoint.com/long-context-vs-rag ; *1M context windows are a trap* (keepmyprompts)
- Inference-vs-training dominance — *Why LLM inference costs more than training* ; on-prem break-even — arXiv 2509.18101
- Extraction cost/reliability — Firecrawl pricing ; Cloudflare *Markdown for Agents* (3.4s P95) ;
  StableBrowse semantic browser layer ; Web Bench (browser-agent benchmark, 2026)
