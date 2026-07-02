# Feature: The model team — executors & specialists

**Modules:** `opencode.json` agents · `.opencode/plugins/econ-executor-validate.js` ·
`packages/code-intelligence/src/fanout.ts` · `packages/code-intelligence/src/specialists.ts`
**Sprint:** 4 (parallelism + modular worker roles)
**Status:** shipped

---

## Overview

Sprint 4 completes the three-role model team: a cheap, stateless **executor tier** for
delegable mechanical work, a **specialist library** of named single-purpose roles mapped to
tiers, and a **wave-based fan-out** planner that batches independent tool calls into one
concurrent message instead of looping the main thread file-by-file. Together these push
recon, lint, docstrings, refactors, and codemods off the expensive conductor/oracle tiers and
onto cheaper models running in parallel. A pre-dispatch schema-validation plugin keeps the
cheap tier honest by refusing malformed tool calls before they execute, so the model
self-corrects instead of silently failing.

```
                conductor (senior)
                      │ dispatchSpecialist(name, task)
                      ▼
              specialists.ts roster ──▶ TIER_AGENT ──▶ agent/model
        (recon, lint, docstrings, test-author, refactor, ...)
                      │
                      ▼
     planWaves(calls) partitions intended tool calls
     into the minimum number of mutually-independent waves
                      │
                      ▼
        ┌─────────────┴─────────────┐
        │   wave 1 (all independent) │  Effect.forEach(..., { concurrency: "unbounded" })
        │  call → call → call (‖)    │  ── OpenCode's built-in concurrency, unmodified
        └─────────────┬─────────────┘
                      │ each call: tool.execute.before → econ-executor-validate
                      │            (refuses malformed args, model retries)
                      ▼
              digest (WHAT/FILES/RESULT/FOLLOW-UPS)
                      │
                      ▼
              conductor integrates digest, moves to next wave/turn
```

---

## S4.1 — Executor tier + tool-call validation

**Module:** `opencode.json` agents + `.opencode/plugins/econ-executor-validate.js`

A cheap, stateless ~9B tool-calling model (`executor` tier) added to `opencode.json` handles
delegable, read-only or mechanical tasks without reasoning overhead. Paired with a
pre-dispatch schema-validation plugin that catches malformed tool calls from the cheap model
before they reach execution, so the model self-corrects and retries with valid args.

### The executor agent in `opencode.json`

```json
{
  "agents": {
    "executor": {
      "model": "openrouter/qwen/qwen3-8b",
      "description": "econ executor tier: cheap ~9B stateless tool-caller for delegable executor-tier specialists",
      "mode": "subagent"
    }
  }
}
```

**Key properties:**

- **Model:** Qwen3-8B (~9B params) or any small tool-calling OSS model on OpenRouter.
- **Mode:** `subagent` — spawned per-task via OpenCode's `task` tool (never the primary
  session agent).
- **Role:** handles recon, lint, docstrings specialists; returns a digest (see S4.3).
- **Cost:** ~100x cheaper than frontier models, no reasoning needed.

### Pre-dispatch schema validation plugin

**File:** `.opencode/plugins/econ-executor-validate.js`

**Plugin load mechanism.** OpenCode auto-discovers all `*.js` files under
`.opencode/plugins/` at startup (`packages/opencode/src/config/plugin.ts`). Each exported
function is called with a `PluginInput` context and must return a `Hooks` object with
promise-based handlers.

**Hook contract: `tool.execute.before`** (from `packages/plugin/src/index.ts:266`):

```typescript
"tool.execute.before"?: (
  input:  { tool: string; sessionID: string; callID: string },
  output: { args: any }
) => Promise<void>
```

Fires **before dispatch** on every tool call, with the tool name and its call arguments.

**Enforcement mechanism: throw to refuse.** Throwing synchronously inside the hook causes
the effect to reject (`plugin/index.ts:290`), which propagates up through `run.promise` and
surfaces to the AI SDK as a **tool call error the model sees in its next turn**. The model
can then self-correct and retry with valid arguments — no human intervention needed.

```javascript
throw new Error("[econ-executor-validate] REFUSED: '${tool}' call has a malformed schema: ...")
// ↓ AI SDK receives error
// ↓ model self-corrects
// ↓ retries tool call with valid args
```

**Schema validation logic.** Validates required fields + types for: `read`, `edit`, `write`,
`bash`, `grep`, `glob`, `task`.

Each tool declares required fields with accepted camelCase / snake_case aliases and expected
type (always `string` for executor tools):

| Tool | Required fields | Aliases |
|------|----------|---------|
| `read` | `filePath` | filePath \| file_path |
| `edit` | filePath, oldString, newString | file_path, old_string, new_string |
| `write` | filePath, content | file_path |
| `bash` | `command` | — |
| `grep` | `pattern` | — |
| `glob` | `pattern` | — |
| `task` | description, prompt, subagent_type | — |

**Validation rules:**

1. Args must be a plain object (not null, array, or primitive).
2. Every required field must be present (under any accepted alias).
3. Every required field must be the expected type (string).
4. No empty strings (`.trim() === ""` fails).

Tools not in the schema table pass through untouched — no validation overhead for tools that
aren't listed.

**Error reporting to the model.** When validation fails, the error message is precise and
actionable:

```
[econ-executor-validate] REFUSED: 'read' call has a malformed schema:
'filePath|file_path' is missing; 'oldString|old_string' must be a string, got undefined.
Required: filePath, oldString, newString. Fix the arguments and retry.
```

The model sees this and typically self-corrects immediately — no looping or degradation.

**Integration.** The plugin is auto-loaded by OpenCode at startup; no registration call
needed. The validator fires on every tool call from any model, so it applies to executor
specialists (primary beneficiary — cheap models make more mistakes), worker specialists
(backup — catches rare errors from mid-tier models), and any subagent running on the
conductor or executor tier.

**Done-when:** Malformed tool calls are caught before dispatch and the model self-corrects
on retry. Verify: run an executor specialist on a task and confirm that if it emits bad args
(missing fields, wrong types), the plugin refuses it with a clear error and the model
retries successfully.

---

## S4.2 / S4.4 — Parallel fan-out: `planWaves` and the batch-then-fan-out rule

**Module:** `packages/code-intelligence/src/fanout.ts`

`fanout.ts` holds two halves of one idea: `planWaves` is the mechanism that partitions tool
calls into the minimum number of mutually-independent waves, and
`BATCH_THEN_FANOUT_RULE` is the discipline constant that tells the conductor and every
specialist to use it — batch independent work into one message, never loop the main thread
file-by-file.

### OpenCode's built-in concurrency

OpenCode **already runs the tool calls of one assistant message concurrently** — this
feature does NOT rebuild that loop. From `packages/opencode/src/session/processor.ts`
(~lines 879–883):

```typescript
Effect.forEach(toolCalls, {
  concurrency: "unbounded"  // runs all calls in parallel by default
})
```

OpenCode's session processor awaits all tool calls in one message together with
`Effect.forEach(..., { concurrency: "unbounded" })`. The `tool.execute.before` hook (S4.1)
fires per call before dispatch. So a model that emits N independent tool calls in a single
message already gets one parallel wave — concurrent execution is baked in. `planWaves`'s job
is NOT to rebuild the loop, but to *verify and document* the fan-out property so the
orchestrator can reason about whether a set of calls is truly concurrent or needs sequential
waves.

### Conflict detection

Two calls conflict and **must NOT share a wave** when one writes a path the other reads or
writes (write/write or read/write on the same path). Two read-only calls never conflict.

```typescript
function callsConflict(a: FanoutCall, b: FanoutCall): boolean {
  const aw = new Set(a.writes ?? [])
  const bw = new Set(b.writes ?? [])
  if (aw.size === 0 && bw.size === 0) return false  // two reads never conflict
  const ar = a.reads ?? []
  const br = b.reads ?? []
  // a's writes vs b's reads+writes
  for (const p of aw) if (bw.has(p) || br.includes(p)) return true
  // b's writes vs a's reads
  for (const p of bw) if (ar.includes(p)) return true
  return false
}
```

### Wave planner

`planWaves` partitions a set of tool calls into the minimum number of sequential waves:

```typescript
export function planWaves(calls: FanoutCall[]): FanoutCall[][] {
  const waves: FanoutCall[][] = []
  for (const call of calls) {
    let placed = false
    for (const wave of waves) {
      if (wave.every((other) => !callsConflict(call, other))) {
        wave.push(call)
        placed = true
        break
      }
    }
    if (!placed) waves.push([call])
  }
  return waves
}
```

**Greedy first-fit algorithm:** each call joins the earliest wave it does not conflict with;
otherwise it opens a new wave. Input order is preserved. Ideal case: a fully independent set
returns as a single wave (the common case) — the orchestrator dispatches it in one message
and OpenCode runs it concurrently.

### The `FanoutCall` model

```typescript
export interface FanoutCall {
  id:     string      // Stable id to identify the call in the plan
  tool:   string      // Tool id (e.g. "read", "edit", "graph")
  reads?: string[]    // Paths this call reads. Default: none.
  writes?: string[]   // Paths this call writes/mutates. Default: none.
}
```

**Example — three independent recon calls:**

```typescript
const calls = [
  { id: "c1", tool: "graph", reads: ["src/a.ts"], writes: [] },
  { id: "c2", tool: "read", reads: ["src/b.ts"], writes: [] },
  { id: "c3", tool: "grep", reads: ["src/"], writes: [] }
]
planWaves(calls)  // → [[ c1, c2, c3 ]]  one wave, all concurrent
```

**Example — conflicting calls separated into waves:**

```typescript
const calls = [
  { id: "e1", tool: "edit", reads: ["src/a.ts"], writes: ["src/a.ts"] },
  { id: "e2", tool: "edit", reads: ["src/a.ts"], writes: ["src/a.ts"] }
]
planWaves(calls)  // → [[ e1 ], [ e2 ]]  two waves, sequential
```

### Verification utilities

```typescript
// True when all calls are mutually independent — run as one wave
export function isSingleWave(calls: FanoutCall[]): boolean {
  return planWaves(calls).length <= 1
}

// True when a call is read-only
export function isReadOnly(call: FanoutCall): boolean {
  return (call.writes?.length ?? 0) === 0
}
```

**Integration point.** The planner is currently a pure module — used by the orchestrator to
verify and document fan-out properties. It does NOT block or change execution; OpenCode runs
the calls concurrently regardless. This lets the orchestrator (1) reason about parallelism
("are these N calls concurrent or sequential?"), (2) log the wave plan ("dispatched wave 1
with 3 calls, wave 2 with 1 call"), and (3) verify model behavior — confirm the model
respects the single-wave invariant for independent work (the rule below).

### The rule, as code

```typescript
export const BATCH_THEN_FANOUT_RULE =
  "Batch independent work into one wave and dispatch it in a single message so the " +
  "calls run concurrently. NEVER loop the main thread file-by-file over mechanical " +
  "work — partition the calls into waves and fan each wave out at once."
```

This is a **constant**, not just documentation — it can be cited in prompts (inject it into
the system prompt of the conductor/executor so they know the expectation), in logs (emit it
when documenting why a parallelization strategy was chosen), and in tests (assert the
orchestrator respects the rule — no loops, one wave per dispatch). It applies to both the
main conductor and every specialist (executor, worker, oracle).

**Why this matters — cost impact.** Looping the main thread file-by-file over mechanical
work (e.g. renaming a variable across 50 files) means 50 separate messages (token overhead
from repeated context/prompt), 50 separate model inferences (latency + API call overhead),
and no parallelism — each file processed sequentially. Batched + fanned out, the same 50
reads + 50 edits dispatch in two waves (reads then edits): 2–3 messages total, the read wave
runs concurrently, the write wave runs concurrently, and the model reasons about all paths
together after seeing the task once. `planWaves` quantifies the wave count — fewer waves
means less main-thread overhead.

**Scope: where the rule applies**

| Role | Application | Example |
|------|-------------|---------|
| Conductor | Every turn's orchestration | "These 3 recon calls are independent; dispatch in one message, not three" |
| Executor specialist | Within its delegated task | "Run all 5 linter checks in one `bash` call, not five" |
| Worker specialist | Refactor / codemod tasks | "Apply the rename to all 20 call sites in one `edit` wave" |
| Oracle specialist | Review consolidation | "Review all diffs in one pass, return one digest" |

**Using the planner to enforce the rule:** (1) detect the work — identify all intended tool
calls for a task; (2) plan the waves — call `planWaves(calls)`; (3) dispatch per wave — emit
one message with all calls in that wave; (4) never loop — do NOT emit one message per call
(that would create N waves of 1 call each).

### Example: `codemod` specialist respecting the rule

**Task:** "Rename `OldFunction` to `NewFunction` across 30 files."

**Bad (looping, violates the rule):**

```
Message 1: Edit src/a.ts (OldFunction → NewFunction)
Message 2: Edit src/b.ts (OldFunction → NewFunction)
Message 3: Edit src/c.ts (OldFunction → NewFunction)
...
Message 30: Edit src/z.ts (OldFunction → NewFunction)
```

Cost: 30 messages, 30 inferences, no parallelism, token blowup.

**Good (batched + fanned, respects the rule):**

```
Message 1:
  - Edit src/a.ts (rename)
  - Edit src/b.ts (rename)
  - Edit src/c.ts (rename)
  ...
  - Edit src/z.ts (rename)
  [OpenCode runs all 30 edits concurrently via Effect.forEach unbounded]

Message 2 (if needed, e.g. import propagation):
  - Read src/main.ts
  - Read src/index.ts
  [Digest: "Renamed in 30 files, no import changes needed"]
```

Cost: 2 messages, 1 main inference, 30 concurrent edits.

### Batch-then-fan-out workflow

For any multi-site mechanical work: (1) collect the operations — read-only phases (searches,
traces) to identify all sites to change; (2) partition into waves — use `planWaves` or
reason manually, independent operations in one wave, dependent operations across sequential
waves; (3) dispatch per wave — emit ONE message per wave with all calls in that wave;
(4) integrate the digest — the child specialist/model returns a digest (not raw transcript),
and the orchestrator chains it forward.

### Exceptions (rare)

The rule is not absolute when: **interactive debugging** — a specialist is tracing an
unknown bug and needs to read results before deciding the next read (inherently sequential);
**fallback / retry** — a tool call fails and one retry is needed (not repetitive looping);
**resource limits** — a single wave is too large for one message, e.g. > 10MB args (batch by
size, not by file count). When an exception applies, document it — a comment or log line
explaining why the loop is necessary. The rule is the default; exceptions are explicit.

**Done-when:** Independent calls are confirmed to run as one fan-out wave via OpenCode's
built-in concurrency, and `BATCH_THEN_FANOUT_RULE` is encoded as a constant and documented
in code and prompts, with `planWaves` as its concrete mechanism. Verify: given a set of 3+
independent tool calls, confirm `planWaves` returns a single wave; run them as one message in
OpenCode and observe all three start/complete concurrently. Separately, confirm the
conductor and every specialist batch independent work into one wave and dispatch it in one
message, not in a loop over individual files or calls.

---

## S4.3 — Specialist library + dispatcher

**Module:** `packages/code-intelligence/src/specialists.ts`

A **roster of named, single-purpose roles** mapped to model tiers. Each specialist runs in
its own child session (spawned via OpenCode's `task` tool) and returns a compact **digest**
instead of its raw transcript — keeping the orchestrator's context lean. Specialists are pure
DATA: name, tier, role prompt, and allowed tools.

### The specialist roster

**Executor tier (cheap, stateless recon):**

| Name | Purpose | Tools |
|------|---------|-------|
| `recon` | Read-only investigation: find/trace/map code and return a context digest. | read, grep, glob, graph |
| `lint` | Run the linter/formatter and report violations (no edits). | read, grep, bash |
| `docstrings` | Add or repair `@sem` doc comments on exported entities. | read, edit, write |

**Worker tier (mid-size model, needs judgement):**

| Name | Purpose | Tools |
|------|---------|-------|
| `test-author` | Write or improve tests, then run them. | read, edit, write, bash |
| `refactor` | Multi-site mechanical refactor: rename / extract / inline / move. | read, edit, write, graph |
| `codemod` | Apply a repeated mechanical change across many files via one pass. | read, edit, write, bash, grep, glob |
| `dep-repair` | Propagate a signature change: fix every caller and import. | read, edit, write, graph, bash |
| `repro` | Build a minimal reproduction of a bug and confirm it fails. | read, edit, write, bash |

**Oracle tier (frontier reasoning / senior judgement):**

| Name | Purpose | Tools |
|------|---------|-------|
| `review` | Review a diff for correctness and risk; return findings (no edits). | read, grep, glob, graph |

### Tier → agent mapping

```typescript
export const TIER_AGENT: Record<SpecialistTier, string> = {
  executor: "executor",      // → openrouter/qwen/qwen3-8b (S4.1)
  worker: "conductor",       // → openrouter/qwen/qwen3-coder (S1.1)
  conductor: "conductor",    // → same
  oracle: "oracle"           // → openrouter/deepseek/deepseek-r1 (S3.2)
}
```

These names **MUST match** the `agents` keys in `opencode.json`. The `worker` role is filled
by the mid-tier `conductor` agent until a dedicated worker agent exists.

### Specialist data structure

```typescript
export interface Specialist {
  name:        string              // Stable, kebab-case id (e.g. "test-author")
  tier:        SpecialistTier      // "executor" | "worker" | "conductor" | "oracle"
  description: string              // One-line summary for menus/logs
  role:        string              // System-prompt fragment (does NOT include digest contract)
  tools:       string[]            // Tool ids permitted in this specialist's child session
}
```

**Example — the `test-author` specialist:**

```typescript
{
  name: "test-author",
  tier: "worker",
  description: "Write or improve tests for the targeted code, then run them.",
  role: "You are a test-author specialist. Write or strengthen tests for the code " +
        "named in the task, mirroring existing test conventions, then run only those " +
        "test files and report pass/fail. Do NOT change production code to make a " +
        "test pass.",
  tools: ["read", "edit", "write", "bash"]
}
```

### Digest contract

Every dispatched specialist is appended with the same digest contract, forcing each child
session to return a compact, structured summary instead of its raw transcript:

```
---
Return ONLY a compact digest (not your raw transcript):
- WHAT YOU DID: 1-3 lines.
- FILES TOUCHED: absolute paths, or 'none'.
- RESULT: the answer / findings / test outcome the orchestrator needs.
- FOLLOW-UPS: anything the orchestrator must do next, or 'none'.
```

The orchestrator integrates this digest — not a wall of tool output — and chains it into the
next specialist or turn.

### The dispatcher: `dispatchSpecialist`

```typescript
export function dispatchSpecialist(name: string, task: string): SpecialistInvocation {
  const specialist = SPECIALISTS[name]
  if (!specialist) {
    throw new Error(
      `Unknown specialist "${name}". Known: ${listSpecialists().join(", ")}`,
    )
  }
  const subagent_type = TIER_AGENT[specialist.tier]
  const prompt = [specialist.role, "", `TASK: ${task}`, DIGEST_CONTRACT].join("\n")
  return {
    subagent_type,
    description: `${specialist.name} specialist`,
    prompt,
  }
}
```

**Returns a `SpecialistInvocation`:**

```typescript
export interface SpecialistInvocation {
  subagent_type: string  // OpenCode agent to spawn (e.g. "executor", "conductor")
  description:   string  // 3–5 word task description for logs
  prompt:        string  // Full prompt: role + task + digest contract
}
```

Pass these fields straight to OpenCode's `task` tool to spawn the specialist in its own
child session with the correct agent/model.

### Helper functions

```typescript
// Look up a specialist by name
export function getSpecialist(name: string): Specialist | undefined

// All specialists for a given tier
export function specialistsForTier(tier: SpecialistTier): Specialist[]

// Every specialist name in the library
export function listSpecialists(): string[]
```

### Design principles

- **Specialists are data, not behavior.** The module exports a pure library; no I/O, no
  side effects. The orchestrator reads the data and decides when to invoke.
- **One child session per task.** Each specialist runs isolated, with its own model,
  prompt, and tool sandbox. Failures are contained.
- **Digest over transcript.** The digest contract keeps orchestrator context lean and
  allows chaining many specialists without token blowup.
- **Tier is logical, not runtime.** Specialists declare a tier (executor/worker/oracle);
  the `TIER_AGENT` mapping converts that to the agent that runs it. Changing the mapping
  is a config-only change.

**Done-when:** Specialists are defined as data; `dispatchSpecialist(name, task)` compiles
them into a runnable `task`-tool invocation. Verify: call `dispatchSpecialist("test-author",
"Add tests for src/x.ts")` and confirm it returns the correct `subagent_type`, description,
and full prompt (role + task + digest contract).

---

## Tests

Verification for this feature spans all four sub-areas; see each `Done-when` above for the
concrete assertion. In short:

- **S4.1:** an executor specialist emitting malformed tool-call args is refused by
  `econ-executor-validate.js` before dispatch, with a clear error, and the model retries
  successfully.
- **S4.2:** `planWaves` returns a single wave for 3+ independent calls, and two sequential
  waves when calls conflict on a written path; running an independent set as one message
  shows all calls start/complete concurrently via OpenCode's `Effect.forEach(...,
  { concurrency: "unbounded" })`.
- **S4.3:** `dispatchSpecialist("test-author", "Add tests for src/x.ts")` returns the correct
  `subagent_type` ("conductor", per `TIER_AGENT.worker`), a description, and a prompt that
  concatenates the specialist's role, the task, and the digest contract.
- **S4.4:** the conductor and every specialist batch independent work into one wave and
  dispatch it in one message rather than looping over individual files or calls;
  `BATCH_THEN_FANOUT_RULE` is available as a citable constant in prompts, logs, and tests.
