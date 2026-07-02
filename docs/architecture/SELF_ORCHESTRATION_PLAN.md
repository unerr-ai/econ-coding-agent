# Self-Orchestrating Agent Loop — Implementation Plan

**Status:** Planning (no code yet — this doc is the plan; do not implement from it until the sprints are approved).
**Owner:** econ core.
**Companion design (visual):** [Desired vs. present orchestration](https://claude.ai/code/artifact/fdb421b9-76a4-4829-a726-a3a20fa98349) — the side-by-side flow this plan closes.
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
(ground → 47 `TaskCreate` → 29 sub-agent spawns → 96 `TaskUpdate`). §4 dissects how.

**The econ differentiator.** Claude Code's loop is *model-driven* (the system prompt tells the model
to plan and delegate). econ adds a second axis Claude Code lacks — a **cost/risk router** that
switches tiers *automatically* on measured code-structural risk. The end state is **both**: a
conductor that orchestrates itself *and* a harness that escalates the hard tail — run on cheap OSS
tiers with the executor self-hosted at $0, every switch metered. Per the prior topology decision:
durable state in code + the unerr brain, a sticky mid tier that keeps the cache warm, and a large
**stateless oracle fed a compiled brief (not the raw transcript)** — targeting an ~80–90% cost cut
versus a frontier-only agent.

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
- **OL-0.3 — Decision record.** Choose **B-into-A adapter** (recommended: least disruption — the
  router becomes a function the live seam calls) vs. **migrate route to Engine B**. Record in this doc
  + [03-risk-router](../features/03-risk-router.md).

Done-when: telemetry live; a written decision on the router seam with a one-page rationale.

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
cost/quality regression on a control set.

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
size is a fraction of the full transcript.

### Sprint OL-3 — Self-switching: bring the router onto the live path

**Goal:** automatic tier switching on the live turn — the econ differentiator — using the OL-0.3 seam.

- **OL-3.1 — Router seam.** Implement the OL-0.3 decision: the live model seam consults the router
  (adapter around `router.ts` / `SessionRunnerModel.resolve`) to pick the turn's tier. Anchor:
  `prompt.ts:673`. Pseudo:
  ```
  tier = router.route(riskSignal(session), state)   # conductor|reasoner|oracle
  model = tierModel(tier) ?? agent.model             # router decides; agent config is the floor
  ```
- **OL-3.2 — Triage turn-0.** First turn of a session biases to the cheap tier unless the prompt is
  heavy. Anchor: `code-intelligence/triage.ts` (`decideTriageTurn`, `isHeavyPrompt`).
- **OL-3.3 — Risk escalation + hysteresis.** Escalate on code-structural risk (blast-radius / fan-in /
  centrality) with the 70/40 bands; sticky mid tier to keep the cache warm. Anchor: `router.ts`
  (`routeTurn`, `RouterState`).
- **OL-3.4 — Reasoner hard-step.** Route a detected hard step to the reasoner. Anchor: `reasoner.ts`.
- **OL-3.5 — Abstention → escalate.** When the cheap tier signals unsure (`[[ABSTAIN]]`/low
  confidence), force an escalation. Anchor: `abstention.ts`.
- **OL-3.6 — Double-pay accounting (live).** Record cheap spend discarded on escalation so the savings
  receipt is *net*, not gross, on real turns. Anchor: `double-pay.ts` + `cost_breakdown`.
- **OL-3.7 — Cache-aware switching.** Preserve prompt-cache alignment across a tier switch (sticky
  bias + shared prefix) so switching does not blow the cache. Anchor: `prompt.ts` `orderToolsForCache`.

Done-when: live turns show triage on turn-0, risk-based escalation with hysteresis, abstention
escalation, and a *net* savings figure; control-set quality holds.

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
keeps its plan intact; cache-hit rate holds across switches.

### Sprint OL-6 — Validation & rollout

- **OL-6.1 — End-to-end loop eval** on real repos: does a cold prompt produce meta-plan → recon →
  list → auto-execute → verify?
- **OL-6.2 — Cost & quality dashboard:** net savings, per-tier share, cache-hit, escalation rate,
  abstention rate — against a frontier-only control.
- **OL-6.3 — Canary + rollback:** ship behind a flag; compare; promote.

Done-when: the loop runs unattended on a real task at target cost/quality; a documented rollback path.

---

## 6. Consolidated task list

| ID | Task | Lever | Depends on |
|---|---|---|---|
| OL-0.1 | Turn-phase telemetry | — | — |
| OL-0.2 | Engine-unification spike | C | OL-0.1 |
| OL-0.3 | Router-seam decision record | C | OL-0.2 |
| OL-1.1 | Meta-plan directive | A | — |
| OL-1.2 | Mandate task list | A | — |
| OL-1.3 | Delegate-by-default | A | — |
| OL-1.4 | Verification gate | A | — |
| OL-1.5 | Loop-adherence eval | A | OL-1.1–1.4 |
| OL-2.1 | Fan-out recon step | B | OL-1.3 |
| OL-2.2 | Compiled brief for oracle | B | OL-0.3 |
| OL-2.3 | Digest-return contract | B | — |
| OL-3.1 | Router seam (live) | C | OL-0.3 |
| OL-3.2 | Triage turn-0 | C | OL-3.1 |
| OL-3.3 | Risk escalation + hysteresis | C | OL-3.1 |
| OL-3.4 | Reasoner hard-step | C | OL-3.1 |
| OL-3.5 | Abstention → escalate | C | OL-3.1 |
| OL-3.6 | Double-pay accounting (live) | C | OL-3.1 |
| OL-3.7 | Cache-aware switching | C | OL-3.3 |
| OL-4.1 | Remove CLI `--agent`/`--model` | D | OL-3.1 |
| OL-4.2 | Remove TUI agent switching | D | OL-3.1 |
| OL-4.3 | Remove app model/agent switching | D | OL-3.1 |
| OL-4.4 | Split switch event | D | OL-4.1–4.3 |
| OL-4.5 | Guardrail test | D | OL-4.1–4.4 |
| OL-5.1 | Briefs not transcripts | B | OL-2.3 |
| OL-5.2 | Summaries back to parent | B | — |
| OL-5.3 | Parent→child cache sharing | B | — |
| OL-5.4 | Long-horizon compaction tuning | B | — |
| OL-6.1 | End-to-end loop eval | — | OL-1..OL-5 |
| OL-6.2 | Cost & quality dashboard | — | OL-6.1 |
| OL-6.3 | Canary + rollback | — | OL-6.2 |

**Sequencing note:** OL-4 (remove manual switching) depends on OL-3.1 landing first — the router must
decide the live model *before* we take the manual override away, or a run has no way to pick a tier.

---

## 7. Open decisions & risks

- **Engine seam (OL-0.3).** Adapter-into-Engine-A is recommended (least disruption), but if Engine B
  is where the product is heading, a route migration may be worth the cost. Decide in OL-0.
- **Prompt vs. hard-code.** The loop should be *prompt-driven* (portable, model-agnostic) with the
  router as the only hard automatic switch. Resist encoding the loop as a rigid state machine — it
  makes the agent brittle and defeats "models switch themselves."
- **Cheap-tier capability.** The loop leans on the cheap tiers doing recon well; if `gpt-oss-20b` /
  `deepseek-v4-flash` under-deliver on grounding, OL-2/OL-3 thresholds need tuning, not more escalation.
- **Removing switching (OL-4) is one-way for users.** Gate behind a dev flag first; confirm the router
  covers the cases a human used to switch for before full removal.
- **Cache churn on switch (OL-3.7).** A tier switch mid-turn can invalidate the prompt cache; sticky
  hysteresis + shared prefix are the mitigation, and must be measured (OL-6.2).

---

## 8. References

- Visual: [Desired vs. present orchestration artifact](https://claude.ai/code/artifact/fdb421b9-76a4-4829-a726-a3a20fa98349)
- [`ECON_ARCHITECTURE.md`](./ECON_ARCHITECTURE.md) — system design narrative
- Feature docs: [03-risk-router](../features/03-risk-router.md), [04-model-team](../features/04-model-team.md), [06-observability](../features/06-observability.md)
- [`AUTO_COMPACTION_AND_CONTEXT.md`](../design/AUTO_COMPACTION_AND_CONTEXT.md) — context/compaction design + verification log
- Claude Code source (reference): `../claude-code-source-code` — `src/constants/prompts.ts`, `src/tools/{TaskCreateTool,AgentTool}`, `src/utils/model/*`
