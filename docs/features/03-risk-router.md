# Feature: The risk-escalation router (the moat)

**Sprint:** 3 · **Status:** shipped (S3.1–S3.6 implemented and tested; S3.7 reasoner tier layered on top)

## Overview

econ runs a cheap **conductor** model by default and escalates only the hard tail of turns to an
expensive **oracle** — and it decides "hard" from **code-structural risk** (blast-radius, fan-in,
call-graph centrality, complexity), not from guessing at the prompt text the way a generic
model-router would. A **hysteresis** state machine (40/70 risk bands) keeps a noisy mid-band
reading from flapping the tier turn-to-turn, and two extra triggers can force escalation outright:
a **verifier abstention** signal from the conductor ("I'm not sure") and a **per-repo triage**
go/no-go that checks whether cheap-first routing actually pays here. On escalation, the oracle
gets a **compiled brief** — not the raw session transcript — and the router records the **double-pay**
(the wasted cheap attempt plus the oracle cost) so the savings receipt stays honest. An optional
**reasoner** rung sits between conductor and oracle for steps that need chain-of-thought without
paying the oracle's full price.

---

## Capability sections

### Risk score — S3.1

**Module:** `packages/code-intelligence/src/risk.ts`

A 0–100 code-structural risk score computed inline from the bun:sqlite call graph. The score is
**purely structural** — no prompt-text classification, no task-type heuristics. It answers: "how
dangerous is it to edit this entity right now?"

| Factor | Raw value | Ceiling | Weight |
|---|---|---|---|
| `fanIn` | Direct caller count (edges where `to_entity = name`) | 15 callers | **35%** |
| `blastRadius` | Unique caller-file count reachable transitively via BFS (depth ≤ 5) | 30 files | **35%** |
| `centrality` | Connectivity proxy: `fanIn + fanOut` | 20 | **20%** |
| `cx` | Body complexity proxy: `lineEnd − lineStart` (line count) | 100 lines | **10%** |

Each factor is normalized to `[0, 1]` against its ceiling (clamped, not scaled beyond 1), then the
weighted sum is multiplied by 100 and rounded to an integer:

```
score = round(
  0.35 * min(fanIn / 15, 1)
+ 0.35 * min(blastRadius / 30, 1)
+ 0.20 * min(centrality / 20, 1)
+ 0.10 * min(cx / 100, 1)
) * 100
```

`fanIn` and `blastRadius` share 70% because direct and transitive dependents are the clearest
break-risk signal — editing a function with 10 callers is concretely riskier than editing an
isolated leaf. `centrality` at 20% captures hub status (a highly connected entity is expensive to
reason about even if callers are few). `cx` at 10% is a small tiebreaker: large, complex bodies
have more surface area for mistakes.

**Blast-radius BFS.** `blastRadius` is a file-level BFS over the caller graph:

1. Start: the entity's own file is marked visited; the entity name is the initial frontier.
2. Each BFS level: for each name in the frontier, call `getCallers(name)` → collect
   `ref.fromFile` values not yet visited → mark them visited → fetch their entities via
   `getEntitiesInFile(fromFile)` → their names become the next frontier.
3. Stop at depth 5 or when the frontier is empty.
4. Return `visitedFiles.size - 1` (excluding the entity's own file).

O(depth × frontier × edges), bounded by the depth cap.

**unerr-cli lift.** Derived from two unerr-cli modules: `src/intelligence/edit-impact.ts`
(`computeEditImpact`, `EditImpactGraph` — the narrow async graph interface + BFS caller traversal
+ configurable thresholds) and `src/intelligence/health-grade.ts` (`computeScore` — the weighted
multi-factor scoring pattern with explicit ceilings and linear normalization). Key adaptation:
unerr-cli uses CozoDB (Datalog) for graph queries; here we use the bun:sqlite graph surface
(`RiskGraph` interface) and implement BFS in TypeScript rather than Datalog.

**API:**

```typescript
// Single entity
computeRisk(graph: RiskGraph, target: Entity): Promise<RiskResult>
// → { score: 0–100, factors: { blastRadius, fanIn, centrality, cx } }

// Turn-level aggregation (feeds the router, below)
computeTurnRisk(graph: RiskGraph, entities: Entity[]): Promise<TurnRiskResult | null>
// → { score, topEntity, perEntity[] } | null

interface RiskGraph {
  getEntity(key: string): Promise<Entity | null>
  getCallers(entityKey: string): Promise<Reference[]>
  getReferences(entityKey: string): Promise<Reference[]>
  getEntitiesInFile(filePath: string): Promise<Entity[]>
}
```

`BunSqliteGraph` satisfies `RiskGraph` structurally (all four methods implemented, including
`getEntitiesInFile`). `BunSqliteGraph.riskScore(filePath)` delegates to `computeRisk`: calls
`getEntitiesInFile(filePath)`, calls `computeRisk` for each entity, returns `max(scores) / 100` —
normalized to `[0, 1]` to preserve the existing `CodeIntelligence.riskScore` signature.

**Feeding the router.** The router calls `computeTurnRisk` at the start of each routing decision,
passing the entities touched by the current turn:

```typescript
const turnRisk = await computeTurnRisk(graph, entitiesInTurn)
if (turnRisk && turnRisk.score >= ESCALATION_THRESHOLD) {
  return routeToSenior(turn, { reason: "structural-risk", score: turnRisk.score, topEntity: turnRisk.topEntity })
}
```

The `perEntity` breakdown lets the router log which specific entity drove escalation, supporting
the hysteresis and double-pay accounting below.

**Tests** (`packages/code-intelligence/test/risk.test.ts`, synthetic mock graph, no indexing
required): bounds (score ∈ [0, 100] for all entities); separation (high-fan-in entity, 10 callers,
scores > 30; leaf scores < 20); factor values (fanIn, blastRadius, centrality, cx all verified);
`computeTurnRisk` (null on empty, topEntity = max, perEntity sorted descending).

**Done-when:** every turn carries a risk score.

---

### Router + hysteresis — S3.2 (the hub)

**Module:** `packages/code-intelligence/src/router.ts`

The pure `routeTurn` function is where the risk score (S3.1), the abstention signal (S3.3), and
the triage override (S3.5) all converge into one tier decision, with hysteresis so a score
oscillating near a boundary doesn't flap the model tier turn-to-turn.

```typescript
routeTurn(input: RouterInput, config?: RouterConfig): RouterOutput

RouterInput {
  risk: number         // 0–100 from computeTurnRisk (S3.1)
  state: RouterState   // previous tier (hysteresis carrier)
  abstain?: boolean    // S3.3 hook: hold tier without transition
  forceTier?: Tier      // S3.5 hook: bypass risk logic entirely
}

RouterOutput {
  tier: "conductor" | "oracle"   // ("reasoner" also possible once S3.7 is layered in — see below
  reason: string                 //  section)
  state: RouterState   // updated state — callers must persist this
}
```

**Hysteresis state machine:**

```
         risk > 70
    ┌──────────────────────────────►  oracle
    │                                  │
    │                    risk < 40     │
    │  ◄────────────────────────────────┘
 conductor
    │
    │  40 ≤ risk ≤ 70 → HOLD (no-flap zone)
    └─────────────────────────────────────►  (stay in current tier)
```

| Band | Default threshold | Action |
|------|------------------|--------|
| High  | risk > 70        | Escalate to oracle |
| Low   | risk < 40        | De-escalate to conductor |
| Mid   | 40 ≤ risk ≤ 70   | Hold current tier (no flap) |

Both thresholds are configurable via `RouterLayerConfig.routerConfig`.

**Evaluation order** (each hook below is owned by its own sprint slice, documented in its own
section further down):

1. `forceTier` (S3.5 triage) — immediate return, skips everything else
2. `abstain` (S3.3) — hold without recording a transition
3. `risk > escalateAbove` → oracle
4. `risk < deescalateBelow` → conductor
5. mid-band → hold current tier

**Fork point.** File: `packages/core/src/session/runner/model.ts`. Added
`locationLayerWith(config: RouterLayerConfig)` — the fork; `locationLayer` is now
`locationLayerWith({})` (degrade-open default). The fork sits at the top of the `resolve`
function body inside `locationLayerWith`, before the existing S1.1 chain runs:

```typescript
// packages/core/src/session/runner/model.ts — inside locationLayerWith closure
let routedAgentModel = undefined
if (!session.model) {                           // explicit overrides always win
  const risk = yield* riskProvider(session)    // injected; defaults to 0
  const prevState = routerStateMap.get(session.id) ?? defaultRouterState
  const { tier, state: nextState } = routeTurn({ risk, state: prevState }, routerCfg)
  routerStateMap.set(session.id, nextState)
  routedAgentModel = (yield* agents.resolve(AgentV2.ID.make(tier)))?.model
}

// S1.1 chain (preserved as fallback):
const agentModel = session.model
  ? undefined
  : routedAgentModel ?? (yield* agents.resolve(session.agent))?.model
```

**Degrade-open behavior.** The system never crashes when no risk signal is available:

| Scenario | Behavior |
|----------|----------|
| No `riskProvider` injected | Default provider returns 0 → conductor always selected |
| `riskProvider` injected but returns 0 | Same: conductor |
| Tier agent not configured in opencode.json | `agents.resolve(tier)` returns `undefined` → falls through to S1.1 agent-model chain |
| Oracle agent in config but no model | `tierAgent?.model` is `undefined` → falls through |

Restarting the process resets hysteresis state to `{ tier: "conductor" }` — cost-safe.

**Hysteresis state persistence.** State is kept in an in-memory `Map<sessionID, RouterState>`
inside the `locationLayerWith` closure, created once per layer instance. Router state is
*transient* — a restart defaulting to conductor is cost-safe (one extra mid-tier turn, not a
costly oracle turn), and it avoids migration/I-O on every turn. If cross-restart persistence is
ever needed, wire into S1.3 `SessionCanonicalState.setScratchpad` with key `"router.tier"` at the
`routerStateMap.set` site — no interface changes needed.

**Tier → model mapping** (`opencode.json` `agents` block):

| Tier | Agent ID | Model | Sprint |
|------|----------|-------|--------|
| conductor | `conductor` | `openrouter/qwen/qwen3-coder` | S1.1 |
| oracle | `oracle` | `openrouter/deepseek/deepseek-r1` | S3.2 |
| reasoner | `reasoner` | `openrouter/qwen/qwen3-30b-a3b:thinking` | S3.7 |

Adding more tiers later is purely a config change (new agent entry).

**Tests:** `packages/code-intelligence/test/router.test.ts` (24 pure router tests),
`packages/core/test/session-runner-model-router.test.ts` (5 integration tests).

**Done-when:** high-risk escalates, low-risk stays cheap, mid-band doesn't flap.

**Files changed:** `packages/code-intelligence/src/router.ts` (new — pure `routeTurn` + types),
`packages/code-intelligence/src/index.ts` (re-exports), `packages/core/src/session/runner/model.ts`
(`locationLayerWith` fork), `packages/core/package.json` (added
`@opencode-ai/code-intelligence: workspace:*`), `opencode.json` (added `oracle` agent).

---

### Abstention — S3.3

**Module:** `packages/code-intelligence/src/abstention.ts`

When the cheap conductor is unsure about its own answer — even on a structurally low-risk turn —
the system must escalate rather than serve a low-confidence answer. This is the verifier
abstention signal: the conductor voluntarily opts out so the oracle takes over.

**Abstention contract** — the conductor signals abstention by including any one of the following
in its turn result (`ConductorResult`), checked in this priority order (first match wins):

| Signal | Field | Condition |
|--------|-------|-----------|
| Structured flag | `abstain: true` | Explicit boolean; highest priority |
| Sentinel token | `text` containing `[[ABSTAIN]]` or `[[UNSURE]]` | Case-insensitive on the token name; brackets required |
| Low confidence | `confidence: number` in \[0, 1\] | Strictly below `CONFIDENCE_THRESHOLD` (default **0.5**) |

A missing field is never treated as abstention — the check is opt-in from the conductor side.

```typescript
// Examples
{ abstain: true }                                              // 1. explicit flag
{ text: "I cannot determine the correct edit here. [[ABSTAIN]]" } // 2. sentinel token
{ confidence: 0.3 }                                             // 3. low-confidence numeric field
{ abstain: true, confidence: 0.2, text: "Not sure. [[UNSURE]]" } // 4. combined — flag wins
```

**Routing through the router's `forceTier` hook.** The abstention module is a thin
pre-processing layer that translates conductor signals into the `forceTier` value the router (S3.2)
already understands — no change to `router.ts` was required:

```
ConductorResult
      │
      ▼
detectAbstention(conductorResult)   → AbstentionResult { abstained, confidence?, reason? }
      │
      ▼
escalationFromAbstention(abstention) → { forceTier?: "oracle" }
      │
      ▼
routeTurn({ risk, state, forceTier })
      ├─ forceTier="oracle" present → tier="oracle"  (bypasses risk bands)
      └─ forceTier absent           → normal hysteresis logic
```

**API:**

```typescript
detectAbstention(conductorResult: ConductorResult): AbstentionResult
escalationFromAbstention(abstention: AbstentionResult): { forceTier?: "oracle" }

interface ConductorResult {
  text?:      string   // scanned for [[ABSTAIN]] / [[UNSURE]]
  confidence?: number  // [0, 1]; < CONFIDENCE_THRESHOLD → abstain
  abstain?:   boolean  // explicit flag
}

interface AbstentionResult {
  abstained:   boolean
  confidence?: number
  reason?:     string
}

const CONFIDENCE_THRESHOLD = 0.5   // configurable by importing module
```

**Caller integration pattern:**

```typescript
import { detectAbstention, escalationFromAbstention } from "./abstention.js"
import { routeTurn } from "./router.js"

const abstention = detectAbstention(conductorResult)
const { forceTier } = escalationFromAbstention(abstention)
const routing = routeTurn({ risk, state, forceTier })
// routing.tier is "oracle" if conductor abstained, else risk-band logic applies.
```

**Design decisions:**
- Three signals, any one sufficient — different model families expose different confidence
  interfaces, so supporting all three keeps the conductor integration format-agnostic.
- Threshold default 0.5 — a conservative mid-point; below 50% confidence the conductor is
  effectively guessing and the oracle should take over. Callers may import
  `CONFIDENCE_THRESHOLD` to apply a different threshold in their own logic.
- Opt-in signals only — the absence of a confidence field is never treated as abstention, so
  existing conductor integrations that don't emit confidence are unaffected.

**Done-when:** an explicit "unsure" escalates.

---

### Compiled brief — S3.4

**Module:** `packages/code-intelligence/src/brief.ts`

The oracle (large-tier model) is the most expensive tier in the cost-routing stack. Its token
share is the dominant term in the savings identity, `reduction ≈ f × (1 − 1/r)`, where `f` is the
fraction of turns handled by the oracle and `r` is the price ratio. Keeping the oracle's context
compact — replacing raw session transcripts with a structured brief — directly reduces `f` and
shrinks each oracle call's token count. `brief.ts` is the pure assembler that produces this brief;
it accepts structured inputs only — there is no `rawTranscript` field.

**`OracleBrief` shape:**

```ts
interface OracleBrief {
  text: string            // Plain-text brief the oracle receives
  estimatedTokens: number // estimateTokens(text)
  tokenBudget: number     // Budget applied during assembly
  trimmed: boolean        // True when any slice/attempt was truncated
}
```

**Brief schema — section ordering** (fixed order regardless of input size):

| # | Section | Always included? | Trimmed? |
|---|---------|-----------------|---------|
| 1 | `## Problem` | Yes | Never |
| 2 | `## Question` | Yes | Never |
| 3 | `## Expected Output Shape` | Yes | Never |
| 4 | `## Context Slices` | Only when slices are provided | Yes — greedily per slice |
| 5 | `## Prior Attempts` | Only when attempts are present | Yes — as a block |

The oracle always sees the core directive (sections 1–3) before any supporting context.
Sections 4–5 are elided entirely if their budget allocation reaches zero.

**Budget policy:**

| Parameter | Default | Notes |
|---|---|---|
| Total budget | 8 000 tokens | Override via `BriefInput.tokenBudget` |
| Fixed sections 1–3 | Always included | Consume ~60–120 tokens typically |
| Header overhead reserve | 60 tokens | Structural newlines + headings |
| Slice budget | 60% of remaining | Greedy in input order; each slice gets what's left |
| Attempt budget | 40% of remaining | Trimmed as a single block via smartTruncate |

Token estimation uses `estimateTokens` from `trim.ts` (content-aware char heuristic, ±10–20%).
The smartTruncate head+tail strategy is used for both slices and the attempts block, so the
most-informative ends are retained even when the middle is elided.

**`BriefInput` — structured API:**

```ts
interface BriefInput {
  problem: string               // Problem statement (always emitted)
  question: string              // Specific question for the oracle (always emitted)
  outputShape: string           // Expected output format (always emitted)
  slices: readonly string[]     // Code/context slices (trimmed to budget)
  attempts: readonly AttemptSummary[] // Prior attempts (trimmed to budget)
  tokenBudget?: number          // Defaults to 8 000
}
```

There is no `rawTranscript` field. The API is the enforcement boundary: a caller cannot inject a
raw conversation history without first decomposing it into the structured fields above.

**`briefFromContext` — convenience adapter:**

```ts
function briefFromContext(
  recon: ReconBundle,
  canonicalState: CanonicalStateFragment,
  question: string,
  outputShape: string,
  opts?: { problem?: string; tokenBudget?: number },
): OracleBrief
```

| Source | Mapped to |
|---|---|
| `recon.notes` | Slices (first, highest priority — carry conventions) |
| `recon.entities` | Slices (entity kind + name + file + signature + domain) |
| `recon.references` | Not included (callers visible via entity slices) |
| `canonicalState.attempts[].payload` | `AttemptSummary[]` (task / status / error) |

`CanonicalStateFragment` is a structurally-compatible subset of
`SessionCanonicalState.CanonicalState` — no Effect imports, no DB deps.

**How the router hands off to the oracle.** On escalation the router (S3.2) calls `recon(task)`
on the code-intelligence port to get the `ReconBundle`, reads the session's `CanonicalState`
fragment from S1.3, and passes both to `briefFromContext`:

```
riskRouter (S3.2)
  └─► recon(task)           → ReconBundle
  └─► canonicalState.load() → CanonicalStateFragment
  └─► briefFromContext(...)  → OracleBrief
  └─► oracleCall(brief.text) [token budget enforced]
```

The governance gate sees the same `OracleBrief.text` as its input when verifying the oracle's
proposed edit — not the raw transcript — which keeps the gate's context window similarly bounded.

**Tests:** `packages/code-intelligence/test/brief.test.ts` — 25 assertions across structural,
no-transcript, budget, and adapter groups.

**Done-when:** oracle gets a brief, returns decision/patch.

**Files delivered:** `packages/code-intelligence/src/brief.ts` (`compileBrief`, `briefFromContext`,
`OracleBrief`, `BriefInput`, `AttemptSummary`, `CanonicalStateFragment`). Note:
`packages/code-intelligence/src/index.ts` was not touched by this slice (S3.1/S3.6 own that
integration); `packages/core` was read-only (canonical-state shape only).

---

### Per-repo triage — S3.5

**Module:** `packages/code-intelligence/src/triage.ts`

Before any session starts, decide whether cheap-first routing pays for *this specific repo*.
Rather than blindly defaulting to the conductor tier, `triageRepo` checks whether observed
pass-rate data and signal quality together justify the cheap-first bet.

**Go/No-Go inequality.** Cheap-first routing pays iff all three conditions hold:

```
cheapPassRate > 1 / costRatio          (pass-rate clears the break-even point)
signalDiscrimination >= 0.6            (risk signal separates pass from fail)
sampleSize >= 30                       (statistics are reliable)
```

*Why `cheapPassRate > 1/costRatio`.* Expected cost per turn under cheap-first routing:

```
E[cost] = cheapPassRate × C_cheap + (1 − cheapPassRate) × C_oracle
```

Cheap-first beats oracle-first (`C_oracle`) when `E[cost] < C_oracle`, which simplifies:

```
cheapPassRate × C_cheap < cheapPassRate × C_oracle
cheapPassRate > C_cheap / C_oracle
cheapPassRate > 1 / costRatio
```

So `1/costRatio` is the break-even pass-rate; below it, routing costs more than always using the
oracle.

*Why `signalDiscrimination >= 0.6`.* The pass-rate inequality tells us *how often* cheap works.
The discrimination check tells us whether the risk signal can *predict* when cheap will fail —
without that, we can't selectively escalate and the router degrades to a coin flip. 0.6 is set
above random (0.5) with a margin; a perfect predictor scores 1.0.

*Why `sampleSize >= 30`.* Both `cheapPassRate` and `signalDiscrimination` are estimated from
observed data. Fewer than 30 turns makes both estimates unreliable. Below this floor, triage falls
back to degrade-open.

**Degrade-open rule.** On any missing or degenerate signal → default to cheap-first, never crash.
Triggers: any stat is `NaN` or `Infinity`; `sampleSize < 1` (no data at all); `sampleSize <
MIN_SAMPLE_SIZE` (too few samples to trust); `costRatio <= 0` (degenerate: would divide by zero).
Return: `{ decision: "cheap-first", reason: "insufficient signal" }`. Rationale: we never have
enough information to confidently force the oracle at repo initialisation; defaulting cheap is
safe because the per-turn risk router (S3.2) still escalates individual high-risk turns. Forcing
oracle on bad data would silently drain savings.

**Feeding the router's `forceTier` hook.** `triageRepo` returns `{ decision, forceTier?, reason }`.
`forceTier` passes directly into `routeTurn`'s override hook:

```typescript
const triage = triageRepo(repoStats)

const routeOutput = routeTurn({
  risk: currentRisk,
  state: sessionState,
  forceTier: triage.forceTier,   // "oracle" when oracle-first, undefined when cheap-first
})
```

When `forceTier` is `"oracle"`, `routeTurn` bypasses all hysteresis and risk logic and returns the
oracle tier immediately (evaluation step 1 in router.ts). When `forceTier` is `undefined`
(cheap-first), normal hysteresis applies and per-turn risk still drives escalation.

**API:**

```typescript
triageRepo(stats: TriageStats, options?: { minSampleSize?: number; minDiscrimination?: number })
  → TriageResult

interface TriageStats {
  cheapPassRate: number          // 0–1
  costRatio: number              // oracle / conductor cost ratio (e.g. 5)
  signalDiscrimination: number   // 0–1 AUC / separation score
  sampleSize: number             // number of observed turns
}

interface TriageResult {
  decision: "cheap-first" | "oracle-first"
  forceTier?: "oracle"           // set only when oracle-first
  reason: string
}
```

Default thresholds (overridable via `options`): `MIN_SAMPLE_SIZE = 30`, `MIN_DISCRIMINATION = 0.6`.

**Done-when:** triage forces oracle where cheap won't pay; missing signal → cheap, never crash.

---

### Double-pay accounting — S3.6

**Module:** `packages/code-intelligence/src/double-pay.ts` · **Date:** 2026-06-27

When the router (S3.2) decides mid-turn that the cheap conductor cannot handle a task and invokes
the oracle, two model calls are billed for one logical turn: the cheap attempt **and** the oracle
response. Reporting only oracle cost makes savings look better than they are. This module records
both costs so the S7 savings receipt can subtract the wasted spend and show an honest net figure.

**Event shape — `EscalationCost`:**

```typescript
interface EscalationCost {
  turnId: string

  cheap: {
    tier: "cheap"
    model: string          // e.g. "qwen/qwen-2.5-coder-32b-instruct"
    cost: number           // USD; sourced from Usage.cost (S0.3)
    tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  }

  oracle: {
    tier: "oracle"
    model: string          // e.g. "anthropic/claude-opus-4"
    cost: number
    tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  }

  totalCost: number        // cheap.cost + oracle.cost — the honest per-turn bill
  wastedCost: number       // cheap.cost — money burned on the discarded attempt
}
```

Invariants (always true): `totalCost === cheap.cost + oracle.cost`; `wastedCost === cheap.cost`.

**Module API:**

`recordEscalation(input: EscalationInput): EscalationCost` — builds the record and calls an
optional `emit` callback synchronously. Pure function, no I/O. The router calls this inside the
escalation branch after the oracle response arrives (both costs are then known):

```typescript
const record = recordEscalation({
  turnId: session.currentTurnId,
  cheap:  { model: cheapModel,  cost: cheapUsage.cost ?? 0,  tokens: cheapTokens  },
  oracle: { model: oracleModel, cost: oracleUsage.cost ?? 0, tokens: oracleTokens },
  emit:   (r) => emitSavingsEvent("escalation", r),   // injected at wiring time
})
```

`DoublePayLedger` — in-memory aggregator, one instance per session; the router adds every
escalation record:

```typescript
const ledger = new DoublePayLedger()
ledger.add(record)            // called by the router on each escalation

ledger.escalations            // count of escalated turns
ledger.totalWastedCost        // Σ cheap.cost across all escalations
ledger.effectiveSavings(gross) // gross − totalWastedCost → honest net
ledger.snapshot()             // { escalations, totalWastedCost } — safe to log
```

**Wiring point — router.** Inside the escalation branch of the cost-routing engine (the point
where the router decides the cheap model's answer is insufficient and the oracle must re-answer):

```typescript
import { recordEscalation } from "@opencode-ai/code-intelligence/src/double-pay.ts"

// After oracle responds:
const record = recordEscalation({
  turnId:  turn.id,
  cheap:   { model: cheapModel, cost: cheapStep.cost ?? 0, tokens: cheapStep.tokens },
  oracle:  { model: oracleModel, cost: oracleStep.cost ?? 0, tokens: oracleStep.tokens },
  emit:    sessionLedger.add.bind(sessionLedger),   // or inject emitSavingsEvent here
})
```

`cheapStep.cost` comes from `SessionEvent.Step.Ended.cost`, which S0.3 wired to `Usage.cost`
flowing from the OpenRouter wire.

**Savings receipt — subtracting double-pay.** The receipt accumulates gross savings (oracle
reference price minus cheap price) for every turn that succeeded on the cheap model. Before
displaying:

```typescript
const display = {
  grossSavings:     router.grossSavings,
  doublePayPenalty: sessionLedger.totalWastedCost,
  effectiveSavings: sessionLedger.effectiveSavings(router.grossSavings),
  escalations:      sessionLedger.escalations,
}
```

`effectiveSavings` can go negative in a pathological session (many escalations, few cheap
successes) — the receipt surfaces that honestly rather than clamping to zero, so users can see the
router performing poorly.

**Dependency boundary:** no imports from `packages/core` or `packages/llm` — callers extract the
`cost`/token numbers from `Usage` and pass plain values, keeping the accounting module decoupled.
No I/O — `emit` is pluggable; the default (omitted) is a no-op.
`packages/code-intelligence/src/index.ts` not modified by this slice — import by path
(`../src/double-pay.ts`) until the index export is coordinated with S3.1/S3.4.

**Tests:** `packages/code-intelligence/test/double-pay.test.ts` — shape, accumulation, savings
adjustment, mixed-session scenario.

**Done-when:** escalations record both costs.

---

### Reasoner mode — S3.7 (optional rung)

**Modules:** `packages/code-intelligence/src/router.ts` (extended), `packages/code-intelligence/src/reasoner.ts` (new)

An optional **reasoner** tier — a mid-size thinking model (chain-of-thought) — sits between the
cheap conductor and the expensive oracle. CoT is paid **only on explicitly flagged hard steps**,
never as a default tax on every turn.

**Three-rung ladder:**

```
conductor (cheap, no CoT)
    │  hardStep=true
    ▼
reasoner (mid, CoT — thinking model)
    │  alreadyTriedReasoner=true  OR  risk > 70
    ▼
oracle   (frontier, large model)
```

| Tier | When selected | CoT paid? |
|------|--------------|-----------|
| conductor | `hardStep` absent/false, risk ≤ escalateAbove | No |
| reasoner  | `hardStep=true`, `alreadyTriedReasoner=false`, risk ≤ escalateAbove | Yes (mid cost) |
| oracle    | risk > escalateAbove **or** (`hardStep=true` and `alreadyTriedReasoner=true`) | Yes (high cost) |

Risk-band hysteresis (conductor ↔ oracle, thresholds 40/70, S3.2) is unchanged — the reasoner tier
is layered on top via the explicit `hardStep` signal, so normal turns never change routing
behaviour.

**Hard-step signal contract.** The conductor (or any caller) sets `hardStep: true` on a
`RouterInput` when the current step requires structured reasoning. The signal is step-local — it
must be explicitly passed each call; it is never inferred from history.

```typescript
// packages/code-intelligence/src/router.ts
routeTurn({ risk, state, hardStep: true, alreadyTriedReasoner: false }) // → { tier: "reasoner", ... }
routeTurn({ risk, state, hardStep: true, alreadyTriedReasoner: true })  // → { tier: "oracle", ... }
```

The dedicated pure function in `reasoner.ts` encodes the same contract and can be called
independently of `routeTurn` when step-level routing is needed:

```typescript
// packages/code-intelligence/src/reasoner.ts
decideReasoner({ risk, hardStep, alreadyTriedReasoner })
// → { tier: "conductor" | "reasoner" | "oracle", reason: string }
```

**Hysteresis safety.** A `"reasoner"` tier in `RouterState` de-escalates to conductor on the next
mid-band turn that carries no `hardStep` signal — CoT is never accidentally inherited across
turns:

```
turn N:   hardStep=true  → reasoner  (state.tier = "reasoner")
turn N+1: hardStep unset → conductor (mid-band: reasoner → conductor mapping)
```

No conductor ↔ reasoner flapping: reasoner is entered only on an explicit signal, never by
crossing a risk band.

**Model (`opencode.json`):**

```json
"reasoner": {
  "model": "openrouter/qwen/qwen3-30b-a3b:thinking",
  "description": "econ reasoner tier: mid-size thinking model for hard steps needing CoT (S3.7)",
  "mode": "primary"
}
```

Placeholder — swap for any Qwen3-thinking or DeepSeek-R1-distill variant on OpenRouter.
Recommended alternatives: `openrouter/qwen/qwen3-30b-a3b:thinking` (Qwen3 30B-A3B MoE, thinking
mode) or `openrouter/deepseek/deepseek-r1-distill-qwen-32b` (distilled R1, smaller cost than full
R1).

**Tests:** `packages/code-intelligence/test/reasoner.test.ts` — 16 tests for `decideReasoner` +
`routeTurn` reasoner integration.

**Done-when:** a hard step can use chain-of-thought without paying it every turn.

---

## Routing decision diagram

Adapted from `docs/architecture/ECON_ARCHITECTURE.md` §4, kept faithful to sprint 3's actual
thresholds, hooks, and tier set:

```
            ┌──────────────────────────────────────────────┐
   turn ──▶ │ compute risk score from the code graph (S3.1) │
            │ (blast-radius · fan-in · centrality · cx)     │
            └───────────────┬───────────────────────────────┘
                            ▼
        forceTier set (S3.5 triage) ─────────────────────▶ that tier, bypass everything else
                            │
                            ▼ (no forceTier)
        abstain=true (S3.3 verifier) ────────────────────▶ hold current tier, skip risk eval
                            │
                            ▼ (no abstain)
        hardStep=true (S3.7) ──▶ alreadyTriedReasoner=false ──▶ REASONER (mid, CoT)
                            │       alreadyTriedReasoner=true ──▶ ORACLE
                            ▼ (no hardStep)
        score < 40  ─────────────────────────────────────▶ CONDUCTOR handles it (cheap)
        40 ≤ score ≤ 70 ────────────────────────────────▶ hysteresis: keep current tier (no flap)
        score > 70  ────────────────────────────────────▶ ORACLE
                                                              │
                                                              ▼
                                          build brief (S3.4: Problem/Question/Output-Shape/
                                          Context-Slices/Prior-Attempts, budget-bounded)
                                                              │
                                                              ▼
                                                oracleCall(brief.text) ─▶ integrate ─▶ continue
                                                              │
                                                              ▼
                                    record double-pay (S3.6: cheap.cost + oracle.cost,
                                    wastedCost = cheap.cost) into the savings receipt
```

The `forceTier` and `abstain` fields are both carried on the same `RouterInput` the risk score and
hysteresis state travel on (S3.2) — there is no separate code path per hook, just evaluation-order
precedence inside `routeTurn`.

---

## Cross-cutting notes

- **Router is the hub.** S3.1 supplies the `risk` field, S3.3 and S3.5 both resolve to the same
  `forceTier`/`abstain` fields on `RouterInput`, S3.7 extends the tier enum and adds
  `hardStep`/`alreadyTriedReasoner`, and S3.6 is called from the router's escalation branch after
  the oracle responds. No sibling slice needed a `router.ts` signature break except S3.7 (additive
  fields only).
- **Everything degrades open.** Missing risk provider → 0 (conductor). Missing/degenerate triage
  stats → cheap-first. Unconfigured tier agent → falls through to the pre-S3.2 agent-model chain.
  A crash is never an acceptable failure mode for a cost optimization.
- **Cost honesty end to end.** The compiled brief (S3.4) keeps the oracle's *input* token cost
  bounded; double-pay accounting (S3.6) keeps the *reported savings* honest by charging back the
  wasted cheap attempt on every escalation.

## Files (all sprint-3 modules)

| File | Role |
|---|---|
| `packages/code-intelligence/src/risk.ts` | `computeRisk`, `computeTurnRisk` — S3.1 |
| `packages/code-intelligence/src/router.ts` | `routeTurn`, `Tier`, `RouterInput`/`RouterOutput` — S3.2, extended by S3.7 |
| `packages/code-intelligence/src/abstention.ts` | `detectAbstention`, `escalationFromAbstention` — S3.3 |
| `packages/code-intelligence/src/brief.ts` | `compileBrief`, `briefFromContext`, `OracleBrief` — S3.4 |
| `packages/code-intelligence/src/triage.ts` | `triageRepo` — S3.5 |
| `packages/code-intelligence/src/double-pay.ts` | `recordEscalation`, `DoublePayLedger` — S3.6 |
| `packages/code-intelligence/src/reasoner.ts` | `decideReasoner` — S3.7 |
| `packages/core/src/session/runner/model.ts` | `locationLayerWith` fork point — S3.2 |
| `opencode.json` | `oracle` + `reasoner` agent entries |

## Tests

| File | Coverage |
|---|---|
| `packages/code-intelligence/test/risk.test.ts` | bounds, separation, factor values, `computeTurnRisk` |
| `packages/code-intelligence/test/router.test.ts` | 24 pure `routeTurn` tests |
| `packages/core/test/session-runner-model-router.test.ts` | 5 integration tests |
| `packages/code-intelligence/test/abstention.test.ts` | `detectAbstention` + `escalationFromAbstention` signal detection |
| `packages/code-intelligence/test/brief.test.ts` | 25 assertions — structural, no-transcript, budget, adapter |
| `packages/code-intelligence/test/triage.test.ts` | go/no-go inequality, degrade-open triggers |
| `packages/code-intelligence/test/double-pay.test.ts` | shape, accumulation, savings adjustment, mixed-session |
| `packages/code-intelligence/test/reasoner.test.ts` | 16 tests — `decideReasoner` + router reasoner integration |

## Source documents

This feature doc consolidates the former `S3.1-risk-score.md` through
`S3.7-reasoner.md` sprint-log docs, which have since been removed.
