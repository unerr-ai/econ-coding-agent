import { describe, expect, it } from "bun:test"
import { compressTestResults } from "../../src/tool/shell-compress/strategies/test-results"

// Jest fixture: `Tests: 4 failed, 30 passed, 34 total` summary line present, but no ● failure
// blocks (the incident shape — blocks evicted by a tail ring-buffer, only the trailing summary
// survives).
const JEST_FAILED_NO_BLOCKS = [
  "PASS src/foo.test.ts",
  "PASS src/bar.test.ts",
  "",
  "Test Suites: 2 passed, 2 total",
  "Tests:       4 failed, 30 passed, 34 total",
  "Time:        3.2s",
  "Ran all test suites.",
].join("\n")

const JEST_ALL_PASS_NO_BLOCKS = [
  "PASS src/foo.test.ts",
  "PASS src/bar.test.ts",
  "",
  "Test Suites: 2 passed, 2 total",
  "Tests:       30 passed, 30 total",
  "Ran all test suites.",
].join("\n")

const VITEST_FAILED_NO_BLOCKS = [
  "✓ src/foo.test.ts (12ms)",
  "✓ src/bar.test.ts (8ms)",
  "",
  "Test Files  2 passed (2)",
  "Tests  4 failed | 30 passed (34)",
  "Duration  1.20s",
].join("\n")

describe("compressTestResults — failed count must survive a masked exit code / evicted blocks", () => {
  it("jest: summary says failed but no ● blocks, exitCode 0 — must not silently drop the failure", () => {
    const result = compressTestResults(JEST_FAILED_NO_BLOCKS, "npx jest", 0)
    expect(result).toContain("4 failed")
    expect(result).toContain("Tests:       4 failed, 30 passed, 34 total")
  })

  it("jest: same fixture, exitCode 1 — still contains the failure", () => {
    const result = compressTestResults(JEST_FAILED_NO_BLOCKS, "npx jest", 1)
    expect(result).toContain("4 failed")
  })

  it("jest: piped command (`| tail -50`) with all-pass output, exitCode 0 — exit code is untrusted so the one-liner is skipped, but emitCompressed still reports the correct pass count", () => {
    const piped = compressTestResults(JEST_ALL_PASS_NO_BLOCKS, "npx jest 2>&1 | tail -50", 0)
    const trusted = compressTestResults(JEST_ALL_PASS_NO_BLOCKS, "npx jest", 0)
    expect(piped).toContain("30 passed")
    expect(piped).not.toContain("failed")
    // Falling through to emitCompressed for the untrusted (piped) command must not change the
    // correct outcome versus the trusted one-liner path when there is in fact nothing hidden.
    expect(piped).toBe(trusted)
  })

  it("jest: clean single-segment command, all pass, exitCode 0, no ● blocks — one-liner path still works (regression guard)", () => {
    const result = compressTestResults(JEST_ALL_PASS_NO_BLOCKS, "npx jest", 0)
    expect(result).toBe("jest: 30 passed")
  })

  it("vitest: summary says failed but no ● blocks, exitCode 0 — must not silently drop the failure", () => {
    const result = compressTestResults(VITEST_FAILED_NO_BLOCKS, "npx vitest run", 0)
    expect(result).toContain("4 failed")
    expect(result).toContain("Tests  4 failed | 30 passed (34)")
  })
})

// Live jest repro (benchmark run 14): a test file with no it()/describe blocks. Jest exits 1
// printing "Test suite failed to run" — 0 parsed tests + no "N failed" count looks identical to
// an empty passing run, which previously rendered as a bare `jest: 0 tests (...)` and silently
// dropped the actual reason.
const JEST_NO_TESTS_FOUND = [
  "FAIL test/plugin/repro_3123.test.js",
  "  ● Test suite failed to run",
  "",
  "    Your test suite must contain at least one test.",
  "",
  "      at onResult (node_modules/@jest/core/build/index.js:1054:18)",
  "",
  "Test Suites: 1 failed, 1 total",
  "Tests:       0 total",
  "Snapshots:   0 total",
  "Time:        0.61 s",
  "Ran all test suites matching /test\\/plugin\\/repro_3123.test.js/i.",
].join("\n")

describe("compressTestResults — jest suite failed to run (0 tests found)", () => {
  it("unpiped, exitCode 1 — failure marker + verbatim reason survive, never a bare '0 tests'", () => {
    const result = compressTestResults(
      JEST_NO_TESTS_FOUND,
      "npx jest --no-coverage test/plugin/repro_3123.test.js",
      1,
    )
    expect(result).toContain("must contain at least one test")
    expect(result).toContain("suite failed to run")
    expect(result).not.toBe("jest: 0 tests (Time:        0.61 s)")
  })

  it("piped (`| tail -20`) — tail's own exit code (0) must not mask the failure", () => {
    const result = compressTestResults(
      JEST_NO_TESTS_FOUND,
      "npx jest --no-coverage test/plugin/repro_3123.test.js 2>&1 | tail -20",
      0,
    )
    expect(result).toContain("must contain at least one test")
    expect(result).toContain("suite failed to run")
  })

  it("exact rendering matches the decided format", () => {
    const result = compressTestResults(JEST_NO_TESTS_FOUND, "npx jest", 1)
    expect(result).toBe(
      "jest: suite failed to run — Your test suite must contain at least one test. (0 tests)",
    )
  })

  it("a normal passing run's one-liner is unchanged", () => {
    const result = compressTestResults(JEST_ALL_PASS_NO_BLOCKS, "npx jest", 0)
    expect(result).toBe("jest: 30 passed")
  })
})

// Bun fixtures below are regenerated from a live `bun test` run (bun test v1.3.14), stdout +
// "\n" + stderr merged the way compressShellOutput merges them for a command that isn't in
// MERGE_STDERR_RE (bun test's diagnostics land entirely on stderr, stdout only carries the
// version banner + any console.log lines from the tests themselves).
const BUN_PASS_STDOUT_LINES = [
  "bun test v1.3.14 (0d9b296a)",
  ...Array.from({ length: 60 }, (_, i) => `processing case number ${i + 1} of the suite`),
]
const BUN_PASS_STDERR_LINES = [
  "",
  "pass.test.ts:",
  "",
  " 60 pass",
  " 0 fail",
  " 60 expect() calls",
  "Ran 60 tests across 1 file. [86.00ms]",
]
const BUN_ALL_PASS = `${BUN_PASS_STDOUT_LINES.join("\n")}\n${BUN_PASS_STDERR_LINES.join("\n")}`

const BUN_FAIL_STDOUT = "bun test v1.3.14 (0d9b296a)"
const BUN_FAIL_STDERR_LINES = [
  "",
  "fail.test.ts:",
  '16 |   it("should pass test 4", () => {',
  "17 |     expect(true).toBe(true);",
  "18 |   });",
  "19 | ",
  '20 |   it("should fail test 1", () => {',
  "21 |     expect(1 + 1).toBe(3);",
  "                       ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 3",
  "Received: 2",
  "",
  "      at <anonymous> (/econ-live-test/fail.test.ts:21:19)",
  "(fail) fail > should fail test 1 [2.00ms]",
  '20 |   it("should fail test 1", () => {',
  "21 |     expect(1 + 1).toBe(3);",
  "22 |   });",
  "23 | ",
  '24 |   it("should fail test 2", () => {',
  '25 |     expect("broken".includes("missing")).toBe(true);',
  "                                              ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: true",
  "Received: false",
  "",
  "      at <anonymous> (/econ-live-test/fail.test.ts:25:42)",
  "(fail) fail > should fail test 2 [0.25ms]",
  "",
  " 4 pass",
  " 2 fail",
  " 6 expect() calls",
  "Ran 6 tests across 1 file. [10.00ms]",
]
const BUN_WITH_FAILURES = `${BUN_FAIL_STDOUT}\n${BUN_FAIL_STDERR_LINES.join("\n")}`

describe("compressTestResults — bun test (bun_test framework)", () => {
  it("all-pass: one-liner, no console.log noise survives", () => {
    const result = compressTestResults(BUN_ALL_PASS, "bun test pass.test.ts", 0)
    expect(result).toBe("bun_test: 60 passed (86.00ms)")
    expect(result).not.toContain("processing case number")

    const ratio = result.length / BUN_ALL_PASS.length
    expect(ratio).toBeLessThan(0.5)
  })

  it("with failures: both failure blocks preserved, summary present, passing noise dropped", () => {
    const result = compressTestResults(BUN_WITH_FAILURES, "bun test fail.test.ts", 1)

    expect(result).toContain("bun_test: 4 passed, 2 failed")
    expect(result).toContain("(fail) fail > should fail test 1 [2.00ms]")
    expect(result).toContain("(fail) fail > should fail test 2 [0.25ms]")
    expect(result).toContain("Expected: 3")
    expect(result).toContain("Received: 2")
    expect(result).toContain("Expected: true")
    expect(result).toContain("Received: false")
    expect(result).toContain(" 4 pass")
    expect(result).toContain(" 2 fail")
    expect(result).toContain("Ran 6 tests across 1 file. [10.00ms]")
  })

  it("detection: command 'bun test x.test.ts' selects the bun_test framework", () => {
    const result = compressTestResults(BUN_ALL_PASS, "bun test x.test.ts", 0)
    expect(result).toStartWith("bun_test:")
  })

  it("detection: no command, bun content alone selects the bun_test framework", () => {
    const result = compressTestResults(BUN_ALL_PASS, undefined, 0)
    expect(result).toStartWith("bun_test:")
  })
})
