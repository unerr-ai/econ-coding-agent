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
  reason?: string // e.g. "critical-unverified-review", "ladder-exhausted", "budget-exhausted"
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
 * `atTier` is at the slice's allowed ceiling. Every slice — critical or not — is
 * bounded by `maxClimbs`: consequence (isCritical) no longer buys extra generator
 * climbs (blast-radius routes the judge verifier instead, allocation.ts), it only
 * marks an unverifiable settle as loud-for-review.
 */
export interface SliceTransitionCtx {
  sameTierRetryBudget: number // SAME_TIER_RETRY_BUDGET (2)
  maxClimbs: number // per slice: 1 for a normal slice, 0 for a read-only recon/verify slice
  maxAttempts: number // MAX_SLICE_ATTEMPTS backstop on total dispatches (8)
  isReadOnly: boolean // recon/verify slices never squeeze or climb
  isCritical: boolean // high coupling/risk (consequence): marks an unverifiable settle loud-for-review — NOT extra generator climbs
  escalate: (tier: EconTier) => EconTier | undefined
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

  // stalled → climb one tier. Consequence (isCritical) no longer buys extra
  // generator climbs: blast-radius routes the judge VERIFIER (allocation.ts), not
  // the author. Every slice — critical or not — is bounded by maxClimbs on the
  // difficulty axis (a genuine reject earns one climb; predicted difficulty was
  // already priced up-front by allocateSlice's difficulty floor).
  const higher = ctx.escalate(state.atTier)
  const canClimb = higher !== undefined && state.attempts < ctx.maxAttempts && state.climbs < ctx.maxClimbs

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

  // exhausted → soft-settle unverified. A critical slice we could not verify settles
  // LOUDLY (flag for review) rather than force-authoring at the oracle — the
  // consequence response is a stricter verifier + review, never more generator spend.
  const criticalUnverified = ctx.isCritical && !ctx.isReadOnly
  return settle(state, {
    outcome: "unverified",
    atTier: state.atTier,
    attempts: state.attempts,
    reason: criticalUnverified ? "critical-unverified-review" : "ladder-exhausted",
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

/**
 * The kind of stuck the supervisor detected — each maps to a recovery rung.
 * Conservative by design: only genuinely pathological behaviour fires, never
 * normal work (diverse exploration or progressive edits to one file).
 *   - test-edit        the model edited a test (the fake-green cheat)
 *   - repeated-red     the same failing command result, over and over
 *   - repeated-tool    the EXACT same call (tool + args) re-issued verbatim
 *   - no-op            steps that perform no operation at all
 *   - excessive-reread the same file pulled up many times without acting on it
 */
export type StuckReason = "repeated-red" | "repeated-tool" | "test-edit" | "no-op" | "excessive-reread"

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
  toolSignature: string // `${tool}:${target}#${hash(input)}` — a verbatim repeat = re-issuing the same call; "" = no operation
  resultSignature?: string // `${exitCode}|${stdoutDigest}` for a test/command step; undefined otherwise
  editedTestFile?: string // the model edited a test file this step (the fake-green tell), with its path
  readFiles?: readonly string[] // file paths this step read — feeds the excessive-reread tally
  progressed?: boolean // the step ran a command or landed an edit — a productive action that clears the reread tally
}

export interface StuckSupervisorConfig {
  repeatThreshold: number // consecutive identical signatures (a verbatim repeat, or an identical red result) that count as stuck
  noopThreshold: number // consecutive no-operation steps that count as stalled
  rereadThreshold: number // reads of one file, without an intervening productive action, that count as circling
}

export const DEFAULT_STUCK_CONFIG: StuckSupervisorConfig = {
  repeatThreshold: 3,
  noopThreshold: 3,
  rereadThreshold: 5,
}

export interface StuckSupervisor {
  /** Feed one step; returns the first stuck signal it triggers, else undefined. */
  observe(step: StepObservation): StuckSignal | undefined
  reset(): void
}

/**
 * Build a stateful stuck-detector for one turn's inner loop. Conservative:
 * it fires only on genuinely pathological behaviour, never on normal work
 * (diverse exploration or several different edits to one file). Priority order:
 *   1. test-edit        — editing a test file (the fake-green cheat), immediate.
 *   2. excessive-reread — one file read `rereadThreshold` times without acting on it.
 *   3. repeated-red     — the same failing command result `repeatThreshold` times.
 *   4. no-op            — `noopThreshold` steps in a row that perform no operation.
 *   5. repeated-tool    — the EXACT same call (tool + args) re-issued verbatim
 *                         `repeatThreshold` times; the signature hashes the full
 *                         input, so progressive edits and diverse reads never collide.
 *
 * @sem domain=routing role=orchestrator
 */
export function createStuckSupervisor(
  config: StuckSupervisorConfig = DEFAULT_STUCK_CONFIG,
): StuckSupervisor {
  let redRun = { sig: "", count: 0 }
  let dupRun = { sig: "", count: 0 }
  let noopRun = 0
  const rereads = new Map<string, number>()

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
      // 1. test-edit — the fake-green tell; fire before it can fake a pass.
      if (step.editedTestFile) {
        return { reason: "test-edit", signature: step.editedTestFile, count: 1 }
      }

      // 2. excessive-reread — the same file pulled up `rereadThreshold` times without
      // acting on it. A productive step (an edit or a command) is fresh progress and
      // clears every file's tally: a read that follows an edit is re-verification, not
      // circling. Only a run of pure reads returning to one file trips this.
      if (step.progressed) {
        rereads.clear()
      } else if (step.readFiles) {
        for (const file of step.readFiles) {
          const n = (rereads.get(file) ?? 0) + 1
          rereads.set(file, n)
          if (n >= config.rereadThreshold) {
            return { reason: "excessive-reread", signature: file, count: n }
          }
        }
      }

      // 3. repeated-red — the same failing command result `repeatThreshold` times.
      // Its tally only advances on result steps, so it tolerates interleaved
      // reads/edits (the django-11885 12x-thrash caught at the 3rd). A command step
      // ends here: its progress IS its result, never the verbatim-repeat check below.
      if (step.resultSignature !== undefined) {
        noopRun = 0
        const n = tally(redRun, step.resultSignature)
        if (n >= config.repeatThreshold) {
          return { reason: "repeated-red", signature: step.resultSignature, count: n }
        }
        return undefined
      }

      // 4. no-op — the step performed no operation at all (empty signature),
      // `noopThreshold` times in a row: the model is stalling, producing nothing.
      if (step.toolSignature === "") {
        noopRun += 1
        if (noopRun >= config.noopThreshold) {
          return { reason: "no-op", signature: "", count: noopRun }
        }
        return undefined
      }

      // 5. repeated-tool — the EXACT same call (tool + args) re-issued
      // `repeatThreshold` times. The signature hashes the full input, so progressive
      // edits to one file and diverse reads yield distinct signatures and never
      // collide — only a verbatim repeat does (run 11885 v1/v2 false positives).
      noopRun = 0
      const t = tally(dupRun, step.toolSignature)
      if (t >= config.repeatThreshold) {
        return { reason: "repeated-tool", signature: step.toolSignature, count: t }
      }

      return undefined
    },
    reset() {
      redRun = { sig: "", count: 0 }
      dupRun = { sig: "", count: 0 }
      noopRun = 0
      rereads.clear()
    },
  }
}
