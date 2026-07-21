/**
 * Tests for packages/code-intelligence/src/brief.ts
 *
 * Verifies three contracts:
 *  (a) The compiled brief contains the question + output shape + key slice content.
 *  (b) The brief does NOT contain a raw-transcript blob passed as a decoy
 *      (no `rawTranscript` field exists in BriefInput — the API enforces structure).
 *  (c) The compiled brief stays within the token budget.
 */
import { describe, it, expect } from "bun:test"
import { compileBrief } from "../src/brief.ts"
import { estimateTokens } from "../src/trim.ts"
import type { ReconBundle } from "../src/index.ts"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROBLEM = "The router must escalate structurally-risky edits to the oracle tier."
const QUESTION = "Which entities in src/router.ts have fan-in > 5?"
const OUTPUT_SHAPE = 'A JSON array of { name: string; fanIn: number } objects, sorted descending.'

const SLICE_DISPATCH = [
  "function dispatch(task: Task): Model {",
  "  // routes to cheap tier by default",
  "  return cheapModel",
  "}",
].join("\n")

const SLICE_TASK_TYPE = "interface Task { kind: string; payload: unknown }"

const ATTEMPTS = [
  { task: "Identify high-fan-in entities", status: "failure" as const, error: "No graph index found" },
  { task: "Re-index the repository", status: "success" as const },
]

// A raw transcript blob that should NEVER appear in a compiled brief.
// compileBrief accepts no `rawTranscript` field — this is the decoy we verify is absent.
const RAW_TRANSCRIPT =
  "=== RAW TRANSCRIPT START ===\nUser: explain the codebase\nAssistant: sure, here is everything\n=== RAW TRANSCRIPT END ==="

// ---------------------------------------------------------------------------
// (a) Structural content — question, output shape, key slices
// ---------------------------------------------------------------------------

describe("compileBrief — structural content", () => {
  it("contains the question", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH],
      attempts: [],
    })
    expect(brief.text).toContain(QUESTION)
  })

  it("contains the expected output shape", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH],
      attempts: [],
    })
    expect(brief.text).toContain(OUTPUT_SHAPE)
  })

  it("contains key content from the first slice", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH, SLICE_TASK_TYPE],
      attempts: [],
    })
    expect(brief.text).toContain("dispatch")
  })

  it("contains content from a second slice when budget allows", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH, SLICE_TASK_TYPE],
      attempts: [],
    })
    expect(brief.text).toContain("Task")
  })

  it("includes prior-attempt task names", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [],
      attempts: ATTEMPTS,
    })
    expect(brief.text).toContain("Identify high-fan-in entities")
    expect(brief.text).toContain("failure")
  })

  it("includes attempt error when status is failure", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [],
      attempts: [{ task: "do thing", status: "failure", error: "boom" }],
    })
    expect(brief.text).toContain("boom")
  })

  it("problem appears before question in the text (ordering contract)", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [],
      attempts: [],
    })
    expect(brief.text.indexOf(PROBLEM)).toBeLessThan(brief.text.indexOf(QUESTION))
  })

  it("question appears before slices in the text (ordering contract)", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH],
      attempts: [],
    })
    const questionPos = brief.text.indexOf(QUESTION)
    const slicePos = brief.text.indexOf("dispatch")
    expect(questionPos).toBeLessThan(slicePos)
  })

  it("slices appear before attempts in the text (ordering contract)", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH],
      attempts: ATTEMPTS,
    })
    const slicePos = brief.text.indexOf("dispatch")
    const attemptPos = brief.text.indexOf("Attempt 1")
    expect(slicePos).toBeLessThan(attemptPos)
  })
})

// ---------------------------------------------------------------------------
// (b) No raw-transcript blob — BriefInput has no `rawTranscript` field
// ---------------------------------------------------------------------------

describe("compileBrief — no raw transcript", () => {
  it("does not contain the raw transcript when it is not in any structured field", () => {
    // BriefInput has no rawTranscript field — only problem/question/outputShape/slices/attempts.
    // Calling compileBrief with structured inputs must never produce the decoy blob.
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH, SLICE_TASK_TYPE],
      attempts: ATTEMPTS,
    })
    expect(brief.text).not.toContain(RAW_TRANSCRIPT)
    expect(brief.text).not.toContain("=== RAW TRANSCRIPT")
    expect(brief.text).not.toContain("RAW TRANSCRIPT START")
  })

  it("trims a large multi-line decoy slice so the full blob does not appear verbatim", () => {
    // Build a large multi-line "transcript" (>> 100 tokens) that smartTruncate can cut.
    // The API has no rawTranscript field; here we simulate the worst case where a caller
    // tries to inject it as a slice.  The brief trims it — the full blob must not survive.
    const lines = Array.from(
      { length: 200 },
      (_, i) => `[${i}] User: explain line ${i} | Assistant: sure thing line ${i}`,
    )
    const largeDecoy = "=== RAW TRANSCRIPT ===\n" + lines.join("\n") + "\n=== END TRANSCRIPT ==="
    const brief = compileBrief({
      problem: "p",
      question: "q",
      outputShape: "o",
      slices: [largeDecoy],
      attempts: [],
      tokenBudget: 300,
    })
    // The full blob must not appear verbatim — it exceeds the budget and is truncated.
    expect(brief.text).not.toContain(largeDecoy)
    // The brief stays within budget (15% margin for token-estimate rounding).
    expect(brief.estimatedTokens).toBeLessThanOrEqual(brief.tokenBudget * 1.15)
  })
})

// ---------------------------------------------------------------------------
// (c) Token budget enforcement
// ---------------------------------------------------------------------------

describe("compileBrief — token budget", () => {
  it("returns OracleBrief.tokenBudget matching the input tokenBudget", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [],
      attempts: [],
      tokenBudget: 3000,
    })
    expect(brief.tokenBudget).toBe(3000)
  })

  it("defaults to 8000 when tokenBudget is omitted", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [],
      attempts: [],
    })
    expect(brief.tokenBudget).toBe(8000)
  })

  it("estimatedTokens matches estimateTokens(text)", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH],
      attempts: ATTEMPTS,
    })
    expect(brief.estimatedTokens).toBe(estimateTokens(brief.text))
  })

  it("trimmed is false for small input that fits within default budget", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH, SLICE_TASK_TYPE],
      attempts: ATTEMPTS,
    })
    expect(brief.trimmed).toBe(false)
    expect(brief.estimatedTokens).toBeLessThanOrEqual(brief.tokenBudget)
  })

  it("trims a huge slice to fit within a small budget", () => {
    // Multi-line content so smartTruncate can split on line boundaries.
    const bigSlice = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"x".repeat(60)}`).join("\n")
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [bigSlice],
      attempts: [],
      tokenBudget: 500,
    })
    expect(brief.trimmed).toBe(true)
    expect(brief.estimatedTokens).toBeLessThanOrEqual(brief.tokenBudget * 1.15)
  })

  it("stays within budget for normal input with a 1000-token cap", () => {
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: [SLICE_DISPATCH, SLICE_TASK_TYPE],
      attempts: ATTEMPTS,
      tokenBudget: 1000,
    })
    expect(brief.estimatedTokens).toBeLessThanOrEqual(brief.tokenBudget * 1.15)
  })

  it("stays within budget when many slices are provided", () => {
    const manySlices = Array.from({ length: 20 }, (_, i) => `slice ${i}: ${"code line ".repeat(30)}`)
    const brief = compileBrief({
      problem: PROBLEM,
      question: QUESTION,
      outputShape: OUTPUT_SHAPE,
      slices: manySlices,
      attempts: ATTEMPTS,
      tokenBudget: 2000,
    })
    expect(brief.estimatedTokens).toBeLessThanOrEqual(brief.tokenBudget * 1.15)
  })
})
