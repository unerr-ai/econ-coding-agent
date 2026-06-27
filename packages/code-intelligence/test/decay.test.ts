/**
 * Unit tests for decay.ts: decayConfidence pure function and DEFAULT_DECAY_CONFIG.
 */

import { describe, it, expect } from "bun:test"
import { decayConfidence, DEFAULT_DECAY_CONFIG } from "./../src/decay.js"
import type { DecayConfig } from "./../src/decay.js"

// ---------------------------------------------------------------------------
// decayConfidence
// ---------------------------------------------------------------------------

describe("decayConfidence", () => {
  it("returns the original confidence when age is 0", () => {
    expect(decayConfidence(1, 0)).toBe(1)
    expect(decayConfidence(0.8, 0)).toBe(0.8)
  })

  it("returns ~0.5 when age equals the half-life", () => {
    const halfLifeMs = DEFAULT_DECAY_CONFIG.halfLifeMs
    const result = decayConfidence(1, halfLifeMs)
    expect(Math.abs(result - 0.5)).toBeLessThan(1e-9)
  })

  it("returns ~0.25 when age equals two half-lives", () => {
    const halfLifeMs = DEFAULT_DECAY_CONFIG.halfLifeMs
    const result = decayConfidence(1, halfLifeMs * 2)
    expect(Math.abs(result - 0.25)).toBeLessThan(1e-9)
  })

  it("clamps result to 0 — confidence cannot go below 0", () => {
    // Very large age drives the value toward 0; should never go negative.
    const result = decayConfidence(1, Number.MAX_SAFE_INTEGER)
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(1)
  })

  it("clamps result to 1 — confidence cannot exceed 1", () => {
    // Input confidence already 1 at age 0 → output must be exactly 1.
    expect(decayConfidence(1, 0)).toBeLessThanOrEqual(1)
  })

  it("respects a custom DecayConfig half-life", () => {
    const config: DecayConfig = { halfLifeMs: 1000 }
    const result = decayConfidence(1, 1000, config)
    expect(Math.abs(result - 0.5)).toBeLessThan(1e-9)
  })

  it("works with a starting confidence less than 1", () => {
    const halfLifeMs = DEFAULT_DECAY_CONFIG.halfLifeMs
    // After one half-life, 0.6 → ~0.3
    const result = decayConfidence(0.6, halfLifeMs)
    expect(Math.abs(result - 0.3)).toBeLessThan(1e-9)
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_DECAY_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_DECAY_CONFIG", () => {
  it("has a halfLifeMs equal to 30 days in milliseconds", () => {
    const thirtyDaysMs = 1000 * 60 * 60 * 24 * 30
    expect(DEFAULT_DECAY_CONFIG.halfLifeMs).toBe(thirtyDaysMs)
  })
})
