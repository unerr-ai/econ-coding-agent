# Feature: Observability — the proof surface

econ's product surface is observability: we **count savings, we don't promise**
them. Every completed turn's usage is forwarded into a telemetry store, which
drives a live status line and an **honest** end-of-turn savings receipt with
double-pay subtracted. A unified-login seam (scaffolded, not yet implemented)
is included in this feature so a single unerr token can eventually authenticate
both the agent and the unerr brain.

Guiding facts (anchored): savings are driven by the large-tier **TOKEN** share,
not call count, so `reduction ≈ 1 − large-tier token share`; and an escalated
turn double-pays (the cheap attempt is discarded), which the receipt must
subtract to stay honest.

## Data flow

```
step-finish (per-turn usage: cost + tokens + model)
        │
        ▼
 emitUsageEvent → TelemetryStore   [S7.1]
        │
        ├──────────────► econ-status.js (event-hook plugin)   [S7.2]
        │                 tier · context-tokens · cache-hit% · spend · turns
        │
        └──────────────► buildReceipt(store, ledger, baseline)   [S7.3]
                           netSavings = grossSavings − ledger.totalWastedCost
                                  │
                                  ▼
                          formatReceipt() → savings receipt

  (unified login seam, S7.4, is orthogonal: unerr credential
   resolution feeds the provider-auth path used by step-finish's
   model calls, not the telemetry pipeline above)
```

## Files

| Task | File | What |
|---|---|---|
| S7.1 | `packages/code-intelligence/src/telemetry.ts` (new) | `UsageEvent` store + `emitUsageEvent` writer + `inferTier` + process-level sink (`installUsageSink`) |
| S7.1 | `packages/core/src/session/runner/publish-llm-event.ts` (edit) | `step-finish` forwards each turn's usage to the sink (additive, dependency-free, no-op until installed) |
| S7.3 | `packages/code-intelligence/src/receipt.ts` (new) | `buildReceipt` / `formatReceipt` — honest $ saved, double-pay subtracted via the S3.6 ledger |
| S7.2 | `.opencode/plugins/econ-status.js` (new) | status-line surface: subscribes to the event stream, surfaces tier + cache-hit + context tokens |
| S7.4 | `docs/sprint7/login-seam.md` | unerr unified-login integration point (scaffold/seam) — full section below |
| — | `packages/code-intelligence/test/{telemetry,receipt}.test.ts` (new) | 84 tests, all green |

## Done-when status

- **S7.1 — DONE.** Every completed turn (`step-finish`) forwards a normalised
  usage payload (cost + tokens + model) to the telemetry sink; `emitUsageEvent`
  builds a `UsageEvent` and appends it to the `TelemetryStore`. No-op until
  `installUsageSink(store)` is called at app bootstrap (see "Remaining wiring").
- **S7.2 — DONE (seam wired, TUI change deferred).** Status data (tier,
  cumulative cache-hit, latest context tokens, spend) is computed and surfaced
  by the `econ-status.js` plugin off the existing event stream — no TUI fork.
  A first-class footer field is a documented deferred follow-up (see
  [Status line — deferred follow-up](#deferred-follow-up-needs-files-outside-the-s7-boundary)).
- **S7.3 — DONE.** `buildReceipt` reads real recorded usage + the double-pay
  ledger and reports `netSavings = grossSavings − totalWastedCost` via
  `DoublePayLedger.effectiveSavings`. Verified by tests including the invariant
  "adding an escalation reduces net savings by exactly the wasted cost".
- **S7.4 — SCAFFOLD/SEAM documented.** See
  [Unified login seam](#unified-login-seam-s74) below.

---

## Telemetry store & usage sink [S7.1]

`packages/code-intelligence/src/telemetry.ts` defines the `UsageEvent` shape,
the `TelemetryStore` that accumulates events, `inferTier` (name-heuristic tier
classification), and `installUsageSink` — a process-level hook the runner
forwards into.

`packages/core/src/session/runner/publish-llm-event.ts` forwards each turn's
usage on `step-finish` to `globalThis.__econUsageSink`. This is additive and
dependency-free: until `installUsageSink` is called, the forward is a no-op, so
`@opencode-ai/core` never compile-depends on the observability modules (see
[Decoupling note](#decoupling-note)).

**Status:** DONE.

---

## Status line [S7.2]

### What the status line shows

Three live numbers for econ's proof surface: **context fill**, **cache-hit
ratio**, and **tier in use** (plus cumulative spend / turn count).

### Recon: where status renders in this fork

This fork's TUI is **TypeScript/Solid, not Go**. Status-shaped surfaces found:

- **Event stream (the data spine).** Every turn publishes
  `session.next.step.ended` with `{ cost, tokens: { input, output, reasoning,
  cache: { read, write } } }`
  (`packages/core/src/session/event.ts`, published in
  `packages/core/src/session/runner/publish-llm-event.ts`). Streamed to clients
  via `GET /api/event` (`packages/server/src/groups/event.ts`).
  `session.next.step.started` carries the **model ref** (`{ id, providerID }`).
- **Existing context-fill render.**
  `packages/tui/src/feature-plugins/sidebar/context.tsx` already computes
  context-fill % = `(sum of latest message tokens) / model.limit.context`.
- **Plugin hooks** (`packages/plugin/src/index.ts`, `Hooks` interface): `event`,
  `chat.message`, `chat.params`, `tool.execute.before/after`, etc. **No
  dedicated `statusline` / `status` hook exists.**

### Decision

Surface econ status via a **new `event`-hook plugin**,
`.opencode/plugins/econ-status.js` — auto-discovered, **zero core/TUI changes**,
inside the Sprint 7 ownership boundary.

It tracks the model from `session.next.step.started`, rolls up tokens/cost from
`session.next.step.ended`, infers the tier (name heuristic mirroring
`telemetry.ts::inferTier`), and surfaces
`tier · context-tokens · cache-hit% · spend · turns`. Cache-hit is cumulative
`cacheRead / (cacheRead + input)`.

This is the same event stream the TUI sidebar already consumes, so econ's status
rides alongside the existing context-fill render without forking it.

### Deferred follow-up (needs files outside the S7 boundary)

A first-class, in-footer status field would be cleaner than plugin logging:

1. **A `message.usage` plugin hook** in `packages/plugin/src/index.ts` — fired
   per assistant turn with `{ usage, tier }`, returning a `statusLine` string.
   (Edits a forbidden core-adjacent file.)
2. **A server route** `GET /api/session/:id/status` in
   `packages/server/src/groups/session.ts` aggregating the latest Step.Ended
   usage + econ tier, which the TUI footer reads.
3. **Precise context-fill %** needs the active model's `limit.context` (from
   provider config). The plugin reports raw latest-token count; the TUI sidebar
   already converts tokens→% and is the right place to add econ's tier badge.

These are tracked for a later sprint; they require touching `packages/plugin`,
`packages/server`, and/or `packages/tui`, which are outside Sprint 7's ownership.

**Status:** DONE (seam wired, TUI footer change deferred).

---

## Savings receipt [S7.3]

`packages/code-intelligence/src/receipt.ts` defines `buildReceipt` /
`formatReceipt` — the honest $ saved, double-pay subtracted via the S3.6
`DoublePayLedger`.

### Receipt format (double-pay subtracted)

`formatReceipt()` renders:

```
econ savings receipt
  turns:        12
  tier split:   cheap 78.0%  oracle 22.0%
  reduction:    78.0%  (1 − large-tier token share 22.0%)
  cache hit:    64.0%
  spent:        $0.4200
  vs frontier:  $1.9000      ← same token volume priced at the frontier baseline
  gross saved:  $1.4800      ← baseline − actual (optimistic)
  double-pay:   −$0.0600 (2 escalations)
  NET SAVED:    $1.4200  (double-pay subtracted)
  catches:
    • src/auth/token.ts → oracle (fan-in 31)
```

Dollar math (only when a `FrontierBaseline` price is supplied):

```
frontierBaselineCost = Σ frontierCostOf(turn.tokens)      // same tokens @ frontier rates
grossSavings         = frontierBaselineCost − actualCost   // optimistic
netSavings           = ledger.effectiveSavings(grossSavings)
                     = grossSavings − ledger.totalWastedCost   // HONEST
```

Why subtract: a discarded cheap attempt's frontier-priced tokens exceed its
cheap cost, so it *masquerades as savings* in the gross figure. Routing through
`effectiveSavings` removes that phantom plus the real waste. Without a baseline
price the receipt still reports the token-share reduction and the tier split —
the headline metric needs no pricing.

**Status:** DONE. `buildReceipt` reads real recorded usage + the double-pay
ledger and reports `netSavings = grossSavings − totalWastedCost` via
`DoublePayLedger.effectiveSavings`. Verified by tests including the invariant
"adding an escalation reduces net savings by exactly the wasted cost".

---

## Per-model cost breakdown (`run --format json`)

The cumulative `cost`/`tokens` on a session answer "what did this run cost";
they don't answer "how did the **three tiers** split it". Because econ routes a
turn across conductor / oracle / executor, the proof surface must show the
**per-model** token + cost split — that split is where the savings story lives
(the cheap conductor carries the bulk; the expensive oracle is a rare tail; the
executor is free). So `econ run --format json` emits a per-model breakdown on
top of the existing per-step events.

**Why we compute cost ourselves.** The upstream `part.cost` on `step_finish`
uses the models.dev catalog price, which is **not** our real cost — we run BYOK
on Fireworks, and the executor is self-hosted. So the breakdown is priced by
econ's own matrix, not the upstream figure.

**The econ cost matrix** (`packages/code-intelligence/src/econ-cost.ts`,
`ECON_COST_MATRIX`, USD per 1M tokens — Fireworks BYOK):

| Tier | Model | input (uncached) | input (cached read) | output |
|---|---|---|---|---|
| conductor | `deepseek/deepseek-v4-flash` | $0.14 | $0.03 | $0.28 |
| oracle / reasoner | `z-ai/glm-5.2` | $1.40 | $0.14 | $4.40 |
| executor | `openai/gpt-oss-20b` | **$0** | **$0** | **$0** |

The executor is **zero** on purpose: in production it runs on econ's own cheap
self-hosted GPUs, so its marginal token cost is ~0. `econStepCost({modelID,
tokens})` applies the matrix: `input×input + cache.read×cachedInput +
cache.write×input + output×output + reasoning×output`, all `/1e6` (cache-write
is billed at the uncached rate — Fireworks lists no separate write price;
reasoning is billed at the output rate, mirroring the upstream cost logic). An
unknown model → 0 (degrade-open). A `modelID` prefixed with `openrouter/`
resolves to the bare key.

**Output shape.** Two additions to the NDJSON stream, both keyed to the tiers
actually used in the run (a run that only touched the conductor shows one tier):

- Each `step_finish` gains `providerID`, `modelID`, and `econCost` (our-matrix
  USD for that step) — alongside the untouched upstream `part.cost`, so an
  external parser can roll up per model live.
- A terminal `cost_breakdown` event once the session goes idle:

```json
{"type":"cost_breakdown","sessionID":"…",
 "cumulative":{"tokens":{"input":…,"output":…,"reasoning":…,"cache":{"read":…,"write":…}},"cost":0.00164},
 "models":{
   "deepseek/deepseek-v4-flash":{"label":"DeepSeek V4 Flash (conductor)","tokens":{…},"cost":0.00164},
   "z-ai/glm-5.2":{"label":"GLM 5.2 (oracle)","tokens":{…},"cost":0.01544}
 }}
```

`cumulative.cost` is the **sum of the per-model econ costs** (not the upstream
figure). In default (non-JSON) mode the same rollup prints one dim line per tier
plus a cumulative line. The run command tracks `messageID → {providerID,
modelID, tokens}` from `message.updated` (each assistant message is exactly one
tier) and buckets by `modelID` at the end — `step_finish` alone carries no model
id, so the map is the join key.

**Status:** DONE. Live-verified via CLI: conductor (uncached **and** prompt-cache
paths priced to the cent), oracle (`glm-5.2`, ~10× the conductor cost for a
similar prompt — the tier split made visible), executor priced at 0. Unit-tested
in `packages/code-intelligence/test/econ-cost.test.ts` (8 cases: each tier, cache
math, unknown-model, prefix resolution, labels).

---

## Exact exports to add to `packages/code-intelligence/src/index.ts`

(index.ts is outside Sprint 7's ownership boundary — add these, grouped:)

```ts
// econ S7.1 telemetry · S7.3 savings receipt (the proof surface)
export {
  TelemetryStore,
  emitUsageEvent,
  installUsageSink,
  inferTier,
  type UsageEvent,
  type UsageEventTokens,
  type UsageTier,
  type UsageTotals,
  type StatusSnapshot,
  type RawUsage,
} from "./telemetry.js"
export {
  buildReceipt,
  formatReceipt,
  type SavingsReceipt,
  type ReceiptInput,
  type ReceiptCatch,
  type FrontierBaseline,
  type TierSplitRow,
} from "./receipt.js"
```

## Remaining wiring (one line, at app bootstrap — outside the boundary)

The runner forwards usage to `globalThis.__econUsageSink`, which is unset until:

```ts
import { TelemetryStore, installUsageSink } from "@opencode-ai/code-intelligence"
const telemetry = new TelemetryStore()
installUsageSink(telemetry /*, emitSavingsEvent */)   // forward → unerr telemetry
```

Pass `emitSavingsEvent` (unerr telemetry core) as the optional `forward` arg to
fan each `UsageEvent` out to unerr. Then `buildReceipt({ store: telemetry,
ledger, baseline })` at end-of-turn produces the receipt.

## Decoupling note

`@opencode-ai/core` does **not** compile-depend on the observability modules —
the runner talks to a typed process-level hook, mirroring double-pay's injected
`emit` pattern. This keeps the engine free of the proof surface and lets tests /
bootstraps install the sink without touching core.

---

## Unified login seam [S7.4]

Goal: one token = econ + unerr. Reuse unerr's credential core + device-flow so a
single login authenticates both the agent and the unerr brain. This section maps
OpenCode's auth path and names the exact integration point to scaffold against.

### Recon: OpenCode's auth/credential path

- **Credential storage** — `packages/core/src/credential.ts` (+
  `packages/core/src/credential/sql.ts`). SQLite via Drizzle. `Credential.Service`
  (Effect): `all()`, `list(integrationID)`, `get(id)`, `create()`, `update()`,
  `remove()`. Token shapes:
  - `Credential.OAuth` = `{ type: "oauth", methodID, refresh, access, expires, metadata? }`
  - `Credential.Key`   = `{ type: "key", key, metadata? }`
  - wrapped as `Credential.Info` = `{ id, integrationID, label, value }`.
- **Login / OAuth flow** — `packages/core/src/integration.ts`:
  `Integration.connection.oauth({ integrationID, methodID, inputs, label? })` →
  `Attempt`; `Integration.attempt.complete({ attemptID, code? })` stores the
  credential. **No device-flow yet** — only code-based OAuth.
- **Provider token resolution at request time** —
  `packages/llm/src/route/auth.ts`. `credentialFromSecret(secret, name)` (~L76),
  `Auth.config(name)` (~L92, reads env via `Config.redacted`), `Auth.bearer(...)`
  builds the `Authorization` header. The request runs in
  `packages/llm/src/route/executor.ts`.
- **`packages/identity`** — empty (only image assets). Not a code seam.

### The seam (where unerr credentials plug in)

**Primary — provider auth resolver:**
`packages/llm/src/route/auth.ts :: credentialFromSecret()`.

Wrap it with a resolver that, before falling back to `Config.redacted()`, checks
for a unerr-managed source (e.g. a `"unerr:"`-prefixed secret name or a
unerr-aware `Config` source) and, when matched, fetches the token from the unerr
sidecar over **UDS** (the `unerrd` Node sidecar the architecture already runs).
Both branches return `Redacted.Redacted`, so no caller changes — the LLM request
machinery is untouched. This is the single point where "one token" reaches every
model call.

**Secondary — unified login command / device-flow:**
`packages/core/src/integration.ts` (the OAuth attempt flow) is where a unerr
**device-flow** would be added as a new method: kick off the unerr device code,
poll, and on success persist via `Credential.Service.create()` as a
`Credential.OAuth`. A thin `login` command (in `packages/cli`) would drive it.
unerr's existing `credentials` core + device-flow (sibling `../unerr-cli`)
supplies the device-code implementation to reuse rather than rebuild.

### Recommended scaffold order (later sprint)

1. Add a `unerr` integration descriptor + a **device-flow** method alongside the
   OAuth method in `integration.ts`; persist the returned token as
   `Credential.OAuth` (refresh/access/expires) via `Credential.Service`.
2. Extend `credentialFromSecret()` in `llm/src/route/auth.ts` to resolve a
   unerr-managed credential from the sidecar (UDS) → `Redacted`.
3. Add a `login` command in `packages/cli` that runs the device-flow once and
   stores the unified token; the same token then satisfies both econ model calls
   and unerr brain auth.

All three are outside Sprint 7's ownership boundary (they edit
`packages/llm/src/route/auth.ts`, `packages/core/src/integration.ts`,
`packages/cli`); this section is the scaffold/seam handoff, not an
implementation.

**Status:** SCAFFOLD/SEAM documented (not implemented).
