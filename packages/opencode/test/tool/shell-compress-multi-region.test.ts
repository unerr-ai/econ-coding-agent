import { describe, expect, it } from "bun:test"
import { compressMultiRegion } from "../../src/tool/shell-compress/strategies/multi-region"

// ~40 lines of jest-style test output (10 PASS groups + a summary block) sniffable as
// test_results in every sliding window, so it collapses into one confident region.
function jestBlock(groups: number, withSummary: boolean): string[] {
  const lines: string[] = []
  for (let i = 0; i < groups; i++) {
    lines.push(`PASS src/file${i}.test.ts`)
    lines.push(`  ✓ renders component ${i} (2ms)`)
    lines.push(`  ✓ handles edge case ${i} (1ms)`)
    lines.push("")
  }
  if (withSummary) {
    lines.push("Test Suites: 10 passed, 10 total")
    lines.push("Tests:       30 passed, 30 total")
    lines.push("Time:        3.2s")
    lines.push("Ran all test suites.")
  }
  return lines
}

const JEST_40 = jestBlock(9, true) // 36 + 4 summary lines = 40

// ~15 lines of git-status-style output — no OutputCategory sniffs this, so it stays
// an "unknown" region and goes through the omni (line-preserving) fallback.
const GIT_STATUS_15 = [
  "On branch main",
  "Your branch is up to date with 'origin/main'.",
  "",
  "Changes not staged for commit:",
  '  (use "git add <file>..." to update what will be committed)',
  '  (use "git restore <file>..." to discard changes in working directory)',
  "\tmodified:   src/foo.ts",
  "\tmodified:   src/bar.ts",
  "\tmodified:   src/baz.ts",
  "",
  "Untracked files:",
  '  (use "git add <file>..." to include in what will be committed)',
  "\tnew-file.txt",
  "",
  'no changes added to commit (use "git add" and/or "git commit -a")',
]

const COMPOSITE_COMMAND = "npx jest && echo DONE-MARKER && git status"
const COMPOSITE_OUTPUT = [...JEST_40, "DONE-MARKER", ...GIT_STATUS_15].join("\n")

// A small diff block — scores "diff" confidently (0.9), the strongest single signal in the
// classifier, so it dominates any window it touches.
const DIFF_BLOCK = [
  "diff --git a/x.ts b/x.ts",
  "index abc123..def456 100644",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,3 @@",
  "-const a = 1",
  "+const a = 2",
  " const b = 2",
  " const c = 3",
  " const d = 4",
]

function extractHeaders(text: string): Array<{ start: number; end: number; category: string }> {
  return [...text.matchAll(/── lines (\d+)–(\d+) · (\S+) ──/g)].map((m) => ({
    start: Number(m[1]),
    end: Number(m[2]),
    category: m[3]!,
  }))
}

describe("compressMultiRegion — composite command with a jest + git-status split", () => {
  it("produces >= 2 region headers with correct 1-based line ranges", () => {
    const result = compressMultiRegion(COMPOSITE_OUTPUT, COMPOSITE_COMMAND, 0)
    expect(result).not.toBeNull()
    const headers = extractHeaders(result!)
    expect(headers.length).toBeGreaterThanOrEqual(2)
    expect(headers[0]).toEqual({ start: 1, end: 40, category: "test_results" })
  })

  it("compresses the jest region via test_results (contains pass/fail counts)", () => {
    const result = compressMultiRegion(COMPOSITE_OUTPUT, COMPOSITE_COMMAND, 0)
    expect(result).toMatch(/\d+ passed/)
  })

  it("keeps the git region present and preserves DONE-MARKER", () => {
    const result = compressMultiRegion(COMPOSITE_OUTPUT, COMPOSITE_COMMAND, 0)
    expect(result).toContain("DONE-MARKER")
    expect(result).toMatch(/On branch main|Untracked files|modified:/)
  })
})

describe("compressMultiRegion — homogeneous output", () => {
  it("returns null when the whole output sniffs as a single category", () => {
    const homogeneous = jestBlock(10, false).join("\n") // 40 lines, all test_results, no split
    const result = compressMultiRegion(homogeneous, "npx jest", 0)
    expect(result).toBeNull()
  })
})

describe("compressMultiRegion — region line-range arithmetic", () => {
  it("headers are contiguous, start at 1, and end at the last line with no gaps or overlaps", () => {
    const result = compressMultiRegion(COMPOSITE_OUTPUT, COMPOSITE_COMMAND, 0)
    expect(result).not.toBeNull()
    const headers = extractHeaders(result!)
    const totalLines = COMPOSITE_OUTPUT.split("\n").length

    expect(headers[0]!.start).toBe(1)
    expect(headers[headers.length - 1]!.end).toBe(totalLines)
    for (let i = 1; i < headers.length; i++) {
      expect(headers[i]!.start).toBe(headers[i - 1]!.end + 1)
    }
  })
})

describe("compressMultiRegion — never-inflate", () => {
  it("returns null on short mixed output where the split isn't worth the header overhead", () => {
    // 12 lines of jest (no summary line) + a 10-line diff block: two genuinely distinct,
    // confidently-sniffed regions, but at this size the region headers cost more than the
    // per-region strategies save — never-inflate must veto the split.
    const shortMixed = [...jestBlock(3, false), ...DIFF_BLOCK].join("\n")
    const result = compressMultiRegion(shortMixed, "npx jest && git diff", 0)
    expect(result).toBeNull()
  })
})
