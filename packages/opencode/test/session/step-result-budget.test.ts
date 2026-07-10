import { describe, expect, test } from "bun:test"
import { applyStepResultBudget, STEP_RESULT_BUDGET } from "@/session/tools"

// L1.3 guardrail (docs/design/turn-cache-economics.md §5-L1 sub-move 3): aggregate
// per-assistant-message tool-result token budget. Token.estimate is length/4, so the
// 20k-token budget corresponds to ~80k chars of combined output per step.

// Each call gets a fresh session+message pair so the module-level accumulator starts
// at zero; the reset test reuses a sessionID with a new messageID on purpose.
let seq = 0
function freshStep() {
  seq += 1
  return { sessionID: `ses_budget_${seq}`, messageID: `msg_budget_${seq}` }
}

// ~100k chars ≈ 25k estimated tokens — a single result that crosses the 20k budget.
function bigOutput() {
  return Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(90)}`).join("\n")
}

function numberedLines(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n")
}

describe("applyStepResultBudget", () => {
  test("budget constant is 20k estimated tokens", () => {
    expect(STEP_RESULT_BUDGET).toBe(20_000)
  })

  test("under budget: output passes through untouched", () => {
    const step = freshStep()
    const first = numberedLines("alpha", 100)
    const second = numberedLines("beta", 100)
    expect(applyStepResultBudget({ ...step, toolID: "read", output: first })).toBe(first)
    expect(applyStepResultBudget({ ...step, toolID: "grep", output: second })).toBe(second)
  })

  test("calls after breach: truncated to first 40 lines with self-describing marker", () => {
    const step = freshStep()
    applyStepResultBudget({ ...step, toolID: "bash", output: bigOutput() })

    const next = numberedLines("next", 100)
    const result = applyStepResultBudget({ ...step, toolID: "grep", output: next })
    expect(result).not.toBe(next)

    const lines = result.split("\n")
    // 40 kept lines + 1 marker line
    expect(lines.length).toBe(41)
    expect(lines.slice(0, 40)).toEqual(next.split("\n").slice(0, 40))
    const marker = lines[40]!
    expect(marker).toContain("step result budget")
    expect(marker).toMatch(/Total this step: ~\d+k tokens/)
    expect(marker).toContain("Re-run narrower, or continue in the next message")
  })

  test("post-breach result at or under 40 lines passes through — nothing was cut, so no marker", () => {
    const step = freshStep()
    applyStepResultBudget({ ...step, toolID: "bash", output: bigOutput() })

    const small = numberedLines("small", 40)
    expect(applyStepResultBudget({ ...step, toolID: "read", output: small })).toBe(small)
  })

  test("exempt tools untouched even after breach; non-exempt still truncated after", () => {
    const step = freshStep()
    applyStepResultBudget({ ...step, toolID: "bash", output: bigOutput() })

    for (const toolID of ["edit", "write", "skill", "todowrite", "todoread"]) {
      const output = numberedLines(toolID, 100)
      expect(applyStepResultBudget({ ...step, toolID, output })).toBe(output)
    }

    const after = numberedLines("after", 100)
    expect(applyStepResultBudget({ ...step, toolID: "grep", output: after })).toContain("step result budget")
  })

  test("crossing call kept whole; only subsequent calls truncated", () => {
    const step = freshStep()
    // ~12.5k tokens: under budget, passes through
    const half = "y".repeat(50_000)
    expect(applyStepResultBudget({ ...step, toolID: "read", output: half })).toBe(half)

    // ~12.6k more tokens: this call crosses the 20k boundary — kept whole
    const crossing = Array.from({ length: 500 }, () => "z".repeat(100)).join("\n")
    expect(applyStepResultBudget({ ...step, toolID: "read", output: crossing })).toBe(crossing)

    // the next call is over budget from the start — truncated
    const after = numberedLines("post", 60)
    expect(applyStepResultBudget({ ...step, toolID: "read", output: after })).toContain("step result budget")
  })

  test("new messageID in the same session resets the accumulator", () => {
    const step = freshStep()
    applyStepResultBudget({ ...step, toolID: "bash", output: bigOutput() })
    const breached = applyStepResultBudget({ ...step, toolID: "grep", output: numberedLines("old", 100) })
    expect(breached).toContain("step result budget")

    const nextStep = { sessionID: step.sessionID, messageID: `${step.messageID}_next` }
    const output = numberedLines("fresh", 100)
    expect(applyStepResultBudget({ ...nextStep, toolID: "grep", output })).toBe(output)
  })
})
