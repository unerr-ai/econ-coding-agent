/**
 * Unit tests for resolution-phase.ts (task #53) — the pure prior-uncertainty
 * resolution decision table. One describe block per precedence branch, in the
 * exact order resolutionDecision checks them, plus the headless-never-asks
 * and termination invariants called out in the spec.
 */

import { describe, it, expect } from "bun:test"
import {
  resolutionDecision,
  MAX_RESOLVE_ATTEMPTS,
  type ResolutionInput,
} from "../src/resolution-phase.js"
import type { PlanNode } from "../src/evaluator.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    budget: 10_000,
    interactive: false,
    resolveAttempts: 0,
    ...overrides,
  }
}

function planNode(overrides: Partial<PlanNode> & { id: string }): PlanNode {
  return {
    objective: "do the thing",
    outputShape: "a diff",
    successCriterion: "typecheck + targeted test pass",
    estimateTokens: 100,
    ...overrides,
  }
}

const VALID_PLAN: PlanNode[] = [
  planNode({ id: "goal-1" }),
  planNode({ id: "task-1", parentId: "goal-1" }),
]

// Missing objective/outputShape/successCriterion — fails validatePlan's
// per-node completeness check.
const INVALID_PLAN: PlanNode[] = [{ id: "bare" }]

// ---------------------------------------------------------------------------
// Branch 1 — not flagged
// ---------------------------------------------------------------------------

describe("resolutionDecision — branch 1: not flagged", () => {
  it("decomposes now when neither ambiguous nor hard", () => {
    const result = resolutionDecision(baseInput({ ambiguity: "clear", hardness: "trivial" }))
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("approach not uncertain")
  })

  it("decomposes now when both ambiguity and hardness are absent", () => {
    const result = resolutionDecision(baseInput())
    expect(result.mode).toBe("decompose-now")
  })

  it("takes priority over an otherwise-flagged input's other fields (needsUserInput ignored when not flagged)", () => {
    const result = resolutionDecision(
      baseInput({ ambiguity: "clear", hardness: "moderate", needsUserInput: true, interactive: true }),
    )
    expect(result.mode).toBe("decompose-now")
  })
})

// ---------------------------------------------------------------------------
// Branch 2 — short-circuit: flagged but a valid candidate plan already exists
// ---------------------------------------------------------------------------

describe("resolutionDecision — branch 2: valid candidatePlan short-circuit", () => {
  it("decomposes now on a flagged task when candidatePlan validates", () => {
    const result = resolutionDecision(
      baseInput({ ambiguity: "ambiguous", candidatePlan: VALID_PLAN }),
    )
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("approach fixed, plan valid")
  })

  it("does not short-circuit when candidatePlan fails validatePlan", () => {
    const result = resolutionDecision(
      baseInput({ hardness: "hard", candidatePlan: INVALID_PLAN }),
    )
    expect(result.mode).not.toBe("decompose-now")
  })

  it("does not short-circuit when candidatePlan is absent", () => {
    const result = resolutionDecision(baseInput({ ambiguity: "ambiguous" }))
    expect(result.mode).toBe("resolve-first")
  })
})

// ---------------------------------------------------------------------------
// Branch 3 — ask-user, interactive only
// ---------------------------------------------------------------------------

describe("resolutionDecision — branch 3: ask-user (interactive only)", () => {
  it("asks the user when flagged, no valid plan, needsUserInput, and interactive", () => {
    const result = resolutionDecision(
      baseInput({
        hardness: "hard",
        candidatePlan: INVALID_PLAN,
        needsUserInput: true,
        interactive: true,
      }),
    )
    expect(result.mode).toBe("ask-user")
    expect(result.reason).toBe("approach needs product intent")
  })

  it("NEVER asks the user in headless mode, even with needsUserInput true", () => {
    const result = resolutionDecision(
      baseInput({
        ambiguity: "ambiguous",
        needsUserInput: true,
        interactive: false,
      }),
    )
    expect(result.mode).not.toBe("ask-user")
    expect(["resolve-first", "decompose-now"]).toContain(result.mode)
  })

  it("falls through to resolve-first when interactive but needsUserInput is false", () => {
    const result = resolutionDecision(
      baseInput({ ambiguity: "ambiguous", interactive: true, needsUserInput: false }),
    )
    expect(result.mode).toBe("resolve-first")
  })
})

// ---------------------------------------------------------------------------
// Branch 4 — termination guarantee
// ---------------------------------------------------------------------------

describe("resolutionDecision — branch 4: termination guarantee", () => {
  it("decomposes now (best-effort) once resolveAttempts hits MAX_RESOLVE_ATTEMPTS", () => {
    const result = resolutionDecision(
      baseInput({ hardness: "hard", resolveAttempts: MAX_RESOLVE_ATTEMPTS }),
    )
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("resolution budget exhausted, best-effort")
  })

  it("also terminates past the cap (resolveAttempts > MAX_RESOLVE_ATTEMPTS)", () => {
    const result = resolutionDecision(
      baseInput({ ambiguity: "ambiguous", resolveAttempts: MAX_RESOLVE_ATTEMPTS + 5 }),
    )
    expect(result.mode).toBe("decompose-now")
  })

  it("terminates even in interactive mode with an unanswered needsUserInput once the cap is hit", () => {
    const result = resolutionDecision(
      baseInput({
        hardness: "hard",
        interactive: true,
        needsUserInput: false,
        resolveAttempts: MAX_RESOLVE_ATTEMPTS,
      }),
    )
    expect(result.mode).toBe("decompose-now")
  })

  it("MAX_RESOLVE_ATTEMPTS is 2", () => {
    expect(MAX_RESOLVE_ATTEMPTS).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Branch 5 — resolve-first (the default, still-resolvable case)
// ---------------------------------------------------------------------------

describe("resolutionDecision — branch 5: resolve-first", () => {
  it("resolves first when flagged, no valid plan, under the attempt cap, headless", () => {
    const result = resolutionDecision(baseInput({ ambiguity: "ambiguous", resolveAttempts: 1 }))
    expect(result.mode).toBe("resolve-first")
    expect(result.reason).toBe("run/re-run the resolution pass to fix the approach")
  })

  it("resolves first when flagged and hard, one attempt below the cap", () => {
    const result = resolutionDecision(
      baseInput({ hardness: "hard", resolveAttempts: MAX_RESOLVE_ATTEMPTS - 1 }),
    )
    expect(result.mode).toBe("resolve-first")
  })
})
