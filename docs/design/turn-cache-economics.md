# Turn & cache economics — closing the realized-savings gap

**Status:** first implementation wave landed 2026-07-10 (L1.1/L1.2c/L1.3-budget/L1.4 prompt
shape, degraded-turn stand-down); validation fires pending · **Date:** 2026-07-10 · **Owner:** econ core

**Companions:** [`AUTO_COMPACTION_AND_CONTEXT.md`](./AUTO_COMPACTION_AND_CONTEXT.md) owns the
compaction machinery this doc re-triggers; [`tooling-context-opt.md`](./tooling-context-opt.md)
owns per-tool output leanness; [`cross-tier-context.md`](./cross-tier-context.md) owns
cross-tier cache warmth; the measured baseline lives in
[`../testing/SWE_BENCH_TRACKER.md`](../testing/SWE_BENCH_TRACKER.md). This doc owns **one
question**: why our realized savings vs a frontier harness are ~2× when the token-price ratio
says ~10×, and the four levers that close the gap.

---

## 1. The measured problem

All numbers from the 2026-07-10 SWE-mini-10 ladder (real-graded, receipts in the tracker).

**Our price schedule** (litellm/minimax-m3 path — reverse-engineered from receipts,
reproduces four runs' bills to the cent):

| line item | price | notes |
|---|---|---|
| uncached input | $0.30/M | new tool results + prompts, billed once |
| output + think | $1.20/M | what the model generates |
| **cache read** | **$0.06/M** | the whole accumulated context, re-read **every step** |
| cache write | $0.00 | implicit caching, no write surcharge on this path |

**Where the ladder's $1.51 went:** ≈73% cache reads ($1.10), ≈20% uncached input, ≈7% output.
The "intelligence" we bought cost ~$0.40; the rest was re-reading our own transcript.

**Cost decomposition per run** (verified):

| run | steps | avg ctx | uncached in | output | cache reads | total | cache share |
|---|---|---|---|---|---|---|---|
| 11999 | 18 | ~17k | $0.020 | $0.003 | $0.018 | $0.0403 | 45% |
| 11790 (M3) | 25 | ~28k | $0.022 | $0.010 | $0.042 | $0.0738 | 57% |
| 11848 | 31 | ~22k | $0.019 | $0.006 | $0.041 | $0.0659 | 62% |
| 12039 | 43 | ~29k | $0.037 | $0.005 | $0.074 | $0.1158 | 64% |
| 11885 | 179 | ~65k | $0.094 | $0.045 | **$0.705** | $0.8447 | **83%** |

**The cost law.** With one tool call per step, every step re-reads the entire context, and the
context grows with every step's result — so cache-read spend grows **~quadratically in step
count**: `cost_cache ≈ Σ ctx(step) × $0.06/M ≈ steps × avg_ctx × $0.06/M`. Steps hurt twice:
once as the count, once as the growth of what each subsequent step re-reads.

**The comparison that motivates this doc.** Claude Code closes these instances in 4–9
assistant turns to our 18–179 steps (~5.5× median). Its per-turn price is ~11× ours, so we
still land 2.1× cheaper overall — but the realized ratio degrades exactly where steps blow up:
3.2× cheaper on lean runs (11999), 1.3–1.5× on step-heavy ones (11951, 11964). The token-price
advantage is real; we spend most of it re-reading transcript.

**What the steps actually are** (session-DB tool anatomy):

| run | steps | edits | test-runs | file peeks | grep/ls | graph tools |
|---|---|---|---|---|---|---|
| 11999 | 18 | 1 | 1 | 5 | 1 | 10 |
| 11964 | 46 | 1 | 12 | 21 | 14 | 7 |
| 11885 | 179 | 41 | 21 | 43 | 22 | 52 |

One edit and ~44 steps of looking-and-verifying around it (11964) is the archetype. Every one
of those probes is independent and read-only — i.e. batchable.

**Steps ≈ tool calls.** 266 of 267 assistant messages across four ladder sessions carried
exactly **one** tool call — despite our system prompt already ordering batching
(`prompts/fragments.ts:3` BATCH_RULE, reinforced in `roles.ts` §1a). The model (minimax-m3)
ignores the advisory instruction essentially 100% of the time; the pipeline itself handles a
multi-call message fine (the single observed 2-call message executed correctly).

**Context anatomy of the worst run** (11885, ctx peak 124.8k): tool outputs ~234k chars
(~65k tok) across 178 parts, assistant text ~37k chars, reasoning ~31k chars — and
**0 parts pruned** (see §4).

---

## 2. How Claude Code lands in 4–9 turns (source-verified)

Direct read of `../claude-code-source-code` (file:line refs are into that checkout). Five
mechanisms, in impact order:

**2.1 Parallel tool batching — the turn collapser.** The system prompt orders it ("make all
independent tool calls in parallel", `src/constants/prompts.ts:310`; repeated inside the Bash
tool prompt with worked examples and pre-marked "run these in parallel" workflow steps,
`src/tools/BashTool/prompt.ts:85,298`). The executor is built for it: consecutive
concurrency-safe `tool_use` blocks are partitioned into one batch and run concurrently
(cap 10, `src/services/tools/toolOrchestration.ts:8-12`); non-safe tools run serially with
exclusive access. Safety is a **per-tool `isConcurrencySafe` predicate, default false**:
Read/Grep/Glob/WebFetch are safe; **Bash is dynamically safe when the command parses as
read-only**; Edit/Write are never safe (`src/Tool.ts:402,759`, `BashTool.tsx:434-440`).
Results are buffered and re-emitted **in received order** so the transcript stays
deterministic; only a *Bash* sibling failure cancels the rest of a batch
(`StreamingToolExecutor.ts:356-440`). Net effect: N discovery/verify probes = 1 turn = 1
context re-read.

**2.2 Layered cheap-first context management.** Before every model call, in order:
per-message tool-result budget → snip → **microcompact** → autocompact (`src/query.ts:365-478`)
— granular $0 evictions run first so the LLM summarize is a last resort. Microcompact evicts
**old tool results only** (Read/shell/Grep/Glob/Web/Edit/Write), keeping the last `keepRecent`
(default 5), replacing older content with a literal `[Old tool result content cleared]`
tombstone (`src/services/compact/microCompact.ts:36-50,446-530`). The model is *told* this
will happen and instructed to write down anything it needs later
(`prompts.ts:836-841`). Autocompact triggers at ~window−33k with a 3-failure circuit breaker
(`autoCompact.ts:29-91`).

**2.3 Hard per-result output caps.** Bash 30k chars (env-tunable, hard cap 150k); Read 2000
lines / 25k tokens; Grep 250 matches; Glob 100 files; any single result >50k chars is
persisted to disk with a 2k preview + path; **aggregate cap 200k chars across one turn's
batched results** (`src/constants/toolLimits.ts`, `outputLimits.ts`, `toolResultStorage.ts`).
Nothing like our 51.5k-char refs blob (pre-M3) can enter context at all.

**2.4 State tracking kills redundant steps.** A file-state LRU (100 entries/25MB) backs a
**read-dedup**: re-reading an unchanged range returns a stub, not the content — their telemetry
says ~18% of Read calls are same-file collisions (`FileReadTool.ts:523`). Edits require a
prior fresh Read (mtime-gated, `FileEditTool.ts:275-306`). The prompt bans re-verifying
already-checked results and gold-plating (`prompts.ts:201-203,211,240`).

**2.5 Planning rides free.** Todos live in app state, not messages; reminders and nudges are
`<system-reminder>` attachments smooshed onto *existing* user/tool-result messages — planning
bookkeeping never consumes an assistant turn (`TodoWriteTool.ts:62-94`,
`messages.ts:1797-1835,3663`). Cache discipline (single moving `cache_control` breakpoint,
byte-stable alphabetical tool ordering, latched TTL, `claude.ts:3078`, `tools.ts:354`) makes
the surviving turns cheap.

---

## 3. What the field does (external survey)

Web + source-code sweep, 2026-07-10; all load-bearing numbers verified against primary
sources. Only findings that change our design are kept.

**3.1 Batching is the proven turn collapser — and it's fragile.**
- The cleanest causal datapoint: **Amp's Librarian went ~3 → ~8 parallel calls/turn ⇒ ~15 → ~5
  turns ⇒ 43% cheaper, ~3× faster, quality flat** ([source](https://ampcode.com/news/a-faster-librarian)).
- Codex CLI (Rust) ships a mid-stream parallel executor: tool futures spawn as each call
  streams in, read-lock for parallel-safe tools / write-lock for mutating ones, results
  drained in emission order (`codex-rs/core/src/tools/parallel.rs`) — the same
  partition-by-safety shape as Claude Code's (§2.1). Crush uses semaphore(5) for read-side
  tools, mutex for bash/edit. OpenCode upstream (our base) lets the AI SDK fire tool calls
  as they stream, unbounded — capability present, unsteered.
- **Two silent killers documented by Anthropic**: returning each tool_result as a *separate
  user message* "teaches" the model to stop batching (in-context training against yourself),
  and provider/parser drift on open-weight serving stacks silently degrades multi-call
  fidelity (Moonshot ships a vendor-verifier for exactly this). Health metric: **avg tool_use
  blocks per assistant message, target > 1.0**
  ([Anthropic parallel-tool-use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)).
- **The third silent killer (measured in-house, 2026-07-10, 42 controlled API probes): your
  own single-call transcript.** M3 batches 3/3 spontaneously on a clean transcript; three
  single-call steps in carried history drag it to 1–2/3. The system-prompt BATCH_RULE loses
  that fight (1/3) while a recency-positioned reminder wins it (6/6) — in-context momentum
  outweighs steering-at-distance, so the fix must ride close to the generation point. This is
  the primary explanation for the 266/267 baseline (§1), not provider or parser drift (both
  cleared on our path by the same probe set).
- **Open-weight support**: MiniMax M2-family output format is parallel-native (one tool_call
  block holds multiple invokes) — so M3's 1-call-per-step behavior is steerable, not
  architectural. Trap: MiniMax is interleaved-thinking; stripping think blocks from carried
  history is documented to hurt performance. DeepSeek-class models measure **53.1% on
  parallel-call benchmarks via JSON tool calling vs 94.0% when tool use is expressed as
  code** ([CaveAgent](https://arxiv.org/pdf/2601.01569)) — for weak-parallel tiers, a
  *code-execution channel* (one "run this script" turn replacing N calls; CodeAct measured
  −52% latency/−64% tokens, Anthropic's programmatic tool calling −37% tokens with accuracy
  *gains*) rescues batching where JSON fan-out won't.

**3.2 Pruning: dumb masking beats LLM summarization — on both axes.**
- **"The Complexity Trap"** ([arXiv 2508.21433](https://arxiv.org/abs/2508.21433)), SWE-bench
  Verified ×500: rolling observation-masking (keep last M=10) **halves cost while matching or
  beating LLM summarization** — Qwen3-Coder: raw 53.4% @ $1.29 → masking 54.8% @ $0.61 →
  summary 53.8% @ $0.64.
- **SWE-agent's original ablation**: collapsing observations older than the last 5 to one
  line *improved* solve rate 15.0% → 18.0% — old observations are noise, not signal
  ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793)). OpenHands' production condenser
  pipeline (masking + summarize-on-overflow) published 54% vs 53% resolve at less than half
  the per-turn cost.
- **Eviction economics**: Anthropic's server-side context editing clears oldest-first in
  amortized chunks (`clear_at_least`) because eviction rewrites the cached prefix. Upstream
  OpenCode's `prune()` constants (protect 2 turns + 40k tail, act only if >20k freed) are the
  same amortization idea — that's the machinery we inherited in §4. Manus (production) goes
  further: append-only context, *restorable* compression (drop bulky content to disk, keep
  the path) — which is what our `cache_ref` spill already implements at the tool layer.
- Convergent per-result truncation constants: 2,000 lines / 50KiB with full output on disk +
  a "grep/read it" hint (OpenCode upstream, Goose, Roo); 10KB middle-cut (Codex).

**3.3 Verification waste is measured and large; memoization is unshipped.**
- Across **7,745 SWE-bench leaderboard traces**: agents average **8.8 test executions per
  task** (spread: 2.0–18.7 across harnesses). Controlled: banning test execution entirely
  costs only **1.25pp resolve (n.s.) while saving 56–62% tokens** (Claude-Code-specific
  figures; [arXiv 2606.26978](https://arxiv.org/abs/2606.26978)). Re-running the same test
  without an intervening code change is 2.5–6× more frequent in *failing* trajectories.
- Turn caps at the p75 turn count cut cost **24–68%** with minimal solve impact
  ([arXiv 2510.16786](https://arxiv.org/html/2510.16786)).
- **No surveyed agent ships hash-based test-result memoization** — only loop detectors, turn
  caps, and prompt policy ("prefer single tests, not the whole suite" is Claude Code's own
  best-practices line). Our L3.1 memo is a genuine edge; pytest-testmon/Nx-style
  affected-test selection exists as infrastructure to borrow.
- Sobering caveat: agent self-validation is a weak oracle — 81–100% of failing trajectories
  passed their own validation at least once. Memoize green results; don't inflate their
  authority (the real grader stays senior).

**3.4 Tier-splits: the expensive model decomposes; escalate on evidence.**
- Best coding datapoint: **DeepSeek-R1 architect + Sonnet editor = 64.0% @ $13.29 vs Sonnet
  solo 51.6% @ $14.41** (+12.4pp, cheaper) — with the caveat that the architect advantage
  decays as solo frontier models improve ([aider leaderboards](https://aider.chat/docs/leaderboards/)).
- **MinionS**: the *expensive* model decomposes into chunk-scoped subtasks, cheap models
  execute → **5.7× cost reduction at 97.9% of frontier quality**
  ([arXiv 2502.15964](https://arxiv.org/abs/2502.15964)) — the direction our
  conductor-decomposes design already took. ADaPT's decompose-*on-failure* (+28.3% success on
  hard tails) is the published form of our L4 grind valve.
- Anthropic's own multi-agent economics: agents ≈ 4× chat tokens, multi-agent ≈ 15× — an
  explicit "only when task value pays" gate. Matches our two-axis allocation philosophy.

**3.5 The read-price axis is a router input we don't use yet.** Verified against provider
pricing pages 2026-07-10: cache-hit prices spread **~20× across viable coding tiers** —
DeepSeek flash **$0.0028/M** (0.02×), Qwen3 Coder $0.022/M, MiniMax M3 $0.06/M (0.2×,
confirms our measured row), Kimi 0.17×, GLM-5.2 $0.26/M — and Chinese providers cache
implicitly while Claude/Gemini need explicit `cache_control` plus write/storage surcharges.
Two facts sharpen the lever: (a) the price data already lives in code
(`ECON_COST_MATRIX`, `packages/code-intelligence/src/econ-cost.ts:49` — per-model
`cachedInput` rates) but `allocateSlice` never reads it; (b) the price ladder is **not
monotone with the tier ladder** — our executor's cached read ($0.01/M) is 6× cheaper than
our conductor's ($0.06/M), so routing the long boring turn-tail into fresh executor slices
is a compound win (cheaper rate × smaller fresh context × the child-slice batching dividend,
§7 P11 row). Design + build is tracked as the read-price tail-routing task. Also: the
OpenRouter cache-accounting bug class (missing cache-write tokens in usage) is confirmed
current — keeps CLAUDE.md's day-0 verification gate relevant.

---

## 4. What we already have — and why it doesn't fire

Inventory against our engine (all verified in code this session):

| capability | state | seam | why it doesn't help runs today |
|---|---|---|---|
| Batching instruction | **fires (2026-07-10)** | BATCH_RULE + PROBE_SCRIPT_RULE (`session/prompts/fragments.ts`); batch-momentum watcher `turn-supervisor.ts:291` → recency nudge (`prompts/nudges.ts`, injected `prompt.ts:1642`) | advisory-at-distance alone loses to transcript momentum (§3.1 third killer); the recency watcher moved M3 to **1.19 calls/msg** — first reading >1.0 (11964); fresh child slices batch 1.47/msg. `parallel_tool_calls` IS set on the litellm path (`packages/llm/src/protocols/openai-chat.ts:358`, OL-9.4a) |
| Multi-call message handling | **works** | processor/tools pipeline | proven by the one observed 2-call message; concurrency of execution unverified (AI-SDK default) |
| Deterministic prune | **present, never fires in runs** | `session/compaction.ts:518` `prune()` — 40k protected tail, 20k minimum, defaults ON | (a) forked **once at end of user turn** (`prompt.ts:2800`) — after all step cost is paid; (b) `turns < 2` gate walks *user* messages, and a `run` session has exactly one → **nothing is ever eligible. 0 parts pruned in the 179-step 11885 run** |
| Observation masking | **present, overflow-only** | `compaction.ts:633` `maskObservations()` | fires only inside `compact()`'s prune-first ladder, which triggers at `isOverflow` — our 524k window never overflowed (peak 124.8k) |
| Stale-read pruning | **present, overflow-only** | `compaction.ts:578` `pruneStaleReads()` (mtime-based) | same trigger problem |
| LLM summarize + receipt attribution | **present, overflow-only** | `compaction.ts` compact() ladder, AC-5.1 | same |
| Per-result caps | **per-tool + aggregate (2026-07-10)** | per-tool: `tool/truncate.ts` (2000 lines / 50KB); aggregate: `session/step-budget.ts` `enforceStepBudget` (~20k tok/step, largest-first trim, visible spill markers), enforced in the step loop before transcript build (`prompt.ts:2229`) | the L1.3 fan-out guardrail is now in place; single-line blobs can't be line-trimmed and rely on the per-tool 50KB cap |
| Step budget (inline) | **grind valve live** | `createGrindValve` (`turn-supervisor.ts:190`) — 60-step soft budget, fires on a 15-step no-green-verify stall, plants a reasoner design prepass (the L4.2 transition) | reactive by design: escalation happens on failure evidence, never pre-allocated |
| Difficulty→tier allocation | **present + degrade-cheap (2026-07-10)** | turn-read → `allocation.ts` two-axis; degraded policy: `DEGRADED_ARMING` (`arming-judge.ts`) | under-called 11885 (tracker tuning log 2026-07-10). A degraded/null turn-read now reads as the cheapest posture AND stands down mid-turn decomposition (gate in `slice-orchestrator.ts` `runConductorOrchestration`; grind valve is the only way up) — the 11964 re-fire's $0.3467-vs-$0.0985 trip was unguided decomposition on timed-out turn-reads, with slices lifted by allocateSlice's *structural* cells, not the difficulty floor |

The one-line diagnosis: **every context-economy mechanism we own is calibrated to interactive
chat granularity (user turns, window overflow), while the agentic-run cost accrues at *step*
granularity inside a single user turn, far below the overflow threshold.**

---

## 5. The four levers

Ranked by expected bill impact. Each grounded in the exact seams above.

### L1 — Batched tool calls per step (expected ~2–3× on the cache-read line)

The gap is model behavior, not harness capability. Three sub-moves, cheapest first:

1. **Provider hint + formatting audit.** Set `parallel_tool_calls: true` explicitly on the
   litellm chat request for tool-capable tiers (seam: `session/llm/request.ts` / `llm.ts`
   request assembly — currently only `toolChoice` is threaded). M2-family output is
   parallel-native (§3.1), so M3's single-call habit is steerable. **Audit first:** confirm
   our pipeline returns all of a step's tool_results in ONE user message — per-result
   messages in-context train the model *out* of batching (§3.1, Anthropic). Also: never strip
   M3's think blocks from carried history (documented regression).
2. **Structural steering, CC-style.** Advisory BATCH_RULE demonstrably fails on M3. Port
   what CC does instead: (a) repeat the instruction *inside the tool descriptions* the model
   reads at call time (bash/read/graph-search), with a worked example ("send `git status` and
   `git diff` as two calls in ONE message"); (b) pre-mark batchable sequences in our own
   workflow nudges (localization seed → "issue your first 3 orientation probes in one
   message"). Seams: `tool/bash.ts` description, `session/prompts/nudges.ts`, frame seeds in
   `slice-orchestrator.ts`. Instrument the health metric: **avg tool calls per assistant
   message** (receipt line; target > 1.5 on discovery-heavy runs).
3. **Concurrency-safe executor readiness.** Before encouraging fan-out, classify our tools:
   read/grep/glob/graph-search/file-peek bash = safe; edit/write/mutating bash = exclusive.
   Port CC's partition-then-run pattern (consecutive safe calls run concurrently, cap ~8;
   results re-emitted in received order; a failed sibling doesn't cancel reads) — Codex's
   RwLock executor and Crush's semaphore(5) are the same shape (§3.1). Seam:
   `session/tools.ts` execution wrapper — today calls execute serially in message order.
   **Guardrail:** an aggregate per-step result budget (CC: 200k chars/turn; ours should be
   token-based, ~20k tok/step with per-result overflow-to-`cache_ref` spill) so a fan-out
   can't stuff the context it was meant to save.
4. **Code-execution channel for weak-parallel escalation tiers.** If a tier won't batch via
   JSON calls (DeepSeek-class: 53% JSON vs 94% as code, §3.1), let it write one short probe
   script (read-only bash) instead of N calls — one turn, N results, already within our bash
   tool. This is a prompt-shape change, not a new tool; CodeAct/programmatic-tool-calling
   measured −37–64% tokens with accuracy flat-to-up.

**Sanity math:** 11964's 46 steps were ~33 independent probes + 12 test-runs + 1 edit. At
batch factor 3 for the probes, ~46 → ~22 messages ⇒ cache reads roughly halve. The quadratic
term improves too: results arriving earlier means less transcript exists when they arrive.

**Status (2026-07-10):** L1.1 shipped — `parallel_tool_calls` set (`openai-chat.ts:358`) and
the one-message result shape audited clean (`message-v2.ts`; think blocks preserved). L1.2's
steering-at-distance was refuted by the 42-probe experiment (§3.1 third killer) and
superseded by the recency-positioned **batch-momentum watcher** (L1.2c,
`turn-supervisor.ts:291` + `prompts/nudges.ts`): fires after 3 consecutive single-call
steps, re-arms every 8 — first M3 reading above the floor (1.19 calls/msg on 11964). L1.3's
aggregate step budget shipped (`session/step-budget.ts`); the concurrency executor remains
unbuilt. L1.4 shipped as prompt shape — `PROBE_SCRIPT_RULE` (single source,
`fragments.ts`) referenced from the bash description, the momentum nudge, and the
bash-holding personas. The 2–3× cache-read payoff remains unproven until a grind-class
trace (60+ steps) is re-fired.

### L2 — Step-granular context economy (expected ~1.5× on grind runs; multiplicative with L1)

Stop keying pruning to user turns and window overflow. Re-trigger the machinery we already
own at step granularity, keeping [`AUTO_COMPACTION_AND_CONTEXT.md`](./AUTO_COMPACTION_AND_CONTEXT.md)
as the owner of the mechanisms themselves:

1. **Fix the two dead gates in `prune()`** (`compaction.ts:518`): count *assistant steps*,
   not user messages (`turns < 2` → "protect the last K=5 steps"); and invoke it inside the
   step loop — not `forkIn(scope)` at turn end — every N steps (N≈10) or when estimated ctx
   exceeds an **economic threshold** (~40k tokens), whichever first. The overflow ladder stays
   as-is for the window-full case.
2. **Promote `maskObservations()` + `pruneStaleReads()` into the same step-loop trigger.**
   They're $0 passes; running them only at 524k-window overflow means never. The evidence for
   mask-first is now strong (§3.2): rolling masking with keep-last-10 **halved cost and
   slightly beat** LLM summarization on SWE-bench Verified, and SWE-agent's keep-last-5
   ablation *gained* 3pp solve rate — old observations are noise. LLM summarize stays
   overflow-only. **Eviction amortization on our path:** implicit caching with $0 writes
   means an eviction's penalty is a one-time re-ingest of the post-edit suffix at 5× the read
   price — so evict in chunks (the inherited `PRUNE_MINIMUM=20k` is exactly this
   amortization; keep it for masking too, e.g. mask only when ≥10k tokens reclaimable).
3. **Tell the model.** Port CC's contract line ("older tool results are cleared; write down
   what you need") into the conductor base prompt, so masking doesn't surprise the model into
   re-reading. Seam: `session/prompts/fragments.ts`.
4. **Unified per-result ceilings** (finishes what M3 started): a single token ceiling at the
   tool boundary (~6k tok/result; oversize spills to `cache_ref` pagination which
   `graph-tools.ts` already implements) — the meter already records per-call raw/returned for
   receipt attribution.

**Sanity math:** 11885 carried ~65k avg ctx over 179 steps. Keep-last-5-steps masking with a
40k economic ceiling ⇒ avg ctx ~35k ⇒ cache reads ~$0.38 vs $0.705.

### L3 — Verify-loop dedup (expected ~10–20% of steps on hard runs)

12–21 of the steps on hard instances were test invocations, many re-proving an already-green
result (11964 ran `model_enums` variants 12×; 11885 ran suites 21×) — squarely on the field
average of 8.8 test executions/task, where controlled studies show most of it buys nothing
(§3.3). No surveyed agent ships result memoization, so L3.1 is differentiating, not parity.

1. **Green-test memo.** Key = (normalized command, mtime-set of files the run touched). On a
   repeat invocation with no intervening edit to any watched file, return the memoized result
   line as the tool output ("unchanged since step N: OK, 45 tests") instead of re-executing.
   Invalidate on any edit/write. Seam: shell tool wrapper in `tool/` + the F2 verify-command
   runner. Deterministic, $0, and saves wall-clock too.
2. **Read-dedup stub, CC-style.** Same-range re-read of an unchanged file returns a stub
   (CC telemetry: ~18% of reads are dup). Seam: `tool/read.ts` + a small file-state LRU;
   our edit-governance already tracks freshness for its own gate — reuse that state.
3. **Prompt discipline.** Add CC's "verify once, at the finish line; don't re-verify what you
   already checked" to the shared-discipline base (`prompts/fragments.ts`) — cheap, and the
   failure-mode overhaul (F1–F4) showed base-prompt discipline lines do steer M3 when phrased
   as rules rather than advice.

### L4 — Design-escalation for grinder tickets (expected: converts the $0.84 tail case)

Already half-designed via the two-axis allocation; the 11885 run supplies the missing trigger
evidence (tracker tuning log 2026-07-10). The survey validates both the direction and the
trigger shape (§3.4): the *expensive* model decomposes / cheap executes (MinionS: 5.7× cost
reduction at 97.9% quality; aider: R1-architect+editor beats the editor solo by 12.4pp at
lower cost), and decompose-**on-failure** (ADaPT) is the published form of the grind valve —
escalation stays evidence-gated, per the build directive.

**Status (2026-07-10):** live fires revised L4.1 — blind design-slice decomposition on 11885
went **0/3 at $0.98–1.52**, while localize-inline-first (resolution-gate branch 1b) passed
at $0.7879; decomposition earns its price only after localization evidence exists. The valve
(L4.2) is live (`createGrindValve`, `turn-supervisor.ts:190`).

1. **Turn-read calibration:** optimization-phrased tickets ("make X more efficient",
   "combine/reduce/dedupe Y") are *design-shaped*, not build-trivial. One prompt-table row in
   the turn-read extraction; re-fire 11885 expecting a reasoner-authored design + conductor
   execution ≪ $0.84. Held to the n=1 guardrail: only after a second grinder confirms, or
   behind the offline arming rig showing 0 over-fires on the nine cheap instances.
2. **Grind valve (safety net, not router):** the inline path gets a soft step budget
   (`agent.steps` for the conductor, ~60) — on hitting it with no green verify transition in
   the last ~15 steps, the turn-supervisor proposes a reasoner design slice (existing P11
   delegation machinery) instead of grinding on. This is failure-evidence escalation — the
   kind the build directive says to employ only where grounded — and the 11885 trace is that
   grounding: 41 edit-steps of trial-and-error that a $0.23 design slice (12039 run-1 price)
   would likely have collapsed.

### Expected combined effect

| run | today | L1 | +L2 | +L3 | notes |
|---|---|---|---|---|---|
| 11964 ($0.0985) | 46 steps | ~22 msgs, ~$0.055 | ~$0.048 | ~$0.042 | probes batch 3:1; ctx already lean |
| 11885 ($0.8447) | 179 steps | ~90 msgs, ~$0.45 | ~$0.28 | ~$0.24 | L4 would instead cap it near ~$0.3–0.4 with a design slice |

Ladder-wide: from 2.1× → **~4–6× cheaper than the frontier baseline** at unchanged pass rate —
which is the thesis number (`f×(1−1/r)`) actually realized.

---

## 6. Phasing, measurement, guardrails

**Order: L1.1+L1.2 → L2.1+L2.2 → L3.1 → L1.3 → L2.3/2.4 → L3.2/3.3 → L4** — cheapest,
least-risky, most-measurable first. Every phase re-fires a fixed probe set (11999 lean,
11964 mid, 11885 grind) and records a tracker tuning-log row.

Measurement is the receipt (observability is the product surface): per-run `cache r` line and
`[econ:meter]` already expose the inputs; add a `reclaimed` line attributing tokens saved by
batch/mask/memo (the AC-5.1 attribution plumbing already exists for compaction).

**Metric note (2026-07-10):** the conductor model was swapped (minimax-m3 → deepseek-v4-flash,
user-directed) between the baseline ladder and L1 validation, so raw $ is not comparable
across that boundary. The primary L1 validation metrics are **turns (assistant messages)**
and **batch calls/msg** (the receipt's new `batch X.XX/msg` line) — both model-comparable;
cost stays on the receipt as secondary evidence. The §1 baselines (1.00–1.01 calls/msg) were
measured on minimax-m3.

Guardrails (standing, from the build directive):
- **No ✓ case may get more expensive** — the nine cheap instances are the regression set
  (compared within the same conductor binding; across a model swap, compare turns).
- Pass rate is senior to cost: a lever that costs even one real-graded pass is reverted.
- Masking/memoization must be observable in the transcript (tombstones, "unchanged since
  step N") — never silently absent context, or debugging trust dies.
- Watch-fors carried from M3: truncation markers must steer the model to *narrow*, not to
  trust partial data; batching must not revive the uncapped-blob problem (aggregate step
  budget is mandatory before executor fan-out ships).

---

## 7. Interaction with the orchestration machinery

Levers 1–3 sit **below** the orchestration layer
([`../architecture/ORCHESTRATION_MECHANISM.md`](../architecture/ORCHESTRATION_MECHANISM.md));
they change what a step costs, not which steps the machinery decides to take. L4 is the one
genuine mechanism change. The specific touchpoints, so implementation keeps them honest:

| mechanism | interaction | rule to preserve |
|---|---|---|
| Two-axis allocation (P-series, `allocation.ts`) | none functionally — but L1–L3 cut the *conductor's* step cost, which shifts the L4 break-even (a cheaper grind weakens the case for escalating a given ticket) | re-derive the L4 step-budget threshold **after** L1–L3 land, not before |
| P8 step budgets (slices) / 25-tool slice cap | budgets count **tool calls**, batching only reduces *messages* — cap semantics unchanged; a batched slice finishes the same work in fewer round trips | do not convert caps to message counts; calls stay the unit |
| P6b scope-overlap serialization | operates at slice level; L1's concurrency-safe fan-out operates *within* a step — orthogonal. Edits stay exclusive in both layers | governance gate (fires at the edit) must still see every edit individually — edits are never batched, so this holds by construction |
| Sound-rung verification (OL-7.9 verify commands) | **L3 memoization must never satisfy the sound rung.** The rung is the trust anchor (posterior-trustable); a memoized "green" is the agent's memory, and §3.3 shows self-validation is a weak oracle. In practice safe by construction — a fix slice edits files, which invalidates the memo — but the final rung run must bypass the memo explicitly | memo applies to *intermediate* re-verification inside a slice; the rung's verdict always re-executes |
| P9 synthesis / unverified cascade | fewer wasted verify steps (L3) means outcomes reach synthesis with the same trust labels at lower cost; no logic change | — |
| P11 delegation (child mini-loops) | children inherit all three substrate levers automatically (same tool layer, same step loop); child transcripts are separate sessions so masking budgets apply per-loop. Measured 2026-07-10: fresh child transcripts batch at **1.47 calls/msg** vs the root's momentum-suppressed ~1.0 — decomposition carries a hidden batching dividend (shifts the L1↔L4 break-even) | per-loop, not per-turn, accounting for the keep-last-K window |
| Turn-read / arming (W2) | **L4.1 is a turn-read calibration** (optimization-phrased tickets → design-shaped). Same evidence-grounded-judge architecture, one more table row; validated on the arming rig (0 over-fires on the nine cheap instances) before live | n=1 guardrail from the tracker tuning log stands |
| shouldOrchestrate (turn-open) | **L4.2 (grind valve) adds the one new transition**: inline → orchestrated *mid-turn* on step-budget + no-green-progress evidence. Today orchestration is decided only at turn open | this is the only change that needs an ORCHESTRATION_MECHANISM.md update when it ships (new edge in the state machine); L1–L3 need none |
| Frame seeds / repo primer / turn-read verdict | L2 masking must treat these as protected parts (the AC-6.1 protected-region machinery already covers plan/pins — extend the predicate to seeds + primer) | a masked-away primer would send the model re-deriving repo basics, spending the steps L2 saved |
| Escalation briefs (cross-tier) | briefs are built from structured state (todos, slice outcomes, receipts), not raw transcript — masking old tool outputs doesn't degrade them | keep briefs sourced from state, never from raw transcript spans |

Net: the orchestration *decisions* (what to decompose, which tier authors, what verifies)
are untouched by L1–L3; the *economics under* those decisions improve on both sides of every
comparison the allocator makes. The savings model `f×(1−1/r)` is unchanged — these levers
raise the realized fraction of `r` that survives harness overhead.
