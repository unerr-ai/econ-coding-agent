/**
 * Tests for the turn-triage extraction module (U1a) — the pure
 * parse/validate pipeline (`parseTriageResponse`) and its blocking,
 * conductor-tier call wrapper (`runTurnTriage`), per
 * docs/architecture/ORCHESTRATION_MECHANISM.md §1.1/§4.1. No wiring here —
 * `complete` is a plain mocked callback, never a real provider.
 */

import { describe, test, expect } from "bun:test"
import {
  parseTriageResponse,
  runTurnTriage,
  triageTelemetry,
  TRIAGE_MAX_GOALS,
  type TriageComplete,
} from "../../src/session/turn-triage"

describe("parseTriageResponse", () => {
  test("a single goal parses with its shape and deliverable intact", () => {
    const userPrompt = "Fix the login bug where users can't reset their password."
    const raw = JSON.stringify({
      goals: [
        {
          quote: "Fix the login bug where users can't reset their password.",
          shape: "diagnosis-grounded",
          deliverable: "password reset works again",
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTriageResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
    expect(verdict!.goals[0].quote).toBe("Fix the login bug where users can't reset their password.")
    expect(verdict!.goals[0].shape).toBe("diagnosis-grounded")
    expect(verdict!.goals[0].deliverable).toBe("password reset works again")
    expect(verdict!.constraints).toHaveLength(0)
    expect(verdict!.confidence).toBe("high")
  })

  test("a compound three-goal prompt carries dependsOn through", () => {
    const userPrompt = "Audit the five fixes, apply whichever fixes the audit approves, and write a changelog entry."
    const raw = JSON.stringify({
      goals: [
        { quote: "Audit the five fixes", shape: "audit", deliverable: "a pass/fail verdict per fix" },
        {
          quote: "apply whichever fixes the audit approves",
          shape: "build",
          deliverable: "approved fixes applied",
          dependsOn: [0],
        },
        {
          quote: "write a changelog entry",
          shape: "build",
          deliverable: "a changelog entry describing the applied fixes",
          dependsOn: [1],
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTriageResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(3)
    expect(verdict!.goals[1].dependsOn).toEqual([0])
    expect(verdict!.goals[2].dependsOn).toEqual([1])
    expect(verdict!.goals[0].dependsOn).toBeUndefined()
  })

  test("\"don't touch any tests\" extracts a no-test-edit constraint", () => {
    const userPrompt = "Audit the five fixes and don't touch any tests."
    const raw = JSON.stringify({
      goals: [{ quote: "Audit the five fixes", shape: "audit", deliverable: "a pass/fail verdict per fix" }],
      constraints: [{ quote: "don't touch any tests", kind: "no-test-edit" }],
      confidence: "high",
    })

    const verdict = parseTriageResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.constraints).toHaveLength(1)
    expect(verdict!.constraints[0].kind).toBe("no-test-edit")
    expect(verdict!.constraints[0].quote).toBe("don't touch any tests")
  })

  test('"Do not modify any test files" also extracts a no-test-edit constraint', () => {
    const userPrompt = "Fix the profile-name bug. Do not modify any test files."
    const raw = JSON.stringify({
      goals: [
        {
          quote: "Fix the profile-name bug.",
          shape: "diagnosis-grounded",
          deliverable: "profile name displays correctly",
        },
      ],
      constraints: [{ quote: "Do not modify any test files.", kind: "no-test-edit" }],
      confidence: "high",
    })

    const verdict = parseTriageResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.constraints).toHaveLength(1)
    expect(verdict!.constraints[0].kind).toBe("no-test-edit")
    expect(verdict!.constraints[0].quote).toBe("Do not modify any test files.")
  })

  test("a hallucinated goal quote is dropped, a valid sibling goal survives", () => {
    const userPrompt = "Fix the profile-name bug."
    const raw = JSON.stringify({
      goals: [
        {
          quote: "Fix the profile-name bug.",
          shape: "diagnosis-grounded",
          deliverable: "profile name displays correctly",
        },
        { quote: "also refactor the entire auth module", shape: "build", deliverable: "a cleaner auth module" },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTriageResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
    expect(verdict!.goals[0].quote).toBe("Fix the profile-name bug.")
  })

  test("a verdict where every goal quote is invalid returns null", () => {
    const userPrompt = "Fix the profile-name bug."
    const raw = JSON.stringify({
      goals: [{ quote: "this text is not in the prompt at all", shape: "build", deliverable: "n/a" }],
      constraints: [],
      confidence: "high",
    })

    expect(parseTriageResponse(raw, userPrompt)).toBeNull()
  })

  test("malformed JSON returns null", () => {
    const userPrompt = "Fix the profile-name bug."
    expect(parseTriageResponse("{not valid json", userPrompt)).toBeNull()
  })

  test("more than TRIAGE_MAX_GOALS goals returns null", () => {
    const userPrompt = Array.from({ length: 8 }, (_, i) => `do task ${i}`).join(". ") + "."
    const goals = Array.from({ length: 8 }, (_, i) => ({
      quote: `do task ${i}`,
      shape: "build" as const,
      deliverable: `task ${i} done`,
    }))
    expect(goals.length).toBeGreaterThan(TRIAGE_MAX_GOALS)
    const raw = JSON.stringify({ goals, constraints: [], confidence: "high" })

    expect(parseTriageResponse(raw, userPrompt)).toBeNull()
  })

  test("the verbatim-substring check is case-sensitive", () => {
    const userPrompt = "Fix the Login bug."
    const wrongCase = JSON.stringify({
      goals: [{ quote: "fix the login bug", shape: "diagnosis-grounded", deliverable: "n/a" }],
      constraints: [],
      confidence: "high",
    })
    expect(parseTriageResponse(wrongCase, userPrompt)).toBeNull()

    const exactCase = JSON.stringify({
      goals: [{ quote: "Fix the Login bug", shape: "diagnosis-grounded", deliverable: "login works again" }],
      constraints: [],
      confidence: "high",
    })
    const verdict = parseTriageResponse(exactCase, userPrompt)
    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].quote).toBe("Fix the Login bug")
  })
})

describe("runTurnTriage", () => {
  test("resolves the verdict the injected complete callback returns", async () => {
    const userPrompt = "Fix the profile-name bug."
    const complete: TriageComplete = async () =>
      JSON.stringify({
        goals: [
          {
            quote: "Fix the profile-name bug.",
            shape: "diagnosis-grounded",
            deliverable: "profile name displays correctly",
          },
        ],
        constraints: [],
        confidence: "high",
      })

    const verdict = await runTurnTriage({ userPrompt, complete })

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
  })

  test(
    "a complete callback slower than TRIAGE_TIMEOUT_MS resolves to null",
    async () => {
      const complete: TriageComplete = () => new Promise(() => {}) // never resolves
      const verdict = await runTurnTriage({ userPrompt: "Fix the profile-name bug.", complete })
      expect(verdict).toBeNull()
    },
    // waits out the full TRIAGE_TIMEOUT_MS (8s) race — needs more than bun's 5s default
    12_000,
  )

  test("a rejected complete callback resolves to null", async () => {
    const complete: TriageComplete = async () => {
      throw new Error("provider unavailable")
    }
    const verdict = await runTurnTriage({ userPrompt: "Fix the profile-name bug.", complete })
    expect(verdict).toBeNull()
  })

  test("malformed JSON from complete resolves to null", async () => {
    const complete: TriageComplete = async () => "{not valid json"
    const verdict = await runTurnTriage({ userPrompt: "Fix the profile-name bug.", complete })
    expect(verdict).toBeNull()
  })
})

describe("triageTelemetry", () => {
  test("summarizes goal count, shapes, constraint kinds, and confidence", () => {
    const verdict = parseTriageResponse(
      JSON.stringify({
        goals: [
          { quote: "Audit the five fixes", shape: "audit", deliverable: "a pass/fail verdict per fix" },
          {
            quote: "fix the profile-name bug",
            shape: "diagnosis-grounded",
            deliverable: "profile name displays correctly",
          },
        ],
        constraints: [{ quote: "don't touch any tests", kind: "no-test-edit" }],
        confidence: "low",
      }),
      "Audit the five fixes, fix the profile-name bug, and don't touch any tests.",
    )!

    const summary = triageTelemetry(verdict)

    expect(summary).toEqual({
      goalCount: 2,
      shapes: ["audit", "diagnosis-grounded"],
      constraintKinds: ["no-test-edit"],
      confidence: "low",
    })
  })
})
