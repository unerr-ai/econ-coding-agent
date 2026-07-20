/**
 * Prior-uncertainty resolution phase (task #53) — the pure decision table that
 * decides, for an ambiguous/hard task, whether the approach is settled enough
 * to decompose now, needs one more resolution pass first, or needs product
 * intent only a user can supply. Bounded recursion: `resolveAttempts` +
 * `MAX_RESOLVE_ATTEMPTS` guarantee termination even if resolution never
 * converges. Pure: no I/O, no model calls — the opencode-session wiring that
 * drives resolution passes is a separate later task.
 *
 * @sem domain=routing role=controller
 */

import { validatePlan, type PlanNode } from "./evaluator.js"
import type { SliceHardness, SliceAmbiguity } from "./allocation.js"

/**
 * The four outcomes of one resolution-phase decision: proceed straight to
 * decomposition, run (or re-run) a resolution pass to fix the approach first,
 * stop and ask the user (only ever reachable when a user is present), or
 * continue inline without engaging orchestration — an armed turn that already
 * localized keeps working its own todos, with the grind valve as the only
 * escalation.
 *
 * @sem domain=routing role=type
 */
export type ResolutionMode = "decompose-now" | "resolve-first" | "ask-user" | "continue-inline"

/**
 * Inputs to one resolution-phase decision for a flagged (ambiguous/hard) task.
 * `resolveAttempts` is the recursion/termination guard — the caller increments
 * it each time it re-enters this decision after a resolution pass.
 *
 * @sem domain=routing role=type
 */
export interface ResolutionInput {
  /** Task ambiguity from the arming judge; absent → treated as clear (not flagged on this axis). */
  ambiguity?: SliceAmbiguity
  /** Task difficulty from the arming judge; absent → treated as not-hard (not flagged on this axis). */
  hardness?: SliceHardness
  /** A plan produced by a prior resolution pass, if any — checked against `validatePlan` for the short-circuit. */
  candidatePlan?: PlanNode[]
  /** Turn/slice token budget, passed through to `validatePlan` for its synthesis-headroom check. */
  budget: number
  /** True when a real user is present (TUI); false when headless (benchmark/opencode run) — gates `ask-user`. */
  interactive: boolean
  /** The resolution pass concluded the approach needs product intent it can't derive from code. */
  needsUserInput?: boolean
  /** When false, the step-2 valid-plan short-circuit validates `candidatePlan` STRUCTURALLY ONLY — cycles/depth/branching/deps/budget — skipping the per-node objective/outputShape/successCriterion check. Required for todo-derived plans (which carry no node fields). Defaults to true (full validation). */
  requireNodeFields?: boolean
  /** True when the arming judge armed the localization pre-pass (vague diagnosis, location/mechanism unknown). On the FIRST pass this bypasses the step-2 valid-plan short-circuit: a structurally-valid todo skeleton is a plan-shaped guess, not a fixed approach — decompose-blind went 0/3 on the 11885 live fires while localize-inline-first passed 2/2. */
  armLocalization?: boolean
  /** How many resolution passes already ran on this task — the recursion/termination guard. */
  resolveAttempts: number
  /** Direct-first valve precondition: true when at least one diagnosis goal already carries `locationNamed` or `fixSpecified` evidence (the conductor already knows where the fix goes). Absent/false — the valve never fires. */
  diagnosisLocationOrFixKnown?: boolean
  /** Direct-first valve width gate: the candidate plan's writer (editing) slice count. Absent, or above the valve's cap, disqualifies it — the valve only ever narrows an existing `decompose-now`, never widens it. */
  writerSliceCount?: number
  /** A harness-planted escalation slice — the finish-gate deferral seed or the grind valve's design seed — is pending in the todo list. These are gate-mandated escalations carrying executed evidence, never conductor-authored decomposition, so they take top precedence over every armed-turn policy below. */
  escalationSeedPending?: boolean
}

/**
 * One resolution-phase decision: the mode to take next, and why.
 *
 * @sem domain=routing role=type
 */
export interface ResolutionDecision {
  mode: ResolutionMode
  reason: string
}

/**
 * Resolution-pass cap (provisional): after this many resolution attempts on
 * one task, the decision falls through to `decompose-now` regardless of
 * whether the approach converged — the termination guarantee that bounds the
 * recursive resolve-then-recheck loop.
 *
 * @sem domain=routing role=constant
 */
export const MAX_RESOLVE_ATTEMPTS = 2

/**
 * The prior-uncertainty resolution-phase decision table (task #53): for a
 * flagged (ambiguous/hard) task, decide whether to decompose now, resolve the
 * approach first, ask the user, or continue inline — in strict precedence order
 * so exactly one branch ever fires. A harness-mandated escalation seed
 * (`escalationSeedPending`) takes TOP precedence over every branch below,
 * including the armed-turn veto (1b): 1b's 11885 calibration measured
 * conductor-authored decomposition going 0/4 on an armed turn, not a
 * gate-mandated escalation carrying its own executed evidence — applying 1b's
 * veto to a harness-planted deferral/grind seed would be a category error, not
 * a policy the calibration actually covers. A narrow direct-first valve nests
 * inside the valid-plan branch: when the location/fix is already known, the
 * turn is unarmed, this is the first pass, hardness isn't "hard", and the plan
 * is narrow, it returns continue-inline instead of decompose-now for one cheap
 * verified swing. Pure: no I/O.
 *
 * @sem domain=routing role=controller
 */
export function resolutionDecision(input: ResolutionInput): ResolutionDecision {
  // 0. Harness-mandated escalation seed pending — highest precedence, before
  //    "not flagged" and before the armed-turn veto (1b). The finish-gate
  //    deferral seed and the grind valve's design seed are gate-mandated
  //    escalations carrying executed evidence, never conductor-authored
  //    decomposition — 1b's "armed turn never decomposes" policy was
  //    calibrated against the latter, so letting it veto the former would be a
  //    category error, not a real disagreement in the data.
  if (input.escalationSeedPending === true) {
    return {
      mode: "decompose-now",
      reason: "harness escalation seed pending — gate-mandated dispatch, precedes armed-inline policy",
    }
  }

  const flagged = input.ambiguity === "ambiguous" || input.hardness === "hard"

  // 1. Not flagged — no approach uncertainty to resolve; decompose straight away.
  if (!flagged) {
    return { mode: "decompose-now", reason: "approach not uncertain" }
  }

  // 1b. Armed vague diagnosis — an armed turn NEVER decomposes. First pass
  //     (resolveAttempts === 0): localize before slicing — the candidate plan
  //     is a turn-open todo skeleton (a plan-shaped guess) and armLocalization
  //     means the location/mechanism is by definition unknown, so no approach
  //     can be "fixed" yet, and the step-2 short-circuit below must not fire.
  //     After localization (resolveAttempts ≥ 1) the conductor keeps fixing
  //     INLINE (continue-inline) instead of decomposing-with-knowledge: on 11885
  //     the decompose-after-localize route went 0/4 REAL FAIL (three wrong fixes,
  //     one grind timeout) while the inline route went 3/3 REAL PASS, so the
  //     grind valve (turn-supervisor) is the ONLY escalation for an armed turn.
  //     One home for the policy — this single branch precedes 2/3/4.
  if (input.armLocalization === true) {
    if (input.resolveAttempts === 0) {
      return { mode: "resolve-first", reason: "armed vague diagnosis — localize before slicing" }
    }
    return { mode: "continue-inline", reason: "armed turn localized — continue inline, grind valve is the only escalation" }
  }

  // 2. Short-circuit: a prior resolution pass already produced a plan, and it
  //    validates — the approach is fixed, so proceed even though the task was
  //    flagged. Re-resolving a settled, valid plan would waste the budget. The
  //    check honors `requireNodeFields`: structural-only (cycles/depth/branching/deps/budget)
  //    when false, full validation when true (default).
  if (
    input.candidatePlan !== undefined &&
    validatePlan(input.candidatePlan, input.budget, { requireNodeFields: input.requireNodeFields ?? true }).ok
  ) {
    // 2b. Direct-first valve (narrow, item 4 / mini10-11999 forensics): the
    //     conductor already knows where the fix goes (a diagnosis goal named
    //     the location or a fix), this is the FIRST resolution pass on an
    //     unarmed turn, the aggregate hardness isn't "hard", and the plan is
    //     narrow (<=2 writer slices) — take one cheap verified direct-fix
    //     swing inline before paying for decomposition. A failed/incomplete
    //     swing falls through to the rules above unchanged on the next
    //     resolution pass (resolveAttempts >= 1 disqualifies this branch).
    // armLocalization is already guaranteed not-true here (branch 1b above
    // returns early whenever it is true), so this branch's precondition list
    // omits it — TS narrows the type, so an explicit re-check would be a
    // comparison with no overlap, not a real disqualifier.
    if (
      input.resolveAttempts === 0 &&
      input.diagnosisLocationOrFixKnown === true &&
      input.hardness !== "hard" &&
      input.writerSliceCount !== undefined &&
      input.writerSliceCount <= 2
    ) {
      return {
        mode: "continue-inline",
        reason: "direct_first_inline — location/fix already known, narrow plan, one direct-fix window before decomposition",
      }
    }
    return { mode: "decompose-now", reason: "approach fixed, plan valid" }
  }

  // 3. The resolution pass concluded it needs product intent it can't get
  //    from code — but ONLY when a real user is present to answer. Headless
  //    runs (benchmark/opencode run) have no one to ask, so this branch is
  //    skipped there and falls through to the resolve/terminate branches below.
  if (input.needsUserInput === true && input.interactive === true) {
    return { mode: "ask-user", reason: "approach needs product intent" }
  }

  // 4. Termination guarantee: bound the recursive resolve-then-recheck loop.
  //    After MAX_RESOLVE_ATTEMPTS passes with no valid plan (and no answerable
  //    user question), proceed best-effort rather than looping forever.
  if (input.resolveAttempts >= MAX_RESOLVE_ATTEMPTS) {
    return { mode: "decompose-now", reason: "resolution budget exhausted, best-effort" }
  }

  // 5. Otherwise: still flagged, no valid candidate plan yet, under budget —
  //    run (or re-run) the resolution pass to fix the approach.
  return { mode: "resolve-first", reason: "run/re-run the resolution pass to fix the approach" }
}
