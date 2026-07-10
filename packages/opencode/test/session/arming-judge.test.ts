/**
 * Table tests for the arming decision (P1-alt) — `decideArming` is a pure
 * function over the turn-read verdict's extracted evidence, so every rule of
 * the policy is asserted directly: per diagnosis goal,
 * arm = !fixSpecified && (!locationNamed || hardness === "hard"), OR-ed;
 * localized = every diagnosis goal names a location; missing evidence reads
 * conservatively (arm); non-diagnosis shapes never arm.
 */

import { describe, test, expect } from "bun:test"
import { decideArming } from "../../src/session/arming-judge"
import type { TriageGoal, TriageVerdict } from "../../src/session/turn-triage"

function verdictOf(goals: TriageGoal[], confidence: "high" | "low" = "high"): TriageVerdict {
  return { goals, constraints: [], confidence }
}

describe("decideArming — stand-down cases", () => {
  test("no verdict at all stands down (the P5 neutral-degrade posture)", () => {
    const decision = decideArming(null)
    expect(decision.armLocalization).toBe(false)
    expect(decision.localized).toBe(true)
    expect(decision.hardness).toBe("moderate")
    expect(decision.evidence).toContain("stands down")
  })

  test("a build-only turn never arms — localization does not apply", () => {
    const decision = decideArming(
      verdictOf([{ quote: "add a --json flag", shape: "build", deliverable: "flag works" }]),
    )
    expect(decision.armLocalization).toBe(false)
    expect(decision.localized).toBe(true)
    expect(decision.hardness).toBe("trivial")
    expect(decision.evidence).toContain("no diagnosis-shaped goal")
  })

  test("audit/qa/run-only shapes never arm", () => {
    for (const shape of ["audit", "qa", "run-only"] as const) {
      const decision = decideArming(verdictOf([{ quote: "review this PR", shape, deliverable: "done" }]))
      expect(decision.armLocalization).toBe(false)
    }
  })

  test("P3 — research and refactor shapes never arm (localization does not apply)", () => {
    for (const shape of ["research", "refactor"] as const) {
      const decision = decideArming(
        verdictOf([{ quote: "look into the library change", shape, deliverable: "done" }]),
      )
      expect(decision.armLocalization).toBe(false)
      expect(decision.evidence).toContain("no diagnosis-shaped goal")
    }
  })
})

describe("decideArming — the per-goal evidence table", () => {
  test("location named, not hard → no arm, localized (django-12039: the trivial file-named fix stays cheap)", () => {
    const decision = decideArming(
      verdictOf([
        {
          quote: "fix the indentation in ddl_references.py",
          shape: "diagnosis-grounded",
          deliverable: "indentation fixed",
          evidence: { locationNamed: true, locationQuote: "ddl_references.py", fixSpecified: false, hardness: "trivial", ambiguity: "clear" },
        },
      ]),
    )
    expect(decision.armLocalization).toBe(false)
    expect(decision.localized).toBe(true)
    expect(decision.hardness).toBe("trivial")
  })

  test("location named but judged hard → arms anyway (knowing the file is not knowing the mechanism)", () => {
    const decision = decideArming(
      verdictOf([
        {
          quote: "fix the race in cache.ts",
          shape: "diagnosis-grounded",
          deliverable: "race fixed",
          evidence: { locationNamed: true, locationQuote: "cache.ts", fixSpecified: false, hardness: "hard", ambiguity: "clear" },
        },
      ]),
    )
    expect(decision.armLocalization).toBe(true)
    expect(decision.localized).toBe(true)
    expect(decision.hardness).toBe("hard")
  })

  test("a handed fix with no location → no arm (an executor grep, not a diagnosis)", () => {
    const decision = decideArming(
      verdictOf([
        {
          quote: "use request.form.get() instead of request.args.get()",
          shape: "diagnosis-grounded",
          deliverable: "endpoint reads the POST body",
          evidence: { locationNamed: false, fixSpecified: true, fixQuote: "use request.form.get() instead", hardness: "trivial", ambiguity: "clear" },
        },
      ]),
    )
    expect(decision.armLocalization).toBe(false)
    expect(decision.localized).toBe(false)
    expect(decision.evidence).toContain("fix handed")
  })

  test("no location, no fix → arms (the vague-symptom shape)", () => {
    const decision = decideArming(
      verdictOf([
        {
          quote: "the app sometimes crashes on startup",
          shape: "diagnosis-vague",
          deliverable: "crash root-caused and fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ]),
    )
    expect(decision.armLocalization).toBe(true)
    expect(decision.localized).toBe(false)
  })

  test("a diagnosis goal with NO evidence reads conservatively → arms", () => {
    const decision = decideArming(
      verdictOf([{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }]),
    )
    expect(decision.armLocalization).toBe(true)
    expect(decision.localized).toBe(false)
    expect(decision.hardness).toBe("moderate")
    expect(decision.evidence).toContain("no evidence extracted")
  })

  test("mixed goals OR: one located goal + one unlocated goal → arms, not localized", () => {
    const decision = decideArming(
      verdictOf([
        {
          quote: "fix HTTP serialization in server/api.ts",
          shape: "diagnosis-grounded",
          deliverable: "serialization fixed",
          evidence: { locationNamed: true, locationQuote: "server/api.ts", fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
        {
          quote: "a query in the database layer isn't fetching the right fields",
          shape: "diagnosis-vague",
          deliverable: "query fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ]),
    )
    expect(decision.armLocalization).toBe(true)
    expect(decision.localized).toBe(false)
  })
})

describe("decideArming — turn-level hardness and ambiguity", () => {
  test("a needsPlan goal floors hardness to hard (feeds the difficulty floor and the reasoning un-mute)", () => {
    const decision = decideArming(
      verdictOf([{ quote: "refactor the auth module to JWT", shape: "build", deliverable: "JWT everywhere", needsPlan: true }]),
    )
    expect(decision.armLocalization).toBe(false)
    expect(decision.hardness).toBe("hard")
  })

  test("turn hardness is the max judged hardness across diagnosis goals", () => {
    const decision = decideArming(
      verdictOf([
        {
          quote: "fix the typo in README rendering",
          shape: "diagnosis-vague",
          deliverable: "typo fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "trivial", ambiguity: "clear" },
        },
        {
          quote: "the cache corrupts under concurrent writes",
          shape: "diagnosis-vague",
          deliverable: "corruption fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "hard", ambiguity: "clear" },
        },
      ]),
    )
    expect(decision.hardness).toBe("hard")
  })

  test("per-goal judged ambiguity, or a low-confidence extraction, flags the turn ambiguous", () => {
    const judged = decideArming(
      verdictOf([
        {
          quote: "login fails with special characters",
          shape: "diagnosis-vague",
          deliverable: "login fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "ambiguous" },
        },
      ]),
    )
    expect(judged.ambiguity).toBe("ambiguous")

    const lowConfidence = decideArming(
      verdictOf([{ quote: "something is slow sometimes", shape: "diagnosis-vague", deliverable: "cause found" }], "low"),
    )
    expect(lowConfidence.ambiguity).toBe("ambiguous")

    const clear = decideArming(
      verdictOf([
        {
          quote: "the enum renders the wrong label",
          shape: "diagnosis-vague",
          deliverable: "label fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ]),
    )
    expect(clear.ambiguity).toBe("clear")
  })
})
