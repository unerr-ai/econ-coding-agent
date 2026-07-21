/**
 * Table tests for the arming decision (P1-alt) — `decideArming` is a pure
 * function over the turn-read verdict's extracted evidence, so every rule of
 * the policy is asserted directly: per diagnosis goal,
 * arm = !fixSpecified && (!locationNamed || hardness === "hard"), OR-ed;
 * localized = every diagnosis goal names a location; missing evidence reads
 * conservatively (arm); non-diagnosis shapes never arm.
 */

import { describe, test, expect } from "bun:test"
import { allocateSlice, resolutionDecision } from "@opencode-ai/code-intelligence"
import { decideArming, verdictIsReadOnly, DEGRADED_ARMING } from "../../src/session/arming-judge"
import type { TriageGoal, TriageVerdict } from "../../src/session/turn-triage"

function verdictOf(goals: TriageGoal[], confidence: "high" | "low" = "high"): TriageVerdict {
  return { goals, constraints: [], confidence }
}

describe("decideArming — stand-down cases", () => {
  test("no verdict at all resolves to DEGRADED_ARMING (the P5 cheapest-degrade posture)", () => {
    const decision = decideArming(null)
    expect(decision).toEqual(DEGRADED_ARMING)
    expect(decision.armLocalization).toBe(false)
    expect(decision.localized).toBe(true)
    // The floor, not "moderate": below the hard/ambiguous threshold every lift consumer gates on.
    expect(decision.hardness).toBe("trivial")
    expect(decision.ambiguity).toBe("clear")
    // The inline-stand-down flag the orchestration hook reads — true ONLY here.
    expect(decision.degraded).toBe(true)
    expect(decision.evidence).toContain("stands down")
  })

  test("a computed verdict is never flagged degraded (degraded is the null-posture flag only)", () => {
    const build = decideArming(verdictOf([{ quote: "add a --json flag", shape: "build", deliverable: "flag works" }]))
    const diagnosis = decideArming(
      verdictOf([{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }]),
    )
    expect(build.degraded).toBeFalsy()
    expect(diagnosis.degraded).toBeFalsy()
  })

  test("the degraded posture triggers NO lift — no difficulty floor, no reasoning un-mute, no decompose-from-flag", () => {
    const degrade = decideArming(null)

    // Reasoning un-mute (llm/request.ts): un-mutes only on ambiguous/hard — the
    // degrade sits below that threshold, so the conductor stays on its cheap baseline.
    expect(degrade.ambiguity === "ambiguous" || degrade.hardness === "hard").toBe(false)

    // Per-slice difficulty floor (allocation.ts): a testable, spec-backed mechanical
    // slice carrying the degrade's difficulty stays on the executor — never floored
    // to the reasoner (the floor only fires on hard/ambiguous).
    const alloc = allocateSlice({
      sliceType: "mechanical",
      testStrength: "testable",
      specBacked: true,
      hardness: degrade.hardness,
      ambiguity: degrade.ambiguity,
    })
    expect(alloc.tier).toBe("executor")
    expect(alloc.reasonCode).not.toBe("difficulty-floor")

    // Resolution decompose gate (resolution-phase.ts): the degrade is never
    // "flagged", so the gate never engages a resolve-first/decompose-from-flag pass.
    const res = resolutionDecision({
      hardness: degrade.hardness,
      ambiguity: degrade.ambiguity,
      armLocalization: degrade.armLocalization,
      budget: 10_000,
      interactive: true,
      resolveAttempts: 0,
    })
    expect(res.reason).toBe("approach not uncertain")
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
  test("location named, not hard → no arm, localized (the trivial file-named fix stays cheap)", () => {
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

describe("decideArming — armReproduction (S2 repro-first gate)", () => {
  test("DEGRADED_ARMING never arms reproduction", () => {
    expect(DEGRADED_ARMING.armReproduction).toBe(false)
  })

  test("any diagnosis-shaped goal arms reproduction — even a fully handed fix (repro-first: a post-fix repro can only ever run green)", () => {
    const handedFix = decideArming(
      verdictOf([
        {
          quote: "use request.form.get() instead of request.args.get()",
          shape: "diagnosis-grounded",
          deliverable: "endpoint reads the POST body",
          evidence: {
            locationNamed: false,
            fixSpecified: true,
            fixQuote: "use request.form.get() instead",
            hardness: "trivial",
            ambiguity: "clear",
          },
        },
      ]),
    )
    expect(handedFix.armLocalization).toBe(false) // localization does not need to arm...
    expect(handedFix.armReproduction).toBe(true) // ...but reproduction still does

    const located = decideArming(
      verdictOf([
        {
          quote: "fix the indentation in ddl_references.py",
          shape: "diagnosis-grounded",
          deliverable: "indentation fixed",
          evidence: { locationNamed: true, locationQuote: "ddl_references.py", fixSpecified: false, hardness: "trivial", ambiguity: "clear" },
        },
      ]),
    )
    expect(located.armReproduction).toBe(true)

    const vague = decideArming(
      verdictOf([{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }]),
    )
    expect(vague.armReproduction).toBe(true)
  })

  test("build/refactor/audit/qa/research/run-only shapes never arm reproduction — it applies to diagnosis goals only", () => {
    for (const shape of ["build", "refactor", "audit", "qa", "research", "run-only"] as const) {
      const decision = decideArming(verdictOf([{ quote: "do the thing", shape, deliverable: "done" }]))
      expect(decision.armReproduction).toBe(false)
    }
  })

  test("a mixed turn (one build goal + one diagnosis goal) arms reproduction — OR-ed the same way armLocalization is", () => {
    const decision = decideArming(
      verdictOf([
        { quote: "add a --json flag", shape: "build", deliverable: "flag works" },
        { quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" },
      ]),
    )
    expect(decision.armReproduction).toBe(true)
  })
})

describe("verdictIsReadOnly — the turn-shape lever the harness gates on", () => {
  test("every read-only shape (qa/research/audit/run-only) is read-only", () => {
    for (const shape of ["qa", "research", "audit", "run-only"] as const) {
      expect(verdictIsReadOnly(verdictOf([{ quote: "where is X", shape, deliverable: "answer" }]))).toBe(true)
    }
  })

  test("a turn of ALL read-only goals is read-only (a multi-question turn still stands the fix machinery down)", () => {
    const verdict = verdictOf([
      { quote: "where is resolve_redirects", shape: "qa", deliverable: "answer" },
      { quote: "list the retry call sites", shape: "audit", deliverable: "list" },
    ])
    expect(verdictIsReadOnly(verdict)).toBe(true)
  })

  test("every editing shape (diagnosis-*/build/refactor) is NOT read-only — the fix harness stays armed", () => {
    for (const shape of ["diagnosis-vague", "diagnosis-grounded", "build", "refactor"] as const) {
      expect(verdictIsReadOnly(verdictOf([{ quote: "do the thing", shape, deliverable: "done" }]))).toBe(false)
    }
  })

  test("a COMPOUND turn with even one fix goal is NOT read-only — 'explain X and fix Y' keeps the full harness", () => {
    const compound = verdictOf([
      { quote: "explain how redirect handling works", shape: "qa", deliverable: "answer" },
      { quote: "fix the failing redirect test", shape: "diagnosis-grounded", deliverable: "test green" },
    ])
    expect(verdictIsReadOnly(compound)).toBe(false)
    // …and its diagnosis goal still arms reproduction — the fix work fires.
    expect(decideArming(compound).armReproduction).toBe(true)
  })

  test("an absent or empty verdict is NOT read-only — the null-verdict DEGRADED_ARMING path owns that posture", () => {
    expect(verdictIsReadOnly(null)).toBe(false)
    expect(verdictIsReadOnly(undefined)).toBe(false)
    expect(verdictIsReadOnly(verdictOf([]))).toBe(false)
  })
})
