/**
 * Cache-aware switch-vs-stay pricing for cross-tier delegation
 * (ORCHESTRATION_MECHANISM §3.3/§4.4): prices whether a recurring slice
 * group is cheaper handled inline by its current warm tier ("stay") or
 * delegated via a compiled brief to another tier ("move"), using each
 * tier's own hit-rate-weighted cache economics — never a hardcoded premium.
 *
 * @sem domain=routing role=pricing
 */

import { ECON_COST_MATRIX } from "./econ-cost"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One tier's cache economics: its $/1M-token rate, how much a cache-hit read
 * is discounted (fraction of the standard rate paid on a hit), how much a
 * cold write is marked up (multiple of the standard rate paid on the first
 * write), and its measured cache-hit reliability. `hitRate` is always
 * caller-supplied — measured, never assumed.
 *
 * @sem domain=routing role=type
 */
export interface TierCacheProfile {
  /** USD per 1M tokens at this tier's standard (uncached) rate. */
  ratePerMTok: number
  /** Fraction of the standard rate paid on a cache-hit read (e.g. 0.1 = 10x cheaper). */
  readDiscount: number
  /** Multiple of the standard rate paid on the first, cold write (1.0 = no premium). */
  writePremium: number
  /** Measured cache-hit rate for this tier's prefix, in [0, 1]. */
  hitRate: number
}

/**
 * Inputs to the switch-vs-stay inequality for one slice group: the tier
 * currently holding it ("stay", with its full re-read context size) against
 * a candidate delegate ("move", with its compiled brief size), over the
 * group's expected call count.
 *
 * @sem domain=routing role=type
 */
export interface SwitchPricingInput {
  /** The tier that already owns this slice group's warm context. */
  stay: TierCacheProfile & { ctxTokens: number }
  /** The candidate tier a compiled brief would move this group to. */
  move: TierCacheProfile & { briefTokens: number }
  /** How many calls this slice group is expected to make. */
  expectedCalls: number
}

// ---------------------------------------------------------------------------
// Defaults (documented — used only when a model's own cache data is absent)
// ---------------------------------------------------------------------------

/** Fallback read discount when a model carries no cached-rate data (~10x, the converged provider norm — §3.3). */
export const DEFAULT_READ_DISCOUNT = 0.1

/** Fallback write premium when a model carries no cache-write-rate data (no premium — the automatic-prefix norm). */
export const DEFAULT_WRITE_PREMIUM = 1.0

// ---------------------------------------------------------------------------
// Core pricing
// ---------------------------------------------------------------------------

/** A tier's own hit-rate-weighted cost multiplier: cheap on a cache hit (readDiscount), full price on a miss. */
function cacheMultiplier(profile: TierCacheProfile): number {
  return profile.hitRate * profile.readDiscount + (1 - profile.hitRate)
}

/**
 * Cost of keeping a slice group on its current ("stay") tier for its
 * expected call count — the group's full context re-read every call,
 * weighted by that tier's own hit rate and read discount (§3.3 Cost_stay).
 *
 * @sem domain=routing role=pricing
 */
export function stayCost(input: Pick<SwitchPricingInput, "stay" | "expectedCalls">): number {
  const { stay, expectedCalls } = input
  if (expectedCalls <= 0 || stay.ctxTokens <= 0) return 0
  const multiplier = cacheMultiplier(stay)
  return (expectedCalls * stay.ctxTokens * stay.ratePerMTok * multiplier) / 1_000_000
}

/**
 * Cost of moving a slice group to a candidate ("move") tier for its expected
 * call count — one cold brief write at the write premium, then every
 * subsequent call re-reading that same brief at the move tier's own
 * hit-rate-weighted discount (§3.3 Cost_switch).
 *
 * @sem domain=routing role=pricing
 */
export function switchCost(input: Pick<SwitchPricingInput, "move" | "expectedCalls">): number {
  const { move, expectedCalls } = input
  if (expectedCalls <= 0 || move.briefTokens <= 0) return 0
  const writeCost = (move.briefTokens * move.ratePerMTok * move.writePremium) / 1_000_000
  const repeatCalls = Math.max(0, expectedCalls - 1)
  const repeatCost =
    (repeatCalls * move.briefTokens * move.ratePerMTok * cacheMultiplier(move)) / 1_000_000
  return writeCost + repeatCost
}

/**
 * The expected-call count at which switchCost and stayCost cross — solved
 * from the two cost lines (both linear in N). Finite and positive only when
 * the move tier's steady per-call rate undercuts the stay tier's (its cold
 * write amortizes over volume); Infinity when stay never loses regardless of
 * volume; a value at or below 1 means switching is already favorable on the
 * first call.
 *
 * @sem domain=routing role=pricing
 */
export function breakEvenCalls(input: SwitchPricingInput): number {
  const { stay, move } = input
  if (stay.ctxTokens <= 0 || move.briefTokens <= 0) return Infinity
  const unitStay = stay.ctxTokens * stay.ratePerMTok * cacheMultiplier(stay)
  const writeCost = move.briefTokens * move.ratePerMTok * move.writePremium
  const repeatUnit = move.briefTokens * move.ratePerMTok * cacheMultiplier(move)
  const denom = unitStay - repeatUnit
  if (denom === 0) {
    // Parallel per-call rates — no crossing; switching is either always or never favorable.
    return writeCost <= unitStay ? 1 : Infinity
  }
  return (writeCost - repeatUnit) / denom
}

/**
 * The switch-vs-stay verdict for one slice group at its actual expected call
 * count: which side is cheaper, by how much, where the two would cross, and
 * why — including the §4.4 hit-rate-alarm reason when either tier's prefix
 * is unreliable (<70%), which is a caching bug to fix, never a routing
 * signal to react to.
 *
 * @sem domain=routing role=pricing
 */
export function shouldSwitch(input: SwitchPricingInput): {
  move: boolean
  delta: number
  breakEven: number
  reasons: string[]
} {
  const stay = stayCost(input)
  const move = switchCost(input)
  const delta = stay - move
  const breakEven = breakEvenCalls(input)
  const reasons: string[] = []

  reasons.push(
    move < stay
      ? `switch cost $${move.toFixed(6)} < stay cost $${stay.toFixed(6)} at ${input.expectedCalls} call(s)`
      : `stay cost $${stay.toFixed(6)} <= switch cost $${move.toFixed(6)} at ${input.expectedCalls} call(s)`,
  )
  if (input.stay.hitRate < 0.7) {
    reasons.push(
      `stay tier hit rate ${input.stay.hitRate} < 0.7 — prefix-invalidation alarm, fix the prefix, don't route around it`,
    )
  }
  if (input.move.hitRate < 0.7) {
    reasons.push(
      `move tier hit rate ${input.move.hitRate} < 0.7 — prefix-invalidation alarm, fix the prefix, don't route around it`,
    )
  }

  return { move: move < stay, delta, breakEven, reasons }
}

// ---------------------------------------------------------------------------
// Profile adapter
// ---------------------------------------------------------------------------

/**
 * Derives a tier's cache-discount fields from econ's own BYOK cost matrix —
 * readDiscount = cachedInput/input, writePremium = cacheWrite/input — the
 * live rates §4.4 rule 3 requires instead of a hardcoded premium. Returns
 * null for a model absent from the matrix; callers fall back to
 * {@link DEFAULT_READ_DISCOUNT}/{@link DEFAULT_WRITE_PREMIUM} (documented
 * ~10x-discount/no-premium defaults) in that case. hitRate is never derived
 * here — it is always caller-supplied and measured.
 *
 * @sem domain=routing role=pricing
 */
export function cacheProfileFor(
  modelKey: string,
): { readDiscount: number; writePremium: number } | null {
  const rate = ECON_COST_MATRIX[modelKey]
  if (!rate || rate.input <= 0) return null
  return {
    readDiscount: rate.cachedInput / rate.input,
    writePremium: rate.cacheWrite / rate.input,
  }
}

// ---------------------------------------------------------------------------
// Group moves (§4.4 rule 4 — groups move together or not at all)
// ---------------------------------------------------------------------------

/** One slice's brief contribution within a same-tier group move. */
export interface GroupMoveSlice {
  briefTokens: number
}

/**
 * Prices a same-tier group of slices as one combined move — summed brief
 * tokens, one write, then repeats over the group's total expected calls —
 * never bounced item-by-item (§4.4 rule 4).
 *
 * @sem domain=routing role=pricing
 */
export function groupMove(
  slices: GroupMoveSlice[],
  move: TierCacheProfile,
  expectedCalls: number,
): { briefTokens: number; cost: number } {
  const briefTokens = slices.reduce((sum, slice) => sum + slice.briefTokens, 0)
  const cost = switchCost({ move: { ...move, briefTokens }, expectedCalls })
  return { briefTokens, cost }
}
