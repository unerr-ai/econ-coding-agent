# econ — documentation

Docs are organized by **feature**, not by sprint. Four layers, outermost first:

```
docs/
├── architecture/   the system-design narrative (what we're building, and why it fits together)
│   ├── ECON_ARCHITECTURE.md   + diagrams/ (TikZ figures)
│   ├── SELF_ORCHESTRATION_PLAN.md   sprint/task plan for the self-orchestrating agent loop
│   └── DECOMPOSITION_ORCHESTRATION_PLAN.md   detailed plan: decomposition-first (risk → one feature)
├── features/       how each feature is built on the forked OpenCode base — seams + status
├── design/         deeper per-topic design notes the features draw on
└── strategy/       the business case — positioning, economics, market
```

## Start here

- **What econ is + the vision** → [../README.md](../README.md)
- **The system design** (model team, router, context engine, memory, guardrails, caching,
  economics) → [architecture/ECON_ARCHITECTURE.md](./architecture/ECON_ARCHITECTURE.md)
- **How it's built, feature by feature** → [features/README.md](./features/README.md)

## Layers

### `architecture/` — the system design
The single narrative doc [ECON_ARCHITECTURE.md](./architecture/ECON_ARCHITECTURE.md) — the
multi-tier model team, the risk-escalation router, the context engine, anchored memory, the
in-loop governance gate, caching, economics, and market framing. Read two ways: plain-language
framing plus an "Under the hood" track. TikZ figures live in
[architecture/diagrams/](./architecture/diagrams/). Alongside it,
[SELF_ORCHESTRATION_PLAN.md](./architecture/SELF_ORCHESTRATION_PLAN.md) is the sprint/task plan for
moving econ to a self-orchestrating agent loop (models switch themselves; context managed per switch)
— grounded in the current codebase and the checked-out Claude Code source. Its next direction,
[DECOMPOSITION_ORCHESTRATION_PLAN.md](./architecture/DECOMPOSITION_ORCHESTRATION_PLAN.md), is the
detailed engineering plan for the **decomposition-first** reframe: the conductor splits a task into
typed slices and allocates each to the cheapest capable tier (execute-cheap-then-verify, escalate only
failures), with whole-turn *risk* demoted from the routing decision to one per-slice feature —
grounded in the 2026-07 model/reasoning/cost research (F1–F8).

### `features/` — the build docs
One doc per feature area (foundations → conductor core → context engine → router → model team
→ long-horizon → observability → hardening/hosting/ship). Each says what the feature is, the
exact OpenCode seams it touches, and its status. Index + integration-zone model + verified
seam table: [features/README.md](./features/README.md).

### `design/` — deeper design notes
- [adaptive-compute.md](./design/adaptive-compute.md) — the "compute dial": divide cost on the
  common path, multiply accuracy on the hard tail.
- [AUTO_COMPACTION_AND_CONTEXT.md](./design/AUTO_COMPACTION_AND_CONTEXT.md) — auto-compaction
  hardening, `/context` + `/usage` UX, the cheap-model-first triage tier, and the user-pain +
  efficiency task tracker (extended by feature
  [05-long-horizon](./features/05-long-horizon.md)).
- [cross-tier-context.md](./design/cross-tier-context.md) — how the 3 model tiers share context
  without a shared transcript: sticky cache-warm conductor, stateless brief-fed oracle,
  token-budgeted executor; cache-hit-rate discipline + measurement.
- [session-record-and-transcript.md](./design/session-record-and-transcript.md) — the durable
  conversation record (full tool I/O + reasoning in SQLite) vs Claude Code's `.jsonl`, and the
  read/stream layer to reach parity: `session show`, JSONL export, live `session tail`.
- [tooling-context-opt.md](./design/tooling-context-opt.md) — collapsing the native tool
  surface + the unerr-cli port backlog that makes tool output lean.
- [models.md](./design/models.md) — the open-weight model facts and the per-role selection.
- [tier-prompts.md](./design/tier-prompts.md) — the grounded reference for every tier/persona
  system prompt (verbatim, `file:line`-anchored) and all ~25 runtime prompt-mutation surfaces
  (reasoning gate, preambles, frame seeds, typing, wrappers, escalation briefs, verifier prompts).

### `strategy/` — the business case
- [POSITIONING.md](./strategy/POSITIONING.md) — who econ is for, the wedge, and the
  one-product/three-triggers regional model; [COMPETITORS.md](./strategy/COMPETITORS.md) covers
  the competitive field.
- [ENTERPRISE_SEGMENTATION.md](./strategy/ENTERPRISE_SEGMENTATION.md) — the cross-segment,
  global demand map: affordability × independence as two axes (affordability splitting into
  parity vs scale), the 2×2 by business type and region, the model-per-tier config that lets one
  product serve every segment, and the three GTM lanes. The segment cut of POSITIONING's regional cut.
- Model strategy — [MODEL_SELECTION.md](./strategy/MODEL_SELECTION.md) (which open/rented models
  we run per tier, Phase 1) + [MODEL_TRAINING_STRATEGY.md](./strategy/MODEL_TRAINING_STRATEGY.md)
  (how we post-train our *own* mid-tier reasoner in Phase 2 — recipe, data flywheel, parity math).
- Economics — token COGS & pricing ([TOKEN_ECONOMICS.md](./strategy/TOKEN_ECONOMICS.md)), regional
  market sizing ([MARKET_ECONOMICS.md](./strategy/MARKET_ECONOMICS.md),
  [MARKET_ECONOMICS_EUROPE.md](./strategy/MARKET_ECONOMICS_EUROPE.md)), GPU-utilization tactics
  ([GPU_UTILIZATION_ECONOMICS.md](./strategy/GPU_UTILIZATION_ECONOMICS.md)), and sovereign-hosting
  postures + capital logic ([SOVEREIGN_HOSTING.md](./strategy/SOVEREIGN_HOSTING.md)).
- Confidential compute — [CONFIDENTIAL_COMPUTE_MARKET.md](./strategy/CONFIDENTIAL_COMPUTE_MARKET.md)
  (market research) + [CONFIDENTIAL_COMPUTE_EXCHANGE.md](./strategy/CONFIDENTIAL_COMPUTE_EXCHANGE.md)
  ("the Exchange", a separate adjacent venture).
</content>
