/**
 * Unit tests for evaluator.ts — task U4a, ORCHESTRATION_MECHANISM.md §4.2:
 * evaluate() (tier + venue at dispatch), validatePlan() (the decomposition
 * quality gate), redecompositionCheck() (mid-flight re-decomposition
 * triggers). One describe block per rule in evaluate()'s priority order, then
 * validatePlan's checks, then redecompositionCheck's exact-boundary triggers.
 */

import { describe, it, expect } from "bun:test"
import {
  evaluate,
  validatePlan,
  redecompositionCheck,
  type EvalContext,
  type PlanNode,
} from "../src/evaluator.js"
import { allocateSlice, ALLOCATION_RISK_TIEBREAK, type SliceAllocationInput } from "../src/allocation.js"

// ---------------------------------------------------------------------------
// Fixture helper — every EvalContext field except `cache` is required by the
// spec; this gives each test a minimal, override-friendly baseline that
// otherwise never fires rules 2–6.
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    triage: {},
    history: { attempts: 0 },
    riskNotes: [],
    verifyStrength: { hasVerifyCommands: false },
    containmentAvailable: false,
    venue: { requestingTier: "executor", sameFilesInScope: false, readOnlyParallel: false },
    hysteresis: { signalDelta: true },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// (1) Base allocation — delegated to allocateSlice, never re-implemented
// ---------------------------------------------------------------------------

describe("evaluate — rule 1: base tier delegates to allocateSlice", () => {
  it("mirrors allocateSlice's tier and folds its reason in first", () => {
    const input = { coupling: "high" as const, testStrength: "untestable" as const }
    const base = allocateSlice(input)
    const v = evaluate(ctx(input))
    expect(v.tier).toBe(base.tier) // oracle — the residual cell
    expect(v.reasons[0]).toBe(`base: ${base.reason}`)
  })

  it("pins/ceilings (the need hint) still apply through evaluate", () => {
    const v = evaluate(ctx({ coupling: "low", testStrength: "untestable", need: "oracle" }))
    expect(v.tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// (2) Decision-shaped ambiguity — must never be undercut by the round-down
// ---------------------------------------------------------------------------

describe("evaluate — rule 2: decision-shaped ambiguity blocks the round-down", () => {
  const mechanicalUnbacked = { sliceType: "mechanical" as const, coupling: "low" as const, testStrength: "untestable" as const }
  const strongVerify = { hasVerifyCommands: true, testStrength: "testable" as const }

  it("triage.shape=diagnosis-vague blocks round-down despite strong verify + containment", () => {
    const base = allocateSlice(mechanicalUnbacked) // reasoner
    const v = evaluate(
      ctx({
        ...mechanicalUnbacked,
        triage: { shape: "diagnosis-vague" },
        verifyStrength: strongVerify,
        containmentAvailable: true,
      }),
    )
    expect(v.tier).toBe(base.tier)
    expect(v.reasons.some((r) => r.includes("decision-shaped ambiguity"))).toBe(true)
    expect(v.reasons.some((r) => r.startsWith("round-down:"))).toBe(false)
  })

  it("sliceType=design never enters the mechanical round-down branch", () => {
    const v = evaluate(
      ctx({ sliceType: "design", verifyStrength: strongVerify, containmentAvailable: true }),
    )
    expect(v.tier).toBe("reasoner")
    expect(v.reasons.some((r) => r.startsWith("round-down:"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (3) Mechanical round-down — the only de-escalation path (Q5)
// ---------------------------------------------------------------------------

describe("evaluate — rule 3: mechanical round-down (verify strong AND containment available)", () => {
  const mechanicalUnbacked = { sliceType: "mechanical" as const, coupling: "low" as const, testStrength: "untestable" as const }
  const strongVerify = { hasVerifyCommands: true, testStrength: "testable" as const }

  it("rounds down one tier (reasoner -> executor) when both conditions hold", () => {
    expect(allocateSlice(mechanicalUnbacked).tier).toBe("reasoner") // sanity-check the base cell
    const v = evaluate(ctx({ ...mechanicalUnbacked, verifyStrength: strongVerify, containmentAvailable: true }))
    expect(v.tier).toBe("executor")
    expect(v.reasons.some((r) => r.startsWith("round-down: mechanical + strong verify + containment available"))).toBe(true)
  })

  it("blocks the round-down when containmentAvailable is false", () => {
    const v = evaluate(ctx({ ...mechanicalUnbacked, verifyStrength: strongVerify, containmentAvailable: false }))
    expect(v.tier).toBe("reasoner")
    expect(v.reasons.some((r) => r.includes("containment unavailable"))).toBe(true)
  })

  it("blocks the round-down when verify commands don't exist", () => {
    const v = evaluate(
      ctx({ ...mechanicalUnbacked, verifyStrength: { hasVerifyCommands: false }, containmentAvailable: true }),
    )
    expect(v.tier).toBe("reasoner")
    expect(v.reasons.some((r) => r.includes("verify strength not strong enough"))).toBe(true)
  })

  it("blocks the round-down when the slice itself is untestable, even with commands present", () => {
    const v = evaluate(
      ctx({
        ...mechanicalUnbacked,
        verifyStrength: { hasVerifyCommands: true, testStrength: "untestable" },
        containmentAvailable: true,
      }),
    )
    expect(v.tier).toBe("reasoner")
  })

  it("never applies to a non-mechanical sliceType", () => {
    const v = evaluate(
      ctx({
        sliceType: "recon",
        coupling: "high",
        testStrength: "untestable",
        verifyStrength: strongVerify,
        containmentAvailable: true,
      }),
    )
    expect(v.tier).toBe("oracle") // base for high-coupling · untestable, untouched
  })
})

// ---------------------------------------------------------------------------
// (4) Venue — the affinity rule (Q9)
// ---------------------------------------------------------------------------

describe("evaluate — rule 4: venue affinity", () => {
  it("same tier + same files/entities in scope -> inline", () => {
    const v = evaluate(
      ctx({
        coupling: "low",
        testStrength: "testable", // base -> executor
        venue: { requestingTier: "executor", sameFilesInScope: true, readOnlyParallel: false },
      }),
    )
    expect(v.venue).toBe("inline")
    expect(v.reasons.some((r) => r.includes("same files/entities in scope"))).toBe(true)
  })

  it("read-only parallel work -> child, even at the same tier", () => {
    const v = evaluate(
      ctx({
        coupling: "low",
        testStrength: "testable",
        venue: { requestingTier: "executor", sameFilesInScope: false, readOnlyParallel: true },
      }),
    )
    expect(v.venue).toBe("child")
    expect(v.reasons.some((r) => r.includes("read-only parallel"))).toBe(true)
  })

  it("tier differs from the requesting thread -> child", () => {
    const v = evaluate(
      ctx({
        coupling: "high",
        testStrength: "untestable", // base -> oracle
        venue: { requestingTier: "executor", sameFilesInScope: true, readOnlyParallel: false },
      }),
    )
    expect(v.venue).toBe("child")
    expect(v.reasons.some((r) => r.includes("tier differs"))).toBe(true)
  })

  it("1-2 small same-tier items -> inline even without file overlap", () => {
    const v = evaluate(
      ctx({
        coupling: "low",
        testStrength: "testable",
        venue: { requestingTier: "executor", sameFilesInScope: false, readOnlyParallel: false, smallItemCount: 2 },
      }),
    )
    expect(v.venue).toBe("inline")
    expect(v.reasons.some((r) => r.includes("small same-tier item"))).toBe(true)
  })

  it("a larger same-tier batch with no file overlap defaults to child", () => {
    const v = evaluate(
      ctx({
        coupling: "low",
        testStrength: "testable",
        venue: { requestingTier: "executor", sameFilesInScope: false, readOnlyParallel: false, smallItemCount: 3 },
      }),
    )
    expect(v.venue).toBe("child")
    expect(v.reasons.some((r) => r.includes("context diverges"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (5) Cache — moving tiers costs more; keep the prior (capable) tier
// ---------------------------------------------------------------------------

describe("evaluate — rule 5: cache-switch guard", () => {
  it("keeps the prior tier when switchDelta > 0 and the prior tier is capable", () => {
    const v = evaluate(
      ctx({
        coupling: "low",
        testStrength: "untestable", // base -> executor + qe
        cache: { switchDelta: 5 },
        hysteresis: { lastTier: "reasoner", signalDelta: true },
      }),
    )
    expect(v.tier).toBe("reasoner")
    expect(v.reasons.some((r) => r.startsWith("cache: switchDelta=5"))).toBe(true)
  })

  it("never lowers below the pins/ceilings/round-up floor even when switchDelta > 0", () => {
    // design floor forces oracle; the prior tier (executor) is not capable of it.
    const v = evaluate(
      ctx({
        sliceType: "design",
        cache: { switchDelta: 5 },
        hysteresis: { lastTier: "executor", signalDelta: true },
      }),
    )
    expect(v.tier).toBe("reasoner")
    expect(v.reasons.some((r) => r.startsWith("cache:"))).toBe(false)
  })

  it("does nothing when switchDelta is not positive", () => {
    const v = evaluate(
      ctx({
        coupling: "low",
        testStrength: "untestable",
        cache: { switchDelta: 0 },
        hysteresis: { lastTier: "reasoner", signalDelta: true },
      }),
    )
    expect(v.tier).toBe("executor")
    expect(v.reasons.some((r) => r.startsWith("cache:"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (6) Hysteresis — holds without a signal delta, releases with one (Q6)
// ---------------------------------------------------------------------------

describe("evaluate — rule 6: per-turn hysteresis", () => {
  it("holds the last-dispatched tier when there is no signal delta", () => {
    const v = evaluate(
      ctx({
        coupling: "high",
        testStrength: "untestable", // base -> oracle
        hysteresis: { lastTier: "executor", signalDelta: false },
      }),
    )
    expect(v.tier).toBe("executor")
    expect(v.reasons.some((r) => r.includes("hysteresis: no signal delta"))).toBe(true)
  })

  it("releases and lets the base tier stand when a signal delta arrives", () => {
    const v = evaluate(
      ctx({
        coupling: "high",
        testStrength: "untestable", // base -> oracle
        hysteresis: { lastTier: "executor", signalDelta: true },
      }),
    )
    expect(v.tier).toBe("oracle")
  })

  it("is a no-op when there's no lastTier to hold", () => {
    const v = evaluate(
      ctx({
        coupling: "high",
        testStrength: "untestable",
        hysteresis: { signalDelta: false },
      }),
    )
    expect(v.tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// Regression: evaluate() is a strict superset of allocateSlice — with no
// triage ctx, containmentAvailable=false, and no hysteresis, every fixture
// from allocation.test.ts's matrix must land on the identical tier (W2a).
// ---------------------------------------------------------------------------

describe("evaluate — regression: matches allocateSlice on neutral inputs (superset)", () => {
  const fixtures: SliceAllocationInput[] = [
    { coupling: "low", testStrength: "testable" },
    { coupling: "high", testStrength: "testable" },
    { coupling: "low", testStrength: "untestable" },
    { coupling: "high", testStrength: "untestable" },
    { coupling: "high", testStrength: "testable", risk: 100 },
    { coupling: "high", testStrength: "testable", need: "oracle" },
    { coupling: "high", testStrength: "testable", need: "reasoner", risk: 99 },
    { coupling: "low", testStrength: "testable", need: "oracle", risk: 95 },
    { coupling: "high", testStrength: "testable", sliceType: "mechanical", need: "oracle", risk: 100 },
    { coupling: "high", testStrength: "testable", risk: ALLOCATION_RISK_TIEBREAK + 30 },
    { sliceType: "design", coupling: "low", testStrength: "testable" },
    { sliceType: "design", testStrength: "testable" },
    { sliceType: "design", coupling: "high", testStrength: "untestable" },
    { sliceType: "mechanical", coupling: "high", testStrength: "testable" },
    { sliceType: "recon", coupling: "high", testStrength: "testable" },
    { sliceType: "verify", coupling: "high", testStrength: "testable" },
    { coupling: "low", testStrength: "untestable", risk: 90 },
    { coupling: "low", testStrength: "untestable", risk: ALLOCATION_RISK_TIEBREAK },
    { coupling: "low", testStrength: "untestable", risk: 10 },
    { coupling: "low", testStrength: "untestable", need: "oracle" },
    { sliceType: "design", need: "executor" },
    { coupling: "high", testStrength: "untestable", need: "conductor" },
    { coupling: "low", testStrength: "untestable", need: "supercomputer" },
    { coupling: "low", testStrength: "untestable", need: "reasoner" },
    { sliceType: "mechanical", coupling: "low", testStrength: "untestable" },
    { sliceType: "mechanical", coupling: "low", testStrength: "untestable", specBacked: true },
    { sliceType: "mechanical", coupling: "low", testStrength: "testable" },
    { sliceType: "recon", coupling: "low", testStrength: "untestable" },
    {},
    { testStrength: "testable" },
    { coupling: "high" },
  ]

  for (const input of fixtures) {
    it(`tier(${JSON.stringify(input)}) matches allocateSlice`, () => {
      const base = allocateSlice(input)
      const v = evaluate(ctx(input))
      expect(v.tier).toBe(base.tier)
    })
  }
})

// ---------------------------------------------------------------------------
// validatePlan — the decomposition quality gate
// ---------------------------------------------------------------------------

function planNode(overrides: Partial<PlanNode> & { id: string }): PlanNode {
  return {
    objective: "do the thing",
    outputShape: "a diff",
    successCriterion: "typecheck + targeted test pass",
    estimateTokens: 100,
    ...overrides,
  }
}

describe("validatePlan", () => {
  it("passes a clean, well-formed plan", () => {
    const tree: PlanNode[] = [
      planNode({ id: "goal-1" }),
      planNode({ id: "task-1", parentId: "goal-1" }),
      planNode({ id: "task-2", parentId: "goal-1", dependsOn: ["task-1"] }),
    ]
    const result = validatePlan(tree, 10_000)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it("detects a dependency cycle", () => {
    const tree: PlanNode[] = [
      planNode({ id: "a", dependsOn: ["b"] }),
      planNode({ id: "b", dependsOn: ["a"] }),
    ]
    const result = validatePlan(tree, 10_000)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("cycle"))).toBe(true)
  })

  it("flags more than 3 inbound dependencies on one node", () => {
    const tree: PlanNode[] = [
      planNode({ id: "d1" }),
      planNode({ id: "d2" }),
      planNode({ id: "d3" }),
      planNode({ id: "d4" }),
      planNode({ id: "n", dependsOn: ["d1", "d2", "d3", "d4"] }),
    ]
    const result = validatePlan(tree, 10_000)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("n: 4 inbound dependencies"))).toBe(true)
  })

  it("flags depth > 3 (goal -> task -> sub-item -> too-deep)", () => {
    const tree: PlanNode[] = [
      planNode({ id: "goal" }),
      planNode({ id: "task", parentId: "goal" }),
      planNode({ id: "sub", parentId: "task" }),
      planNode({ id: "too-deep", parentId: "sub" }),
    ]
    const result = validatePlan(tree, 10_000)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("too-deep: depth 4"))).toBe(true)
  })

  it("flags branching > 5 children under one parent", () => {
    const children = Array.from({ length: 6 }, (_, i) => planNode({ id: `child-${i}`, parentId: "goal" }))
    const tree: PlanNode[] = [planNode({ id: "goal" }), ...children]
    const result = validatePlan(tree, 10_000)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("goal: 6 children"))).toBe(true)
  })

  it("flags a node missing objective/outputShape/successCriterion", () => {
    const tree: PlanNode[] = [{ id: "bare" }]
    const result = validatePlan(tree, 10_000)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("bare: missing objective, outputShape, successCriterion"))).toBe(true)
  })

  it("flags summed estimateTokens over 70% of budget", () => {
    const tree: PlanNode[] = [planNode({ id: "a", estimateTokens: 8_000 })]
    const result = validatePlan(tree, 10_000) // ceiling is 7,000
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("estimated tokens 8000 exceeds"))).toBe(true)
  })

  it("stays within the 70% budget ceiling exactly at the boundary", () => {
    const tree: PlanNode[] = [planNode({ id: "a", estimateTokens: 7_000 })]
    const result = validatePlan(tree, 10_000) // ceiling is exactly 7,000
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// redecompositionCheck — mid-flight re-decomposition triggers, exact boundaries
// ---------------------------------------------------------------------------

describe("redecompositionCheck", () => {
  it("returns no triggers when nothing crosses a threshold", () => {
    expect(redecompositionCheck({})).toEqual([])
  })

  it("budgetOverrunPct: 50 does not fire, 51 fires escalate-tier", () => {
    expect(redecompositionCheck({ budgetOverrunPct: 50 })).toEqual([])
    expect(redecompositionCheck({ budgetOverrunPct: 51 })).toEqual(["escalate-tier"])
  })

  it("siblingConflict: true fires replan-less-parallel, false does not", () => {
    expect(redecompositionCheck({ siblingConflict: false })).toEqual([])
    expect(redecompositionCheck({ siblingConflict: true })).toEqual(["replan-less-parallel"])
  })

  it("coverageGaps: 0 does not fire, 1 fires new-items", () => {
    expect(redecompositionCheck({ coverageGaps: 0 })).toEqual([])
    expect(redecompositionCheck({ coverageGaps: 1 })).toEqual(["new-items"])
  })

  it("wallClockRatio: 1.99 does not fire, 2 fires reorder (inclusive boundary)", () => {
    expect(redecompositionCheck({ wallClockRatio: 1.99 })).toEqual([])
    expect(redecompositionCheck({ wallClockRatio: 2 })).toEqual(["reorder"])
  })

  it("fires multiple triggers, in signal order, when several thresholds cross at once", () => {
    const triggers = redecompositionCheck({
      budgetOverrunPct: 60,
      siblingConflict: true,
      coverageGaps: 2,
      wallClockRatio: 2.5,
    })
    expect(triggers).toEqual(["escalate-tier", "replan-less-parallel", "new-items", "reorder"])
  })
})
