/**
 * Per-slice tier + verifier allocation (OL-7.2) on TWO orthogonal axes
 * (consequence ⟂ difficulty — corpus R5, extended from arming to routing):
 *  - the GENERATOR tier follows DIFFICULTY (the arming judge's hardness/ambiguity,
 *    plus design and unbacked-authoring) — a hard or ambiguous slice floors above
 *    the executor, and ambiguity overrides the testable clamp because a sound check
 *    proves the code RUNS, never that it solved the RIGHT problem (green-but-wrong);
 *  - the VERIFIER rung follows CONSEQUENCE (coupling / risk / blast-radius) — a
 *    tightly-coupled or high-risk slice earns the cross-model judge, regardless of
 *    which tier authored it.
 * Coupling/risk therefore NEVER escalate the author (a rename across 50 files is
 * cheap to do, costly to get wrong — that asymmetry belongs to the verifier); a
 * testable slice stays on the cheap executor unless DIFFICULTY lifts it. Gap-closure
 * §4.3 (2026-07-19): every difficulty floor that used to land the generator on the
 * reasoner (design, unbacked-mechanical, hard/ambiguous, a "reasoner" need hint) now
 * redirects straight to the oracle — the reasoner is judge-only, never a generator,
 * so the solve ladder collapses to one hop above the conductor, no maybe-rung. Pure:
 * no I/O — tiers resolve to concrete models downstream through model-registry
 * (tierModelRef), so nothing here hard-codes a model id.
 *
 * @sem domain=routing role=allocator
 */

import type { EconTier } from "./region"

/**
 * Decomposition slice type (OL-7.1). Only `design` is treated specially by the
 * allocator (it is the insight-heavy type → reasoner, regardless of coupling); the
 * rest flow through the coupling × test-strength matrix.
 *
 * @sem domain=routing role=type
 */
export type SliceType = "design" | "mechanical" | "recon" | "verify"

/** Cross-slice coupling tag from the OL-7.9 probe (probeSliceCoupling). */
export type Coupling = "low" | "high"

/** Whether a sound check exists for the slice (OL-7.9 probeSliceTestStrength). */
export type TestStrength = "testable" | "untestable"

/**
 * Task difficulty (mirrors the arming judge's `hardness`) — a GENERATOR-tier
 * signal, orthogonal to coupling/consequence. `hard` floors the author at the oracle
 * (the reasoner is judge-only, §4.3 — it never solves).
 *
 * @sem domain=routing role=type
 */
export type SliceHardness = "trivial" | "moderate" | "hard"

/**
 * Task ambiguity (mirrors the arming judge's `ambiguity`) — a GENERATOR-tier
 * signal that also OVERRIDES the testable clamp: a sound check proves code runs,
 * never that it solved the right problem, so ambiguity is the one failure a green
 * suite cannot catch.
 *
 * @sem domain=routing role=type
 */
export type SliceAmbiguity = "clear" | "ambiguous"

/**
 * Verifier rung that must gate a slice before acceptance, listed weakest-last:
 *  - "sound"  — sound checks (typecheck + targeted tests + static analysis; the
 *               bounded ≤2 test-refine loop for mechanical). Trustworthy when green.
 *  - "qe"     — QE self-consistency veto (agreement across a couple of samples);
 *               used when no sound check exists but the slice is independent.
 *  - "judge"  — cross-model judge (a different model family reviews the output);
 *               the strongest rung available for untestable, coupled work.
 * (The optional execution-free reward-model rung of OL-7.8a sits between `sound`
 * and `judge` but is off by default and out of this pure allocator's scope.)
 *
 * @sem domain=routing role=type
 */
export type VerifierRung = "sound" | "qe" | "judge"

/**
 * Machine-readable code for the factor that decided a slice's tier — the matrix
 * cell that set the floor, or the tiebreaker/hint that overrode it (SM5 routing
 * telemetry). Callers log it; nothing here parses it back into a decision.
 *
 * @sem domain=routing role=type
 */
export type AllocationReasonCode =
  | "design-insight"
  | "testable-invariant"
  | "difficulty-floor"
  | "mechanical-unbacked"
  | "untestable-default"
  | "need-hint"

/**
 * One slice's structural features. `coupling`/`testStrength` come from the OL-7.9
 * probes; `need` is the conductor's optional minimum-tier hint; `risk` is the
 * optional OL-3 code-structural score (0–100), used only as an in-cell tiebreaker.
 * All fields optional so a partially-tagged slice still allocates defensively.
 *
 * @sem domain=routing role=type
 */
export interface SliceAllocationInput {
  /** Slice type from typed decomposition (OL-7.1); only `design` changes the floor. */
  sliceType?: SliceType
  /** Cross-slice coupling; absent → treated as `low`. */
  coupling?: Coupling
  /** Sound-check availability; absent → treated as `untestable` (no assumed safety net). */
  testStrength?: TestStrength
  /**
   * Conductor's minimum-tier hint (an EconTier name). It can RAISE the tier above
   * the matrix floor, never lower it, and can never lift a testable slice above
   * executor — the safety-net invariant overrides an over-eager hint.
   */
  need?: string
  /** Optional OL-3 risk score 0–100; a high score breaks the low-coupling·untestable borderline toward oracle. */
  risk?: number
  /**
   * True when this slice's edit is backed by an upstream design slice's concrete
   * patch (the design-emits-the-patch contract): the slice transcribes, it does
   * not invent. An unbacked mechanical edit with no sound check is authored code
   * with no spec and no safety net — it allocates to the oracle, not the executor
   * (§4.3 — the reasoner never solves).
   */
  specBacked?: boolean
  /**
   * Task difficulty from the arming judge — a GENERATOR-tier lever (never the
   * verifier). `hard` floors the author at the oracle (§4.3 — the reasoner is
   * judge-only). Absent → no difficulty signal.
   */
  hardness?: SliceHardness
  /**
   * Task ambiguity from the arming judge — a GENERATOR-tier lever that also
   * overrides the testable clamp (tests can't catch a misinterpretation). Absent → clear.
   */
  ambiguity?: SliceAmbiguity
}

/**
 * The resolved allocation for one slice: the executing tier, the gating verifier
 * rung, a machine-readable code for the deciding factor, and a human-readable
 * trace of the cell + tiebreakers applied.
 *
 * @sem domain=routing role=type
 */
export interface SliceAllocation {
  /** Model tier that executes the slice (an ECON_TIER_BINDING key). */
  tier: EconTier
  /** Verifier rung that must gate the slice before acceptance. */
  verification: VerifierRung
  /**
   * Machine-readable code for the factor that decided `tier` (routing telemetry).
   * Optional so a hand-built `SliceAllocation` (e.g. a re-derived post-evaluate
   * allocation, or a test fixture) doesn't need one — `allocateSlice` always sets it.
   */
  reasonCode?: AllocationReasonCode
  /** Explanation of the matrix cell chosen and any tiebreakers applied. */
  reason: string
}

/**
 * Tier strictness order (cheap → expensive) for max/min comparisons across the
 * routing layer. Exported so evaluator.ts (and any other tier-comparing
 * module) imports this single source instead of keeping its own copy.
 *
 * @sem domain=routing role=config
 */
export const TIER_RANK: Record<EconTier, number> = {
  conductor: 0,
  executor: 1,
  reasoner: 2,
  oracle: 3,
}

/** `TIER_RANK`'s keys ordered cheapest → priciest; index i has rank i. */
const TIER_BY_RANK: EconTier[] = ["conductor", "executor", "reasoner", "oracle"]

/**
 * Risk score above which the low-coupling·untestable borderline cell breaks
 * toward oracle (and its verifier toward the cross-model judge). Matches the
 * OL-3 router's default `escalateAbove` so the two agree on "high risk".
 *
 * @sem domain=routing role=config
 */
export const ALLOCATION_RISK_TIEBREAK = 70

/** Parse a `need` hint into an EconTier, or undefined if it isn't a known tier. */
function parseTier(need: string | undefined): EconTier | undefined {
  if (need === undefined) return undefined
  return need in TIER_RANK ? (need as EconTier) : undefined
}

/** The stricter (more expensive) of two tiers. */
function higherTier(a: EconTier, b: EconTier): EconTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b
}

/**
 * The tier one step cheaper than `tier`, or `tier` itself if already the
 * floor. §4.3: mirrors `escalateTier`'s up-direction skip — a round-down
 * never lands on the judge-only reasoner rung either (evaluate()'s only
 * caller could otherwise round an oracle-floored slice down onto it), so a
 * step that would land there continues one more step to the executor.
 */
export function lowerTier(tier: EconTier): EconTier {
  const rank = TIER_RANK[tier]
  if (rank === 0) return tier
  const down = TIER_BY_RANK[rank - 1]
  return down === "reasoner" ? "executor" : down
}

/**
 * Allocate one decomposed slice: the GENERATOR tier from DIFFICULTY (hardness/
 * ambiguity + design/unbacked-authoring) and the VERIFIER rung from CONSEQUENCE
 * (coupling/risk). Coupling/risk raise the verifier (→ judge), never the author;
 * a testable slice stays on the executor unless ambiguity/hardness lifts it (the
 * sound net can't catch a misinterpretation). `need` is the conductor's hint and
 * can raise the tier but not past the testable clamp — unless difficulty already
 * broke it. Every generator path that would land on the reasoner (design,
 * unbacked-mechanical, the difficulty floor, or a "reasoner" need hint) redirects
 * to the oracle instead (§4.3 — the reasoner is judge-only, the solve ladder is
 * one hop above the conductor). Returns a machine-readable `reasonCode` alongside
 * the prose `reason` trace so callers can log which factor decided the tier.
 *
 * @sem domain=routing role=allocator
 */
export function allocateSlice(input: SliceAllocationInput): SliceAllocation {
  const sliceType = input.sliceType
  const coupling: Coupling = input.coupling === "high" ? "high" : "low"
  // An absent test-strength is treated as untestable — we do not assume a safety
  // net we haven't observed. With coupling defaulting low, this still lands cheap
  // (executor + QE), so the conservative default is not a cost hit.
  const testStrength: TestStrength = input.testStrength === "testable" ? "testable" : "untestable"
  const testable = testStrength === "testable"
  const highCoupling = coupling === "high"
  const riskHigh = typeof input.risk === "number" && input.risk > ALLOCATION_RISK_TIEBREAK

  const notes: string[] = []

  // --- Verifier rung: follows test-strength, with coupling/risk choosing the
  //     untestable rung. A sound check, where one exists, is always the strongest.
  let verification: VerifierRung
  if (testable) {
    verification = "sound"
  } else if (highCoupling) {
    verification = "judge"
  } else {
    // low-coupling · untestable: QE self-consistency by default; the cross-model
    // judge when risk breaks the borderline (risk as verifier-strictness tiebreaker).
    verification = riskHigh ? "judge" : "qe"
  }

  // --- Generator tier. STRUCTURE (coupling/risk) sets only a cheap default here;
  //     it no longer escalates the AUTHOR — consequence already routed the VERIFIER
  //     above (high coupling / high risk → judge). DIFFICULTY (hardness/ambiguity)
  //     is the sole structural→generator lever, applied as a floor just below.
  //     (Consequence ⟂ difficulty — corpus R5, extended from arming to routing.)
  let tier: EconTier
  let reasonCode: AllocationReasonCode
  if (sliceType === "design") {
    // SM5: design is insight-heavy — it exceeds the executor by construction and
    // coupling never demotes it. §4.3: the reasoner is judge-only now, so the
    // insight-heavy floor lands straight on the oracle — one hop, no maybe-rung.
    tier = "oracle"
    reasonCode = "design-insight"
    notes.push("design slice → oracle (insight-heavy; reasoner is judge-only)")
  } else if (!testable && sliceType === "mechanical" && input.specBacked !== true) {
    // An UNBACKED mechanical edit with no sound check: authoring code with neither a
    // design patch to transcribe nor a check to catch it — a capability (difficulty)
    // need, not a consequence one. §4.3: the oracle authors it directly (spec-backed
    // edits stay executor: transcription + QE is safe and cheap; the reasoner never
    // solves).
    tier = "oracle"
    reasonCode = "mechanical-unbacked"
    notes.push("untestable mechanical without a design patch → oracle authors the edit")
  } else {
    // Every remaining cell — INCLUDING high-coupling·untestable — starts on the cheap
    // executor. Coupling is CONSEQUENCE: it already raised the verifier to `judge`
    // above; it must NOT raise the author. A rename across 50 files is cheap to DO and
    // costly to get WRONG — that asymmetry belongs to the verifier, never the tier.
    tier = "executor"
    reasonCode = testable ? "testable-invariant" : "untestable-default"
    notes.push(
      testable
        ? highCoupling
          ? "high-coupling · testable → executor (the sound check holds the coupling)"
          : "low-coupling · testable → executor"
        : highCoupling
          ? "high-coupling · untestable → executor (coupling routes the judge verifier, not the author)"
          : "low-coupling · untestable → executor",
    )
  }

  // --- Difficulty floor: the GENERATOR axis. Only ambiguity/hardness — never
  //     coupling/risk — raise the AUTHOR. Ambiguity OVERRIDES the testable clamp: a
  //     sound check proves the code RUNS, never that it solved the RIGHT problem, so
  //     an ambiguous spec is the one failure a green suite cannot catch
  //     (confident-wrong). `hard` needs reasoning depth the executor lacks.
  if (input.hardness === "hard" || input.ambiguity === "ambiguous") {
    // §4.3: the difficulty floor lands on the oracle directly — the reasoner is
    // judge-only now, no longer an intermediate solve rung between the executor
    // and the oracle.
    const floored = higherTier(tier, "oracle")
    if (floored !== tier) {
      tier = floored
      reasonCode = "difficulty-floor"
      notes.push(
        input.ambiguity === "ambiguous"
          ? "ambiguous spec → oracle floor (a sound check can't catch a misinterpretation)"
          : "hard task → oracle floor (reasoning depth beyond the executor)",
      )
    }
  }

  // --- Conductor `need` hint: can RAISE the tier above the floor, but never lifts a
  //     testable slice above executor — the sound-net invariant overrides an over-eager
  //     hint. Exempt: design, and a testable slice already lifted by the difficulty
  //     floor (once ambiguity broke the sound-net invariant, a need hint may raise too).
  const needTier = parseTier(input.need)
  if (needTier !== undefined && TIER_RANK[needTier] > TIER_RANK[tier]) {
    if (testable && sliceType !== "design" && reasonCode !== "difficulty-floor") {
      notes.push(`need="${input.need}" ignored: testable slice is clamped to executor (sound-net invariant)`)
    } else {
      // §4.3: a "reasoner" need hint is honored as a request for more than the
      // matrix floor, redirected to the one solve rung above conductor (oracle)
      // — the reasoner is judge-only and never generates.
      tier = needTier === "reasoner" ? "oracle" : needTier
      reasonCode = "need-hint"
      notes.push(
        needTier === "reasoner"
          ? `need="${input.need}" raised the tier (reasoner is judge-only → oracle)`
          : `need="${input.need}" raised the tier`,
      )
    }
  }

  return { tier, verification, reasonCode, reason: notes.join("; ") }
}
