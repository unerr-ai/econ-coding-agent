# econ — Architecture Decision & Build Plan

**Status:** Updated 2026-06-23. We have a **proven MVP** (`unerr-gov-agent`, qwen-code
lineage) — the cost-routing engine + in-loop governance + unerr-brain integration all
work. This phase builds the **professional version**: adopt a best-in-class open-source
**TUI/CLI shell** and transplant the proven engine onto it. Built with coding agents,
for existing customers.

---

## Decision (one line)

**Base on [OpenCode](https://github.com/anomalyco/opencode) (TypeScript, MIT). Transplant
our proven engine — the risk-escalation router and the in-loop governance gate — into
OpenCode's TypeScript backend, keep its polished TypeScript TUI, and build the
code-intelligence **inline**: a code graph on `bun:sqlite` + WASM tree-sitter, ported from
unerr-cli (lift the WASM parser, the AST extractor, and the pure token/guardrail/risk
modules; rewrite the store's Datalog queries as SQL recursive CTEs). No separate brain
process, no UDS hop, no native addons.** We do **not** rebuild the shell (OpenCode nailed it)
and we do **not** rebuild the router/gate (the MVP proved them); we **do** port the graph
store onto Bun-native primitives so the whole engine runs in one process. The richer unerr
runtime (anchored memory, conventions, drift, federation) stays available **later**, behind a
`CodeIntelligence` interface — not in the first build.

OpenCode is now checked out at [`./opencode`](../../opencode) — we take it over and modify
it directly.

### Why OpenCode (and not the prettier / faster alternatives)

The deciding axis is **grafting a working TypeScript engine onto a nailed UI** — so the
right base is the one whose UI is most cleanly separable from its engine, in a compatible
language.

| Candidate | UI quality | Stack | License | Verdict |
|---|---|---|---|---|
| **OpenCode** | Polished, plan mode, live tool/edit render | **TS backend (Bun/Hono) + TypeScript TUI, decoupled over an OpenAPI HTTP API** | **MIT** | ✅ **base** |
| Crush (Charm) | Prettiest in category | Go monolith | **FSL-1.1-MIT** (source-available, restricts commercial-compete) | ❌ wrong language to graft + risky license for a commercial base |
| Codex CLI | Good, "leaves UX on the table" | Rust monolith | Apache-2.0 | ❌ wrong language; engine bridge/rewrite |
| qwen-code shell (our MVP's shell) | Functional Ink/React TUI | TS | Apache-2.0 | keep the **engine**, replace the **shell** — UI not professional enough |

The load-bearing fact: **OpenCode is a client/server split by design** — a TS backend
(Bun) exposes an OpenAPI HTTP API + auto-generated SDK; the TypeScript TUI
is a *separate process* that talks to it; one backend already serves TUI/web/desktop. That
is "bring your own engine, keep the UI" already solved — and the backend is the same
language as our engine, so it's a **transplant, not a bridge**.

### Evaluated as a base and rejected: MiMo-Code (Xiaomi)

MiMo-Code (Xiaomi, released 2026-06-10) is **itself a fork of OpenCode** — its `LICENSE`
preserves `Copyright (c) 2025 opencode` under MIT, plus a separate acceptable-use policy
(`USE_RESTRICTIONS.md`: no military / malware / unsupervised high-risk). That AUP is a
use restriction, **not** a source-availability restriction like Crush's FSL — so it is not
a commercial-base blocker. We cloned it and diffed against our OpenCode checkout:

- **Not a separate base — same lineage.** The real choice is *OpenCode + which MiMo deltas*,
  not OpenCode vs MiMo.
- **Not rebaseable onto our checkout.** MiMo collapsed OpenCode's modular packages
  (`core` / `llm` / `server` / `tui`) into a single `packages/opencode` monolith and baked
  Xiaomi model-perf tuning into the provider layer. Forking MiMo means inheriting that
  divergence *and* a competitor's release cadence.
- **Its memory subsystem overlaps — and is shallower than — our moat.** MiMo memory is a
  SQLite-FTS5 / BM25 index over markdown files (`packages/opencode/src/memory/`); our unerr
  brain is *code-graph-anchored* memory + conventions + blast-radius governance. We will not
  fork a competing, weaker memory system.

**What is worth cherry-picking (model-agnostic, verified in MiMo's source):** its
**long-horizon orchestration**. Vanilla OpenCode already ships *basic* compaction
(`session.ts` `CompactInput`, `SessionHistory.latestCompaction`); MiMo's delta is a much more
**structured checkpoint layer on top**:
- **Structured checkpoints** (`src/session/checkpoint*.ts`, `src/session/compaction.ts`):
  auto context reconstruction at 40/60/80% fill, a `checkpoint-writer` subagent that
  maintains a task-tree + decisions summary, verbatim-preserve recent turns — what powers
  its 200+-step runs. We graft it onto OpenCode's existing compaction (not from scratch),
  mapping to our §3 "state lives outside the model window" principle.
- **Goal-judge loop** (`src/session/goal.ts`): run until an independent judge model confirms
  a stop condition, with a doom-loop gate (overlaps our retry-loop-breaker).

These are tracked as a workstream in the implementation plan; we port the *behavior*, not
the monolith.

---

## What we already have (transplant, don't rebuild)

The MVP proved these out — the router and gate are portable TypeScript that move onto
OpenCode's backend as-is; the code graph is ported inline onto Bun-native primitives:

1. **Risk-escalation router** (the moat — see design below).
2. **In-loop governance gate** that fires at the edit (breaking-change / blast-radius /
   boundary / drift re-anchor), which a proxy/MCP layer structurally cannot do.
3. **Code intelligence (ported inline)** — the live code graph, risk classifier,
   blast-radius, search, compression. The WASM parser, AST extractor and pure scoring
   modules lift from unerr-cli as-is; the graph *store* is rewritten on `bun:sqlite` (see
   integration strategy). Anchored memory + conventions follow later via the optional unerr
   runtime.

~70–80% of a coding agent is the boring mass (shell + tools + provider plumbing) — that's
what OpenCode hands us. The ~20–30% that is the moat is what we transplant.

---

## The router — get this right (risk-escalation, NOT task-class)

`task-class → senior/worker/junior → endpoint` is the **wrong shape**: it's the "dumb
router" pattern (claude-code-router / LiteLLM / RouteLLM) — routes on prompt length / static
class, already commoditized, and **cannot see the code**. The correct shape (our proven
design):

**Default to the cheap tier; escalate only the hard tail; decide "hard" from
code-structural risk, not the prompt.**

- **Signal = the graph, not the text:** blast-radius / fan-in, call-graph centrality,
  cyclomatic complexity → one 0–100 risk score (this is what a proxy can't do; it's the moat).
- **Escalate when:** score over the upper band, **or** the cheap model's verifier
  *abstains* (explicit signal, not a confidence guess), **or** per-repo triage says cheap
  doesn't pay here.
- **Hysteresis (two bands, e.g. 70 / 40):** a score between them changes nothing, so one
  noisy reading can't flap the tier.
- **Triage go/no-go (per repo):** only allow cheap if `cheapPassRate > 1 / interTierCostRatio`
  **and** the risk signal actually discriminates (effect size above a floor); else force
  frontier. Don't pretend to save when the savings don't cover the rework.
- **Charge the double-pay:** every escalation = a cheap attempt **plus** a frontier
  attempt; subtract it from the savings math or the numbers lie.
- **Degrade open:** any missing signal / thrown lookup / bad input → cheap tier. Routing is
  an optimization; it must never crash a turn.

Magnitude's plan(expensive)/execute(cheap) split is a **complementary** axis to layer on
later (split a single step by role); the risk-escalation loop is the spine.

---

## How we use OpenCode — the integration strategy (binary vs fork vs layer)

The load-bearing "how" question: do we run OpenCode's binary **as-is** and configure it,
**fully merge** our logic into its source, or keep it untouched and add our logic as a
separate **layer**? We researched how comparable products solved this (Cursor's VS Code
fork; Cline / Roo / Continue as extensions; claude-code-router / LiteLLM as proxies; the
Claude Agent SDK as a library; LSP as a sidecar). The three pure options each fail for us:

| Option | What it is | Why it's not enough alone |
|---|---|---|
| **Binary as-is + config** | point env at our endpoints; add MCP + plugins only | the risk-escalation router needs **in-process, per-turn** model selection keyed on a code-structural risk signal — not reachable from outside; enforcement gaps remain (MCP tools bypass permissions, opencode issue #2748) |
| **Full merge / deep fork** | rewrite logic throughout the source | Cursor's lesson: a permanent rebase team, fork drift compounds, you lose upstream fixes + ecosystem access. Overkill — ~70–80% of OpenCode is boring mass we never need to touch |
| **Layer only (proxy + sidecar)** | never touch the loop | a proxy sees only the LLM request/response **stream** — it can route models and capture telemetry but **cannot enforce an edit-time gate** (the edit happens client-side, outside the proxy); a plain MCP tool is skippable (model can use native file tools). Edit-time enforcement structurally requires being **in the tool-execution loop** |

**Decision — a three-zone hybrid, forked from a pinned stable base.** Organize our changes
across three zones (below); fork from a **pinned stable** OpenCode commit, merge our engine in,
and from there **diverge — "make it ours."** We keep `upstream` as a remote for *optional*
cherry-picks, but do **not** commit to continuous rebasing.

- **Zone 1 — Plugin / hook layer (no source edits; rides upstream).** OpenCode's plugin API
  exposes `tool.execute.before` (block by throwing / mutate args) — the rare extension hook
  that reaches the **enforcement** boundary, not just observation. Put here: the in-loop
  **governance gate**, **telemetry** (from per-message usage events), **custom tools**, the
  **graph-tool wiring** (the inline intelligence exposed as custom tools), and **context
  injection** (`chat.params` / `chat.message`). These survive upstream updates with no rebase tax.
- **Zone 2 — Inline intelligence (new packages in the fork, in-process).** The
  code-intelligence engine — the code graph, the risk signal, compression, the guardrail
  checks — built **inside** the Bun backend as our own packages, not a separate process. We
  **port unerr-cli**: lift its WASM tree-sitter parser + AST extractor and its pure modules
  (token estimation, smart-truncate, BM25, boundary / edit-impact / signal-scorer), and
  rewrite the graph store on **`bun:sqlite`** (Datalog/CozoScript → SQL recursive CTEs for
  blast-radius / call-graph / communities). Both `bun:sqlite` and WASM tree-sitter are
  first-class in Bun — **zero native-addon pain, no UDS**. Anchored memory, conventions, drift
  re-anchor and federation are *not* ported now; they arrive later via the optional unerr
  runtime behind a `CodeIntelligence` interface.
- **Zone 3 — Minimal source fork (only what the plugin ceiling can't reach).** The
  **risk-escalation router** at the model-selection seam (`session/runner/model.ts`
  `resolve()`) — it needs in-process per-turn selection keyed on the inline intelligence's
  risk signal —
  plus closing the enforcement gaps the plugin layer can't (e.g. the MCP-permission bypass,
  deeper context-epoch control). Track the `upstream` remote; keep the fork surface to these
  few seams so rebases stay cheap.

**Why this wins:** we get the un-skippable edit-time gate a pure layer/binary cannot
deliver (the research is unanimous — only an in-loop hook can enforce it, and
`tool.execute.before` *is* that hook), while forking only ~3–4 seams instead of carrying
Cursor-scale divergence. The seam table below says *where* each piece lands; the zones say
*how deeply* we touch the source to land it.

### Chosen path: adopt the stable base, then diverge

**The call (2026-06-27): take the current stable OpenCode, merge our engine into it, make it
ours, and proceed on our own tangent as it evolves.** A recon of the loop makes this
lower-risk than the Cursor analogy suggests:

- **The orchestration substrate already exists.** OpenCode ships sub-agents (the `task` tool
  spawns child sessions, each able to set its own model), **parallel** tool execution (Effect
  fibers), and an **agent/mode abstraction** (`AgentV2.Info` = system prompt + permissions +
  optional model override). So **conductor / oracle / executor are largely agent *configs*, not
  new loop code.** The new build is our moat (risk router, governance gate, telemetry, the
  inline code-intelligence) plus **one greenfield seam — a context-assemble hook** (prompt assembly is
  inline in `session/runner/llm.ts` today; no plugin hook reaches it).
- **Why the Cursor counter-point is right — with a twist.** Yes: OpenCode is young and small,
  so the fork surface is a fraction of VS Code's. But the part we change — the agent loop — is
  also OpenCode's *fastest-moving* part, so the real cost of diverging is **not** a rebase tax;
  it's **forfeiting upstream's future agent-feature improvements.** We accept that deliberately.
- **The cheap hedge (keep optionality for ~0 cost).** Pin the fork commit, keep `upstream` as a
  remote, and keep our changes **legible** — the inline intelligence lives in its own packages
  behind a `CodeIntelligence` interface, source edits stay isolated and commented — so we can
  hand-pick a specific upstream win later *if* it's worth it, without owing a continuous merge.
  With divergence chosen, the three zones now serve **code cleanliness and testability**, not
  rebase-avoidance.

---

## Integration seams (in OpenCode's backend)

| Concern | Where it goes in OpenCode | How |
|---|---|---|
| **Model selection per request** (the router) | provider / model-selection layer in the backend | install `routeTurn(riskSignal, state) → 'cheap' \| 'frontier'`; read the risk signal off the turn context |
| **In-loop governance gate** | the tool/edit execution path (pre-exec hook) | fire blast-radius / breaking-callers / boundary / drift checks before an edit lands; the model can't skip it |
| **Code intelligence** (graph, risk, search, compression) | inline package(s) in the Bun backend | ported from unerr-cli: WASM tree-sitter + AST extractor + pure modules lifted as-is; the graph store rewritten on `bun:sqlite` (recursive CTEs). In-process calls, no UDS, no native addons |
| **Context-slice injection** (recon bundle) | context assembly in the backend | inject the graph recon bundle (slices + callers) at the context-assemble hook; preserve cache-friendly prefix ordering. *(Anchored memory + conventions inject the same way later, via the unerr runtime.)* |
| **Telemetry / savings** | end of turn | write through the telemetry core (`enqueue` / `emitSavingsEvent`) into a local event store; the local savings receipt renders from it. Cloud drain is via the optional unerr runtime (later), not required for the receipt |
| **Unified login** | auth | reuse unerr `credentials` / device-flow — one token = econ + unerr |

**Why we port the intelligence inline (onto `bun:sqlite`) instead of running it as a Node
sidecar:** unerr-cli's *parser* is already native-addon-free (WASM tree-sitter), but its
*store* is CozoDB via `cozo-node` — a native addon that fights Bun's `--compile` packaging and
forces a separate process. Bun ships **`bun:sqlite` and WASM as first-class**, so we rewrite
the store on `bun:sqlite` (the Datalog blast-radius / community queries become SQL recursive
CTEs) and run the whole engine — router, gate, graph — in **one Bun process**. We accept the
rewrite cost (the query layer is the real work) to delete the sidecar, the UDS hop, and all
native-addon risk. The richer unerr runtime (anchored memory, conventions, drift, federation)
is deferred behind a `CodeIntelligence` interface and can be added inline or as a runtime
later without changing callers.

---

## Observability & the savings receipt (our product surface)

Cost visibility — cache hit-rate, tokens-per-outcome, cheap-vs-frontier split, $ saved — is
not a nice-to-have for us; it's the **proof** behind the pitch and the input our router
depends on. OpenCode gives us accurate raw numbers but an incomplete display:

**What OpenCode already emits (the data layer is solid):**
- Per-message token metadata with **cache read/write as first-class**: `tokens.input`,
  `tokens.output`, `tokens.cache.write`, `tokens.cache.read`; cumulative session totals.
- Provider-agnostic prompt caching (`promptCacheKey = sessionId` for OpenAI-style;
  `cache_control` markers for Anthropic/Bedrock/OpenRouter).
- Cost computed with separate cached vs uncached pricing; a `/usage` command.

**Where it's weaker than Claude Code (and where the bugs are):**
- The live always-on status display (context % used, cache-hit ratio ticking live) is
  command-driven / partly a feature request, not a polished footer.
- **Cost/cache accounting bugs hit our provider path:** cost calc has ignored cache-**read**
  tokens; **cache-write tokens aren't accounted for on OpenRouter** → cost underestimation.

**Our approach — own it, don't inherit it:**
1. Consume OpenCode's per-message usage data (it's in the API/message metadata).
2. Pipe it into unerr's existing telemetry/savings pipeline (`emitSavingsEvent`, event
   store, token-trace + savings-origin dashboard) — purpose-built and far richer.
3. Render our own **status line + end-of-turn receipt**: context fill, cache-hit ratio,
   tier used, cheap/frontier split, $ saved vs a frontier baseline.

**Day-0 gate:** verify `cache.read` / `cache.write` are actually reported on *our* provider
path (OpenRouter / Fireworks / vLLM) and fix the accounting if not. The savings math is only
as honest as those two numbers.

---

## Multi-tier model routing (OSS, India-hosted)

Two tiers on the spine: **cheap** (bulk of turns) and **frontier** (the hard tail). Every
tier on an OpenAI-compatible endpoint (India-hosted vLLM / LiteLLM / OpenRouter), OSS-first.
Candidate OSS models (2026): Qwen 3.x-Coder, GLM-5.x, Kimi K2.6, DeepSeek V4, Devstral —
pinned by eval, not assertion. (Delegation senior→worker→junior is an orthogonal axis we can
add later; the cheap/frontier escalation loop ships first.)

---

## Packaging — "one deployment"

- Goal: feel like one product. With the intelligence inline there is **no sidecar to
  supervise** — the backend is a single Bun process; the TUI is the only other artifact.
- **Bun single binary**: `bun build --compile` ships the backend (engine + inline graph) as a
  standalone binary (no user Node install). Because the store is `bun:sqlite` and the parser is
  WASM — both Bun built-ins — there are **no native addons to fight** under `bun --compile`;
  the one thing to verify day-0 is that the tree-sitter `.wasm` grammars are bundled/resolved
  in the compiled binary. Bun can't fuse the TypeScript TUI binary with the backend — "one
  deployment" = installer UX, not a single fused executable.

---

## The plan (transplant onto OpenCode)

> The day-by-day table below is the high-level spine. The full **sprint + task breakdown for
> every feature** (grounded in verified OpenCode seam paths) lives in
> [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

| Day | Workstream | Done when |
|---|---|---|
| **0** | Build/run OpenCode locally; point a tier at one OSS OpenAI-compatible endpoint; scaffold the **inline intelligence package** (`bun:sqlite` store + a WASM tree-sitter parse spike) and **verify cache.read/write** on our provider path. | OpenCode runs on an OSS model; a graph query returns in-process from `bun:sqlite`; cache numbers confirmed. |
| **1** | Transplant the **risk-escalation router** into the model-selection seam; wire cheap/frontier endpoints; carry tier state + hysteresis across a turn. | A high-risk edit escalates to frontier; a low-risk one stays cheap; logged. |
| **2** | Graph tools (recon, file_read, get_references) as the backend's primary tools — in-process against the `bun:sqlite` graph; bias the loop to them. | econ edits a real repo on the graph, on OSS models. |
| **3** | Transplant the **in-loop governance gate** (blast-radius / breaking-callers / boundary / drift) into the edit path. | A breaking signature edit is blocked/flagged before it lands. |
| **4** | Context-slice injection (recon bundle at the context-assemble hook); preserve cache-friendly prefix ordering. (Anchored memory/conventions deferred to the unerr runtime.) | Slices appear before the model plans; caching not regressed. |
| **5** | Observability: consume usage → unerr telemetry → **status line + savings receipt**; unified login. | Receipt shows tier split + cache-hit + $ saved; one login. |
| **6** | Harden: sandbox/permission defaults, model fallback, escalation double-pay accounting; dogfood on a customer repo. | Clean run on a real customer repo. |
| **7** | Polish + ship to existing customers. | GA. |

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Porting unerr's graph store off CozoDB onto `bun:sqlite` (Datalog → SQL). | The query layer is the real work — blast-radius / community queries become SQL recursive CTEs. De-risk by porting incrementally with a parity test against the MVP's graph answers; lift the parser/extractor + pure modules unchanged so only the store is new. Native-addon risk is **eliminated** (no `cozo-node`, all Bun built-ins). |
| Cache/cost accounting bugs on OpenRouter. | Day-0 verification gate; patch the accounting; our own receipt is the source of truth. |
| OSS-model tool-call reliability. | Keep frontier tier strong; validate tool-call schemas before dispatch; governance review on each turn. |
| OpenCode fork churn (fast-moving upstream). | We **diverge by choice** from a pinned stable commit; `upstream` is kept only for *optional* cherry-picks. The accepted trade is forfeiting upstream's future agent-feature work — hedged by keeping our changes legible so a specific win can be hand-picked later. |
| Crush license envy. | Steal styling ideas only; do not base on FSL-licensed code. |

---

## Sources

- OpenCode architecture (client/server, Bun/Hono backend, TypeScript TUI, OpenAPI+SDK): https://medium.com/@maclarensg_50191/how-opencode-actually-works-an-architecture-guide-backed-by-source-code-939811f0434f · https://opencode.ai/docs/server/
- OpenCode usage / cache tokens / cost + gaps: https://github.com/ramtinJ95/opencode-tokenscope · https://github.com/anomalyco/opencode/issues/10575 · https://github.com/anomalyco/opencode/issues/18440 · https://github.com/anomalyco/opencode/issues/28494
- Crush (prettiest TUI, Go, FSL): https://thenewstack.io/terminal-user-interfaces-review-of-crush-ex-opencode-al/ · https://github.com/charmbracelet/crush
- OSS coding models / routing: https://www.mindstudio.ai/blog/best-open-source-llms-agentic-coding-2026
