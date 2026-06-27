/**
 * Tests for packages/code-intelligence/src/checkpoint.ts
 *
 * Simulates a long-run session: ascending fill sequences, boundary conditions,
 * output-size guarantees, and hysteresis re-arm after compaction.
 */

import { describe, it, expect } from "bun:test"
import {
  createCheckpointState,
  shouldCheckpoint,
  buildCheckpoint,
  checkpointIfNeeded,
  DEFAULT_CHECKPOINT_CONFIG,
} from "../src/checkpoint.ts"
import type { CheckpointSnapshot, CheckpointState } from "../src/checkpoint.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): CheckpointSnapshot {
  return { scratchpad: {}, ledger: [], attempts: [] }
}

function snapshotWithScratchpad(keys: Record<string, unknown>): CheckpointSnapshot {
  return { scratchpad: keys, ledger: [], attempts: [] }
}

// ---------------------------------------------------------------------------
// 1. Ascending sequence fires exactly at 0.4, 0.6, 0.8 — once each
// ---------------------------------------------------------------------------

describe("checkpointIfNeeded — ascending fill sequence", () => {
  it("fires exactly at 0.4, 0.6, 0.8 for sequence [0.1,0.3,0.45,0.55,0.65,0.75,0.85]", () => {
    const state = createCheckpointState()
    const snapshot = emptySnapshot()
    const sequence = [0.1, 0.3, 0.45, 0.55, 0.65, 0.75, 0.85]
    const firedAt: number[] = []

    for (const ratio of sequence) {
      const result = checkpointIfNeeded(ratio, snapshot, state)
      if (result.fired && result.threshold !== null) {
        firedAt.push(result.threshold)
      }
    }

    expect(firedAt).toEqual([0.4, 0.6, 0.8])
    expect(state.count).toBe(3)
  })

  it("fires each threshold at most once per crossing (no duplicate fires)", () => {
    const state = createCheckpointState()
    const snapshot = emptySnapshot()
    // Cross 0.4 multiple times in one climb — still fires only once
    const sequence = [0.41, 0.42, 0.43, 0.5, 0.61, 0.62, 0.81, 0.82]
    let fires = 0
    for (const ratio of sequence) {
      const r = checkpointIfNeeded(ratio, snapshot, state)
      if (r.fired) fires++
    }
    expect(fires).toBe(3)
  })

  it("does not fire when fillRatio never crosses a threshold", () => {
    const state = createCheckpointState()
    const snapshot = emptySnapshot()
    for (const ratio of [0.0, 0.1, 0.2, 0.39]) {
      const r = checkpointIfNeeded(ratio, snapshot, state)
      expect(r.fired).toBe(false)
    }
    expect(state.count).toBe(0)
  })

  it("fired result includes a non-null context string", () => {
    const state = createCheckpointState()
    const snapshot = snapshotWithScratchpad({ goal: "test" })
    const result = checkpointIfNeeded(0.45, snapshot, state)
    expect(result.fired).toBe(true)
    expect(typeof result.context).toBe("string")
    expect((result.context ?? "").length).toBeGreaterThan(0)
  })

  it("non-fired result has null context and null threshold", () => {
    const state = createCheckpointState()
    const snapshot = emptySnapshot()
    const result = checkpointIfNeeded(0.1, snapshot, state)
    expect(result.fired).toBe(false)
    expect(result.context).toBeNull()
    expect(result.threshold).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. buildCheckpoint output length <= maxContextChars with large inputs
// ---------------------------------------------------------------------------

describe("buildCheckpoint — output size guarantee", () => {
  it("stays within maxContextChars with a 5 000-entry ledger", () => {
    const ledger = Array.from({ length: 5000 }, (_, i) => ({
      tool: `tool-${i}`,
      result: `result of action ${i} — some reasonably long result text`,
      seq: i,
    }))
    const snapshot: CheckpointSnapshot = {
      scratchpad: { currentTask: "write checkpoint module", phase: "Sprint 5" },
      ledger,
      attempts: [{ task: "write tests", status: "in-progress" }],
    }
    const out = buildCheckpoint(snapshot)
    expect(out.length).toBeLessThanOrEqual(DEFAULT_CHECKPOINT_CONFIG.maxContextChars)
  })

  it("stays within a custom small maxContextChars", () => {
    const ledger = Array.from({ length: 100 }, (_, i) => ({
      tool: `tool-${i}`,
      result: `result-${i}`,
      seq: i,
    }))
    const snapshot: CheckpointSnapshot = {
      scratchpad: { key: "value" },
      ledger,
      attempts: [],
    }
    const config = { ...DEFAULT_CHECKPOINT_CONFIG, maxContextChars: 500 }
    const out = buildCheckpoint(snapshot, config)
    expect(out.length).toBeLessThanOrEqual(500)
  })

  it("never throws on huge or empty inputs", () => {
    // Huge
    const hugeSnapshot: CheckpointSnapshot = {
      scratchpad: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, `v${i}`])),
      ledger: Array.from({ length: 10000 }, (_, i) => ({ tool: `t${i}`, result: "x".repeat(200), seq: i })),
      attempts: Array.from({ length: 100 }, (_, i) => ({ task: `task-${i}`, status: "failure" })),
      taskTree: "# Tasks\n" + "- item\n".repeat(500),
    }
    expect(() => buildCheckpoint(hugeSnapshot)).not.toThrow()

    // Empty
    expect(() => buildCheckpoint(emptySnapshot())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. Load-bearing state preservation
// ---------------------------------------------------------------------------

describe("buildCheckpoint — preserves load-bearing state", () => {
  it("includes every scratchpad key in the output", () => {
    const snapshot = snapshotWithScratchpad({
      goal: "write tests",
      context: "sprint 5",
      status: "in-progress",
      priority: "high",
    })
    const out = buildCheckpoint(snapshot)
    expect(out).toContain("goal")
    expect(out).toContain("context")
    expect(out).toContain("status")
    expect(out).toContain("priority")
  })

  it("includes scratchpad values in the output", () => {
    const snapshot = snapshotWithScratchpad({ phase: "Sprint 5", owner: "agent" })
    const out = buildCheckpoint(snapshot)
    expect(out).toContain("Sprint 5")
    expect(out).toContain("agent")
  })

  it("preserves all scratchpad keys even when ledger is large (budget pressure)", () => {
    const keys = { alpha: "a", beta: "b", gamma: "c", delta: "d" }
    const snapshot: CheckpointSnapshot = {
      scratchpad: keys,
      ledger: Array.from({ length: 5000 }, (_, i) => ({
        tool: `tool-${i}`,
        result: "x".repeat(100),
        seq: i,
      })),
      attempts: [],
    }
    const out = buildCheckpoint(snapshot)
    // Every key must survive even under budget pressure
    for (const k of Object.keys(keys)) {
      expect(out).toContain(k)
    }
    expect(out.length).toBeLessThanOrEqual(DEFAULT_CHECKPOINT_CONFIG.maxContextChars)
  })

  it("includes most-recent ledger entries (not oldest) when ledger exceeds maxLedgerEntries", () => {
    const ledger = Array.from({ length: 30 }, (_, i) => ({
      tool: `tool-${i}`,
      result: `result-${i}`,
      seq: i,
    }))
    const snapshot: CheckpointSnapshot = { scratchpad: {}, ledger, attempts: [] }
    const out = buildCheckpoint(snapshot)
    // Most-recent entries (seq 29 and 28) should appear
    expect(out).toContain("tool-29")
    expect(out).toContain("tool-28")
  })

  it("omits oldest ledger entries when over maxLedgerEntries cap", () => {
    const ledger = Array.from({ length: 30 }, (_, i) => ({
      tool: `tool-${i}`,
      result: `r-${i}`,
      seq: i,
    }))
    const snapshot: CheckpointSnapshot = { scratchpad: {}, ledger, attempts: [] }
    // Default maxLedgerEntries = 20, so entries 0–9 should be excluded
    const out = buildCheckpoint(snapshot)
    expect(out).not.toContain("tool-0")
    expect(out).not.toContain("tool-9")
  })

  it("includes taskTree when provided", () => {
    const snapshot: CheckpointSnapshot = {
      scratchpad: {},
      ledger: [],
      attempts: [],
      taskTree: "## Tasks\n- [x] step one\n- [ ] step two",
    }
    const out = buildCheckpoint(snapshot)
    expect(out).toContain("step one")
    expect(out).toContain("step two")
  })

  it("output contains the Checkpoint header", () => {
    const out = buildCheckpoint(emptySnapshot())
    expect(out).toContain("## Checkpoint")
  })
})

// ---------------------------------------------------------------------------
// 4. Hysteresis re-arm — threshold fires again after context shrinks
// ---------------------------------------------------------------------------

describe("shouldCheckpoint / checkpointIfNeeded — re-arm after compaction", () => {
  it("re-fires 0.6 after all thresholds fire then context shrinks to 0.2", () => {
    const state = createCheckpointState()
    const snapshot = emptySnapshot()

    // First pass: fire all three thresholds
    checkpointIfNeeded(0.45, snapshot, state) // fires 0.4
    checkpointIfNeeded(0.65, snapshot, state) // fires 0.6
    checkpointIfNeeded(0.85, snapshot, state) // fires 0.8
    expect(state.count).toBe(3)
    expect(state.firedThresholds).toEqual([0.4, 0.6, 0.8])

    // Simulate post-compaction shrink: context drops to 0.2 — no new fire
    const shrink = checkpointIfNeeded(0.2, snapshot, state)
    expect(shrink.fired).toBe(false)
    expect(state.count).toBe(3)

    // Re-arm: firedThresholds above 0.2 have been pruned
    expect(state.firedThresholds).toEqual([])

    // Climb back to 0.65 — 0.6 should fire again
    const refire = checkpointIfNeeded(0.65, snapshot, state)
    expect(refire.fired).toBe(true)
    expect(refire.threshold).toBe(0.6)
    expect(state.count).toBe(4)
  })

  it("re-fires 0.4 after shrinking below 0.4", () => {
    const state = createCheckpointState()
    const snapshot = emptySnapshot()

    checkpointIfNeeded(0.45, snapshot, state) // fires 0.4
    expect(state.count).toBe(1)

    // Shrink below 0.4
    checkpointIfNeeded(0.35, snapshot, state)
    expect(state.count).toBe(1)
    expect(state.firedThresholds).toEqual([]) // 0.4 pruned

    // Climb back past 0.4
    const refire = checkpointIfNeeded(0.42, snapshot, state)
    expect(refire.fired).toBe(true)
    expect(refire.threshold).toBe(0.4)
    expect(state.count).toBe(2)
  })

  it("partial re-arm: shrinking to 0.5 re-arms 0.6 and 0.8 but not 0.4", () => {
    const state = createCheckpointState()
    const snapshot = emptySnapshot()

    checkpointIfNeeded(0.45, snapshot, state) // fires 0.4
    checkpointIfNeeded(0.65, snapshot, state) // fires 0.6
    checkpointIfNeeded(0.85, snapshot, state) // fires 0.8

    // Shrink to 0.5 — only thresholds > 0.5 are pruned (0.6, 0.8)
    shouldCheckpoint(0.5, state) // prunes 0.6 and 0.8 from firedThresholds
    expect(state.firedThresholds).toEqual([0.4])

    // 0.4 is still fired — climbing to 0.55 should not re-fire 0.4
    const r = checkpointIfNeeded(0.55, snapshot, state)
    expect(r.fired).toBe(false)

    // Climbing to 0.65 should fire 0.6 again
    const r2 = checkpointIfNeeded(0.65, snapshot, state)
    expect(r2.fired).toBe(true)
    expect(r2.threshold).toBe(0.6)
  })
})

// ---------------------------------------------------------------------------
// 5. shouldCheckpoint — standalone contract
// ---------------------------------------------------------------------------

describe("shouldCheckpoint — standalone", () => {
  it("returns fire=false and threshold=null below all thresholds", () => {
    const state = createCheckpointState()
    const r = shouldCheckpoint(0.1, state)
    expect(r.fire).toBe(false)
    expect(r.threshold).toBeNull()
  })

  it("returns the highest crossed threshold, not just any crossed threshold", () => {
    const state = createCheckpointState()
    // fillRatio crosses both 0.4 and 0.6 — should fire at 0.6
    const r = shouldCheckpoint(0.65, state)
    expect(r.threshold).toBe(0.6)
  })

  it("respects custom config thresholds", () => {
    const state = createCheckpointState()
    const config = { thresholds: [0.5, 0.9], maxContextChars: 8000, maxLedgerEntries: 20 }
    const r = shouldCheckpoint(0.75, state, config)
    expect(r.fire).toBe(true)
    expect(r.threshold).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// 6. createCheckpointState
// ---------------------------------------------------------------------------

describe("createCheckpointState", () => {
  it("returns a fresh state with empty firedThresholds and count=0", () => {
    const state: CheckpointState = createCheckpointState()
    expect(state.firedThresholds).toEqual([])
    expect(state.count).toBe(0)
  })

  it("returns independent instances on repeated calls", () => {
    const a = createCheckpointState()
    const b = createCheckpointState()
    a.count = 5
    expect(b.count).toBe(0)
  })
})
