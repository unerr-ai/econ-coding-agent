/**
 * Tests for the arming-judge module (§1.1b) — the one cheap, evidence-grounded
 * LLM call that decides whether a turn needs a localization pre-pass, replacing
 * the brittle regex doors (`roundUpTriageShapes`, `isHardDiagnosisPrompt`).
 * Covers the pure parse/validate pipeline (`parseArmingResponse`), its
 * blocking judge wrapper (`judgeArming`), the heuristic degrade path
 * (`heuristicArming`), and the user-message builder (`buildArmingUser`). No
 * wiring here — `complete` is a plain mocked callback, never a real provider,
 * mirroring test/session/turn-triage.test.ts.
 */

import { describe, test, expect } from "bun:test"
import {
  parseArmingResponse,
  judgeArming,
  heuristicArming,
  buildArmingUser,
} from "../../src/session/arming-judge"
import type { TriageComplete, TriageVerdict } from "../../src/session/turn-triage"

describe("parseArmingResponse", () => {
  test("valid JSON parses into an ArmingVerdict", () => {
    const raw = JSON.stringify({
      armLocalization: true,
      localized: false,
      hardness: "moderate",
      ambiguity: "clear",
      evidence: "only a symptom is described",
    })

    const verdict = parseArmingResponse(raw)

    expect(verdict).not.toBeNull()
    expect(verdict!.armLocalization).toBe(true)
    expect(verdict!.localized).toBe(false)
    expect(verdict!.hardness).toBe("moderate")
    expect(verdict!.ambiguity).toBe("clear")
    expect(verdict!.evidence).toBe("only a symptom is described")
  })

  test("a ```json-fenced body still parses", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        armLocalization: false,
        localized: true,
        hardness: "trivial",
        ambiguity: "clear",
        evidence: "the getter in enums.py",
      }) +
      "\n```"

    const verdict = parseArmingResponse(raw)

    expect(verdict).not.toBeNull()
    expect(verdict!.armLocalization).toBe(false)
    expect(verdict!.hardness).toBe("trivial")
  })

  test("an invalid hardness returns null", () => {
    const raw = JSON.stringify({
      armLocalization: true,
      localized: false,
      hardness: "extreme",
      ambiguity: "clear",
      evidence: "n/a",
    })
    expect(parseArmingResponse(raw)).toBeNull()
  })

  test("an invalid ambiguity returns null", () => {
    const raw = JSON.stringify({
      armLocalization: true,
      localized: false,
      hardness: "moderate",
      ambiguity: "unsure",
      evidence: "n/a",
    })
    expect(parseArmingResponse(raw)).toBeNull()
  })

  test("a non-boolean armLocalization returns null", () => {
    const raw = JSON.stringify({
      armLocalization: "true",
      localized: false,
      hardness: "moderate",
      ambiguity: "clear",
      evidence: "n/a",
    })
    expect(parseArmingResponse(raw)).toBeNull()
  })

  test("malformed JSON returns null", () => {
    expect(parseArmingResponse("{not valid json")).toBeNull()
  })

  test('a body missing "localized" defaults it to the inverse of armLocalization', () => {
    const armedRaw = JSON.stringify({
      armLocalization: true,
      hardness: "moderate",
      ambiguity: "clear",
      evidence: "n/a",
    })
    const armed = parseArmingResponse(armedRaw)
    expect(armed).not.toBeNull()
    expect(armed!.localized).toBe(false)

    const notArmedRaw = JSON.stringify({
      armLocalization: false,
      hardness: "trivial",
      ambiguity: "clear",
      evidence: "n/a",
    })
    const notArmed = parseArmingResponse(notArmedRaw)
    expect(notArmed).not.toBeNull()
    expect(notArmed!.localized).toBe(true)
  })
})

describe("judgeArming", () => {
  test("resolves the verdict the injected complete callback returns", async () => {
    const complete: TriageComplete = async () =>
      JSON.stringify({
        armLocalization: true,
        localized: false,
        hardness: "moderate",
        ambiguity: "clear",
        evidence: "only a symptom is described",
      })

    const verdict = await judgeArming({ userPrompt: "the app crashes on startup", complete })

    expect(verdict).not.toBeNull()
    expect(verdict!.armLocalization).toBe(true)
    expect(verdict!.hardness).toBe("moderate")
  })

  test(
    "a complete callback slower than ARMING_TIMEOUT_MS resolves to null",
    async () => {
      const complete: TriageComplete = () => new Promise(() => {}) // never resolves
      const verdict = await judgeArming({ userPrompt: "the app crashes on startup", complete })
      expect(verdict).toBeNull()
    },
    // waits out the full ARMING_TIMEOUT_MS (8s) race — needs more than bun's 5s default
    12_000,
  )

  test("a rejected complete callback resolves to null", async () => {
    const complete: TriageComplete = async () => {
      throw new Error("provider unavailable")
    }
    const verdict = await judgeArming({ userPrompt: "the app crashes on startup", complete })
    expect(verdict).toBeNull()
  })

  test("first attempt malformed then valid retries once and resolves, firing onParseRetry once", async () => {
    const validRaw = JSON.stringify({
      armLocalization: true,
      localized: false,
      hardness: "moderate",
      ambiguity: "clear",
      evidence: "only a symptom is described",
    })
    let callCount = 0
    const complete: TriageComplete = async () => {
      callCount++
      return callCount === 1 ? "{not valid json" : validRaw
    }
    let retryCount = 0

    const verdict = await judgeArming({
      userPrompt: "the app crashes on startup",
      complete,
      onParseRetry: () => {
        retryCount++
      },
    })

    expect(verdict).not.toBeNull()
    expect(verdict!.armLocalization).toBe(true)
    expect(callCount).toBe(2)
    expect(retryCount).toBe(1)
  })
})

describe("heuristicArming", () => {
  test("no verdict at all stands down: armLocalization is false", () => {
    const verdict = heuristicArming()
    expect(verdict.armLocalization).toBe(false)
  })

  test("a verdict with a diagnosis-vague goal arms localization", () => {
    const triageVerdict: TriageVerdict = {
      goals: [{ quote: "something is slow sometimes", shape: "diagnosis-vague", deliverable: "cause identified" }],
      constraints: [],
      confidence: "high",
    }

    const verdict = heuristicArming(triageVerdict)

    expect(verdict.armLocalization).toBe(true)
  })

  test("a needsPlan goal produces hardness:hard", () => {
    const triageVerdict: TriageVerdict = {
      goals: [{ quote: "diagnose the flaky test", shape: "build", deliverable: "root cause found", needsPlan: true }],
      constraints: [],
      confidence: "high",
    }

    const verdict = heuristicArming(triageVerdict)

    expect(verdict.hardness).toBe("hard")
  })
})

describe("buildArmingUser", () => {
  test("includes the TASK text", () => {
    const user = buildArmingUser({ userPrompt: "Fix the profile-name bug." })
    expect(user).toContain("TASK:")
    expect(user).toContain("Fix the profile-name bug.")
  })

  test("includes the TRIAGE goals when a verdict is passed", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "the parser drops trailing commas", shape: "diagnosis-grounded", deliverable: "fixed" }],
      constraints: [],
      confidence: "high",
    }

    const user = buildArmingUser({ userPrompt: "Fix the parser bug.", verdict })

    expect(user).toContain("TRIAGE")
    expect(user).toContain("diagnosis-grounded")
    expect(user).toContain("the parser drops trailing commas")
  })

  test("includes the CURRENT PLAN when todos are passed", () => {
    const user = buildArmingUser({
      userPrompt: "Fix the profile-name bug.",
      todos: [{ content: "Implement the fix", status: "pending" }],
    })

    expect(user).toContain("CURRENT PLAN")
    expect(user).toContain("Implement the fix")
  })
})
