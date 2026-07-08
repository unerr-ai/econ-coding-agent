# econ — documentation

Docs are organized by **feature**, not by sprint. Four layers, outermost first:

```
docs/
├── architecture/   the system-design narrative (what we're building, and why it fits together)
│   ├── ECON_ARCHITECTURE.md   + diagrams/ (TikZ figures)
│   └── ORCHESTRATION_MECHANISM.md   the orchestration/state-machine mechanism
├── features/       how each feature is built on the forked OpenCode base — seams + status
├── design/         deeper per-topic design notes the features draw on
├── testing/        live-fire playbooks + reference approaches for benchmark cases
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
[ORCHESTRATION_MECHANISM.md](./architecture/ORCHESTRATION_MECHANISM.md) is the single
orchestration-mechanism doc: how the conductor triages a task, decomposes it into typed slices,
allocates each to the cheapest capable tier (execute-cheap-then-verify, escalate only the failures),
verifies, and hardens the loop as an explicit state machine (the squeeze-then-climb ladder + the
SM-series). It absorbed and superseded the three earlier plan docs (`SELF_ORCHESTRATION_PLAN`,
`DECOMPOSITION_ORCHESTRATION_PLAN`, `PERSONA_ORCHESTRATION_PLAN`) — grounded in the current codebase,
the checked-out Claude Code source, and the 2026-07 model/reasoning/cost research (F1–F8).

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

### `testing/` — live-fire playbooks + reference approaches
- [TIER_FIRING_CHECKLIST.md](./testing/TIER_FIRING_CHECKLIST.md) — the acceptance-test playbook for
  econ's escalation machinery on real repos: five canonical cases (one per routing door) + the
  decode/debug discipline for a door that won't open.
- [PROMPT_SLICING_CORPUS.md](./testing/PROMPT_SLICING_CORPUS.md) — the evidence-grounded golden spec
  for arming decisions: prompt archetypes + expected shape/door/pre-pass/tier, the R1–R5 decision
  rules (with research citations), and the labeled corpus encoded 1:1 in `test/arming-rig/corpus.ts`.
  Re-run the rig (deterministic + `RIG_LIVE=1`) after every arming-judge or door change.
- [SHELL_COMPRESSION_CHECKLIST.md](./testing/SHELL_COMPRESSION_CHECKLIST.md) — live-testing checklist
  verifying shell-output compression end-to-end (lossy path triggers only when appropriate, recovery
  intact, audit trails).
- [REFERENCE_APPROACHES.md](./testing/REFERENCE_APPROACHES.md) — per benchmark case, the reference
  approach (gold patch + how a strong agent independently decomposes/verifies it), used to audit the
  orchestration *expectation* separately from econ's actual outcome.
- [SWE_BENCH_TRACKER.md](./testing/SWE_BENCH_TRACKER.md) — the working tracker for the SWE-mini-10
  django set: per-instance benchmark verdict + local triage status + root-cause, the laptop run
  recipe, and the real-grader-simulation rule that keeps local runs honest (local "N tests OK" ≠ pass).

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
