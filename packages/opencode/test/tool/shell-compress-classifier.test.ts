import { describe, expect, it } from "bun:test"
import { classifyShellOutput, countNonSilentSegments } from "../../src/tool/shell-compress/classifier"
import { compressShellOutput } from "../../src/tool/shell-compress/index"

// Real incident shape: a composite command whose middle/trailing segments (echo marker,
// git status) got swallowed because matchCommandHint picked ONE category (last non-silent
// segment wins) and that category's strategy kept only what it recognized, dropping the rest.
const COMPOSITE_COMMAND = "bun test x.test.ts && echo DONE-MARKER && git status"
const COMPOSITE_OUTPUT = [
  "bun test v1.0.21 (9c1226b1)",
  "",
  "x.test.ts:",
  "✓ passes a basic check [1.00ms]",
  "",
  " 1 pass",
  " 0 fail",
  " 1 expect() calls",
  "Ran 1 tests across 1 files. [50.00ms]",
  "DONE-MARKER",
  "On branch main",
  "Your branch is up to date with 'origin/main'.",
  "",
  "nothing to commit, working tree clean",
].join("\n")

const JEST_ALL_PASS_NO_BLOCKS = [
  "PASS src/foo.test.ts",
  "PASS src/bar.test.ts",
  "",
  "Test Suites: 2 passed, 2 total",
  "Tests:       30 passed, 30 total",
  "Ran all test suites.",
].join("\n")

describe("compressShellOutput — composite command classification", () => {
  it("counts every non-silent segment of the composite command (bug repro)", () => {
    expect(countNonSilentSegments(COMPOSITE_COMMAND)).toBe(3)
    expect(classifyShellOutput(COMPOSITE_COMMAND, COMPOSITE_OUTPUT).non_silent_segments).toBe(3)
  })

  it("preserves the echo marker and the git status lines instead of collapsing to one category", () => {
    const result = compressShellOutput(COMPOSITE_COMMAND, COMPOSITE_OUTPUT)

    expect(result.text).toContain("DONE-MARKER")
    expect(result.text).toMatch(/On branch main|nothing to commit/)
  })
})

describe("compressShellOutput — single-segment regression guard", () => {
  it("still hits the dedicated git-status fast path for a git-status-prefixed command", () => {
    const command = "git status"
    const output = [
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      "\tmodified:   src/foo.ts",
      "",
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join("\n")

    const result = compressShellOutput(command, output)

    expect(result.text).toContain("branch=main")
    expect(result.text).toContain("modified: 1")
  })

  it("still classifies and compresses a single-segment `ls -la` via the tabular strategy", () => {
    const command = "ls -la"
    const output = [
      "total 24",
      "drwxr-xr-x  5  user  staff  160  file1",
      "-rw-r--r--  1  user  staff  220  file2",
      "-rw-r--r--  1  user  staff  350  file3",
    ].join("\n")

    const classification = classifyShellOutput(command, output)
    expect(classification.non_silent_segments).toBe(1)
    expect(classification.category).toBe("tabular")

    const result = compressShellOutput(command, output)
    expect(result.text.split("\n")[0]).toBe("c0|c1|c2|c3|c4|c5")
  })
})

describe("compressShellOutput — silent segments in a composite command", () => {
  // Decided semantics: a silent segment (mkdir, chmod, cd, git add, ...) does not count toward
  // the composite-guard threshold, because it never contributes any output to interleave with
  // the real command's — so `mkdir -p x && npx jest` is still a single *effective* segment and
  // gets the jest test_results strategy, not the composite dedup-only fallback.
  it("does not count the silent `mkdir` segment, so the composite guard does not fire", () => {
    const command = "mkdir -p x && npx jest"
    expect(countNonSilentSegments(command)).toBe(1)

    const classification = classifyShellOutput(command, JEST_ALL_PASS_NO_BLOCKS)
    expect(classification.non_silent_segments).toBe(1)
    expect(classification.category).toBe("test_results")
  })

  it("routes `mkdir -p x && npx jest` through the jest strategy, not the omni passthrough", () => {
    const command = "mkdir -p x && npx jest"
    const result = compressShellOutput(command, JEST_ALL_PASS_NO_BLOCKS, undefined, 0)

    // If mkdir were (wrongly) counted as non-silent, non_silent_segments would be 2 and this
    // short (<80 line) output would come back unchanged via the omni passthrough instead.
    expect(result.text).toBe("jest: 30 passed")
  })
})
