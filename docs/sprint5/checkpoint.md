# Sprint 5 — Surviving 100–200 step tasks

Goal: graft MiMo's structured checkpoint onto OpenCode's existing compaction
(**extend, don't rebuild**) so long runs keep load-bearing state without context
blowup. Three pieces shipped; all pure logic lives in `packages/code-intelligence`,
durable persistence reuses the S1.3 canonical-state table, and a runtime plugin
wires the trigger.

## S5.1 — Checkpoint writer (proactive context reconstruction)

`packages/code-intelligence/src/checkpoint.ts` (pure, deterministic, no LLM) +
`test/checkpoint.test.ts`. Runtime trigger: `.opencode/plugins/econ-checkpoint.js`.

**How it reconciles with OpenCode compaction.** OpenCode's compaction
(`packages/core/src/session/compaction.ts` → `compactIfNeeded`/`compactAfterOverflow`)
fires only at **overflow** — when `estimate > context − max(output, buffer)`, i.e.
the window is essentially full — and pays an **LLM summary call**. The checkpoint
layer sits **on top**: it fires **deterministically and for free** at **40/60/80%**
fill, *below* overflow, reinjecting structured state (scratchpad, tool-call ledger,
attempts, task-tree) bounded to `maxContextChars`. The two are complementary:

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

## S5.2 — Task tree + decisions, surviving restart

`packages/code-intelligence/src/task-tree.ts` (pure tree model: immutable
add/update/setDecision, collectDecisions, serialize/deserialize, renderTaskTree) +
`test/task-tree.test.ts`. Persistence is **additive** on the existing canonical-state
store (`packages/core/src/session/canonical-state.ts`): two new service methods
`setTaskTree` / `loadTaskTree` reuse the existing `scratchpad` kind under the reserved
key `__task_tree__` (deterministic id `${sessionID}:scratchpad:__task_tree__`, upsert
semantics) — **no `sql.ts` table change**. Restart is simulated in-test by a
`deserializeTaskTree(serializeTaskTree(tree))` roundtrip (the persistence is JSON in a
scratchpad row, so the roundtrip is faithful): structure, statuses and decisions stay
intact.

Known interaction: because the tree lives under the `scratchpad` kind, `load()` and
`rebuildContext()` will also surface the `__task_tree__` key in their scratchpad map.
That is acceptable (the tree *is* canonical state) but means rebuildContext carries the
serialized tree; a future refinement could special-case the reserved key.

## S5.3 — Goal-judge loop + doom-loop gate

`packages/code-intelligence/src/goal-judge.ts` (`runUntilGoal`, `makeStubJudge`,
config/state) + `test/goal-judge.test.ts`. A run-until-condition loop with a STUB
judge (live-model judge gated on credentials).

**How the doom-loop gate reconciles with the S6.3 retry-loop-breaker.** Both use the
same pattern — a stable progress signature + a consecutive count against a numeric
limit — but at **different layers** and with **opposite actions**:

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
