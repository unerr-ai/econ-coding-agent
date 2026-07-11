import { describe, expect, test } from "bun:test"
import { applyResultCeiling, RESULT_TOKEN_CEILING } from "@/session/tools"
import { Token } from "@/util/token"

// L2.4 unified per-result ceiling (docs/design/turn-cache-economics.md §5-L2 item 4):
// every individual tool result is capped at RESULT_TOKEN_CEILING before it is
// persisted, at the same wrapper sites the (now-deleted) inline aggregate step
// budget used to cover — that duplicate 20k cap is gone; step-budget.ts's
// water-filling pass is the sole aggregate guard today.

// ~280k chars ≈ 70k estimated tokens — the single-blob case the ceiling exists for.
function blob70k() {
  return Array.from({ length: 2800 }, (_, i) => `line ${i} ${"x".repeat(90)}`).join("\n")
}

function numberedLines(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n")
}

describe("applyResultCeiling", () => {
  test("ceiling constant is 6k estimated tokens", () => {
    expect(RESULT_TOKEN_CEILING).toBe(6_000)
  })

  test("under the ceiling: output passes through untouched", () => {
    const output = numberedLines("small", 200)
    expect(applyResultCeiling({ toolID: "grep", output })).toBe(output)
  })

  test("over the ceiling: truncated near 6k tokens with a self-describing narrow marker", () => {
    const result = applyResultCeiling({ toolID: "bash", output: blob70k() })

    // Bounded: kept text ≈ ceiling, plus the one marker line.
    expect(Token.estimate(result)).toBeLessThanOrEqual(RESULT_TOKEN_CEILING + 100)
    expect(Token.estimate(result)).toBeGreaterThan(RESULT_TOKEN_CEILING - 100)

    const lines = result.split("\n")
    const marker = lines.at(-1)!
    expect(marker).toContain("[result ceiling:")
    expect(marker).toContain("~70k-token output truncated to ~6k")
    expect(marker).toContain("do not treat it as complete")
    expect(marker).toContain("narrow the call")

    // The cut lands on a line boundary — the last kept line is a whole original line.
    expect(lines.at(-2)).toMatch(/^line \d+ x{90}$/)
  })

  test("exempt tools are never ceiling-cut, even on huge outputs", () => {
    for (const toolID of ["edit", "write", "skill", "todowrite", "todoread"]) {
      const output = blob70k()
      expect(applyResultCeiling({ toolID, output })).toBe(output)
    }
  })
})
