/**
 * Pre-dispatch evaluator (ORCHESTRATION_MECHANISM.md §1.3/§4.2, task U4a) — the
 * dispatch-time and re-dispatch gate that decides a task's tier AND its venue
 * (inline vs child) before the work is cast, plus the two plan-integrity checks
 * that keep a decomposed tree honest before spend: the decomposition quality
 * gate (`validatePlan`) and the mid-flight re-decomposition triggers
 * (`redecompositionCheck`). `evaluate()` delegates the base tier — pins,
 * ceilings, the design floor, the testable-safety-net invariant — to
 * `allocateSlice` and never re-implements it; it only adds the one sanctioned
 * de-escalation path (mechanical work behind a strong safety net), the venue
 * affinity rule, the cache-switch guard, and per-turn hysteresis. Pure: no I/O,
 * Bun-only.
 *
 * @sem domain=routing role=evaluator
 */

import { allocateSlice, lowerTier, TIER_RANK, type SliceAllocationInput } from "./allocation.js"
import type { EconTier } from "./region.js"

/** Triage goal shapes treated as decision-shaped ambiguity (§1.1's "needs a plan first"). */
const DECISION_SHAPED_TRIAGE_SHAPES = new Set(["diagnosis-vague"])

/**
 * Inline-vs-child affinity inputs (§4.2 rule 4 / Q9, decided qualitative): same
 * tier + same files/entities in scope stays on the requesting thread; a tier
 * change, read-only parallel work, or genuinely diverging context spawns a
 * child. One or two small same-tier items are always cheaper inline.
 *
 * @sem domain=routing role=type
 */
export interface EvalVenueContext {
  /** The tier of the thread that would otherwise dispatch this task. */
  requestingTier: EconTier
  /** True when the task's edit scope overlaps the requesting thread's open files/entities. */
  sameFilesInScope: boolean
  /** True when the work is read-only and parallelizable (the one fan-out shape that pays). */
  readOnlyParallel: boolean
  /** Count of small items being dispatched together, when known. 1–2 always inline. */
  smallItemCount?: number
}

/**
 * Everything `evaluate()` needs at dispatch (and re-dispatch) time: the
 * allocation-input fields (flattened in, so `evaluate()` can hand `this`
 * straight to `allocateSlice`), triage's read on the goal, attempt history,
 * risk context, verification strength, containment availability, the venue
 * affinity inputs, a precomputed cache-switch term, and per-turn hysteresis
 * state. `cache` is the only optional top-level field — its absence means no
 * switch-cost signal is available yet, not that switching is free.
 *
 * @sem domain=routing role=type
 */
export interface EvalContext extends SliceAllocationInput {
  /** Triage's read on this task: ambiguity shape and how many goals this turn tracks. */
  triage: {
    shape?: string
    goalCount?: number
  }
  /** Dispatch attempts so far on this slice, and why the last one was rejected (if any). */
  history: {
    attempts: number
    lastRejectReason?: string
  }
  /** Prior-failure / blast-radius notes surfaced by the graph (rsk anchors, coupling notes). Receipt context only — the score itself reaches allocate() via `risk`. */
  riskNotes: string[]
  /** Whether a failure would even be detected, and how well. */
  verifyStrength: {
    hasVerifyCommands: boolean
    testStrength?: "testable" | "untestable"
  }
  /** Whether a rejected attempt can be restored to a clean tree (U3's snapshot bracket). */
  containmentAvailable: boolean
  /** Affinity inputs for the inline-vs-child decision. */
  venue: EvalVenueContext
  /** Precomputed switch-cost delta (§1.7/§3.3); positive means moving tiers costs more. The caller prices this — evaluate() never imports the cache-switch helper. */
  cache?: {
    switchDelta?: number
  }
  /** Per-turn hysteresis state (Q6): the tier this slice last ran at, and whether a new signal arrived since. */
  hysteresis: {
    lastTier?: EconTier
    signalDelta: boolean
  }
}

/**
 * `evaluate()`'s output: the decided tier, the decided venue, and one
 * human-readable reason per rule that fired — the receipt's evaluator
 * drilldown is built directly from this array.
 *
 * @sem domain=routing role=type
 */
export interface EvalVerdict {
  tier: EconTier
  venue: "inline" | "child"
  reasons: string[]
}

/**
 * Decide a task's tier and venue at dispatch (and re-dispatch) time, per
 * §4.2's six-rule priority order: allocate()'s base (pins/ceilings/design
 * floor/testable invariant) → decision-shaped ambiguity guard → the one
 * sanctioned mechanical round-down → venue affinity → cache-switch guard →
 * per-turn hysteresis. Every rule that changes or holds the tier/venue appends
 * a reason string. Pure: no I/O.
 *
 * @sem domain=routing role=evaluator
 */
export function evaluate(ctx: EvalContext): EvalVerdict {
  const reasons: string[] = []

  if (ctx.riskNotes.length > 0) {
    reasons.push(`risk notes: ${ctx.riskNotes.join("; ")}`)
  }
  if (ctx.history.attempts > 0) {
    reasons.push(
      `history: attempt #${ctx.history.attempts + 1}` +
        (ctx.history.lastRejectReason ? ` (prior reject: ${ctx.history.lastRejectReason})` : ""),
    )
  }

  // (1) Base allocation — pins, ceilings, the design floor, the testable
  //     safety-net invariant. Never re-implemented; evaluate() only adds to it.
  const base = allocateSlice(ctx)
  let tier: EconTier = base.tier
  reasons.push(`base: ${base.reason}`)
  // The floor this decision must never drop below via the cache guard (5) —
  // captured before the one de-escalation path (3) can lower `tier`.
  const floorTier = tier

  // (2) Decision-shaped ambiguity rounds up — allocateSlice already forces the
  //     reasoner floor for sliceType "design"; this rule's job here is only to
  //     make sure step (3) never undercuts an ambiguous, decision-shaped goal.
  const decisionShaped =
    ctx.sliceType === "design" ||
    (ctx.triage.shape !== undefined && DECISION_SHAPED_TRIAGE_SHAPES.has(ctx.triage.shape))
  if (decisionShaped) {
    reasons.push(`decision-shaped ambiguity (${ctx.triage.shape ?? ctx.sliceType}): round-down blocked`)
  }

  // (3) Mechanical round-down — the only de-escalation path (Q5): one tier
  //     down, only when verification is strong AND a failed attempt can be
  //     contained (restored to a clean tree).
  const verifyStrong = ctx.verifyStrength.hasVerifyCommands === true && ctx.verifyStrength.testStrength === "testable"
  if (ctx.sliceType === "mechanical" && !decisionShaped) {
    if (verifyStrong && ctx.containmentAvailable) {
      const down = lowerTier(tier)
      if (down !== tier) {
        reasons.push(`round-down: mechanical + strong verify + containment available → ${down} (was ${tier})`)
        tier = down
      } else {
        reasons.push(`round-down eligible but ${tier} is already the floor tier`)
      }
    } else if (!ctx.containmentAvailable) {
      reasons.push("round-down blocked: containment unavailable")
    } else {
      reasons.push("round-down blocked: verify strength not strong enough")
    }
  }

  // (4) Venue — the affinity rule (Q9), decided against the tier settled so
  //     far (steps 1–3).
  const { requestingTier, sameFilesInScope, readOnlyParallel, smallItemCount } = ctx.venue
  const smallBatch = requestingTier === tier && typeof smallItemCount === "number" && smallItemCount >= 1 && smallItemCount <= 2
  let venue: "inline" | "child"
  if (requestingTier === tier && sameFilesInScope) {
    venue = "inline"
    reasons.push(`venue: same tier (${tier}) + same files/entities in scope → inline`)
  } else if (readOnlyParallel) {
    venue = "child"
    reasons.push("venue: read-only parallel work → child")
  } else if (requestingTier !== tier) {
    venue = "child"
    reasons.push(`venue: tier differs (requesting ${requestingTier}, decided ${tier}) → child`)
  } else if (smallBatch) {
    venue = "inline"
    reasons.push(`venue: ${smallItemCount} small same-tier item(s) → inline`)
  } else {
    venue = "child"
    reasons.push("venue: context diverges from the requesting thread → child")
  }

  // (5) Cache — moving tiers costs more when the switch delta is positive;
  //     keep the prior (owner) tier if it's still capable — never below the
  //     pins/ceilings/round-up floor from steps (1)-(2).
  const switchDelta = ctx.cache?.switchDelta
  const priorTier = ctx.hysteresis.lastTier
  if (typeof switchDelta === "number" && switchDelta > 0 && priorTier !== undefined && priorTier !== tier) {
    if (TIER_RANK[priorTier] >= TIER_RANK[floorTier]) {
      reasons.push(`cache: switchDelta=${switchDelta} > 0 → keep prior tier ${priorTier} instead of ${tier} (moving costs more)`)
      tier = priorTier
    }
  }

  // (6) Hysteresis — no new signal this turn → the last-dispatched tier wins
  //     over a marginal re-evaluation.
  if (ctx.hysteresis.lastTier !== undefined && !ctx.hysteresis.signalDelta) {
    if (ctx.hysteresis.lastTier !== tier) {
      reasons.push(`hysteresis: no signal delta → holding lastTier ${ctx.hysteresis.lastTier} (was about to move to ${tier})`)
    } else {
      reasons.push(`hysteresis: no signal delta → holding lastTier ${ctx.hysteresis.lastTier}`)
    }
    tier = ctx.hysteresis.lastTier
  }

  return { tier, venue, reasons }
}

/**
 * One node of a decomposed plan tree, prior to dispatch. `parentId` places it
 * in the goal → task → sub-item tracker hierarchy (§4.5); `dependsOn` lists
 * other nodes it needs completed first. `objective`/`outputShape`/
 * `successCriterion` are optional on the type so a partially-built plan can be
 * represented — `validatePlan` is what requires them filled in before spend.
 *
 * @sem domain=routing role=type
 */
export interface PlanNode {
  id: string
  parentId?: string
  dependsOn?: string[]
  objective?: string
  outputShape?: string
  successCriterion?: string
  estimateTokens?: number
}

/** Result of `validatePlan`: whether the plan passes the decomposition quality gate, and why not. */
export interface PlanValidation {
  ok: boolean
  violations: string[]
}

const MAX_INBOUND_DEPS = 3
const MAX_DEPTH = 3
const MAX_CHILDREN = 5
const BUDGET_FRACTION = 0.7

/**
 * The decomposition quality gate (§4.2): checked mechanically before any child
 * spawns. Verifies no dependency cycles (across both the parent hierarchy and
 * the `dependsOn` graph), ≤3 inbound dependencies per node, tree depth ≤3,
 * ≤5 children per node, every node carries an objective/output shape/success
 * criterion, and the summed token estimate leaves 30% of `budget` for
 * synthesis and correction. Pure: no I/O. In structural-only mode
 * (`opts.requireNodeFields=false`) the per-node objective/outputShape/
 * successCriterion check is skipped — a todo-derived plan carries none of
 * those, so the #53 resolution gate validates structure (cycles, depth,
 * branching, deps, budget) only.
 *
 * @sem domain=routing role=validator
 */
export function validatePlan(
  tree: PlanNode[],
  budget: number,
  opts: { requireNodeFields?: boolean } = {},
): PlanValidation {
  const violations: string[] = []
  const requireNodeFields = opts.requireNodeFields ?? true
  const byId = new Map(tree.map((node) => [node.id, node]))

  // --- Cycle detection over the combined parent-hierarchy + dependency graph.
  //     A cycle in either graph corrupts the "tree, executed as a star"
  //     assumption the rest of the checks (depth, in particular) rely on.
  const adjacency = new Map<string, string[]>()
  const addEdge = (from: string, to: string) => {
    const list = adjacency.get(from)
    if (list) list.push(to)
    else adjacency.set(from, [to])
  }
  for (const node of tree) {
    if (!adjacency.has(node.id)) adjacency.set(node.id, [])
    if (node.parentId !== undefined && byId.has(node.parentId)) addEdge(node.parentId, node.id)
    for (const dep of node.dependsOn ?? []) {
      if (byId.has(dep)) addEdge(dep, node.id)
    }
  }
  const UNVISITED = 0
  const VISITING = 1
  const DONE = 2
  const color = new Map<string, number>()
  let cycleFound = false
  const visit = (id: string): void => {
    if (cycleFound) return
    color.set(id, VISITING)
    for (const next of adjacency.get(id) ?? []) {
      const state = color.get(next) ?? UNVISITED
      if (state === VISITING) {
        cycleFound = true
        return
      }
      if (state === UNVISITED) visit(next)
      if (cycleFound) return
    }
    color.set(id, DONE)
  }
  for (const node of tree) {
    if ((color.get(node.id) ?? UNVISITED) === UNVISITED) visit(node.id)
    if (cycleFound) break
  }
  if (cycleFound) violations.push("dependency cycle detected in the plan graph")

  // --- Inbound dependencies per node.
  for (const node of tree) {
    const inbound = (node.dependsOn ?? []).length
    if (inbound > MAX_INBOUND_DEPS) {
      violations.push(`${node.id}: ${inbound} inbound dependencies exceeds the cap of ${MAX_INBOUND_DEPS}`)
    }
  }

  // --- Branching: children per parent.
  const childCounts = new Map<string, number>()
  for (const node of tree) {
    if (node.parentId === undefined) continue
    childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1)
  }
  for (const [parentId, count] of childCounts) {
    if (count > MAX_CHILDREN) {
      violations.push(`${parentId}: ${count} children exceeds the branching cap of ${MAX_CHILDREN}`)
    }
  }

  // --- Depth: goal → task → sub-item, ≤3. Skipped when a parent-chain cycle
  //     was already flagged above (walking it would never terminate).
  if (!cycleFound) {
    for (const node of tree) {
      let depth = 1
      let current = node
      const seen = new Set<string>([node.id])
      while (current.parentId !== undefined) {
        const parent = byId.get(current.parentId)
        if (parent === undefined || seen.has(parent.id)) break
        seen.add(parent.id)
        depth += 1
        current = parent
      }
      if (depth > MAX_DEPTH) {
        violations.push(`${node.id}: depth ${depth} exceeds the cap of ${MAX_DEPTH}`)
      }
    }
  }

  // --- Every node needs an objective, an output shape, and a success
  //     criterion. Skipped in structural-only mode (requireNodeFields=false):
  //     a todo-derived plan carries none of these, so the resolution gate
  //     checks cycles/depth/branching/deps/budget only.
  if (requireNodeFields) {
    for (const node of tree) {
      const missing: string[] = []
      if (!node.objective) missing.push("objective")
      if (!node.outputShape) missing.push("outputShape")
      if (!node.successCriterion) missing.push("successCriterion")
      if (missing.length > 0) {
        violations.push(`${node.id}: missing ${missing.join(", ")}`)
      }
    }
  }

  // --- Budget headroom: summed estimate ≤ 70% of the turn budget (30%
  //     reserved for synthesis and correction).
  const totalEstimate = tree.reduce((sum, node) => sum + (node.estimateTokens ?? 0), 0)
  const ceiling = BUDGET_FRACTION * budget
  if (totalEstimate > ceiling) {
    violations.push(`estimated tokens ${totalEstimate} exceeds ${BUDGET_FRACTION * 100}% of budget ${budget} (ceiling ${ceiling})`)
  }

  return { ok: violations.length === 0, violations }
}

/** Mid-flight re-decomposition triggers (§4.2), keyed by the signal that fires them. */
export type RedecompositionTrigger = "escalate-tier" | "replan-less-parallel" | "new-items" | "reorder"

/** Signals sampled during execution that `redecompositionCheck` evaluates against §4.2's thresholds. */
export interface RedecompositionSignals {
  /** Percent over budget a running child is tracking. >50 escalates that slice's tier. */
  budgetOverrunPct?: number
  /** A conflict between sibling slices detected at fold-back. Any true value re-plans with less parallelism. */
  siblingConflict?: boolean
  /** Count of coverage gaps found at synthesis. >0 becomes new tracked items — never silent scope loss. */
  coverageGaps?: number
  /** Wall-clock elapsed ÷ estimate. ≥2 suspects a hidden sequential dependency and re-orders. */
  wallClockRatio?: number
}

/**
 * The mid-flight re-decomposition triggers (§4.2): a running child over
 * budget escalates its own tier (never widens the fan-out); a sibling
 * conflict re-plans with less parallelism; coverage gaps become new tracked
 * items; a wall-clock blowout suspects a hidden sequential dependency and
 * re-orders. Multiple triggers can fire from the same signal set. Pure: no I/O.
 *
 * @sem domain=routing role=validator
 */
export function redecompositionCheck(signals: RedecompositionSignals): RedecompositionTrigger[] {
  const triggers: RedecompositionTrigger[] = []
  if (typeof signals.budgetOverrunPct === "number" && signals.budgetOverrunPct > 50) {
    triggers.push("escalate-tier")
  }
  if (signals.siblingConflict === true) {
    triggers.push("replan-less-parallel")
  }
  if (typeof signals.coverageGaps === "number" && signals.coverageGaps > 0) {
    triggers.push("new-items")
  }
  if (typeof signals.wallClockRatio === "number" && signals.wallClockRatio >= 2) {
    triggers.push("reorder")
  }
  return triggers
}
