# econ — Token Economics: COGS, GPU utilization, and pricing

**Status:** Drafted 2026-07-01. The cost model behind econ: what a token actually costs us to serve,
how to maximize GPU utilization across the three model tiers, CPU-vs-GPU for the cheap tier, and how
to price (per-seat / per-1M / weekly-cap) on a low COGS floor. Companion to
[MODEL_SELECTION.md](./MODEL_SELECTION.md) (the tiers + hosted prices),
[ADAPTIVE_COMPUTE.md](./ADAPTIVE_COMPUTE.md) (the compute dial that governs oracle spend),
[SOVEREIGN_HOSTING.md](./SOVEREIGN_HOSTING.md) (rent-vs-own postures) and
[ECON_ARCHITECTURE.md §12](./ECON_ARCHITECTURE.md). All figures June–July 2026; ~₹95/USD; sources §11.

> **One-line thesis.** Routing — not self-hosting — is econ's savings engine: it cuts the bill
> **10–20× vs frontier** by keeping the expensive tier's token share tiny. Self-hosting the *cheap+mid*
> tiers adds a bit more; self-hosting the **oracle barely helps** (it needs ~8 FP8 GPUs it can't shrink
> without wrecking coding accuracy, and its rare calls leave those GPUs idle). At plain commercial GPU
> rates, **self-host blended ≈ the hosted price**; the self-host win only appears with **IndiaAI-
> subsidised / spot oracle GPUs** — or by keeping the oracle on a hosted API longest. So econ's real
> cost lever is **utilization + routing**, its real risk is **uncapped autonomous consumption**, and
> its pricing job is to **meter the oracle tier** while pricing the cheap tiers as a flat seat. The low
> COGS floor is a *choice space*: econ can price aggressively for India **and** hold a healthy margin.

---

## 0. The one equation, and the one insight

**In plain terms.** When you self-host, you don't pay per token — you rent a GPU by the hour whether
it's busy or idle. So the cost of a token is just *"how much did the GPU cost while it produced this
token,"* which depends entirely on **how busy the GPU was**.

**Under the hood.**

```
   cost per 1M tokens  =  GPU_$/hr  ×  277.8  /  ( aggregate_tokens_per_sec  ×  utilization )

   (277.8 = 1,000,000 / 3,600 :  converts $/hr and tok/s into $/1M-tokens)
```

Everything else in this doc falls out of that formula:

- **Utilization is the business.** A GPU at 30% utilization costs **3× per token** vs the same GPU at
  90%. On a cost-led product, keeping GPUs hot *is* the product, not an optimization.
- **Cheapest-per-hour ≠ cheapest-per-token.** A weak GPU that can't batch is expensive per token even
  if it's cheap per hour (see §2 — L4 vs L40S).
- **Routing beats hosting.** The blended cost is dominated by *which tier* serves the tokens, and the
  oracle is 10–100× the cheap tier. Calling it rarely (the `fct` rule: *savings ≈ 1 − large-tier token
  share*) saves more than any hosting decision.

---

## 1. The COGS floor — what a token actually costs us

Self-hosted, at healthy utilization (~60–70%, continuous batching), per tier:

| Tier (model) | Best GPU | Agg tok/s | **Commercial (E2E)** | **Subsidised / spot** | Hosted (today) |
|---|---|---|---|---|---|
| Assistant `gpt-oss-20b` (21B MoE, 3.6B active) | **L40S** | ~3,000 | **~$0.14 / 1M** | — (already floor) | $0.07 in / $0.30 out |
| Engineer `Qwen3.7` (~30B) | **L40S / 1×H100** | ~2,500 | **~$0.17 / 1M** | ~$0.09 / 1M | $0.40 in / $1.60 out |
| Expert `GLM 5.2` (large MoE, **FP8**) | **8×H100 / 4×H200 (TP)** | ~800–2,000 | **~$3–6 / 1M** | **~$1.5 / 1M** | $1.40 in / $4.40 out |
| **Blended** (65% Eng / 25% Asst / 10% Exp) | | | **~$0.55 / 1M** | **~$0.25 / 1M** | ~$0.55 / 1M |

**Three honest readings of this table:**

1. **The 10–20× win is routing, not hosting.** Blended ~$0.55/1M self-host (commercial) vs a
   frontier-for-everything stack at **~$10–15/1M** is the headline — and *all* of it comes from *using
   cheap tiers and touching the oracle rarely* (the `fct` rule), which is equally true on hosted APIs
   (~$0.55/1M). **At plain commercial GPU rates, self-hosting ≈ hosted — no free lunch.** The self-host
   advantage (→ ~$0.25/1M) appears **only with IndiaAI-subsidised + spot oracle GPUs**. Say this
   plainly; do not oversell self-hosting.
2. **The oracle dominates the blend — more than I first thought.** At ~$3–6/1M it contributes ~$0.40
   of the ~$0.55 blend despite only 10% of tokens, because a large-MoE oracle self-hosts at only
   ~800–2,000 tok/s on 8 FP8 GPUs (not the ~4,500 an earlier estimate assumed). Every point of oracle
   token-share is the most expensive point in the system — the router's job (per
   [ADAPTIVE_COMPUTE.md](./ADAPTIVE_COMPUTE.md)) is to keep it small.
3. **The oracle is the *last* tier to self-host.** A rare-call, 8-GPU cluster is the worst utilization
   case — idle 8×H100 between escalations. So keep the oracle on a **hosted per-token API longest**,
   or on **subsidised/spot/customer** GPUs, and self-host only once fleet-wide oracle volume can fill
   the node (see §3.2). Customer-hosted sovereign deployments move the oracle's 8×H100 onto *their*
   books entirely ([SOVEREIGN_HOSTING.md](./SOVEREIGN_HOSTING.md)).

---

## 2. Utilization is the whole game

**In plain terms.** The difference between a profitable and a ruinous GPU bill is not the GPU you pick
— it's how full you keep it.

**Under the hood — the three utilization facts:**

**2.1 Idle is catastrophic.** A GPU rented to emit a trickle of tokens is pure loss:

```
   L40S ($1/hr) producing...      effective tok/s     cost / 1M tokens
   ───────────────────────────────────────────────────────────────────
   3,000 tok/s  (full batch)          3,000              $0.09
     900 tok/s  (30% util)              900              $0.31
       3 tok/s  (one idle stream)         3              $92.00   ← the "self-host is expensive" myth
```

The last row is where "self-hosting costs $660/1M" numbers come from — they're **idle-GPU** numbers,
not batched ones. **Below a load that fills a shared pool, do NOT self-host — rent per-token**
(the Phase-A posture in [SOVEREIGN_HOSTING.md](./SOVEREIGN_HOSTING.md)).

**2.2 Cheapest-per-hour ≠ cheapest-per-token.** The batch-ability of the GPU dominates:

| GPU | ₹/hr | $/hr | gpt-oss-20b agg tok/s | **$/1M** | verdict |
|---|---|---|---|---|---|
| **L4** | 50–70 | ~$0.63 | ~80 (can't batch) | **~$2.19** | cheap/hr, **worst/token** |
| **L40S** | 80–150 | ~$1.00 | ~3,000 | **~$0.09–0.14** | **sweet spot** |
| **H100** | 249 | ~$2.62 | ~16,500 | ~$0.044 | best/token, scarce |
| **H100 (IndiaAI)** | 92 | ~$0.97 | ~16,500 | **~$0.016** | best overall if available |

L4 looks cheapest but is **~15–25× worse per token** than an L40S because it can't hold a batch.
**Pick GPUs by $/token at target utilization, never by $/hour.**

**Single-stream vs parallelism (why "100+ tok/s on a cheap GPU" needs a batch size).** The headline
single-user speeds — RTX 5060 Ti ~111 tok/s, RTX 4090 ~225, L40S ~200–400 — are at **batch size 1
(parallelism = 1)**: one request, the *latency* a single dev feels (L4 is ~80 at batch 1, just under).
*Cost* comes from the other end: crank **parallelism** (continuous batching, dozens of concurrent
requests) and aggregate climbs to **~3,000 tok/s (L40S)** / **~16,500 (H100)** while per-request eases
but stays usable — gpt-oss-20b is MoE (3.6B active → light compute), so it batches well before
saturating. The sweet spot gives **both**: L40S serves one user at 200–400 tok/s *and* ~3,000 batched.

**2.3 The utilization levers (how we keep GPUs hot):**

- **Continuous batching** (vLLM / SGLang) — many requests share the GPU; the single biggest lever.
- **SGLang for agent workloads.** SGLang ~16,200 tok/s vs vLLM ~12,500 on H100 (+29%), and its
  **RadixAttention gives up to 6.4× on shared-prefix / multi-turn** — exactly agent traffic. Use
  SGLang for the conductor/oracle; either for the executor.
- **Sticky mid tier + warm cache.** Per the `dec` topology note (mid-tier default reasoner, *sticky
  mid keeps cache warm*), keeping the conductor resident lets re-read context bill at cached rates —
  turning turn-after-turn context into near-free prefix hits.
- **Global queue per tier** — pool all customers' requests into one batched serving queue per model,
  so no single tenant's lull idles a GPU (especially the scarce oracle GPUs).
- **Right-sized GPU per tier** (§3) and **spot/burst for the oracle** (interruptible ₹70–88/hr H100
  spot for rare oracle bursts instead of a standing reservation).

---

## 3. The GPU-availability allocation model (cost-based, by scarcity)

**In plain terms.** Run the high-volume cheap models on **commonly available** GPUs and scale them
wide; reserve the **scarce, expensive** GPUs for the rare expert model and keep those pinned at near-
100% utilization. This is exactly the preference to encode.

**Under the hood.**

```
 tier         model          GPU class (by availability)     scaling pattern          util target
 ──────────   ────────────   ─────────────────────────────   ──────────────────────   ───────────
 Assistant    gpt-oss-20b    COMMODITY  L40S / L4 / CPU       scale WIDE, many cheap    fill via batch
 (executor)   (21B MoE)      (abundant, cheap, anywhere)      nodes; CPU fallback       (or CPU, §4)
 Engineer     Qwen3.7        MID        L40S / 1×A100/H100     moderate pool, sticky     high (sticky
 (conductor)  (~30B)         (widely available)               resident, warm cache      cache)
 Expert       GLM 5.2        SCARCE     8×H100 (TP8) / H200    FEW instances, GLOBAL     MAX (~100%,
 (oracle)     (large MoE)    (contended, expensive)           QUEUE across all tenants  queue-fed)
```

Why this is the cost-optimal shape:

- **Cheap tiers on abundant silicon = supply safety + low $/token.** L40S/L4 are everywhere (E2E,
  Spheron, every Indian cloud); you never bid against the market for them, and the executor can even
  drop to **CPU** (§4) when no GPU is free. Scale horizontally in cheap increments.
- **Oracle on scarce GPUs, but rare → keep it hot.** The 8×H100 oracle node is the costliest resource,
  so the one thing you must never do is let it idle. Because oracle calls are rare *and* latency-
  tolerant (they're the hard-tail escalations), **batch every customer's oracle calls into one global
  queue** — a handful of nodes serve the whole fleet at ~100% utilization. Use **spot H100** (₹70–88/hr)
  for burst above the reserved node.
- **IndiaAI subsidy → point it at the oracle.** The subsidy's biggest rupee impact is on the tier with
  the most GPUs and highest rate — the oracle. Apply the ₹92/hr subsidised capacity there first.

### 3.1 Co-locating the executor on spare capacity (GPU backfill)

**In plain terms.** The cheap executor (`gpt-oss-20b`) is so small it can ride on the *idle headroom*
of the conductor's and oracle's GPUs instead of always needing its own — turning those tiers' idle
troughs into near-zero-marginal-cost executor throughput.

**Under the hood — VRAM is the gate, idle compute is the prize.** gpt-oss-20b needs only ~12–16 GB
(4-bit) and is MoE (3.6B active → light compute). Whether it co-locates depends on the primary model's
spare VRAM:

| Host GPU (primary) | Primary VRAM | Free VRAM | Executor fit |
|---|---|---|---|
| **Conductor 1×H100 (80GB)** | Qwen FP8 ~32GB | ~48GB | ✅ **best** — ample room + KV; one H100 serves mid + cheap |
| **Conductor 1×L40S (48GB)** | Qwen FP8 ~32GB | ~16GB | ⚠️ tight — no KV headroom; only if Qwen→4-bit (~19GB) |
| **Oracle 8×H100 (640GB)** | GLM FP8 ~600GB | ~5GB/GPU | ❌ won't fit at FP8 |
| **Oracle 8×H100** | GLM 4-bit ~200GB | ~40–60GB/GPU | ✅ fits **if** GLM quantized + strict preemption |

Three conditions make backfill safe:

1. **Spare capacity lives in the troughs.** A conductor held at >70% util (the §2 goal) has little
   room; backfill's real prize is the **conductor's lulls** and the **oracle's idle time** (rare-call
   → its 8×H100 sit idle most of the time; that idle *compute* is the biggest win, when GLM's VRAM
   footprint leaves room for the executor weights).
2. **Priority preemption is mandatory.** The executor must be a **best-effort filler** that yields
   instantly to the owner tier (MPS/MIG or a priority scheduler) — otherwise oracle backfill delays
   the very escalations the oracle exists for.
3. **Split the executor's own workload by latency.** Co-located latency is bursty (spikes when the
   primary is busy) — fine for **batch/agent chore work**, bad for **inline completion**. Keep
   latency-critical completion on dedicated commodity L40S/CPU; backfill only the batch work.

**Verdict — hybrid, not either/or.** Run a small **commodity baseline** (L40S/CPU) for latency-
critical executor traffic **plus opportunistic backfill** of batch executor work onto conductor/oracle
headroom. The backfill runs at **~zero marginal cost** (the GPU is already paid for and would idle),
so it **raises blended utilization and lowers $/token across every tier** — the §0 lever. Best single
fit: the executor riding the **conductor's H100 headroom**; oracle backfill is a bonus available only
when GLM is quantized enough to spare VRAM.

### 3.2 Quantizing the oracle — FP8 is the floor, INT4 kills coding

**In plain terms.** You can shrink the oracle's GPU count with quantization, but the oracle is the one
tier where you must **not** trade away accuracy — it exists to be the coding-quality ceiling on the
hard tail. So quantize to FP8 and stop.

**Under the hood — the ladder (GLM/DeepSeek large-MoE class):**

| Precision | VRAM vs BF16 | GPU count | Coding quality | For econ's oracle |
|---|---|---|---|---|
| BF16 | 1× | 16×H100 / 8×H200 | perfect | wasteful |
| **FP8** | **½** | **8×H100 / 4×H200** | **−<1–2 pt SWE-bench (near-lossless)** | ✅ **the floor** |
| INT4 / AWQ / GPTQ | ¼ | 4×H100 / 2×H200 | **−5–10 pt HumanEval/SWE-bench** | ❌ craters coding |
| Q2 GGUF | ⅛ | 1 box (Mac 256GB) | solo-dev, ~3–9 tok/s | ❌ not production |

The load-bearing finding: **INT4 barely dents MMLU (−0.5–0.9 pt) but drops *coding* benchmarks
5–10 pt.** So you *can* fit GLM on 4×H100/2×H200 — and it's fine for generalist/batch work — but for a
coding oracle it guts the tier that matters. **FP8 is near-lossless and the production standard; treat
~8×H100 / 4×H200 as the irreducible oracle footprint.** The real "cheaper oracle" levers are hourly,
not GPU-count: **IndiaAI-subsidised (₹92/hr) or spot H200 (~$5.72–11.44/hr vs ~$21 on-demand)**, global-
queue utilization, customer-hosting, or staying on a hosted API until fleet oracle volume fills a node.

---

## 4. CPU vs GPU for gpt-oss-20b (the cheap tier)

**In plain terms.** gpt-oss-20b *can* run on a plain server CPU with no graphics card — but that's a
**deployability** advantage, not a cost advantage. Per token, a batched GPU is far cheaper.

**Under the hood — reconciling the contradiction, honestly.** Generic "20B on CPU is <1 tok/s" advice
is a *dense-model* answer. gpt-oss-20b is **MoE with only ~3.6B active params** and ships in **MXFP4
(~12 GB, runs in 16 GB RAM)**, so CPU decode is memory-bandwidth-bound on ~1.8 GB/token, not the full
20B — that much is real. But the research (2026) adds three cautions that downgrade the earlier bullish
read (incl. [MODEL_SELECTION.md §8](./MODEL_SELECTION.md)):

- **No clean pure-CPU-*server* benchmark exists.** The oft-cited "~30 tok/s" is actually an RTX 3060 +
  CPU-offload (PCIe-bound), not CPU-only. The ~30–50 tok/s server figure is a **reasoned estimate**
  (a high-BW dual-EPYC at ~600–900 GB/s *should* clear it), not a measurement.
- **Long context collapses it** — a real datapoint shows **30 → 9 tok/s at just 8k context**, and CPU
  **prefill/TTFT** on a big prompt is slow. Coding agents are long-context → this is the real blocker.
- A **cheap GPU dominates**: same model does **111 tok/s (RTX 5060 Ti)** to **225 (RTX 4090)**.

| Substrate | Throughput | Monthly cost | **$/1M tokens** | Caveat |
|---|---|---|---|---|
| **L40S (batched)** | ~3,000 tok/s | ~₹73k (~$770) | **~$0.14** | the default |
| **Server CPU (dual EPYC)** | ~15–50 tok/s (short ctx); **~9 at 8k** | ~₹80–120k (~$1,000) | **~$5–9** | *estimate; degrades on long context* |

CPU is **~40–60× worse per token** than a batched L40S **and** weak on the long contexts agents use.

```
 USE CPU for gpt-oss-20b ONLY when:                USE GPU when (almost always):
 • customer on-prem / air-gapped (no GPU)          • any high or steady volume (fills a GPU)
 • truly low volume + SHORT context                • latency-sensitive interactive completion
 • marginal use of spare servers (~$0)             • long-context agent turns (CPU prefill too slow)
 • supply hedge when no GPU is procurable          • the executor is a big share of fleet traffic
```

**Bottom line (revised down):** CPU is a **narrow deployability fallback** — on-prem/air-gap and
short-context chore work only — **not** a general low-cost serving path. It's weaker on agent-length
context than first framed; prefer a cheap GPU or the §3.1 backfill onto conductor headroom, and reserve
CPU for the no-GPU-available case.

---

## 5. What a developer actually costs us

Blended COGS × how much a dev consumes. Consumption varies ~1000× between a light user and a
turned-loose autonomous agent — which is the whole pricing problem:

| User profile | Tokens / month | COGS @ ~$0.30/1M (self-host) | COGS @ ~$0.55/1M (hosted) |
|---|---|---|---|
| **Light** (completion, some chat) | 0.1–0.5M | **~$0.03–0.15** | ~$0.06–0.28 |
| **Regular** (chat + agent, daily) | 0.5–3M | **~$0.15–0.90** | ~$0.28–1.65 |
| **Power** (heavy multi-file, reasoning) | 5–20M | **~$1.50–6.00** | ~$2.75–11 |
| **Autonomous / agent fleet** (long runs) | 100M–1,000M | **~$30–300** | ~$55–550 |

**In plain terms.** For 95% of *interactive* developers, we spend **under $6/month** to serve them —
a flat seat is hugely profitable. The margin only gets thin in two cases econ deliberately courts:
**(a) aggressive India pricing** (a ₹800 seat leaves less room), and **(b) autonomous/agentic
workloads** whose token burn is 10–100× interactive and would torch any flat seat. **These two cases
— not our cost structure — are the entire margin story.**

---

## 6. Pricing design — seat floor + metered oracle + fair-use cap

**In plain terms.** Charge a flat seat that covers the cheap tiers (predictable, near-free to serve),
and **meter the expensive tier and autonomous runs** so heavy users pay for what they burn. This is
where every incumbent has converged.

**Under the hood — what the market does (2026):**

| Product | Structure | The margin-protecting mechanism |
|---|---|---|
| **Claude Code** | seat + **opaque weekly multiplier caps** (1× / 5× / 20×) | weekly hard cap; token counts never published |
| **GitHub Copilot** (Jun 2026) | seat + **AI Credits, model-multiplier metering** | base 0× · standard 1× · **reasoning 5–10×** |
| **Cursor** | seat + included usage → pay-as-you-go overage | per-model usage allocation |
| **Windsurf** | seat + daily/weekly quota | hard quota |

**econ's model — the tiers *are* the meter.** econ has a natural cost gradient (executor → conductor
→ oracle) that maps directly onto Copilot's multiplier idea:

```
 executor (gpt-oss)   included in seat        (0–1× — effectively free to serve)
 conductor (Qwen)     included in seat        (1× — the workhorse, cached, cheap)
 oracle (GLM 5.2)     METERED / weekly budget (5–10× — the one line item that moves the bill)
 autonomous agent-run METERED per run / per-1M (priced separately — the margin killer if flat)
```

**Proposed structure (India-first, INR):**

| Plan | Price (₹/mo) | ≈ USD | Includes | Oracle / agent |
|---|---|---|---|---|
| **Individual (PLG)** | ₹999 | ~$12 | executor + conductor, fair-use | weekly oracle budget; overage metered |
| **Pro** | ₹2,499 | ~$30 | higher caps | larger oracle budget + agent minutes |
| **Team / Business** | ₹3,500 / seat | ~$42 | Pro + shared workspace, SSO | metered oracle + agent-run billing |
| **Enterprise / Sovereign** | platform licence + seat | — | **customer-hosted (their GPU)** | econ bears ~0 GPU COGS → 80–90% software margin |

Design rules:
1. **Seat covers cheap tiers; meter the oracle** (weekly budget or credits), Copilot-style multiplier.
   Interactive devs never hit it; only heavy reasoning users do — and they should pay.
2. **Price autonomous/agent runs separately** (per-run or per-1M) — never let a flat seat fund an
   uncapped agent fleet (§5).
3. **Weekly fair-use cap** as the Claude-Code-style backstop against pathological burn.
4. **Sovereign = customer-hosted.** Push regulated buyers to run the oracle on *their* GPUs; econ
   licences software → COGS ≈ 0, margin 80–90% (the highest-margin path econ has).
5. **Expose it in the savings receipt.** Per-task cost + N×-vs-frontier, live — turning our low COGS
   into the buyer-facing product (§7).

---

## 7. Target unit economics & how to portray them

**In plain terms.** AI tools bleed the classic 80% SaaS margin down to ~52–70% because inference is a
real cost of goods. econ's routing + self-hosting keep COGS low enough to sit at the **top** of that
band — and the way to sell it is *cost-per-outcome* + a *falling AI-COGS ratio*, not a raw price.

**Under the hood — the 2026 benchmarks (what investors measure):**

| Metric | Classic SaaS | AI SaaS 2026 | **econ target** |
|---|---|---|---|
| Gross margin | 77–81% | 52–70% (LLM-native ~65% high end) | **65–80%** (top of band; ~90% on sovereign licence) |
| **AI COGS ratio** (inference ÷ revenue) | ~0% | ~23% at scale; **red flag >30%** | **<15%** and falling |
| LTV : CAC (contribution basis) | 3–4× | needs ~4.6× (AI variability) | ≥4.5× |
| CAC payback | ≤12 mo | ~18 mo median | <18 mo |
| Rule of 40 | growth% + margin% ≥ 40 | still applies | ≥40 |

**Why econ can sit at the top of the band:** the router-as-software play runs at **65–75% margin**
(Martian et al.) vs commodity inference at **40–55%** (DeepInfra/Groq). econ is the *router/harness*,
not the *inference vendor* — so we should portray ourselves as the **high-margin intelligence layer**,
never as a cheap-tokens reseller.

**How to portray the unit economics (in order of investor impact):**

1. **Cost per resolved task / per PR.** A coding task ≈ 0.5–1M tokens end-to-end → **~$0.15–0.30
   self-hosted** vs **~$5–15 frontier-for-everything**. "We resolve a ticket for pennies" beats any
   $/1M-token table. This is the headline metric.
2. **AI-COGS-ratio trajectory to <15%.** Show the ratio falling quarter-over-quarter (routing tightens,
   utilization rises, self-host share grows). Investors reward the *slope*, not the starting point.
3. **N× vs frontier, proven live.** The savings receipt (our product surface) is the *evidence* —
   aligns with the 2026 usage-based-transparency trend (Copilot exposing hidden cost). We don't
   *promise* savings; we *count* them (the honesty rule from [MODEL_SELECTION.md](./MODEL_SELECTION.md)).
4. **Contribution-margin LTV:CAC**, not revenue LTV — the metric AI investors now insist on.

> **The framing in one line:** *"econ is a 65–80%-margin routing/harness layer that resolves coding
> tasks for pennies and drives its own AI-COGS ratio toward <15% — priced as a seat with a metered
> expert tier, so power users and autonomous fleets pay for the compute they burn."*

---

## 8. The margin-protection playbook (each rule ties to a number)

1. **Keep utilization >60%** — below it, $/token doubles (§2.1). Global per-tier queues + batching.
2. **Meter the oracle** — it's 10× the cheap tier and ~⅔ of the blend (§1). Weekly budget / multiplier.
3. **Price autonomous runs separately** — 100M–1B tokens/mo is $30–300 COGS (§5); never flat.
4. **Buy GPUs by $/token, not $/hr** — L40S over L4 (~15–25× better/token, §2.2).
5. **SGLang + warm cache** — +29% throughput, up to 6.4× on agent prefixes (§2.3) → lower $/token.
6. **Push sovereign buyers to customer-hosting** — moves oracle GPU COGS to their books (§6).
7. **Point the IndiaAI subsidy at the oracle** — halves the most expensive tier (§1, §3).
8. **Spot/burst the oracle** — ₹70–88/hr interruptible for rare bursts vs a standing reservation.
9. **Backfill the executor onto conductor/oracle headroom** (§3.1) — soaks idle troughs at ~zero
   marginal cost, raising blended utilization; keep it best-effort with preemption to the owner tier.

---

## 9. Worked example — 100 developers, econ India SaaS

```
 Assume: 100 seats, mostly regular interactive use + some agent runs.
   interactive tokens   : 100 devs × 3M/mo            =   300M tok/mo
   autonomous/agent      : 20 devs × 10M/mo            =   200M tok/mo
   total                                               =   500M tok/mo
   blended COGS @ $0.55/1M (commercial self-host)      =   $275 / mo   ($2.75 / dev)
     (@ $0.25/1M with IndiaAI-subsidised + spot oracle =   $125 / mo)

 Revenue @ ₹2,499 (~$30) Pro seat × 100                =   $3,000 / mo
   gross margin  = (3,000 − 275) / 3,000               =   91%   ← interactive-dominated: still fat

 Now let autonomous burn 10× (2.3B tok/mo, uncapped):
   COGS = 2.3B × $0.55/1M                              =   $1,265 / mo
   gross margin (if NOT metered)                       =   58%   ← the margin killer
   → META: meter the agent runs → the heavy users fund their own COGS, margin holds ~90%.
```

The example shows the thesis: **interactive users are almost pure margin; autonomous burn is the only
thing that moves it — and metering (not a lower COGS) is the fix.**

---

## 10. Phased hosting plan — sequence capital to volume

**In plain terms.** Host nothing until real volume can fill a GPU; then self-host the **cheap tiers
first** and the **oracle last**, because the oracle is the hardest tier to keep busy. This turns every
hosting decision into a volume trigger, so capital follows revenue instead of leading it.

**Under the hood.** A tier is worth self-hosting only once its sustained volume fills a GPU at >60%
utilization (below that, hosted per-token wins — §2.1). The fill thresholds:

```
 fill one L40S  @60% util, 3,000 tok/s   ≈  4.7B tokens/mo   → cheap/mid tier self-host trigger
 fill 8×H100 FP8 oracle @60%, ~1,500 t/s ≈  2.4B oracle tok/mo (≈20–30B total fleet) → oracle trigger
```

| Phase | Trigger | What to self-host | GPUs | econ capex | Findings applied |
|---|---|---|---|---|---|
| **0 — Now (MVP)** | any volume | **nothing** — all tiers on hosted per-token API, routed to **India-resident endpoints** (Yotta/E2E/AceCloud) | — | **~$0** (opex, scales w/ revenue) | self-host at low volume = idle GPUs = ruinous (§2.1); India endpoint buys DPDP residency at $0 capex |
| **1 — Cheap+mid** | a tier sustains **~2–5B tok/mo** | **gpt-oss-20b + Qwen** on **L40S**; executor **backfilled on conductor headroom** (§3.1). **Oracle stays hosted.** | L40S pool | low (opex lease) | captures ~90% of tokens at self-host cost while dodging the oracle's bad economics |
| **2 — Oracle (last)** | fleet oracle **~2–3B tok/mo** (≈20–30B total) | **GLM 5.2 FP8** on **8×H100 / 4×H200**, global-queue hot; **IndiaAI-subsidised / spot** | 8×H100 / 4×H200 | moderate | FP8 only — INT4 craters coding (§3.2); oracle = worst utilization → self-host it *only* when it fills a node |
| **3 — Sovereign / on-prem** | a regulated customer requires it | **customer-VPC** deploy — *customer* bears GPU; econ licences software | customer's | **~0 GPU** → 80–90% margin | CPU gpt-oss for air-gap short-context (§4); oracle on their H100/H200 FP8 |

**Cross-cutting rules that carry this turn's findings:**

1. **Oracle is the last tier to self-host** — and never below FP8 / 8×H100 for coding quality (§3.2).
2. **Keep the oracle on a hosted API (or customer/subsidised/spot GPUs) longest** — a rare-call 8-GPU
   node is the worst utilization case; at plain commercial rates self-host ≈ hosted (§1).
3. **CPU is on-prem/air-gap/short-context only** — not a general cheap-serving path (§4).
4. **Meter the oracle tier from day 0**, wherever it runs — it's ~⅔ of the blend and the margin risk (§6).
5. **Point IndiaAI subsidy + spot at the oracle**, buy GPUs by $/token not $/hr (L40S over L4) (§2–3).

> **Phased-plan verdict:** Phase 0 is *the whole product today* — hosted, India-resident, $0 capex,
> routing does the saving. Self-hosting is an **earned** optimization: cheap tiers at ~2–5B tok/mo,
> the oracle only at fleet scale, sovereignty on the customer's iron. Don't raise for GPUs you can't
> yet fill.

---

## 11. Founder-mode financial model — Month 1 → breakeven

**In plain terms.** In the initial phase it's just the founders — no salaries — so the only cost that
actually scales is **inference (GPU)**. And because Phase 0 runs on **hosted per-token** inference
(§10), that GPU cost is **purely usage-based: $0.55 per 1M tokens consumed, zero idle, zero capex.**
Everything else (cloud, tools, compliance) is wrapped into a flat **$500/month**. That's the whole
model — and it makes breakeven a *tiny* number.

**Under the hood.**

**Cost structure (founder mode):**
```
  Monthly cost = $500 flat           (all non-GPU: cloud + tools + compliance; founders unpaid)
               + inference (GPU)      = tokens_consumed × $0.55/1M   (Phase-0 hosted, usage-based)
```

**11.1 Per-paying-user unit economics (base case)**

| Line | Value | Assumption |
|---|---|---|
| Revenue (ARPU) | **+$18.00** | blended ₹1,500/mo (mix of ₹999 Individual / ₹2,499 Pro) |
| Inference / GPU cost | −$2.75 | **5M tokens/user/mo** × $0.55/1M (hosted blended) |
| Payment fee (~2%) | −$0.36 | Razorpay/UPI-class domestic |
| Free-tier burn (allocated) | −$1.49 | 9 free : 1 paid, free tier **capped at 0.3M tok/mo** |
| **Contribution / paid user** | **≈ $13.40** | **~74% margin** |

> The two numbers everything swings on are **tokens/user (5M)** and **ARPU ($18)** — see §11.4.
> Free-tier burn is the one cost that scales with *signups*, not revenue — which is why the free tier
> must be **metered/capped**, never unlimited (an uncapped free user can cost more than a paid one).

**Reality checks from India-cost research (2026):**
- **ARPU is the #1 assumption risk.** India *individual*-dev WTP for Cursor/Copilot-class tools is only
  **₹400–600 ($5–7)** — *below* the ₹999 Individual price. The $18 blended ARPU **only holds if the mix
  leans Pro/team/GCC** (India B2B mid-market pays **₹15,000–40,000/seat**). *Takeaway:* don't bank on
  solo India devs at ₹999; the money is **B2B/GCC seats**, where ARPU is *higher* than $18. Model the
  individual tier as a **funnel/land**, not the revenue.
- **Payment fee ~2% is conservative.** Razorpay domestic cards ~2%, but **UPI is 0% (RBI-mandated)** —
  a UPI-heavy India base pays **near-zero** fees. Upside to the contribution above.
- **GST is pass-through, not a cost.** 18% B2B is charged *on top* and input-tax-credit-claimable
  (exports zero-rated) — correctly excluded from COGS.
- **OpenRouter's +5.5% markup** is already inside the ~$0.55/1M blended (~$0.03 impact); go direct-to-
  provider above ~$1k/mo spend to shave it.

**11.2 Breakeven (founder mode)**

```
  Breakeven paid users  =  $500 fixed  ÷  $13.40 contribution  ≈  37 paying users
```

**~37 paying users covers everything.** At a dev-tool trial→paid rate of 5–15%, that's ~250–750
signups. **The constraint is no longer cost — it's acquisition and conversion.**

**11.3 The ramp — Month 1 → 6 (founder-led PLG)**

```
        paid   revenue    inference+free-burn    +$500 fixed    net / mo    cumulative
  ───────────────────────────────────────────────────────────────────────────────────
  M1     12      $216            $51                $500          −$335        −$335
  M2     22      $396            $93                $500          −$197        −$532
  M3     38      $684           $161                $500          +$23         −$509   ← monthly breakeven
  M4     60    $1,080           $254                $500          +$326        −$183
  M5     90    $1,620           $381                $500          +$739        +$556   ← cumulative positive
  M6    130    $2,340           $551                $500        +$1,289       +$1,845
```

Monthly breakeven ~**M3**; cumulative cash positive ~**M5**. Total capital at risk before profitability:
**< $600** (plus founder time). This is the point of $500-mode — it's runway you can self-fund.

**11.4 Sensitivity — the model lives or dies on tokens/user × ARPU**

| Avg tokens/user | GPU cost/user | Contribution @ $18 ARPU | Breakeven users |
|---|---|---|---|
| 2M (light) | $1.10 | ~$15.0 | **~33** |
| **5M (base)** | **$2.75** | **~$13.4** | **~37** |
| 20M (power) | $11.00 | ~$5.1 | **~98** |
| 100M (autonomous, unmetered) | $55.00 | **−$39** | **never** ← must meter |

The bottom row is the whole reason the oracle/agent tier is **metered** (§6): one unmetered autonomous
user flips the unit economics negative. Meter it and the base case holds.

**11.5 The two inflections that end founder mode**

1. **Self-host trigger (~900 paying users).** GPU cost stays usage-based (hosted) until aggregate
   volume fills a GPU. At ~5M tok/user, ~900 paid users ≈ 4.7B tok/mo → fill one L40S and self-host
   the **cheap+mid tiers** (Phase 1, §10), dropping their rate from $0.55 toward ~$0.14–0.30. The
   oracle stays hosted far longer.
2. **Salaried-team reset (funded mode).** The day you add a team (~₹15–30L/mo ≈ $18–36K fixed),
   breakeven jumps from ~37 to **~1,500–2,700 paid users** ( = fixed ÷ $13.40). That step-change is
   *why you stay in $500-mode until traction justifies the raise* — you raise to fund the team **after**
   the ~37-user proof, not before (see [SOVEREIGN_HOSTING.md](./SOVEREIGN_HOSTING.md) fundraise logic).

**11.6 The metrics dashboard (what to track from day 1)**

| Metric | Founder-mode target | Note |
|---|---|---|
| ARPU | ~$18 (₹1,500) | blended paid |
| Avg tokens / user | ≤5M/mo | meter above; the #1 cost driver |
| Inference cost / user | ~$2.75 | = tokens × $0.55/1M (Phase 0) |
| Contribution margin | ~74% | top of the AI-SaaS band (52–70%) |
| Breakeven | ~37 paid users | founder mode; ~1,500 funded |
| Free→paid conversion | 5–15% | dev-tool benchmark |
| Monthly churn | <5% | dev tools run lower |
| CAC | ~$0–50 | founder-led / organic early |
| CAC payback | <1 mo (founder) → 6–8 mo (funded) | |
| LTV : CAC | »3:1 | ARPU × margin × ~33-mo life ÷ CAC |

> **Founder-mode verdict:** With inference as the only scaling cost (hosted, usage-based, $0.55/1M) and
> a $500 flat overhead, econ breaks even at **~37 paying users (~M3)**, risks **< $600** to get there,
> and is gated by **acquisition, not cost**. The two things that can break it — **unmetered autonomous
> users** and **an uncapped free tier** — are both closed by metering. Everything else is upside.

---

### 11.7 The real founder-mode — GPU-only cost on AWS credits

**In plain terms.** In practice the founder has **100k+ in AWS credits** and takes no salary, so until
seed/Series A the *only* recurring cost is **GPU** — and even that is **prepaid by credits**. Office,
salaries, etc. are deferred. So the real question is *"how much revenue covers the GPU instances once
credits run out"* — and while credits last, econ is profitable from its first few paying users.

**Under the hood.**

**Token spread (founder's estimate):** ~**60%** executor (gpt-oss-20b) · ~**32%** conductor (Qwen) ·
~**8%** oracle (GLM).

**Per-instance cost (AWS Mumbai, self-hosted):**

| Model | GPU instance | ~$/hr | ~$/mo (730h) | agg tok/s | self-host? |
|---|---|---|---|---|---|
| executor `gpt-oss-20b` (60%) | 1× L40S (g6e) | ~$2 | ~$1,460 | ~3,000 | ✅ credits cover; can co-host conductor via §3.1 backfill |
| conductor `Qwen` (~32%) | 1× L40S / A100 | ~$2–4 | ~$1,460–2,920 | ~2,500 | ✅ or share the executor's card |
| oracle `GLM` FP8 (8%) | 8× H100 (p5.48xl) | ~$60 | **~$43,800** | ~1,500 | ❌ **never — keep hosted per-token** |

The oracle instance alone is **~$44k/mo** — it would **burn 100k credits in ~2 months** for just 8% of
tokens. Footprint = **self-host executor + conductor on 1–2 L40S (credits cover it), keep the oracle on
hosted per-token** (§10 Phase 2 self-hosts it only at fleet scale).

**Credit runway — why GPU is effectively free:**

| Footprint | ~$/mo | 100k credits last |
|---|---|---|
| **1× L40S** (exec + conductor via backfill) | ~$1,460 | **~68 months** |
| 2× L40S (separate) | ~$2,920 | ~34 months |
| + self-hosted 8×H100 oracle | ~$46,700 | ~2 months ❌ |

**Two-phase breakeven:**

```
 Phase A — credits active (~3–6 years):
   GPU cash cost = $0 (credits). Only live cash cost = hosted oracle (~$3/1M × ~8% of tokens)
   ≈ $0.24 per 1M tokens served → ~97% contribution margin.
   → Breakeven ≈ a HANDFUL of paying users. Any revenue is profit; credits are pure runway.

 Phase B — cash (post-credits): cover the L40S instances ÷ ~74% margin:
   1× L40S : ~$1,970/mo (~₹1.6L) ≈ 110 individual seats ($18)  OR  ~5 GCC seats (₹40k)
   2× L40S : ~$3,950/mo (~₹3.3L) ≈ 220 individual seats        OR  ~8–10 GCC seats
```

> **Founder-mode (credits) verdict:** With AWS credits + no salary, **GPU cost is effectively $0 for
> ~3–6 years**, so econ is **profitable from its first few paying users** — the only live cash cost is
> the hosted oracle's tiny per-token bill (~$0.24/1M). The meaningful cash breakeven (cover the GPU if
> paid) is **~₹1.6–3.3L/mo (~110–220 individual seats, or ~5–10 GCC seats)** — cleared long before
> credits expire. **One rule: never self-host the 8×H100 oracle on credits** (2-month burn) — keep it
> hosted until fleet volume fills a node (§10 Phase 2). This *supersedes* the $500-overhead framing of
> §11.1–11.6 for the credit-funded founder phase; those still model the hosted-only path if credits
> are unavailable.

---

## 12. Sources

June–July 2026 (full URLs in the conversation that produced this doc):

- **Self-hosted throughput / GPU sizing** — devforth.io (gpt-oss-20b L4/L40S/H100); arxiv 2508.16700
  (gpt-oss MoE 3.6B-active); github dzhsurf & lmsys.org (DeepSeek V3 8×/96×H100); qwen speed
  benchmarks; particula.tech & spheron.network (vLLM ~12.5k vs SGLang ~16.2k tok/s H100; RadixAttention 6.4×)
- **India GPU pricing** — e2enetworks.com (L4 ₹50–70, L40S ₹80–150, H100 ₹249, H200 ₹300);
  spheron.network (H100 $2.53, spot $1.03–1.43); huggingface.co/blog/daya-shankar (IndiaAI ₹92/hr)
- **CPU inference** — martinalderson.com (memory-bandwidth bound); [MODEL_SELECTION.md §8](./MODEL_SELECTION.md)
  (gpt-oss-20b MoE ~30–50 tok/s server CPU)
- **Incumbent pricing** — anthropic.com/news (Claude Code weekly multiplier caps); github.blog (Copilot
  AI Credits, model multipliers Jun 2026); eesel.ai & flexprice.io (Cursor); nocode.mba (Windsurf)
- **Unit economics / margins** — saasmag.com (AI COGS ~23%, GM compression 80→65%); iconiq growth;
  ltvcacbook.com (AI LTV:CAC 4.6×); introl.com (true cost/1M tokens); featherless.ai (open-model
  price benchmarks, −30–50%/yr)
- **Cost-optimization vendors** — withmartian.com (Martian router, 20–97% cuts, ~$1.3B val);
  anyscale.com (LMSys router 70% MT-Bench); morphllm.com (DeepInfra 25–33% < Fireworks)
