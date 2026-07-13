# Feature: Long-horizon orchestration (checkpointing)

Long-running agent turns (100–200 steps) outgrow a single context window well before
OpenCode's own compaction ever fires, and compaction's lossy prose summary drops the
load-bearing state — task structure, decisions, in-flight attempts — that a long run
needs to keep making progress. Sprint 5 grafts a proactive, deterministic checkpoint
layer, a restart-surviving task tree, and a goal-judge loop with a doom-loop gate onto
OpenCode's existing compaction rather than replacing it — **extend, don't rebuild**.
All pure logic lives in `packages/code-intelligence`, durable persistence is additive
on the S1.3 canonical-state store, and a runtime plugin wires the trigger — three
pieces (S5.1 / S5.2 / S5.3), shipped together.

## Checkpoint lifecycle

```
 context fill %
      │
      │        ┌── 40% ──┐   ┌── 60% ──┐   ┌── 80% ──┐        ┌─ ~100% overflow ─┐
      │        │ trip #1 │   │ trip #2 │   │ trip #3 │        │  OpenCode        │
  ────┼────────┼─────────┼───┼─────────┼───┼─────────┼────────┼  compaction      │
      │        │(re-arms │   │(re-arms │   │(re-arms │        │  (LLM summary +  │
      │        │ if fill │   │ if fill │   │ if fill │        │  recent tail,    │
      │        │ drops   │   │ drops   │   │ drops   │        │  lossy, paid)    │
      │        │ below)  │   │ below)  │   │ below)  │        └──────────────────┘
      ▼        ▼         ▼   ▼         ▼   ▼         ▼
  checkpointIfNeeded (S5.1, deterministic, free, no LLM call)
      │
      ▼
  buildCheckpoint distils:
    scratchpad (all keys preserved)
    tool-call ledger (oldest dropped first under maxContextChars)
    attempts
    task-tree (S5.2: nodes / statuses / decisions)
      │
      ▼
  bounded structured-state block reinjected → window rebuilt from
  checkpoint + live slice (never exceeds maxContextChars)

 in parallel, per goal-run iteration:
  runUntilGoal (S5.3)
      │
      ├─ doom-loop gate: same progressKey for stagnationLimit (3)
      │    iterations? → halt loop BEFORE calling the judge
      │
      └─ else → judge (stub | live-model) evaluates → continue / done
```

---

## S5.1 — Checkpoint writer (proactive context reconstruction)

`packages/code-intelligence/src/checkpoint.ts` (pure, deterministic, no LLM) +
`test/checkpoint.test.ts`. Runtime trigger: was `.opencode/plugins/econ-checkpoint.js`
(MVP plugin, **retired 2026-07-13** with the whole `.opencode/plugins/econ-*.js` layer —
the native engine owns these seams now; the plugins double-hooked them on any run
launched with the econ repo's `.opencode/` present, which is how the fly fleet's
mini-10 diverged from local: every-step recon injection + a second governance gate).

### How it reconciles with OpenCode compaction

OpenCode's compaction (`packages/core/src/session/compaction.ts` →
`compactIfNeeded`/`compactAfterOverflow`) fires only at **overflow** — when
`estimate > context − max(output, buffer)`, i.e. the window is essentially full —
and pays an **LLM summary call**. The checkpoint layer sits **on top**: it fires
**deterministically and for free** at **40/60/80%** fill, *below* overflow,
reinjecting structured state (scratchpad, tool-call ledger, attempts, task-tree)
bounded to `maxContextChars`. The two are complementary:

| | Checkpoint (S5.1) | Compaction (OpenCode) |
|---|---|---|
| Fires at | 40/60/80% fill (proactive) | ~100% overflow (reactive) |
| Cost | deterministic, no model call | LLM summary call |
| Output | bounded structured-state block | lossy prose summary + recent tail |
| Role | cheap proactive net | lossy backstop at the ceiling |

Hysteresis: each threshold fires at most once per crossing; a threshold above the
current fill ratio is **re-armed** (e.g. after a compaction shrinks the window) so
the next climb re-fires. `buildCheckpoint` always preserves every scratchpad key,
drops oldest ledger entries first under budget, and never exceeds `maxContextChars` —
this is the "stays bounded + preserves load-bearing state" guarantee, verified by the
simulated growing-window test (fires exactly at 0.4/0.6/0.8; bounded under a
5000-entry ledger; re-arms).

**Status:** done.

---

## S5.2 — Task tree + decisions, surviving restart

`packages/code-intelligence/src/task-tree.ts` (pure tree model: immutable
add/update/setDecision, collectDecisions, serialize/deserialize, renderTaskTree) +
`test/task-tree.test.ts`. Persistence is **additive** on the existing canonical-state
store (`packages/core/src/session/canonical-state.ts`, [S1.3](./01-conductor-core.md)):
two new service methods `setTaskTree` / `loadTaskTree` reuse the existing `scratchpad`
kind under the reserved key `__task_tree__` (deterministic id
`${sessionID}:scratchpad:__task_tree__`, upsert semantics) — **no `sql.ts` table
change**. Restart is simulated in-test by a
`deserializeTaskTree(serializeTaskTree(tree))` roundtrip (the persistence is JSON in a
scratchpad row, so the roundtrip is faithful): structure, statuses and decisions stay
intact.

Known interaction: because the tree lives under the `scratchpad` kind, `load()` and
`rebuildContext()` will also surface the `__task_tree__` key in their scratchpad map.
That is acceptable (the tree *is* canonical state) but means rebuildContext carries the
serialized tree; a future refinement could special-case the reserved key.

**Status:** done.

---

## S5.3 — Goal-judge loop + doom-loop gate

`packages/code-intelligence/src/goal-judge.ts` (`runUntilGoal`, `makeStubJudge`,
config/state) + `test/goal-judge.test.ts`. A run-until-condition loop with a STUB
judge (live-model judge gated on credentials).

### How the doom-loop gate reconciles with the S6.3 retry-loop-breaker

Both use the same pattern — a stable progress signature + a consecutive count against
a numeric limit — but at **different layers** and with **opposite actions**:

- `evaluateEdit` (guardrail.ts, S6.3) — **edit level**: when the model re-proposes the
  identical *blocked edit* `retryLoopLimit` (3) times, it **releases** the block
  (downgrades to advisory) so the current turn makes progress.
- `runUntilGoal` (goal-judge.ts, S5.3) — **goal-iteration level**: when iterations
  *stagnate* (same `progressKey` for `stagnationLimit` (3) iterations), it **halts**
  the whole loop so model budget isn't burned on a run going nowhere. The gate is
  checked **before** the judge each iteration, so a stagnating run also saves a judge
  call per trip.

No overlap, no duplication: goal-judge never re-implements edit gating; guardrail
never controls the goal loop. `stagnationLimit` mirrors `retryLoopLimit`.

**Status:** done.

---

## Runtime wiring

`.opencode/plugins/econ-checkpoint.js` (auto-discovered) tracks per-session fill from
`session.next.step.ended` token usage, builds an in-process tool-call ledger from
`tool.execute.after`, runs the pure `checkpointIfNeeded` engine, and injects the
bounded reconstruction at the next `context.assemble.before` — the same plugin seam
econ-status.js and econ-recon-inject.js use. Wiring the trigger to the durable
canonical-state store (`rebuildContext` + `loadTaskTree`) from inside the Bun backend
(rather than the in-process snapshot) is a follow-up that needs core edits outside this
sprint's ownership boundary.

## Exports to add to `packages/code-intelligence/src/index.ts`

(index.ts is outside this sprint's edit boundary — these are the exact names to wire.)

```ts
// econ S5.1 checkpoint
export {
  DEFAULT_CHECKPOINT_CONFIG,
  createCheckpointState,
  shouldCheckpoint,
  buildCheckpoint,
  checkpointIfNeeded,
  type CheckpointConfig,
  type CheckpointSnapshot,
  type CheckpointState,
} from "./checkpoint.js"

// econ S5.2 task tree
export {
  createTaskTree,
  addTask,
  updateStatus,
  setDecision,
  findNode,
  collectDecisions,
  serializeTaskTree,
  deserializeTaskTree,
  renderTaskTree,
  type TaskStatus,
  type TaskNode,
  type TaskTree,
} from "./task-tree.js"

// econ S5.3 goal judge
export {
  DEFAULT_GOAL_JUDGE_CONFIG,
  createGoalJudgeState,
  makeStubJudge,
  runUntilGoal,
  type GoalContext,
  type Judge,
  type GoalJudgeConfig,
  type GoalJudgeState,
  type GoalOutcome,
} from "./goal-judge.js"
```
