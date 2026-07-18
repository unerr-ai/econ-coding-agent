# Feature: The conductor core loop

The conductor core is econ's plan → edit → verify loop, run on open-source models
end to end. A single capable mid-tier OSS model — the **conductor** — is wired as the
default reasoner so every turn starts cheap instead of defaulting to a frontier model.
Graph-navigation tools (`recon`, `graph_file_read`, `get_references`) are the primary
way the conductor reads the repo, replacing blind file reads with call-graph queries.
Working state — ledger, scratchpad, attempt history — is persisted outside the context
window in a dedicated SQLite table so it survives compaction, and an eval harness pins
which model fills each tier (conductor / executor / oracle) by evidence — pass rate,
latency, tokens, cost — rather than assertion.

## Loop overview

```
                         ┌────────────────────────┐
                         │   eval harness (S1.4)   │
                         │  scores model candidates│
                         │  per tier → shortlist    │
                         └───────────┬─────────────┘
                                     │ pins model choice
                                     ▼
        ┌────────────────────────────────────────────────┐
        │        conductor (default reasoner, S1.1)       │
        │   default_agent="conductor" → openrouter/qwen   │
        └───────┬───────────────────────────┬─────────────┘
                │ navigates repo via         │ appends/reads
                ▼                            ▼
   ┌────────────────────────┐   ┌─────────────────────────────┐
   │   graph tools (S1.2)   │   │  canonical state store (S1.3)│
   │ recon / graph_file_read│   │ session_canonical_state:      │
   │ / get_references        │   │  ledger / scratchpad / attempt│
   │  → BunSqliteGraph        │   │  survives compaction          │
   └────────────────────────┘   └─────────────────────────────┘
                │                            │
                └──────────── plan → edit → verify ──────────────▶ next turn
```

The conductor reasons using the graph tools instead of raw reads, records each
significant decision to canonical state so a compaction never loses working context,
and the model behind "conductor" (and the executor/oracle tiers it can escalate to)
is chosen by the eval harness rather than hardcoded by assumption.

---

## Shared config: OpenRouter + Qwen

Both the conductor default (S1.1) and the eval harness (S1.4) target **OpenRouter** as
the provider and **Qwen** models as the recommended candidates per tier. This is stated
once here; both sections below reference it instead of repeating the block.

```jsonc
// opencode.json (repo root)
{
  "default_agent": "conductor",
  "agents": {
    "conductor": {
      "model": "openrouter/qwen/qwen3-coder",
      "description": "econ default conductor: mid-tier OSS model for everyday coding turns",
      "mode": "primary"
    }
  },
  "providers": {
    "openrouter": {
      "name": "OpenRouter",
      "env": ["OPENROUTER_API_KEY"],
      "api": {
        "type": "aisdk",
        "package": "@ai-sdk/openai-compatible",
        "url": "https://openrouter.ai/api/v1"
      }
    }
  }
}
```

Recommended per-tier candidates (overridable via env, see [Eval harness](#s14--eval-harness-model-candidate-pinning)):

| Tier | Env var | Default model |
|---|---|---|
| conductor | `ECON_CONDUCTOR_MODEL` | `qwen/qwen3-32b` |
| executor | `ECON_EXECUTOR_MODEL` | `qwen/qwen2.5-coder-32b-instruct` |
| oracle | `ECON_ORACLE_MODEL` | `qwen/qwen3-8b` |

A live run of either the conductor default or the eval harness's real-provider mode
requires `OPENROUTER_API_KEY` set to a valid key with the target model available on
the account. Without it, model resolution still succeeds (the model exists in the
catalog from the `providers.openrouter` block) but the LLM call fails at request time
with an auth error.

---

## S1.1 — Conductor as default reasoner

Makes a mid-tier OSS model (`openrouter/qwen/qwen3-coder`) the default "conductor"
reasoner via the `model.ts` resolution chain, so every turn without an explicit
override runs on the cheap tier by default.

### Resolution path (file:line cites)

```
opencode.json
  └─ default_agent: "conductor"
  └─ agents.conductor.model: "openrouter/qwen/qwen3-coder"

  ── boot ──▶  packages/core/src/config/plugin/agent.ts:60-61
                ConfigAgentPlugin reads Config.latest(docs, "default_agent")
                → draft.default(AgentV2.ID.make("conductor"))
                → sets conductor as the selection-default in AgentV2 state

              packages/core/src/config/plugin/agent.ts:77-79
                draft.update("conductor", agent => agent.model = {
                  id: "qwen/qwen3-coder", providerID: "openrouter"
                })

  ── per turn ──▶  packages/core/src/session/runner/llm.ts:173
                    const agent = yield* agents.select(session.agent)
                    // session.agent is undefined → selectedDefault() → conductor

                  packages/core/src/session/runner/llm.ts:190
                    const model = yield* models.resolve(session)

                  packages/core/src/session/runner/model.ts:locationLayer (S1.1 change)
                    const agentModel = (yield* agents.resolve(session.agent))?.model
                    // → { id: "qwen/qwen3-coder", providerID: "openrouter" }
                    const effectiveModel = session.model ?? agentModel
                    // → catalog.model.available().find(m => m.providerID==="openrouter"
                    //                                      && m.id==="qwen/qwen3-coder")
```

**Priority chain** (first non-undefined wins):
1. `session.model` — per-session override (user picked a different model)
2. active agent's `model` ref — conductor's `openrouter/qwen/qwen3-coder`
3. `catalog.model.default()` — site-wide `model:` key in opencode.json
4. first supported available catalog model — last-resort fallback

### What was changed

| File | Change |
|---|---|
| `packages/core/src/session/runner/model.ts` | Added `AgentV2.Service` dependency to `locationLayer`; resolution now consults `agents.resolve(session.agent)?.model` as priority #2 before the catalog default |
| `packages/core/test/session-runner-model.test.ts` | Added `describe("SessionRunnerModel.locationLayer")` with test "picks the conductor agent model when no session.model is set" — asserts `resolved.id === "qwen/qwen3-coder"` and `resolved.provider === "openrouter"` |
| `opencode.json` | New checked-in econ config declaring `default_agent: "conductor"`, `agents.conductor.model: "openrouter/qwen/qwen3-coder"`, and `providers.openrouter` block (see [Shared config](#shared-config-openrouter--qwen) above) |

To swap the model: update `agents.conductor.model` in `opencode.json`
to any `openrouter/<provider>/<model>` string or any other supported provider
(e.g. `anthropic/claude-sonnet-4-5` for a live Anthropic key).

**Status:** done. Unit test passes without a live key (`Auth.config("OPENROUTER_API_KEY")`
is only exercised at LLM-call time, which the test doesn't reach).

---

## S1.2 — Graph tools

Exposes the in-process `BunSqliteGraph` (Sprint 0) as three agent-loop tools so the
model navigates the repo via the call graph instead of blind file reads.

### Tool signatures

#### `recon`
```
input:  { task: string }
output: JSON string — ReconBundle { entities: Entity[], references: Reference[], notes: string[] }
```
Accepts a natural-language task phrase, returns the most relevant entities + their
reference edges + anchored notes in one shot. Replaces the search→read→search fan-out.

#### `graph_file_read`
```
input:  { path: string, entity?: string }
output: string — entity JSON profile (when entity given) OR cat-n formatted file content
```
Reads a source file with 1-based line numbers, or returns an entity profile
(name, kind, signature, lineStart, lineEnd, filePath) from the graph by name.

#### `get_references`
```
input:  { entity: string, direction?: "callers" | "callees", depth?: 1 | 2, limit?: number,
          include_text_occurrences?: boolean }   — default direction: "callers"
output: JSON — { references: ReferenceRow[], direction, total, truncated }
        ReferenceRow { file, line, name, kind, fan_in, domain?, role?, summary?, chokepoint?, hop }
```
Returns the caller list (blast-radius fan-in, default) or callee list (outgoing imports/calls)
for a named entity, enriched with the semantic fields (`domain`/`role`/`summary`).
`chokepoint: true` — plus an inline `ur|rsk` line — marks a row whose own fan-in meets
`RSK_CALLER_THRESHOLD` (the same constant the edit-time cascade warning uses). `depth: 2` walks
one bounded, cycle-safe extra hop (`hop` tags each row); callees are deduped by target;
`include_text_occurrences: true` keeps the original rename-sweep output shape. Per
[docs/design/graph-navigation-audit.md §2](../design/graph-navigation-audit.md) (G1).

### Registration path

| Step | File | Line range |
|------|------|-----------|
| Tool definitions (framework-agnostic) | `packages/code-intelligence/src/tools.ts` | full file |
| Index re-exports | `packages/code-intelligence/src/index.ts` | 142–144 |
| opencode `Tool.define()` wrappers | `packages/opencode/src/tool/graph-tools.ts` | full file |
| Registry: import | `packages/opencode/src/tool/registry.ts` | 18–19 (Z1 comment) |
| Registry: `yield*` tool instances | `packages/opencode/src/tool/registry.ts` | 112–114 |
| Registry: `Effect.all` inits | `packages/opencode/src/tool/registry.ts` | 220–222 |
| Registry: `builtin` array | `packages/opencode/src/tool/registry.ts` | 242–244 |

**tsconfig path alias** — `packages/opencode/tsconfig.json` maps
`@opencode-ai/code-intelligence` → `../code-intelligence/src/index.ts` so no
`bun install` is required during development. Add
`"@opencode-ai/code-intelligence": "workspace:*"` to
`packages/opencode/package.json` dependencies before shipping.

### Wiring summary

```
BunSqliteGraph (bun:sqlite, in-process)
  └─ makeReconTool / makeFileReadTool / makeGetReferencesTool  [code-intelligence/src/tools.ts]
       └─ GraphReconTool / GraphFileReadTool / GraphGetReferencesTool  [opencode/src/tool/graph-tools.ts]
            └─ ToolRegistry.layer (builtin list)  [opencode/src/tool/registry.ts:220-244]
                 └─ ToolRegistry.tools()  ← called by SessionTools.resolve()
```

The singleton graph is created lazily at first tool call against `process.cwd()` and indexed
in the background. Queries return empty results during the initial index run.

### How the loop selects them

`ToolRegistry.tools()` (`packages/opencode/src/tool/registry.ts:270`) returns all builtin
tools filtered by model/provider rules. The graph tools have no filter guard — they are
always included. The agent loop in `packages/opencode/src/session/tools.ts:86` iterates
`yield* registry.tools(...)` and hands each `Def` to the AI SDK `tool()` wrapper, so
`recon`, `graph_file_read`, and `get_references` are advertised to the model in every turn.

### Tests

`packages/code-intelligence/test/graph-tools.test.ts` — 10 assertions, no model needed:

- indexes `test/fixture` (a.ts, b.ts, c.ts)
- calls each tool's `execute()` directly
- asserts `recon("calc")` returns entities containing Calculator
- asserts `get_references("greet", callers)` finds the c.ts import edge
- asserts `get_references("", callees)` returns all file-level import edges
- asserts `file_read("a.ts")` produces cat-n line numbers and contains "greet"
- asserts `file_read("a.ts", entity="greet")` returns entity profile JSON

Run: `bun test --cwd packages/code-intelligence test/graph-tools.test.ts`

**Status:** done.

---

## S1.3 — Canonical state

A persisted `session_canonical_state` SQLite table (ledger / scratchpad / attempt)
that survives compaction, plus a `rebuildContext` API to refill the conductor's
working state after a compaction or hard restart without re-reading the whole
conversation.

### Problem

The model's context window is finite and **compacted** periodically — old messages
are summarised and dropped. Any state that lived only in the window (tool-call
history, working notes, attempt history) is lost. The conductor must be able to
**refill** its working state after a compaction or a hard restart without re-reading
the whole conversation.

### Design

Keep the agent's canonical state in a **dedicated SQLite table**
(`session_canonical_state`) that is **orthogonal to `session_message`**. Compaction
only touches the `session_message` view; the canonical table is never touched during
compaction, so it survives unconditionally.

#### Three entry kinds

| Kind | Semantics | Write pattern |
|------|-----------|---------------|
| `ledger` | Immutable log of tool-calls and decisions | Append-only (generated row ID) |
| `scratchpad` | Mutable key/value working notes | Last-write-wins via `onConflictDoUpdate` on a deterministic PK (`${sessionID}:scratchpad:${key}`) |
| `attempt` | History of task attempts / retries | Append-only (generated row ID) |

#### Table shape (`packages/core/src/session/sql.ts`, lines 179–214)

```sql
session_canonical_state (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- 'ledger' | 'scratchpad' | 'attempt'
  key         TEXT NOT NULL,   -- tool name / scratchpad key / task name
  seq         INTEGER NOT NULL,
  payload     TEXT NOT NULL,   -- JSON
  time_created INTEGER NOT NULL
)
```

Indexes: `(session_id)` and `(session_id, kind, seq)` for efficient per-session reads.

#### Service (`packages/core/src/session/canonical-state.ts`)

```
SessionCanonicalState.Service
  .appendLedger(sessionID, { tool, input, result?, decision? })
  .setScratchpad(sessionID, key, value)          -- upserts
  .appendAttempt(sessionID, { task, status, error? })
  .load(sessionID) → { ledger, scratchpad, attempts }
  .rebuildContext(sessionID) → Markdown string   -- inject after compaction
```

`rebuildContext` returns a Markdown document (three sections: Scratchpad /
Tool Call Ledger / Attempt History) ready to be injected as a `synthetic`
message type into the next runner turn.

### Where it was extended

| File | Change |
|------|--------|
| `packages/core/src/session/sql.ts` | Added `SessionCanonicalStateTable` (lines 179–214) |
| `packages/core/src/database/migration/20260627000001_s1_3_canonical_state.ts` | Migration: `CREATE TABLE session_canonical_state` + indexes |
| `packages/core/src/database/migration.gen.ts` | Registered new migration |
| `packages/core/src/database/schema.gen.ts` | Added same DDL so fresh in-memory DBs get the table (lines 272–291) |
| `packages/core/src/session/canonical-state.ts` | New service file (250 lines) |
| `packages/core/test/session-canonical-state.test.ts` | Survives-compaction test (2 tests, 23 assertions) |

### How compaction interacts (no code change required)

`SessionHistory.latestCompaction` (`packages/core/src/session/history.ts:13`) finds
the highest-seq `compaction` row in `session_message` and filters earlier messages
out of the runner's view. `session_canonical_state` is a separate table — it is
**never queried or written by the compaction path**, so all three kinds of entry
persist regardless of how many compaction cycles occur.

### Rebuild path after compaction

After compaction the runner calls `SessionHistory.loadForRunner` which starts from
the compaction message. To re-inject canonical state, call:

```typescript
const context = yield* SessionCanonicalState.Service.rebuildContext(sessionID)
// then inject `context` as a Synthetic message into the next LLM turn
```

The returned Markdown is suitable for the `text` field of a `SessionMessage.Synthetic`
row (or an `appendSyntheticContext` helper that S5 will wire in).

### Tie-in to S5 — MiMo checkpoint

S5 (MiMo checkpoint) will:
1. Call `appendLedger` / `setScratchpad` / `appendAttempt` at each significant
   agent decision point.
2. On compaction detection (new `compaction` row in `session_message`), call
   `rebuildContext` and inject the result as a synthetic message so the next
   model turn starts with full canonical context.

The `rebuildContext` API is intentionally format-agnostic — S5 can change the
rendering without touching the storage layer.

### Verification

```
bun test packages/core/test/session-canonical-state.test.ts
# 2 tests, 23 assertions, 0 failures
```

Typecheck: `tsgo --noEmit` on `@opencode-ai/core` — clean.

**Status:** done.

---

## S1.4 — Eval harness (model-candidate pinning)

**Goal:** choose the best model per tier (conductor / executor / oracle) on
evidence — pass rate, latency, token usage, cost — not assertion. This is what
pins the model behind the conductor default in [S1.1](#s11--conductor-as-default-reasoner)
and any escalation tiers it uses.

### Directory layout

```
packages/eval/
  src/
    types.ts              — core interfaces (Fixture, ModelEndpoint, RunResult, TierScore)
    fixtures.ts           — 4 benchmark tasks (one per tier combination)
    providers/
      mock.ts             — dry-run provider (no HTTP, canned responses)
      openai-compat.ts    — real OpenAI-compatible /chat/completions caller
      index.ts            — factory: routes to mock or live provider
    scorer.ts             — aggregation + ranked shortlist + report renderer
    harness.ts            — orchestrator: runs all fixtures, returns ScoredShortlist
    index.ts              — CLI entrypoint (--dry-run flag)
  test/
    harness.test.ts       — 11 unit/integration tests (bun:test)
  package.json
  tsconfig.json
```

### How to run

#### Dry-run (no API key, no network)

```bash
cd packages/eval
bun run dry-run
# or from workspace root:
bun run /path/to/packages/eval/src/index.ts --dry-run
```

#### Real evaluation (once you have an endpoint + key)

Set environment variables, then run without `--dry-run`. Defaults to OpenRouter +
the recommended Qwen models per tier (see [Shared config](#shared-config-openrouter--qwen)):

```bash
export OPENROUTER_API_KEY=sk-or-...
# Optional overrides per tier:
export ECON_CONDUCTOR_BASE_URL=https://openrouter.ai/api/v1
export ECON_CONDUCTOR_MODEL=qwen/qwen3-32b
export ECON_EXECUTOR_BASE_URL=https://openrouter.ai/api/v1
export ECON_EXECUTOR_MODEL=qwen/qwen2.5-coder-32b-instruct
export ECON_ORACLE_BASE_URL=https://openrouter.ai/api/v1
export ECON_ORACLE_MODEL=qwen/qwen3-8b

cd packages/eval
bun run start
```

Any endpoint that speaks the OpenAI `/chat/completions` protocol works:
Ollama (`http://localhost:11434/v1`), Together AI, local vLLM, etc.

### How scoring works

Each fixture is run against every configured endpoint for its tier.
Results are aggregated per `(tier, model)` pair:

| Metric | How computed |
|---|---|
| **pass** | `fixture.check(output)` — coarse substring/regex, not exact match |
| **pass rate** | `passes / total fixtures` for this (tier, model) |
| **latency\_ms** | wall-clock time from `fetch()` call to response parsed (or mock delay) |
| **input\_tokens** | `usage.prompt_tokens` from the API response (mock: estimated at 4 chars/token) |
| **output\_tokens** | `usage.completion_tokens` (mock: estimated) |
| **cost\_usd** | `(inputTokens / 1M) × pricing.inputPer1M + (outputTokens / 1M) × pricing.outputPer1M` |

The shortlist per tier is sorted **pass rate descending, then total cost ascending** —
highest-quality cheapest model ranks first.

Exit code: `0` if every tier has at least one model at 100% pass rate; `1` otherwise.

### How to add a candidate model

1. **Add an endpoint** to the `TierConfig` in `src/harness.ts` (or pass it from `src/index.ts`):

```typescript
// e.g. evaluate two executor candidates side-by-side
executor: [
  {
    name: "qwen2.5-coder-32b",
    baseURL: "https://openrouter.ai/api/v1",
    model: "qwen/qwen2.5-coder-32b-instruct",
    apiKey: process.env.OPENROUTER_API_KEY,
    provider: "openai-compat",
    pricing: { inputPer1M: 0.20, outputPer1M: 0.20 },
  },
  {
    name: "deepseek-coder-v2",
    baseURL: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-coder-v2",
    apiKey: process.env.OPENROUTER_API_KEY,
    provider: "openai-compat",
    pricing: { inputPer1M: 0.14, outputPer1M: 0.28 },
  },
],
```

   Or via env vars: `ECON_EXECUTOR_MODEL=deepseek/deepseek-coder-v2` (single candidate).

2. **Add a fixture** in `src/fixtures.ts` — implement `Fixture` interface:
   - `id`: short kebab-case string
   - `tier`: `"conductor" | "executor" | "oracle"`
   - `prompt` / optional `system`: the task text
   - `check(output)`: returns `true` on pass — keep it coarse (substring / regex)
   - `checkDescription`: human-readable pass criterion
   - `mockResponse`: a canned string that satisfies `check` (needed for dry-run)

### Dry-run sample output

```
Running in DRY-RUN mode — using mock provider (no API key required).

econ eval harness — scored shortlist [DRY-RUN / mock responses]
============================================================

## Tier: CONDUCTOR
----------------------------------------
  1. qwen3-32b [mock]
       ✓ plan-rest-to-graphql

## Tier: EXECUTOR
----------------------------------------
  1. qwen-coder-32b [mock]
       ✓ fix-sum-bug
       ✓ implement-palindrome

## Tier: ORACLE
----------------------------------------
  1. qwen3-8b [mock]
       ✓ judge-null-safety
```

All mock runs pass because each fixture's `mockResponse` is authored to satisfy its `check`.
Real runs may fail — that's the point.

### Fixture set (current)

| id | tier | what it tests |
|---|---|---|
| `plan-rest-to-graphql` | conductor | 3-step numbered migration plan |
| `fix-sum-bug` | executor | fix an off-by-assignment bug in a loop accumulator |
| `implement-palindrome` | executor | implement `isPalindrome` from scratch |
| `judge-null-safety` | oracle | pick the safer null-handling snippet (A vs B) |

**Status:** done. `bun test --cwd packages/eval` — 11 tests passing.
