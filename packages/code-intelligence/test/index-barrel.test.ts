/**
 * Regression test for the barrel name collision (FIX-9): the package used to
 * export TWO unrelated functions named `planWaves` — slice-loop.ts's DAG
 * wave scheduler (star-exported) and fanout.ts's read/write-conflict planner
 * (explicit named export, which shadowed the star-export per ESM semantics).
 * This asserts the barrel's public `planWaves` is unambiguously the DAG
 * scheduler by feeding it a 2-wave dependency graph and checking wave shape.
 */

import { describe, test, expect } from "bun:test"
import { planWaves } from "../src/index.ts"

describe("barrel planWaves (index.ts)", () => {
  test("is the DAG wave scheduler — orders a 2-wave dependency graph", () => {
    const waves = planWaves([
      { id: "a", prompt: "" },
      { id: "b", prompt: "" },
      { id: "c", prompt: "", deps: ["a", "b"] },
    ])
    expect(waves.length).toBe(2)
    expect(new Set(waves[0])).toEqual(new Set(["a", "b"]))
    expect(waves[1]).toEqual(["c"])
  })

  test("throws on an unknown dependency (fanout's planner never throws)", () => {
    expect(() => planWaves([{ id: "a", prompt: "", deps: ["ghost"] }])).toThrow(/unknown slice/)
  })
})
