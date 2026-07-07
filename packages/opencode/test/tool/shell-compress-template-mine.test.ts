import { describe, expect, it } from "bun:test"
import { mineTemplates } from "../../src/tool/shell-compress/strategies/template-mine"
import { compressLogText } from "../../src/tool/shell-compress/strategies/log-text"
import { compressErrorDiagnostic } from "../../src/tool/shell-compress/strategies/error-diagnostic"

describe("mineTemplates — Drain3-lite single-pass grouping", () => {
  it("collapses 10,000 near-identical lines varying only a number to a single exemplar + count", () => {
    const huge = Array.from(
      { length: 10_000 },
      (_, i) => `connection refused to host ${i} after 42ms`,
    )
    const result = mineTemplates(huge)

    expect(result.length).toBe(1)
    expect(result[0]).toBe("connection refused to host 0 after 42ms  [×10000]")
    expect(result.join("\n").length).toBeLessThan(huge.join("\n").length / 100)
  })

  it("preserves first-occurrence order across interleaved template groups", () => {
    const mixed = [
      "GET /a 200 12ms",
      "POST /b 200 8ms",
      "GET /a 200 45ms",
      "GET /a 200 33ms",
      "POST /b 200 9ms",
    ]
    const result = mineTemplates(mixed)

    // GET's template is first-seen at index 0 and has 3 occurrences (collapses);
    // POST's template is first-seen at index 1 and has only 2 (kept as-is).
    // The GET group must appear before the POST lines even though input interleaves them.
    expect(result).toEqual(["GET /a 200 12ms  [×3]", "POST /b 200 8ms", "POST /b 200 9ms"])
  })

  it("keeps three different salient messages that share a masked template as separate entries", () => {
    const err1 = "error: unexpected token at line 1"
    const err2 = "error: unexpected token at line 2"
    const err3 = "error: unexpected token at line 3"
    const noise = Array.from({ length: 5 }, (_, i) => `heartbeat ${i} ok`)
    const lines = [...noise, err1, err2, err3, "unrelated info line"]

    const result = mineTemplates(lines)

    // All three share the masked template "error: unexpected token at line <*>" and would hit
    // the count>=3 collapse threshold if grouped by template — they must survive individually
    // because salient lines group by exact raw text, not by masked template.
    expect(result).toContain(err1)
    expect(result).toContain(err2)
    expect(result).toContain(err3)
    expect(result.some((l) => l.includes("[×3]") && l.includes("unexpected token"))).toBe(false)
  })

  it("collapses identical salient lines with a count while keeping one full exemplar", () => {
    const salient = "FATAL: connection refused"
    const lines = [salient, "startup complete", salient, "listening on port", salient, "ready to serve"]

    const result = mineTemplates(lines)

    expect(result).toEqual([
      "FATAL: connection refused  [×3]",
      "startup complete",
      "listening on port",
      "ready to serve",
    ])
  })

  it("never inflates — returns the input unchanged when mining does not shorten it", () => {
    const unique = ["alpha one", "beta two", "gamma three", "delta four"]
    const result = mineTemplates(unique)
    expect(result).toBe(unique)
  })
})

describe("mineTemplates integration — pre-pass ahead of log-text and error-diagnostic strategies", () => {
  it("compressLogText: collapses a repetitive quoted-token fixture that its own normalization alone would leave as separate patterns, while keeping the error signal", () => {
    const words = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
      "juliet",
    ]
    const noisy = Array.from({ length: 90 }, (_, i) => `session ping "${words[i % words.length]}" ok`)
    const errorLine = "ERROR: connection dropped unexpectedly"
    const raw = [errorLine, ...noisy].join("\n")

    const result = compressLogText(raw)

    // Only mineTemplates' quoted-string masking can unify all 90 lines into one group —
    // log-text's own normalizeLogLine has no quote handling, so without the pre-pass this
    // would surface as 10 separate word-keyed patterns instead of one [×90] group.
    expect(result).toContain("[×90]")
    expect(result).toContain(errorLine)
    expect(result.length).toBeLessThan(raw.length)
  })

  it("compressErrorDiagnostic: generic/fallback path collapses repetitive lines the old frame-only dedup could not, while keeping the error signal", () => {
    const noisy = Array.from({ length: 50 }, (_, i) => `connecting to node ${i} attempt ${i % 5}`)
    const errorLine = "error: could not reach upstream service"
    const raw = [...noisy, errorLine, "shutting down"].join("\n")

    const result = compressErrorDiagnostic(raw)

    // compressFallback (the generic-format path) only dedups consecutive identical stack
    // frames — it cannot collapse these non-frame, number-varying lines on its own. The
    // [×50] marker can only come from the mineTemplates pre-pass.
    expect(result).toContain("[×50]")
    expect(result).toContain(errorLine)
    expect(result.length).toBeLessThan(raw.length)
  })
})
