# Sprint 7 — the proof surface (status line · savings receipt · telemetry)

econ's product surface is observability: we **count savings, we don't promise**
them. Sprint 7 wires per-turn usage into a telemetry store, derives the live
status line, and produces an **honest** end-of-turn savings receipt with
double-pay subtracted.

Guiding facts (anchored): savings are driven by the large-tier **TOKEN** share,
not call count, so `reduction ≈ 1 − large-tier token share`; and an escalated
turn double-pays (cheap attempt discarded), which the receipt must subtract.

## Files

| Task | File | What |
|---|---|---|
| S7.1 | `packages/code-intelligence/src/telemetry.ts` (new) | `UsageEvent` store + `emitUsageEvent` writer + `inferTier` + process-level sink (`installUsageSink`) |
| S7.1 | `packages/core/src/session/runner/publish-llm-event.ts` (edit) | `step-finish` forwards each turn's usage to the sink (additive, dependency-free, no-op until installed) |
| S7.3 | `packages/code-intelligence/src/receipt.ts` (new) | `buildReceipt` / `formatReceipt` — honest $ saved, double-pay subtracted via the S3.6 ledger |
| S7.2 | `.opencode/plugins/econ-status.js` (new) | status-line surface: subscribes to the event stream, surfaces tier + cache-hit + context tokens |
| S7.4 | `docs/sprint7/login-seam.md` | unerr unified-login integration point (scaffold/seam) |
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
  `status-line.md`).
- **S7.3 — DONE.** `buildReceipt` reads real recorded usage + the double-pay
  ledger and reports `netSavings = grossSavings − totalWastedCost` via
  `DoublePayLedger.effectiveSavings`. Verified by tests including the invariant
  "adding an escalation reduces net savings by exactly the wasted cost".
- **S7.4 — SCAFFOLD/SEAM documented.** See `login-seam.md`.

## Receipt format (double-pay subtracted)

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
