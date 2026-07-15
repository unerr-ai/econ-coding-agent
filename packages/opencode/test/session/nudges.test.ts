/**
 * Unit tests for prompts/nudges.ts — seenRedInversionNudgeText (the
 * oracle-inversion nudge: a committed test's expectation contradicts the
 * issue's stated desired output, so the F18 seen-red gate marks that red
 * SANCTIONED rather than nudging the model to make it green).
 */

import { describe, test, expect } from "bun:test"
import { seenRedInversionNudgeText } from "../../src/session/prompts/nudges"

describe("seenRedInversionNudgeText", () => {
  test("a single sanctioned entry: SANCTIONED, singular framing, and the command", () => {
    const text = seenRedInversionNudgeText([{ command: "pytest tests/test_widget.py" }])
    expect(text).toContain("SANCTIONED")
    expect(text).toContain("This red is")
    expect(text).toContain("`pytest tests/test_widget.py`")
  })

  test("multiple sanctioned entries: plural framing, and every command", () => {
    const text = seenRedInversionNudgeText([
      { command: "pytest tests/test_widget.py" },
      { command: "pytest tests/test_forms.py" },
    ])
    expect(text).toContain("SANCTIONED")
    expect(text).toContain("These reds are")
    expect(text).toContain("`pytest tests/test_widget.py`")
    expect(text).toContain("`pytest tests/test_forms.py`")
  })

  test("includes the desired/buggy literals in the evidence line when both are present", () => {
    const text = seenRedInversionNudgeText([
      { command: "pytest tests/test_widget.py", desiredLiteral: "254", buggyLiteral: "'254'" },
    ])
    expect(text).toContain("254")
    expect(text).toContain("'254'")
    expect(text).toContain("the issue's stated desired form")
  })

  test("omits the evidence line when only one of desired/buggy literal is present", () => {
    const text = seenRedInversionNudgeText([{ command: "pytest tests/test_widget.py", desiredLiteral: "254" }])
    expect(text).not.toContain("the issue's stated desired form")
  })
})
