/**
 * Cross-session continuity layer: condenses the canonical session state into a
 * compact resume strip so a new agent session can reconstruct intent, decisions,
 * and open loops without replaying the full conversation history.
 *
 * @sem domain=intelligence role=query
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal mirror of the canonical session state shape — decoupled from the
 * packages/core implementation so this package stays dependency-free while
 * the core schema evolves.
 *
 * @sem domain=intelligence role=utilities
 */
export interface SessionStateLike {
  intent?: string
  decisions?: string[]
  blockers?: string[]
  openLoops?: string[]
}

/**
 * Flattened, fully-populated snapshot of the fields a resuming session needs;
 * absent optional fields are normalised to safe defaults so callers never
 * encounter undefined.
 *
 * @sem domain=intelligence role=utilities
 */
export interface ResumeStrip {
  intent: string
  decisions: string[]
  blockers: string[]
  openLoops: string[]
}

// ---------------------------------------------------------------------------
// buildResumeStrip
// ---------------------------------------------------------------------------

/**
 * Maps a partial session state onto a fully-populated ResumeStrip with safe
 * defaults, giving resuming sessions a reliable contract regardless of how
 * much state the previous session recorded.
 *
 * @sem domain=intelligence role=query
 */
export function buildResumeStrip(state: SessionStateLike): ResumeStrip {
  // TODO: read the real canonical state row from packages/core/src/session/canonical-state.ts
  // once the cross-package dependency is wired; for now, map fields through directly.
  return {
    intent: state.intent ?? "",
    decisions: state.decisions ?? [],
    blockers: state.blockers ?? [],
    openLoops: state.openLoops ?? [],
  }
}
