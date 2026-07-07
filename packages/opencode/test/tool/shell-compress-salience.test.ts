import { describe, expect, it } from "bun:test"
import { compressOmni } from "../../src/tool/shell-compress/strategies/omni"
import { compressProgress } from "../../src/tool/shell-compress/strategies/progress"
import { compressTabular } from "../../src/tool/shell-compress/strategies/tabular"
import { compressTestResults } from "../../src/tool/shell-compress/strategies/test-results"
import { compressTreePaths } from "../../src/tool/shell-compress/strategies/tree-paths"

describe("salience guard — progress.ts keeps an interleaved failure line", () => {
  it("survives an ERROR line buried well before the kept tail", () => {
    const fixture = [
      ...Array.from({ length: 10 }, (_, i) => `fetching package-${i}...`),
      "ERROR: disk full",
      ...Array.from({ length: 25 }, (_, i) => `fetching package-${i + 10}...`),
    ].join("\n")

    const result = compressProgress(fixture)

    expect(result).toContain("ERROR: disk full")
    // Confirms the fixture actually exercised the lossy head/tail path, not a passthrough.
    expect(result).toContain("progress line(s) omitted")
  })
})

describe("salience guard — tabular.ts keeps a non-tabular failure row", () => {
  it("keeps a FAILED row that doesn't parse into >=2 whitespace-aligned cells", () => {
    const rows = Array.from({ length: 49 }, (_, i) => `row${i}  value${i}`)
    const fixture = [...rows, "3 tests FAILED"].join("\n")

    const result = compressTabular(fixture)

    expect(result).toContain("FAILED")
  })
})

describe("salience guard — tree-paths.ts keeps a permission-denied entry", () => {
  it("survives a `find`-style Permission denied line among many rolled-up paths", () => {
    const fixture = [
      ...Array.from({ length: 44 }, (_, i) => `src/pkg/file${i}.ts`),
      "find: 'src/pkg/secret.ts': Permission denied",
    ].join("\n")

    const result = compressTreePaths(fixture)

    expect(result).toContain("Permission denied")
  })
})

describe("salience guard — omni.ts never merges distinct salient lines", () => {
  it("dedupes an identical error with a count marker but keeps a different one separate", () => {
    const fixture = [
      ...Array.from({ length: 90 }, (_, i) => `processing item ${i}`),
      "ERROR: disk full",
      "ERROR: disk full",
      // Not caught by omni's local ERROR_RE (no ERROR/FATAL/CRIT/PANIC/Exception/
      // Traceback/FAIL/WARN token) — only surfaces via the isSalientLine integration.
      "AssertionError: expected 5 got 3",
    ].join("\n")

    const result = compressOmni(fixture)

    expect(result).toContain("ERROR: disk full  [×2]")
    expect(result).toContain("AssertionError: expected 5 got 3")
    expect(result).not.toContain("ERROR: disk full  [×3]")
  })
})

describe("salience guard — test-results.ts compressFallback", () => {
  // Regression: compressFallback used to run its own local isFailLine regex;
  // it now defers to the shared isSalientLine and must keep the same lines.
  it("still keeps FAIL/AssertionError lines through the generic fallback path", () => {
    const fixture = [
      "check-1 passing",
      "check-2 passing",
      "check-3 passing",
      "check-4 passing",
      "check-5 passing",
      "check-6 FAIL",
      "AssertionError: expected 5 got 3",
    ].join("\n")

    const result = compressTestResults(fixture, "run-custom-tests")

    expect(result).toContain("check-6 FAIL")
    expect(result).toContain("AssertionError: expected 5 got 3")
    // Confirms the passing streak still collapses — salience didn't disable compression.
    expect(result).toContain("passing lines collapsed")
  })

  it("keeps an assertion line even when a failure block truncates past 20 lines", () => {
    const fixture = [
      "PASS src/other.test.ts",
      "● big test > overflows the truncation limit",
      ...Array.from({ length: 22 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`),
      "    AssertionError: expected 5 to equal 3",
      ...Array.from({ length: 3 }, (_, i) => `    at frame${i + 22} (file.ts:${i + 22}:1)`),
      "",
      "Tests:       1 failed, 0 passed, 1 total",
    ].join("\n")

    const result = compressTestResults(fixture, "npx jest")

    expect(result).toContain("AssertionError: expected 5 to equal 3")
    expect(result).toContain("more lines")
  })
})

describe("salience guard — never disables compression wholesale", () => {
  it("still heavily compresses an all-noise fixture with no salient lines", () => {
    const fixture = Array.from({ length: 150 }, (_, i) => `heartbeat tick ${i}`).join("\n")

    const result = compressOmni(fixture)

    expect(result.length).toBeLessThan(fixture.length * 0.3)
    expect(result).toContain("[×150]")
  })
})
