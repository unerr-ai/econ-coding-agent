/**
 * Proactive, deterministic context-reconstruction layer that sits on top of
 * OpenCode's LLM-based compaction: fires structured markdown checkpoints at
 * fill-ratio thresholds (40 / 60 / 80%) well below overflow — no LLM call —
 * so the model always has a fresh brief of load-bearing state as context
 * pressure climbs.
 *
 * @sem domain=intelligence role=analysis
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Tuning knobs for the checkpoint layer — thresholds, context-size cap, and
 * ledger depth. Pass a custom config to override production defaults for
 * testing or session-specific budget constraints.
 *
 * @sem domain=intelligence role=analysis
 */
export interface CheckpointConfig {
  /** Ascending fill-ratio values (0–1) at which a checkpoint fires. */
  thresholds: number[]
  /** Maximum byte length of a buildCheckpoint output string. */
  maxContextChars: number
  /** Maximum number of ledger entries included in one checkpoint. */
  maxLedgerEntries: number
}

/**
 * Production defaults: fires at 40/60/80% fill, caps output at 8 000 chars,
 * keeps the 20 most-recent ledger entries per checkpoint.
 *
 * @sem domain=intelligence role=analysis
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  thresholds: [0.4, 0.6, 0.8],
  maxContextChars: 8000,
  maxLedgerEntries: 20,
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of the agent's canonical state — mirrors the data
 * shapes from canonical-state.ts as plain local types so this module stays
 * DB-decoupled and cross-package-import-free.
 *
 * @sem domain=intelligence role=analysis
 */
export interface CheckpointSnapshot {
  scratchpad: Record<string, unknown>
  ledger: Array<{ tool: string; result?: string; decision?: string; seq?: number }>
  attempts: Array<{ task: string; status: string; error?: string }>
  /** Optional pre-rendered task-tree markdown from the S5.2 task-tree module. */
  taskTree?: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Mutable firing state for one session's checkpoint lifecycle — tracks which
 * thresholds have already fired so each fill crossing fires at most once, until
 * context shrinks below a threshold and it re-arms.
 *
 * @sem domain=intelligence role=analysis
 */
export interface CheckpointState {
  /** Thresholds that have fired in the current fill cycle. */
  firedThresholds: number[]
  /** Total number of checkpoints emitted in this session. */
  count: number
}

/**
 * Returns a fresh CheckpointState for a new session — no thresholds fired,
 * count at zero.
 *
 * @sem domain=intelligence role=analysis
 */
export function createCheckpointState(): CheckpointState {
  return { firedThresholds: [], count: 0 }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Computes whether a checkpoint should fire at the current fill ratio —
 * returns the highest eligible threshold and prunes re-armed thresholds (those
 * above the current fill ratio) from state as a side effect, so a subsequent
 * rise re-fires them. Actual recording is deferred to checkpointIfNeeded.
 *
 * @sem domain=intelligence role=analysis
 */
export function shouldCheckpoint(
  fillRatio: number,
  state: CheckpointState,
  config: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG,
): { fire: boolean; threshold: number | null } {
  // Re-arm hysteresis: remove any previously-fired threshold now above the
  // current fill ratio (happens after compaction shrinks context).
  state.firedThresholds = state.firedThresholds.filter((t) => t <= fillRatio)

  // Find the highest threshold that fillRatio has crossed and not yet fired.
  const sorted = [...config.thresholds].sort((a, b) => b - a) // descending
  for (const t of sorted) {
    if (fillRatio >= t && !state.firedThresholds.includes(t)) {
      return { fire: true, threshold: t }
    }
  }

  return { fire: false, threshold: null }
}

/**
 * Renders the agent's canonical state as a bounded markdown reconstruction
 * block, prioritising scratchpad keys (always preserved) then task-tree,
 * most-recent ledger entries, and attempts — oldest ledger rows are dropped
 * first when the char budget is tight.
 *
 * @sem domain=intelligence role=analysis
 */
export function buildCheckpoint(
  snapshot: CheckpointSnapshot,
  config: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG,
): string {
  const { scratchpad, ledger, attempts, taskTree } = snapshot
  const { maxContextChars, maxLedgerEntries } = config

  // --- Scratchpad (always included — load-bearing) ---
  const scratchpadLines = ["### Scratchpad"]
  for (const [k, v] of Object.entries(scratchpad)) {
    const val = typeof v === "string" ? v : JSON.stringify(v)
    scratchpadLines.push(`- **${k}**: ${val}`)
  }
  if (scratchpadLines.length === 1) scratchpadLines.push("_(empty)_")
  const scratchpadSection = scratchpadLines.join("\n")

  // --- Task tree (optional) ---
  const taskTreeSection = taskTree ? `### Task Tree\n${taskTree}` : null

  // --- Attempts ---
  let attemptsSection: string | null = null
  if (attempts.length > 0) {
    const lines = ["### Attempts"]
    for (const a of attempts) {
      const err = a.error ? ` — ${a.error}` : ""
      lines.push(`- [${a.status}] ${a.task}${err}`)
    }
    attemptsSection = lines.join("\n")
  }

  // --- Budget calculation ---
  // Build the fixed content (everything except the variable-depth ledger).
  const header = "## Checkpoint — reconstructed context"
  const fixedParts: string[] = [header, scratchpadSection]
  if (taskTreeSection) fixedParts.push(taskTreeSection)
  if (attemptsSection) fixedParts.push(attemptsSection)
  const fixedContent = fixedParts.join("\n\n")
  const ledgerHeaderStr = "\n\n### Recent Actions\n"
  const ledgerBudget = maxContextChars - fixedContent.length - ledgerHeaderStr.length

  // --- Ledger (most-recent maxLedgerEntries; newest wins under budget pressure) ---
  const recentLedger = ledger.slice(-maxLedgerEntries)
  const includedLines: string[] = []
  let ledgerUsed = 0

  // Walk from newest to oldest, accumulate while within budget.
  for (let i = recentLedger.length - 1; i >= 0; i--) {
    const entry = recentLedger[i]!
    const seq = entry.seq != null ? `[${entry.seq}] ` : ""
    const result = entry.result ? ` → ${entry.result.slice(0, 120)}` : ""
    const decision = entry.decision ? ` (${entry.decision})` : ""
    const line = `- ${seq}${entry.tool}${result}${decision}`
    const lineLen = line.length + 1 // +1 for the "\n" separator
    if (ledgerBudget <= 0 || ledgerUsed + lineLen > ledgerBudget) break
    includedLines.unshift(line)
    ledgerUsed += lineLen
  }

  // --- Assemble output (priority order: scratchpad → taskTree → ledger → attempts) ---
  const parts: string[] = [header, scratchpadSection]
  if (taskTreeSection) parts.push(taskTreeSection)
  if (includedLines.length > 0) {
    parts.push("### Recent Actions\n" + includedLines.join("\n"))
  }
  if (attemptsSection) parts.push(attemptsSection)

  const output = parts.join("\n\n")

  // Safety truncation — should not trigger in normal operation.
  return output.length <= maxContextChars ? output : output.slice(0, maxContextChars)
}

/**
 * The primary integration point — combines threshold detection with checkpoint
 * emission. Mutates state when a threshold fires (records it, increments
 * count); returns a null context when no checkpoint is warranted.
 *
 * @sem domain=intelligence role=analysis
 */
export function checkpointIfNeeded(
  fillRatio: number,
  snapshot: CheckpointSnapshot,
  state: CheckpointState,
  config: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG,
): { fired: boolean; threshold: number | null; context: string | null } {
  const decision = shouldCheckpoint(fillRatio, state, config)

  if (!decision.fire || decision.threshold === null) {
    return { fired: false, threshold: null, context: null }
  }

  // Record the fired threshold and increment count.
  state.firedThresholds.push(decision.threshold)
  state.count += 1

  const context = buildCheckpoint(snapshot, config)
  return { fired: true, threshold: decision.threshold, context }
}
