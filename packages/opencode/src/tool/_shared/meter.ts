/**
 * Per-call token meter for econ tool results.
 * Records { tool, raw_tokens, returned_tokens, ratio } for every instrumented
 * tool call so the savings pipeline can aggregate compression gains.
 *
 * Wire-out: emits a structured debug log line today; replace the TODO below
 * once the savings telemetry path lands in packages/opencode.
 * Reference shape from unerr-cli: shell-compression-log.ts §accountCompression.
 *
 * @sem domain=metrics role=accounting
 */

// ---------------------------------------------------------------------------
// Record type
// ---------------------------------------------------------------------------

/**
 * One recorded tool call — the minimum fields the savings dashboard needs
 * to compute per-tool compression ratios and token deltas.
 */
export interface ToolCallRecord {
  /** Tool identifier, e.g. "read", "grep", "webfetch". */
  tool: string
  /** Estimated tokens in the raw (pre-truncation) output. */
  raw_tokens: number
  /** Estimated tokens in the returned (post-truncation) output. */
  returned_tokens: number
  /** returned_tokens / raw_tokens; 1.0 when nothing was compressed. */
  ratio: number
}

// ---------------------------------------------------------------------------
// In-process log (Sprint 0 stub; replace with telemetry sink in Sprint 1)
// ---------------------------------------------------------------------------

/** All records emitted this process lifetime, for in-process inspection/tests. */
const _records: ToolCallRecord[] = []

/**
 * Record one tool call's token accounting.
 *
 * Today this emits a structured debug line (stderr) and appends to an
 * in-process array.
 * TODO(econ-telemetry): replace the console.error sink below with a call to
 * the savings telemetry module (emitSavingsEvent / emitUsageEvent) once it is
 * wired into packages/opencode.  The ToolCallRecord shape is intentionally
 * minimal so the upgrade is a one-liner.
 * See docs/architecture/TOOL_CONSOLIDATION.md §Sprint 1 for the planned hook.
 */
export function recordToolCall(record: ToolCallRecord): void {
  _records.push(record)
  // Structured log on stderr — console.debug/console.log both write to
  // stdout, which corrupts `opencode run --format json` NDJSON. Use
  // console.error (stderr) so the signal survives without polluting the
  // machine-readable stdout stream.
  console.error("[econ:meter]", JSON.stringify(record))
}

/**
 * Return all records accumulated this process lifetime.
 * Intended for tests and in-process inspection; not a persistent store.
 */
export function getRecords(): readonly ToolCallRecord[] {
  return _records
}

/**
 * Reset the in-process record list — for use in tests only.
 */
export function clearRecords(): void {
  _records.length = 0
}
