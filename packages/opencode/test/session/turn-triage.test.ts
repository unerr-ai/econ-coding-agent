/**
 * Tests for the turn-read extraction module (P1-alt) — the pure
 * parse/validate pipeline (`parseTurnReadResponse`), including the
 * per-diagnosis-goal evidence section, and its blocking, conductor-tier call
 * wrapper (`runTurnRead`), per docs/architecture/ORCHESTRATION_MECHANISM.md
 * §1.1/§4.1. No wiring here — `complete` is a plain mocked callback, never a
 * real provider.
 */

import { describe, test, expect } from "bun:test"
import {
  parseTurnReadResponse,
  runTurnRead,
  triageTelemetry,
  isContinuationShortCircuit,
  TRIAGE_MAX_GOALS,
  type TriageComplete,
} from "../../src/session/turn-triage"

describe("parseTurnReadResponse", () => {
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

    const verdict = parseTurnReadResponse(raw, userPrompt)

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

    const verdict = parseTurnReadResponse(raw, userPrompt)

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

    const verdict = parseTurnReadResponse(raw, userPrompt)

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

    const verdict = parseTurnReadResponse(raw, userPrompt)

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

    const verdict = parseTurnReadResponse(raw, userPrompt)

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

    expect(parseTurnReadResponse(raw, userPrompt)).toBeNull()
  })

  test("malformed JSON returns null", () => {
    const userPrompt = "Fix the profile-name bug."
    expect(parseTurnReadResponse("{not valid json", userPrompt)).toBeNull()
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

    expect(parseTurnReadResponse(raw, userPrompt)).toBeNull()
  })

  test("the verbatim-substring check is case-sensitive", () => {
    const userPrompt = "Fix the Login bug."
    const wrongCase = JSON.stringify({
      goals: [{ quote: "fix the login bug", shape: "diagnosis-grounded", deliverable: "n/a" }],
      constraints: [],
      confidence: "high",
    })
    expect(parseTurnReadResponse(wrongCase, userPrompt)).toBeNull()

    const exactCase = JSON.stringify({
      goals: [{ quote: "Fix the Login bug", shape: "diagnosis-grounded", deliverable: "login works again" }],
      constraints: [],
      confidence: "high",
    })
    const verdict = parseTurnReadResponse(exactCase, userPrompt)
    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].quote).toBe("Fix the Login bug")
  })

  // JOB 2 — the per-diagnosis-goal evidence section (P1-alt). Partial-accept
  // (Q-B): a bad evidence section never sinks its goal; an unbacked `true`
  // claim degrades to false (the conservative, arm-leaning posture).

  test("a diagnosis goal carries its evidence through: quotes validated verbatim", () => {
    const userPrompt = "fix the off-by-one in src/parser.ts — the loop should start at 1, not 0"
    const raw = JSON.stringify({
      goals: [
        {
          quote: "fix the off-by-one in src/parser.ts",
          shape: "diagnosis-grounded",
          deliverable: "loop bound corrected",
          evidence: {
            locationNamed: true,
            locationQuote: "src/parser.ts",
            fixSpecified: true,
            fixQuote: "the loop should start at 1, not 0",
            hardness: "trivial",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].evidence).toEqual({
      locationNamed: true,
      locationQuote: "src/parser.ts",
      fixSpecified: true,
      fixQuote: "the loop should start at 1, not 0",
      hardness: "trivial",
      ambiguity: "clear",
    })
  })

  test("locationNamed:true without a verbatim quote degrades to false — evidence is auditable, never asserted", () => {
    const userPrompt = "the importer rejects vCard 4.0 files"
    const raw = JSON.stringify({
      goals: [
        {
          quote: "the importer rejects vCard 4.0 files",
          shape: "diagnosis-vague",
          deliverable: "importer accepts vCard 4.0",
          evidence: {
            locationNamed: true,
            locationQuote: "importer.py", // not in the prompt
            fixSpecified: true,
            fixQuote: "", // empty — no backing quote
            hardness: "moderate",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].evidence!.locationNamed).toBe(false)
    expect(verdict!.goals[0].evidence!.fixSpecified).toBe(false)
  })

  test("a malformed evidence section is dropped while its goal survives (Q-B partial-accept)", () => {
    const userPrompt = "the app crashes on startup"
    const raw = JSON.stringify({
      goals: [
        {
          quote: "the app crashes on startup",
          shape: "diagnosis-vague",
          deliverable: "crash fixed",
          evidence: "not an object",
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
    expect(verdict!.goals[0].evidence).toBeUndefined()
  })

  test("an invalid hardness/ambiguity value is dropped from the evidence, the booleans survive", () => {
    const userPrompt = "the session handler leaks memory in handler.ts"
    const raw = JSON.stringify({
      goals: [
        {
          quote: "the session handler leaks memory in handler.ts",
          shape: "diagnosis-grounded",
          deliverable: "leak fixed",
          evidence: {
            locationNamed: true,
            locationQuote: "handler.ts",
            fixSpecified: false,
            fixQuote: "",
            hardness: "extreme",
            ambiguity: "unsure",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].evidence).toEqual({
      locationNamed: true,
      locationQuote: "handler.ts",
      fixSpecified: false,
    })
  })

  // A reasoning conductor can stream a preamble (or trailing prose) alongside
  // the JSON answer, or land the answer entirely in the reasoning channel —
  // see turnReadDispatch, prompt.ts. These cases cover the resulting
  // `extractJsonObject` tolerance.

  test("a reasoning preamble before the JSON parses correctly", () => {
    const userPrompt = "Fix the login bug where users can't reset their password."
    const json = JSON.stringify({
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
    const raw = `Let me think through this step by step before answering.\n${json}`

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
    expect(verdict!.goals[0].quote).toBe("Fix the login bug where users can't reset their password.")
  })

  test("trailing prose after the JSON is ignored by the balanced-brace extraction", () => {
    const userPrompt = "Fix the profile-name bug."
    const json = JSON.stringify({
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
    const raw = `${json}\n\nThat's my full analysis of the request.`

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
  })

  test("a brace inside a quoted field doesn't confuse the balanced-brace extraction", () => {
    const userPrompt = "Fix the config parser for the {invalid} block syntax."
    const json = JSON.stringify({
      goals: [
        {
          quote: "Fix the config parser for the {invalid} block syntax.",
          shape: "diagnosis-grounded",
          deliverable: "parser handles {invalid} blocks",
        },
      ],
      constraints: [],
      confidence: "high",
    })
    const raw = `Reasoning first.\n${json}\ntrailing`

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].quote).toBe("Fix the config parser for the {invalid} block syntax.")
  })

  test("empty raw (no content and no reasoning) returns null", () => {
    const userPrompt = "Fix the profile-name bug."
    expect(parseTurnReadResponse("", userPrompt)).toBeNull()
  })

  test("a reasoning-only fallback string — no content, just a reasoning stream ending in the JSON answer — still parses", () => {
    const userPrompt = "Fix the profile-name bug."
    const json = JSON.stringify({
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
    // Mirrors turnReadDispatch's `text.trim() || reasoningText` fallback: when
    // the model's content channel comes back empty, the reasoning stream
    // (which typically opens with commentary before the JSON answer) is passed
    // to the parser instead.
    const raw = `I need to identify the goals and constraints in this prompt. The user wants a bug fixed, so the shape is diagnosis-grounded.\n${json}`

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
    expect(verdict!.goals[0].shape).toBe("diagnosis-grounded")
  })

  test("raw text with no JSON object at all returns null", () => {
    const userPrompt = "Fix the profile-name bug."
    expect(parseTurnReadResponse("Sure, I can help with that.", userPrompt)).toBeNull()
  })
})

describe("runTurnRead", () => {
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

    const verdict = await runTurnRead({ userPrompt, complete })

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
  })

  test("a complete callback slower than the timeout resolves to null", async () => {
    const complete: TriageComplete = () => new Promise(() => {}) // never resolves
    // Inject a tiny cap so the race resolves instantly instead of waiting the real TURN_READ_TIMEOUT_MS.
    const verdict = await runTurnRead({ userPrompt: "Fix the profile-name bug.", complete, timeoutMs: 50 })
    expect(verdict).toBeNull()
  })

  test("a rejected complete callback resolves to null", async () => {
    const complete: TriageComplete = async () => {
      throw new Error("provider unavailable")
    }
    const verdict = await runTurnRead({ userPrompt: "Fix the profile-name bug.", complete })
    expect(verdict).toBeNull()
  })

  test("malformed JSON from complete resolves to null", async () => {
    const complete: TriageComplete = async () => "{not valid json"
    const verdict = await runTurnRead({ userPrompt: "Fix the profile-name bug.", complete })
    expect(verdict).toBeNull()
  })

  test("a parse failure then a valid second response returns the verdict, retries once, and fires onParseRetry once", async () => {
    const userPrompt = "Fix the profile-name bug."
    const validRaw = JSON.stringify({
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
    let callCount = 0
    const complete: TriageComplete = async () => {
      callCount++
      return callCount === 1 ? "{not valid json" : validRaw
    }
    let retryCount = 0
    const verdict = await runTurnRead({
      userPrompt,
      complete,
      onParseRetry: () => {
        retryCount++
      },
    })

    expect(verdict).not.toBeNull()
    expect(verdict!.goals).toHaveLength(1)
    expect(callCount).toBe(2)
    expect(retryCount).toBe(1)
  })

  test("two parse failures return null, calling complete twice and firing onParseRetry exactly once", async () => {
    let callCount = 0
    const complete: TriageComplete = async () => {
      callCount++
      return "{not valid json"
    }
    let retryCount = 0
    const verdict = await runTurnRead({
      userPrompt: "Fix the profile-name bug.",
      complete,
      onParseRetry: () => {
        retryCount++
      },
    })

    expect(verdict).toBeNull()
    expect(callCount).toBe(2)
    expect(retryCount).toBe(1)
  })

  test("a rejected complete callback resolves to null without retrying", async () => {
    let callCount = 0
    const complete: TriageComplete = async () => {
      callCount++
      throw new Error("provider unavailable")
    }
    let retryCount = 0
    const verdict = await runTurnRead({
      userPrompt: "Fix the profile-name bug.",
      complete,
      onParseRetry: () => {
        retryCount++
      },
    })

    expect(verdict).toBeNull()
    expect(callCount).toBe(1)
    expect(retryCount).toBe(0)
  })
})

describe("triageTelemetry", () => {
  test("summarizes goal count, shapes, constraint kinds, and confidence", () => {
    const verdict = parseTurnReadResponse(
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
      turnRole: "fresh",
    })
  })
})

// P3 — the taxonomy additions: research/refactor shapes and the no-edits
// constraint kind ride the same parse/validate pipeline.
describe("parseTurnReadResponse — P3 shapes and constraints", () => {
  test("a research-shaped goal parses (external-sources deliverable)", () => {
    const userPrompt = "What breaking changes did zod v4 ship, and do any affect our validators?"
    const raw = JSON.stringify({
      goals: [
        {
          quote: "What breaking changes did zod v4 ship",
          shape: "research",
          deliverable: "a cited digest of zod v4 breaking changes",
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].shape).toBe("research")
  })

  test("a refactor-shaped goal parses (restructure, no behavior change)", () => {
    const userPrompt = "extract the retry logic into a shared helper without changing behavior"
    const raw = JSON.stringify({
      goals: [
        {
          quote: "extract the retry logic into a shared helper",
          shape: "refactor",
          deliverable: "retry logic shared, behavior unchanged, suite green",
        },
      ],
      constraints: [],
      confidence: "high",
    })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.goals[0].shape).toBe("refactor")
  })

  test('"plan the migration, don\'t code it" extracts a no-edits constraint', () => {
    const userPrompt = "plan the migration to the new billing API, don't code it"
    const raw = JSON.stringify({
      goals: [
        {
          quote: "plan the migration to the new billing API",
          shape: "build",
          deliverable: "a migration plan",
          needsPlan: true,
        },
      ],
      constraints: [{ quote: "don't code it", kind: "no-edits" }],
      confidence: "high",
    })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.constraints[0].kind).toBe("no-edits")
    expect(verdict!.goals[0].needsPlan).toBe(true)
  })
})

// P4 — the turnRole field and the pre-LLM continuation short-circuit.
describe("parseTurnReadResponse — P4 turnRole", () => {
  test("turnRole absent defaults to fresh (older mocks/stubs keep working)", () => {
    const userPrompt = "Fix the profile-name bug."
    const raw = JSON.stringify({
      goals: [
        { quote: "Fix the profile-name bug.", shape: "diagnosis-grounded", deliverable: "profile name displays" },
      ],
      constraints: [],
      confidence: "high",
    })
    expect(parseTurnReadResponse(raw, userPrompt)!.turnRole).toBe("fresh")
  })

  test("a continuation verdict may carry ZERO goals — a pure steering message extracts nothing", () => {
    const userPrompt = "hmm, that approach still seems to produce the same failure as before somehow"
    const raw = JSON.stringify({ goals: [], constraints: [], confidence: "high", turnRole: "continuation" })

    const verdict = parseTurnReadResponse(raw, userPrompt)

    expect(verdict).not.toBeNull()
    expect(verdict!.turnRole).toBe("continuation")
    expect(verdict!.goals).toHaveLength(0)
  })

  test("zero goals on a FRESH verdict still fails outright", () => {
    const raw = JSON.stringify({ goals: [], constraints: [], confidence: "high", turnRole: "fresh" })
    expect(parseTurnReadResponse(raw, "Fix the profile-name bug.")).toBeNull()
  })

  test("an invalid turnRole value reads as fresh", () => {
    const userPrompt = "Fix the profile-name bug."
    const raw = JSON.stringify({
      goals: [
        { quote: "Fix the profile-name bug.", shape: "diagnosis-grounded", deliverable: "profile name displays" },
      ],
      constraints: [],
      confidence: "high",
      turnRole: "followup",
    })
    expect(parseTurnReadResponse(raw, userPrompt)!.turnRole).toBe("fresh")
  })
})

describe("isContinuationShortCircuit — the pre-LLM ack/anaphora net", () => {
  test("the canonical ack/steering messages short-circuit", () => {
    for (const prompt of [
      "go ahead",
      "yes, do it",
      "continue",
      "proceed",
      "try again",
      "keep going",
      "still broken",
      "it's still failing",
      "still not working",
      "that didn't work",
      "same error",
      "ok go ahead!",
    ]) {
      expect(isContinuationShortCircuit(prompt)).toBe(true)
    }
  })

  test("real work never short-circuits — when in doubt, call the model", () => {
    for (const prompt of [
      "now also handle the empty case", // new deliverable — must reach the turn-read
      "go ahead and rewrite the auth module to use JWT", // ack prefix but carries work
      "still broken in src/parser.ts", // path-shaped token
      "try again with `--force`", // code-shaped token
      "fix the memory leak in the session handler",
      "continue the migration by porting the billing module and its tests over too", // ≥80 chars of real work
      "",
    ]) {
      expect(isContinuationShortCircuit(prompt)).toBe(false)
    }
  })
})
