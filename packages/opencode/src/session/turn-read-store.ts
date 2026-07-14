/**
 * Per-session turn-read continuation store (P4 §4b) — what a continuation
 * turn inherits from the session's last FRESH turn: the turn-read verdict,
 * the M4 pinned reproduction, and the S4 governance-gate block ledger
 * (files BLOCKED and not yet re-landed) — all things a continuation must not
 * reset. Same per-session module-state pattern as arming-store.ts: written by
 * fresh turns (a neutral-degrade turn CLEARS them), read at turn open by
 * continuation turns, never written by them.
 *
 * @sem domain=routing role=config
 */
import type { VerifyCommand } from "@opencode-ai/code-intelligence"
import type { TriageVerdict } from "./turn-triage"
import type { IssueExpectation, IssueThreshold } from "./issue-expectations"

/** M4/S1 — the turn-end pinned reproduction, plus (only for a runner-confirmed red) the exit/tail evidence that proved it red. Structurally identical to slice-orchestrator's `TurnProbePin` (colocated here rather than imported, so this store stays dependency-free of the orchestrator module). */
export interface TurnProbePin {
  readonly probe: VerifyCommand
  readonly redEvidence?: { readonly exitCode: number; readonly outputTail: string }
  /** True when this pin is an F16 regression promotion (a previously-green tracked neighbor suite standing in for the turn's own repro) — the provenance the oracle-inversion form rung and the promoted-pin-green finish check key on. */
  readonly promoted?: boolean
}

const verdictBySession = new Map<string, TriageVerdict>()
const probeBySession = new Map<string, TurnProbePin>()
const filesBySession = new Map<string, readonly string[]>()
/** S4 — per-session ledger of governance-gate BLOCKs not yet re-landed: sessionID → (file → one-line reason). */
const blocksBySession = new Map<string, Map<string, string>>()

/** Record (or, on null, clear) the fresh turn's verdict — called once per fresh root turn. */
export function setTurnVerdict(sessionID: string, verdict: TriageVerdict | null): void {
  if (verdict) verdictBySession.set(sessionID, verdict)
  else verdictBySession.delete(sessionID)
}

/** The last fresh turn's verdict, or `undefined` when that turn degraded neutrally. */
export function getTurnVerdict(sessionID: string): TriageVerdict | undefined {
  return verdictBySession.get(sessionID)
}

/** Record (or, on undefined, clear) the turn's M4 pinned reproduction (probe + any red evidence) — fresh turns clear at open and re-set on pin; probe-from-red updates mid-turn. */
export function setPinnedProbe(sessionID: string, probe: TurnProbePin | undefined): void {
  if (probe) probeBySession.set(sessionID, probe)
  else probeBySession.delete(sessionID)
}

/** The pinned reproduction a continuation turn restores, or `undefined` when the prior turn pinned none. */
export function getPinnedProbe(sessionID: string): TurnProbePin | undefined {
  return probeBySession.get(sessionID)
}

/** S4 — record (or update) a governance-gate BLOCK for a file this session hit — the abandonment signal (django-12039: blocked twice, never re-applied, empty patch). */
export function recordGateBlock(sessionID: string, file: string, reason: string): void {
  let files = blocksBySession.get(sessionID)
  if (!files) {
    files = new Map()
    blocksBySession.set(sessionID, files)
  }
  files.set(file, reason)
}

/** S4 — mark a previously-blocked file re-landed: a subsequent successful edit to it supersedes the abandonment signal. */
export function clearGateBlock(sessionID: string, file: string): void {
  blocksBySession.get(sessionID)?.delete(file)
}

/** S4 — every file still blocked-and-unresolved for this session, file → one-line reason — the S3 done-time nudge's fold-in. */
export function getGateBlocks(sessionID: string): ReadonlyMap<string, string> {
  return blocksBySession.get(sessionID) ?? new Map()
}

/** S4 — clear every recorded block for the session, alongside the pinned-probe reset at fresh turn open (a new task starts with a clean governance ledger). */
export function clearGateBlocks(sessionID: string): void {
  blocksBySession.delete(sessionID)
}

/** Q-D — does the stored verdict carry a research-shaped goal? Read at the dispatch/conversion seams to auto-cast the researcher persona and route research slices to the citation check. */
export function researchShapedTurn(sessionID: string): boolean {
  return getTurnVerdict(sessionID)?.goals.some((goal) => goal.shape === "research") === true
}

/** M2 — record (or, on empty, clear) the fresh turn's file evidence: prompt-named paths + tree-resolved dotted modules. Continuation turns inherit; a degraded turn clears. */
export function setTurnFiles(sessionID: string, files: readonly string[]): void {
  if (files.length > 0) filesBySession.set(sessionID, files)
  else filesBySession.delete(sessionID)
}

/** M2 — the turn's file evidence, the probe fallback for slices whose own text names no file. */
export function getTurnFiles(sessionID: string): readonly string[] {
  return filesBySession.get(sessionID) ?? []
}

/** Round F §6 — issue-derived expectations, extracted mechanically at fresh-turn open: sessionID → the issue's stated expected/actual/error literals. */
const expectationsBySession = new Map<string, readonly IssueExpectation[]>()

/** Record (or, on empty, clear) the fresh turn's issue-derived expectations. Continuation turns inherit; a degraded turn clears. */
export function setIssueExpectations(sessionID: string, literals: readonly IssueExpectation[]): void {
  if (literals.length > 0) expectationsBySession.set(sessionID, literals)
  else expectationsBySession.delete(sessionID)
}

/** The turn's issue-stated literals — the fidelity judge's required-coverage list and the oracle-inversion detector's evidence. */
export function getIssueExpectations(sessionID: string): readonly IssueExpectation[] {
  return expectationsBySession.get(sessionID) ?? []
}

/** Round F fix-wave — issue-stated numeric boundary rules (11848's "more than 50 years… MUST"): sessionID → the rules the fidelity judge must see asserted on BOTH sides. */
const thresholdsBySession = new Map<string, readonly IssueThreshold[]>()

/** Record (or, on empty, clear) the fresh turn's issue-stated boundary rules. Extracted by pure code, so this runs even on a degraded turn-read. */
export function setIssueThresholds(sessionID: string, thresholds: readonly IssueThreshold[]): void {
  if (thresholds.length > 0) thresholdsBySession.set(sessionID, thresholds)
  else thresholdsBySession.delete(sessionID)
}

/** The turn's issue-stated boundary rules — rendered into the fidelity judge's rubric as stated-rule coverage. */
export function getIssueThresholds(sessionID: string): readonly IssueThreshold[] {
  return thresholdsBySession.get(sessionID) ?? []
}
