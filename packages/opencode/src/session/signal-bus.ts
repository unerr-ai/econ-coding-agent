/**
 * The round-F signal bus (feature 08) — one typed publish surface for every
 * deterministic harness signal (gate denies, unresolved repros, hub bounces,
 * convention divergences, oracle inversions) plus the per-turn deferral budget
 * the hard-tail consumer draws on; a signal is never advisory-only — its
 * recorded decision is convert, defer, surface, or none-loud (legal only once
 * the deferral budget is spent). Same per-session module-state pattern as
 * turn-read-store.ts: a logging-free core (`publishSignal` returns the one
 * `[signal]` log line for the call site) with an Effect wrapper
 * (`publishSignalFx`) so producers record-and-log in a single call.
 *
 * @sem domain=routing role=config
 */
import { Effect } from "effect"

export type EconSignalName =
  | "probe_gate_reject" // M4 pin ran red at finish (bounded retry)
  | "probe_gate_exhausted" // M4 retries exhausted — hard tail
  | "oracle_inversion" // pinned red's EXPECTED contradicts issue-stated output — hard tail
  | "seen_red_unresolved" // F18 at finish (2nd arrival = tail)
  | "seen_red_oracle_inverted" // F18b: unresolved red is inversion-shaped — sanctioned, keep-general-fix nudge
  | "seen_red_env_blocked" // F18c: unresolved red is environment/baseline-shaped — sanctioned, state-the-gap nudge
  | "error_search_triggered" // P5 (error-search.ts): still-binding red's trace is unrecognized-by-our-parsers, dependency-rooted, or repro-escalated — one-shot nudge naming ONE pre-built, version-pinned web search query
  | "probe_env_blocked" // F18c/M4: pinned probe's own red repeats an environment-shaped signature — pin release, hard tail
  | "probe_rerun_dedupe" // Round-H: same command produced identical output for the 3rd+ time — no new information
  | "unverified_finish" // S3 / wave-10 deny (exhausted = tail)
  | "patch_sanity_unverified" // H3: landed patch touches none of the issue's candidate sites, or is unjustified test-infra-only (2nd arrival = tail surface)
  | "f2p_claim_unverified" // H1 tooth 3: finish claim covers only a strict subset of the turn's own observed red test ids (2nd arrival = tail surface)
  | "judge_tier_off" // gap-closure §4.3 (#27): ECON_JUDGE_TIER=off skipped a judge dispatch — surfaced once per session
  | "regression_red" // F11 neighbor regressed (unresolved re-arrival = tail)
  | "build_check_red" // P2b build-first rung (regression-neighbors.ts): a compiled-target buildCheck failed BEFORE any neighbor test ran — a deterministic compile block, distinct from a test red (inert on python — no buildCheck row)
  | "unverifiable_regression_surface" // H2.2: a non-trivial code edit's regression lane selected zero tests and no sibling test file exists — surfaced, never silent
  | "deliverable_checklist" // H4.1: end-state finish gate — ops-shaped turn's deliverable checklist (1st denial converts; a pass-through with gaps still open surfaces verifiedScope, never a silent allow)
  | "promoted_pin_green" // F16-promoted pin ran GREEN at finish — the regressed-then-appeased signature (11815 retreat) — hard tail
  | "repro_unresolved" // S2 deadline abstention
  | "repro_drift" // drift detector (kind in evidence)
  | "fidelity_gap" // repro-fidelity judge/teeth rejection
  | "fidelity_finish_reject" // RF-8 finish-time type-fidelity re-check: 1st hit converts (bounded deny), 2nd hit = the convert failed — hard tail
  | "hub_bounce" // hub gate 1st bounce
  | "hub_bounce_repeat" // evidence-bearing 2nd deny — hard tail
  | "hub_bounce_turn_repeat" // Wave 12: cross-session 2nd evidence-less bounce this turn — cached repeat, hard tail
  | "hub_bounce_judge_redirect" // Wave 12: cross-session 3rd evidence-less bounce — judge named a different site, final bounce, hard tail
  | "hub_gate_exhausted_allow" // Wave 12: cross-session 3rd evidence-less bounce — judge endorsed/degraded, bounded fail-open allow, hard tail
  | "convention_divergence" // wave-11 first pause
  | "convention_divergence_repeat" // evidenced family conflict on identical retry — hard tail
  | "interpreter_mismatch" // agent probe ran a non-project interpreter
  | "interpreter_harvested" // F21: interpreter reused from the turn's own green test run — converts an F14a probe-miss gate skip into a live gate
  | "gate_block" // S4 governance BLOCK ledger entry
  | "coupling_unknown" // P6: edited file's language has no import resolver — fan-in/hub score is not evidence of safety, surfaced once per (session, file)
  | "deferral_armed" // consumer record: pre-pass planted (evidence.consumed names the tail signal)
  | "deferral_dispatched" // consumer record: the escalation slice actually ran
  | "surface_asked" // consumer record: question routed to the human

export type SignalSeverity = "info" | "tail"
export type SignalDecision = "convert" | "defer" | "surface" | "none-loud"

export interface EconSignal {
  readonly name: EconSignalName
  readonly sessionID: string
  readonly step?: number
  readonly severity: SignalSeverity
  readonly decision: SignalDecision
  readonly evidence: Record<string, string | number | boolean | null>
}

/** The one `[signal]` trace line a publish produces — callers log it verbatim (Effect contexts use `publishSignalFx` instead, which cannot forget to). */
export interface SignalLogLine {
  readonly message: string
  readonly payload: Record<string, unknown>
}

/** Ring-buffer cap per session — a runaway producer degrades to dropping the OLDEST signals, never to unbounded memory. */
const SIGNAL_BUFFER_CAP = 200

const signalsBySession = new Map<string, EconSignal[]>()
const deferralUsedBySession = new Set<string>()

function formatLogLine(signal: EconSignal): SignalLogLine {
  const payload: Record<string, unknown> = {
    "session.id": signal.sessionID,
    severity: signal.severity,
    decision: signal.decision,
    step: signal.step ?? null,
  }
  for (const [key, value] of Object.entries(signal.evidence)) payload[`evidence.${key}`] = value
  return { message: `[signal] ${signal.name}`, payload }
}

/** Record a signal on the session's ring buffer and return its one `[signal]` log line for the call site to emit — exactly one line per publish, `grep '\[signal\]' engine.log` replays the turn's decision history. */
export function publishSignal(signal: EconSignal): SignalLogLine {
  let buffer = signalsBySession.get(signal.sessionID)
  if (!buffer) {
    buffer = []
    signalsBySession.set(signal.sessionID, buffer)
  }
  buffer.push(signal)
  if (buffer.length > SIGNAL_BUFFER_CAP) buffer.splice(0, buffer.length - SIGNAL_BUFFER_CAP)
  return formatLogLine(signal)
}

/** Record a signal AND emit its trace line in one call — the default publish entry for Effect contexts (prompt loop, edit/write tools). */
export function publishSignalFx(signal: EconSignal) {
  const line = publishSignal(signal)
  return Effect.logInfo(line.message, line.payload)
}

/** Every signal recorded for the session this turn, oldest first. */
export function signalsFor(sessionID: string): readonly EconSignal[] {
  return signalsBySession.get(sessionID) ?? []
}

/** The hard-tail subset — the deterministic evidence the deferral consumer routes on. */
export function tailSignals(sessionID: string): readonly EconSignal[] {
  return signalsFor(sessionID).filter((signal) => signal.severity === "tail")
}

/** True until the turn's single deferral is spent — a second exhausted gate in the same turn goes loud exactly as before round F. */
export function deferralAvailable(sessionID: string): boolean {
  return !deferralUsedBySession.has(sessionID)
}

/** Spend the turn's one deferral (the hard-tail second draw is tail-only, once per turn — the cost-shaped bound). */
export function markDeferralUsed(sessionID: string): void {
  deferralUsedBySession.add(sessionID)
}

/** Clear the session's signals and deferral budget — fresh-turn open only, next to resetResolveAttempts; continuation turns inherit. */
export function resetSignals(sessionID: string): void {
  signalsBySession.delete(sessionID)
  deferralUsedBySession.delete(sessionID)
}

/** Per-name publish counts for the session — the turn-summary payload. */
export function signalSummary(sessionID: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const signal of signalsFor(sessionID)) counts[signal.name] = (counts[signal.name] ?? 0) + 1
  return counts
}

/** The `[signal] turn_summary` line emitted at turn end — counts by name plus the deferral budget state. */
export function summaryLogLine(sessionID: string): SignalLogLine {
  return {
    message: "[signal] turn_summary",
    payload: {
      "session.id": sessionID,
      counts: signalSummary(sessionID),
      deferralAvailable: deferralAvailable(sessionID),
    },
  }
}

/** One seam for the headless/interactive fork every consumer routes on — the same env signal slice-orchestrator's resolution gate and permission/index.ts already read. */
export function interactiveSession(): boolean {
  return process.env["OPENCODE_HEADLESS"] !== "1"
}
