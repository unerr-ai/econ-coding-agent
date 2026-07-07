/**
 * OL-7.6 decompose-vs-risk-veto A/B harness — runs a fixed task set under
 * both orchestration arms via an injected per-task runner, setting/restoring
 * `ECON_ORCHESTRATION` in `process.env` around each arm's tasks purely as a
 * bookkeeping signal the runner can read (production no longer reads this
 * env var — decomposition orchestration is unconditional as of 2026-07-04),
 * then hands the raw per-task results to the scorer's aggregation. Offline
 * only: runs against recorded fixtures for historical comparison.
 * @sem domain=eval role=harness
 */

import type {
  DecomposeVetoReport,
  DecomposeVetoTask,
  OrchestrationMode,
  TaskArmResult,
} from "./decompose-veto-types.js"
import { compareArms, summarizeArm } from "./decompose-veto-scorer.js"

/**
 * Produces one task's result under one arm. Injected so unit tests use an
 * in-memory stub (recorded fixtures) and the live driver
 * (decompose-veto-live.ts) uses a real dispatch — same contract either way.
 */
export type ArmTaskRunner = (task: DecomposeVetoTask, mode: OrchestrationMode) => Promise<TaskArmResult>

/**
 * Runs every task in `tasks` under one arm, setting `ECON_ORCHESTRATION` for
 * the arm's duration and restoring the prior value afterward (even on
 * failure) so a comparison run never leaks env state into the next arm or
 * the caller's process. Tasks run sequentially — each is a real run (or a
 * real per-task fixture lookup), not free, so results stay in task order.
 */
export async function runArm(
  tasks: readonly DecomposeVetoTask[],
  mode: OrchestrationMode,
  runner: ArmTaskRunner,
): Promise<TaskArmResult[]> {
  const saved = process.env["ECON_ORCHESTRATION"]
  process.env["ECON_ORCHESTRATION"] = mode
  try {
    const results: TaskArmResult[] = []
    for (const task of tasks) {
      results.push(await runner(task, mode))
    }
    return results
  } finally {
    if (saved === undefined) delete process.env["ECON_ORCHESTRATION"]
    else process.env["ECON_ORCHESTRATION"] = saved
  }
}

/**
 * Runs both arms sequentially over the same task set (decompose, then
 * risk-veto) and aggregates the OL-7.6 decision report. Returns the raw
 * per-arm results alongside the report so a caller can also render its own
 * breakdown or persist the fixture data.
 */
export async function runDecomposeVetoComparison(
  tasks: readonly DecomposeVetoTask[],
  runner: ArmTaskRunner,
): Promise<{ report: DecomposeVetoReport; decompose: TaskArmResult[]; riskVeto: TaskArmResult[] }> {
  const decompose = await runArm(tasks, "decompose", runner)
  const riskVeto = await runArm(tasks, "risk-veto", runner)
  const report = compareArms(summarizeArm("decompose", decompose), summarizeArm("risk-veto", riskVeto))
  return { report, decompose, riskVeto }
}
