/**
 * Tests for the repro-fidelity judge (F9a) — the pure parse/validate
 * pipeline (`parseReproFidelityResponse`) plus its one-shot dispatch
 * (`runReproFidelityJudge`), using arming-judge's scripted-LLM-stub pattern:
 * `complete` is a plain mocked callback, never a real provider. Table:
 * faithful verdict -> no nudge; gaps verdict -> nudge text contains each gap;
 * malformed LLM output -> faithful no-op; LLM throw -> faithful no-op.
 *
 * F14b adds the deterministic assert-teeth backstop: `hasAssertionTeeth`'s
 * truth table, and `applyAssertionTeethGap`'s gap-merge behavior (forces a
 * gap verdict even when the judge said faithful/degraded). RF-4 adds two
 * more of the same shape: `detectRenderedAssert`/`applyRenderedAssertGap`
 * (rendered/serialized-surface asserts) and `missingRequiredLiterals`/
 * `applyRequiredLiteralsGap` (§6 issue-derived literal coverage). The
 * `dispatchPinnedReproFidelity` wiring in prompt.ts (the shared dispatch
 * both pin sites call) is an Effect-generator closure over turn-loop state
 * (sessionID, sessions, lastUser, the per-turn `reproFidelityJudgedThisTurn`
 * flag) — not practical to unit test in isolation here; its two exported
 * building blocks (`hasAssertionTeeth`, `applyAssertionTeethGap`) are
 * covered directly below instead.
 */

import { describe, test, expect } from "bun:test"
import {
  parseReproFidelityResponse,
  runReproFidelityJudge,
  hasAssertionTeeth,
  applyAssertionTeethGap,
  ASSERTION_TEETH_GAP,
  detectRenderedAssert,
  applyRenderedAssertGap,
  RENDERED_ASSERT_GAP,
  missingRequiredLiterals,
  applyRequiredLiteralsGap,
  DEGRADED_REPRO_FIDELITY,
  REPRO_FIDELITY_MAX_GAPS,
  REPRO_FIDELITY_MAX_GAP_CHARS,
  type ReproFidelityComplete,
} from "../../src/session/repro-fidelity-judge"
import { reproFidelityNudgeText } from "../../src/session/prompts/nudges"
import { REPRO_FIDELITY_SYSTEM_PROMPT } from "../../src/session/prompts/judges"

describe("parseReproFidelityResponse", () => {
  test("a faithful verdict with no gaps parses", () => {
    const raw = JSON.stringify({ faithful: true, gaps: [] })
    expect(parseReproFidelityResponse(raw)).toEqual({ faithful: true, gaps: [] })
  })

  test("an unfaithful verdict carries its gaps through", () => {
    const raw = JSON.stringify({ faithful: false, gaps: ["asserts HTML maxlength, not the int value"] })
    expect(parseReproFidelityResponse(raw)).toEqual({
      faithful: false,
      gaps: ["asserts HTML maxlength, not the int value"],
    })
  })

  test("gaps beyond REPRO_FIDELITY_MAX_GAPS are clamped", () => {
    const raw = JSON.stringify({ faithful: false, gaps: ["a", "b", "c", "d", "e"] })
    const verdict = parseReproFidelityResponse(raw)
    expect(verdict).not.toBeNull()
    expect(verdict!.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
    expect(verdict!.gaps).toEqual(["a", "b", "c"])
  })

  test("a gap longer than REPRO_FIDELITY_MAX_GAP_CHARS is truncated, not dropped", () => {
    const longGap = "x".repeat(200)
    const raw = JSON.stringify({ faithful: false, gaps: [longGap] })
    const verdict = parseReproFidelityResponse(raw)
    expect(verdict).not.toBeNull()
    expect(verdict!.gaps[0]).toHaveLength(REPRO_FIDELITY_MAX_GAP_CHARS)
  })

  test("a non-string gap entry is dropped, not corrected", () => {
    const raw = JSON.stringify({ faithful: false, gaps: ["real gap", 42, null] })
    const verdict = parseReproFidelityResponse(raw)
    expect(verdict!.gaps).toEqual(["real gap"])
  })

  test("a missing faithful field fails validation", () => {
    const raw = JSON.stringify({ gaps: [] })
    expect(parseReproFidelityResponse(raw)).toBeNull()
  })

  test("malformed JSON fails validation", () => {
    expect(parseReproFidelityResponse("{not valid json")).toBeNull()
  })

  test("no JSON object at all fails validation", () => {
    expect(parseReproFidelityResponse("I cannot judge this.")).toBeNull()
  })

  test("empty raw text fails validation", () => {
    expect(parseReproFidelityResponse("")).toBeNull()
  })
})

describe("runReproFidelityJudge", () => {
  const issueText = 'The issue quotes str(Choices.RED) and expects "Red", not the raw enum value.'
  const reproContent = 'assert response.content.decode().count(\'maxlength="254"\') == 1\n'

  test("a faithful verdict needs no nudge", async () => {
    const complete: ReproFidelityComplete = async () => JSON.stringify({ faithful: true, gaps: [] })
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict.faithful).toBe(true)
    expect(verdict.gaps).toHaveLength(0)
  })

  test("a gaps verdict's nudge text contains each gap", async () => {
    const gaps = ["asserts HTML maxlength, not the int value", "no assert on str(Choices.RED) itself"]
    const complete: ReproFidelityComplete = async () => JSON.stringify({ faithful: false, gaps })
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict.faithful).toBe(false)
    const nudge = reproFidelityNudgeText([...verdict.gaps])
    for (const gap of gaps) expect(nudge).toContain(gap)
  })

  test("malformed LLM output degrades to the faithful no-op", async () => {
    const complete: ReproFidelityComplete = async () => "{not valid json"
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict).toEqual(DEGRADED_REPRO_FIDELITY)
  })

  test("a thrown completion degrades to the faithful no-op", async () => {
    const complete: ReproFidelityComplete = async () => {
      throw new Error("provider unavailable")
    }
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict).toEqual(DEGRADED_REPRO_FIDELITY)
  })

  test("the completion request carries the issue text and repro content", async () => {
    let seenUser = ""
    let seenSystem = ""
    const complete: ReproFidelityComplete = async ({ system, user }) => {
      seenSystem = system
      seenUser = user
      return JSON.stringify({ faithful: true, gaps: [] })
    }
    await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(seenSystem).toContain("repro-fidelity judge")
    expect(seenUser).toContain(issueText)
    expect(seenUser).toContain(reproContent)
  })
})

describe("reproFidelityNudgeText", () => {
  test("names each gap and the re-run-STILL-RED instruction", () => {
    const gaps = ["asserts HTML maxlength, not the int value"]
    const text = reproFidelityNudgeText(gaps)
    expect(text).toContain(gaps[0])
    expect(text.toUpperCase()).toContain("STILL RED")
  })

  test("names every gap when there are several", () => {
    const gaps = ["gap one here", "gap two here"]
    const text = reproFidelityNudgeText(gaps)
    for (const gap of gaps) expect(text).toContain(gap)
  })

  test("F15d — tells the model to verify each gap against the issue text and ignore an invented one", () => {
    const text = reproFidelityNudgeText(["some gap"])
    expect(text).toContain("Verify each gap above against the issue text yourself")
    expect(text).toContain("ignore any gap here that asserts something the issue itself does not state")
  })
})

describe("REPRO_FIDELITY_SYSTEM_PROMPT", () => {
  test("F15d — forbids the judge from inventing an expectation the issue does not state", () => {
    expect(REPRO_FIDELITY_SYSTEM_PROMPT).toContain("never invent an expectation the issue text does not state")
    expect(REPRO_FIDELITY_SYSTEM_PROMPT).toContain("omit that gap entirely rather than assert one")
  })
})

describe("hasAssertionTeeth", () => {
  test.each([
    ["assert response.status_code == 200", true],
    ["raise ValueError('mismatch')", true],
    ["sys.exit(1)", true],
    ["exit(2)", true],
    ["process.exit(1)", true],
    ["exit 1", true],
    ["throw new Error('mismatch')", true],
    ["os._exit(3)", true],
  ])("%s -> %s", (content, expected) => {
    expect(hasAssertionTeeth(content)).toBe(expected)
  })

  test.each([
    ['print(f"EXPECTED {expected} ACTUAL {actual}")', false],
    ["exit(0)", false],
    ["sys.exit()", false],
    ["sys.exit(0)", false],
    ["# this needs an assertion eventually", false],
    ["", false],
  ])("%s -> %s", (content, expected) => {
    expect(hasAssertionTeeth(content)).toBe(expected)
  })

  test("a bare word boundary means 'assertion' (not 'assert') does not count — documented limitation", () => {
    // Plain word-boundary regex is intentional (F14b spec): \bassert\b does
    // not match inside "assertion" (no boundary between "assert" and "ion").
    expect(hasAssertionTeeth("# add an assertion here later")).toBe(false)
  })

  test("shell exit with a multi-digit nonzero code counts", () => {
    expect(hasAssertionTeeth("exit 10")).toBe(true)
  })
})

describe("applyAssertionTeethGap", () => {
  const faithfulVerdict = { faithful: true, gaps: [] }

  test("toothless content forces a gap verdict even when the judge said faithful", () => {
    const merged = applyAssertionTeethGap(faithfulVerdict, 'print("EXPECTED 1 ACTUAL 2")')
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toEqual([ASSERTION_TEETH_GAP])
  })

  test("toothless content forces a gap verdict even when the judge already reported other gaps", () => {
    const judgeVerdict = { faithful: false, gaps: ["asserts the wrong field"] }
    const merged = applyAssertionTeethGap(judgeVerdict, 'print("EXPECTED 1 ACTUAL 2")')
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toEqual(["asserts the wrong field", ASSERTION_TEETH_GAP])
  })

  test("content with real assertion teeth is a no-op — same verdict reference returned", () => {
    const verdict = faithfulVerdict
    const merged = applyAssertionTeethGap(verdict, "assert response.status_code == 200")
    expect(merged).toBe(verdict)
  })

  test("the merged gap list is reclamped to REPRO_FIDELITY_MAX_GAPS", () => {
    const judgeVerdict = {
      faithful: false,
      gaps: Array.from({ length: REPRO_FIDELITY_MAX_GAPS }, (_, i) => `gap ${i}`),
    }
    const merged = applyAssertionTeethGap(judgeVerdict, 'print("no teeth here")')
    expect(merged.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
    expect(merged.gaps).not.toContain(ASSERTION_TEETH_GAP)
  })
})

describe("detectRenderedAssert", () => {
  test("fires on a substring assert against a rendered HTML variable", () => {
    expect(detectRenderedAssert('assert \'maxlength="254"\' in html')).toBeDefined()
  })

  test("fires on an assertIn shape against a rendered variable", () => {
    expect(detectRenderedAssert('assertIn("maxlength=\\"254\\"", rendered)')).toBeDefined()
  })

  test("fires on a compared expression wrapped in str(...)", () => {
    expect(detectRenderedAssert("assert str(field.max_length) == '254'")).toBeDefined()
  })

  test("does NOT fire on a plain typed-equality assert", () => {
    expect(detectRenderedAssert('assert form.fields["username"].max_length == 254')).toBeUndefined()
  })

  test("does NOT fire on content with no assert at all", () => {
    expect(detectRenderedAssert('print("no assertion here")')).toBeUndefined()
  })
})

describe("applyRenderedAssertGap", () => {
  const faithfulVerdict = { faithful: true, gaps: [] }

  test("a rendered-assert hit forces a gap verdict even when the judge said faithful", () => {
    const merged = applyRenderedAssertGap(faithfulVerdict, 'assert \'maxlength="254"\' in html')
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toEqual([RENDERED_ASSERT_GAP])
  })

  test("content with no rendered-assert shape is a no-op — same verdict reference returned", () => {
    const verdict = faithfulVerdict
    const merged = applyRenderedAssertGap(verdict, 'assert form.fields["username"].max_length == 254')
    expect(merged).toBe(verdict)
  })
})

describe("missingRequiredLiterals / applyRequiredLiteralsGap", () => {
  const reproContent = "assert response.status_code == 200\n"

  test("a literal present in the repro is not reported missing", () => {
    expect(missingRequiredLiterals('assert x == "254"', ["254"])).toEqual([])
  })

  test("a literal absent from the repro is reported missing", () => {
    expect(missingRequiredLiterals(reproContent, ['"name" DESC'])).toEqual(['"name" DESC'])
  })

  test("undefined/empty requiredLiterals yields no misses", () => {
    expect(missingRequiredLiterals(reproContent, undefined)).toEqual([])
    expect(missingRequiredLiterals(reproContent, [])).toEqual([])
  })

  test("a missing required literal forces a gap naming it, even when the judge said faithful", () => {
    const faithfulVerdict = { faithful: true, gaps: [] }
    const merged = applyRequiredLiteralsGap(faithfulVerdict, reproContent, ['"name" DESC'])
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toHaveLength(1)
    expect(merged.gaps[0]).toContain('"name" DESC')
  })

  test("a present required literal is a no-op — same verdict reference returned", () => {
    const verdict = { faithful: true, gaps: [] }
    const merged = applyRequiredLiteralsGap(verdict, reproContent, ["status_code"])
    expect(merged).toBe(verdict)
  })

  test("the merged gap list is reclamped to REPRO_FIDELITY_MAX_GAPS", () => {
    const judgeVerdict = {
      faithful: false,
      gaps: Array.from({ length: REPRO_FIDELITY_MAX_GAPS }, (_, i) => `gap ${i}`),
    }
    const merged = applyRequiredLiteralsGap(judgeVerdict, reproContent, ['"name" DESC'])
    expect(merged.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
  })
})
