/**
 * Unit tests for the fan-out wave planner (fanout.ts).
 * Pure — no I/O, no side effects. All functions are deterministic.
 */

import { describe, test, expect } from "bun:test"
import {
  isReadOnly,
  callsConflict,
  planFanoutWaves,
  isSingleWave,
  BATCH_THEN_FANOUT_RULE,
} from "../src/fanout.ts"
import type { FanoutCall } from "../src/fanout.ts"

// ---------------------------------------------------------------------------
// Helpers — construct FanoutCall objects
// ---------------------------------------------------------------------------

function readCall(id: string, reads: string[] = []): FanoutCall {
  return { id, tool: "read", reads }
}

function writeCall(id: string, writes: string[], reads: string[] = []): FanoutCall {
  return { id, tool: "edit", reads, writes }
}

// ---------------------------------------------------------------------------
// isReadOnly
// ---------------------------------------------------------------------------

describe("isReadOnly", () => {
  test("true when writes is absent", () => {
    expect(isReadOnly({ id: "a", tool: "read" })).toBe(true)
  })

  test("true when writes is an empty array", () => {
    expect(isReadOnly({ id: "a", tool: "read", writes: [] })).toBe(true)
  })

  test("false when writes has one or more paths", () => {
    expect(isReadOnly({ id: "b", tool: "edit", writes: ["src/foo.ts"] })).toBe(false)
  })

  test("false when writes has multiple paths", () => {
    expect(isReadOnly({ id: "c", tool: "edit", writes: ["a.ts", "b.ts"] })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// callsConflict
// ---------------------------------------------------------------------------

describe("callsConflict", () => {
  test("two read-only calls never conflict", () => {
    const a = readCall("a", ["src/foo.ts"])
    const b = readCall("b", ["src/foo.ts"])
    expect(callsConflict(a, b)).toBe(false)
  })

  test("write/write on the same path conflicts", () => {
    const a = writeCall("a", ["src/foo.ts"])
    const b = writeCall("b", ["src/foo.ts"])
    expect(callsConflict(a, b)).toBe(true)
  })

  test("write on path that other call reads conflicts (a writes, b reads)", () => {
    const a = writeCall("a", ["src/foo.ts"])
    const b = readCall("b", ["src/foo.ts"])
    expect(callsConflict(a, b)).toBe(true)
  })

  test("write on path that other call reads conflicts (b writes, a reads)", () => {
    const a = readCall("a", ["src/foo.ts"])
    const b = writeCall("b", ["src/foo.ts"])
    expect(callsConflict(a, b)).toBe(true)
  })

  test("disjoint write paths do not conflict", () => {
    const a = writeCall("a", ["src/foo.ts"])
    const b = writeCall("b", ["src/bar.ts"])
    expect(callsConflict(a, b)).toBe(false)
  })

  test("one writes path A, other reads path B only — no conflict", () => {
    const a = writeCall("a", ["src/foo.ts"])
    const b = readCall("b", ["src/bar.ts"])
    expect(callsConflict(a, b)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// planFanoutWaves
// ---------------------------------------------------------------------------

describe("planFanoutWaves", () => {
  test("empty input returns empty waves", () => {
    expect(planFanoutWaves([])).toEqual([])
  })

  test("fully-independent read-only calls return a single wave containing all", () => {
    const calls: FanoutCall[] = [
      readCall("a", ["src/a.ts"]),
      readCall("b", ["src/b.ts"]),
      readCall("c", ["src/c.ts"]),
    ]
    const waves = planFanoutWaves(calls)
    expect(waves.length).toBe(1)
    expect(waves[0].length).toBe(3)
  })

  test("disjoint-path write calls return a single wave", () => {
    const calls: FanoutCall[] = [
      writeCall("a", ["src/a.ts"]),
      writeCall("b", ["src/b.ts"]),
    ]
    const waves = planFanoutWaves(calls)
    expect(waves.length).toBe(1)
    expect(waves[0].length).toBe(2)
  })

  test("two calls writing the SAME path are split into 2 separate waves", () => {
    const calls: FanoutCall[] = [
      writeCall("a", ["src/shared.ts"]),
      writeCall("b", ["src/shared.ts"]),
    ]
    const waves = planFanoutWaves(calls)
    expect(waves.length).toBe(2)
    expect(waves[0].length).toBe(1)
    expect(waves[1].length).toBe(1)
  })

  test("preserves all calls: total count across waves equals input count", () => {
    const calls: FanoutCall[] = [
      writeCall("a", ["src/shared.ts"]),
      writeCall("b", ["src/shared.ts"]),
      readCall("c", ["src/other.ts"]),
      writeCall("d", ["src/another.ts"]),
    ]
    const waves = planFanoutWaves(calls)
    const total = waves.reduce((sum, w) => sum + w.length, 0)
    expect(total).toBe(calls.length)
  })

  test("a single call produces a single wave with one element", () => {
    const waves = planFanoutWaves([writeCall("a", ["src/foo.ts"])])
    expect(waves.length).toBe(1)
    expect(waves[0].length).toBe(1)
  })

  test("read call does not conflict with a write to a different path — stays in one wave", () => {
    const calls: FanoutCall[] = [
      writeCall("a", ["src/a.ts"]),
      readCall("b", ["src/b.ts"]),
    ]
    const waves = planFanoutWaves(calls)
    expect(waves.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// isSingleWave
// ---------------------------------------------------------------------------

describe("isSingleWave", () => {
  test("true for an independent read-only set", () => {
    const calls: FanoutCall[] = [
      readCall("a", ["src/a.ts"]),
      readCall("b", ["src/b.ts"]),
    ]
    expect(isSingleWave(calls)).toBe(true)
  })

  test("true for an empty set", () => {
    expect(isSingleWave([])).toBe(true)
  })

  test("false when a write/write conflict exists", () => {
    const calls: FanoutCall[] = [
      writeCall("a", ["src/shared.ts"]),
      writeCall("b", ["src/shared.ts"]),
    ]
    expect(isSingleWave(calls)).toBe(false)
  })

  test("false when a read/write conflict exists", () => {
    const calls: FanoutCall[] = [
      writeCall("a", ["src/foo.ts"]),
      readCall("b", ["src/foo.ts"]),
    ]
    expect(isSingleWave(calls)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// BATCH_THEN_FANOUT_RULE
// ---------------------------------------------------------------------------

describe("BATCH_THEN_FANOUT_RULE", () => {
  test("is a non-empty string", () => {
    expect(typeof BATCH_THEN_FANOUT_RULE).toBe("string")
    expect(BATCH_THEN_FANOUT_RULE.length).toBeGreaterThan(0)
  })
})
