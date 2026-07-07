# The econ Orchestration Mechanism

**Status: v1.4 (2026-07-07) — implemented (U1–U6 + wave-2 wiring), live-fire smoked, always-on.**
This doc also absorbed the still-relevant content of the three retired plan docs
(DECOMPOSITION_ORCHESTRATION_PLAN, PERSONA_ORCHESTRATION_PLAN, SELF_ORCHESTRATION_PLAN —
deleted 2026-07-07) into §7 "Inherited foundations".
Turn triage runs on every root turn open with no feature flag (base-flow features ship enabled;
mock-provider test harnesses switch the turn-open calls off via the `SessionPrompt.TurnOpenCalls`
service). Two live-fire fixes landed during the smoke: small (housekeeping) calls skip the
adaptive reasoning gate (un-muted thinking starved the triage JSON), and the triage cap is 8s
(a triage-shaped completion measures ~3.7–4.3s through the live gateway). All research
streams are in (Claude Code source recon, econ seam map, routing/triage literature, cache
economics, hierarchy/fan-out); every §5 decision is closed; §6 U1–U6 are being built. Companion docs:
[ECON_ARCHITECTURE](./ECON_ARCHITECTURE.md) (whole-system design),
[failure-taxonomy](../design/failure-taxonomy.md) (the evidence this doc is built on; its §8
holds the flow-selection verdict + casting policy this doc extends),
[cross-tier-context](../design/cross-tier-context.md) (how tiers share context),
[TIER_FIRING_CHECKLIST](../testing/TIER_FIRING_CHECKLIST.md) (live-fire playbook).

econ runs a team of models at different pay grades — executor (junior), conductor (team
lead), reasoner (specialist), oracle (principal). The orchestration mechanism is everything
that happens between "user hits enter" and "the receipt prints": understanding the request,
splitting it into tracked goals, deciding who works on what, checking the work, and cleaning
up when an attempt fails. This doc is the single home for that mechanism's design.

---

## 1. The new mechanism — a prompt's journey

The whole pipeline, end to end. Stages tagged **NEW** are the upgrades this doc introduces;
everything else already runs in production today (§2 has the as-built detail).

```
 user prompt
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [1] UNDERSTAND (triage) ── NEW: one cheap LLM call, forced      │
 │     schema → list of goals + constraints + confidence           │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [2] TRACK ── every goal becomes a todo at turn open (NEW:       │
 │     skeleton written before the conductor's first token);       │
 │     constraints arm hard gates; frame slices seeded per goal    │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [3] EVALUATE ── NEW: pre-flight check per task, AT DISPATCH:    │
 │     difficulty + blast radius + verifiability + history +       │
 │     cache cost → pick the tier, UP or DOWN                      │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [4] EXECUTE ── seat-scoped child sessions (exists): lean brief, │
 │     persona, step budget; deciders can't edit, runners can't    │
 │     write, the conductor never grinds                           │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [5] VERIFY ── 7-rung ladder (exists): run the actual build/     │
 │     tests, watch for test-dodging, case-count shrink, skips     │
 └─────────────────────────────────────────────────────────────────┘
    │ pass                          │ reject
    ▼                               ▼
 fold-back → receipt      ┌──────────────────────────────────────┐
                          │ [6] CONTAIN ── NEW: restore the tree │
                          │     to pre-attempt snapshot; failed  │
                          │     diff becomes advice, not residue │
                          └──────────────────────────────────────┘
                                    │
                                    ▼
                          ┌──────────────────────────────────────┐
                          │ [7] ESCALATE ── one tier up (exists),│
                          │     both attempts on the receipt     │
                          │     (double-pay) → back to [3]       │
                          └──────────────────────────────────────┘
```

### 1.1 Understand: one cheap model reads the prompt properly

Today a set of string-matching rules labels each prompt with exactly one category. That
breaks on compound requests — *"audit these five fixes, fix the profile-name bug users are
reporting, and don't touch any tests"* has three intents and fits no single label. String
matching has no answer to compound prompts; goal decomposition does.

**The upgrade:** the first act of every turn is one small, fast LLM call (conductor tier,
its own tiny context, ~1–2s, still well under a cent) that fills a strict form:

```
goals:
  1. "Audit the five fixes…"            → shape: audit
  2. "fix the profile-name bug…"        → shape: diagnosis-vague, needs a plan first
constraints:
  - "don't touch any tests"             → kind: no-test-edit
confidence: high
```

Three rules keep the cheap model honest (each backed by the research in §3):

- **It can only quote, never invent.** Every goal and constraint must be a verbatim span of
  the user's prompt, and we validate that the span exists. The triage cannot hallucinate
  work, and it cannot start planning — extraction only.
- **It answers a fixed form, not an open question.** The forced schema is what makes the
  call reliable and cheap — and it's why the conductor tier suffices here without waking a
  heavyweight reasoner. Note the tier floor runs the other way too: splitting and
  categorizing a nuanced compound prompt is exactly where small models measurably fail
  (§3.2, rule 5), which is why this call runs on the conductor, not the executor (§4.1).
- **If it fails, the old heuristic catches.** Schema-invalid or too slow → fall back to
  today's regex classifier, and log the disagreement as free evaluation telemetry.

### 1.2 Track: goals become todos before any work starts

If triage found more than one goal, the todo list is written **at turn open** — before the
conductor produces its first token. The conductor wakes up to a tracked plan instead of a
wall of text. This finishes a journey we've already been on: live fire proved the cheap
conductor won't reliably *type* todos (structural nets now do it), and this step stops
trusting it to *create* them, too.

Each goal also brings its own setup: a symptom-shaped goal seeds a planner pre-pass (a
senior investigates before anyone edits — the door that produced the django gold-file fix),
a build-list goal arms the mechanical dispatch net, and every extracted constraint arms a
*hard* gate — "don't touch tests" becomes an edit-time block, not a polite suggestion. The
negation bug we hand-patched ("Do not modify any test files" accidentally *disarming* the
gate) becomes structurally impossible: the constraint is understood, not pattern-matched.

**The list is a tree, executed as a star.** Goals from triage form the top level; each goal
decomposes into its own child items, and those into sub-items where genuinely needed. Two
caps keep the tree honest — both set by the evidence in §3.4, not by taste:

- **Data depth ≤3** (goal → task → sub-item). Recursive decomposition measurably helps up
  to depth 2–3 and falls off past it (error compounding, context fragmentation).
- **Branching 3–5 per node.** Parallel fan-out pays off at 3–5 independent branches; past
  ~5, coordination overhead and tail latency eat the speedup. A task that keeps failing
  gets a *higher tier*, not a wider fan-out.

Unrelated goals run as **parallel instances** — two independent goals can each get their
own child session at the same time, on the same tier or different tiers (the zod run
already does this for slices; the tree extends it to whole goals). But the tree is a
*tracker* structure, not an execution hierarchy: **children never spawn grandchildren.** A
child that discovers its task needs further splitting returns the sub-plan to the
conductor, which re-dispatches — recursion happens *through the hub*, never below it. The
write-heavy-agent evidence is unambiguous that executed depth fragments context (§3.4);
read-only exploration inside a research child is the one place a second level is allowed.

```
   tracker (tree, depth ≤3)              execution (always a star)
   goal A ── task A1                            conductor
          └─ task A2 ── sub A2a                ╱    │    ╲
   goal B ── task B1                     child(A1) child(A2) child(B1)
                                         parallel, ≤3–5 live at once;
                                         a child needing a further split
                                         folds its sub-plan back to the hub
```

### 1.3 Evaluate: a pre-flight check before anyone is hired

This is the third mechanism the system has been missing. Today a task's tier is decided
once, from static metadata, when the plan is written — and the only thing that ever changes
it is a *failure* after the money is spent. Neither vibes nor failure: every task gets
**evaluated at dispatch time**, and the evaluation can move the tier in *both* directions.

The evaluator's inputs, all cheap to read:

| signal | question it answers |
|---|---|
| graph probes (fan-in, blast radius) | how much breaks if this goes wrong? |
| verify strength (tests exist? commands derived?) | will a failure even be *detected*? |
| triage shape + difficulty | what kind of work is this, per the goal it serves? |
| attempt history + prior-failure notes | has this slice (or this entity) burned us before? |
| cache term (§1.7) | what does *moving* this work actually cost? |

And one rule does most of the deciding: **verification strength is what makes a cheap
attempt safe.** If the work is well-tested and cleanly revertible, giving it to the junior
is a bounded gamble — worst case we lose a few cents and escalate. If verification is weak
*and* the blast radius is high, a cheap failure would be silent and expensive — so the
senior goes first. Ambiguity still rounds **up** for decision-shaped work (the §8 casting
policy), and rounds **down** only for mechanical work sitting inside a strong safety net.

The evaluator also decides **who executes — the working thread itself, or a child** (the
venue). Spawning is not free: a child duplicates context the parent already holds warm (a
brief compile plus a cold cache write), and indiscriminate multi-agent use runs up to ~15×
the tokens of a single thread (§3.4). Hence the affinity rule: **if a subtask runs on the
same tier as the thread already working, and mostly needs context that thread already
holds, it runs inline — no child is spawned.** Delegation is for the cases where it earns
its cost: the tier changes, the needed context genuinely diverges (a lean brief suffices),
or the work is read-only and parallelizable — the one shape where fan-out reliably pays.
One or two small same-tier items are always cheaper done inline than spawned.

The evaluator also re-runs mid-flight: a slice that stalls (no progress, contradicting
evidence) doesn't just get a nudge — it gets *re-classified* ("is this harder than we
thought?"), which the literature finds catches 60–70% of misrouted-hard tasks before the
budget burns (§3.2, rule 3).

### 1.4 Execute: the right seat, with the right tools removed

Unchanged from today, and worth restating because the evaluator feeds it: work runs in
child sessions with **seat-scoped toolsets**. A senior brought in to *decide* (plan, judge)
physically cannot edit files or run shell commands — deciding is the job, grinding is
delegated down. A runner that executes builds cannot edit. Every child gets a lean compiled
brief, never the session transcript. (Proven live: the django planner delivered its ranked
plan in 9 read-only steps; the zod runner ran the build with edit permissions denied.)

### 1.5 Verify: the work is checked, not trusted

Also unchanged — the seven-rung verifier ladder runs the actual build/test commands, watches
the trajectory for test-dodging, rejects suspicious skips and shrinking test counts, and
falls back to judge/consistency checks when no tests exist. This is the load-bearing wall:
both the cheap-first gamble (§1.3) and the containment story (§1.6) only work because
failure is *detected* here. Notably, the incumbent doesn't have this wall at all — Claude
Code merges subagent work back on pure trust (§3.1). It can afford trust; a system built on
cheap tiers cannot.

### 1.6 Contain: a failed attempt costs its tokens, not the tree

The gap the zod live fire exposed. Today, when the junior's attempt fails verification, its
edits **stay in the working tree** and the escalated senior starts from that corrupted
state — anchored to the failed approach at best, building on broken code at worst. And if
the turn ends there, the residue ships.

**The upgrade** brackets every attempt with a snapshot (the git-based snapshot subsystem
already exists in the codebase — it's just never been wired to the slice loop):

```
        snapshot ──► attempt ──► verify ──► pass ──► keep, fold back
           │                        │
           │                        └─ reject
           │                             │
           └────────── restore ◄─────────┘
                          │
                          ▼
              escalation brief gains:
              "prior attempt's diff (rejected because X) —
               context to learn from, not code to keep"
```

The escalated tier starts from a **clean tree**, and the failed diff rides along as
*advice*. This keeps the one accidental benefit of today's dirty-tree behavior (the senior
can see what was tried) without the corruption risk. Parallel slices get the same guarantee
via worktree isolation — borrowing Claude Code's mechanic but not its blind merge: econ
merges only diffs that passed the rungs.

### 1.7 The cache rule: the owner stays put; only briefs travel

Prompt caches are per-model. Move work between tiers and the new model starts cold — so a
naive "cheapest capable tier per task" rule can quietly cost more than it saves. The
research (§3.3) reduces this to one clean principle and one guardrail:

- **The turn owner never moves.** The conductor's session context is the one big, hot,
  constantly re-read prefix. At a healthy hit rate its effective cost per call drops ~4×;
  moving it to another model re-bills everything. This was already the §8 "spine" rule for
  stability reasons — the cache math is its economic proof.
- **Per-slice switching is cheap *because* only the brief travels.** A child slice carries a
  30–60k-token brief, not the transcript. On econ's provider path (mostly no cache-write
  premium), a cold start on a brief costs cents. The lean-brief architecture is not a
  nice-to-have — it is what makes multi-tier routing affordable at all.
- **The guardrail:** don't bounce a *group* of related slices across tiers item-by-item, and
  treat a falling hit rate (<70%) as a prefix-invalidation bug to fix, never as a routing
  signal to react to.

### 1.8 The receipt

Every stage above leaves a decodable trace: which goals were found, what the evaluator
decided and why, which seats ran, what was verified, what got reverted, where escalation
double-paid. The user-facing receipt stays a per-tier cost drilldown (facts only, no
counterfactual "you would have paid X elsewhere" — that lives in benchmarks, never in
product); the internal trace is what makes a misrouted turn diagnosable after the fact.

---

## 2. Today's mechanism, and the five gaps

### 2.1 As built (2026-07-06 — seam map verified by direct code recon)

| stage | what runs today | where |
|---|---|---|
| classify | `classifyTurnShape` regex heuristic → one label + confidence; preamble; gates; frame-slice seed on diagnosis-vague | `packages/opencode/src/session/slice-orchestrator.ts`, step-0 block in `session/prompt.ts` |
| decompose | conductor plans; structural nets type todos (`autoTypeTodos`: judgment / diagnosis / `typeBuildPlan`); `shouldOrchestrate` benefit gate | `slice-orchestrator.ts` |
| probe | coupling / testStrength / verifyCommands probed **once, at decompose time** | `probeSlice*` in `packages/opencode/src/tool/graph-tools.ts` |
| allocate | static matrix sliceType × coupling × testStrength × need → tier; risk breaks exactly one borderline cell toward oracle (`risk > 70`); **no hysteresis, no de-escalation, no dispatch-time re-eval** | `packages/code-intelligence/src/allocation.ts:132-212` (risk tiebreak `:201-210`) |
| execute | seat-scoped child sessions, personas, step budgets, lean briefs | `childSlicePermission`, dispatch site in `session/prompt.ts` |
| verify | 7 rungs: sound (runs `verifyCommands`, case counts), behavior gate, shrink reject, skip flags, extra rung, QE veto, flagged unverified-accept | `packages/code-intelligence/src/verifier.ts:518-601` |
| escalate | executor → conductor → reasoner → oracle with type ceilings; escalation brief (verdict + ≤6k-char digest + files/commands lists); **failed edits NOT reverted**; double-pay booked per rung | `slice-loop.ts:271-282` (chain), `:414-443` (brief), `:702-716` (booking into `double-pay.ts`) |
| observe | `turn_shape` / `orchestration_engaged` events; `EconReceipt` per-tier drilldown | session logs, receipt |

Live-fire status: diagnosis-planner door FIRED with payoff (django gold-file fix, ~$0.15);
mechanical-dispatch door FIRED (zod, ~$0.07); escalation ladder FIRED live with double-pay
visible; judgment door proven 4×; residual/judge-sampler door awaits an express-style case.

### 2.2 The five gaps

**G1 — one label per prompt.** Compound requests are unrepresentable; even a clean build
prompt was mislabeled `qa/low` in live fire (harmless only because a structural net caught
the todos downstream).

**G2 — tier decisions are frozen, and only failure changes them.** Probes run once at
decompose time; nothing re-evaluates at dispatch or between rungs; de-escalation doesn't
exist. By the time failure teaches us the tier was wrong, we've paid for the attempt, the
rework, and G3.

**G3 — no failure containment.** Rejected attempts leave their edits in the tree (confirmed
in code and observed live). The snapshot subsystem that fixes this exists
(`packages/opencode/src/snapshot/index.ts:44-53` — `track/restore/revert/diff`, git-based)
but is wired only to user-facing revert.

**G4 — cache-blind switching.** Nothing prices the cold-start cost of moving work between
models. Already measured internally: one tier's provider discounts cached reads ≈11.6×;
session-affinity behavior differs per model (W8 probe, `model-registry.ts` notes).

**G5 — the mechanism runs invisibly to the models that must cooperate with it.** Several stages need model cooperation the prompts don't supply: the generator is never shown the judge's checks (§1.5), so it can't pre-satisfy them; the reasoner delta described a delegating principal, not the leaf slice it actually runs as; the conductor is never told that inline edits escape the containment bracket (§1.6). Verify (generator pre-satisfies checks), Track (conductor types slices correctly), Execute (well-formed edits) and Contain (route uncertain edits into slices) each have a cooperation seam the prompts were silent on. Being closed by the prompt-content overhaul — the prompt-side companion to U3/U4.

---

## 3. What the research says

### 3.1 The incumbent (Claude Code source, `../claude-code-source-code`)

| mechanism | what the source shows | lesson for econ |
|---|---|---|
| cheap pre-processing | one blocking small-model call: the auto-mode permission classifier (structured verdict, allowlist fast-path skips the call) — no prompt-triage call | the *pattern* (small model + forced schema + blocking gate + fast-path) is exactly our triage shape, aimed at a different question |
| todo evaluation | none — todos are never scored for difficulty/risk; one nice nudge: a 3+ item list closing without a verification item triggers a reminder | copy the nudge; the evaluator itself is ours to build |
| routing | static per-agent model config; **no capability escalation exists** — only capacity fallback on overload errors | our ladder is a real differentiator, not table stakes |
| checkpoints | snapshot after every loop iteration; user-driven rewind; **no automatic revert on failure** | adopt the per-turn cadence as backstop; the automatic restore at rung-reject is ours |
| subagents | git worktree per agent, merged back **with zero verification — trust** | worktree mechanics transfer; the trust model doesn't — cheap tiers must be verified |
| failure handling | categorized retry errors only; no "prior attempt failed because X" context | our escalation brief is already ahead; feed it the rejected diff |

One frontier model buys quality with trust; a cheap-tier team buys it with verification.
econ's mechanism cannot be "Claude Code, cheaper" — evaluated casting, verification, and
containment *are* the product.

### 3.2 Routing & triage literature (distilled to design rules)

1. **Cascade (try cheap → verify → escalate) beats predicting the tier upfront** for coding
   — FrugalGPT, RouteLLM, RouterBench all land on the same cost-quality frontier result.
   **No paper contradicted our design.** The caveats are about the *deferral signal*, not
   the shape.
2. **A model's own confidence is a weak escalation signal; external verification is
   strong** (AutoMix, NeurIPS-23 deferral study). Validates commands-over-confidence rungs;
   argues for agreement-sampling on untestable slices.
3. **Route per-step, not per-task, and re-classify on stall** — catches 60–70% of
   misrouted-hard tasks early (agentic routing literature). Direct support for the
   dispatch-time + mid-flight evaluator.
4. **Coarse-route then fine-cascade** (Cluster/Route/Escalate, ETH 2025) — exactly the
   triage + ladder split.
5. **Small-model triage is reliable only as scoped extraction with a fallback** (open-ended
   triage: ~39% for small models; scoped few-shot classification: 84%+), and **extractive
   decomposition beats generative** (hallucinated subtasks are the documented failure mode
   — TaskBench, GRAFT). This is why §1.1's schema quotes, validates, and falls back.
6. **Blocking triage is the right latency pattern** for chat-shaped agents (~100–200ms class
   latency for large savings on the simple share).
7. **The architect/editor split is independently proven** (Aider: reasoning model plans,
   cheap model edits, 30–50% cheaper at parity) — the same split our planner pre-pass +
   cheap execution just validated live.

Citations: FrugalGPT [2305.05176](https://arxiv.org/abs/2305.05176) · RouteLLM
[2406.18665](https://arxiv.org/abs/2406.18665) · AutoMix
[2310.12963](https://arxiv.org/abs/2310.12963) · RouterBench
[2403.12031](https://arxiv.org/abs/2403.12031) · Cascade deferral
[NeurIPS 2023](https://openreview.net/forum?id=4KZhZJSPYU) · Cluster/Route/Escalate
[2606.27457](https://arxiv.org/abs/2606.27457) · Agent-as-a-Router
[2606.22902](https://arxiv.org/abs/2606.22902) · Adaptive-RAG
[2403.14403](https://arxiv.org/abs/2403.14403) · Decomposed Prompting
[2210.02406](https://arxiv.org/abs/2210.02406) · GRAFT
[2605.11706](https://arxiv.org/abs/2605.11706) ·
[TaskBench](https://proceedings.neurips.cc/paper_files/paper/2024/file/085185ea97db31ae6dcac7497616fd3e-Paper-Datasets_and_Benchmarks_Track.pdf) ·
[Aider architect mode](https://aider.chat/2024/09/26/architect.html).

### 3.3 Cache economics (why §1.7 is stated the way it is)

Provider mechanics converge on ~10× cached-read discounts, with differing write premiums:
explicit-cache providers charge one (1.25–2× on the write), automatic-prefix providers
charge none (first call at standard rate; DeepSeek-style disk caches read at ≈0.02×). The
reasoner's measured ≈11.6× read discount is in `model-registry.ts`. Self-hosted serving
reproduces the same economics via prefix caching (vLLM, SGLang RadixAttention) **only with
cache-aware routing** — session affinity lifts hit rates from ~60% to 85–96%. Production
discipline is unanimous (Manus, Anthropic guidance): byte-stable prefix, append-only
history, deterministic serialization. LiteLLM caveat: several streamed providers omit cache
fields — `EconModelProfile.cacheAccounting` stays canonical
([cross-tier-context §6.1](../design/cross-tier-context.md) owns the blind-spot record and
the >85% conductor hit-rate target).

The switch-vs-stay inequality, for a slice group of N expected calls — context `T_ctx` on
warm model M₁ (hit rate `h`, read discount `d`) vs a compiled brief `T_brief` on colder,
cheaper M₂ (write premium `w`):

```
Cost_stay(N)   = N × T_ctx × rate_M1 × (h·d + (1−h))
Cost_switch(N) = T_brief × rate_M2 × w  +  (N−1) × T_brief × rate_M2 × d
```

Worked shape — **verified against real `ECON_COST_MATRIX` rates** (`cache-switch.test.ts`,
2026-07-06): every current econ model bills cache writes at the plain input rate
(`writePremium = 1.0` across all four; conductor↔oracle is an exact 10× price pair), and at
that setting a lean-brief switch to a cheaper tier wins at **every** group size — the
"~20-call amortization threshold" in an earlier draft was an artifact of illustrative
write-premium rates and is corrected here. A stay-warm crossover only exists on
write-premium providers, or when the brief stops being lean (brief/context ≳ 0.235 at these
rates). **The decisive variable is `T_brief`, not the price ratio** — and the owner seat is
the ρ = 1 endpoint of that same rule: moving the owner means moving the whole transcript,
which is why it never moves.

Bottom line for G4: down-switching is *not* generally punished on econ's provider path
(lean briefs + mostly no write premium). What must never move is the owner seat's warm
session prefix. The genuine risks are bouncing a *group* item-by-item, and
prefix-invalidation bugs misread as routing problems. And per
[TOKEN_ECONOMICS](../strategy/TOKEN_ECONOMICS.md), oracle token-share dominates blended
cost — switching *to avoid* an oracle call is always worth a cold brief write.

### 3.4 Hierarchy, fan-out & delegation economics

The evidence splits cleanly by *what kind of work* is being delegated:

- **Recursion depth.** ADaPT (recursive decompose-on-need) shows recursion genuinely
  helps at depth 2 (task success 26.9% → 78.2% on its hardest split) and still helps at
  depth 3 with diminishing returns — but that is read/planning work. For **write-heavy
  agents the production record is one executed level**: Anthropic's research system is
  orchestrator → workers (read-only research, ~90% time cut, ~15× tokens), AgentOrchestra
  is conductor → specialists, Claude Code subagents are flat, and Cognition's "Don't Build
  Multi-Agents" documents the failure mode of going deeper — siblings and grandchildren
  make conflicting implicit decisions because none sees the others' work.
- **Branching.** 3–5 parallel workers is the repeated production optimum for moderate
  complexity; past ~5, coordination overhead and tail latency dominate the gains. When a
  task keeps failing, **escalating its tier beats widening the fan-out.**
- **Inline vs delegate.** Reads parallelize; writes inline (the Anthropic/Cognition split,
  both right about their own domain). Detailed child briefs (objective, output shape,
  boundaries) are non-negotiable for parallel dispatch — vague briefs measurably produce
  duplicated and conflicting sibling work.
- **Decomposition quality is a real, checkable property**, not taste: fixed verifiable
  pipelines can beat free-form agents outright (Agentless: 60.4% SWE-bench Verified at
  ~1/10 the cost of interactive agents); good splits minimize coupling (≤2–3 dependency
  edges per subtask), size each unit to be *independently verifiable*, and get checked
  before execution (rubric judge: no cycles, a success criterion per item, budget
  headroom), with explicit re-decomposition triggers during execution.

Citations: ADaPT [2311.05772](https://arxiv.org/abs/2311.05772) ·
[Anthropic — multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ·
[Cognition — Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) ·
AgentOrchestra [2506.12508](https://arxiv.org/abs/2506.12508) ·
Kimi-Dev / Agentless results [2509.23045](https://arxiv.org/html/2509.23045v2) ·
[LangChain — how and when to build multi-agent](https://blog.langchain.com/how-and-when-to-build-multi-agent-systems/) ·
LLM-agent evaluation survey [2507.21504](https://arxiv.org/html/2507.21504v1).

**Verdict on the goal tree:** yes to the tree, bounded exactly where proposed — the 3–4
cap lands on the evidence numbers (data depth 3, branching 3–5) — and **executed as a
star**: the tracker holds the hierarchy, the conductor stays the only spawner.

---

## 4. Design details (under the hood)

### 4.1 Turn Triage

One **conductor-tier** call at turn open; own tiny context (the session's golden cached
prefix is never touched — this is a separate small request, so model choice doesn't affect
the warm prefix either way); forced schema; temperature 0; **blocking** — its output gates
seeds, and the §7-item-3 lesson stands: the pre-pass must exist *before* exploration
starts. Tier decision (Q1, closed 2026-07-06): the *executor* binding is below the
language-competence floor for splitting and categorizing nuanced compound prompts — the
§3.2 small-model triage numbers are the documented risk — while the conductor is still
cheap enough that the call costs well under a cent. Capability floor beats the generic
"extraction is small-model work" rule.

```ts
type TriageVerdict = {
  goals: Array<{
    quote: string          // VERBATIM span of the user prompt — validated; extraction only
    shape: "diagnosis-vague" | "diagnosis-grounded" | "build" | "audit" | "qa" | "run-only"
    deliverable: string    // one line: what "done" looks like
    dependsOn?: number[]   // ordering ("apply whichever fixes the audit approves")
    needsPlan?: boolean    // seed a planner pre-pass for this goal
  }>
  constraints: Array<{ quote: string; kind: "no-test-edit" | "scope-limit" | "no-new-files" | "other" }>
  confidence: "high" | "low"
}
```

Hard rules: quotes validated against the prompt (a goal that can't cite its span is
dropped); ≤7 goals; schema-invalid or >8s → heuristic fallback (`classifyTurnShape`
demotes to reliability floor + shadow signal; `triage_vs_heuristic` disagreement logged);
triage never localizes or designs; a low-confidence verdict escalates the triage call to
the **reasoner** rather than guessing (one tier up from the conductor base). Consumers:
todo skeleton (§1.2), per-goal frame seeding, constraint→gate arming, `shouldOrchestrate`
goal count, graph prefetch for named files/symbols.

### 4.2 Pre-dispatch evaluator

Runs at dispatch and at every re-dispatch; inputs per §1.3 (probes — refreshed if the tree
changed since decompose — triage shape, attempt history + `rsk` anchors on touched entities,
verify strength, cache term). Decision rules, in priority order:

1. Constraint pins win (`need:` pins, slice-type ceilings — unchanged).
2. Decision-shaped work rounds up on ambiguity (§8 casting policy — unchanged).
3. **Mechanical work rounds down only inside a strong safety net**: verify commands exist
   AND containment can restore cleanly. Weak net + high blast radius → up front.
4. **Venue — the affinity rule (inline vs child):** same tier as the requesting thread AND
   high context overlap (the child's brief would mostly reproduce what the thread already
   holds warm), or a write tightly coupled to work in flight → **inline, no spawn**.
   Delegate when the tier changes, the context diverges (a lean brief suffices), or the
   work is read-only parallel. One or two small same-tier items: always inline.
5. Cache term: price any proposed move per §3.3; groups move together or not at all.
6. Hysteresis: re-evaluation within a turn needs a signal *delta* (new failure, new
   contradiction, refreshed probe change), not a marginal score wobble.

**Decomposition quality gate — the plan itself is verified before any spend.** Checked
mechanically where possible, by a cheap rubric judge where not: no dependency cycles;
every item carries a one-line objective, an expected output shape, and a success criterion
the rungs can actually check; ≤3 inbound dependencies per item; branching ≤5, tree depth
≤3; summed child estimates ≤70% of the turn budget (30% reserved for synthesis and
correction). A plan that fails the gate is re-decomposed *before* the first child spawns —
this is the anti-"vibes" step for the breakdown itself, mirroring what the rungs are for
the code.

**Re-decomposition triggers (during execution):** a child running >50% over its budget →
escalate that slice's tier, don't widen the fan-out; a sibling conflict detected at
fold-back → stop and re-plan with less parallelism; coverage gaps at synthesis → the
missing work becomes new tracked items, never silent scope loss; wall-clock ≥2× estimate →
suspect a hidden sequential dependency and re-order.

Mid-flight: the convergence-budget and contradiction triggers become evaluator re-entry
points — a stalled slice is re-classified, not just un-muted.

### 4.3 Failure containment

`snap.track()` before each attempt → rungs reject → `restore()` → escalate on a clean tree,
with the failed diff attached to the escalation brief as context ("rejected because X — do
not repeat this approach"). Parallel slices run in worktrees; only rung-passed diffs merge.
Per-turn snapshot cadence (the Claude Code pattern) as the outer backstop so a turn that
dies mid-failure is still revertible from the receipt. Default is clean-tree
(diff-as-advice), not salvage-in-place — revisit only with live-fire evidence that
re-derivation cost dominates (§5 Q3).

Cost note: a "snapshot" here is a commit in the shadow git repo the snapshot subsystem
already maintains (content-addressed, compressed, delta-only — unchanged files store
nothing new). Per-attempt cost ≈ the compressed diff, typically kilobytes; the watchpoint
is `git add` scan latency on very large repos (tens of ms), not storage. Two lean-keeping
rules: read-only slices (explorer/planner/decider seats) get **no bracket** — nothing to
roll back; attempt-level snapshots are pruned once the turn closes cleanly, keeping only
the per-turn backstop for user-facing rewind.

### 4.4 Cache-aware casting rules

1. The owner seat never moves (economic proof in §3.3; spine rule in failure-taxonomy §8).
2. Only briefs travel — never a transcript.
3. Price every proposed group move with the §3.3 inequality, using live rates from
   `ECON_COST_MATRIX` + per-model `cacheAccounting` (never hardcoded premiums).
4. Group same-tier slices consecutively; never down-switch mid-group for one small item.
5. Hit rate <70% on any tier is a prefix-invalidation alarm
   ([cross-tier-context](../design/cross-tier-context.md) owns the >85% target): fix the
   prefix; never route around a broken cache.

### 4.5 The goal tree — structure, caps, instances

The tracker stores the hierarchy (each todo carries a parent reference): triage goals are
root nodes, decomposition fills in tasks and sub-items beneath them. Caps, from §3.4's
evidence: **data depth ≤3** (goal → task → sub-item), **branching 3–5 per node**. Execution
is a **star, never a tree**: the conductor is the only spawner; at most one level of live
children; unrelated goals may run as parallel instances simultaneously (same tier or
different tiers, within the branching cap); a child that needs a further split folds its
sub-plan back to the conductor for re-dispatch. The single sanctioned exception: read-only
exploration inside a research child may fan out one more level — the one shape the
evidence supports going deeper. The affinity rule (§4.2 rule 4) decides per item whether
it becomes a child at all or stays inline on the thread that already holds the context.

---

## 5. Open decisions

| # | question | recommendation | state |
|---|---|---|---|
| Q1 | Triage tier: executor vs conductor | **decided: conductor** (2026-07-06) — the executor binding is below the language-competence floor for splitting/categorizing compound prompts (it cannot perform this activity at all today; §3.2 rule 5 documents the small-model triage floor); conductor is still sub-cent per call. Low-confidence verdicts escalate to the reasoner. | decided |
| Q2 | Triage writes the todo skeleton directly vs conductor confirms | **decided: direct write** (2026-07-06) — mooted by Q1: triage already runs on the conductor tier, so a confirmation pass would pay the same model twice to agree with itself. The framework materializes the skeleton mechanically from the triage verdict; the session thread can amend but never has to create. | decided |
| Q3 | Containment default: clean-tree + diff-as-advice vs salvage-in-place | **decided (2026-07-06): clean tree**, failed diff rides the escalation brief as advice; revisit only on live-fire evidence that re-derivation cost dominates | decided |
| Q4 | Cache term formula + premiums | **decided** — §3.3 inequality, live rates from model profiles (§4.4 rule 3) | decided |
| Q5 | De-escalation triggers beyond verify-strength | **decided (2026-07-06): verify-strength only** to start; new signals only from receipt evidence | decided |
| Q6 | Where hysteresis state lives | **decided (2026-07-06): per turn**; session-level only if receipts show cross-turn thrash | decided |
| Q7 | Goal-tree data depth cap | **decided (2026-07-06): 3** (goal → task → sub-item) — evidence degrades past depth 3 | decided |
| Q8 | Live branching cap | **decided (2026-07-06): 3 default, 5 max** — 5 only for provably independent read-heavy work | decided |
| Q9 | Affinity overlap threshold | **decided (2026-07-06): qualitative to start** — same tier + same files/entities in scope → inline; quantify from receipt data later | decided |

---

## 6. Implementation plan — what gets upgraded

Ordered by dependency; each step is independently shippable and live-fire-testable. What
does **not** change: the spine (conductor owns the turn), the structural nets (they remain
the enforcement layer triage advises), the verifier rungs, and the ladder itself.

**U1 — Turn Triage call** *(unlocks U2; biggest single fix — kills G1)*
Replace `classifyTurnShape` as the decider (it stays as fallback + shadow signal). New
triage module + schema-forced **conductor-tier** call (Q1 decided; low-confidence escalates
to the reasoner); wire into the `prompt.ts` step-0 block.
Gate before the flip: golden-set eval on the tierfire prompt corpus — goal-split accuracy,
constraint/negation extraction, p95 latency — plus `triage_vs_heuristic` telemetry.

**U2 — Goal-tracked turn open, tree-shaped** *(kills the compound-prompt gap end-to-end)*
Multi-goal verdicts materialize the todo skeleton at turn open; per-goal frame seeding
(planner/localization per goal, not per turn); constraints arm gates (`no-test-edit` from
the constraint, regex kept as belt-and-braces); `shouldOrchestrate` reads goal count. The
tracker gains the tree: todos carry a parent reference (goal → task → sub-item, depth ≤3,
branching ≤5); unrelated goals dispatch as parallel instances; fold-back accepts a
child-returned sub-plan and re-dispatches through the hub (children never spawn
grandchildren).

**U3 — Containment bracket** *(kills G3; small, high-value — the snapshot API already exists)*
`snap.track()` / `restore()` around slice attempts in `slice-loop.ts`; failed diff attached
to `buildEscalationBrief`; escalation-trigger provenance logged at INFO (the live-fire
decode gap); per-turn snapshot backstop. Worktree isolation for parallel slices lands as a
follow-up.

**U4 — Pre-dispatch evaluator** *(kills G2; depends on U1 for the triage signal, U3 for the
safe-gamble rule)*
`evaluate()` before `allocate()` at dispatch time: probe refresh on tree change, history +
`rsk` anchors, the §4.2 rule stack — including the venue/affinity rule (inline vs child)
and the decomposition quality gate on the plan itself — hysteresis state, de-escalation,
and the §4.2 re-decomposition triggers during execution. Mid-flight re-entry from the
convergence/contradiction triggers. `allocate()` keeps ceilings and pins.

**U5 — Cache-aware casting term** *(completes G4; depends on U4)*
Switch-pricing helper reading `ECON_COST_MATRIX` + `cacheAccounting`; group-move rule in
dispatch ordering; hit-rate alarm (<70%) into telemetry + status line.

**U6 — Receipt & decode upgrades** *(rides along each step)*
Goals + evaluator verdicts (with reasons) + reverts + escalation provenance on the internal
trace; receipt rollup unchanged in shape (facts only, per-tier drilldown).

Suggested order: **U1 → U2 → U3 → U4 → U5**, U6 riding along. U3 can land in parallel with
U1/U2 (no shared seams). Each step re-fires the relevant live-fire case from
[TIER_FIRING_CHECKLIST](../testing/TIER_FIRING_CHECKLIST.md) before the next begins.

---

## 7. Inherited foundations

This doc absorbed and superseded the three earlier plan docs
(`SELF_ORCHESTRATION_PLAN.md`, `DECOMPOSITION_ORCHESTRATION_PLAN.md`,
`PERSONA_ORCHESTRATION_PLAN.md`, all deleted 2026-07-07). Their build history lives in git;
what carries forward is below — the economics that justify the mechanism, the shipped
execution-substrate invariants, the wire-level lessons, and the open items.

### 7.1 The cost thesis — why decomposition, not routing, is the lever

The savings identity: **`reduction ≈ f × (1 − 1/r)`** — `f` is the *boring share* (the
fraction of work that runs on cheap tiers) and `r` the price ratio between the expensive and
cheap tier. A whole-turn risk router does not move `f`; it only picks one tier for a
monolith. **Decomposition raises `f`**: split the task into typed slices, allocate each to
the cheapest tier that clears its need, and only the irreducible-hard core pays the oracle
rate. Risk is thereby demoted from *the decision* to *one feature* in per-slice allocation;
whole-turn risk routing survives only as the degenerate single-slice case. What makes
"default cheap" safe is the per-slice **verification gate** — execute cheap, verify,
escalate only actual failures — which is strictly cheaper than escalating on the *fear* of
failure.

Worked shape (a ~50k-token "migrate auth middleware + propagate to 40 callers" task):
whole-turn risk-veto sends all 50k to the oracle ≈ $0.22; decomposition sends 5k of design
to the oracle and 45k of verified mechanical work to the executor ≈ $0.031 — **~7× cheaper
at the same quality**. The win is entirely the `f ≈ 0.9` boring share.

The frontier gap decomposes into three parts, each with its own closer:

| Gap component | Closer |
|---|---|
| Knowledge (what the code/APIs look like) | retrieval: graph wiring + targeted web into slice briefs |
| Deterministic/coupling errors | the sound verifier ladder + behavior monitoring |
| True reasoning residual (a few % of coding work) | oracle tier; frontier escape-hatch for the last resort |

### 7.2 The allocation matrix (coupling × test-strength)

The evaluator's base allocation (`allocation.ts`) is built on this 2×2, with risk as the
tiebreaker (one cell, >70) — never the primary decision:

| | **testable** | **untestable** |
|---|---|---|
| **low coupling** | executor + verify | reasoner (spec-less mechanical) |
| **high coupling** | executor + graph wiring + verify | oracle + judge rung |

Design slices always floor at the oracle; recon/verify slices ceiling at the conductor. The
operational recipe per slice: inject wiring → dispatch cheap → sound-verify → accept, or
climb the ladder with the reverted diff as advice (§4.3).

### 7.3 Execution substrate — shipped invariants

- **Six executor personas** (Explorer / Runner / Applier / Author / Researcher / Procedure):
  each a real agent definition with its own system prompt *and* its own toolset; none
  carries `task`, `question`, or `todowrite`. Scaling principle: **routines are data,
  personas are code** — a new recurring flow becomes a parameterized brief template, never a
  new persona. Seams: `agent/` definitions, `session/system.ts` `PERSONA_DELTA`.
- **Conductor briefing contract**: every slice brief carries (a) the exact paths/entities
  the conductor already identified, (b) the method when method matters, (c) the report
  format expected back. A brief must prove the conductor understood the work.
- **Delegation is conductor-only, at every depth.** No persona can spawn or ask; the
  permission service backstops the class — in a headless run every would-be ask
  auto-resolves as reject-with-feedback, so no child can ever park on an unanswerable
  question.
- **Session-tier memory policy** — three kinds of memory, only one carries over: the
  conversation is the conductor's running memory (persistent, warm prefix, 84–97% observed
  hit rate); a worker's memory is disposable (fresh session, lean brief in, digest out);
  durable memory lives outside the chat (code graph + anchored notes). Reasoner and oracle
  sessions persist with the `x-session-affinity` gateway header for replica-sticky caching;
  the executor stays stateless with a per-persona constant prefix. Two invariants survive
  every economic argument: **the judge stays stateless** (a verifier that remembers
  endorsing the plan is a correlated verifier), and **compiled-brief discipline survives
  persistence** (a session-long oracle still gets tight deltas, never raw transcript).
- **Web search is a slice-brief ingredient, not a turn phase**: small, targeted, woven into
  the brief of the slice that needs the external fact.

### 7.4 Wire-level lessons (paid for in live-fire runs)

- **AI-SDK option naming**: on the `@ai-sdk/openai-compatible` path, snake_case option keys
  (`reasoning_effort`) are silently clobbered by the SDK's camelCase handling — config must
  use `reasoningEffort`. All four tiers ran with decorative reasoning config for weeks
  before this surfaced. If the native LLM runtime is ever enabled for the gateway provider,
  options must additionally nest under the provider slug (`openai.reasoningEffort`).
- **Hybrid thinkers default to thinking ON server-side.** The conductor is deliberately
  no-think (`reasoningEffort:"none"`, un-muted per-request by the adaptive reasoning gate
  for plan/recovery/contradiction steps only — and never for `small:true` housekeeping
  calls); thinking tiers need a 32k output ceiling so a thought can complete. Measured
  trade-off of the no-think conductor: ~+50% wall clock, +10% cost, in exchange for
  structurally eliminating the mid-think output-truncation failure class and keeping every
  token accountable.
- **Truncation is not completion**: a `finish: "length"` response with zero tool calls is a
  continuation-required condition (bounded nudge, then a visible error) — never a silent
  successful exit.

### 7.5 Carried-forward open items

| Item | Origin | State |
|---|---|---|
| Executor model swap eval (NVIDIA Nemotron 3 vs gpt-oss-120b + verify gate) | OL-M.1 | post-POC, eval-gated |
| Self-host break-even calibration folded into the live receipt | OL-M.3 / #108 | needs monthly-volume input |
| Interim summaries back from long-running children | OL-5.2 | needs bg-job event machinery |
| Canary + rollback rollout discipline | OL-6.3 | post-GA ops |
| Execution-free RM verifier rung: host the judge model, pin its ID in the registry | OL-7.8a / F16 | seam shipped (`ECON_VERIFIER_RM` endpoint config); model unhosted |
| Frontier escape-hatch: stay all-OSS or reach a true frontier model for the residual | OL-7.10 / §9 | open decision; hatch resolver ships, no product env read |
| Everyday-capability eval on test-poor repos: define the harness's case set | OL-7.12 | harness exists, case set thin |
| Gateway region move sin → bom when capacity returns | infra | tracked in feature 08 |
