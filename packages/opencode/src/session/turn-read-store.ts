/**
 * Per-session turn-read continuation store (P4 §4b) — what a continuation
 * turn inherits from the session's last FRESH turn: the turn-read verdict
 * (the turn preamble and goal count are rebuilt from it — Q-H: a
 * continuation continues the same goal tree, preamble unchanged) and the M4
 * pinned reproduction (the repro is still the contract; a continuation must
 * not reset it). Same per-session module-state pattern as arming-store.ts:
 * written by fresh turns — a neutral-degrade turn CLEARS it, since a
 * degraded turn has no goal tree to continue — read at turn open by
 * continuation turns, never written by them.
 *
 * @sem domain=routing role=config
 */
import type { VerifyCommand } from "@opencode-ai/code-intelligence"
import type { TriageVerdict } from "./turn-triage"

const verdictBySession = new Map<string, TriageVerdict>()
const probeBySession = new Map<string, VerifyCommand>()

/** Record (or, on null, clear) the fresh turn's verdict — called once per fresh root turn. */
export function setTurnVerdict(sessionID: string, verdict: TriageVerdict | null): void {
  if (verdict) verdictBySession.set(sessionID, verdict)
  else verdictBySession.delete(sessionID)
}

/** The last fresh turn's verdict, or `undefined` when that turn degraded neutrally. */
export function getTurnVerdict(sessionID: string): TriageVerdict | undefined {
  return verdictBySession.get(sessionID)
}

/** Record (or, on undefined, clear) the turn's M4 pinned reproduction — fresh turns clear at open and re-set on pin; probe-from-red updates mid-turn. */
export function setPinnedProbe(sessionID: string, probe: VerifyCommand | undefined): void {
  if (probe) probeBySession.set(sessionID, probe)
  else probeBySession.delete(sessionID)
}

/** The pinned reproduction a continuation turn restores, or `undefined` when the prior turn pinned none. */
export function getPinnedProbe(sessionID: string): VerifyCommand | undefined {
  return probeBySession.get(sessionID)
}

/** Q-D — does the stored verdict carry a research-shaped goal? Read at the dispatch/conversion seams to auto-cast the researcher persona and route research slices to the citation check. */
export function researchShapedTurn(sessionID: string): boolean {
  return getTurnVerdict(sessionID)?.goals.some((goal) => goal.shape === "research") === true
}
