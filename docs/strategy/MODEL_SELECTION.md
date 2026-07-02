# econ — Model Selection & Research

**Status:** Drafted 2026-06-28; updated 2026-06-30 (wired roles → tiers, §1.2: 3 distinct models,
reasoner merged into oracle). This is the living reference for *which models econ runs in each
role, and why*. It opens with the decision and the cost, then walks through all the research
behind it in plain language. Treat it as the base document — when a new model lands, add it using
the template in §10 and, if it wins a role, update §1.

> **One-line summary.** econ runs a small *team* of models — a cheap assistant, a capable
> everyday engineer, and a rarely-called expert. Each job goes to the cheapest model that can
> do it well. This doc records the team we picked and the evidence for it.

> **Scope note.** This doc covers *which open/rented models we run* (Phase 1). Training our
> **own** mid-tier reasoner — the post-training recipe, the customer-trajectory data flywheel,
> the parity math, and the go/no-go conditions — lives in
> [MODEL_TRAINING_STRATEGY.md](./MODEL_TRAINING_STRATEGY.md) (Phase 2).

---

## 1. The decision (what we are building with)

| Role (plain name) | Model | What it does | Why it won |
|---|---|---|---|
| **Assistant** (cheap, high-volume chores) | **gpt-oss-20b** (OpenAI, open-weight) | Opens files, runs commands, makes small edits — the simple repetitive work | Cheapest, reliable at following instructions, US-made, and uniquely fast on a plain CPU (see §8) |
| **Engineer** (the everyday workhorse) | **Qwen3.7 Plus** (Alibaba) | Plans the job, decides each step, does most of the real work, holds the working context | Genuinely capable + very cheap + a well-rounded thinker (better at *planning* than code-only models) |
| **Expert** (rare, hardest problems) | **GLM 5.2** (Z.ai) | Called only for the genuinely hard reasoning the engineer can't crack | Highest score of any open model on the fairest real-world coding test today |

**Backups we will keep wired in the test harness:**

- Assistant → **Nemotron Nano 9B V2** (NVIDIA) or **Phi-4-mini** (smallest, for tight-RAM machines)
- Engineer (self-host, see §1.3 ladder) → **gpt-oss-120b** on 1×H100 (recommended sweet spot — MoE
  ~5B active) · **Qwen3-Coder-30B-A3B-Instruct** on 1×L40S (cheapest) · **GLM-4.5-Air** (coding alt)
- Expert → **DeepSeek V4-Pro** (nearly as strong, very permissive licence for self-hosting)

### 1.1 Cost per 1 million tokens

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

**What the team actually costs to run.** Cost is *tokens × price*, so the bill depends on how
the work is split across the three. In a typical job the cheap engineer carries the bulk of the
words, the assistant's share is almost free, and the expensive expert is touched rarely:

| Tier | Rough share of all tokens | Effective price/1M | Contribution |
|---|---|---|---|
| Engineer (carries the context) | ~65% | ~$0.30 (mostly cached input) | ~$0.20 |
| Assistant (tiny prompts) | ~25% | ~$0.15 | ~$0.04 |
| Expert (small, output-heavy) | ~10% | ~$3.00 | ~$0.30 |
| **Blended total** | | | **~$0.55 / 1M tokens** |

Against a top frontier model used for *everything* (blended **~$10–15 / 1M**), that is roughly a
**10–20× reduction** — and it grows once the cheap tiers are self-hosted. The single biggest
lever is **how often the expert is called**: every expert call is the dominant line item, so the
router's job is to call it rarely and only when it pays off.

> **Honesty rule (carried from the architecture).** We *count* savings from real usage; we don't
> *promise* them. The blended number above is an estimate from representative token shares — the
> end-of-turn receipt reports the real figure per job.

### 1.2 From roles to tiers — how econ actually wires this

**In plain terms.** The three roles above are *jobs*. econ's code routes work to four
*tier slots* — `executor`, `conductor`, `reasoner`, `oracle`. Three of them are the three roles;
the fourth (`reasoner`) is an optional "think harder" rung between the everyday Engineer and the
rare Expert. For now we point that rung at the **same model as the Expert**, so we run exactly
**three distinct models**, not four. We keep the extra slot so a cheaper thinking model can slide
into it later without re-plumbing anything.

**Under the hood.**

Tier → model (every model is reached via OpenRouter, which routes to an upstream — incl. Fireworks
— automatically):

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

### 1.3 The middle layer, hosted vs self-host (the conductor tier)

**The point most people miss.** The conductor is the *middle layer* between the cheap Assistant
(gpt-oss-20b) and the rare Expert (GLM). Today it runs on a **hosted API** (a "Qwen-Plus"-class
endpoint via OpenRouter). That is fine for Phase 0 — but **"Qwen-Plus" is a closed, API-only tier;
its weights are not published, so it can *never* be self-hosted** (confirmed 2026-07-01; a licensing
fact). So the moment we self-host in India (Phase 1, [TOKEN_ECONOMICS.md §10](./TOKEN_ECONOMICS.md)),
the middle layer swaps to a **real open model** — and it does **not** have to fit one L40S.

**Don't cap the middle tier at an L40S.** The right frame is a *footprint ladder*: pick the box that
buys the quality the middle layer needs, because **serving cost tracks a MoE's *active* params, not
its total size.** A 100B+ MoE with low active count serves nearly as cheaply per token as a 30B while
being materially stronger — so "bigger box" ≠ "much more expensive per token." Rungs, cheapest first:

| Rung | Box | Self-host middle-tier pick | Type | Why this rung |
|---|---|---|---|---|
| **A — floor** | 1×L40S 48 GB | **Qwen3-Coder-30B-A3B-Instruct** | MoE, 3.3B active | Coder-tuned; serves at ~3B *speed* (≈ gpt-oss-20b cost). Cheapest viable middle. |
| | | **Qwen2.5-Coder-32B** / **Qwen3-32B** (dense fallbacks) | Dense 32B | Predictable latency / stronger planner; tighter context |
| **B — sweet spot** ✅ | 1×H100 80 GB | **gpt-oss-120b** | MoE, ~5.1B active | Same family as the executor (shared tooling, Apache, US-origin hedge); ~5B active = serves almost as cheap as a 30B but a real quality jump. **Recommended once we allow 1×H100.** |
| | | **GLM-4.5-Air** | MoE, ~12B active (~106B total) | Coding-specialist alternative on the same box; smaller sibling of the GLM oracle → consistent behaviour |
| **C — upper-middle** | 2×H100 | **Qwen3-235B-A22B** / dense **Qwen2.5-72B**, **Llama-3.3-70B** | MoE 22B active / dense 70B | Closest to oracle quality while staying off the 8×H100 tier; use only if B leaves a real gap |

**Recommendation with the L40S cap lifted: gpt-oss-120b on 1×H100 (rung B).** Its ~5B active means
throughput — and therefore $/1M — stays close to the 30B floor, so we buy a genuine step up in
capability at little marginal serving cost, and it shares the gpt-oss executor's tooling/licence.
Keep **Qwen3-Coder-30B-A3B** (rung A) as the low-cost variant for credit-lean months, and reach for
**rung C** only if the test gate shows B can't carry the everyday load.

Note the ceiling is unchanged: the open models that reach *Sonnet-class* coding (GLM large-MoE,
DeepSeek-V3-class, Qwen3-Coder-480B, Kimi K2) are 8×H100-scale — that is the **Expert/oracle** tier,
not the middle layer. Sonnet-class quality is bought only on the rare oracle call; the middle layer
just has to be a strong, cheap everyday coder. Final pick still runs through the §9 test gate.

> **Verifiability note (2026-07-01).** Model *version numbers* elsewhere in this doc (e.g.
> "Qwen3.7 Plus," "DeepSeek V4-Pro") came from research passes and are not all independently
> confirmed. The three self-host picks in the table above are **real, currently-available models**;
> prefer them for anything we actually deploy.

---

## 2. Why a team of models, not one

Paying the single best model to open files and fix typos is like paying a senior engineer to do
data entry — it's where today's coding tools quietly burn most of their money. econ's whole
saving comes from one move: **give each task to the cheapest model that can do it well.**

So the real question was never "which one model is best." It was "who is best for each of the
three jobs?" — and the answer is three different models, because each job rewards a different
strength.

---

## 3. The three jobs, in plain terms

| The job | What it really needs | What it does NOT need |
|---|---|---|
| **Assistant** | Speed, low cost, reliably following exact instructions | Deep cleverness — it's doing simple chores |
| **Engineer** | Solid all-round judgement; ability to plan and keep track of a big task; affordable | To be the smartest model on Earth |
| **Expert** | Top-tier reasoning on genuinely hard problems | To be cheap or fast — it's used rarely |

A key, non-obvious point that shaped the picks: the engineer's job is **thinking and deciding**,
not just typing code. A well-rounded model that "happens to be good at code" is a *better*
engineer than a narrow code-only model, because it understands the problem better (see §7).

---

## 4. The chosen models, one by one

### Assistant — gpt-oss-20b
- **Cheapest serious option** and made in the US (helpful for "is my data safe?" peace of mind).
- **Very good at following instructions exactly** — which is all the chore work needs.
- **Runs on an ordinary CPU** without a graphics card, and unusually fast for its capability
  because of a clever design (only a small part of it works on each word — see §8).
- Reads up to ~131,000 tokens at once (plenty for file slices).

### Engineer — Qwen3.7 Plus
- **Capable at real coding work** — planning a change, seeing how pieces fit — at a fraction of
  the cost of the top models.
- **Reads a huge amount at once** (up to ~1 million tokens), so it keeps track of big tasks.
- **A well-rounded thinker**, which is exactly what the planning-and-deciding role wants.
- Its **cached-input price is 5× cheaper than fresh input** ($0.08 vs $0.40) — and because the
  engineer drives turn after turn, most of its re-read context bills at that cheap cached rate.

### Expert — GLM 5.2
- On the **hardest, fairest real-world coding test available (SWE-bench Pro)** it scores the
  **highest of any open model — 62.1**, ahead of GPT-5.5 and right behind the best paid model on
  Earth (Claude Opus 4.8).
- **Excellent at long, hard reasoning tasks** and at using tools well — the only things you'd
  ever bother the expert for.
- Because it's called rarely, its higher price barely moves the total bill while lifting the
  quality ceiling a lot.

---

## 5. The full field we evaluated (the candidates)

We did not just pick from a short list — here is everything we weighed, what's true about each
(June 2026), and where it fits.

| Model | Maker | Best at | Reads at once | Open / licence | Best econ role | Verdict |
|---|---|---|---|---|---|---|
| **GLM 5.2** | Z.ai (CN) | Hardest reasoning; top open coding score (62.1) | 1M | Open-weight | **Expert ✅** | Chosen expert |
| **DeepSeek V4-Pro** | DeepSeek (CN) | Near-top reasoning; 80.6 on the older test | 1M | Open, very permissive | Expert (backup) | Strong, MIT-style licence |
| **DeepSeek V4-Flash** | DeepSeek (CN) | Cheap strong reasoning | 1M | Open, permissive | Cheap reasoner | $0.14/$0.28 — great value |
| **Qwen3.7 Plus** | Alibaba (CN) | All-round engineer; huge context; cheap | 1M | Open-weight | **Engineer ✅** | Chosen engineer |
| **MiniMax M3** | MiniMax (CN) | Cheapest strong coder | 512K | Open-weight | Engineer (budget) | Best cost per result |
| **Qwen3-Coder-30B-A3B-Instruct** | Alibaba (CN) | Self-host middle tier on one L40S; ~3B active = fast | ~256K | Open (Apache) | **Engineer (self-host) ✅** | Real, available; Phase-1 conductor pick (§1.3) |
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

---

## 6. Two honesty notes that shape every choice

### 6.1 Don't trust the scoreboards — trust our own tests
The popular coding benchmark (SWE-bench Verified) got **contaminated** in 2026: its test
problems leaked into model training, and some models were caught essentially reading the answer
key off disk. Vendors also quote their *own* favourable numbers. So:
- We lean on the **harder, fairer test (SWE-bench Pro)** where it exists, and
- We will **run every candidate through econ's own small test** and let the results pick winners,
  rather than believing the marketing.
- **Kimi K2.7 Code** is the clearest example to avoid for now — it only publishes its own scores,
  which independent reviewers say don't hold up.

### 6.2 The China-data point (and why it doesn't block us)
Most of the strongest open models (GLM, Qwen, MiniMax, DeepSeek, Kimi) are **made in China**.
Using their *hosted* service means your code touches Chinese servers — fine for testing, not for
a product that promises data stays in India.

**The fix is built into econ's plan:** these are **open-weight** models, so for the real product
we **download them and run them on our own machines in India.** That removes the data-residency
worry entirely — it is the whole reason econ is "hosted in India." The US-made models
(gpt-oss, Nemotron, Phi-4) are kept as hedges if anyone prefers a US origin.

---

## 7. "Are these models trained for coding?" — the generalist vs specialist point

A question worth recording, because it's easy to get backwards.

- **DeepSeek V4** and **Qwen3.6/3.7** are **general models that are excellent at code** — not
  code-only specialists. (The code-only specialists are *DeepSeek-Coder* and *Qwen3-Coder-Next*.)
- For the **engineer** role this is a **good thing**, not a gap. The engineer's job is to
  *understand the problem and decide what to do* — and a well-rounded model does that better. In
  head-to-head tests, the general model beat the code-only one at understanding the problem; the
  code-only one only won at raw typing speed.
- So we use **general models for the engineer and expert** (thinking roles), and keep the
  **code-only specialists for the assistant's mechanical code transforms** (typing roles).

---

## 8. Running the assistant on a plain CPU (no graphics card)

We specifically wanted the cheap assistant to run on a CPU. The key fact that decides this:

> **On a CPU, speed depends on how much of the model is read *per word* — and the bottleneck is
> memory speed, not the number of cores.**

gpt-oss-20b is "20 billion" in total, but **only ~3.6 billion actually work on each word** (a
"mixture of experts" — only a few specialists show up per task). A normal model uses *all* its
size every word. So per word:

| Model | Works per word | Memory to hold it | Relative CPU speed | Capability |
|---|---|---|---|---|
| Phi-4-mini | 3.8B (all) | ~3 GB | Fast | Lowest |
| **gpt-oss-20b** | **3.6B of 21B** | **~16 GB** | **Fast (≈ Phi-4-mini)** | **Highest of these** |
| Nemotron 9B | 9B (all) | ~7 GB | ~2× slower | Middle |
| Qwen 14B | 14B (all) | ~9 GB | ~3–4× slower | High but slow |

**Conclusion: gpt-oss-20b is the best CPU performer** — it runs at a small model's *speed* while
delivering a big model's *quality*. Its only cost is needing ~16 GB of RAM sitting ready, which
is the cheap resource to add.

**How to set up the CPU optimally** (where to spend a hardware budget):
1. **Buy memory *bandwidth*, not cores.** A server chip (8–12 memory channels) is **4–6× faster**
   here than a desktop (2 channels), at the same core count. This is the big lever.
2. **Cores: ~8–16 is enough** to feed the memory; more cores barely help (you wait on memory).
3. **Fill every memory channel** with the fastest RAM the board supports.
4. **Use the 4-bit version** and a runtime that uses all cores (llama.cpp / Ollama).

**Realistic result:** ~10–15 words/second on a normal desktop; **~30–50+ words/second on a
high-bandwidth server CPU** — genuinely usable with no graphics card. If a machine can't spare
~16 GB of RAM, drop to **Phi-4-mini** (fits in ~3 GB) and accept lower skill.

> **Honesty caveat (added 2026-07-01, from web research).** The ~30–50 tok/s server-CPU figure is a
> *reasoned estimate*, not a measurement — no clean pure-CPU-server benchmark for gpt-oss-20b exists
> (the widely-cited "~30 tok/s" is actually GPU+CPU-offload). And CPU throughput **collapses on long
> context** (~30 → ~9 tok/s at 8k) with slow prefill/TTFT — exactly the long contexts a coding agent
> uses. So treat pure-CPU as a **narrow on-prem/air-gap/short-context fallback**, not a general cheap
> serving path; a cheap GPU (L4/L40S, 111–225 tok/s) or GPU-headroom backfill wins. Full analysis:
> [TOKEN_ECONOMICS.md §4](./TOKEN_ECONOMICS.md).

---

## 9. How we will finalise (the test gate)

Nothing above is treated as final by assertion. Before committing each role we will:
1. Wire all candidates for a role behind the same interface (hosted endpoints first).
2. Run them through econ's own small, honest coding test set.
3. Pin the winner by **measured result**, and record the number here.
4. Re-check after any model update — these ship every few weeks.

This is why the doc separates **chosen** (§1) from **the field** (§5): the field is the menu, the
choice is the current result of the test gate, and both will move.

---

## 10. Template — adding a model later

When a new model appears, add a row to §5 using this shape, and if it wins a role, update §1 and
§1.1:

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

---

## 11. Sources

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

*(Full URLs are in the conversation that produced this doc; keep this list short and update it
when a model row changes.)*
