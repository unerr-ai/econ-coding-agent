/**
 * Per-slice tier + verifier allocation (OL-7.2) — the (coupling × test-strength)
 * matrix that decides, for one decomposed slice, which model tier executes it and
 * which verifier rung must gate it. The decomposition-first reframe's core rule
 * lives here: a high-coupling *testable* slice stays on the cheap executor because
 * a sound check (compile / tests / types) is the safety net — so coupling never
 * escalates a checkable slice. Only design slices and the untestable+high-coupling
 * residual reach the oracle. Coupling and test-strength are the primary allocator;
 * risk and the conductor's `need` hint are tiebreakers within a cell, never the
 * primary lever. Pure: no I/O — tiers resolve to concrete models downstream through
 * model-registry (tierModelRef), so nothing here hard-codes a model id.
 *
 * @sem domain=routing role=allocator
 */

import type { EconTier } from "./region"

/**
 * Decomposition slice type (OL-7.1). Only `design` is treated specially by the
 * allocator (it is the irreducible-reasoning type → oracle); the rest flow
 * through the coupling × test-strength matrix.
 *
 * @sem domain=routing role=type
 */
export type SliceType = "design" | "mechanical" | "recon" | "verify"

/** Cross-slice coupling tag from the OL-7.9 probe (probeSliceCoupling). */
export type Coupling = "low" | "high"

/** Whether a sound check exists for the slice (OL-7.9 probeSliceTestStrength). */
export type TestStrength = "testable" | "untestable"

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
   * with no spec and no safety net — it allocates to the reasoner, not the executor.
   */
  specBacked?: boolean
}

/**
 * The resolved allocation for one slice: the executing tier and the gating
 * verifier rung, plus a human-readable trace of the cell + tiebreakers applied.
 *
 * @sem domain=routing role=type
 */
export interface SliceAllocation {
  /** Model tier that executes the slice (an ECON_TIER_BINDING key). */
  tier: EconTier
  /** Verifier rung that must gate the slice before acceptance. */
  verification: VerifierRung
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

/** The tier one step cheaper than `tier`, or `tier` itself if already the floor. */
export function lowerTier(tier: EconTier): EconTier {
  const rank = TIER_RANK[tier]
  return rank === 0 ? tier : TIER_BY_RANK[rank - 1]
}

/**
 * Allocate one decomposed slice to a model tier + verifier rung using the
 * (coupling × test-strength) matrix (OL-7.2). Coupling and test-strength are the
 * primary allocator; the `design` slice type forces the oracle floor; `risk` and
 * the conductor's `need` hint act only as in-cell tiebreakers. Never escalates a
 * testable slice off the cheap executor — that invariant is the whole reframe.
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

  // --- Matrix tier (the primary allocator).
  let tier: EconTier
  if (sliceType === "design") {
    tier = "oracle"
    notes.push("design slice → oracle (irreducible reasoning)")
  } else if (testable) {
    // CORE INVARIANT: a testable slice stays on the cheap executor regardless of
    // coupling — the sound check is the safety net, so coupling never escalates a
    // checkable slice. This is the decomposition-first reframe's whole point.
    tier = "executor"
    notes.push(
      highCoupling
        ? "high-coupling · testable → executor (deterministic wiring + sound verify hold the coupling — the core invariant, NOT oracle)"
        : "low-coupling · testable → executor",
    )
  } else if (highCoupling) {
    // The residual: tightly-coupled AND uncheckable — the only structural cell
    // that reaches the oracle.
    tier = "oracle"
    notes.push("high-coupling · untestable → oracle (the residual)")
  } else if (sliceType === "mechanical" && input.specBacked !== true) {
    // An UNBACKED mechanical edit in the untestable cell: the executor would be
    // inventing code with neither a design patch to transcribe nor a sound check
    // to catch it — the plausible-but-wrong cell. The reasoner authors it instead
    // (spec-backed edits stay executor: transcription + QE is safe and cheap).
    tier = "reasoner"
    notes.push("low-coupling · untestable · mechanical without a design patch → reasoner authors the edit")
  } else {
    tier = "executor"
    notes.push("low-coupling · untestable → executor")
  }

  // --- Risk tiebreaker: only breaks the low-coupling·untestable borderline
  //     (the doc's "executor/oracle" cell) toward oracle. Never touches a
  //     testable cell (invariant) or the already-oracle cells.
  if (!testable && !highCoupling && riskHigh) {
    tier = higherTier(tier, "oracle")
    notes.push(`risk=${input.risk} > ${ALLOCATION_RISK_TIEBREAK}: borderline broken toward oracle`)
  }

  // --- Conductor `need` hint: can RAISE the tier above the matrix floor, but can
  //     never lift a testable slice above executor — the safety-net invariant
  //     overrides an over-eager hint (design keeps its oracle floor and is exempt).
  const needTier = parseTier(input.need)
  if (needTier !== undefined && TIER_RANK[needTier] > TIER_RANK[tier]) {
    if (testable && sliceType !== "design") {
      notes.push(`need="${input.need}" ignored: testable slice is clamped to executor (safety-net invariant)`)
    } else {
      tier = needTier
      notes.push(`need="${input.need}" raised the tier`)
    }
  }

  return { tier, verification, reason: notes.join("; ") }
}
