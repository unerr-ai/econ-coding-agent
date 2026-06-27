/**
 * Unit tests for continuity.ts: buildResumeStrip safe-defaults and field mapping.
 */

import { describe, it, expect } from "bun:test"
import { buildResumeStrip } from "./../src/continuity.js"
import type { SessionStateLike, ResumeStrip } from "./../src/continuity.js"

// ---------------------------------------------------------------------------
// buildResumeStrip
// ---------------------------------------------------------------------------

describe("buildResumeStrip", () => {
  it("maps intent through and defaults arrays to []", () => {
    const result = buildResumeStrip({ intent: "x" })
    expect(result.intent).toBe("x")
    expect(result.decisions).toEqual([])
    expect(result.blockers).toEqual([])
    expect(result.openLoops).toEqual([])
  })

  it("returns all-empty defaults when called with an empty object", () => {
    const result = buildResumeStrip({})
    expect(result.intent).toBe("")
    expect(result.decisions).toEqual([])
    expect(result.blockers).toEqual([])
    expect(result.openLoops).toEqual([])
  })

  it("maps all populated fields through unchanged", () => {
    const state: SessionStateLike = {
      intent: "build the router",
      decisions: ["use bun", "skip zod"],
      blockers: ["missing API key"],
      openLoops: ["add retry logic"],
    }
    const result = buildResumeStrip(state)
    expect(result.intent).toBe("build the router")
    expect(result.decisions).toEqual(["use bun", "skip zod"])
    expect(result.blockers).toEqual(["missing API key"])
    expect(result.openLoops).toEqual(["add retry logic"])
  })

  it("always returns a fully-populated ResumeStrip (no undefined fields)", () => {
    const result: ResumeStrip = buildResumeStrip({})
    // TypeScript type check — all fields must be present at runtime
    expect(typeof result.intent).toBe("string")
    expect(Array.isArray(result.decisions)).toBe(true)
    expect(Array.isArray(result.blockers)).toBe(true)
    expect(Array.isArray(result.openLoops)).toBe(true)
  })

  it("uses empty string not undefined for missing intent", () => {
    const result = buildResumeStrip({ decisions: ["d1"] })
    expect(result.intent).toBe("")
    expect(result.decisions).toEqual(["d1"])
  })
})
