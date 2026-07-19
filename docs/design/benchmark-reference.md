# Benchmark reference — SWE-bench Pro & Terminal-Bench 2.1 (July 2026)

External reference scores for the models econ routes to, judges with, or competes against.
Collected 2026-07-19 from public leaderboards and vendor announcements. **Read the caveats
before quoting any number** — most rows are self-reported on vendor-tuned scaffolds, and
both benchmarks have known integrity issues. This doc holds *external* scores only; econ's
own measured results live in the fleet-run records and
[gap-closure-plan.md](./gap-closure-plan.md); tier bindings and the per-benchmark oracle
strategy live in [gap-closure-plan.md §4](./gap-closure-plan.md) and
[models.md](./models.md) — not duplicated here.

---

## SWE-bench Pro — public set (731 instances, pass@1)

| Model | Scaffold | Score | Verification | Source (2026) |
|---|---|---|---|---|
| Claude Mythos 5 | vendor | 80.3% | self-reported | benchlm.ai, Jul 15 |
| Claude Fable 5 | vendor | 80.0% | self-reported | benchlm.ai, Jul 15 |
| Sakana Fugu-Ultra | vendor | 73.7% | self-reported | benchlm.ai, Jul 15 |
| Claude Opus 4.8 | vendor | 69.2% | Anthropic official | morphllm.com, May 28 |
| Grok 4.5 | vendor | 64.7% | self-reported | benchlm.ai, Jul 15 |
| GPT-5.6 Sol | vendor | 64.6% | self-reported | benchlm.ai, Jul 15 |
| Claude Sonnet 5 | vendor | 63.2% | self-reported | codingfleet.com, Jun 30 |
| GLM-5.2 | vendor | 62.1% | self-reported | morphllm.com, Jul 15 |
| Qwen 3.7 Max | vendor | 60.6% | self-reported | morphllm.com, Jul 15 |
| MiniMax M3 | vendor | 59.0% | self-reported | morphllm.com, Jul 15 |
| GPT-5.4 xHigh | **SEAL standardized** | 59.1% | **leaderboard-verified** | labs.scale.com |
| GPT-5.5 | vendor | 58.6% | self-reported | morphllm.com |

**Caveats (they change the reading):**

1. **OpenAI retracted its SWE-Pro endorsement (Jul 8, 2026)** after auditing the public
   set: ~27.4% of tasks flagged broken by its automated pipeline, ~34.1% by human review
   (overly strict tests, underspecified prompts, low coverage). Scores are directional
   only. Internal A/Bs on Pro remain valid (same broken tasks in both arms); external
   headline claims on Pro are weak currency.
2. **~20 points of every vendor score is agent engineering, not model capability**: the
   only harness-normalized row (Scale's SEAL, uniform scaffold) puts same-generation
   frontier at ~59% where vendor scaffolds report ~80%. This is direct public evidence
   for the harness-first thesis.
3. **GPT-5.6 variants**: only "Sol" has a published SWE-Pro number as of Jul 19 — no
   Luna/Terra/base rows exist; do not substitute other benchmarks for them.
4. All rows are pass@1 single-attempt; public split only (the commercial/held-out split
   scores lower and is not published per-model).

---

## Terminal-Bench 2.1 (89 tasks, pass@1, avg of 3 repeats)

| Model | Harness | Score | Verification | Source (2026) |
|---|---|---|---|---|
| GPT-5.6 Sol Ultra | OpenAI native | 91.9% | official | openai.com, Jul 10 |
| GPT-5.6 Sol base | OpenAI native | 88.8% | official | openai.com, Jul 10 |
| Kimi K3 (open-weight) | KimiCode | 88.3% | official | codingfleet.com, Jul |
| Claude Fable 5 / Mythos 5 | Anthropic native | 88.0% | official | anthropic.com, Jun 9 |
| GPT-5.6 Terra | OpenAI native | 87.4% | official | openai.com, Jul 10 |
| GPT-5.6 Luna | OpenAI native | 84.7% | official | openai.com, Jul 10 |
| GPT-5.5 | Codex CLI | 83.4% | leaderboard | tbench.ai |
| Grok 4.5 | xAI native | 83.3% | official | codingfleet.com, Jul 8 |
| Claude Opus 4.8 | Anthropic native | 82.7% | official | anthropic.com, May 27 |
| GLM-5.2 | Z.AI native | 81.0% | official | venturebeat.com, Jun 13 |
| Claude Sonnet 5 | Anthropic native | 80.4% | official (system card) | anthropic.com, Jun 30 |
| Muse Spark 1.1 | Meta native | 80.0% | official | meta.com, Jul 9 |
| Gemini 3.5 Flash | Terminus-2 | 76.2% | leaderboard | deepmind.google |
| Gemini 3.1 Pro | Gemini CLI | 70.7% | leaderboard | tbench.ai |
| Qwen 3.7 Plus / Max | Terminus-2 | 70.3% / 69.7% | official — **TB 2.0** | qwen.ai, May |
| Claude Opus 4.7 | Claude Code | 69.7% | leaderboard | tbench.ai, Apr 16 |
| DeepSeek V4 Pro | Terminus-2 | 67.9% | official — **TB 2.0** | huggingface.co |
| MiniMax M3 | Terminus-2 | 66.0% | official | venturebeat.com, Jun 1 |

**Caveats:**

1. **TB 2.1 fixed 28 of 89 tasks vs 2.0 — cross-version comparison is invalid.** The
   Qwen and DeepSeek rows above are 2.0 scores, kept only because no 2.1 rows exist for
   them; never mix them into a 2.1 trade table.
2. **Scaffold swing is 3–5 points for the same model** (GPT-5.5: 83.4 Codex CLI vs 78.2
   Terminus-2; Opus 4.8: 82.7 native vs 78.9 Claude Code). The Claude Code harness
   consistently scores below Anthropic's benchmark-native harness. Any earlier econ note
   quoting "GPT-5.5 78.2 vs Opus 4.8 74.6" was comparing Terminus-2 rows — on native
   harnesses it is a near-tie (83.4 vs 82.7).
3. **The frontier is a three-way statistical tie** (Sol base 88.8, Kimi K3 88.3, Fable
   88.0); only Sol *Ultra* (91.9) separates. Terminal ability ≠ SWE-patch ability: Sol is
   15 points under Fable on SWE-Pro while leading TB.

---

## Cross-benchmark readings relevant to econ

- **The two benchmarks rank models differently** — SWE-Pro (repo-scale patch work)
  favors the Claude line; TB 2.1 (terminal/ops tasks) favors GPT-5.6 Sol. Per-benchmark
  oracle binding (not one global oracle) is the right shape; the binding table lives in
  [gap-closure-plan.md §4.4](./gap-closure-plan.md).
- **TB-arm oracle A/B ordering**: GPT-5.6 Sol (88.8, official) now outranks Grok 4.5
  (83.3, official as of Jul 8 — previously self-reported) as the primary challenger.
- **Kimi K3** (88.3 TB, weights promised Jul 27, 2.8T MoE) is the open-weight watch item
  for the sovereign/in-region lane: frontier-class terminal ability with hostable weights.
- **Sonnet 5 is a price play, not a capability tier**: ~97% of Opus 4.8's TB score and
  ~91% of its SWE-Pro score at a fraction of the cost (intro pricing Jun–Aug 2026).
- **econ's own tiers for context**: GLM-5.2 (oracle) 81.0 TB / 62.1 Pro; MiniMax M3
  (conductor) 66.0 TB / 59.0 Pro — raw single-model rows; econ's whole-agent measured
  results and cost bands live in [gap-closure-plan.md](./gap-closure-plan.md).

Primary sources: labs.scale.com/leaderboard/swe_bench_pro_public · tbench.ai/leaderboard/terminal-bench/2.1 ·
openai.com/index/gpt-5-6 · anthropic.com/news/claude-fable-5-mythos-5 · benchlm.ai/benchmarks/swePro ·
morphllm.com/swe-bench-pro · the OpenAI SWE-Pro audit coverage (explainx.ai / alphasignal.ai, Jul 2026).
