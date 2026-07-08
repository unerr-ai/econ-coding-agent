/**
 * The explicit orchestration state machine — the shared, pure contract the SM
 * series is built on. It makes the loop discipline that a cheap tier gets from
 * the harness (rather than from being smart) legible and testable in one place:
 *
 *  - the SLICE loop's squeeze-then-climb becomes a pure `sliceTransition`
 *    reducer with real terminal states, so a settled slice is never
 *    re-dispatched (the run-8 "868 calls / slices never settled" blocker);
 *  - the ROOT turn loop's continuation is expressed as Claude-Code-style
 *    `Continue`/`Terminal` named reasons (query.ts:204-239 pattern);
 *  - a `StuckSupervisor` turns repeated-red / repeated-tool / a test-edit /
 *    no-progress into an escalation signal — the "think harder, then hand up"
 *    reflex the incumbent has to be told to have.
 *
 * Everything here is deterministic (no clock, no randomness, external ops
 * injected) so every transition is table-testable without a live model or shell.
 *
 * @sem domain=routing role=orchestrator
 */

import type { EconTier } from "./region"

// ─────────────────────────────── slice-level FSM ───────────────────────────────

/** Where a single slice sits in its execute → verify → escalate lifecycle. */
export type SlicePhase =
  | "verifying" // a verdict is expected next
  | "squeezing" // retrying the SAME tier while its failure evidence keeps changing (M2)
  | "climbing" // escalated one tier, awaiting the rescue verdict (M3)
  | "settled" // terminal — see `terminal`

/** Why a slice reached its terminal state — the slice analogue of a Terminal reason. */
export type SliceOutcome =
  | "accepted" // a verdict accepted at the first/only dispatch
  | "escalated" // accepted after >=1 squeeze/climb (double-pay was booked)
  | "unverified" // ladder exhausted; soft-settled unverified (absence of a check != failure)
  | "abandoned" // a budget/timeout killed it before it could settle

export interface SliceTerminal {
  outcome: SliceOutcome
  atTier: EconTier
  attempts: number
  reason?: string // e.g. "critical-unverified-at-ceiling", "budget-exhausted"
}

/**
 * The full, explicit slice state — replaces the scattered local tuple
 * (`attempts`/`sameTierRetries`/`climbs`/`atTier`/`lastSignatureAtTier`) that
 * the loop threaded implicitly.
 */
export interface SliceMachineState {
  phase: SlicePhase
  atTier: EconTier
  attempts: number
  sameTierRetries: number
  climbs: number
  lastSignatureAtTier: string | undefined
  terminal: SliceTerminal | undefined
}

/**
 * A verdict reduced to only what the transition needs — kept decoupled from
 * verifier.ts's `VerifierVerdict` so the reducer stays pure and independently
 * testable. `signature` is `${rung}|${missing}`: an identical value across
 * attempts means "no new evidence surfaced" and stops the squeeze.
 */
export interface SliceVerdictLike {
  accepted: boolean
  signature: string
}

export type SliceEvent =
  | { type: "verdict"; verdict: SliceVerdictLike }
  | { type: "budget-exhausted"; reason?: string }

/**
 * Caps and ladder operations, injected so the reducer never hardcodes the tier
 * order or the budgets. `escalate` returns the next tier up or `undefined` once
 * `atTier` is at the slice's allowed ceiling; `atCeiling` bounds the M3 forced
 * climb at the oracle.
 */
export interface SliceTransitionCtx {
  sameTierRetryBudget: number // SAME_TIER_RETRY_BUDGET (2)
  maxClimbs: number // per slice: 1 for a normal slice, 0 for a read-only recon/verify slice
  maxAttempts: number // MAX_SLICE_ATTEMPTS backstop on total dispatches (8)
  isReadOnly: boolean // recon/verify slices never squeeze or climb
  isCritical: boolean // high coupling or risk over the tiebreak → forced-floor climbs (M3)
  escalate: (tier: EconTier) => EconTier | undefined
  atCeiling: (tier: EconTier) => boolean
}

/** The state a slice starts in, already dispatched once on `startTier`. */
export function initialSliceState(startTier: EconTier): SliceMachineState {
  return {
    phase: "verifying",
    atTier: startTier,
    attempts: 1,
    sameTierRetries: 0,
    climbs: 0,
    lastSignatureAtTier: undefined,
    terminal: undefined,
  }
}

function settle(state: SliceMachineState, terminal: SliceTerminal): SliceMachineState {
  return { ...state, phase: "settled", terminal }
}

/**
 * The pure squeeze-then-climb reducer: given the current slice state and a
 * verdict (or budget-exhausted) event, decide the next state. A settled state
 * is absorbing — re-applying any event returns it unchanged, which is what
 * stops the outer loop from re-dispatching a finished slice.
 *
 * @sem domain=routing role=orchestrator
 */
export function sliceTransition(
  state: SliceMachineState,
  event: SliceEvent,
  ctx: SliceTransitionCtx,
): SliceMachineState {
  if (state.terminal) return state // terminal is absorbing (run-8 re-dispatch fix)

  if (event.type === "budget-exhausted") {
    return settle(state, {
      outcome: "abandoned",
      atTier: state.atTier,
      attempts: state.attempts,
      reason: event.reason ?? "budget-exhausted",
    })
  }

  const { verdict } = event
  if (verdict.accepted) {
    const outcome: SliceOutcome = state.attempts > 1 ? "escalated" : "accepted"
    return settle(state, { outcome, atTier: state.atTier, attempts: state.attempts })
  }

  // reject → squeeze the same tier while its failure evidence keeps changing (M2)
  const canSqueeze =
    !ctx.isReadOnly &&
    state.attempts < ctx.maxAttempts &&
    state.sameTierRetries < ctx.sameTierRetryBudget &&
    verdict.signature !== state.lastSignatureAtTier

  if (canSqueeze) {
    return {
      ...state,
      phase: "squeezing",
      attempts: state.attempts + 1,
      sameTierRetries: state.sameTierRetries + 1,
      lastSignatureAtTier: verdict.signature,
    }
  }

  // stalled → climb one tier (M3 forces the climb for a critical slice below the ceiling)
  const higher = ctx.escalate(state.atTier)
  const forcedFloor = ctx.isCritical && !ctx.isReadOnly && !ctx.atCeiling(state.atTier)
  const canClimb =
    higher !== undefined &&
    state.attempts < ctx.maxAttempts &&
    (state.climbs < ctx.maxClimbs || forcedFloor)

  if (canClimb && higher) {
    return {
      ...state,
      phase: "climbing",
      atTier: higher,
      attempts: state.attempts + 1,
      climbs: state.climbs + 1,
      sameTierRetries: 0,
      lastSignatureAtTier: undefined,
    }
  }

  // exhausted → soft-settle unverified (loud at the ceiling for a critical slice)
  return settle(state, {
    outcome: "unverified",
    atTier: state.atTier,
    attempts: state.attempts,
    reason: forcedFloor ? "critical-unverified-at-ceiling" : "ladder-exhausted",
  })
}

/** True once a slice has reached a terminal state — the outer loop must not re-dispatch it. */
export function isSliceTerminal(
  state: SliceMachineState,
): state is SliceMachineState & { terminal: SliceTerminal } {
  return state.terminal !== undefined
}

// ─────────────────────────────── turn-level loop ───────────────────────────────

/** Why the root turn loop continued this iteration (Claude-Code query.ts:216 pattern). */
export type TurnContinueReason =
  | "tool_use" // the model asked for tools; run them and loop
  | "stuck_rethink" // supervisor un-muted the conductor's reasoning for a recovery step (rung 1)
  | "stuck_escalate" // supervisor escalated the tier (rung 2)
  | "probe_gate_retry" // the turn-end probe is still red; re-inject the nudge and retry

/** Why the root turn loop terminated. */
export type TurnTerminalReason =
  | "completed"
  | "max_turns"
  | "probe_unresolved" // probe still red after the retry budget — exits loud, never silent-success
  | "aborted"

/** One step's decision, carrying the reason so every path is logged and testable. */
export type TurnStep =
  | { kind: "continue"; reason: TurnContinueReason }
  | { kind: "terminal"; reason: TurnTerminalReason }

// ─────────────────────────────── stuck supervisor ───────────────────────────────

/** The kind of stuck the supervisor detected — each maps to a recovery rung. */
export type StuckReason = "repeated-red" | "repeated-tool" | "test-edit" | "no-progress"

export interface StuckSignal {
  reason: StuckReason
  signature: string
  count: number
}

/**
 * One observed step of the conductor's inner loop, reduced to comparable
 * signatures. The caller computes the digests (it owns the tool/result shapes);
 * the supervisor only compares them, so it stays deterministic and pure.
 */
export interface StepObservation {
  toolSignature: string // `${toolName}|${argsHash}` — identical repeats = re-issuing the same call
  resultSignature?: string // `${exitCode}|${stdoutDigest}` for a test/command step; undefined otherwise
  editedTestFile?: string // the model edited a test file this step (the fake-green tell), with its path
}

export interface StuckSupervisorConfig {
  repeatThreshold: number // consecutive identical signatures that count as stuck
  noProgressThreshold: number // steps with no fingerprint change that count as no-progress
}

export const DEFAULT_STUCK_CONFIG: StuckSupervisorConfig = {
  repeatThreshold: 3,
  noProgressThreshold: 4,
}

export interface StuckSupervisor {
  /** Feed one step; returns the first stuck signal it triggers, else undefined. */
  observe(step: StepObservation): StuckSignal | undefined
  reset(): void
}

/**
 * Build a stateful stuck-detector for one turn's inner loop. Priority order:
 * a test-edit fires immediately (the fake-green tell), then an identical red
 * result repeated `repeatThreshold` times (the django-11885 12x-thrash caught at
 * the 3rd), then an identical repeated RESULTLESS tool call (a read/edit loop —
 * never a command whose result is changing, which is healthy iteration), then a
 * stagnant fingerprint.
 *
 * @sem domain=routing role=orchestrator
 */
export function createStuckSupervisor(
  config: StuckSupervisorConfig = DEFAULT_STUCK_CONFIG,
): StuckSupervisor {
  let redRun = { sig: "", count: 0 }
  let toolRun = { sig: "", count: 0 }
  let lastFingerprint: string | undefined
  let stagnant = 0

  function tally(run: { sig: string; count: number }, sig: string): number {
    if (sig === run.sig) run.count += 1
    else {
      run.sig = sig
      run.count = 1
    }
    return run.count
  }

  return {
    observe(step) {
      // 1. test-edit — the fake-green tell; escalate before it can fake a pass
      if (step.editedTestFile) {
        return { reason: "test-edit", signature: step.editedTestFile, count: 1 }
      }

      // 2. the same red result seen `repeatThreshold` times (tolerates interleaved reads/edits)
      if (step.resultSignature !== undefined) {
        const n = tally(redRun, step.resultSignature)
        if (n >= config.repeatThreshold) {
          return { reason: "repeated-red", signature: step.resultSignature, count: n }
        }
      }

      // 3. the same resultless tool call re-issued `repeatThreshold` times — a
      // read/edit loop with nothing to show. Gated to steps with no result: a
      // command step's progress IS its result (judged by repeated-red above), so
      // re-running the same command while the result changes is healthy
      // iteration and must not fire here.
      if (step.resultSignature === undefined) {
        const t = tally(toolRun, step.toolSignature)
        if (t >= config.repeatThreshold) {
          return { reason: "repeated-tool", signature: step.toolSignature, count: t }
        }
      }

      // 4. no-progress: the overall fingerprint hasn't changed for `noProgressThreshold` steps
      const fingerprint = `${step.toolSignature}#${step.resultSignature ?? ""}`
      if (fingerprint === lastFingerprint) {
        stagnant += 1
        if (stagnant >= config.noProgressThreshold) {
          return { reason: "no-progress", signature: fingerprint, count: stagnant }
        }
      } else {
        lastFingerprint = fingerprint
        stagnant = 0
      }

      return undefined
    },
    reset() {
      redRun = { sig: "", count: 0 }
      toolRun = { sig: "", count: 0 }
      lastFingerprint = undefined
      stagnant = 0
    },
  }
}
