/**
 * Unit tests for triage.ts: triageRepo — go/no-go on cheap-first routing.
 * Pure function tests: no I/O, no mocks beyond the input shape.
 */

import { describe, it, expect } from "bun:test"
import {
  triageRepo,
  MIN_SAMPLE_SIZE,
  MIN_DISCRIMINATION,
  isHeavyPrompt,
  decideTriageTurn,
  DEFAULT_ESCALATE_ON,
  type TriageStats,
} from "../src/triage.js"
import { routeTurn, defaultRouterState } from "../src/router.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A baseline stat set that clearly satisfies all cheap-first conditions. */
const cheapFirstStats: TriageStats = {
  cheapPassRate: 0.85,       // > 1/5 = 0.2
  costRatio: 5,              // oracle 5× more expensive
  signalDiscrimination: 0.75, // above MIN_DISCRIMINATION (0.6)
  sampleSize: 50,            // above MIN_SAMPLE_SIZE (30)
}

// ---------------------------------------------------------------------------
// Case (a): high cheapPassRate + good discrimination → cheap-first
// ---------------------------------------------------------------------------

describe("triageRepo — cheap-first when conditions are met", () => {
  it("returns cheap-first for high pass rate and good discrimination", () => {
    const result = triageRepo(cheapFirstStats)
    expect(result.decision).toBe("cheap-first")
    expect(result.forceTier).toBeUndefined()
    expect(result.reason).toContain("cheap-first routing pays")
  })

  it("exact boundary: cheapPassRate just above 1/costRatio passes", () => {
    const stats: TriageStats = {
      ...cheapFirstStats,
      cheapPassRate: 0.201,  // just above 1/5 = 0.2
      costRatio: 5,
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
  })

  it("exact discrimination boundary: 0.6 is acceptable", () => {
    const stats: TriageStats = {
      ...cheapFirstStats,
      signalDiscrimination: MIN_DISCRIMINATION,
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
  })

  it("exact sample boundary: MIN_SAMPLE_SIZE is acceptable", () => {
    const stats: TriageStats = {
      ...cheapFirstStats,
      sampleSize: MIN_SAMPLE_SIZE,
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
  })
})

// ---------------------------------------------------------------------------
// Case (b): low cheapPassRate (cheap won't pay) → oracle-first + forceTier
// ---------------------------------------------------------------------------

describe("triageRepo — oracle-first when cheap won't pay", () => {
  it("oracle-first when cheapPassRate <= 1/costRatio", () => {
    const stats: TriageStats = {
      ...cheapFirstStats,
      cheapPassRate: 0.15,   // below 1/5 = 0.2
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("oracle-first")
    expect(result.forceTier).toBe("oracle")
    expect(result.reason).toContain("cheap won't pay")
  })

  it("oracle-first when cheapPassRate equals 1/costRatio exactly (boundary: not strictly >)", () => {
    const stats: TriageStats = {
      ...cheapFirstStats,
      cheapPassRate: 0.2,   // exactly 1/5, NOT strictly >
      costRatio: 5,
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("oracle-first")
    expect(result.forceTier).toBe("oracle")
  })

  it("oracle-first when discrimination is too weak even if pass rate is high", () => {
    const stats: TriageStats = {
      ...cheapFirstStats,
      signalDiscrimination: 0.5,  // below MIN_DISCRIMINATION (0.6)
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("oracle-first")
    expect(result.forceTier).toBe("oracle")
    expect(result.reason).toContain("risk signal too weak")
  })

  it("oracle-first when both pass rate low AND discrimination weak", () => {
    const stats: TriageStats = {
      ...cheapFirstStats,
      cheapPassRate: 0.10,
      signalDiscrimination: 0.45,
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("oracle-first")
    expect(result.reason).toContain("cheap won't pay")
    expect(result.reason).toContain("risk signal too weak")
  })

  it("oracle-first when sampleSize below minimum", () => {
    // sampleSize < MIN_SAMPLE_SIZE with otherwise good stats still degrades open
    // to cheap-first (degrade-open rule — not enough data to trust oracle-first)
    const stats: TriageStats = {
      ...cheapFirstStats,
      sampleSize: MIN_SAMPLE_SIZE - 1,
    }
    const result = triageRepo(stats)
    // Degrade-open: insufficient samples → cheap-first, not oracle-first
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toContain("insufficient signal")
  })
})

// ---------------------------------------------------------------------------
// Case (c): missing signal / zero sample → cheap-first, no crash
// ---------------------------------------------------------------------------

describe("triageRepo — degrade-open on missing or degenerate stats", () => {
  it("cheapPassRate NaN → cheap-first, no crash", () => {
    const stats: TriageStats = { ...cheapFirstStats, cheapPassRate: NaN }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toBe("insufficient signal")
  })

  it("costRatio NaN → cheap-first, no crash", () => {
    const stats: TriageStats = { ...cheapFirstStats, costRatio: NaN }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toBe("insufficient signal")
  })

  it("signalDiscrimination NaN → cheap-first, no crash", () => {
    const stats: TriageStats = { ...cheapFirstStats, signalDiscrimination: NaN }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toBe("insufficient signal")
  })

  it("sampleSize = 0 (zero-sample) → cheap-first, no crash", () => {
    const stats: TriageStats = { ...cheapFirstStats, sampleSize: 0 }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toBe("insufficient signal")
  })

  it("sampleSize negative → cheap-first, no crash", () => {
    const stats: TriageStats = { ...cheapFirstStats, sampleSize: -1 }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toBe("insufficient signal")
  })

  it("costRatio = 0 (division by zero guard) → cheap-first, no crash", () => {
    const stats: TriageStats = { ...cheapFirstStats, costRatio: 0 }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toBe("insufficient signal")
  })

  it("all stats Infinity → cheap-first, no crash", () => {
    const stats: TriageStats = {
      cheapPassRate: Infinity,
      costRatio: Infinity,
      signalDiscrimination: Infinity,
      sampleSize: Infinity,
    }
    const result = triageRepo(stats)
    expect(result.decision).toBe("cheap-first")
    expect(result.reason).toBe("insufficient signal")
  })
})

// ---------------------------------------------------------------------------
// Case (d): routeTurn(forceTier from triage) actually returns oracle
// ---------------------------------------------------------------------------

describe("routeTurn integration — forceTier from triage overrides risk logic", () => {
  it("oracle-first triage + routeTurn returns oracle tier regardless of low risk", () => {
    const poorStats: TriageStats = {
      ...cheapFirstStats,
      cheapPassRate: 0.05,   // cheap definitely won't pay
    }
    const triage = triageRepo(poorStats)
    expect(triage.forceTier).toBe("oracle")

    // Pass triage's forceTier into routeTurn with zero risk (would normally be conductor)
    const routeResult = routeTurn({
      risk: 0,
      state: defaultRouterState,
      forceTier: triage.forceTier,
    })
    expect(routeResult.tier).toBe("oracle")
    expect(routeResult.reason).toContain("forceTier")
  })

  it("cheap-first triage + routeTurn uses risk logic normally (no forceTier)", () => {
    const goodStats: TriageStats = cheapFirstStats
    const triage = triageRepo(goodStats)
    expect(triage.forceTier).toBeUndefined()

    // No forceTier: low risk routes to conductor via normal hysteresis
    const routeResult = routeTurn({
      risk: 20,
      state: defaultRouterState,
      forceTier: triage.forceTier, // undefined — ignored by routeTurn
    })
    expect(routeResult.tier).toBe("conductor")
  })

  it("oracle-first triage + routeTurn returns oracle even when risk is mid-band", () => {
    const poorStats: TriageStats = {
      ...cheapFirstStats,
      signalDiscrimination: 0.3,  // too weak
    }
    const triage = triageRepo(poorStats)
    expect(triage.decision).toBe("oracle-first")

    const routeResult = routeTurn({
      risk: 55,  // mid-band: would hold current tier without forceTier
      state: defaultRouterState,
      forceTier: triage.forceTier,
    })
    expect(routeResult.tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// isHeavyPrompt — AC-3.2 heavy-prompt classifier
// ---------------------------------------------------------------------------

describe("isHeavyPrompt — matches escalate_on signals", () => {
  it("matches multi_file_edit phrasing", () => {
    expect(isHeavyPrompt("please refactor across the whole codebase", DEFAULT_ESCALATE_ON)).toBe(true)
    expect(isHeavyPrompt("migrate the auth module to the new SDK", DEFAULT_ESCALATE_ON)).toBe(true)
    expect(isHeavyPrompt("rename this variable everywhere", DEFAULT_ESCALATE_ON)).toBe(true)
  })

  it("matches high_risk phrasing", () => {
    expect(isHeavyPrompt("this touches production payment flows", DEFAULT_ESCALATE_ON)).toBe(true)
    expect(isHeavyPrompt("delete the legacy auth tables", DEFAULT_ESCALATE_ON)).toBe(true)
  })

  it("matches explicit_plan_request phrasing", () => {
    expect(isHeavyPrompt("plan the migration to the new router", DEFAULT_ESCALATE_ON)).toBe(true)
    expect(isHeavyPrompt("write an RFC for the new caching layer", DEFAULT_ESCALATE_ON)).toBe(true)
  })

  it("returns false for a light, single-file prompt", () => {
    expect(isHeavyPrompt("fix the typo in the README", DEFAULT_ESCALATE_ON)).toBe(false)
  })

  it("returns false for empty/undefined text", () => {
    expect(isHeavyPrompt("", DEFAULT_ESCALATE_ON)).toBe(false)
    expect(isHeavyPrompt("   ", DEFAULT_ESCALATE_ON)).toBe(false)
  })

  it("only matches signals present in the escalate_on list", () => {
    // "plan the" would match explicit_plan_request, but it's excluded here.
    expect(isHeavyPrompt("plan the migration", ["high_risk"])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// decideTriageTurn — AC-3.1/AC-3.2 per-turn triage bias
// ---------------------------------------------------------------------------

describe("decideTriageTurn — cheap-first bias for the session's first turn", () => {
  it("applies triage on a light first turn when enabled", () => {
    const result = decideTriageTurn({ isFirstTurn: true, enabled: true, prompt: "fix the typo in the README" })
    expect(result.applyTriage).toBe(true)
  })

  it("does not apply triage when disabled", () => {
    const result = decideTriageTurn({ isFirstTurn: true, enabled: false, prompt: "fix the typo in the README" })
    expect(result.applyTriage).toBe(false)
    expect(result.reason).toContain("disabled")
  })

  it("does not apply triage on a later turn", () => {
    const result = decideTriageTurn({ isFirstTurn: false, enabled: true, prompt: "fix the typo in the README" })
    expect(result.applyTriage).toBe(false)
    expect(result.reason).toContain("first turn")
  })

  it("does not apply triage when the first prompt matches an escalate_on signal", () => {
    const result = decideTriageTurn({
      isFirstTurn: true,
      enabled: true,
      prompt: "refactor across every service in the monorepo",
    })
    expect(result.applyTriage).toBe(false)
    expect(result.reason).toContain("escalate_on")
  })

  it("degrade-open: applies triage when no prompt text is available", () => {
    const result = decideTriageTurn({ isFirstTurn: true, enabled: true })
    expect(result.applyTriage).toBe(true)
  })
})
