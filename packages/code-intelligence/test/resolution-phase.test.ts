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
// Branch 1b — armed vague diagnosis: NEVER decompose. First pass localizes
// (resolve-first); after localization the conductor continues inline
// (continue-inline), with the grind valve as the only escalation.
// ---------------------------------------------------------------------------

describe("resolutionDecision — branch 1b: armed turn never decomposes", () => {
  it("resolves first on the first pass even when candidatePlan validates (the 11885 case)", () => {
    const result = resolutionDecision(
      baseInput({ ambiguity: "ambiguous", armLocalization: true, candidatePlan: VALID_PLAN }),
    )
    expect(result.mode).toBe("resolve-first")
    expect(result.reason).toBe("armed vague diagnosis — localize before slicing")
  })

  it("continues inline (NOT decompose-now) after one localization pass, even when candidatePlan validates — tonight's 0/4-vs-3/3 failure pinned", () => {
    const result = resolutionDecision(
      baseInput({
        ambiguity: "ambiguous",
        armLocalization: true,
        resolveAttempts: 1,
        candidatePlan: VALID_PLAN,
      }),
    )
    expect(result.mode).toBe("continue-inline")
    expect(result.mode).not.toBe("decompose-now")
    expect(result.reason).toBe("armed turn localized — continue inline, grind valve is the only escalation")
  })

  it("still continues inline at resolveAttempts=MAX — the armed branch precedes the termination branch", () => {
    const result = resolutionDecision(
      baseInput({
        hardness: "hard",
        armLocalization: true,
        resolveAttempts: MAX_RESOLVE_ATTEMPTS,
        candidatePlan: VALID_PLAN,
      }),
    )
    expect(result.mode).toBe("continue-inline")
    expect(result.mode).not.toBe("decompose-now")
  })

  it("continues inline regardless of needsUserInput — the grind valve is the only escalation for an armed turn (no ask-user)", () => {
    const result = resolutionDecision(
      baseInput({
        ambiguity: "ambiguous",
        armLocalization: true,
        resolveAttempts: 1,
        needsUserInput: true,
        interactive: true,
      }),
    )
    expect(result.mode).toBe("continue-inline")
    expect(result.mode).not.toBe("ask-user")
  })

  it("does not bypass the short-circuit when armLocalization is false", () => {
    const result = resolutionDecision(
      baseInput({ ambiguity: "ambiguous", armLocalization: false, candidatePlan: VALID_PLAN }),
    )
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("approach fixed, plan valid")
  })

  it("never fires on an unflagged task — branch 1 takes precedence", () => {
    const result = resolutionDecision(baseInput({ armLocalization: true }))
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("approach not uncertain")
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
// Branch 2b — direct-first valve (item 4 / mini10-11999 forensics): a narrow
// conjunction inside the valid-plan short-circuit that trades decompose-now
// for one cheap continue-inline swing. Every disqualifier is tested alone so
// the valve's signature stays exact — any one of them must fall back to the
// byte-identical decompose-now (or resolve-first/continue-inline via an
// earlier branch) the pre-valve code always returned.
// ---------------------------------------------------------------------------

describe("resolutionDecision — direct-first valve (narrow: fires only on its exact signature)", () => {
  const valveInput = (overrides: Partial<ResolutionInput> = {}): ResolutionInput =>
    baseInput({
      ambiguity: "ambiguous",
      candidatePlan: VALID_PLAN,
      diagnosisLocationOrFixKnown: true,
      writerSliceCount: 2,
      ...overrides,
    })

  it("fires on the exact narrow signature: continue-inline, direct_first_inline signal", () => {
    const result = resolutionDecision(valveInput())
    expect(result.mode).toBe("continue-inline")
    expect(result.reason).toContain("direct_first_inline")
  })

  it("fires at the writerSliceCount boundary (<=2, tested at exactly 1)", () => {
    const result = resolutionDecision(valveInput({ writerSliceCount: 1 }))
    expect(result.mode).toBe("continue-inline")
  })

  it("disqualifier: resolveAttempts !== 0 falls back to decompose-now", () => {
    const result = resolutionDecision(valveInput({ resolveAttempts: 1 }))
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("approach fixed, plan valid")
  })

  it("disqualifier: diagnosisLocationOrFixKnown absent falls back to decompose-now", () => {
    const result = resolutionDecision(valveInput({ diagnosisLocationOrFixKnown: undefined }))
    expect(result.mode).toBe("decompose-now")
  })

  it("disqualifier: diagnosisLocationOrFixKnown false falls back to decompose-now", () => {
    const result = resolutionDecision(valveInput({ diagnosisLocationOrFixKnown: false }))
    expect(result.mode).toBe("decompose-now")
  })

  it("disqualifier: aggregate hardness \"hard\" falls back to decompose-now", () => {
    const result = resolutionDecision(valveInput({ hardness: "hard" }))
    expect(result.mode).toBe("decompose-now")
  })

  it("disqualifier: writerSliceCount above the cap (3) falls back to decompose-now", () => {
    const result = resolutionDecision(valveInput({ writerSliceCount: 3 }))
    expect(result.mode).toBe("decompose-now")
  })

  it("disqualifier: writerSliceCount absent falls back to decompose-now", () => {
    const result = resolutionDecision(valveInput({ writerSliceCount: undefined }))
    expect(result.mode).toBe("decompose-now")
  })

  it("disqualifier: an armed turn takes branch 1b instead — continue-inline for the armed reason, never direct_first_inline", () => {
    const result = resolutionDecision(
      valveInput({ armLocalization: true, resolveAttempts: 1 }),
    )
    expect(result.mode).toBe("continue-inline")
    expect(result.reason).not.toContain("direct_first_inline")
    expect(result.reason).toBe("armed turn localized — continue inline, grind valve is the only escalation")
  })

  it("existing branch-2 behavior is byte-identical when the valve's new fields are simply absent (no diagnosisLocationOrFixKnown/writerSliceCount)", () => {
    const result = resolutionDecision(baseInput({ ambiguity: "ambiguous", candidatePlan: VALID_PLAN }))
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("approach fixed, plan valid")
  })
})

// ---------------------------------------------------------------------------
// Branch 2b — structural-only short-circuit (requireNodeFields: false)
// ---------------------------------------------------------------------------

describe("resolutionDecision — branch 2: structural-only short-circuit (requireNodeFields:false)", () => {
  it("decomposes now on a flagged task when candidatePlan passes structural-only validation (requireNodeFields:false)", () => {
    const result = resolutionDecision(
      baseInput({
        ambiguity: "ambiguous",
        candidatePlan: [{ id: "0" }, { id: "1", dependsOn: ["0"] }] as PlanNode[],
        requireNodeFields: false,
      }),
    )
    expect(result.mode).toBe("decompose-now")
    expect(result.reason).toBe("approach fixed, plan valid")
  })

  it("does not short-circuit when requireNodeFields defaults to true (full validation), rejecting fields-less plan", () => {
    const result = resolutionDecision(
      baseInput({
        ambiguity: "ambiguous",
        candidatePlan: [{ id: "0" }, { id: "1", dependsOn: ["0"] }] as PlanNode[],
      }),
    )
    expect(result.mode).not.toBe("decompose-now")
  })

  it("still rejects plans that violate structural constraints even in structural-only mode (e.g., 6 children under one parent)", () => {
    const result = resolutionDecision(
      baseInput({
        ambiguity: "ambiguous",
        candidatePlan: [
          { id: "p" },
          ...Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, parentId: "p" })),
        ] as PlanNode[],
        requireNodeFields: false,
      }),
    )
    expect(result.mode).not.toBe("decompose-now")
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
