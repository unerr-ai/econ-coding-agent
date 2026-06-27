<h1 align="center">econ</h1>

<p align="center">
  <strong>An economical coding agent — built for India, hosted in India.</strong>
</p>

<p align="center">
  A native coding agent that aims to match the capability of Claude Code / Cursor
  at a fraction of the cost — by routing every step of the work to the cheapest
  open-source model that can do it well, and by handing the model only the code
  that matters instead of the whole repo.
</p>

> **Status: vision / pre-code.** This repository currently holds the goal and the
> plan. No application code exists yet. We are building toward the milestones below
> deliberately and in order. This README is the north star, not a description of
> shipped features.

---

## Why this exists

Frontier coding agents are excellent and expensive. The expense comes from two
habits that have nothing to do with the hard part of coding:

1. **One model does everything.** The most expensive "brain" gets used for boring,
   mechanical work — fixing a test, renaming a symbol, formatting, "go find X" —
   the same way it's used for hard design and debugging. That's paying a senior
   engineer to do data entry.
2. **The agent reads too much.** It greps, reads whole files one at a time, and
   re-reads when the first read was too small — filling the context window (and the
   bill) with noise. Studies put ~84% of an agent's tokens in tool output, mostly
   file reads.

`econ` attacks both, and adds a third thing the global tools don't prioritise: a
**cost-efficient agent that is native to the Indian market** — hosted on Indian
infrastructure, defaulting to open-source models that can be self-hosted or served
cheaply in-region, with data residency and price points that fit local teams.

The near-term target is blunt: **a comparable alternative to Claude Code, at an
affordable cost.** Everything else builds on that.

---

## The two big ideas

### 1. Harness-driven, multi-tier model routing (open-source at every step)

Instead of one model per session, `econ` runs a small "team" of models and routes
each sub-task to the cheapest tier that can do it well — the same insight behind
[Magnitude](https://docs.magnitude.dev/why-magnitude) (split the work across a strong
planner and a smaller, faster executor) and behind unerr's senior/worker/junior
delegation. The difference: every tier is an **open-source model**, chosen and
hosted for the Indian cost/latency landscape.

```
  SENIOR  ── strongest available OSS reasoning model.
    │         Plans, designs, root-causes hard bugs, reviews. Never handed off.
    │  hands the boring work down
    ▼
  WORKER  ── mid OSS model. Tests, multi-file renames — needs some care.
    │
    ▼
  JUNIOR  ── cheapest/fastest OSS model. Lint/format, doc comments, "go find X".
```

The routing decision lives **in the harness**, not in the user's head: the agent
itself decides what's boring, hands it down, and reviews the result. The savings
model is straightforward — `reduction ≈ f × (1 − 1/r)` where `f` is the share of
work that's genuinely boring and `r` is the price ratio between tiers. On
exploration- and refactor-heavy work this is where almost all the savings come from.

### 2. Hand the model the right slice, not the whole repo

`econ` ships the context-engineering layer pioneered in
[unerr](https://github.com/unerr-ai/unerr) as a **built-in capability**, not a
bolt-on plugin:

- **Graph navigation** — a live call graph (tree-sitter + verified call data) so one
  query returns the entity, its body, and everything that depends on it, replacing
  5–15 file reads.
- **Semantic & syntactic graph edges** — both how the code is structured (calls,
  imports, definitions) and what it means (domain/role annotations), so the agent
  reasons over meaning, not just text.
- **Optimal file reads & pattern matches** — function-targeted reads, exact
  string/regex search with bounded surrounding context, and "set the read size right
  the first time" instead of read-small-then-re-read.
- **Text / output compression** — shell output trimming and web pages fetched at
  5–10× less bulk, so the window fills with signal.
- **MCP / tooling optimisations** — the right tool surfaced at the moment it's
  needed, instead of dozens of tool definitions eating the context window up front.
- **Edit-time guardrails** — surface the callers a signature change would break
  *before* the edit lands.

Together these cut the read/navigate token slice dramatically — and fewer tokens at
every step compounds with the cheaper models above.

---

## What "native to India" means here

- **Hosted in India.** Inference and any cloud components run on Indian
  infrastructure — for latency, for data residency, and for price.
- **Open-source models by default.** No dependency on a single foreign frontier
  vendor; models are swappable per tier and can be self-hosted or served in-region.
- **Affordable, measured.** Cost savings are counted and shown, not promised — the
  routing and compression each report what they saved so the blended cost per real
  task is visible.

---

## Roadmap (in order)

| Phase | Goal |
|---|---|
| **0 · Foundations** *(now)* | Pin down architecture, model tiers, and the harness contract. Stand up the project skeleton. |
| **1 · Comparable core** | A working coding agent (plan → edit → verify loop) on open-source models — the affordable Claude Code alternative. |
| **2 · Context engine** | Built-in graph navigation, semantic/syntactic edges, compression, optimal reads, edit-time guardrails. |
| **3 · Multi-tier routing** | Harness-driven senior/worker/junior delegation with cost accounting and a savings receipt. |
| **4 · India hosting** | In-region inference + data residency; production-grade affordable serving. |
| **5 · Primitives** *(future)* | A library of pre-built, templatized code blocks — see below. |

---

## Primitives (future)

Beyond raw coding, `econ` will ship **primitives**: the smallest reusable,
production-ready pieces of code for common functionality, composable into any
project. Think "a SaaS starter with billing + login wired together," but as
fine-grained, battle-tested blocks the agent can drop in and adapt rather than
re-generate from scratch each time. This is a later-phase goal — noted here so the
core is designed to support it, not built before the core exists.

---

## Status & how to follow along

There is no installable build yet. This repo is the plan; code lands phase by phase
per the roadmap above. Contributions and discussion will open as Phase 1 begins.
