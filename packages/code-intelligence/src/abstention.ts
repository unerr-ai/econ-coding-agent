/**
 * Detects when the cheap conductor signals it is unsure about its own answer
 * and produces a forceTier hook value that routes the turn to the oracle tier.
 *
 * Abstention contract — what the conductor must emit to trigger escalation:
 *   1. Structured flag:  set `conductorResult.abstain = true`
 *   2. Sentinel token:   include `[[ABSTAIN]]` or `[[UNSURE]]` anywhere in
 *                        `conductorResult.text` (case-insensitive match on
 *                        the token name, brackets required)
 *   3. Low confidence:   set `conductorResult.confidence` to a number in
 *                        [0, 1]; values strictly below CONFIDENCE_THRESHOLD
 *                        (0.5) are treated as abstention
 *
 * Any one of the three signals is sufficient.  A missing field is never
 * treated as abstention — the check is opt-in from the conductor side.
 *
 * @sem domain=routing role=abstention-detector
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Confidence threshold below which a conductor result is treated as an
 * abstention.  Conductor must emit a `confidence` value in [0, 1].
 * Values strictly below this threshold trigger oracle escalation.
 */
export const CONFIDENCE_THRESHOLD = 0.5

/**
 * Sentinel tokens that the conductor may embed in its text output to signal
 * explicit unsure state.  Matched case-insensitively; brackets are required.
 */
export const ABSTENTION_TOKENS = ["[[ABSTAIN]]", "[[UNSURE]]"] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The result shape the conductor (cheap model) returns for a turn.
 * All fields are optional — callers may populate only the fields they support.
 */
export interface ConductorResult {
  /** Raw text output from the conductor; scanned for sentinel tokens. */
  text?: string
  /**
   * Structured confidence score in [0, 1].
   * Strictly below CONFIDENCE_THRESHOLD triggers abstention.
   */
  confidence?: number
  /**
   * Explicit structured abstention flag.
   * Set to `true` when the conductor knows it should not be trusted.
   */
  abstain?: boolean
}

/** Result of running detectAbstention on a ConductorResult. */
export interface AbstentionResult {
  /** Whether the conductor signalled that it is unsure. */
  abstained: boolean
  /** The confidence value that was provided (if any). */
  confidence?: number
  /** Human-readable explanation of why abstention was or was not triggered. */
  reason?: string
}

// ---------------------------------------------------------------------------
// detectAbstention
// ---------------------------------------------------------------------------

/**
 * Examines a conductor turn result for any unsure/low-confidence signal and
 * returns a normalised AbstentionResult.  Pure: no I/O, no side effects.
 *
 * Signals checked in order (first match wins):
 *   1. conductorResult.abstain === true
 *   2. sentinel token in conductorResult.text
 *   3. conductorResult.confidence < CONFIDENCE_THRESHOLD
 *
 * @sem domain=routing role=abstention-detector
 */
export function detectAbstention(conductorResult: ConductorResult): AbstentionResult {
  // 1. Explicit structured flag.
  if (conductorResult.abstain === true) {
    return {
      abstained: true,
      confidence: conductorResult.confidence,
      reason: "conductor set abstain=true",
    }
  }

  // 2. Sentinel token scan.
  if (conductorResult.text !== undefined) {
    const upper = conductorResult.text.toUpperCase()
    for (const token of ABSTENTION_TOKENS) {
      if (upper.includes(token)) {
        return {
          abstained: true,
          confidence: conductorResult.confidence,
          reason: `conductor text contains sentinel token ${token}`,
        }
      }
    }
  }

  // 3. Low-confidence numeric field.
  if (
    conductorResult.confidence !== undefined &&
    conductorResult.confidence < CONFIDENCE_THRESHOLD
  ) {
    return {
      abstained: true,
      confidence: conductorResult.confidence,
      reason: `conductor confidence=${conductorResult.confidence} < threshold=${CONFIDENCE_THRESHOLD}`,
    }
  }

  // No abstention signal found.
  return {
    abstained: false,
    confidence: conductorResult.confidence,
    reason: "no abstention signal detected",
  }
}

// ---------------------------------------------------------------------------
// escalationFromAbstention
// ---------------------------------------------------------------------------

/**
 * Converts an AbstentionResult into the forceTier hook value consumed by
 * routeTurn.  When the conductor abstained, returns `{ forceTier: "oracle" }`
 * so routeTurn bypasses risk-band logic and routes directly to the oracle.
 * When the conductor did not abstain, returns `{}` (no override).
 *
 * Usage with routeTurn:
 *   const abstention = detectAbstention(conductorResult)
 *   const { forceTier } = escalationFromAbstention(abstention)
 *   const routing = routeTurn({ risk, state, forceTier })
 *
 * @sem domain=routing role=abstention-escalator
 */
export function escalationFromAbstention(abstention: AbstentionResult): { forceTier?: "oracle" } {
  if (abstention.abstained) {
    return { forceTier: "oracle" }
  }
  return {}
}
