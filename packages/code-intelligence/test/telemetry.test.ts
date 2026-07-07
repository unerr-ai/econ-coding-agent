/**
 * S7.1 telemetry unit tests.
 *
 * Covers:
 *  1. inferTier — oracle / reasoner / cheap / unknown branches (order matters:
 *     oracle checked first, then reasoner, then cheap); attributeTier —
 *     model-id-first attribution with agent-name disambiguation/fallback.
 *  2. emitUsageEvent — normalisation, clamping, return value, tier default vs
 *     explicit override, sink callback, timestamp default.
 *  3. TelemetryStore — totals / byTier rollup / totalTokens, cacheHitRatio,
 *     status snapshot (contextFill, tier/model from latest), latest/count/clear.
 *  4. installUsageSink — process-level install, forwarding, disposer cleanup.
 *  5. U6 decode events — emitTurnTriageEvent / emitEvaluatorVerdictEvent /
 *     emitSliceContainedEvent / emitEscalationProvenanceEvent: each stamps its
 *     literal `type` tag + a default timestamp, forwards through an optional
 *     sink, round-trips through JSON.stringify/parse.
 */

import { describe, it, expect } from "bun:test"
import {
  TelemetryStore,
  emitUsageEvent,
  inferTier,
  tierFromAgent,
  attributeTier,
  installUsageSink,
  EfficiencyMetrics,
  emitTurnTriageEvent,
  emitEvaluatorVerdictEvent,
  emitSliceContainedEvent,
  emitEscalationProvenanceEvent,
} from "../src/telemetry.ts"
import type {
  RawUsage,
  CompactionOutcomeEvent,
  TurnTriageEvent,
  EvaluatorVerdictEvent,
  SliceContainedEvent,
  EscalationProvenanceEvent,
} from "../src/telemetry.ts"
import { ECON_TIER_BINDING, ECON_PERSONAS } from "../src/model-registry.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = "sess-001"
const TS = 1_700_000_000_000

/** Raw cheap turn: haiku model, known token counts, deterministic timestamp. */
function cheapRaw(overrides: Partial<RawUsage> = {}): RawUsage {
  return {
    sessionID: SESSION,
    model: "claude-haiku-3",
    cost: 0.0008,
    tokens: { input: 1000, output: 200, cache: { read: 400, write: 100 } },
    timestamp: TS,
    ...overrides,
  }
}

/** Raw oracle turn: opus model, no cache tokens. */
function oracleRaw(overrides: Partial<RawUsage> = {}): RawUsage {
  return {
    sessionID: SESSION,
    model: "anthropic/claude-opus-4",
    cost: 0.02,
    tokens: { input: 800, output: 400 },
    timestamp: TS + 1000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// inferTier
// ---------------------------------------------------------------------------

describe("inferTier", () => {
  // oracle branch
  it("oracle: opus", () => expect(inferTier("anthropic/claude-opus-4")).toBe("oracle"))
  it("oracle: gpt-4o", () => expect(inferTier("openai/gpt-4o")).toBe("oracle"))
  it("oracle: gpt4 (no dash)", () => expect(inferTier("gpt4-turbo")).toBe("oracle"))
  it("oracle: gpt-5", () => expect(inferTier("openai/gpt-5")).toBe("oracle"))
  it("oracle: o1", () => expect(inferTier("openai/o1")).toBe("oracle"))
  it("oracle: o3", () => expect(inferTier("openai/o3-mini")).toBe("oracle"))
  it("oracle: sonnet-4 (oracle checked before reasoner sonnet)", () =>
    expect(inferTier("claude-sonnet-4-20250514")).toBe("oracle"))
  it("oracle: ultra", () => expect(inferTier("gemini-ultra-2")).toBe("oracle"))

  // reasoner branch — checked after oracle, so sonnet-3-5 ≠ sonnet-4
  it("reasoner: 32b", () =>
    expect(inferTier("qwen/qwen-2.5-coder-32b-instruct")).toBe("reasoner"))
  it("reasoner: reason", () => expect(inferTier("some-reason-model")).toBe("reasoner"))
  it("reasoner: r1", () => expect(inferTier("deepseek-r1-zero")).toBe("reasoner"))
  it("reasoner: sonnet (pre-4 variant)", () =>
    expect(inferTier("claude-sonnet-3-5")).toBe("reasoner"))
  it("reasoner: medium", () => expect(inferTier("command-medium")).toBe("reasoner"))
  it("reasoner: 70b", () => expect(inferTier("llama-3.1-70b")).toBe("reasoner"))
  it("reasoner: deepseek (chat, no r1)", () =>
    expect(inferTier("deepseek-chat")).toBe("reasoner"))

  // cheap branch
  it("cheap: haiku", () => expect(inferTier("claude-haiku-3")).toBe("cheap"))
  it("cheap: mini", () => expect(inferTier("phi-3-mini")).toBe("cheap"))
  it("cheap: nano", () => expect(inferTier("gemini-nano-1")).toBe("cheap"))
  it("cheap: flash", () => expect(inferTier("gemini-flash-1.5")).toBe("cheap"))
  it("cheap: qwen (no 32b)", () => expect(inferTier("qwen/qwen-coder")).toBe("cheap"))
  it("cheap: 8b", () => expect(inferTier("llama-3-8b")).toBe("cheap"))
  it("cheap: 7b", () => expect(inferTier("mistral-7b")).toBe("cheap"))
  it("cheap: small", () => expect(inferTier("phi-small-128k")).toBe("cheap"))
  it("cheap: lite", () => expect(inferTier("mixtral-lite")).toBe("cheap"))

  // econ's pinned tier models — recognised authoritatively (via the registry binding) before the
  // generic heuristic, whose substrings can collide on pinned ids. Regression guard for the
  // savings-receipt bug where a conductor turn was mislabelled a large tier. Derived from
  // ECON_TIER_BINDING so a model swap keeps guarding the CURRENT binding, not a stale id.
  // conductor/executor now resolve to their own exact tier, not a collapsed "cheap".
  it("econ conductor model resolves to its exact tier (registry beats name heuristic)", () =>
    expect(inferTier(ECON_TIER_BINDING.conductor)).toBe("conductor"))
  it("econ executor model resolves to its exact tier (not unknown)", () =>
    expect(inferTier(ECON_TIER_BINDING.executor)).toBe("executor"))
  it("econ oracle model resolves to oracle", () =>
    expect(inferTier(ECON_TIER_BINDING.oracle)).toBe("oracle"))
  it("econ reasoner model resolves to reasoner", () =>
    expect(inferTier(ECON_TIER_BINDING.reasoner)).toBe("reasoner"))
  it("generic deepseek (non-flash) stays reasoner", () =>
    expect(inferTier("deepseek-chat")).toBe("reasoner"))
  it("resolves a 'litellm/'-prefixed gateway ref to the same tier as the bare model id", () =>
    expect(inferTier(`litellm/${ECON_TIER_BINDING.conductor}`)).toBe(
      inferTier(ECON_TIER_BINDING.conductor),
    ))

  // fallback
  it("unknown: unrecognised model", () =>
    expect(inferTier("my-custom-model-v1")).toBe("unknown"))
  it("is case-insensitive", () => expect(inferTier("Claude-HAIKU-3")).toBe("cheap"))
})

// ---------------------------------------------------------------------------
// emitUsageEvent
// ---------------------------------------------------------------------------

describe("tierFromAgent", () => {
  // Agent-name tier claim — used by attributeTier as a disambiguator/fallback only. conductor
  // and executor are no longer merged into "cheap" — the receipt groups small vs large tiers
  // itself.
  it("conductor is conductor", () => expect(tierFromAgent("conductor")).toBe("conductor"))
  it("executor is executor", () => expect(tierFromAgent("executor")).toBe("executor"))
  it("reasoner is reasoner (not oracle)", () => expect(tierFromAgent("reasoner")).toBe("reasoner"))
  it("oracle is oracle", () => expect(tierFromAgent("oracle")).toBe("oracle"))
  it("non-econ agent is unknown (caller falls back to inferTier)", () =>
    expect(tierFromAgent("build")).toBe("unknown"))

  // OL-9.1: every ECON_PERSONAS agent runs on the executor model, so it must attribute to
  // "executor" too — derived from the constant (not a hardcoded name list) so a new persona
  // added to the registry stays covered automatically.
  for (const persona of ECON_PERSONAS) {
    it(`persona "${persona}" attributes to executor`, () =>
      expect(tierFromAgent(persona)).toBe("executor"))
  }
})

describe("attributeTier", () => {
  // W9 regression guard (2026-07-06 benchmark): spend must be attributed by the model that
  // billed, not by the dispatching agent's name — an agent named after one tier running
  // another tier's model previously relabelled the whole escalation in the receipt.
  it("model beats a disagreeing agent name (reasoner model under an oracle-named agent)", () =>
    expect(attributeTier(ECON_TIER_BINDING.reasoner, "oracle")).toBe("reasoner"))
  it("model beats a disagreeing agent name (conductor model under a reasoner-named agent)", () =>
    expect(attributeTier(ECON_TIER_BINDING.conductor, "reasoner")).toBe("conductor"))
  it("gateway-prefixed model ref still wins over the agent name", () =>
    expect(attributeTier(`litellm/${ECON_TIER_BINDING.reasoner}`, "oracle")).toBe("reasoner"))

  // Every pinned binding resolves to its exact tier with no agent hint at all.
  for (const [tier, model] of Object.entries(ECON_TIER_BINDING)) {
    it(`binding "${tier}" resolves from model id alone`, () =>
      expect(attributeTier(model)).toBe(tier))
  }

  // Agent name is the fallback when the model id resolves to nothing.
  it("unknown model falls back to the agent name", () =>
    expect(attributeTier("my-custom-model-v1", "reasoner")).toBe("reasoner"))
  it("unknown model + persona agent attributes to executor", () =>
    expect(attributeTier("my-custom-model-v1", ECON_PERSONAS[0]!)).toBe("executor"))
  it("unknown model + non-econ agent falls back to the name heuristic", () =>
    expect(attributeTier("claude-haiku-3", "build")).toBe("cheap"))
  it("unknown model + no agent is unknown", () =>
    expect(attributeTier("my-custom-model-v1")).toBe("unknown"))
})

describe("emitUsageEvent", () => {
  it("returns a normalised UsageEvent with correct fields", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw())
    expect(event.sessionID).toBe(SESSION)
    expect(event.model).toBe("claude-haiku-3")
    expect(event.timestamp).toBe(TS)
    expect(event.cost).toBe(0.0008)
    expect(event.tokens.input).toBe(1000)
    expect(event.tokens.output).toBe(200)
    expect(event.tokens.cacheRead).toBe(400)
    expect(event.tokens.cacheWrite).toBe(100)
    expect(event.tokens.reasoning).toBe(0)
  })

  it("appends the event to the store", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, cheapRaw())
    expect(store.count).toBe(1)
  })

  it("returned event is the same object the store holds", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw())
    expect(store.latest()).toBe(event)
  })

  it("infers tier from model when tier is omitted", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw())
    expect(event.tier).toBe("cheap")
  })

  it("uses explicit tier override instead of inference", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw({ tier: "oracle" }))
    expect(event.tier).toBe("oracle")
  })

  it("clamps negative cost to 0", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw({ cost: -5 }))
    expect(event.cost).toBe(0)
  })

  it("clamps non-finite cost (Infinity) to 0", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw({ cost: Infinity }))
    expect(event.cost).toBe(0)
  })

  it("clamps negative token counts to 0", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw({ tokens: { input: -200, output: -50 } }))
    expect(event.tokens.input).toBe(0)
    expect(event.tokens.output).toBe(0)
  })

  it("wires toolCalls through from raw usage, defaulting to 0 when omitted", () => {
    const store = new TelemetryStore()
    const withCalls = emitUsageEvent(store, cheapRaw({ toolCalls: 3 }))
    expect(withCalls.toolCalls).toBe(3)
    const withoutCalls = emitUsageEvent(store, cheapRaw({ toolCalls: undefined }))
    expect(withoutCalls.toolCalls).toBe(0)
  })

  it("clamps a negative toolCalls to 0", () => {
    const store = new TelemetryStore()
    const event = emitUsageEvent(store, cheapRaw({ toolCalls: -2 }))
    expect(event.toolCalls).toBe(0)
  })

  it("calls the sink with the emitted event", () => {
    const store = new TelemetryStore()
    const received: ReturnType<typeof store.latest>[] = []
    emitUsageEvent(store, cheapRaw(), (e) => received.push(e))
    expect(received).toHaveLength(1)
    expect(received[0]?.sessionID).toBe(SESSION)
  })

  it("does not throw when sink is omitted", () => {
    const store = new TelemetryStore()
    expect(() => emitUsageEvent(store, cheapRaw())).not.toThrow()
  })

  it("uses Date.now() when timestamp is omitted", () => {
    const store = new TelemetryStore()
    const before = Date.now()
    const event = emitUsageEvent(store, { sessionID: SESSION, model: "claude-haiku-3" })
    const after = Date.now()
    expect(event.timestamp).toBeGreaterThanOrEqual(before)
    expect(event.timestamp).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// TelemetryStore
// ---------------------------------------------------------------------------

describe("TelemetryStore", () => {
  it("starts empty", () => {
    const store = new TelemetryStore()
    expect(store.count).toBe(0)
    expect(store.latest()).toBeUndefined()
    expect(store.all()).toHaveLength(0)
  })

  it("count increments with each appended event", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, cheapRaw())
    emitUsageEvent(store, oracleRaw())
    expect(store.count).toBe(2)
  })

  it("latest() returns the most recently appended event", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, cheapRaw())
    const oracle = emitUsageEvent(store, oracleRaw())
    expect(store.latest()).toBe(oracle)
  })

  it("all() returns events in arrival order", () => {
    const store = new TelemetryStore()
    const e1 = emitUsageEvent(store, cheapRaw())
    const e2 = emitUsageEvent(store, oracleRaw())
    expect(store.all()[0]).toBe(e1)
    expect(store.all()[1]).toBe(e2)
  })

  it("clear() resets count and latest to empty", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, cheapRaw())
    store.clear()
    expect(store.count).toBe(0)
    expect(store.latest()).toBeUndefined()
  })

  // ---- totals() -----------------------------------------------------------

  describe("totals()", () => {
    it("aggregates cost and token counts across multiple turns", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw({ cost: 0.001, tokens: { input: 1000, output: 200 } }))
      emitUsageEvent(store, cheapRaw({ cost: 0.002, tokens: { input: 500, output: 100 } }))
      const t = store.totals()
      expect(t.turns).toBe(2)
      expect(t.cost).toBeCloseTo(0.003)
      expect(t.tokens.input).toBe(1500)
      expect(t.tokens.output).toBe(300)
    })

    it("builds per-tier byTier breakdown with correct turns and cost", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw({ cost: 0.001, tokens: { input: 500, output: 100 } }))
      emitUsageEvent(store, oracleRaw({ cost: 0.02, tokens: { input: 800, output: 300 } }))
      const t = store.totals()
      expect(t.byTier["cheap"]?.turns).toBe(1)
      expect(t.byTier["cheap"]?.cost).toBeCloseTo(0.001)
      expect(t.byTier["oracle"]?.turns).toBe(1)
      expect(t.byTier["oracle"]?.cost).toBeCloseTo(0.02)
    })

    it("totalTokens equals sum of all 5 token fields across all events", () => {
      const store = new TelemetryStore()
      // cheapRaw: input=1000, output=200, reasoning=0, cacheRead=400, cacheWrite=100 → 1700
      emitUsageEvent(store, cheapRaw())
      // oracleRaw: input=800, output=400, rest=0 → 1200
      emitUsageEvent(store, oracleRaw())
      expect(store.totals().totalTokens).toBe(1700 + 1200)
    })

    it("aggregates toolCalls across turns, both top-level and per-tier", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw({ toolCalls: 2 }))
      emitUsageEvent(store, cheapRaw({ toolCalls: 3 }))
      emitUsageEvent(store, oracleRaw({ toolCalls: 1 }))
      const t = store.totals()
      expect(t.toolCalls).toBe(6)
      expect(t.byTier["cheap"]?.toolCalls).toBe(5)
      expect(t.byTier["oracle"]?.toolCalls).toBe(1)
    })

    it("peakContextTokens is the MAX prompt-side context (input+cacheRead+cacheWrite), not the sum", () => {
      const store = new TelemetryStore()
      // cheap turn 1: 1000+400+100 = 1500
      emitUsageEvent(
        store,
        cheapRaw({ tokens: { input: 1000, cache: { read: 400, write: 100 } } }),
      )
      // cheap turn 2 (smaller context): 200+50+0 = 250
      emitUsageEvent(store, cheapRaw({ tokens: { input: 200, cache: { read: 50 } } }))
      // oracle turn: 800+0+0 = 800 — a different tier's peak, smaller than the cheap tier's peak
      emitUsageEvent(store, oracleRaw({ tokens: { input: 800 } }))
      const t = store.totals()
      expect(t.byTier["cheap"]?.peakContextTokens).toBe(1500)
      expect(t.byTier["oracle"]?.peakContextTokens).toBe(800)
      expect(t.peakContextTokens).toBe(1500)
    })

    it("byTier rows expose the tokens breakdown, totalTokens, and per-tier cacheHitRatio", () => {
      const store = new TelemetryStore()
      emitUsageEvent(
        store,
        cheapRaw({ tokens: { input: 100, output: 20, cache: { read: 300, write: 0 } } }),
      )
      const t = store.totals()
      const cheap = t.byTier["cheap"]
      expect(cheap?.tokens).toEqual({
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 300,
        cacheWrite: 0,
      })
      expect(cheap?.totalTokens).toBe(420)
      // 300 / (300 + 100 + 0)
      expect(cheap?.cacheHitRatio).toBeCloseTo(300 / 400)
    })
  })

  // ---- cacheHitRatio() ----------------------------------------------------

  describe("cacheHitRatio()", () => {
    it("returns 0 when store is empty", () => {
      const store = new TelemetryStore()
      expect(store.cacheHitRatio()).toBe(0)
    })

    it("returns 0 when there are no cache reads, even though cacheWrite alone makes the denominator nonzero", () => {
      const store = new TelemetryStore()
      // cache-write only — no cacheRead, no input; denom=500 (cacheWrite counts as a miss), ratio=0
      emitUsageEvent(store, cheapRaw({ tokens: { cache: { write: 500 } } }))
      expect(store.cacheHitRatio()).toBe(0)
    })

    it("= cacheRead / (cacheRead + input + cacheWrite)", () => {
      const store = new TelemetryStore()
      // cheapRaw: cacheRead=400, input=1000, cacheWrite=100 → 400/1500
      emitUsageEvent(store, cheapRaw())
      expect(store.cacheHitRatio()).toBeCloseTo(400 / 1500)
    })

    it("includes cacheWrite in the denominator as a miss (write tokens missed the cache)", () => {
      const store = new TelemetryStore()
      // cacheRead=200, cacheWrite=800, input=200 → 200/(200+200+800) = 1/6
      emitUsageEvent(
        store,
        cheapRaw({ tokens: { input: 200, cache: { read: 200, write: 800 } } }),
      )
      expect(store.cacheHitRatio()).toBeCloseTo(200 / 1200)
    })

    it("accumulates cacheRead and input across multiple events", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw({ tokens: { input: 1000, cache: { read: 0 } } }))
      emitUsageEvent(store, cheapRaw({ tokens: { input: 0, cache: { read: 500 } } }))
      // read=500, input=1000 → 500/1500
      expect(store.cacheHitRatio()).toBeCloseTo(500 / 1500)
    })
  })

  // ---- status() -----------------------------------------------------------

  describe("status()", () => {
    it("returns undefined tier and model when empty", () => {
      const store = new TelemetryStore()
      const s = store.status()
      expect(s.tier).toBeUndefined()
      expect(s.model).toBeUndefined()
      expect(s.latestTokens).toBe(0)
      expect(s.turns).toBe(0)
    })

    it("tier and model reflect the LATEST event", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw())
      emitUsageEvent(store, oracleRaw())
      const s = store.status()
      expect(s.tier).toBe("oracle")
      expect(s.model).toBe("anthropic/claude-opus-4")
    })

    it("contextFill = latestTokens / contextLimit when limit given", () => {
      const store = new TelemetryStore()
      // cheapRaw tokens: 1000+200+0+400+100 = 1700
      emitUsageEvent(store, cheapRaw())
      const s = store.status(8000)
      expect(s.contextFill).toBeCloseTo(1700 / 8000)
      expect(s.latestTokens).toBe(1700)
    })

    it("contextFill is undefined when no contextLimit given", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw())
      expect(store.status().contextFill).toBeUndefined()
    })

    it("cumulativeCost sums all events", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw({ cost: 0.001 }))
      emitUsageEvent(store, oracleRaw({ cost: 0.02 }))
      expect(store.status().cumulativeCost).toBeCloseTo(0.021)
    })

    it("turns equals the number of recorded events", () => {
      const store = new TelemetryStore()
      emitUsageEvent(store, cheapRaw())
      emitUsageEvent(store, oracleRaw())
      expect(store.status().turns).toBe(2)
    })
  })
})

// ---------------------------------------------------------------------------
// installUsageSink
// ---------------------------------------------------------------------------

describe("installUsageSink", () => {
  it("sets globalThis.__econUsageSink to a function", () => {
    const store = new TelemetryStore()
    const dispose = installUsageSink(store)
    expect(typeof (globalThis as any).__econUsageSink).toBe("function")
    dispose()
  })

  it("calling the sink appends an event to the store", () => {
    const store = new TelemetryStore()
    const dispose = installUsageSink(store)
    ;(globalThis as any).__econUsageSink(cheapRaw())
    expect(store.count).toBe(1)
    dispose()
  })

  it("calling the sink invokes the forward callback with the emitted event", () => {
    const store = new TelemetryStore()
    const forwarded: any[] = []
    const dispose = installUsageSink(store, (e) => forwarded.push(e))
    ;(globalThis as any).__econUsageSink(cheapRaw())
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.model).toBe("claude-haiku-3")
    dispose()
  })

  it("disposer removes globalThis.__econUsageSink", () => {
    const store = new TelemetryStore()
    const dispose = installUsageSink(store)
    dispose()
    expect((globalThis as any).__econUsageSink).toBeUndefined()
  })

  it("store is unaffected after disposer runs", () => {
    const store = new TelemetryStore()
    const dispose = installUsageSink(store)
    ;(globalThis as any).__econUsageSink(cheapRaw())
    dispose()
    // Events recorded before disposal remain
    expect(store.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// EfficiencyMetrics (AC-5.2)
// ---------------------------------------------------------------------------

describe("EfficiencyMetrics", () => {
  it("rolls up tokens-per-task across multiple recorded tasks", () => {
    const metrics = new EfficiencyMetrics()
    metrics.recordTask(1000)
    metrics.recordTask(3000)
    metrics.recordTask(2000)

    const snapshot = metrics.snapshot()
    expect(snapshot.tasksRecorded).toBe(3)
    expect(snapshot.totalTaskTokens).toBe(6000)
    expect(snapshot.tokensPerTask).toBe(2000)
  })

  it("tokensPerTask is 0 when no task has been recorded", () => {
    expect(new EfficiencyMetrics().snapshot().tokensPerTask).toBe(0)
  })

  it("clamps negative/non-finite task token counts to 0", () => {
    const metrics = new EfficiencyMetrics()
    metrics.recordTask(-500)
    metrics.recordTask(Number.POSITIVE_INFINITY)
    metrics.recordTask(100)
    const snapshot = metrics.snapshot()
    expect(snapshot.totalTaskTokens).toBe(100)
    expect(snapshot.tasksRecorded).toBe(3)
  })

  it("counts duplicate reads of the same file as re-reads", () => {
    const metrics = new EfficiencyMetrics()
    metrics.recordFileRead("src/a.ts")
    metrics.recordFileRead("src/b.ts")
    metrics.recordFileRead("src/a.ts")
    metrics.recordFileRead("src/a.ts")

    const snapshot = metrics.snapshot()
    expect(snapshot.totalFileReads).toBe(4)
    // a.ts read 3x -> 2 re-reads; b.ts read 1x -> 0 re-reads
    expect(snapshot.reReadCount).toBe(2)
    expect(snapshot.reReadRate).toBeCloseTo(0.5)
  })

  it("reReadRate is 0 when no files have been read", () => {
    expect(new EfficiencyMetrics().snapshot().reReadRate).toBe(0)
  })

  it("reReadCount is 0 when every file is read exactly once", () => {
    const metrics = new EfficiencyMetrics()
    metrics.recordFileRead("src/a.ts")
    metrics.recordFileRead("src/b.ts")
    const snapshot = metrics.snapshot()
    expect(snapshot.reReadCount).toBe(0)
    expect(snapshot.reReadRate).toBe(0)
  })

  it("records a post-compaction continuation signal as a plain counter, not a judged score", () => {
    const metrics = new EfficiencyMetrics()
    metrics.recordCompactionOutcome({ sessionID: SESSION, productiveContinuation: true })
    metrics.recordCompactionOutcome({ sessionID: SESSION, productiveContinuation: false })
    metrics.recordCompactionOutcome({ sessionID: SESSION, productiveContinuation: true })

    const snapshot = metrics.snapshot()
    expect(snapshot.compactions).toBe(3)
    expect(snapshot.productiveCompactions).toBe(2)
    expect(snapshot.postCompactionSuccessRate).toBeCloseTo(2 / 3)
  })

  it("postCompactionSuccessRate is undefined when no compaction has fired yet", () => {
    expect(new EfficiencyMetrics().snapshot().postCompactionSuccessRate).toBeUndefined()
  })

  it("forwards the compaction outcome event through the emit callback", () => {
    const metrics = new EfficiencyMetrics()
    const received: CompactionOutcomeEvent[] = []
    const event = metrics.recordCompactionOutcome(
      { sessionID: SESSION, productiveContinuation: true, timestamp: TS },
      (e) => received.push(e),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
    expect(event.timestamp).toBe(TS)
  })
})

// ---------------------------------------------------------------------------
// U6 — orchestration decode events
// ---------------------------------------------------------------------------

describe("emitTurnTriageEvent", () => {
  it("constructs a turn_triage event carrying every goal, stamping the given timestamp", () => {
    const event = emitTurnTriageEvent({
      sessionID: SESSION,
      goals: [
        { summary: "add retry to boot path", shape: "mechanical" },
        { summary: "explain the retry design", shape: "judgment" },
      ],
      timestamp: TS,
    })
    expect(event.type).toBe("turn_triage")
    expect(event.sessionID).toBe(SESSION)
    expect(event.timestamp).toBe(TS)
    expect(event.goals).toHaveLength(2)
    expect(event.goals[1]?.shape).toBe("judgment")
  })

  it("defaults timestamp to Date.now() when omitted", () => {
    const before = Date.now()
    const event = emitTurnTriageEvent({ sessionID: SESSION, goals: [] })
    expect(event.timestamp).toBeGreaterThanOrEqual(before)
  })

  it("forwards the built event through the optional sink", () => {
    const received: TurnTriageEvent[] = []
    const event = emitTurnTriageEvent(
      { sessionID: SESSION, goals: [{ summary: "x", shape: "mechanical" }], timestamp: TS },
      (e) => received.push(e),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
  })

  it("serializes and round-trips through JSON", () => {
    const event = emitTurnTriageEvent({
      sessionID: SESSION,
      goals: [{ summary: "x", shape: "mechanical" }],
      timestamp: TS,
    })
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })
})

describe("emitEvaluatorVerdictEvent", () => {
  it("constructs an evaluator_verdict event with tier, venue, and reasons", () => {
    const event = emitEvaluatorVerdictEvent({
      sessionID: SESSION,
      sliceId: "slice-1",
      tier: "reasoner",
      venue: "child",
      reasons: ["high fan-in", "history: prior fail"],
      timestamp: TS,
    })
    expect(event.type).toBe("evaluator_verdict")
    expect(event.sliceId).toBe("slice-1")
    expect(event.tier).toBe("reasoner")
    expect(event.venue).toBe("child")
    expect(event.reasons).toEqual(["high fan-in", "history: prior fail"])
    expect(event.timestamp).toBe(TS)
  })

  it("forwards the built event through the optional sink", () => {
    const received: EvaluatorVerdictEvent[] = []
    const event = emitEvaluatorVerdictEvent(
      { sessionID: SESSION, sliceId: "slice-1", tier: "executor", venue: "inline", reasons: [], timestamp: TS },
      (e) => received.push(e),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
  })

  it("serializes and round-trips through JSON", () => {
    const event = emitEvaluatorVerdictEvent({
      sessionID: SESSION,
      sliceId: "slice-1",
      tier: "executor",
      venue: "inline",
      reasons: ["low blast radius"],
      timestamp: TS,
    })
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })
})

describe("emitSliceContainedEvent", () => {
  it("constructs a slice_contained event, toTier omitted when the attempt wasn't re-dispatched", () => {
    const event = emitSliceContainedEvent({
      sessionID: SESSION,
      sliceId: "slice-1",
      fromTier: "executor",
      rungReason: "sound-reject",
      reverted: true,
      timestamp: TS,
    })
    expect(event.type).toBe("slice_contained")
    expect(event.fromTier).toBe("executor")
    expect(event.toTier).toBeUndefined()
    expect(event.rungReason).toBe("sound-reject")
    expect(event.reverted).toBe(true)
  })

  it("carries toTier when the slice was re-dispatched to a different tier", () => {
    const event = emitSliceContainedEvent({
      sessionID: SESSION,
      sliceId: "slice-1",
      fromTier: "executor",
      toTier: "conductor",
      rungReason: "behavior-gate",
      reverted: true,
      timestamp: TS,
    })
    expect(event.toTier).toBe("conductor")
  })

  it("forwards the built event through the optional sink", () => {
    const received: SliceContainedEvent[] = []
    const event = emitSliceContainedEvent(
      { sessionID: SESSION, sliceId: "slice-1", fromTier: "executor", rungReason: "shrink-reject", reverted: false, timestamp: TS },
      (e) => received.push(e),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
  })

  it("serializes and round-trips through JSON", () => {
    const event = emitSliceContainedEvent({
      sessionID: SESSION,
      sliceId: "slice-1",
      fromTier: "executor",
      toTier: "reasoner",
      rungReason: "qe-veto",
      reverted: true,
      timestamp: TS,
    })
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })
})

describe("emitEscalationProvenanceEvent", () => {
  it("constructs an escalation_provenance event naming from/to tier and the reason", () => {
    const event = emitEscalationProvenanceEvent({
      sessionID: SESSION,
      sliceId: "slice-1",
      fromTier: "executor",
      toTier: "oracle",
      reason: "verify-reject rung 3",
      timestamp: TS,
    })
    expect(event.type).toBe("escalation_provenance")
    expect(event.fromTier).toBe("executor")
    expect(event.toTier).toBe("oracle")
    expect(event.reason).toBe("verify-reject rung 3")
  })

  it("forwards the built event through the optional sink", () => {
    const received: EscalationProvenanceEvent[] = []
    const event = emitEscalationProvenanceEvent(
      { sessionID: SESSION, sliceId: "slice-1", fromTier: "conductor", toTier: "reasoner", reason: "stall", timestamp: TS },
      (e) => received.push(e),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
  })

  it("serializes and round-trips through JSON", () => {
    const event = emitEscalationProvenanceEvent({
      sessionID: SESSION,
      sliceId: "slice-1",
      fromTier: "conductor",
      toTier: "oracle",
      reason: "double-escalation",
      timestamp: TS,
    })
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })
})

describe("U6 decode events — no comparison-shaped fields (standing rule)", () => {
  it("none of the four event shapes ever serialize a frontier/counterfactual field", () => {
    const events = [
      emitTurnTriageEvent({ sessionID: SESSION, goals: [{ summary: "x", shape: "mechanical" }], timestamp: TS }),
      emitEvaluatorVerdictEvent({
        sessionID: SESSION,
        sliceId: "slice-1",
        tier: "reasoner",
        venue: "child",
        reasons: ["blast-radius"],
        timestamp: TS,
      }),
      emitSliceContainedEvent({
        sessionID: SESSION,
        sliceId: "slice-1",
        fromTier: "executor",
        toTier: "reasoner",
        rungReason: "shrink-reject",
        reverted: true,
        timestamp: TS,
      }),
      emitEscalationProvenanceEvent({
        sessionID: SESSION,
        sliceId: "slice-1",
        fromTier: "executor",
        toTier: "oracle",
        reason: "verify-reject",
        timestamp: TS,
      }),
    ]
    const serialized = JSON.stringify(events).toLowerCase()
    for (const banned of ["frontier", "counterfactual", "wouldhavecost", "netsaved", "grosssaved", "vsclaude", "vscursor"]) {
      expect(serialized).not.toContain(banned)
    }
  })
})
