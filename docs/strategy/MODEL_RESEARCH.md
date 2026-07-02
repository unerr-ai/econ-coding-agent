# econ — Model Research: the validated facts

**Status:** Drafted 2026-07-01. Validated facts backing econ's tier picks — open-weight candidates,
context windows, KV-cache economics, context-extension methods, and the long-context + coding
fine-tuning recipe. This is the *facts* doc; the *decisions* live in
[MODEL_SELECTION.md](./MODEL_SELECTION.md), the *cost model* in [TOKEN_ECONOMICS.md](./TOKEN_ECONOMICS.md).

Every model below verifiably exists; SWE-bench numbers are **vendor-reported** unless noted.
**Excluded as unverified (post-cutoff / fabricated in research passes — do not cite):** DeepSeek V4,
GLM-5.2, Kimi K2.6/K2.7, MiniMax M2.x/M3, Nemotron-Cascade 2, Qwen3.7 Max/Plus scores. (The docs'
names "GLM 5.2" / "Qwen 3.7 Plus" are aspirational; real equivalents are GLM-4.5 / Qwen3-Coder.
"Qwen-Plus" is a **closed hosted API** — cannot be self-hosted.)

---

## 1. Validated open-weight model catalog

Params = total / active (MoE). Footprint = **weights only, FP8, approximate — add KV cache (§3)**.

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
(weights held resident in VRAM). A big-MoE with low active count is cheap to compute but expensive to
keep loaded. Example: **Kimi K2 and GLM-4.5 have the same 32B active** (same compute/token) but Kimi
holds **1T resident (~16×H100) vs GLM-4.5's 355B (~4×H100)** — ~3× the VRAM for its extra reserve
params. Native ≠ effective: a model advertising 256K–1M often reasons reliably across only a fraction
(validate with **RULER**, not SWE-bench).

---

## 2. KV cache — how long context is paid for

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
turn, so its KV is computed once and reused (the "warm cache" mechanism).

---

## 3. Extending an open model's context

The cap is the positional encoding (RoPE): beyond the trained length, attention degrades. Four
methods, cheapest-effort first:

1. **Inference-time RoPE scaling** (config flag, no retraining): PI → NTK-aware → **YaRN** (how Qwen
   goes 32K→128K→256K→1M) → LongRoPE (2M+). Set `rope_scaling`, serve in vLLM.
2. **Continued pre-training / long-context fine-tune** (the real fix — §4).
3. **Architecture** (means a different model): sliding-window (Mistral), **linear/lightning attention**
   (MiniMax-M1), Mamba/SSM hybrids → native 1M+; **MLA** (DeepSeek) makes long context cheap to serve.
4. **Retrieve instead** (RAG / repo-slicing) — the model gets a compiled brief, not the whole repo.

**Effective ≪ claimed:** YaRN-extrapolation degrades with distance (128K→256K may recall well only to
~180K); always re-validate with RULER.

---

## 4. Long-context + coding fine-tuning recipe (validated)

Two-stage continued training (not from scratch); the two goals use **different** data:

**Stage 1 — continued pre-training, extends context (LONG documents):**
- Best long sources: **code repositories + books/textbooks**.
- **Mix long with high-quality short data** — long-only hurts long-context *and* short-context skill;
  ~60/40 long/short (ProLong code mix ~50/50 of 64K/512K chunks).
- **Repo-level packing by imports** (Granite-128K): build the import **DAG**, **topological-sort**,
  concatenate files in dependency order; + per-language length upsampling. Teaches cross-file reasoning.
- **YaRN scaling** + raise RoPE base + reset LR when stepping up length; **train at sequences longer
  than the target**; document separators + cross-document attention masking (FlashAttention-2 varlen).
- **Ring attention / sequence parallelism** for the long sequences.
- **Cheap:** ProLong reached SOTA-128K from Llama-3-8B with **~40B tokens (~5% of typical)**, up to 512K.

**Stage 2 — SFT, teaches coding (SHORT instruction data):**
- **OpenCodeInstruct** — 5M samples with unit tests + execution feedback + LLM-judged correctness.
- **Agentic/repo trajectories:** executable envs (SWE-Gym, SWE-rebench, SWE-Factory); synthetic
  generators (SWE-Smith, SWE-Mirror, BugPilot). Dual-tier = big execution-free corpus + small
  execution-grounded set (SWE-ZERO → SWE-HERO). **Execution-based RL** rewards patches that pass tests.
- **ProLong finding:** short instruction SFT is *sufficient* for long-context ability; long synthetic
  instruction data did not help — extend context in Stage 1, teach coding in Stage 2, don't conflate.

**Validation:** evaluate **after SFT** on real long-context tasks + RULER; confirm short-context didn't
regress.

---

## 5. Sources

Model cards / vendor reports: gpt-oss card (arxiv 2508.10925), GLM-4.5 ARC report (arxiv 2508.06471 —
64.2% / Air 57.6%), Kimi-K2-Instruct card (HuggingFace — 1T/32B, 65.8%, Modified MIT), MiniMax-01
(arxiv 2501.08313), Qwen3-Coder (Qwen blog/HF — 256K→1M), DeepSeek-V3 (arxiv 2412.19437 — MLA),
Llama 4 Scout (Meta).

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
