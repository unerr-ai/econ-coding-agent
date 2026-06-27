# econ — Implementation Plan (Sprints & Tasks)

**Status:** Drafted 2026-06-27. This is the executable breakdown of the architecture in
[ECON_ARCHITECTURE.md](./ECON_ARCHITECTURE.md) onto the base + integration strategy decided
in [DECISION_AND_PLAN.md](./DECISION_AND_PLAN.md). The day-table in DECISION_AND_PLAN is the
spine; this doc expands every feature into sprints, tasks, the integration **zone** each
lands in, the **verified OpenCode seam** it touches, and a **done-when** check.

All seam paths below were verified in our checkout at `./opencode` (recon, 2026-06-27) — they
are real, not assumed.

> **Build discipline (we practise what we preach).** Most tasks are delegated to the cheapest
> sub-agent tier that fits (executor / worker), main thread does design + wiring + root-cause.
> Batch related work, fan out in parallel, review every diff before integrating.

---

## 1. The integration model these sprints assume

Per DECISION_AND_PLAN §"How we use OpenCode", we **fork from a pinned stable base** and split
work across three zones. The zones organize our code; per §1.2 we **diverge** rather than
continuously rebase. Every task is tagged with its zone:

| Zone | Where it lives | Rebase cost | What goes here |
|---|---|---|---|
| **Z1 — Plugin/hook** | OpenCode plugin API (`packages/plugin/src/index.ts`), no source edits | none (rides upstream) | governance gate (`tool.execute.before`), telemetry, custom tools, brain wiring, context injection |
| **Z2 — Inline intelligence** | new packages in the fork, in-process (Bun) | none (our code) | code graph on `bun:sqlite` + WASM tree-sitter (ported from unerr-cli), risk signal, compression, guardrail logic |
| **Z3 — Source fork** | edit OpenCode source at named seams | tracked vs `upstream` | risk-escalation router (`model.ts`), enforcement gaps the plugin ceiling can't reach |

**Verified seams (the only OpenCode files we expect to fork — Z3):**

| Seam | Path | Line |
|---|---|---|
| Model selection (router) | `packages/core/src/session/runner/model.ts` `resolve()` | ~157 |
| Tool settlement gate | `packages/core/src/tool/registry.ts` `settleWith` | ~49 |
| Edit pre-write point | `packages/core/src/tool/edit.ts` `execute` (before `files.writeIfUnchanged`) | ~150–159 |
| Context assembly | `packages/core/src/session/context-epoch.ts` `prepare()` + `runner/llm.ts` | — |
| Usage/cost | `packages/llm/src/schema/events.ts` `Usage` + `runner/publish-llm-event.ts` | 51 / 17 |
| Compaction (extend, don't rebuild) | `packages/core/src/session.ts` `CompactInput`, `SessionHistory.latestCompaction` | 79 / — |
| Plugin hooks (Z1 host) | `packages/plugin/src/index.ts` — `tool.execute.before/after`, `chat.message`, `chat.params`, `permission.ask`, `command.execute.before`, `shell.env` | 222–335 |

> **Recon de-risk (2026-06-27).** OpenCode already ships the orchestration *substrate*:
> sub-agents (the `task` tool spawns child sessions, each able to set its own model), **parallel**
> tool execution (Effect `FiberSet` in `runner/llm.ts`), and an **agent/mode abstraction**
> (`AgentV2.Info` = system prompt + permissions + optional model override). So **conductor /
> oracle / executor are largely agent *configs*, not new loop code** — which sharply de-risks
> S1, S3b and S4. The genuinely new build is our moat (router, governance gate, telemetry) plus
> **one greenfield seam: a context-assemble hook** — prompt assembly is inline in `llm.ts` today
> and no plugin hook reaches it (affects S2.1 / S6.1).

### 1.1 How the pieces interact — and where we touch

Legend: `▓ upstream` (rides `upstream`, untouched) · `①Z1` plugin/hook · `②Z2` inline
intelligence (in-process) · `③Z3` minimal source fork.

```
        ┌────────────────────────────────────────────────────────────┐
        │  ▓ TUI (TypeScript, upstream — unchanged)                    │
        └───────────────────────────┬────────────────────────────────┘
                                     │ HTTP API (unchanged)
        ┌───────────────────────────▼────────────────────────────────┐
        │  OpenCode backend (Bun/TS) — ~70–80% rides upstream as-is    │
        │                                                              │
        │   onPromptSubmit / context-epoch.prepare                     │
        │        └── ①Z1: inject recon bundle + memory ◀────────┐      │
        │   session/runner/llm.ts  (the turn loop — ▓ untouched) │      │
        │   model.resolve()  ══ ③Z3: risk-escalation router ══╗  │      │
        │        (pick conductor / oracle / executor)         ║  │      │
        │   tool/registry.settleWith → tool/edit.ts           ║  │      │
        │        └── ①Z1: governance gate (tool.execute.before)║  │     │
        │            (+③Z3 patch to close the MCP-perm gap)    ║  │      │
        │   publish-llm-event                                  ║  │      │
        │        └── ①Z1: telemetry + real cost / cache        ║  │      │
        │                                                       ║  │     │
        │   ┌─────────────────────────────────────────────┐   ║  │      │
        │   │ ②Z2: inline intelligence (SAME process)      │───╫──┘ in-  │
        │   │  code graph (bun:sqlite) · WASM tree-sitter  │   ║   proc  │
        │   │  risk signal · compression · guardrail logic │───╫──▶ call │
        │   │  (ported from unerr-cli — no native addons)  │   ║  (0 AI, │
        │   └─────────────────────────────────────────────┘   ║   <5ms) │
        └──────────────────────────────────────────────────────╫───────┘
                                                                ║ pick tier
                                            ┌───────────────────▼──────────┐
                                            │  MODEL ENDPOINTS (OSS, in-region)
                                            │  conductor(mid) · oracle(large,
                                            │  brief-fed) · executor(small)×N
                                            └──────────────────────────────┘
```

**Reading it:** the TUI, the HTTP API, and the turn loop are **upstream and untouched** — we
ride OpenCode's updates for the boring mass. Our changes clip onto five named points: four are
**①Z1 plugin hooks** (inject context, enforce the gate, emit telemetry) that survive rebases
with zero tax, and one is the **③Z3 fork** at `model.resolve()` for the risk router. The
**②Z2 inline intelligence** runs **inside the same Bun process** (no sidecar, no UDS) — the
code graph on `bun:sqlite` + WASM tree-sitter, ported from unerr-cli — and feeds both the
router (the risk score) and the context injector (slices + memory) via direct in-process
calls, sub-5ms, zero AI. The router then picks the tier: conductor by default, oracle only on
a compiled brief, executors fanned out (per the `dec p:` topology — sticky mid tier keeps the
KV cache warm; the oracle's small token share is what the savings identity turns on).

### 1.2 How the system moves forward with our changes

**Chosen path: adopt a pinned stable OpenCode, merge our engine in, then diverge — "make it
ours."** We pin a known-good upstream commit, build our moat into it, and proceed on our own
tangent. We do *not* sign up for continuous rebasing.

```
  upstream OpenCode ──pin a stable commit──▶ FORK ("ours") ──▶ our own tangent ─▶ …
        │                                       │
        │  ▓ boring mass inherited at fork      │ + our engine merged in
        │  (shell · server · tools · providers) │   (router · gate · brain · ctx hook)
        │                                       │
        └── `upstream` kept as a remote ────────┘  optional cherry-pick, NOT a rebase treadmill
```

The trade we accept deliberately: once we diverge, we **forfeit upstream's future
agent-feature improvements** (and the agent loop is OpenCode's fastest-moving area). The cheap
hedge that keeps optionality: pin the fork commit, keep the `upstream` remote, and keep our
changes **legible** — the inline intelligence lives in its own packages behind a
`CodeIntelligence` interface (Z2), and source edits are isolated and commented — so we can
hand-pick a specific upstream win later *if* it's worth it, without
owing a continuous merge. With divergence chosen, the three-zone split now serves **code
cleanliness and testability**, not rebase-avoidance.

---

## 2. Legend

- **Zone**: Z1 / Z2 / Z3 (above).
- **Tier**: which build sub-agent does it — `junior` (mechanical/recon), `worker` (refactor/tests/scaffold), `main` (design/wiring/root-cause).
- Tasks reference **ECON_ARCHITECTURE §** for the feature spec, and DECISION_AND_PLAN for the rationale.

---

## 3. Sprint plan

Sprints are ~1 week. S0–S3 are the critical path to a working cheap+oracle agent; S4–S8 add
the team, long-horizon, safety, proof, and hosting. Dependencies noted per sprint.

### Sprint 0 — Foundations & day-0 de-risk gates
**Goal:** OpenCode runs on an OSS model, the inline graph store answers in-process, cache
numbers are trustworthy, and we have *proven* a plugin can enforce at the edit boundary.
Nothing else is safe to build until these hold.

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S0.1 | Build & run OpenCode locally; point one tier at an OSS OpenAI-compatible endpoint (vLLM / OpenRouter) via `model.resolve` config | Z1 | junior | OpenCode answers a prompt on an OSS model |
| S0.2 | Scaffold the **inline intelligence package**: `bun:sqlite` graph store + WASM tree-sitter parse spike (lift unerr-cli's `tree-sitter-loader` + a minimal `ast-extractor` path); index a toy repo | Z2 | main | a graph query returns in-process from `bun:sqlite` (no native addons) |
| S0.3 | **DAY-0 GATE:** verify `cache.read`/`cache.write` are actually reported on our provider path; fix cost accounting (cost must be computed, not 0) | Z1 | worker | a turn reports correct cache read/write + non-zero cost |
| S0.4 | **Plugin enforcement spike:** a `tool.execute.before` plugin that blocks a test edit by throwing | Z1 | worker | the edit is refused; model sees the error |
| S0.5 | Scope the MCP-permission bypass (opencode #2748) — decide if a Z3 patch is needed for full gate coverage of tool paths we route through | Z3? | main | written go/no-go on a source patch for S6.3 |
| S0.6 | Fork hygiene: **pin the stable upstream commit**, keep `upstream` as a remote for *optional* cherry-picks (not continuous rebase), keep source edits isolated + commented | Z3 | junior | fork point pinned; `upstream` remote present; change-legibility convention written |
| S0.7 | Define the **`CodeIntelligence` interface** (graph queries, risk signal, recon, compression) as the port boundary — the inline `bun:sqlite` impl satisfies it now; the full unerr runtime can implement it later | Z2 | main | callers depend on the interface, not the impl |

**Exit:** econ runs on an OSS model; the inline `bun:sqlite` graph answers in-process; cache verified; a plugin blocks an edit.

---

### Sprint 1 — Comparable core: the conductor loop  *(ARCH Phase 1, §3)*
**Goal:** a plan→edit→verify loop on OSS models with a single capable tier (the conductor).
**Depends on:** S0.

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S1.1 | Wire the **conductor** tier (mid, non-thinking ~30B) as the default reasoner via `model.resolve` | Z3 | main | every turn defaults to the conductor |
| S1.2 | Make the inline graph tools the loop's **primary** tools (recon bundle, file_read, get_references) as custom tools, backed by the `bun:sqlite` graph | Z1+Z2 | worker | the agent edits a repo via graph tools, not blind file reads |
| S1.3 | **Canonical state outside the window** (§3): ledger / scratchpad / attempt-history persisted in engine + brain, conductor window is a refilled cache | Z3 | main | state survives a simulated compaction/restart |
| S1.4 | Eval harness to pin conductor/executor/oracle candidates by eval, not assertion (Qwen3-32B etc.) | — | worker | a scored shortlist per tier |

**Exit:** econ edits a real repo end-to-end on OSS models, on the graph.

---

### Sprint 2 — Context engine: hand over the right slice  *(ARCH Phase 2, §5)*
**Goal:** recon bundle, compression, pruning, optimal reads wired into context assembly.
**Depends on:** S1 (graph tools live).

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S2.0 | **Build the context-assemble hook** (the one greenfield seam): a hook point before prompt assembly in `runner/llm.ts` / `context-epoch.prepare` so memory + recon inject push-based | Z3 | main | a hook fires before the model sees the prompt (S2.1/S6.1 depend on it) |
| S2.1 | Inject the **recon bundle** (slices + callers + conventions + memory) at `context-epoch.prepare` / on-context-assemble | Z1+Z2 | main | a turn starts with the bundle, no read fan-out |
| S2.2 | **Output trimming** of command output + file reads via `tool.execute.after` — lift unerr-cli's `smart-truncate` + `token-estimator` (pure, no addons) | Z1 | worker | long tool output is trimmed to the relevant slice |
| S2.3 | **Web-fetch compression** (DOM-extracted, BM25-ranked, hash-cached) as a tool — lift unerr-cli's `extract` / `passage-split` / `bm25-rank` (pure) | Z2 | worker | a fetch returns ranked markdown at a fraction of raw size |
| S2.4 | **Context pruning** of the conductor window (drop stale tool output / superseded reasoning / integrated results) | Z3 | main | window stays bounded across a long turn |
| S2.5 | **Fidelity gate** (§5): measure each compression/prune step; discard any saving that loses the answer | Z2 | worker | a regression set passes with compression on |
| S2.6 | **Semantic layer** (§5): expose the graph's domain/role (`@sem`) edges so the agent reasons over meaning; maintain annotations on edit | Z2 | worker | reads/recon carry domain/role tags; edits keep them current |

**Exit:** turns run on injected slices; fidelity gate green.

---

### Sprint 3 — Risk-escalation router + oracle  *(ARCH Phase 3, §4; the moat)*
**Goal:** the conductor+oracle spine; escalate on **code-structural risk**, not prompt text.
**Depends on:** S2 (graph signal), S1 (conductor).
Cites: `dec p:` topology (mid 32B default reasoner, large = stateless oracle fed a compiled
brief), `fct p:` savings (reduction ≈ 1 − large-tier token share).

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S3.1 | Compute the **0–100 risk score** inline (blast-radius / fan-in / centrality / cx) from the `bun:sqlite` graph — lift unerr-cli's `signal-scorer` / `edit-impact`; expose on turn context | Z2 | main | every turn carries a risk score |
| S3.2 | Fork `model.resolve` → `routeTurn(riskSignal, state) → tier` with **hysteresis** (e.g. 70/40 bands) | Z3 | main | high-risk escalates, low-risk stays cheap, mid-band doesn't flap |
| S3.3 | **Verifier abstention** signal from the conductor → force escalation | Z3 | worker | an explicit "unsure" escalates |
| S3.4 | **Compiled brief** builder (problem + slices + attempts + question + output shape) — the oracle never sees the raw transcript | Z1+Z2 | main | oracle gets a brief, returns decision/patch |
| S3.5 | **Per-repo triage** go/no-go (`cheapPassRate > 1/costRatio` and signal discriminates); **degrade-open** on missing signal | Z2 | worker | triage forces oracle where cheap won't pay; missing signal → cheap, never crash |
| S3.6 | **Double-pay accounting** (cheap attempt + oracle) into telemetry | Z1 | worker | escalations record both costs |
| S3.7 | **Reasoner mode** (optional, §3): a thinking/distilled mid model for a genuinely hard *step*, else escalate straight to the oracle | Z3 | worker | a hard step can use chain-of-thought without paying it every turn |

**Exit:** a high-risk edit escalates to the oracle with a brief; a low-risk one stays cheap; double-pay logged.

---

### Sprint 4 — Executors & specialist sub-agents  *(ARCH Phase 3b, §3/§8)*
**Goal:** the stateless executor tier + the specialist library → full three-role team.
**Depends on:** S3.

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S4.1 | **Executor** tier (~9B tool-caller), stateless; **tool-call schema validation** before dispatch (`tool.execute.before`) | Z1+Z3 | main | malformed tool calls are caught pre-dispatch |
| S4.2 | **Parallel fan-out** of independent executor tool calls in one wave | Z3 | worker | N independent calls run as one wave |
| S4.3 | **Specialist library** mapped to tiers: recon/lint/docstrings (executor), test-author/refactor/codemod/dep-repair/repro (worker), review (conductor/oracle) | Z1 | worker | each specialist runs in its own context, returns a digest |
| S4.4 | Orchestration rules: **batch-then-fan-out**, never loop the main thread file-by-file | — | main | a multi-file change runs as one codemod/fan-out, not a serial loop |

**Exit:** the three-role team is live; specialists run in parallel.

---

### Sprint 5 — Long-horizon orchestration (MiMo cherry-pick)  *(new workstream)*
**Goal:** survive 100–200 step tasks by grafting MiMo's structured checkpoint onto
OpenCode's existing compaction. (See DECISION_AND_PLAN §"Evaluated: MiMo-Code".)
**Depends on:** S1.3 (canonical state), S4 (subagents for the checkpoint-writer).

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S5.1 | Port MiMo's **checkpoint-writer** behavior — auto context reconstruction at 40/60/80% fill — **on top of** OpenCode's `CompactInput` / `SessionHistory.latestCompaction` | Z3 | main | a long run rebuilds context at thresholds without blowup |
| S5.2 | **Task-tree + decisions summary** persisted (ties to §3 canonical state + §6 memory) | Z2 | worker | task tree survives a session restart |
| S5.3 | **Goal-judge loop** (optional): run-until-condition with a doom-loop gate; reconcile with the retry-loop-breaker (S6.3) | Z3 | main | a goal completes when an independent judge confirms |

**Exit:** a 100+ step task completes without context blowout; checkpoint survives restart.

---

### Sprint 6 — Memory & guardrails  *(ARCH Phase 4, §6/§7)*
**Goal:** anchored memory + the in-loop governance gate (the safety moat).
**Depends on:** S2 (context assembly), S3 (blast-radius signal).

> **Scope note (inline pivot).** The **governance gate (S6.3)** is a priority-now item, built
> inline on the `bun:sqlite` graph. The memory/convention items (S6.1, S6.2, S6.4, S6.5, S6.6)
> are the **deferred unerr-runtime surface** — implement them behind the `CodeIntelligence`
> interface and back them with the optional unerr runtime when it lands; they are **not**
> required for the first shippable agent (the four priorities now are graph, token
> optimization, subagents, guardrails).

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S6.1 | **Anchored memory** inject on prompt-submit + fold into the recon bundle *(deferred → unerr runtime)* | Z1+Z2 | main | relevant notes appear before the agent plans |
| S6.2 | Capture user rules ("remember/always"); **four-moment lifecycle**; sentinel-line **save at turn-stop** (no extra round-trip) *(deferred → unerr runtime)* | Z1 | worker | a stated rule persists and resurfaces next session |
| S6.3 | **In-loop governance gate** at `tool.execute.before` (+ Z3 patch per S0.5 to close the MCP gap): breaking-change, blast-radius, boundary, convention-slip, drift re-anchor, retry-loop-breaker — blast-radius/boundary computed from the inline graph (lift unerr-cli's `boundary-check` + `edit-impact`) | Z1+Z3 | main | a breaking signature edit is blocked / fixes all callers before landing |
| S6.4 | **Convention auto-detection** (pattern holds across repo → enforced) *(deferred → unerr runtime)* | Z2 | worker | a detected convention is surfaced unprompted |
| S6.5 | **Confidence decay** (§6): facts lose confidence over time unless reinforced; stale memory fades *(deferred → unerr runtime)* | Z2 | worker | an unreinforced fact decays out of recall |
| S6.6 | **Cross-session continuity** (§6/§13): timeline + tool-call ledger powering a resume strip *(deferred → unerr runtime)* | Z1+Z2 | worker | a new session resumes where the last left off |

**Exit:** breaking edits are caught at the edit; recalled memory appears; caching not regressed.

---

### Sprint 7 — Observability: the proof surface  *(ARCH Phase 5, §13)*
**Goal:** status line + savings receipt + unified telemetry — "count savings, don't promise".
**Depends on:** S0.3 (cache numbers), S3.6 (double-pay).

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S7.1 | Consume per-message usage → unerr telemetry (`emitSavingsEvent`, event store) | Z1+Z2 | worker | every turn writes a usage event |
| S7.2 | **Status line**: context fill, cache-hit ratio, tier in use | Z1 | worker | live status renders |
| S7.3 | **End-of-turn receipt**: named catches, tier split, cache-hit, $ saved vs frontier baseline (double-pay subtracted) | Z1 | main | receipt shows honest $ saved from real usage |
| S7.4 | **Unified login** (reuse unerr `credentials` / device-flow) — one token = econ + unerr | Z2 | worker | one login authenticates both |

**Exit:** receipt shows tier split + cache-hit + $ saved; one login.

---

### Sprint 8 — Harden, India hosting & ship  *(ARCH Phase 6; DECISION days 6–7)*
**Goal:** in-region inference, "one deployment" packaging, dogfood, GA.
**Depends on:** all prior.

| ID | Task | Zone | Tier | Done-when |
|---|---|---|---|---|
| S8.1 | **In-region inference** endpoints + data residency | Z2 | main | tiers served from in-region infra |
| S8.2 | **Packaging "one deployment"**: `bun build --compile` one backend binary (no sidecar) + the TUI; day-0-verify the tree-sitter `.wasm` grammars bundle into the compiled binary | — | worker | one installer brings up the backend (single process) + TUI |
| S8.3 | Harden: sandbox/permission defaults, model fallback; final fork-hygiene pass (review any optional `upstream` cherry-picks) | Z3 | worker | safe defaults; divergence documented |
| S8.4 | **Dogfood** on a customer repo; polish; GA | — | main | clean run on a real customer repo; shipped |

**Exit:** GA to existing customers.

---

## 4. Cross-cutting standing gates (every sprint)

- **Fork hygiene:** keep Z3 edits to the named seams and isolated/commented; we **diverge from the pinned commit** (no continuous rebase) — `upstream` stays a remote for *optional* cherry-picks only; if a seam grows, reconsider whether it belongs in Z1.
- **Fidelity gate:** any new compression/pruning ships only if it passes the answer-preservation set (§5).
- **Cache honesty:** re-confirm `cache.read`/`cache.write` after any provider change (S0.3 is recurring).
- **Cache-friendly prefix ordering** (§9/§11.2): stable parts first (system → tools → conventions → durable context), volatile last; verify the cache-read hit isn't regressed.
- **Eval-pinned models:** never assert a tier choice; pin by eval (S1.4 is recurring).
- **Delegation:** mechanical/repetitive work → executor/worker sub-agents in parallel; main thread reviews diffs.

---

## 5. Traceability — architecture feature → sprint

| ECON_ARCHITECTURE § — Feature | Sprint |
|---|---|
| §3 Model team (conductor/oracle/executor) | S1 (conductor), S3 (oracle), S4 (executors) |
| §3 Reasoner mode (optional) | S3.7 |
| §4 Risk-escalation router | S3 |
| §5 Context engine (graph, recon, compression, pruning) | S2 |
| §5 Semantic edges / domain (`@sem`) annotations | S2.6 |
| Inline code-intelligence port (unerr-cli → `bun:sqlite`) | S0.2, S0.7, S1.2, S2.2/2.3, S3.1, S6.3 |
| Deferred unerr-runtime surface (memory/conventions/decay/resume) | S6.1/6.2/6.4/6.5/6.6 (behind `CodeIntelligence`) |
| §6 Anchored memory | S6 *(deferred → runtime)* |
| §6 Confidence decay + resume strip | S6.5 / S6.6 *(deferred → runtime)* |
| §7 In-loop governance gate | S6 |
| §8 Specialist sub-agents | S4 |
| §9 Caching (sticky conductor, warm KV) | S1.3 + S3.2 (no tier ping-pong) + S0.3 |
| §9/§11.2 Cache-friendly prefix ordering | standing gate (§4) |
| §11 Execution internals (hooks, round-trips) | realized across S2/S6 via Z1 hooks |
| §11.4 Context-assemble hook (the one greenfield seam) | S2.0 |
| §13 Product surface (status line, receipt) | S7 |
| §14 Market/moat | (positioning — no build task) |
| Long-horizon (MiMo cherry-pick) | S5 |
| §Phasing (1, 2, 3, 3b, 3c, 4, 5, 6) | S1 → S8 |

---

## 6. Critical path & sequencing

```
S0 ─▶ S1 ─▶ S2 ─▶ S3 ─┬─▶ S4 ─▶ S5
                       ├─▶ S6
                       └─▶ S7 ─▶ S8
```

S0→S3 is the spine (a working cheap+oracle agent on the graph). S4 (team), S5 (long-horizon),
S6 (safety), S7 (proof) can parallelize once S3 lands; S8 closes. The two-tier cheap/oracle
loop is shippable after S3 — everything after deepens it.
