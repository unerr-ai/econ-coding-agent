# Self-Orchestrating Agent Loop — Implementation Plan

**Status (2026-07-03): Waves 1–4 shipped & live-validated.** The self-orchestrating loop is on the live path — conductor loop (OL-1), live risk-escalation router (OL-3 core), understanding/briefs (OL-2/OL-5), manual-switching removal (OL-4), model/serving + validation (OL-M/OL-6). Five checkpoints green; the binary routes real prompts (light→conductor, heavy→reasoner, **high graph-risk→oracle**) and prints a net savings receipt. **OL-3.3 (graph-risk escalation) now shipped & live** — an in-process `BunSqliteGraph` (no unerrd client needed) scores the prompt's entities and escalates on real blast-radius/fan-in/centrality. Deferred/closed: OL-3.8 (won't-build for POC — the cheap tier has no reasoning-effort support), OL-3.5a (needs N-sample loop), OL-2.2 live wire (unerrd recon client), OL-5.2, OL-M.1 (post-POC), OL-6.3 (post-GA ops). Per-item status in §6. **Next direction (2026-07-03): Sprint OL-7 — cost-optimal decomposition**, the reframe that makes *decomposition* (not whole-turn risk-escalation) the primary cost lever; risk demotes to one per-slice allocation feature. Planned, design-first; see §1 reframe + §5 OL-7.
**Owner:** econ core.
**Companion design (visual):** [Desired vs. present orchestration](https://claude.ai/code/artifact/fdb421b9-76a4-4829-a726-a3a20fa98349) — the side-by-side flow this plan closes.
**Research-validated (2026-07):** benchmarks, pricing, and routing literature reviewed — strategy confirmed on-track; tier/signal/cache refinements folded in (see §8, Sprint OL-M).
**Scope:** Move econ from a single-lead turn to a **self-orchestrating loop** — every prompt is understood, grounded, fanned out to the right tier, turned into a tracked task list, and cleared automatically, with the models **switching themselves** and each switch's context managed.

> This is a standalone *plan* doc. The system-design narrative stays in
> [`ECON_ARCHITECTURE.md`](./ECON_ARCHITECTURE.md) (design-only, no phasing). When a sprint here
> starts, its build substance (paths, seams, done-when) also lands in the owning
> [`docs/features/`](../features/README.md) doc — this plan is the spine that points there.

---

## 1. North star — the loop we are building

One sentence: **the user sends a prompt and the system orchestrates itself** — no human picks the
model, no human decides what to delegate.

The target loop (five stages; this is a real sequence, so the numbering is load-bearing):

1. **Meta-plan.** Before acting, form *what is the user really asking, and how do I approach it*,
   grounded in session history + the codebase.
2. **Understand — fan out recon.** Delegate grounding to cheap read-only tiers (junior / explore)
   and hard reasoning to oracle / reasoner; each **reports a digest back** → richer context, cheaply.
3. **Decide → task list.** With that context, either answer directly or externalise the work as an
   explicit, tracked task list.
4. **Auto-execute, self-switching.** Spawn worker / junior / executor sub-agents per task and clear
   the list automatically. Tiers switch **themselves**; each switch carries only the slice it needs.
5. **Consolidate → verify → respond.** Review returned digests, verify non-trivial work, integrate,
   answer.

This loop is not hypothetical — the Claude Code session that produced this plan ran exactly it
(ground → 47 `TaskCreate` → 29 sub-agent spawns → 96 `TaskUpdate`). §3 dissects how.

**The econ differentiator.** Claude Code's loop is *model-driven* (the system prompt tells the model
to plan and delegate). econ adds a second axis Claude Code lacks — a **cost/risk router** that
switches tiers *automatically* on measured code-structural risk. The end state is **both**: a
conductor that orchestrates itself *and* a harness that escalates the hard tail — run on cheap OSS
tiers with the executor self-hosted at $0, every switch metered. Per the prior topology decision:
durable state in code + the unerr brain, a sticky mid tier that keeps the cache warm, and a large
**stateless oracle fed a compiled brief (not the raw transcript)** — targeting an ~80–90% cost cut
versus a frontier-only agent.

**The primary cost lever is decomposition, not the escalation trigger (reframe, 2026-07-03).**
Waves 1–4 shipped a *whole-turn* risk-escalation router (OL-3): score the turn's blast-radius and
route the monolithic turn to one tier. That is the right MVP and stays for the single-slice (short)
case, but it is a *defensive cascade* — "use the big model only when the cheap one looks dangerous" —
and it does not move the variable the savings model actually rewards. The reduction formula
`reduction ≈ f × (1 − 1/r)` is driven by **f, the boring share** — the fraction of work that runs on
cheap tiers. A whole-turn risk score does not change f; it only picks a tier for a monolith, and on a
long-horizon task it is a blunt instrument (score the whole migration high → everything on the oracle,
savings gone; score it low → the hard core collapses). **What raises f is decomposition:** the
conductor splits the task into typed slices and allocates each to the *cheapest tier that clears that
slice's need*, so the high-volume boring share runs cheap and only the irreducible-hard core runs
expensive. Under this frame, **risk is demoted from *the decision* to *one feature* in per-slice
allocation** (alongside difficulty, reversibility, and context size — which are genuinely distinct: a
one-line hub edit is low-difficulty/high-risk, a self-contained tricky algorithm is
high-difficulty/low-risk). The mechanism that makes "default cheap" safe is the **verification gate**
applied per slice — execute cheap, verify, and escalate *only* the slices that fail — which is
strictly cheaper than pre-emptively escalating on the *fear* of failure. This is where "beat Opus with
just orchestration" is actually won: our oracle (GLM-5.2, ~78% SWE-Verified) is *below* Opus on a
single hard slice, so we cannot beat Opus head-to-head on an irreducible problem — we match it on the
*whole task* by making Opus's advantage (holding the entire hard problem in one context) unnecessary,
via good decomposition + cheap verified boring-share + oracle on the small core. See **Sprint OL-7**.

---

## 2. Current state — grounded in the codebase

The uncomfortable but important truth: **econ has two turn engines, and the sophisticated one is not
the one serving live prompts.**

### 2.1 The two engines

**Engine A — the LIVE path (`SessionPrompt`, `packages/opencode/src/session/prompt.ts`).**
Every `run` / TUI / server prompt is served here — the server route calls `SessionPrompt.prompt`
(`server/routes/instance/httpapi/handlers/session.ts:318`). It resolves the model **directly from the
agent config** at `prompt.ts:673` (`input.model ?? ag.model ?? currentModel`) and runs a multi-step
tool-call loop (`runLoop`, `prompt.ts:1184`). It **never** calls the router.

**Engine B — the BUILT-but-unserved path (core V2 `SessionRunner`, `packages/core/src/session/runner/*`
+ `location-layer.ts`).** This engine resolves its model through `SessionRunnerModel.resolve`
(`runner/model.ts:322`), which applies triage bias + the risk-escalation router. It is fully wired
into *its own* location layer (`location-layer.ts:104`). **But its single runtime caller is
`runner/llm.ts:190`** — i.e. only Engine B calls it. Engine A does not.

**Proof it is not live (two independent methods):**
- *Call graph:* `SessionRunnerModel.resolve` has exactly one caller, `runner/llm.ts:190`; a grep of
  `prompt.ts` / `run.ts` for router/triage entities returns nothing.
- *Runtime:* a temporary `Effect.logInfo("router.resolve", …)` placed inside `resolve` **never fired**
  on a live `run --format json` turn, while the `prompt.ts` request-path log *did* fire. (Diagnostic
  removed after the check.)

Net: **on a live turn today there is no automatic tier escalation.** The conductor's pinned model
serves the whole turn unless a human switches agent.

### 2.2 What exists / partial / absent

| Capability | State | Anchor |
|---|---|---|
| Four tiers: conductor / oracle / reasoner / executor | **exists** | `opencode.json` |
| Custom conductor *delta* prompt — "plan, decide, delegate scoped slices to executor via `task`" | **exists (weak)** | `session/system.ts` `select()`, `TIER_DELTA` |
| Task / sub-agent tool — spawn child session, return a digest | **exists** | `tool/task.ts` |
| TodoWrite task-list tool | **exists (not loop-driven)** | `tool/todo.ts` |
| Recon injection (unerr graph context into the turn) | **partial (plugin fires live)** | `econ-recon-inject` plugin (observed: `injected recon for "code"`) |
| Auto-compaction · output-trim · cache-stable tool prefix | **exists** | `session/compaction.ts`, `message-v2.ts`, `prompt.ts` (`orderToolsForCache`) |
| Per-model cost breakdown | **exists** | `cli/cmd/run.ts` (`cost_breakdown`) — see [06-observability](../features/06-observability.md) |
| Risk router · triage · reasoner · abstention · double-pay | **built, NOT live** | `core/session/runner/model.ts`, `code-intelligence/{router,triage,reasoner,abstention,double-pay}.ts` — Engine B only |
| Compiled brief for the oracle hop | **built, not wired** | `code-intelligence/brief.ts` |
| Meta-plan (understand-first) phase | **absent** | — |
| Mandatory task-list → auto-execute loop | **absent** | — |
| Fan-out recon before acting (parallel junior/explore) | **absent (manual only)** | — |
| Verification gate before reporting "done" | **absent** | — |
| Manual model/agent switching (to be removed) | **exists** | `run.ts` `--agent`/`--model`; `tui/dialog-agent.tsx`; `app/model-variant.ts` |

**Reading of the table:** econ has the *primitives* (tiers, task tool, todo tool, compaction, cost
metering) and a *weak instruction layer* (the conductor delta). It lacks the *orchestration layer*
(meta-plan, mandatory list, fan-out, verify) and its *automatic self-switching* (Engine B's router) is
disconnected from the live path.

---

## 3. How Claude Code drives the loop (from the checked-out source)

Grounded in `../claude-code-source-code` (`src/constants/prompts.ts`, `src/tools/*`,
`src/utils/model/*`, `src/services/*`). The essence: **the loop is self-driving because the model is
told what to do and given the tools to do it — there is no external orchestrator.**

Six mechanisms:

1. **System prompt as the behavioural driver.** The prompt *instructs* the strategy: break work down
   with the task-list tool, delegate to sub-agents when the task matches an agent, read before
   proposing, verify non-trivial work. (`prompts.ts` — planning, parallel-tools, delegation,
   read-before-edit, verification sections.)
2. **Task-list as intent capture.** The task-list tool is a **planning trigger, not a logger** — the
   prompt says create tasks *before* executing, mark `in_progress` before starting, complete as you
   go, add follow-ups discovered mid-flight. (`src/tools/TaskCreateTool/prompt.ts`.)
3. **Sub-agents get a focused brief, not the transcript.** The Agent tool passes a compact
   `description + prompt`; the child runs a fresh loop and returns only a **digest** as the tool
   result. Built-in types include a read-only **plan** agent and an **explore** agent.
   (`src/tools/AgentTool/*`, `built-in/planAgent.ts`, `built-in/exploreAgent.ts`.)
4. **Model tier is flexible but model-chosen.** Sub-agents default to `inherit`; the parent *may*
   pass `model: 'haiku'` for cheap recon — there is **no automatic cost router**. (`src/utils/model/agent.ts`.)
   *This is exactly the seam where econ diverges: econ adds the automatic router.*
5. **Verification gate.** Non-trivial implementation must be independently verified (a
   `verification` sub-agent) *before* reporting completion. (`prompts.ts` verification section.)
6. **Context managed across switches.** Sub-agents share the parent's cached prompt prefix; long
   conversations auto-compact at boundaries; background summaries flow back as digests.
   (`forkedAgent.ts`, `services/compact/*`, `services/AgentSummary/*`.)

**Takeaway for econ:** ~80% of the desired loop is a **prompt + tool-instruction problem**, not new
infrastructure. econ already has the task tool, a todo tool, sub-agent tiers, and compaction. What it
is missing is (a) a conductor prompt that *mandates* the loop, and (b) connecting its *extra* asset —
the automatic router — into the live path.

---

## 4. Strategy — four levers

| Lever | What | Nature |
|---|---|---|
| **A. Conductor loop prompt** | Rewrite the conductor delta to mandate meta-plan → task-list → delegate-by-default → verify | Prompt + eval |
| **B. Understanding & briefs** | A fan-out recon step and a compiled brief for the oracle hop (wire `brief.ts`) | Wiring |
| **C. Self-switching (router live)** | Bring Engine B's router (triage / risk / reasoner / abstention / hysteresis / double-pay) onto the live path | Engine work |
| **D. Remove manual switching** | Strip user-facing model/agent switch UX so switching is orchestration-only | Deletion / gating |

Levers A and D are cheap and high-signal; B and C are the engine work. They are sequenced so each
sprint is shippable and measurable on its own.

---

## 5. Implementation plan — sprints & tasks

Task IDs are `OL-<sprint>.<n>`. Each task carries an anchor and a done-when. Pseudo-code is used only
where an algorithm needs pinning; **no production code in this doc.**

### Sprint OL-0 — Foundation: instrument & decide the engine question

**Goal:** measure the live loop and decide *how* the router reaches the live path (adapter into
Engine A vs. migrate the live route onto Engine B). Nothing user-visible ships.

- **OL-0.1 — Turn-phase telemetry.** Emit structured events for each loop phase (understand / plan /
  delegate / execute / verify) and each tier switch on the *live* path, so adherence and cost are
  measurable before and after. Anchor: `session/prompt.ts` runLoop; reuse the observability sink
  ([06-observability](../features/06-observability.md)).
- **OL-0.2 — Engine-unification spike.** Prototype invoking `SessionRunnerModel.resolve` (or a thin
  adapter around `code-intelligence/router.ts`) from Engine A's model seam (`prompt.ts:673`). Answer:
  can the router decide the live turn's model without adopting the whole V2 runner? Output: a spike
  note, not merged code.
- **OL-0.3 — Decision record. DECIDED (2026-07-03): B-into-A adapter.** Evidence: `routeTurn`
  (`code-intelligence/src/router.ts:154`) and `decideTriageTurn` (`triage.ts:235`) are **pure functions
  with zero live callers**, and the live seam is a single line — `prompt.ts:673`
  (`const model = input.model ?? ag.model ?? currentModel`) inside `createUserMessage`. So the router is
  wired as a thin adapter the live seam calls; Engine B's `SessionRunner` is **not** adopted. The one hard
  part is the risk signal: `computeTurnRisk(graph, entities)` (`risk.ts:217`, async) needs the unerr
  `RiskGraph` + the turn's entity set — at turn-open that entity set comes from the `econ-recon-inject`
  plugin (already resolves *N* entities/prompt). This splits Wave 2 into a **turn-open slice** (triage +
  hysteresis + abstention — no graph dependency; tasks OL-3.1/3.2/3.5) and a **graph-risk follow-on**
  (OL-3.3). Full rationale also in [03-risk-router](../features/03-risk-router.md).

Done-when: telemetry live ✅ (OL-0.1 shipped Wave 1); the router-seam decision is recorded ✅ (this bullet).

### Sprint OL-1 — The conductor loop (prompt + eval)

**Goal:** the conductor *self-orchestrates* by instruction — the biggest win for the least code.

- **OL-1.1 — Meta-plan directive.** Extend the conductor delta (`system.ts` `TIER_DELTA`) so every
  non-trivial turn opens by stating intent + approach grounded in session + code, *before* editing.
- **OL-1.2 — Mandate the task list.** Instruct: for any task of ≥3 steps, create the task list via the
  todo tool *before* execution, mark `in_progress` before starting each, complete as you go. Anchor:
  `tool/todo.ts` (already exists — this is a prompt change, not a new tool).
- **OL-1.3 — Delegate-by-default.** Instruct the conductor to route read-only recon and scoped
  mechanical slices to executor/junior via `task` by default, keeping design / interfaces / wiring /
  root-causing on its own thread — then review and integrate digests.
- **OL-1.4 — Verification gate.** Instruct: non-trivial implementation is independently verified
  (a scoped verify sub-agent: typecheck + targeted tests + lint) before reporting done.
- **OL-1.5 — Loop-adherence eval.** A small eval set scoring whether a turn produced a plan, used the
  list, delegated, and verified. Anchor: `packages/eval`. This guards regressions when the prompt is
  tuned. Pseudo:
  ```
  for case in eval_set:
    trace = run(case.prompt)
    score = weighted(has_meta_plan(trace), used_task_list(trace),
                     delegated_when_expected(trace), verified_nontrivial(trace))
    assert score >= case.threshold
  ```

Done-when: on the eval set, the conductor plans, lists, delegates, and verifies at target rates; no
cost/quality regression on a control set. **✅ Shipped (Wave 1):** the conductor `TIER_DELTA`
mandates recon-first → meta-plan → todowrite → delegate → verify (`system.ts`); loop-adherence eval
lives in `packages/eval` (`loop-*`, 17 tests). Checkpoint OL-1 green.

### Sprint OL-2 — Understanding phase & compiled briefs

**Goal:** make the "understand — fan out recon" stage first-class, and give the oracle a brief instead
of the raw transcript.

- **OL-2.1 — Fan-out recon step.** When the meta-plan needs grounding, the conductor spawns *parallel*
  read-only recon sub-agents (junior / explore), one per independent question, and consolidates their
  digests before planning execution. Primarily prompt-driven (OL-1) + a recon sub-agent type. Anchor:
  `tool/task.ts`, agent defs in `agent/agent.ts`.
- **OL-2.2 — Compiled brief for the oracle hop.** Wire `code-intelligence/brief.ts` so an escalation
  to oracle sends a **compiled brief** (goal + relevant slices + prior findings), not the whole
  session — per the stateless-oracle topology decision. Pseudo:
  ```
  brief = compile(goal, focus_entities, callers, prior_digests, constraints)
  oracle_answer = oracle.run(brief)   # stateless; no transcript
  ```
- **OL-2.3 — Digest-return contract.** Standardise what a sub-agent returns (a bounded digest:
  outcome + anchors + follow-ups), so the parent integrates cheaply. Anchor: `tool/task.ts`
  `renderOutput`.

Done-when: a hard turn shows a recon fan-out + a compiled-brief oracle hop in the trace; oracle input
size is a fraction of the full transcript. **✅ Shipped (Wave 2):** OL-2.1 recon-first is in the
conductor delta; OL-2.3 bounded digest is in `tool/task.ts` `renderOutput`. **◐ Deferred — OL-2.2
live wire:** `brief.ts` (`compileBrief`/`briefFromContext`) is built + unit-tested, but wiring it onto
the live oracle hop is coupled to the missing live unerrd recon client (same blocker as OL-3.3) plus an
oracle-as-child-session refactor; the router currently reassigns the agent in-place over the full
transcript, and injecting a brief *on top of* it would add tokens, not save them. Unblocks with OL-3.3.

### Sprint OL-3 — Self-switching: bring the router onto the live path

**Goal:** automatic tier switching on the live turn — the econ differentiator — using the OL-0.3 seam.

> **Status (2026-07-03): the router is LIVE; Wave 2 core shipped.** A new adapter
> `packages/opencode/src/session/tier-router.ts` (`resolveTier`) is called at the live model seam
> (`prompt.ts` `createUserMessage`) for the top-level turn and reassigns the agent to the escalated
> tier. **Shipped & validated:** OL-3.1 seam + OL-3.2 triage turn-0 + hysteresis + tier→model (live:
> light→conductor `deepseek-v4-flash`, heavy→reasoner `z-ai/glm-5.2 agent:reasoner`); OL-3.5 abstention
> (prior-turn `[[ABSTAIN]]`/`[[UNSURE]]`/low-confidence → force oracle; unit-tested + live-safe);
> OL-3.4 reasoner hard-step (satisfied by the router); OL-3.6 double-pay scaffold + OL-3.7 oracle
> cache-hit-rate now in `cost_breakdown`. **OL-3.3 shipped & live:** the router consumes a real
> `computeTurnRisk` — `probeTurnRisk` (in `tool/graph-tools.ts`) resolves the prompt's identifier
> tokens against the in-process `BunSqliteGraph` and scores blast-radius/fan-in/centrality; risk
> above the oracle band (70) overrides even the turn-0 cheap-bias. No live unerrd `RiskGraph` client
> was needed — the graph the read tools already build in-process satisfies `RiskGraph` structurally.
> **Closed / deferred post-POC** (not faked — see §7): **OL-3.8** reasoning-budget rung — *won't-build
> for the POC:* the rung means "retry the cheap tier at higher effort," but the conductor
> (`deepseek-v4-flash`) declares no reasoning support and provider effort-honoring is unverifiable, so
> the rung would be a harmful no-op (double-pay). Revisit if the cheap tier gains a reasoning-capable
> model (post-OL-M.1). **OL-3.5a** self-consistency QE (needs an N-sample generation loop) stays the
> one genuine future "post-generation evaluate-and-escalate" element.

- **OL-3.1 — Router seam.** Implement the OL-0.3 decision: the live model seam consults the router
  (adapter around `router.ts` / `SessionRunnerModel.resolve`) to pick the turn's tier. Anchor:
  `prompt.ts:673`. Pseudo:
  ```
  tier = router.route(riskSignal(session), state)   # conductor|reasoner|oracle
  model = tierModel(tier) ?? agent.model             # router decides; agent config is the floor
  ```
- **OL-3.2 — Triage turn-0.** First turn of a session biases to the cheap tier unless the prompt is
  heavy. Anchor: `code-intelligence/triage.ts` (`decideTriageTurn`, `isHeavyPrompt`).
- **OL-3.3 — Risk escalation + hysteresis. ✅ SHIPPED & live.** Escalate on code-structural risk
  (blast-radius / fan-in / centrality) with the 70/40 bands; sticky mid tier to keep the cache warm.
  Live wire: `probeTurnRisk` (`tool/graph-tools.ts`) tokenises the prompt → `graph.search` per token →
  union entities (cap 8) → `computeTurnRisk`; bounded 3s index wait, fully defensive (cold/timeout/no-
  match/error → 0). `prompt.ts` passes the score into `resolveTier`, which feeds it to `routeTurn` and
  lets risk > 70 override the turn-0 triage bias. Verified live: `refactor routeTurn…` → oracle·glm-5.2
  (was conductor pre-#103). Anchors: `router.ts` (`routeTurn`, `RouterState`), `session/tier-router.ts`,
  `tool/graph-tools.ts` (`probeTurnRisk`).
- **OL-3.4 — Reasoner hard-step.** Route a detected hard step to the reasoner. Anchor: `reasoner.ts`.
- **OL-3.5 — Abstention → escalate.** When the cheap tier signals unsure (`[[ABSTAIN]]`/low
  confidence), force an escalation. Anchor: `abstention.ts`.
- **OL-3.5a — Quality-estimation (QE) signal.** *(Research-driven, §8·R2.)* Self-reported abstention
  alone misses *silent* quality cliffs — the cheap tier that is confidently wrong. Add a generation-side
  QE check (self-consistency across a couple of samples, or a small confidence estimator) that can veto a
  cheap-tier answer *before* it is accepted, independent of whether the model abstained. This is the one
  element standard in 2026 cascade literature that econ's design lacked. Pseudo:
  ```
  if abstained(out) or qe_low(out):   # qe_low := inconsistent samples / low estimator score
     escalate()
  ```
- **OL-3.8 — Escalate the reasoning budget before the tier. ⛔ WON'T-BUILD (POC).** *(Research-driven,
  §8·R3.)* The intent: retry the cheap tier at a larger reasoning budget before hopping the model. But
  the premise fails on econ's model choice — only `gpt-oss-20b` (the executor) declares reasoning
  support; the conductor (`deepseek-v4-flash`) has no `reasoning: true` / effort options, and whether
  Fireworks honors a per-call effort bump for it is unverifiable. Flipping the conductor to "high effort"
  the provider ignores costs a second conductor call before escalating anyway — a harmful no-op, not a
  saving. Abstention→oracle (OL-3.5) already covers "cheap tier was unsure." Revisit only when the cheap
  tier runs a reasoning-capable model (post-OL-M.1 Nemotron 3).
- **OL-3.6 — Double-pay accounting (live).** Record cheap spend discarded on escalation so the savings
  receipt is *net*, not gross, on real turns. Anchor: `double-pay.ts` + `cost_breakdown`.
- **OL-3.7 — Cache-aware switching + oracle cache leverage.** *(Strengthened, §8·R4.)* Preserve
  prompt-cache alignment across a tier switch (sticky bias + shared prefix). Critically, the oracle
  (GLM-5.2) is expensive at every provider ($1.40/$4.40) but its *cached* read is ~$0.26 (−81%): the
  compiled brief (OL-2.2) must be stable and prefix-shared so oracle hops hit cache. Make oracle
  cache-hit-rate a first-class metric. Anchor: `prompt.ts` `orderToolsForCache`.

Done-when: live turns show triage on turn-0, budget-then-tier escalation, risk-based escalation with
hysteresis, QE/abstention vetoes, and a *net* savings figure; oracle cache-hit-rate is tracked;
control-set quality holds.

### Sprint OL-4 — Remove manual model/agent switching

**Goal:** switching is orchestration-driven only. **Keep** internal delegation (`task` tool) and the
router; **remove/gate** every human switch. (Per the note: never `git stash` in this shared tree while
sub-agents run — do these as ordinary edits.)

- **OL-4.1 — Remove CLI `--agent` / `--model`.** Drop the flags (or hide behind a dev-only
  `ECON_DEV_OVERRIDE`), so a run always starts on the conductor and lets the router decide. Anchor:
  `cli/cmd/run.ts` (`--agent`, `--model` options; `localAgent`/`attachAgent`; `createFreshSession`).
- **OL-4.2 — Remove TUI agent switching.** Remove the agent picker dialog + Tab agent-cycle. Anchor:
  `tui/component/dialog-agent.tsx` and the TUI agent-cycle path.
- **OL-4.3 — Remove app model/agent switching.** Remove the model-variant Tab cycle + agent settings
  selector. Anchor: `app/context/model-variant.ts` (`cycleModelVariant`), `app/context/local.tsx`
  (`cycle`), `app/context/settings.tsx` (`setAgent`).
- **OL-4.4 — Split the switch event.** Separate system-initiated tier switches from user switches;
  keep the system one for telemetry, retire the user one. Anchor: `core/session/message.ts`
  (`AgentSwitched`).
- **OL-4.5 — Guardrail test.** A test asserting no user-facing switch entry point remains and internal
  delegation + router still function.

Done-when: no user path changes the model/agent; delegation + router unaffected; guardrail test green.
**✅ Shipped (Wave 3):** CLI flags gated (`run.ts`/`tui.ts`/`agent.ts` pass `undefined` → router
decides); TUI switch commands + keybinds removed (dialogs kept as dead code); app composer model/agent
pickers removed from both render branches; `AgentSwitched`/`ModelSwitched` carry `source:"system"|"user"`
(router emits `"system"`); source-level guardrail test (6/6). Model-*variant* cycling deliberately kept
(thinking/effort axis ≠ model/agent — that's OL-3.8 territory). Checkpoint OL-4 green.

### Sprint OL-5 — Context management per switch

**Goal:** every switch carries only the slice it needs; long horizons stay coherent.

- **OL-5.1 — Briefs, not transcripts, to sub-agents.** Sub-agents receive a compiled brief (task +
  pointers), never the parent transcript (aligns with CLAUDE.md's "give the task plus a one-line
  pointer"). Anchor: `tool/task.ts`.
- **OL-5.2 — Summaries back to parent.** Long-running sub-agents post periodic short summaries that
  return as digests. Anchor: mirror Claude Code `AgentSummary`.
- **OL-5.3 — Parent→child cache sharing.** Share the static prompt prefix across the spawn so the
  parent→child hop reuses cache. Anchor: `prompt.ts` prefix + `orderToolsForCache`.
- **OL-5.4 — Long-horizon compaction tuning.** Tune compaction/pinning so the plan + execution
  frontier survive pruning across a multi-task run. Anchor: `session/compaction.ts` +
  [AUTO_COMPACTION_AND_CONTEXT](../design/AUTO_COMPACTION_AND_CONTEXT.md).

Done-when: sub-agent input size is bounded and independent of parent length; a long multi-task run
keeps its plan intact; cache-hit rate holds across switches. **✅ Shipped/verified (Wave 2):** OL-5.1
confirmed — `tool/task.ts` spawns a fresh child session with only the task brief, never the parent
transcript; OL-5.3 confirmed — the child reuses the same stable static prefix (rotates daily by design,
date in prompt); OL-5.4 compaction pinning tuned. **◐ Deferred — OL-5.2:** interim summaries need new
background-job event machinery; the single-shot completion digest (OL-2.3) covers the common case.
Checkpoint OL-2+OL-5 green.

### Sprint OL-M — Model & serving optimization *(research-driven, see §8)*

**Goal:** put the *right* model in each tier and serve it at the *right* price. Orthogonal to the loop
mechanics — this is the accuracy/affordability tuning the web research surfaced. Model IDs and pricing
belong to [04-model-team](../features/04-model-team.md) / MODEL_SELECTION; this sprint tracks the changes.

- **OL-M.1 — Swap the executor: gpt-oss-20b → NVIDIA Nemotron 3.** *(§8·R1 — biggest accuracy lever;
  DEFERRED post-POC.)* gpt-oss-20b (~60.7% SWE-Verified) is the weakest tier. The intended executor
  target is **NVIDIA Nemotron 3** (self-hostable, decision updated 2026-07-03 — supersedes the earlier
  Qwen3-Coder-30B research suggestion). **Not in the POC scope:** for the POC we keep gpt-oss-20b as the
  executor and lean on the verification gate (OL-1.4). Trial Nemotron 3 behind an eval when the POC is
  past; keep gpt-oss-20b only if the gate fully absorbs its lower first-pass accuracy at lower cost.
- **OL-M.2 — Provider/serving arbitrage.** *(§8·R5.)* Evaluate DeepInfra for the conductor
  (DeepSeek-V4-Flash ~$0.10/$0.20, −29% vs the current Fireworks BYOK $0.14/$0.28) and Together for a
  managed executor floor (gpt-oss-20b ~$0.05/$0.20) — weighed against BYOK billing, latency, reliability,
  and data-residency. This revisits the Fireworks-BYOK premise in `opencode.json`; record the trade in
  [04-model-team](../features/04-model-team.md).
- **OL-M.3 — Model the self-host break-even, don't assume $0.** *(§8·R6.)* "$0 executor" holds only above
  ~50–100M tok/mo on an amortized GPU (~$0.001–0.003/M at moderate volume); below that, a managed
  $0.05/$0.20 is cheaper than an idle card. Encode a break-even curve into the cost model + savings
  receipt so the executor line reflects real marginal cost, not an aspirational zero.
- **OL-M.4 — Oracle cache-leverage validation.** *(§8·R4, pairs with OL-3.7.)* Confirm real oracle
  request patterns hit the GLM-5.2 cache (compiled brief stable + prefix-shared); the −81% cached-read is
  the main lever on the one tier whose per-token price cannot be shopped down.

Done-when: an eval decides the executor model; a provider/serving cost comparison is recorded; the
savings receipt uses a real (not assumed-zero) executor cost; oracle cache-hit-rate is measured.
**✅ Shipped (Wave 4):** OL-M.2 provider arbitrage recorded in [04-model-team](../features/04-model-team.md);
OL-M.3 break-even cost model (`econ-cost.ts` `executorEffectiveCost`/`EXECUTOR_BREAK_EVEN_DEFAULTS`);
OL-M.4 cache accounting validated end-to-end (live oracle turn showed a real `cacheHitRate`, no gap).
**◐ Deferred — OL-M.1:** executor stays gpt-oss-20b for the POC; NVIDIA Nemotron 3 is the post-POC
target, gated behind an eval. Open follow-up #108: calibrate the break-even fixed GPU cost + fold
`executorEffectiveCost` into the run.ts receipt (needs a monthly-volume input).

### Sprint OL-6 — Validation & rollout

- **OL-6.1 — End-to-end loop eval** on real repos: does a cold prompt produce meta-plan → recon →
  list → auto-execute → verify?
- **OL-6.2 — Cost & quality dashboard:** net savings, per-tier share, cache-hit, escalation rate,
  abstention rate — against a frontier-only control.
- **OL-6.3 — Canary + rollback:** ship behind a flag; compare; promote.

Done-when: the loop runs unattended on a real task at target cost/quality; a documented rollback path.
**✅ Shipped (Wave 4):** OL-6.1 live loop-eval runner (`runLoopEvalLive` + `binaryTraceSource` maps the
binary's NDJSON stream to a scored `LoopTrace`; opt-in `loop-live` script); OL-6.2 net-savings receipt
wired into the CLI human-readable output (`buildReceipt`/`formatReceipt` — tier split, reduction %,
NET SAVED vs frontier baseline; JSON `cost_breakdown` event left stable). **◐ Deferred — OL-6.3:**
canary/rollback is post-GA deployment ops; the router already fails safe (in-memory hysteresis resets
to the cheap conductor on restart). Checkpoint OL-M+OL-6 green. Open follow-up #110: the receipt labels
a reasoner turn `oracle` because both tiers pin `glm-5.2` (savings math correct; label imprecise —
needs the authoritative agent name threaded through, not `inferTier(model)`).

### Sprint OL-7 — Cost-optimal decomposition *(the north-star lever — PLANNED, not yet built)*

> **Detailed engineering plan:** [`DECOMPOSITION_ORCHESTRATION_PLAN.md`](./DECOMPOSITION_ORCHESTRATION_PLAN.md)
> — the full research basis (F1–F8), target-loop diagram, allocation function, per-slice execute-verify-escalate,
> code seams, metrics, and phased tasks (A–D). This sprint is the summary spine; that doc is its expansion.

**Goal:** move the primary cost lever from *whole-turn risk-escalation* to *conductor-led task
decomposition + per-slice tier allocation*. Risk demotes to one allocation feature; **decomposition
raises f (the boring share)**, which is what `reduction ≈ f × (1 − 1/r)` rewards. This is the fuller
form of Phase 2 (was "conductor-led escalation — escalate the hard hop"): the conductor doesn't just
escalate one hop, it *splits the whole task and prices every slice*. OL-3 (whole-turn risk routing) is
retained as the **degenerate single-slice case** — a short turn isn't decomposed, it's just routed.

- **OL-7.1 — Typed decomposition.** Extend the conductor meta-plan (OL-1.1/1.2, already live) so a
  complex task is decomposed into a **DAG of typed slices** — `design | mechanical | recon | verify` —
  each carrying its capability need. The task-list tool already externalises the plan; the addition is
  *typing* each slice + its need. Prompt-driven. Anchor: `session/system.ts` `TIER_DELTA`, `tool/todo.ts`.
- **OL-7.2 — Per-slice tier allocation.** Allocate each slice to the **cheapest tier that clears its
  need**, not one tier for the whole turn. Allocation features: slice type, difficulty,
  code-structural risk (reuse `computeTurnRisk` *per slice*), reversibility, context size vs the tier's
  `contextWindow` (from the model registry). Reuse `router.ts` as a **per-slice tier picker** instead of
  a whole-turn decision. Anchor: `code-intelligence/router.ts`, `session/tier-router.ts`, `tool/task.ts`.
- **OL-7.3 — Execute-cheap-then-verify per slice.** Run each slice on its allocated (default cheap)
  tier and gate with the verification step (OL-1.4); **escalate only slices that fail verification or
  are flagged irreducible-hard.** This replaces pre-emptive whole-turn escalation with pay-for-what-
  actually-needed-it. Anchor: `tool/task.ts` spawn + the OL-1.4 verify sub-agent; the OL-2.2 compiled
  brief feeds the escalated design slice.
- **OL-7.4 — Decomposition-quality eval.** Extend the loop-adherence eval (OL-1.5) to score the
  *decomposition itself*: did it split correctly (no missed dependency, no over-fragmentation), was f
  maximised, did per-slice allocation match need, did verification catch cheap-tier errors. A bad split
  costs more than a cheap monolith, so this guards the highest-leverage decision. Anchor: `packages/eval`.
- **OL-7.5 — Adaptive plan-time reasoning.** Gate the conductor's reasoning (deepseek-v4-flash is a
  **hybrid model** — thinking is a toggle, not a model swap) to the **decomposition step on complex
  tasks** — the single highest-leverage decision, and the one place reasoning pays for itself. This is
  econ's version of Opus's *adaptive thinking* (Opus does **not** reason every turn — it decides
  dynamically). Off/low on routine turns, high when decomposing a hard/long task; driven by the same
  complexity/risk signal. Resolves the "should the conductor reason" question. Anchor: `tier-router.ts`
  risk probe → per-turn `reasoning.effort` on the conductor model.

**Worked example — "migrate the auth middleware to add token refresh, propagate to all callers"**
(directional; illustrates *where cost concentrates*, using the registry's tier rates — treat numbers
as directional per §8). Say the task is ~50k output tokens of work:

| Slice | Share | Tier (need) | Rate (out $/1M) |
|---|---|---|---|
| Design the new refresh interface | ~10% (5k) | **oracle** glm-5.2 (irreducible design) | $4.40 |
| Propagate signature to ~40 callers | ~80% (40k) | **executor** gpt-oss-20b (mechanical, verified) | ~$0.20 |
| Recon (find call sites) + final verify | ~10% (5k) | **junior/executor** | ~$0.20 |

- **Risk-veto (today):** the turn touches the auth hub → risk > 70 → the *whole* 50k runs on the
  oracle → 50k × $4.40/1M ≈ **$0.22**.
- **Decompose (OL-7):** 5k oracle + 45k cheap → 5k × $4.40/1M + 45k × $0.20/1M ≈ $0.022 + $0.009 ≈
  **$0.031** — **~7× cheaper at the same quality** (the design still gets the oracle; the mechanical
  bulk is cheap *and* verified). The win is entirely the **f ≈ 0.9 boring share**, which whole-turn
  risk-routing cannot produce.

Done-when: a long-horizon task shows a *typed* decomposition in the trace, per-slice tier allocation
(most slices cheap), execute-cheap-then-verify with escalation only on failed/hard slices, and a *net*
savings figure materially better than the risk-veto baseline on the same task; the decomposition eval
holds on a control set. **Status: PLANNED** — supersedes/absorbs the earlier Phase-2 "escalate the
hard hop" framing (#115). Validate design-first (worked example above) before build.

---

## 6. Consolidated task list

Status legend: ✅ shipped · ◐ deferred (with a concrete blocker — see the sprint's done-when + §7).

| ID | Task | Lever | Depends on | Status |
|---|---|---|---|---|
| OL-0.1 | Turn-phase telemetry | — | — | ✅ |
| OL-0.2 | Engine-unification spike | C | OL-0.1 | ✅ |
| OL-0.3 | Router-seam decision record | C | OL-0.2 | ✅ B-into-A |
| OL-1.1 | Meta-plan directive | A | — | ✅ |
| OL-1.2 | Mandate task list | A | — | ✅ |
| OL-1.3 | Delegate-by-default | A | — | ✅ |
| OL-1.4 | Verification gate | A | — | ✅ |
| OL-1.5 | Loop-adherence eval | A | OL-1.1–1.4 | ✅ |
| OL-2.1 | Fan-out recon step | B | OL-1.3 | ✅ |
| OL-2.2 | Compiled brief for oracle | B | OL-0.3 | ◐ assembler done; live wire → OL-3.3 |
| OL-2.3 | Digest-return contract | B | — | ✅ |
| OL-3.1 | Router seam (live) | C | OL-0.3 | ✅ live |
| OL-3.2 | Triage turn-0 | C | OL-3.1 | ✅ |
| OL-3.3 | Risk escalation + hysteresis | C | OL-3.1 | ◐ needs live unerrd RiskGraph client |
| OL-3.4 | Reasoner hard-step | C | OL-3.1 | ✅ |
| OL-3.5 | Abstention → escalate | C | OL-3.1 | ✅ |
| OL-3.5a | Quality-estimation (QE) veto | C | OL-3.5 | ◐ needs N-sample loop |
| OL-3.6 | Double-pay accounting (live) | C | OL-3.1 | ✅ scaffold (discarded=0 today) |
| OL-3.7 | Cache-aware switching + oracle cache leverage | C | OL-3.3 | ✅ cache-hit metric live |
| OL-3.8 | Escalate reasoning budget before tier | C | OL-3.1 | ◐ needs per-call effort override |
| OL-4.1 | Remove CLI `--agent`/`--model` | D | OL-3.1 | ✅ |
| OL-4.2 | Remove TUI agent switching | D | OL-3.1 | ✅ |
| OL-4.3 | Remove app model/agent switching | D | OL-3.1 | ✅ |
| OL-4.4 | Split switch event | D | OL-4.1–4.3 | ✅ `source` system/user |
| OL-4.5 | Guardrail test | D | OL-4.1–4.4 | ✅ 6/6 |
| OL-5.1 | Briefs not transcripts | B | OL-2.3 | ✅ verified |
| OL-5.2 | Summaries back to parent | B | — | ◐ needs bg-job event machinery |
| OL-5.3 | Parent→child cache sharing | B | — | ✅ verified |
| OL-5.4 | Long-horizon compaction tuning | B | — | ✅ |
| OL-M.1 | Swap executor → NVIDIA Nemotron 3 (eval) | — | OL-1.4 | ◐ post-POC |
| OL-M.2 | Provider/serving arbitrage | — | — | ✅ recorded |
| OL-M.3 | Self-host break-even cost model | — | OL-3.6 | ✅ (calibration → #108) |
| OL-M.4 | Oracle cache-leverage validation | — | OL-3.7 | ✅ validated live |
| OL-6.1 | End-to-end loop eval | — | OL-1..OL-M | ✅ live runner |
| OL-6.2 | Cost & quality dashboard | — | OL-6.1 | ✅ savings receipt (label → #110) |
| OL-6.3 | Canary + rollback | — | OL-6.2 | ◐ post-GA ops |
| OL-7.1 | Typed decomposition (DAG of typed slices) | A | OL-1.2 | ☐ planned |
| OL-7.2 | Per-slice tier allocation (risk = 1 feature) | C | OL-7.1, OL-3.3 | ☐ planned |
| OL-7.3 | Execute-cheap-then-verify per slice | A/C | OL-7.2, OL-1.4 | ☐ planned |
| OL-7.4 | Decomposition-quality eval | A | OL-7.1–7.3 | ☐ planned |
| OL-7.5 | Adaptive plan-time reasoning (conductor hybrid think) | C | OL-7.1 | ☐ planned |

**Sequencing note:** OL-4 (remove manual switching) depends on OL-3.1 landing first — the router must
decide the live model *before* we take the manual override away, or a run has no way to pick a tier.

---

## 7. Open decisions & risks

- **Engine seam (OL-0.3).** Adapter-into-Engine-A is recommended (least disruption), but if Engine B
  is where the product is heading, a route migration may be worth the cost. Decide in OL-0.
- **Prompt vs. hard-code.** The loop should be *prompt-driven* (portable, model-agnostic) with the
  router as the only hard automatic switch. Resist encoding the loop as a rigid state machine — it
  makes the agent brittle and defeats "models switch themselves."
- **Risk-veto vs. decomposition as the primary lever (OL-7).** Whole-turn risk-escalation (OL-3) is a
  *defensive cascade* that does not raise f and is blunt on long-horizon tasks; the cost lever is the
  conductor's *decomposition* (split → per-slice allocation → execute-cheap-then-verify), with risk
  demoted to one allocation feature. Retain OL-3 for the single-slice/short-turn case. **Risk of the
  reframe:** decomposition has overhead and a real failure mode — a wrong split (missed dependency /
  over-fragmentation) costs more than a cheap monolith, so the planner must be good (hence OL-7.5
  plan-time reasoning) and the decomposition eval (OL-7.4) is load-bearing. **Verification becomes
  load-bearing, not optional** — "default cheap, escalate failures" only works if the gate reliably
  catches silent-wrong cheap-tier output, which raises the priority of the QE veto (OL-3.5a, currently
  deferred). Validate design-first (the OL-7 worked example) before committing build effort.
- **Cheap-tier capability (updated by research).** The loop leans on cheap tiers doing recon/chores
  well. The web scan flags **gpt-oss-20b as the weak link** (~60.7% SWE-Verified) — hence OL-M.1 (swap to
  NVIDIA Nemotron 3, *deferred post-POC*) and the QE veto (OL-3.5a). `deepseek-v4-flash` as conductor is
  validated (~79%). **For the POC we keep gpt-oss-20b** and lean on the verification gate.
- **Executor: swap vs. verify (OL-M.1).** Post-POC, decide whether to raise executor accuracy (NVIDIA
  Nemotron 3) or keep gpt-oss-20b cheap and lean on the verification gate (OL-1.4). An eval settles it —
  don't decide by intuition. Deferred out of POC scope.
- **QE is a new dependency (OL-3.5a).** A quality estimator/self-consistency check adds latency and, if a
  learned classifier, a training/maintenance burden. Start with cheap self-consistency before a trained QE.
- **Provider arbitrage vs. BYOK premise (OL-M.2).** DeepInfra (−29% conductor) and Together (managed
  executor floor) undercut the current Fireworks-BYOK path; changing providers touches the
  `opencode.json` architecture decision and data-residency posture. Weigh, don't reflexively switch.
- **Removing switching (OL-4) is one-way for users.** Gate behind a dev flag first; confirm the router
  covers the cases a human used to switch for before full removal. (Research supports the direction:
  frontier agents ship *manual* pickers precisely because they lack an auto-router — econ's OL-3 is what
  makes removal safe.)
- **Cache churn on switch (OL-3.7/OL-M.4).** A tier switch mid-turn can invalidate the prompt cache;
  sticky hysteresis + shared prefix are the mitigation, and must be measured (OL-6.2). The oracle's
  −81% cached-read is the single biggest lever on its otherwise un-shoppable price.

---

## 8. Research validation & refinements (web scan, 2026-07)

Three parallel web-research passes (coding/reasoning benchmarks · pricing & serving economics · routing
literature) checked whether econ optimizes **accuracy, reasoning, and cost** together. *Exact benchmark
numbers come from mixed-quality 2026 aggregators — treat them as directional.*

**Headline: on the right track, and on automatic routing, ahead of the frontier agents.** The tuning
that remains is in the tier picks, the escalation signal, and cache leverage.

### 8.1 What the research confirms

- **Cheap-default + escalate-the-hard-tail is the consensus and is well-grounded.** FrugalGPT (~98% cost
  cut at matched quality), RouteLLM (~85% at ~95% quality), RouteNLP (40–85%) all support the ~80–90%
  target — consistent with the recalled topology decision (~80–90% cut vs. a frontier-only agent).
- **Difficulty/confidence routing beats task-class routing.** econ correctly routes on difficulty/risk,
  not task type — the literature calls task-class routing an anti-pattern by comparison.
- **Routing on code-structural risk (blast-radius / fan-in / centrality) is novel.** No direct academic
  precedent; validated by production graph systems. An original econ contribution — protect it.
- **Frontier coding agents (Claude Code, Cursor, Copilot) do NOT auto-route** — they ship manual model
  pickers. econ's OL-3 automatic router is a genuine moat, and it makes OL-4 (removing the picker) the
  correct contrarian bet rather than a regression.
- **Oracle = GLM-5.2 is the right pick** — top open-weight coder (~78% SWE-Verified, ~62% Pro) at ~1/6
  closed-frontier cost; expensive but capability-justified, and no cheaper equal exists.
- **Conductor = DeepSeek-V4-Flash is validated** — ~79% SWE-Verified at $0.14/$0.28, a 13B-active MoE that
  serves at ~32B-class cost. This *reconciles* the topology note's "mid ~32B default": the spirit — a
  cheap, cache-warm, capable mid tier — is met (and bettered) by V4-Flash, cheaper on output and more
  accurate than a dense 32B, so no change to the conductor.

### 8.2 Refinements the research demands

| # | Refinement | Evidence | Task |
|---|---|---|---|
| R1 | Swap executor gpt-oss-20b → NVIDIA Nemotron 3 *(deferred post-POC)* | gpt-oss-20b ~60.7% SWE-Verified is the weak tier; Nemotron 3 self-hostable | OL-M.1 |
| R2 | Add a quality-estimation (QE) veto | Self-reported abstention misses silent quality cliffs; QE is standard in 2026 cascade SOTA | OL-3.5a |
| R3 | Escalate reasoning budget before tier | SelfBudgeter/BudgetThinker — a cheaper intermediate rung; we already control reasoning effort | OL-3.8 |
| R4 | Lever prompt caching on the oracle | GLM-5.2 cached-read ~$0.26 (−81%); the only lever on its un-shoppable price | OL-3.7, OL-M.4 |
| R5 | Provider/serving arbitrage | DeepInfra V4-Flash ~$0.10/$0.20 (−29%); Together gpt-oss-20b ~$0.05/$0.20 | OL-M.2 |
| R6 | Model the self-host break-even | "$0 executor" holds only >~50–100M tok/mo; below that managed is cheaper | OL-M.3 |

### 8.3 What did *not* need changing

The routing mechanics econ already planned — **hysteresis, abstention, double-pay accounting** — match
active research exactly. The oracle tier and the **compiled-brief / stateless-oracle** topology are
confirmed cost-optimal given GLM-5.2's price floor. Keep all of these.

### 8.4 Key sources

- Cascades/cost: FrugalGPT (arXiv 2305.05176); RouteLLM (ICLR 2025); "Cluster, Route, Escalate" (2026).
- Difficulty routing / QE: "Confident or Seek Stronger" (arXiv 2502.04428); zero-shot confidence work.
- Adaptive budget: SelfBudgeter (2505.11274); BudgetThinker (2508.17196); Token-Budget-Aware Reasoning.
- Benchmarks: SWE-bench Verified/Pro leaderboards, Artificial Analysis, OpenRouter open-weight roundups.
- Pricing: OpenRouter / DeepInfra / Together / Novita model pages; self-host economics (Spheron, DevForth).

---

## 9. References

- Visual: [Desired vs. present orchestration artifact](https://claude.ai/code/artifact/fdb421b9-76a4-4829-a726-a3a20fa98349)
- [`ECON_ARCHITECTURE.md`](./ECON_ARCHITECTURE.md) — system design narrative
- Feature docs: [03-risk-router](../features/03-risk-router.md), [04-model-team](../features/04-model-team.md), [06-observability](../features/06-observability.md)
- [`AUTO_COMPACTION_AND_CONTEXT.md`](../design/AUTO_COMPACTION_AND_CONTEXT.md) — context/compaction design + verification log
- Claude Code source (reference): `../claude-code-source-code` — `src/constants/prompts.ts`, `src/tools/{TaskCreateTool,AgentTool}`, `src/utils/model/*`
