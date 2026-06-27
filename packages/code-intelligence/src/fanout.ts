/**
 * Fan-out planner for independent executor tool calls (S4.2 + S4.4).
 *
 * OpenCode ALREADY runs the tool calls of one assistant message concurrently:
 * the session processor awaits them with `Effect.forEach(..., { concurrency:
 * "unbounded" })` (packages/opencode/src/session/processor.ts ~L879-883), and
 * `tool.execute.before` fires per call before dispatch. So a model that emits N
 * independent tool calls in a single message already gets one parallel wave — we
 * do NOT rebuild that loop.
 *
 * What this module adds is the *planning* side: given a set of intended tool
 * calls, partition them into the minimum number of sequential WAVES such that
 * every call within a wave is mutually independent (safe to run with unbounded
 * concurrency). Two calls conflict when they touch the same path with at least
 * one write (write/write or read/write). This both verifies the fan-out property
 * and encodes the S4.4 rule: batch independent work into one wave, never loop the
 * main thread file-by-file. Pure: no I/O, no side effects.
 *
 * @sem domain=routing role=analysis
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An intended tool call, annotated with the paths it reads and writes so the
 * planner can detect conflicts. Omit `writes` for a read-only call.
 *
 * @sem domain=routing role=model
 */
export interface FanoutCall {
  /** Stable id for this call (used only to identify it in the plan). */
  id: string
  /** Tool id being invoked (e.g. "read", "edit", "graph"). */
  tool: string
  /** Paths this call reads. Default: none. */
  reads?: string[]
  /** Paths this call writes/mutates. Default: none (read-only). */
  writes?: string[]
}

// ---------------------------------------------------------------------------
// Orchestration rule (S4.4)
// ---------------------------------------------------------------------------

/**
 * The batch-then-fan-out rule, as enforced by `planWaves`. Surfaced as a
 * constant so it can be cited in prompts, docs, and logs.
 */
export const BATCH_THEN_FANOUT_RULE =
  "Batch independent work into one wave and dispatch it in a single message so the " +
  "calls run concurrently. NEVER loop the main thread file-by-file over mechanical " +
  "work — partition the calls into waves and fan each wave out at once."

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/** True when the call mutates no path (safe to run alongside anything). */
export function isReadOnly(call: FanoutCall): boolean {
  return (call.writes?.length ?? 0) === 0
}

/**
 * True when two calls conflict and must NOT share a wave: they conflict when one
 * writes a path the other reads or writes (write/write or read/write on the same
 * path). Two read-only calls never conflict.
 *
 * @sem domain=routing role=analysis
 */
export function callsConflict(a: FanoutCall, b: FanoutCall): boolean {
  const aw = new Set(a.writes ?? [])
  const bw = new Set(b.writes ?? [])
  if (aw.size === 0 && bw.size === 0) return false
  const ar = a.reads ?? []
  const br = b.reads ?? []
  // a's writes vs b's reads+writes
  for (const p of aw) if (bw.has(p) || br.includes(p)) return true
  // b's writes vs a's reads
  for (const p of bw) if (ar.includes(p)) return true
  return false
}

// ---------------------------------------------------------------------------
// Wave planner
// ---------------------------------------------------------------------------

/**
 * Partition tool calls into the sequential waves they can be dispatched in: each
 * returned wave is a set of mutually-independent calls that may run together with
 * unbounded concurrency. Greedy first-fit — a call joins the earliest wave it
 * does not conflict with, otherwise opens a new wave. Input order is preserved,
 * so a fully-independent set returns as a single wave (the common, ideal case).
 *
 * @sem domain=routing role=analysis
 */
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

/**
 * True when every call in the set is mutually independent — i.e. the whole set
 * runs as a single fan-out wave. A convenience over `planWaves(calls).length`.
 *
 * @sem domain=routing role=analysis
 */
export function isSingleWave(calls: FanoutCall[]): boolean {
  return planWaves(calls).length <= 1
}
