import { describe, test, expect } from "bun:test"
import {
  detectOracleInversion,
  extractIssueExpectations,
  type IssueExpectation,
} from "../../src/session/issue-expectations"

describe("extractIssueExpectations", () => {
  test("12039-shaped: quoted-identifier spacing bug — expected and actual both extracted with correct kinds", () => {
    const issueText = [
      "The generated ORDER BY clause is missing a space before the direction keyword.",
      'Expected output contains the ordering `"name" DESC` with a space before DESC.',
      'Actual output produces `"name"DESC` with no space, which is the bug.',
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    const expected = literals.find((l) => l.value === '"name" DESC')
    const actual = literals.find((l) => l.value === '"name"DESC')
    expect(expected?.kind).toBe("expected")
    expect(actual?.kind).toBe("actual")
  })

  test("11790-shaped: typed-integer maxlength expectation extracted", () => {
    const issueText =
      "Expected: the maxlength attribute should be the typed integer `254`, not the string 254 rendered as text."

    const { literals } = extractIssueExpectations(issueText)

    const literal = literals.find((l) => l.value === "254")
    expect(literal).toBeDefined()
    expect(literal?.kind).toBe("expected")
    expect(literal?.source).toContain("maxlength")
  })

  test("11815-shaped: desired vs current enum serialization extracted with correct kinds", () => {
    const issueText = [
      "Expected serialization is `TextEnum['A']` for the enum field.",
      "Actual serialization returns `TextEnum('a-value')` instead.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    const expected = literals.find((l) => l.value === "TextEnum['A']")
    const actual = literals.find((l) => l.value === "TextEnum('a-value')")
    expect(expected?.kind).toBe("expected")
    expect(actual?.kind).toBe("actual")
  })

  test("noisy issue with no expected/actual markers returns empty", () => {
    const issueText = [
      "This is a really confusing issue with the 'thing' behavior.",
      "I tried several approaches and nothing seems to work as I'd hoped.",
      "Can someone help me figure out what is happening with the 'widget'?",
      "I read through the forums but could not find anything useful there.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals).toEqual([])
  })

  test("caps extraction at 8 literals even with 20 candidates", () => {
    const lines: string[] = []
    for (let i = 1; i <= 20; i++) {
      lines.push(`Expected: candidate value should be \`literal_${i}\` in this test case.`)
    }
    const issueText = lines.join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBe(8)
  })

  test("empty issue text returns empty and never throws", () => {
    expect(extractIssueExpectations("")).toEqual({ literals: [] })
  })
})

describe("detectOracleInversion", () => {
  const literals: IssueExpectation[] = [
    { value: "TextEnum['A']", kind: "expected", source: "serialization should be `TextEnum['A']`" },
    { value: "TextEnum('a-value')", kind: "actual", source: "currently got `TextEnum('a-value')`" },
  ]

  test("11815-shaped inversion: produced side carries the issue-desired value, assertion expects the buggy one", () => {
    const redTail = [
      "FAIL: test_serialize_enum (migrations.test_writer.WriterTests)",
      "Traceback (most recent call last):",
      '  File "tests/migrations/test_writer.py", line 283, in test_serialize_enum',
      "AssertionError: \"migrations.test_writer.TextEnum['A']\" != \"migrations.test_writer.TextEnum('a-value')\"",
    ].join("\n")
    const verdict = detectOracleInversion(redTail, literals)
    expect(verdict.inverted).toBe(true)
    expect(verdict.desiredLiteral).toBe("TextEnum['A']")
    expect(verdict.buggyLiteral).toBe("TextEnum('a-value')")
  })

  test("normal red (gold-aligned test, incomplete fix): buggy value first — NOT inversion", () => {
    const redTail = [
      "AssertionError: \"migrations.test_writer.TextEnum('a-value')\" != \"migrations.test_writer.TextEnum['A']\"",
    ].join("\n")
    expect(detectOracleInversion(redTail, literals).inverted).toBe(false)
  })

  test("unittest long-string diff form: `-` produced line first still detects inversion", () => {
    const redTail = [
      "AssertionError: strings differ:",
      "- migrations.test_writer.TextEnum['A']",
      "+ migrations.test_writer.TextEnum('a-value')",
    ].join("\n")
    expect(detectOracleInversion(redTail, literals).inverted).toBe(true)
  })

  test("crash trace (no comparison failure) never qualifies", () => {
    const redTail = [
      "Traceback (most recent call last):",
      '  File "repro_issue.py", line 4, in <module>',
      "TypeError: __init__() missing 1 required positional argument",
    ].join("\n")
    expect(detectOracleInversion(redTail, literals).inverted).toBe(false)
  })

  test("one side missing from the tail → conservative false", () => {
    const redTail = "AssertionError: \"migrations.test_writer.TextEnum['A']\" != \"something else entirely\""
    expect(detectOracleInversion(redTail, literals).inverted).toBe(false)
  })

  test("no expected/actual literal pair extracted → false; undefined tail → false", () => {
    const onlyExpected: IssueExpectation[] = [literals[0]]
    expect(detectOracleInversion("AssertionError: x != y", onlyExpected).inverted).toBe(false)
    expect(detectOracleInversion(undefined, literals).inverted).toBe(false)
  })
})
