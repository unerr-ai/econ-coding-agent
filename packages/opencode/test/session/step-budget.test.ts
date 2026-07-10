import { describe, expect, test } from "bun:test"
import {
  enforceStepBudget,
  STEP_TOOL_RESULT_BUDGET,
  STEP_BUDGET_MARKER_TAG,
} from "../../src/session/step-budget"
import { estimateTokens } from "../../../code-intelligence/src/trim"

function lines(prefix: string, n: number, width = 72): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}: ${"x".repeat(width)}`).join("\n")
}

describe("session.step-budget", () => {
  test("default budget is ~20k tokens", () => {
    expect(STEP_TOOL_RESULT_BUDGET).toBe(20_000)
  })

  test("under budget: everything untouched", () => {
    const med = lines("med", 60)
    const tiny = lines("tiny", 3)
    const out = enforceStepBudget(
      [
        { id: "a", output: med },
        { id: "b", output: tiny },
      ],
      STEP_TOOL_RESULT_BUDGET,
    )
    expect(out.reclaimed).toBe(0)
    expect(out.after).toBe(out.before)
    expect(out.results.every((r) => !r.trimmed)).toBe(true)
    expect(out.results.find((r) => r.id === "a")!.output).toBe(med)
    expect(out.results.find((r) => r.id === "b")!.output).toBe(tiny)
  })

  test("boundary: total exactly at budget is untouched", () => {
    const a = lines("med", 40)
    const b = lines("tiny", 4)
    const budget = estimateTokens(a) + estimateTokens(b)
    const out = enforceStepBudget(
      [
        { id: "a", output: a },
        { id: "b", output: b },
      ],
      budget,
    )
    expect(out.before).toBe(budget)
    expect(out.reclaimed).toBe(0)
    expect(out.results.every((r) => !r.trimmed)).toBe(true)
  })

  test("over budget with mixed sizes: only the largest is trimmed", () => {
    const big = lines("big", 300)
    const med = lines("med", 60)
    const tiny = lines("tiny", 3)
    const tMed = estimateTokens(med)
    const tTiny = estimateTokens(tiny)
    // Budget above (2*med + tiny) so the water-fill cap sits between med and big:
    // only `big` exceeds the cap.
    const budget = 2 * tMed + tTiny + Math.floor(tMed / 2)

    const out = enforceStepBudget(
      [
        { id: "big", output: big },
        { id: "med", output: med },
        { id: "tiny", output: tiny },
      ],
      budget,
    )

    const rBig = out.results.find((r) => r.id === "big")!
    const rMed = out.results.find((r) => r.id === "med")!
    const rTiny = out.results.find((r) => r.id === "tiny")!

    expect(rBig.trimmed).toBe(true)
    expect(rBig.reclaimed).toBeGreaterThan(0)
    expect(rMed.trimmed).toBe(false)
    expect(rMed.output).toBe(med)
    expect(rTiny.trimmed).toBe(false)
    expect(rTiny.output).toBe(tiny)

    expect(out.reclaimed).toBeGreaterThan(0)
    expect(out.after).toBeLessThan(out.before)
    expect(out.after).toBeLessThanOrEqual(budget)
  })

  test("trimmed result carries a visible, recoverable marker cut at a line boundary", () => {
    const big = lines("big", 300)
    const budget = Math.floor(estimateTokens(big) / 3)
    const out = enforceStepBudget([{ id: "big", output: big }], budget)
    const trimmed = out.results[0].output

    // Marker present and states elided amount + recovery path.
    expect(trimmed).toContain(STEP_BUDGET_MARKER_TAG)
    expect(trimmed).toMatch(/~\d+ tokens \(\d+ lines?\)/)
    expect(trimmed).toContain("cache_ref")
    expect(trimmed).toContain("narrower")
    expect(trimmed).toContain(String(budget))

    // Cut at a line boundary: the kept head is a faithful prefix of the original,
    // ending exactly on a newline (never mid-line).
    const head = trimmed.slice(0, trimmed.indexOf("\n\n" + STEP_BUDGET_MARKER_TAG))
    expect(head.length).toBeGreaterThan(0)
    expect(big.startsWith(head)).toBe(true)
    expect(big[head.length]).toBe("\n")

    // The trimmed result fits within budget.
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(budget)
  })

  test("multiple oversized results: the tall ones are trimmed, the small one is not", () => {
    const big1 = lines("one", 200)
    const big2 = lines("two", 220)
    const small = lines("small", 5)
    const budget = estimateTokens(small) + Math.floor(estimateTokens(big1) / 2)

    const out = enforceStepBudget(
      [
        { id: "one", output: big1 },
        { id: "two", output: big2 },
        { id: "small", output: small },
      ],
      budget,
    )

    expect(out.results.find((r) => r.id === "one")!.trimmed).toBe(true)
    expect(out.results.find((r) => r.id === "two")!.trimmed).toBe(true)
    expect(out.results.find((r) => r.id === "small")!.trimmed).toBe(false)
    expect(out.results.find((r) => r.id === "small")!.output).toBe(small)
    expect(out.after).toBeLessThanOrEqual(budget)
  })

  test("single-line blob over budget is left intact (never mangled mid-line)", () => {
    const oneLine = "z".repeat(200_000)
    const out = enforceStepBudget([{ id: "x", output: oneLine }], 1_000)
    expect(out.results[0].trimmed).toBe(false)
    expect(out.results[0].output).toBe(oneLine)
  })

  test("empty input is a no-op", () => {
    const out = enforceStepBudget([], 1_000)
    expect(out.results).toEqual([])
    expect(out.reclaimed).toBe(0)
    expect(out.before).toBe(0)
  })
})
