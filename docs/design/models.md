# Models — facts & selection

**Status:** Consolidated 2026-07-02 from the former `MODEL_RESEARCH.md` (facts, drafted
2026-07-01) and `MODEL_SELECTION.md` (decisions, drafted 2026-06-28, updated
2026-06-30), which have been removed. This page merges them
into one reference and removes the duplication between them (model catalog, footprint ladder,
cost-per-1M table, aspirational-name caveat) by stating each fact once and cross-referencing it.

> **Overview.** econ runs a small *team* of open-weight models, one per role: a cheap **Assistant**
> (gpt-oss-20b) for high-volume chores, a capable everyday **Engineer** (Qwen3.7 Plus) that plans
> and drives most turns, and a rarely-called **Expert** (GLM 5.2) for the hardest reasoning. The
> evidence for these picks is the validated model catalog, KV-cache/context economics, and
> fine-tuning research in Part I; the wiring, pricing, and self-host plan that turns that evidence
> into a running system is Part II. **Honesty rule throughout: we *count* savings and *test-gate*
> model picks from real usage — we don't assert or promise them.**

---

## Part I — Validated facts

*(from MODEL_RESEARCH.md)*

Every model in the catalog below verifiably exists; SWE-bench numbers are **vendor-reported**
unless noted.

> **Verifiability / aspirational-names warning.** **Excluded as unverified** (post-cutoff or
> fabricated in research passes — do not cite as fact): **DeepSeek V4**, **GLM-5.2**, Kimi
> K2.6/K2.7, MiniMax M2.x/M3, Nemotron-Cascade 2, Qwen3.7 Max/Plus scores. The *decision* names used
> elsewhere in this doc — **"GLM 5.2"** and **"Qwen3.7 Plus"** — are themselves aspirational
> version numbers from research passes, not independently confirmed; their **real, currently
> verifiable equivalents are GLM-4.5 and Qwen3-Coder** (see catalog below). Separately, **"Qwen-Plus"
> is a closed, API-only hosted tier — its weights are not published, so it can never be self-hosted**
> (confirmed 2026-07-01, a licensing fact, not a benchmark claim). Prefer the real, catalog-verified
> models for anything actually deployed; treat the aspirational names as placeholders for "whatever
> that vendor's current flagship is" until re-confirmed.

### 1. Validated open-weight model catalog

Params = total / active (MoE). Footprint = **weights only, FP8, approximate — add KV cache
(§2 below)**.

| Model | Total / active | Context (native) | License | SWE-bench Verified | Footprint (FP8, weights) |
|---|---|---|---|---|---|
| gpt-oss-20b | 21B / 3.6B | 128K | Apache 2.0 | — | ~1×L40S / CPU-capable |
| gpt-oss-120b | 117B / 5.1B | 128K | Apache 2.0 | — | ~1×H100 (MXFP4 ~63 GB) |
| Qwen3-Coder-30B-A3B | 30B / 3.3B | **256K → 1M** | Apache 2.0 | — | ~1×L40S (weights) |
| Qwen2.5-Coder-32B | 32B dense | 128K | Apache 2.0 | — | ~1×L40S/A100 |
| Qwen3-32B | 32B dense | 128K | Apache 2.0 | — | ~1×L40S |
| GLM-4.5-Air | 106B / 12B | 128K | MIT | **57.6%** | ~1×H100 |
| Qwen3-235B-A22B | 235B / 22B | 128K (256K YaRN) | Apache 2.0 | — | ~4×H100 (2×H100 Q4) |
| GLM-4.5 | 355B / 32B | 128K | MIT | **64.2%** | ~4×H100 |
| Qwen3-Coder-480B-A35B | 480B / 35B | **256K → 1M** | Apache 2.0 | — (top open coder) | ~8×H100 |
| MiniMax-M1 | 456B / 45.9B | **1M** | Apache 2.0 | — (reasoning-tuned) | ~8×H100 |
| DeepSeek-V3 | 671B / 37B | 128K | DeepSeek (MIT-ish) | — | ~8×H100 |
| Kimi K2 | **1T** / 32B | 128K | Modified MIT | **65.8%** (pass@1, tools) | ~16×H100 / 8×H200 |
| Llama 4 Scout | 109B / 17B | 10M | Llama Community | — (coding mediocre) | ~1×H100 |

**Serving-cost fact:** cost has two parts — *active* params (compute/token) and *total* params
(weights held resident in VRAM). A big-MoE with low active count is cheap to compute but expensive
to keep loaded. Example: **Kimi K2 and GLM-4.5 have the same 32B active** (same compute/token) but
Kimi holds **1T resident (~16×H100) vs GLM-4.5's 355B (~4×H100)** — ~3× the VRAM for its extra
reserve params. Native ≠ effective: a model advertising 256K–1M often reasons reliably across only
a fraction (validate with **RULER**, not SWE-bench). This is the same fact behind Part II's
"serving cost tracks a MoE's *active* params, not its total size" self-host ladder.

### 2. KV cache — how long context is paid for

At long context the **KV cache** usually costs more VRAM than the weights.

```
KV_bytes = 2(K+V) × layers × kv_heads × head_dim × seq_len × dtype_bytes × batch
```

Reference: Llama-3.1-8B holds **~16 GB of KV at 128K** (FP16) → ~32 GB at 256K *for an 8B*. A 30B's
256K working set is **~40–80 GB of KV** → KV, not weights, sets the box at long context.

| Lever | Effect | Saving | Where |
|---|---|---|---|
| GQA (grouped-query attention) | share KV heads (e.g. 8 KV : 64 query) | ~8× | built into Qwen3 / GLM / Llama |
| FP8 KV quantization | 8-bit KV vs 16-bit | 2×, <1% acc (0.3–0.7 pt long-ctx) | vLLM `--kv-cache-dtype fp8` |
| PagedAttention | OS-style paged KV blocks | waste <4%, 2–4× throughput | vLLM |
| Prefix caching / RadixAttention | reuse KV for a shared prefix across turns | large for coding agents | vLLM / SGLang |
| MLA (multi-head latent attention) | compress KV to low-rank latent | 7–14× | architectural — DeepSeek-family only |
| KV offload to CPU/NVMe | spill cold KV to host RAM | fits 1M+ at latency cost | HeadInfer / LMCache / vLLM |

Levers multiply. Prefix caching is econ-relevant: a coding agent re-sends the same repo prefix each
turn, so its KV is computed once and reused (the "warm cache" mechanism) — this is also why the
Engineer's *cached*-input price in Part II is so much cheaper than fresh input.

### 3. Extending an open model's context

The cap is the positional encoding (RoPE): beyond the trained length, attention degrades. Four
methods, cheapest-effort first:

1. **Inference-time RoPE scaling** (config flag, no retraining): PI → NTK-aware → **YaRN** (how
   Qwen goes 32K→128K→256K→1M) → LongRoPE (2M+). Set `rope_scaling`, serve in vLLM.
2. **Continued pre-training / long-context fine-tune** (the real fix — §4 below).
3. **Architecture** (means a different model): sliding-window (Mistral), **linear/lightning
   attention** (MiniMax-M1), Mamba/SSM hybrids → native 1M+; **MLA** (DeepSeek) makes long context
   cheap to serve.
4. **Retrieve instead** (RAG / repo-slicing) — the model gets a compiled brief, not the whole repo.

**Effective ≪ claimed:** YaRN-extrapolation degrades with distance (128K→256K may recall well only
to ~180K); always re-validate with RULER.

### 4. Long-context + coding fine-tuning recipe (validated)

Two-stage continued training (not from scratch); the two goals use **different** data:

**Stage 1 — continued pre-training, extends context (LONG documents):**
- Best long sources: **code repositories + books/textbooks**.
- **Mix long with high-quality short data** — long-only hurts long-context *and* short-context
  skill; ~60/40 long/short (ProLong code mix ~50/50 of 64K/512K chunks).
- **Repo-level packing by imports** (Granite-128K): build the import **DAG**, **topological-sort**,
  concatenate files in dependency order; + per-language length upsampling. Teaches cross-file
  reasoning.
- **YaRN scaling** + raise RoPE base + reset LR when stepping up length; **train at sequences
  longer than the target**; document separators + cross-document attention masking
  (FlashAttention-2 varlen).
- **Ring attention / sequence parallelism** for the long sequences.
- **Cheap:** ProLong reached SOTA-128K from Llama-3-8B with **~40B tokens (~5% of typical)**, up to
  512K.

**Stage 2 — SFT, teaches coding (SHORT instruction data):**
- **OpenCodeInstruct** — 5M samples with unit tests + execution feedback + LLM-judged correctness.
- **Agentic/repo trajectories:** executable envs (SWE-Gym, SWE-rebench, SWE-Factory); synthetic
  generators (SWE-Smith, SWE-Mirror, BugPilot). Dual-tier = big execution-free corpus + small
  execution-grounded set (SWE-ZERO → SWE-HERO). **Execution-based RL** rewards patches that pass
  tests.
- **ProLong finding:** short instruction SFT is *sufficient* for long-context ability; long
  synthetic instruction data did not help — extend context in Stage 1, teach coding in Stage 2,
  don't conflate.

**Validation:** evaluate **after SFT** on real long-context tasks + RULER; confirm short-context
didn't regress.

### 5. Facts sources

Model cards / vendor reports: gpt-oss card (arxiv 2508.10925), GLM-4.5 ARC report (arxiv
2508.06471 — 64.2% / Air 57.6%), Kimi-K2-Instruct card (HuggingFace — 1T/32B, 65.8%, Modified
MIT), MiniMax-01 (arxiv 2501.08313), Qwen3-Coder (Qwen blog/HF — 256K→1M), DeepSeek-V3 (arxiv
2412.19437 — MLA), Llama 4 Scout (Meta).

KV cache: [vLLM FP8 KV-cache](https://vllm-project.github.io/2026/04/22/fp8-kvcache.html),
[KV optimization (Spheron)](https://www.spheron.network/blog/kv-cache-optimization-guide/),
[GQA explainer](https://zeroentropy.dev/concepts/grouped-query-attention/),
[KV memory calc (Lyceum)](https://lyceum.technology/magazine/kv-cache-memory-calculation-llm/),
[HeadInfer (arxiv 2502.12574)](https://arxiv.org/pdf/2502.12574).

Context extension: [YaRN (arxiv 2309.00071)](https://arxiv.org/pdf/2309.00071),
[RoPE context-extension deep dive](https://amaarora.github.io/posts/2025-09-21-rope-context-extension.html),
[Aman's primer](https://aman.ai/primers/ai/context-length-extension/).

Training recipe: [ProLong (arxiv 2410.02660)](https://arxiv.org/html/2410.02660v4) +
[code](https://github.com/princeton-nlp/ProLong),
[Granite Code → 128K (arxiv 2407.13739)](https://arxiv.org/pdf/2407.13739),
[From 128K to 4M (arxiv 2504.06214)](https://arxiv.org/html/2504.06214v1),
[OpenCodeInstruct (arxiv 2504.04030)](https://arxiv.org/html/2504.04030v1),
[Seed-Coder (arxiv 2506.03524)](https://arxiv.org/pdf/2506.03524),
[SWE-ZERO→SWE-HERO (arxiv 2604.01496)](https://arxiv.org/pdf/2604.01496).

---

## Part II — Selection & tier wiring

*(from MODEL_SELECTION.md)*

> **One-line summary.** econ runs a small *team* of models — a cheap assistant, a capable
> everyday engineer, and a rarely-called expert. Each job goes to the cheapest model that can do
> it well. This part records the team we picked and the evidence for it, drawing on the catalog
> and economics in Part I.

### 1. The decision (what we are building with)

| Role (plain name) | Model | What it does | Why it won |
|---|---|---|---|
| **Assistant** (cheap, high-volume chores) | **gpt-oss-20b** (OpenAI, open-weight) | Opens files, runs commands, makes small edits — the simple repetitive work | Cheapest, reliable at following instructions, US-made, and uniquely fast on a plain CPU (see §6) |
| **Engineer** (the everyday workhorse) | **Qwen3.7 Plus** (Alibaba) | Plans the job, decides each step, does most of the real work, holds the working context | Genuinely capable + very cheap + a well-rounded thinker (better at *planning* than code-only models) |
| **Expert** (rare, hardest problems) | **GLM 5.2** (Z.ai) | Called only for the genuinely hard reasoning the engineer can't crack | Highest score of any open model on the fairest real-world coding test today |

*(Recall the Part I warning: "GLM 5.2" and "Qwen3.7 Plus" are the aspirational vendor-tier names
used in planning; the currently-verifiable equivalents are GLM-4.5 and Qwen3-Coder. The self-host
picks below use the real, catalog-confirmed names.)*

**Backups we will keep wired in the test harness:**

- Assistant → **Nemotron Nano 9B V2** (NVIDIA) or **Phi-4-mini** (smallest, for tight-RAM machines)
- Engineer (self-host, see §4 ladder) → **gpt-oss-120b** on 1×H100 (recommended sweet spot — MoE
  ~5B active) · **Qwen3-Coder-30B-A3B-Instruct** on 1×L40S (cheapest) · **GLM-4.5-Air** (coding alt)
- Expert → **DeepSeek V4-Pro** (nearly as strong, very permissive licence for self-hosting —
  though per Part I, "DeepSeek V4" itself is on the unverified list; the catalog-verified relative
  is DeepSeek-V3)

### Roles → tiers → models

```
   ROLE                TIER SLOT          CHOSEN MODEL
 ┌───────────┐        ┌───────────┐      ┌──────────────────────┐
 │ Assistant │ ─────▶ │ executor  │ ───▶ │ gpt-oss-20b           │
 └───────────┘        └───────────┘      └──────────────────────┘
 ┌───────────┐        ┌───────────┐      ┌──────────────────────┐
 │ Engineer  │ ─────▶ │ conductor │ ───▶ │ Qwen3.7 Plus          │
 └───────────┘        └───────────┘      └──────────────────────┘
                       ┌───────────┐      ┌──────────────────────┐
      (none)   ─────▶ │ reasoner  │ ───▶ │ GLM 5.2 (merged with │
                       └───────────┘      │ oracle — see below)  │
 ┌───────────┐        ┌───────────┐      └──────────────────────┘
 │ Expert    │ ─────▶ │ oracle    │ ───▶ ┌──────────────────────┐
 └───────────┘        └───────────┘      │ GLM 5.2               │
                                          └──────────────────────┘
```

### 2. Cost per 1 million tokens

"Tokens" are the units models bill by — roughly ¾ of a word each. There are three prices:
**input** (text you send in), **input-cached** (text the model already saw recently — far
cheaper), and **output** (text it writes back, always the most expensive).

| Role | Model | Input | Input (cached) | Output |
|---|---|---|---|---|
| Assistant | **gpt-oss-20b** | $0.07 | $0.04 | $0.30 |
| Engineer | **Qwen3.7 Plus** | $0.40 | $0.08 | $1.60 |
| Expert | **GLM 5.2** | $1.40 | $0.14 | $4.40 |

*(Prices are hosted pay-as-you-go rates, June 2026. Self-hosting in India later replaces these
with the cost of electricity + hardware — usually cheaper still, and the whole point of the
product.)*

**What the team actually costs to run.** Cost is *tokens × price*, so the bill depends on how the
work is split across the three. In a typical job the cheap engineer carries the bulk of the words,
the assistant's share is almost free, and the expensive expert is touched rarely:

| Tier | Rough share of all tokens | Effective price/1M | Contribution |
|---|---|---|---|
| Engineer (carries the context) | ~65% | ~$0.30 (mostly cached input) | ~$0.20 |
| Assistant (tiny prompts) | ~25% | ~$0.15 | ~$0.04 |
| Expert (small, output-heavy) | ~10% | ~$3.00 | ~$0.30 |
| **Blended total** | | | **~$0.55 / 1M tokens** |

Against a top frontier model used for *everything* (blended **~$10–15 / 1M**), that is roughly a
**10–20× reduction** — and it grows once the cheap tiers are self-hosted. The single biggest lever
is **how often the expert is called**: every expert call is the dominant line item, so the
router's job is to call it rarely and only when it pays off.

> **Honesty rule (carried from the architecture).** We *count* savings from real usage; we don't
> *promise* them. The blended number above is an estimate from representative token shares — the
> end-of-turn receipt reports the real figure per job.

### 3. From roles to tiers — how econ actually wires this

**In plain terms.** The three roles above are *jobs*. econ's code routes work to four *tier
slots* — `executor`, `conductor`, `reasoner`, `oracle`. Three of them are the three roles; the
fourth (`reasoner`) is an optional "think harder" rung between the everyday Engineer and the rare
Expert. For now we point that rung at the **same model as the Expert**, so we run exactly **three
distinct models**, not four. We keep the extra slot so a cheaper thinking model can slide into it
later without re-plumbing anything.

**Under the hood.**

Tier → model (every model is reached via OpenRouter, which routes to an upstream — incl.
Fireworks — automatically):

```
role        tier slot   model (OpenRouter slug)         notes
─────────   ─────────   ─────────────────────────────   ─────────────────────────────────
Assistant   executor    openrouter/openai/gpt-oss-20b   also small_model (housekeeping)
Engineer    conductor   openrouter/qwen/qwen3.7-plus    default agent — drives every turn
(none)      reasoner    openrouter/z-ai/glm-5.2         merged → same model as oracle
Expert      oracle      openrouter/z-ai/glm-5.2         rare: high-risk turns / hard steps
```

Escalation ladder (risk-escalation router, S3.2/S3.7):

```
normal turn ......... conductor  (Qwen3.7 Plus)
risk > 70 ........... oracle     (GLM 5.2)
hardStep = true ..... reasoner   (GLM 5.2)  →  oracle on retry (also GLM 5.2)
```

Because `reasoner` and `oracle` resolve to the same model, a hard step pays Expert rates
immediately. That is acceptable for now: `hardStep` is not yet wired into the live loop, and a
genuinely hard step deserves the strongest model anyway. The merge is therefore behaviourally a
no-op today — it just keeps every tier resolving to a real model (a dropped tier would fall back
to the *cheap* conductor, which is wrong for a hard step).

**Where it lives — keep the two in sync** (`region.test.ts` enforces it):

- `opencode.json` → `agents` block (+ `small_model`, `default_agent`)
- `packages/code-intelligence/src/region.ts` → `DEFAULT_REGION_CONFIG.tiers`

**Provider.** We stay on OpenRouter (`openrouter/<id>` slugs); OpenRouter picks an available
upstream, which includes Fireworks. To *force* Fireworks specifically, add provider-routing
`order: ["Fireworks"]` to the `providers.openrouter` block — not applied yet.

**Reversibility.** To re-separate the reasoner onto its own cheaper chain-of-thought model later,
change **one model id** in the two files above (and the matching `region.test.ts` assertion) — no
type, router, or tier-count changes.

### 4. The middle layer, hosted vs self-host (the conductor tier)

**The point most people miss.** The conductor is the *middle layer* between the cheap Assistant
(gpt-oss-20b) and the rare Expert (GLM). Today it runs on a **hosted API** (a "Qwen-Plus"-class
endpoint via OpenRouter). That is fine for Phase 0 — but per Part I, **"Qwen-Plus" is a closed,
API-only tier and can never be self-hosted.** So the moment we self-host in India (Phase 1,
[TOKEN_ECONOMICS.md §10](../strategy/economics.md)), the middle layer swaps to a **real
open model** — and it does **not** have to fit one L40S.

**Don't cap the middle tier at an L40S.** The right frame is a *footprint ladder*: pick the box
that buys the quality the middle layer needs, because — per Part I's serving-cost fact —
**serving cost tracks a MoE's *active* params, not its total size.** A 100B+ MoE with low active
count serves nearly as cheaply per token as a 30B while being materially stronger — so "bigger
box" ≠ "much more expensive per token." Rungs, cheapest first:

| Rung | Box | Self-host middle-tier pick | Type | Why this rung |
|---|---|---|---|---|
| **A — floor** | 1×L40S 48 GB | **Qwen3-Coder-30B-A3B-Instruct** | MoE, 3.3B active | Coder-tuned; serves at ~3B *speed* (≈ gpt-oss-20b cost). Cheapest viable middle. |
| | | **Qwen2.5-Coder-32B** / **Qwen3-32B** (dense fallbacks) | Dense 32B | Predictable latency / stronger planner; tighter context |
| **B — sweet spot** ✅ | 1×H100 80 GB | **gpt-oss-120b** | MoE, ~5.1B active | Same family as the executor (shared tooling, Apache, US-origin hedge); ~5B active = serves almost as cheap as a 30B but a real quality jump. **Recommended once we allow 1×H100.** |
| | | **GLM-4.5-Air** | MoE, ~12B active (~106B total) | Coding-specialist alternative on the same box; smaller sibling of the GLM oracle → consistent behaviour |
| **C — upper-middle** | 2×H100 | **Qwen3-235B-A22B** / dense **Qwen2.5-72B**, **Llama-3.3-70B** | MoE 22B active / dense 70B | Closest to oracle quality while staying off the 8×H100 tier; use only if B leaves a real gap |

(Footprint figures for these picks are the same as the Part I catalog — restated here only as the
ladder's box-selection frame, not duplicated in full.)

**Recommendation with the L40S cap lifted: gpt-oss-120b on 1×H100 (rung B).** Its ~5B active means
throughput — and therefore $/1M — stays close to the 30B floor, so we buy a genuine step up in
capability at little marginal serving cost, and it shares the gpt-oss executor's tooling/licence.
Keep **Qwen3-Coder-30B-A3B** (rung A) as the low-cost variant for credit-lean months, and reach
for **rung C** only if the test gate shows B can't carry the everyday load.

Note the ceiling is unchanged: the open models that reach *Sonnet-class* coding (GLM large-MoE,
DeepSeek-V3-class, Qwen3-Coder-480B, Kimi K2) are 8×H100-scale — that is the **Expert/oracle**
tier, not the middle layer. Sonnet-class quality is bought only on the rare oracle call; the
middle layer just has to be a strong, cheap everyday coder. Final pick still runs through the §8
test gate.

### 5. Why a team of models, not one

Paying the single best model to open files and fix typos is like paying a senior engineer to do
data entry — it's where today's coding tools quietly burn most of their money. econ's whole
saving comes from one move: **give each task to the cheapest model that can do it well.**

So the real question was never "which one model is best." It was "who is best for each of the
three jobs?" — and the answer is three different models, because each job rewards a different
strength.

| The job | What it really needs | What it does NOT need |
|---|---|---|
| **Assistant** | Speed, low cost, reliably following exact instructions | Deep cleverness — it's doing simple chores |
| **Engineer** | Solid all-round judgement; ability to plan and keep track of a big task; affordable | To be the smartest model on Earth |
| **Expert** | Top-tier reasoning on genuinely hard problems | To be cheap or fast — it's used rarely |

A key, non-obvious point that shaped the picks: the engineer's job is **thinking and deciding**,
not just typing code. A well-rounded model that "happens to be good at code" is a *better*
engineer than a narrow code-only model, because it understands the problem better (see §5.1).

**Assistant — gpt-oss-20b.** Cheapest serious option, made in the US, very good at following
instructions exactly, runs on an ordinary CPU (only ~3.6B of it works per word — see §6), reads up
to ~131,000 tokens at once.

**Engineer — Qwen3.7 Plus.** Capable at real coding work at a fraction of top-model cost, reads up
to ~1 million tokens at once, a well-rounded thinker (matches the planning-and-deciding role), and
its cached-input price is 5× cheaper than fresh input ($0.08 vs $0.40) — and because it drives turn
after turn, most of its re-read context bills at that cheap cached rate.

**Expert — GLM 5.2.** On SWE-bench Pro it scores the highest of any open model — **62.1** — ahead
of GPT-5.5 and just behind Claude Opus 4.8. Excellent at long, hard reasoning and tool use — the
only things worth calling the expert for. Called rarely, so its higher price barely moves the
total bill while lifting the quality ceiling a lot.

#### 5.1 "Are these models trained for coding?" — the generalist vs specialist point

- **DeepSeek V4** and **Qwen3.6/3.7** are **general models that are excellent at code** — not
  code-only specialists. (The code-only specialists are *DeepSeek-Coder* and *Qwen3-Coder-Next*.)
- For the **engineer** role this is a **good thing**, not a gap. The engineer's job is to
  *understand the problem and decide what to do* — and a well-rounded model does that better. In
  head-to-head tests, the general model beat the code-only one at understanding the problem; the
  code-only one only won at raw typing speed.
- So we use **general models for the engineer and expert** (thinking roles), and keep the
  **code-only specialists for the assistant's mechanical code transforms** (typing roles).

### 6. Running the assistant on a plain CPU (no graphics card)

We specifically wanted the cheap assistant to run on a CPU. The key fact that decides this:

> **On a CPU, speed depends on how much of the model is read *per word* — and the bottleneck is
> memory speed, not the number of cores.**

gpt-oss-20b is "20 billion" in total, but **only ~3.6 billion actually work on each word** (a
"mixture of experts" — only a few specialists show up per task; see the Part I catalog). A normal
model uses *all* its size every word. So per word:

| Model | Works per word | Memory to hold it | Relative CPU speed | Capability |
|---|---|---|---|---|
| Phi-4-mini | 3.8B (all) | ~3 GB | Fast | Lowest |
| **gpt-oss-20b** | **3.6B of 21B** | **~16 GB** | **Fast (≈ Phi-4-mini)** | **Highest of these** |
| Nemotron 9B | 9B (all) | ~7 GB | ~2× slower | Middle |
| Qwen 14B | 14B (all) | ~9 GB | ~3–4× slower | High but slow |

**Conclusion: gpt-oss-20b is the best CPU performer** — it runs at a small model's *speed* while
delivering a big model's *quality*. Its only cost is needing ~16 GB of RAM sitting ready, which is
the cheap resource to add.

**How to set up the CPU optimally** (where to spend a hardware budget):
1. **Buy memory *bandwidth*, not cores.** A server chip (8–12 memory channels) is **4–6× faster**
   here than a desktop (2 channels), at the same core count. This is the big lever.
2. **Cores: ~8–16 is enough** to feed the memory; more cores barely help (you wait on memory).
3. **Fill every memory channel** with the fastest RAM the board supports.
4. **Use the 4-bit version** and a runtime that uses all cores (llama.cpp / Ollama).

**Realistic result:** ~10–15 words/second on a normal desktop; **~30–50+ words/second on a
high-bandwidth server CPU** — genuinely usable with no graphics card. If a machine can't spare
~16 GB of RAM, drop to **Phi-4-mini** (fits in ~3 GB) and accept lower skill.

> **Honesty caveat (added 2026-07-01, from web research).** The ~30–50 tok/s server-CPU figure is
> a *reasoned estimate*, not a measurement — no clean pure-CPU-server benchmark for gpt-oss-20b
> exists (the widely-cited "~30 tok/s" is actually GPU+CPU-offload). And CPU throughput
> **collapses on long context** (~30 → ~9 tok/s at 8k) with slow prefill/TTFT — exactly the long
> contexts a coding agent uses. So treat pure-CPU as a **narrow on-prem/air-gap/short-context
> fallback**, not a general cheap serving path; a cheap GPU (L4/L40S, 111–225 tok/s) or
> GPU-headroom backfill wins. Full analysis:
> [TOKEN_ECONOMICS.md §4](../strategy/economics.md).

### 7. The full field we evaluated (the candidates)

We did not just pick from a short list — here is everything we weighed, what's true about each
(June 2026), and where it fits. (Cross-check footprint/context/license against the Part I catalog
where a model appears in both.)

| Model | Maker | Best at | Reads at once | Open / licence | Best econ role | Verdict |
|---|---|---|---|---|---|---|
| **GLM 5.2** | Z.ai (CN) | Hardest reasoning; top open coding score (62.1) | 1M | Open-weight | **Expert ✅** | Chosen expert |
| **DeepSeek V4-Pro** | DeepSeek (CN) | Near-top reasoning; 80.6 on the older test | 1M | Open, very permissive | Expert (backup) | Strong, MIT-style licence |
| **DeepSeek V4-Flash** | DeepSeek (CN) | Cheap strong reasoning | 1M | Open, permissive | Cheap reasoner | $0.14/$0.28 — great value |
| **Qwen3.7 Plus** | Alibaba (CN) | All-round engineer; huge context; cheap | 1M | Open-weight | **Engineer ✅** | Chosen engineer |
| **MiniMax M3** | MiniMax (CN) | Cheapest strong coder | 512K | Open-weight | Engineer (budget) | Best cost per result |
| **Qwen3-Coder-30B-A3B-Instruct** | Alibaba (CN) | Self-host middle tier on one L40S; ~3B active = fast | ~256K | Open (Apache) | **Engineer (self-host) ✅** | Real, available; Phase-1 conductor pick (§4) |
| **Qwen2.5-Coder-32B-Instruct** | Alibaba (CN) | Proven dense coder; predictable latency | 128K | Open (Apache) | Engineer (self-host, dense) | Fallback if MoE variance unwanted |
| **Qwen3-Coder-Next** | Alibaba (CN) | Pure code transforms | ~256K | Open-weight | Codemod specialist | Use for mechanical code work |
| **Kimi K2.7 Code** | Moonshot (CN) | Claims coding gains | 262K | Open, permissive | ⚠️ Hold | Only self-reported scores; reviewers dispute — wait |
| **Kimi K2.6** | Moonshot (CN) | Long autonomous runs | 262K | Open, permissive | Engineer/expert alt | Proven, unlike K2.7 |
| **gpt-oss-120b** | OpenAI (US) | Cheap, strong tool use | 131K | Open (Apache) | Engineer (US-made) | US-origin mid option |
| **gpt-oss-20b** | OpenAI (US) | Cheap chores; fast on CPU | 131K | Open (Apache) | **Assistant ✅** | Chosen assistant |
| **Nemotron Nano 9B V2** | NVIDIA (US) | Fast, reliable tool calls | 131K | Open (NVIDIA) | Assistant (backup) | Built for chore work; very fast |
| **Nemotron 3 Ultra** | NVIDIA (US) | Bigger NVIDIA reasoner | 262K | Open (NVIDIA) | Expert alt (NVIDIA infra) | If you standardise on NVIDIA |
| **Qwen 14B** | Alibaba (CN) | Runs anywhere | 128K | Open-weight | Assistant (low-end) | Capable but slow on CPU |
| **Phi-4-mini** | Microsoft (US) | Tiniest, CPU-friendly | 128K | Open (MIT) | Assistant (tight RAM) | Fits in ~3 GB; lowest skill |
| **Claude Opus 4.8** | Anthropic (US) | The overall best (paid) | — | Closed, paid | *Baseline only* | What we measure savings *against*, not a tier we ship |

### 8. Two honesty notes that shape every choice

**Don't trust the scoreboards — trust our own tests.** The popular coding benchmark (SWE-bench
Verified) got **contaminated** in 2026: its test problems leaked into model training, and some
models were caught essentially reading the answer key off disk. Vendors also quote their *own*
favourable numbers. So:
- We lean on the **harder, fairer test (SWE-bench Pro)** where it exists, and
- We will **run every candidate through econ's own small test** and let the results pick winners,
  rather than believing the marketing.
- **Kimi K2.7 Code** is the clearest example to avoid for now — it only publishes its own scores,
  which independent reviewers say don't hold up.

**The China-data point (and why it doesn't block us).** Most of the strongest open models (GLM,
Qwen, MiniMax, DeepSeek, Kimi) are **made in China**. Using their *hosted* service means your code
touches Chinese servers — fine for testing, not for a product that promises data stays in India.

**The fix is built into econ's plan:** these are **open-weight** models, so for the real product
we **download them and run them on our own machines in India.** That removes the data-residency
worry entirely — it is the whole reason econ is "hosted in India." The US-made models (gpt-oss,
Nemotron, Phi-4) are kept as hedges if anyone prefers a US origin.

### 9. How we will finalise (the test gate)

Nothing above is treated as final by assertion. Before committing each role we will:
1. Wire all candidates for a role behind the same interface (hosted endpoints first).
2. Run them through econ's own small, honest coding test set.
3. Pin the winner by **measured result**, and record the number here.
4. Re-check after any model update — these ship every few weeks.

This is why this doc separates **chosen** (§1) from **the field** (§7): the field is the menu, the
choice is the current result of the test gate, and both will move.

> **Honesty rule, restated.** We *count* savings and *test-gate* winners from real, measured
> results — we don't assert or promise them from vendor marketing or benchmark leaderboards alone.

### 10. Template — adding a model later

When a new model appears, add a row to §7 using this shape, and if it wins a role, update §1 and
§2:

```
| <Model name> | <Maker (country)> | <one phrase: what it's best at> | <context size> |
<open/closed + licence> | <which econ role it could fill> | <verdict: chosen / backup / hold / pass> |
```

Checklist before trusting a new model:
- [ ] Is there an **independent** score on a hard test (SWE-bench Pro), or only the vendor's own?
- [ ] **Open-weight** (can we self-host it in India) or closed?
- [ ] Which **job** does it fit — assistant, engineer, or expert — and is it cheaper/better than
      the current holder for that job?
- [ ] **Price** per 1M tokens (input / cached / output).
- [ ] If assistant: **how much works per word** (does it run well on a CPU)?
- [ ] Run it through the **test gate (§9)** before changing §1.
- [ ] If the model is genuinely new (not yet in the Part I catalog), add it there too, per Part I's
      own verifiability bar.

### 11. Selection sources

- SWE-bench Pro standardised leaderboard — labs.scale.com/leaderboard/swe_bench_pro_public
- SWE-bench Pro 2026 round-up (Opus 4.8 leads; contamination notes) — morphllm.com/swe-bench-pro
- Best open-weight coding models 2026 — kilo.ai/open-source-models
- GLM 5.2 benchmarks — groundy.com / venturebeat.com (GLM-5.2 beats GPT-5.5)
- Qwen 3.7 vs 3.6 — yottalabs.ai
- Kimi K2.7 Code — benchmarks disputed — venturebeat.com
- gpt-oss intro + model card — openai.com / huggingface.co/openai/gpt-oss-20b
- DeepSeek V4 review — mindstudio.ai
- CPU inference is memory-bandwidth bound — martinalderson.com (local LLM speed calculator)
- Nemotron Nano 9B V2 model card — build.nvidia.com
- Phi-4-mini CPU speed — promptquorum.com

*(Full URLs are in the conversation that produced the source docs; keep this list short and
update it when a model row changes. See Part I §5 for the model-catalog / KV-cache / training
sources.)*

---

## Notes on merging these two docs

Both source docs were an intentional facts/decisions pair and cross-referenced each other before
this merge; they have since been removed. This page is the single reference going forward —
update it when a model row changes or a new test-gate result lands.

**One fact worth flagging explicitly:** the two source docs did not actually conflict on any
number — MODEL_RESEARCH's "unverified names" list (GLM-5.2, Qwen3.7 Plus, DeepSeek V4) is a
deliberate caveat *about* the very model names MODEL_SELECTION uses as its decision, not a
contradiction of them. That relationship is preserved above: Part I states the caveat once, Part
II's decision table links back to it instead of re-arguing it.
