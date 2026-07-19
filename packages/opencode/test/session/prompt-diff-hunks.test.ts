/**
 * Tests for truncateDiffHunks / DIFF_HUNK_MAX_LINES
 * (packages/opencode/src/session/prompt.ts): H3 (gap-closure §2, #26)'s cap
 * on the unified diff text handed to a judge prompt (hub-design,
 * repro-fidelity) — the pure truncation logic `readTurnDiffHunks` (the
 * `git diff` DI-seam wrapper) delegates to, isolated here from the shell-out.
 */
import { describe, it, expect } from "bun:test"
import { truncateDiffHunks, DIFF_HUNK_MAX_LINES } from "../../src/session/prompt"

describe("truncateDiffHunks — H3 (gap-closure §2, #26)", () => {
  it("an empty diff stays empty", () => {
    expect(truncateDiffHunks("")).toBe("")
  })

  it("a diff at or under the cap passes through unchanged", () => {
    const diff = Array.from({ length: DIFF_HUNK_MAX_LINES }, (_, i) => `+line ${i}`).join("\n")
    expect(truncateDiffHunks(diff)).toBe(diff)
  })

  it("a diff over the cap is cut to DIFF_HUNK_MAX_LINES lines plus a truncation marker naming the dropped count", () => {
    const totalLines = DIFF_HUNK_MAX_LINES + 37
    const diff = Array.from({ length: totalLines }, (_, i) => `+line ${i}`).join("\n")
    const truncated = truncateDiffHunks(diff)
    const truncatedLines = truncated.split("\n")
    // DIFF_HUNK_MAX_LINES original lines plus the one marker line.
    expect(truncatedLines).toHaveLength(DIFF_HUNK_MAX_LINES + 1)
    expect(truncatedLines[DIFF_HUNK_MAX_LINES - 1]).toBe(`+line ${DIFF_HUNK_MAX_LINES - 1}`)
    expect(truncated).toContain("truncated")
    expect(truncated).toContain("+37 more lines")
    expect(truncated).not.toContain(`+line ${totalLines - 1}`)
  })

  it("exactly one line over the cap still truncates (boundary)", () => {
    const diff = Array.from({ length: DIFF_HUNK_MAX_LINES + 1 }, (_, i) => `+line ${i}`).join("\n")
    const truncated = truncateDiffHunks(diff)
    expect(truncated).toContain("+1 more lines")
  })
})
