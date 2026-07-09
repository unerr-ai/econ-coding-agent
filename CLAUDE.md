

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The unerr-managed section further down (between its own start/end markers) is rewritten
> by `unerr install/uninstall` — do not hand-edit it. Edit only this project brief, and keep
> the literal unerr marker tokens out of this prose (embedding one makes the installer
> overwrite everything below it).

## Project: econ — an economical coding agent for India

**What we are building.** `econ` is a native coding agent for the Indian market, hosted in
India, that aims to match Claude Code / Cursor capability at a fraction of the cost. See
[README.md](./README.md) for the full vision and
[docs/architecture/ECON_ARCHITECTURE.md](./docs/architecture/ECON_ARCHITECTURE.md) for the
system design (the per-feature build docs live in [docs/features/](./docs/features/)). Treat
these as the north star.

**Status.** We have a **proven MVP** (cost-routing engine + in-loop governance + unerr-brain
integration, qwen-code lineage). This phase builds the **professional version** by adopting a
nailed open-source shell and transplanting the engine. The repo also holds planning docs;
real product code lands phase by phase.

**Architecture decision (updated 2026-06-23):**

- **Base = [OpenCode](https://github.com/anomalyco/opencode)** (TypeScript, MIT), checked out
  at [`./opencode`](./opencode) — we take it over and modify it. Chosen for its
  **client/server split** (TS Bun/Hono backend + decoupled Go TUI over an HTTP API): keep the
  polished TUI, transplant our engine into the same-language backend. Monorepo seams:
  `packages/core` (engine/tools), `packages/llm` (model selection → router),
  `packages/server` (Hono API), `packages/tui` (the Go TUI we keep).
- **Transplant, don't rebuild:** the **risk-escalation router** (default cheap → escalate the
  hard tail on *code-structural risk* — blast-radius/fan-in/centrality — with hysteresis,
  abstention, triage, double-pay accounting; **NOT** task-class routing), the **in-loop
  governance gate** (fires at the edit), and the **unerr-brain** integration.
- **unerr brain stays a Node sidecar** (`unerrd` + per-repo proxy; native addons), called by
  the Bun backend over **UDS**. Memory/login/telemetry reuse unerr cores (`emitSavingsEvent`,
  `credentials`).
- **Observability is our product surface:** consume OpenCode's per-message usage
  (`tokens.cache.read/write`, cost) → unerr telemetry → our own status line + savings receipt.
  Day-0 gate: verify cache accounting on our provider path (known OpenRouter bug).

Timeline: ~1 week, built with coding agents, for existing customers.

**Also in scope (later phases):** in-region hosting + data residency, and **primitives** — a
library of the smallest reusable, production-ready code blocks (e.g. a SaaS starter with
billing + login) the agent composes rather than re-generates. Design the core to support
primitives; don't build them before the core.

## Documentation — where to look, where to write

Docs live under `docs/`, organized **by feature, not by sprint** (there are no `sprintN/`
folders — don't recreate them). Four layers; keep each doc in the layer that matches its
altitude:

| Layer | Holds | The one narrative/index |
|---|---|---|
| `docs/architecture/` | the single system-design narrative + TikZ `diagrams/` | [`ECON_ARCHITECTURE.md`](./docs/architecture/ECON_ARCHITECTURE.md) — the *design*, no build plan |
| `docs/features/` | one doc per feature: what it is, the OpenCode seams it touches, its status | [`features/README.md`](./docs/features/README.md) — index + zones + verified seam table |
| `docs/design/` | deeper per-topic design notes (models, tooling/context-opt, adaptive-compute, auto-compaction) | — |
| `docs/strategy/` | the business case (positioning & market, economics, confidential compute) | — |
| root | [`docs/README.md`](./docs/README.md) is the docs index — start there | — |

**Lookup order** (before writing a doc, read the relevant existing one — don't start a new
file): docs index → the feature doc for the area (`features/NN-*.md`) → its design note in
`design/` → the system narrative for cross-cutting design → `strategy/` for business/market
questions. Feature docs are numbered by build order (`00`→`07`); the number is the spine.

**Creation & maintenance rules** (keep the standard; don't let it drift):
1. **Consolidate, don't fragment.** A new capability extends the **existing** feature doc for
   its area — do not add a per-task file. Only create a new top-level doc when a genuinely new
   feature/topic has no home; put it in the right layer and add it to `docs/README.md` (and to
   `features/README.md` if it's a feature).
2. **One home per fact.** State a fact/table/number once in its owning doc and cross-reference
   it; never duplicate a section across docs. When merging, dedupe narrative overlap but drop
   no unique data.
3. **`architecture/ECON_ARCHITECTURE.md` stays design-only** — no phasing tables, day plans, or
   sprint/build-order content (that lives in `features/`). Keep its plain-language + "under the
   hood" two-track voice.
4. **Feature docs preserve build substance** — file paths, seams (`file.ts:line`), config
   blocks, `**Status:**`/done-when markers, and tests. They are the build record.
5. **Diagrams where they clarify.** Match the house style: ASCII box/arrow diagrams (as in the
   existing feature docs) or a fenced ` ```mermaid ` block; one focused diagram per doc beats
   several. Preserve existing diagrams.
6. **Cross-link with correct relative paths** and no dead `#anchor` fragments. When you move,
   merge, or delete a doc, fix every inbound link (repo-wide: `README.md`, `CLAUDE.md`,
   `CONTRIBUTING.md`, `opencode.json` comments, and sibling docs) and never leave a stale
   "kept in place / see OLD_NAME.md" provenance line.

`) is
> managed by `unerr install/uninstall` — do not hand-edit it; your changes will be
> overwritten on the next install. Edit only this project brief.

## Project: econ — an economical coding agent for India

**What we are building.** `econ` is a native coding agent for the Indian market,
hosted in India, that aims to match Claude Code / Cursor capability at a fraction of
the cost. See [README.md](./README.md) for the full vision. This is the goal we are
building toward, in order — treat it as the north star, not a description of shipped
code.

**Status.** Pre-code. The repo currently holds the plan only. There is no build, no
test suite, and no application code yet. Do not invent commands, architecture, or
APIs that don't exist — when asked "how do I run/test this," the honest answer today
is "there's nothing to run yet." Update this brief and the README as real code lands.

**The two pillars (what every design decision serves):**

1. **Harness-driven, multi-tier model routing — open-source at every step.** Run a
   team of models (senior / worker / junior) and route each sub-task to the cheapest
   tier that can do it well. Every tier is an OSS model chosen for the Indian
   cost/latency landscape. Savings model: `reduction ≈ f × (1 − 1/r)` (boring share ×
   price ratio). Inspired by Magnitude's plan/execute model split and unerr's
   senior/worker/junior delegation.
2. **Hand the model the right slice, not the whole repo.** Build in (not bolt on) the
   context-engineering layer: live call-graph navigation, semantic + syntactic graph
   edges, optimal/function-targeted file reads & pattern matches, output/text
   compression, MCP optimisations, and edit-time breaking-change guardrails. Fewer
   tokens at every step compounds with the cheaper models above.

**Architecture decision (updated 2026-06-23 — see [docs/architecture/ECON_ARCHITECTURE.md](./docs/architecture/ECON_ARCHITECTURE.md)).**
We have a **proven MVP** (cost-routing engine + in-loop governance + unerr-brain
integration, qwen-code lineage). This phase builds the **professional version** by
adopting a nailed open-source shell and transplanting the engine:

- **Base = [OpenCode](https://github.com/anomalyco/opencode)** (TypeScript, MIT), checked
  out at [`./opencode`](./opencode) — we take it over and modify it. Chosen for its
  **client/server split** (TS Bun/Hono backend + decoupled Go TUI over an HTTP API): we
  keep the polished TUI and transplant our engine into the same-language backend.
- **Transplant, don't rebuild:** the **risk-escalation router** (default cheap → escalate
  the hard tail on *code-structural risk* — blast-radius/fan-in/centrality — with
  hysteresis, abstention, triage, double-pay accounting; **NOT** task-class routing), the
  **in-loop governance gate** (fires at the edit), and the **unerr-brain** integration.
- **unerr brain stays a Node sidecar** (`unerrd` + per-repo proxy; native addons), called
  by the Bun backend over **UDS**. Memory/login/telemetry reuse unerr cores
  (`emitSavingsEvent`, `credentials`).
- **Observability is our product surface:** consume OpenCode's per-message usage
  (`tokens.cache.read/write`, cost) → unerr telemetry → our own status line + savings
  receipt. Day-0 gate: verify cache accounting on our provider path (known OpenRouter bug).

Timeline: ~1 week, built with coding agents, for existing customers.

**Also in scope (later phases):** in-region hosting + data residency, and
**primitives** — a library of the smallest reusable, production-ready code blocks
(e.g. a SaaS starter with billing + login) the agent composes rather than
re-generates. Design the core to support primitives; don't build them before the core.

**Working principle for this repo specifically.** We are building a cost-efficient
coding agent, so practise what we preach: prefer the cheapest path that does the job
well, count and surface savings rather than promising them, and keep context lean.
The reference implementation for these ideas lives in the sibling `../unerr-cli` repo
(see `.internal/roadmap/SAVINGS_ACTIVATION_BRAINSTORM.md` there for the detailed
savings-activation design we're drawing from).
