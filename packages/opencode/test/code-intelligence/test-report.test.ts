/**
 * Tests for test-report.ts (packages/opencode/src/code-intelligence/test-report.ts):
 * the P1 L3 observation-layer format parsers (docs/design/agnostic-hands-eyes.md
 * §2.2). Realistic fixture strings per format, including a JUnit report
 * carrying failures (the structural laundered-red case — the parser reads
 * the report content alone, independent of any accompanying exit code), a
 * skip-shaped fixture per format, and an empty suite.
 */
import { describe, it, expect } from "bun:test"
import {
  parseJUnitXml,
  parseGoTestJson,
  parseJestJson,
  parseTap,
  detectAndParseTestReport,
} from "../../src/code-intelligence/test-report"

describe("parseJUnitXml", () => {
  it("reads a clean passing suite", () => {
    const xml = `<testsuite name="pytest" tests="2" failures="0" errors="0" skipped="0">
      <testcase classname="tests.test_math" name="test_add" time="0.01"/>
      <testcase classname="tests.test_math" name="test_sub" time="0.01"/>
    </testsuite>`
    const report = parseJUnitXml(xml)
    expect(report).toBeDefined()
    expect(report!.format).toBe("junitxml")
    expect(report!.totals).toEqual({ pass: 2, fail: 0, error: 0, skip: 0, total: 2 })
    expect(report!.entries[0]).toEqual({ id: "tests.test_math.test_add", name: "test_add", classname: "tests.test_math", status: "pass" })
  })

  it("a JUnit report carrying failures reads red structurally, independent of any accompanying exit code (the laundered-red case)", () => {
    const xml = `<testsuite name="pytest" tests="3" failures="1" errors="1" skipped="0">
      <testcase classname="tests.test_math" name="test_add" time="0.01"/>
      <testcase classname="tests.test_math" name="test_sub" time="0.02">
        <failure message="AssertionError: assert 1 == 2">Traceback (most recent call last):\n  ...</failure>
      </testcase>
      <testcase classname="tests.test_math" name="test_div" time="0.01">
        <error message="ZeroDivisionError: division by zero">Traceback ...</error>
      </testcase>
    </testsuite>`
    const report = parseJUnitXml(xml)!
    expect(report.totals.fail).toBe(1)
    expect(report.totals.error).toBe(1)
    expect(report.totals.pass).toBe(1)
    const failing = report.entries.find((e) => e.name === "test_sub")!
    expect(failing.status).toBe("fail")
    expect(failing.message).toContain("AssertionError")
    const erroring = report.entries.find((e) => e.name === "test_div")!
    expect(erroring.status).toBe("error")
  })

  it("reads a skipped testcase", () => {
    const xml = `<testsuite tests="1" skipped="1">
      <testcase classname="tests.test_slow" name="test_needs_gpu">
        <skipped message="no GPU available"/>
      </testcase>
    </testsuite>`
    const report = parseJUnitXml(xml)!
    expect(report.totals.skip).toBe(1)
    expect(report.entries[0]!.status).toBe("skip")
    expect(report.entries[0]!.message).toBe("no GPU available")
  })

  it("an empty suite (0 testcases) is a valid report, not a miss", () => {
    const xml = `<testsuite name="pytest" tests="0" failures="0" errors="0" skipped="0"></testsuite>`
    const report = parseJUnitXml(xml)
    expect(report).toBeDefined()
    expect(report!.entries).toEqual([])
    expect(report!.totals).toEqual({ pass: 0, fail: 0, error: 0, skip: 0, total: 0 })
  })

  it("handles a <testsuites> wrapper around multiple <testsuite> elements", () => {
    const xml = `<testsuites>
      <testsuite name="a"><testcase classname="a" name="one"/></testsuite>
      <testsuite name="b"><testcase classname="b" name="two"><failure message="boom"/></testcase></testsuite>
    </testsuites>`
    const report = parseJUnitXml(xml)!
    expect(report.entries).toHaveLength(2)
    expect(report.totals).toEqual({ pass: 1, fail: 1, error: 0, skip: 0, total: 2 })
  })

  it("returns undefined for non-XML content", () => {
    expect(parseJUnitXml("5 passed, 1 failed in 0.12s")).toBeUndefined()
  })
})

describe("parseGoTestJson", () => {
  const PASS_STREAM = [
    '{"Time":"2026-07-20T00:00:00Z","Action":"run","Package":"example.com/demo","Test":"TestAdd"}',
    '{"Time":"2026-07-20T00:00:01Z","Action":"output","Package":"example.com/demo","Test":"TestAdd","Output":"=== RUN   TestAdd\\n"}',
    '{"Time":"2026-07-20T00:00:01Z","Action":"pass","Package":"example.com/demo","Test":"TestAdd","Elapsed":0.01}',
  ].join("\n")

  it("reads a passing test event stream", () => {
    const report = parseGoTestJson(PASS_STREAM)!
    expect(report.format).toBe("go-test-json")
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({ id: "example.com/demo.TestAdd", name: "TestAdd", status: "pass" })
  })

  it("reads a failing test, carrying the accumulated output tail as the message", () => {
    const stream = [
      '{"Action":"run","Package":"example.com/demo","Test":"TestSub"}',
      '{"Action":"output","Package":"example.com/demo","Test":"TestSub","Output":"--- FAIL: TestSub (0.00s)\\n"}',
      '{"Action":"output","Package":"example.com/demo","Test":"TestSub","Output":"    sub_test.go:10: expected 1 got 2\\n"}',
      '{"Action":"fail","Package":"example.com/demo","Test":"TestSub","Elapsed":0.00}',
    ].join("\n")
    const report = parseGoTestJson(stream)!
    expect(report.totals.fail).toBe(1)
    expect(report.entries[0]!.status).toBe("fail")
    expect(report.entries[0]!.message).toContain("expected 1 got 2")
  })

  it("reads a skip action", () => {
    const stream = [
      '{"Action":"run","Package":"example.com/demo","Test":"TestSkipped"}',
      '{"Action":"skip","Package":"example.com/demo","Test":"TestSkipped"}',
    ].join("\n")
    const report = parseGoTestJson(stream)!
    expect(report.totals.skip).toBe(1)
  })

  it("returns undefined for content with no test-scoped event", () => {
    expect(parseGoTestJson("ok  \texample.com/demo\t0.012s")).toBeUndefined()
  })

  it("returns undefined for empty content", () => {
    expect(parseGoTestJson("")).toBeUndefined()
  })
})

describe("parseJestJson", () => {
  const MIXED = JSON.stringify({
    numTotalTests: 3,
    testResults: [
      {
        name: "/repo/src/math.test.ts",
        assertionResults: [
          { fullName: "math adds numbers", title: "adds numbers", status: "passed", failureMessages: [] },
          { fullName: "math subtracts numbers", title: "subtracts numbers", status: "failed", failureMessages: ["Error: expected 2 got 3"] },
          { fullName: "math is pending", title: "is pending", status: "pending", failureMessages: [] },
        ],
      },
    ],
  })

  it("reads passed/failed/pending assertions (shared jest/vitest shape)", () => {
    const report = parseJestJson(MIXED)!
    expect(report.format).toBe("jest-json")
    expect(report.totals).toEqual({ pass: 1, fail: 1, error: 0, skip: 1, total: 3 })
    const failing = report.entries.find((e) => e.name === "math subtracts numbers")!
    expect(failing.status).toBe("fail")
    expect(failing.file).toBe("/repo/src/math.test.ts")
    expect(failing.message).toContain("expected 2 got 3")
  })

  it("returns undefined for malformed JSON", () => {
    expect(parseJestJson("{not json")).toBeUndefined()
  })

  it("returns undefined when testResults is missing", () => {
    expect(parseJestJson(JSON.stringify({ numTotalTests: 0 }))).toBeUndefined()
  })
})

describe("parseTap", () => {
  it("reads ok/not ok result lines with a plan", () => {
    const tap = ["TAP version 13", "1..3", "ok 1 - adds numbers", "not ok 2 - subtracts numbers", "ok 3 - multiplies numbers"].join("\n")
    const report = parseTap(tap)!
    expect(report.format).toBe("tap")
    expect(report.totals).toEqual({ pass: 2, fail: 1, error: 0, skip: 0, total: 3 })
  })

  it("reads a # SKIP directive on an otherwise-ok line", () => {
    const tap = ["1..2", "ok 1 - runs fine", "ok 2 - needs network # SKIP no network in CI"].join("\n")
    const report = parseTap(tap)!
    const skipped = report.entries.find((e) => e.name === "needs network")!
    expect(skipped.status).toBe("skip")
  })

  it("returns undefined when there is neither a plan nor a result line", () => {
    expect(parseTap("hello world\nnothing tap-shaped here")).toBeUndefined()
  })
})

describe("detectAndParseTestReport", () => {
  it("dispatches JUnit XML content to parseJUnitXml", () => {
    const report = detectAndParseTestReport('<testsuite tests="1"><testcase classname="a" name="one"/></testsuite>')
    expect(report?.format).toBe("junitxml")
  })

  it("dispatches a go test -json stream to parseGoTestJson", () => {
    const report = detectAndParseTestReport(
      '{"Action":"run","Package":"p","Test":"T"}\n{"Action":"pass","Package":"p","Test":"T"}',
    )
    expect(report?.format).toBe("go-test-json")
  })

  it("dispatches a bare jest JSON object to parseJestJson", () => {
    const report = detectAndParseTestReport(
      JSON.stringify({ testResults: [{ name: "f.test.ts", assertionResults: [{ title: "x", status: "passed" }] }] }),
    )
    expect(report?.format).toBe("jest-json")
  })

  it("dispatches TAP content to parseTap", () => {
    const report = detectAndParseTestReport("1..1\nok 1 - a lonely tap line")
    expect(report?.format).toBe("tap")
  })

  it("a JUnit report with failures is read as red structurally regardless of exit code — the laundered-red case detectAndParseTestReport exists to serve", () => {
    const report = detectAndParseTestReport(
      '<testsuite tests="1" failures="1"><testcase classname="t" name="bad"><failure message="boom"/></testcase></testsuite>',
    )!
    expect(report.totals.fail).toBe(1)
  })

  it("returns undefined for plain unstructured text", () => {
    expect(detectAndParseTestReport("hello world, nothing structured here")).toBeUndefined()
  })

  it("returns undefined for empty content", () => {
    expect(detectAndParseTestReport("")).toBeUndefined()
  })
})
