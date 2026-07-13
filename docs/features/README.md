# econ — Feature build docs

Each doc here is one **feature area**: what it is, how it's built on the forked OpenCode
base, the exact seams it touches, and its status. These are the build/status layer — the
*system design* they realize lives in
[../architecture/ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md); the deeper
per-topic design notes live in [../design/](../design/).

## The feature docs

| # | Feature | Covers |
|---|---|---|
| [00](./00-foundations.md) | Foundations & day-0 de-risk gates | build/run on an OSS model, cache & cost accounting, plugin enforcement gate, MCP permission scope, verification |
| [01](./01-conductor-core.md) | The conductor core loop | mid-tier conductor as default reasoner, graph tools as primary tools, canonical state outside the window, eval harness |
| [02](./02-context-engine.md) | The context engine | context-assemble hook, recon injection, output trimming, web-fetch compression, window pruning, fidelity gate, semantic layer |
| [03](./03-risk-router.md) | The risk-escalation router (the moat) | structural risk score, hysteresis router, abstention, compiled brief, per-repo triage, double-pay accounting, reasoner mode |
| [04](./04-model-team.md) | The model team — executors & specialists | executor tier + tool-call validation, parallel fan-out, specialist library, batch-then-fan-out discipline |
| [05](./05-long-horizon.md) | Long-horizon orchestration | proactive checkpointing, restart-surviving task tree, goal-judge / doom-loop gate |
| [06](./06-observability.md) | Observability — the proof surface | telemetry store, status line, honest savings receipt (double-pay subtracted), unified-login seam |
| [07](./07-hardening-hosting-ship.md) | Hardening, in-region hosting & ship | safe defaults, in-region inference + data residency, single-binary packaging, dogfood runbook, GA gate checklist |
| [08](./08-signal-bus.md) | Signal bus & round-F variance hardening | unified signal bus (CONVERT/DEFER/SURFACE), hard-tail deferral consumer, oracle-inversion escape, evidence-bearing gate hatches, issue-derived expectations, fidelity teeth, interpreter discipline |

## Integration model — the three zones

We forked from a pinned stable OpenCode commit, merged our engine in, and diverged. Our
changes split across three zones so the source-fork surface stays small:

| Zone | Where it lives | Rebase cost | What goes here |
|---|---|---|---|
| **Z1 — Plugin/hook** | OpenCode plugin API (`packages/plugin/src/index.ts`), no source edits | none (rides upstream) | governance gate (`tool.execute.before`), telemetry, custom tools, context injection |
| **Z2 — Inline intelligence** | new packages in the fork, in-process (Bun) | none (our code) | code graph on `bun:sqlite` + WASM tree-sitter (ported from unerr-cli), risk signal, compression, guardrail logic |
| **Z3 — Source fork** | edit OpenCode source at named seams | tracked vs `upstream` | risk-escalation router (`model.ts`), enforcement gaps the plugin ceiling can't reach |

`upstream` is kept as a remote for *optional* cherry-picks only — not a continuous rebase.

## Verified OpenCode seams (the Z3 surface)

The only OpenCode files we expect to fork, verified against the `./opencode` checkout:

| Seam | Path | Line |
|---|---|---|
| Model selection (router) | `packages/core/src/session/runner/model.ts` `resolve()` | ~157 |
| Tool settlement gate | `packages/core/src/tool/registry.ts` `settleWith` | ~49 |
| Edit pre-write point | `packages/core/src/tool/edit.ts` `execute` (before `files.writeIfUnchanged`) | ~150–159 |
| Context assembly | `packages/core/src/session/context-epoch.ts` `prepare()` + `runner/llm.ts` | — |
| Usage/cost | `packages/llm/src/schema/events.ts` `Usage` + `runner/publish-llm-event.ts` | 51 / 17 |
| Compaction (extend, don't rebuild) | `packages/core/src/session.ts` `CompactInput`, `SessionHistory.latestCompaction` | 79 / — |
| Plugin hooks (Z1 host) | `packages/plugin/src/index.ts` — `tool.execute.before/after`, `chat.message`, `chat.params`, `permission.ask`, `command.execute.before`, `shell.env` | 222–335 |

The one greenfield seam is a **context-assemble hook** before prompt assembly in
`runner/llm.ts` / `context-epoch.prepare` (feature [02](./02-context-engine.md)) — no
existing plugin hook reaches prompt assembly.

## Build order (spine first)

```
00 ─▶ 01 ─▶ 02 ─▶ 03 ─┬─▶ 04
                       ├─▶ 05
                       ├─▶ 06
                       └─▶ 07
```

`00→03` is the critical path to a working cheap+oracle agent on the graph. `04` (team),
`05` (long-horizon), `06` (proof) parallelize once `03` lands; `07` closes. The two-tier
cheap/oracle loop is shippable after `03` — everything after deepens it.

## Standing gates (every feature)

- **Fork hygiene:** keep Z3 edits to the named seams, isolated + commented; diverge from the
  pinned commit (no continuous rebase).
- **Fidelity gate:** any new compression/pruning ships only if it passes the
  answer-preservation set (feature [02](./02-context-engine.md)).
- **Cache honesty:** re-confirm `cache.read`/`cache.write` after any provider change
  (feature [00](./00-foundations.md)).
- **Cache-friendly prefix ordering:** stable parts first (system → tools → conventions →
  durable context), volatile last.
- **Eval-pinned models:** never assert a tier choice; pin by eval (feature
  [01](./01-conductor-core.md)).
- **Delegation:** mechanical/repetitive work → executor/worker sub-agents in parallel; main
  thread reviews diffs.
</content>
