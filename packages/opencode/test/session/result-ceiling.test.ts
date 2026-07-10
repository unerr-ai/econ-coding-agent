import { describe, expect, test } from "bun:test"
import { applyResultCeiling, applyStepResultBudget, RESULT_TOKEN_CEILING, STEP_RESULT_BUDGET } from "@/session/tools"
import { Token } from "@/util/token"

// L2.4 unified per-result ceiling (docs/design/turn-cache-economics.md §5-L2 item 4):
// every individual tool result is capped at RESULT_TOKEN_CEILING BEFORE the L1.3
// aggregate step ledger accounts for it, so one huge blob enters the step at ≤6k
// tokens instead of instantly breaching the 20k aggregate. Exercised at the same pure
// layer as step-result-budget.test.ts; `wrap` reproduces withStepBudget's compose
// order in session/tools.ts — ceiling first, aggregate second.

let seq = 0
function freshStep() {
  seq += 1
  return { sessionID: `ses_ceiling_${seq}`, messageID: `msg_ceiling_${seq}` }
}

function wrap(step: { sessionID: string; messageID: string }, toolID: string, output: string) {
  return applyStepResultBudget({ ...step, toolID, output: applyResultCeiling({ toolID, output }) })
}

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

describe("ceiling composes with the L1.3 aggregate step budget", () => {
  test("ceiling applies first: a 70k blob enters the step ledger at ~6k, so the next call is untouched", () => {
    const step = freshStep()
    const first = wrap(step, "bash", blob70k())
    expect(first).toContain("[result ceiling:")

    // Had the raw 70k been ledgered, this call would be post-breach and cut to 40
    // lines; the ceiling ran first, so the ledger sits at ~6k and it passes whole.
    const next = numberedLines("next", 100)
    expect(wrap(step, "grep", next)).toBe(next)
  })

  test("the aggregate still applies after: stacked ceiled results breach 20k, and markers never stack", () => {
    const step = freshStep()
    // Four ~6k ceiled results push the ledger past the 20k aggregate budget.
    for (let i = 0; i < 4; i++) wrap(step, "bash", blob70k())

    // A post-breach small result gets the L1.3 cut with the budget marker only.
    const small = wrap(step, "grep", numberedLines("post", 100))
    const smallLines = small.split("\n")
    expect(smallLines.length).toBe(41)
    expect(smallLines.at(-1)).toContain("step result budget")

    // A post-breach oversize result is ceiling-cut, then aggregate-cut to 40 lines —
    // the trailing ceiling marker is dropped by the line cut, leaving exactly one marker.
    const big = wrap(step, "bash", blob70k())
    expect(big.split("\n").length).toBe(41)
    expect(big).toContain("step result budget")
    expect(big).not.toContain("[result ceiling:")
  })

  test("aggregate budget constant unchanged by the ceiling work", () => {
    expect(STEP_RESULT_BUDGET).toBe(20_000)
  })
})
