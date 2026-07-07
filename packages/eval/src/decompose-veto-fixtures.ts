/**
 * Recorded fixture results for the OL-7.6 A/B eval — stand in for a real
 * task set's decompose vs risk-veto runs (directional numbers drawn from
 * DECOMPOSITION_ORCHESTRATION_PLAN.md §4.4's worked example: a hub-touching
 * migration that risk-veto sends whole to the oracle vs decompose splitting
 * into a small oracle design slice + a cheap, verified mechanical bulk).
 * Used to unit-test the aggregation/report math without a live run.
 * @sem domain=eval role=fixtures
 */

import type { DecomposeVetoTask, TaskArmResult } from "./decompose-veto-types.js"

/** A small fixed task set standing in for the plan's OL-7.6 "fixed real-repo task set". */
export const DECOMPOSE_VETO_TASKS: DecomposeVetoTask[] = [
  {
    id: "auth-refresh-migration",
    prompt: "migrate the auth middleware to add token refresh, propagate to all callers",
  },
  { id: "rename-config-flag", prompt: "rename the FOO config flag to BAR across the repo" },
  { id: "add-retry-boot", prompt: "add a bounded retry to the boot path" },
]

/**
 * Recorded results for the `decompose` arm — costs mirror the plan's §4.4
 * worked example (~7x cheaper than risk-veto on the hub-touching task),
 * with one small escalation on the hardest task.
 */
export const DECOMPOSE_FIXTURE_RESULTS: TaskArmResult[] = [
  {
    taskId: "auth-refresh-migration",
    mode: "decompose",
    success: true,
    latencyMs: 42_000,
    tokens: { input: 18_000, output: 50_000 },
    costUsd: 0.031,
    escalations: 0,
    wastedCostUsd: 0,
  },
  {
    taskId: "rename-config-flag",
    mode: "decompose",
    success: true,
    latencyMs: 9_000,
    tokens: { input: 4_000, output: 6_000 },
    costUsd: 0.0012,
    escalations: 0,
    wastedCostUsd: 0,
  },
  {
    taskId: "add-retry-boot",
    mode: "decompose",
    success: true,
    latencyMs: 15_000,
    tokens: { input: 5_000, output: 8_000 },
    costUsd: 0.0016,
    escalations: 1,
    wastedCostUsd: 0.0002,
  },
]

/**
 * Recorded results for the legacy `risk-veto` arm — same tasks, whole-turn
 * escalation on the hub touch (the auth migration), and a seeded miss on
 * the retry task (no per-slice verify to catch it).
 */
export const RISK_VETO_FIXTURE_RESULTS: TaskArmResult[] = [
  {
    taskId: "auth-refresh-migration",
    mode: "risk-veto",
    success: true,
    latencyMs: 38_000,
    tokens: { input: 18_000, output: 50_000 },
    costUsd: 0.22,
    escalations: 1,
    wastedCostUsd: 0,
  },
  {
    taskId: "rename-config-flag",
    mode: "risk-veto",
    success: true,
    latencyMs: 8_000,
    tokens: { input: 4_000, output: 6_000 },
    costUsd: 0.0012,
    escalations: 0,
    wastedCostUsd: 0,
  },
  {
    taskId: "add-retry-boot",
    mode: "risk-veto",
    success: false,
    latencyMs: 12_000,
    tokens: { input: 5_000, output: 8_000 },
    costUsd: 0.0016,
    escalations: 0,
    wastedCostUsd: 0,
  },
]
