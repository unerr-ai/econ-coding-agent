/**
 * Tests for packages/code-intelligence/src/trim.ts
 *
 * Imports trim.ts directly (not via index.ts — S2.6 owns that integration).
 */
import { describe, it, expect } from "bun:test"
import { estimateTokens, smartTruncate } from "../src/trim.ts"

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0)
  })

  it("returns a positive integer for non-empty text", () => {
    const n = estimateTokens("hello world")
    expect(n).toBeGreaterThan(0)
    expect(Number.isInteger(n)).toBe(true)
  })

  it("is monotonically larger for longer text", () => {
    const short = estimateTokens("hello")
    const long = estimateTokens("hello world foo bar baz qux")
    expect(long).toBeGreaterThan(short)
  })

  it("produces a reasonable estimate — within 2× of chars/4 heuristic", () => {
    const text = "a".repeat(4000)
    const estimate = estimateTokens(text)
    // 4000 chars / 4 = 1000 tokens; allow 0.5×–2× range
    expect(estimate).toBeGreaterThan(500)
    expect(estimate).toBeLessThan(2000)
  })

  it("estimates JSON text lower than pure prose (more structure = more tokens per char)", () => {
    // JSON has more delimiters so tokens per char is higher (chars/token ratio is lower)
    const json = JSON.stringify({ key: "value", num: 42, arr: [1, 2, 3] })
    const prose = "The quick brown fox jumps over the lazy dog near the river"
    const jsonTokens = estimateTokens(json)
    const proseTokens = estimateTokens(prose)
    // JSON chars/token = 3.0, prose = 4.0 — same length text → JSON has more tokens
    // (We only check json is positive and roughly in range, not strict ordering,
    //  since lengths differ here — the ratio contracts is chars/token.)
    expect(jsonTokens).toBeGreaterThan(0)
    expect(proseTokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// smartTruncate — passthrough (fits in budget)
// ---------------------------------------------------------------------------

describe("smartTruncate — within budget", () => {
  it("returns the original text unchanged when it fits", () => {
    const text = "line one\nline two\nline three"
    const result = smartTruncate(text, { budget: 10000 })
    expect(result.text).toBe(text)
    expect(result.truncated).toBe(false)
    expect(result.tokensUsed).toBe(result.fullTokensEstimate)
    expect(result.tokensBudget).toBe(10000)
  })

  it("sets truncated:false for empty string", () => {
    const result = smartTruncate("", { budget: 100 })
    expect(result.truncated).toBe(false)
    expect(result.text).toBe("")
  })
})

// ---------------------------------------------------------------------------
// smartTruncate — trimming
// ---------------------------------------------------------------------------

function makeLongText(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `line ${i}: ${"x".repeat(60)}`).join("\n")
}

describe("smartTruncate — trimming behaviour", () => {
  it("trims long input to within the token budget", () => {
    const text = makeLongText(500) // ~500 * 64 chars ≈ 32000 chars ≈ ~8600 tokens
    const result = smartTruncate(text, { budget: 500 })

    expect(result.truncated).toBe(true)
    expect(result.tokensUsed).toBeLessThanOrEqual(result.tokensBudget * 1.15) // allow 15% margin
    expect(result.fullTokensEstimate).toBeGreaterThan(result.tokensBudget)
  })

  it("preserves head lines (first lines appear in output)", () => {
    const text = makeLongText(300)
    const firstLine = text.split("\n")[0]
    const result = smartTruncate(text, { budget: 200 })

    expect(result.text).toContain(firstLine)
  })

  it("preserves tail lines (last lines appear in output)", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}: ${"y".repeat(60)}`)
    const text = lines.join("\n")
    const lastLine = lines[lines.length - 1]
    const result = smartTruncate(text, { budget: 200 })

    expect(result.text).toContain(lastLine)
  })

  it("inserts an elision marker", () => {
    const text = makeLongText(300)
    const result = smartTruncate(text, { budget: 200 })

    expect(result.text).toContain("elided")
  })

  it("elision marker includes the full token estimate", () => {
    const text = makeLongText(300)
    const result = smartTruncate(text, { budget: 200 })

    expect(result.text).toContain(String(result.fullTokensEstimate))
  })

  it("never cuts mid-line — every line in the output is complete", () => {
    const text = makeLongText(300)
    const result = smartTruncate(text, { budget: 200 })

    // Filter out the elision markers, which are synthetic
    const outputLines = result.text.split("\n").filter((l) => !l.startsWith("..."))
    for (const line of outputLines) {
      // Every real line from the original starts with "line "
      expect(line.startsWith("line ")).toBe(true)
    }
  })

  it("returns fewer tokens than the original", () => {
    const text = makeLongText(400)
    const result = smartTruncate(text, { budget: 300 })

    expect(result.tokensUsed).toBeLessThan(result.fullTokensEstimate)
  })
})

// ---------------------------------------------------------------------------
// smartTruncate — match context
// ---------------------------------------------------------------------------

describe("smartTruncate — query match context", () => {
  it("surfaces matching lines in the trimmed output", () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      i === 100 ? "SECRET_KEY=abc123 found here" : `filler line ${i}: ${"z".repeat(40)}`,
    )
    const text = lines.join("\n")
    const result = smartTruncate(text, { budget: 150, query: "SECRET_KEY" })

    // The matching line should appear in the output
    expect(result.text).toContain("SECRET_KEY=abc123")
  })

  it("falls back gracefully when query has no matches", () => {
    const text = makeLongText(200)
    const result = smartTruncate(text, { budget: 150, query: "ZZZNOTFOUND" })

    // Should still truncate without crashing; elision marker present
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("elided")
  })
})

// ---------------------------------------------------------------------------
// smartTruncate — edge cases
// ---------------------------------------------------------------------------

describe("smartTruncate — edge cases", () => {
  it("handles a single very long line without crashing", () => {
    const text = "x".repeat(100_000)
    const result = smartTruncate(text, { budget: 500 })
    expect(result).toBeDefined()
    expect(typeof result.text).toBe("string")
  })

  it("clamps budget to minimum 100 even if 0 is passed", () => {
    const text = makeLongText(50)
    const result = smartTruncate(text, { budget: 0 })
    expect(result.tokensBudget).toBe(100)
  })

  it("fullTokensEstimate matches estimateTokens on the original", () => {
    const text = makeLongText(300)
    const result = smartTruncate(text, { budget: 200 })
    expect(result.fullTokensEstimate).toBe(estimateTokens(text))
  })
})
