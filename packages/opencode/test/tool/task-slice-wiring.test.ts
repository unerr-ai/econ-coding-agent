/**
 * Tests for buildChildPrompt (OL-7.7) in packages/opencode/src/tool/task.ts.
 *
 * Uses an injected SliceWiringGraph double (buildChildPrompt's third param,
 * default getGraph()) rather than the real graph singleton, so these tests
 * never trigger a full-repo background index. The wiring-cap / token-budget
 * contracts of the rendered block itself are covered separately by
 * packages/code-intelligence/test/slice-wiring.test.ts; this file covers
 * buildChildPrompt's own contract: gating (no slice metadata, the
 * ECON_SLICE_WIRING kill switch), a ready graph reaching the child prompt,
 * and a cold/slow graph never delaying the spawn past its budget.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { buildChildPrompt } from "../../src/tool/task"
import type { Entity, Reference, SliceWiringGraph } from "@opencode-ai/code-intelligence"

function makeReadyGraph(): SliceWiringGraph {
  const entity: Entity = {
    key: "packages/foo/dispatch.ts:dispatch:function",
    name: "dispatch",
    kind: "function",
    filePath: "packages/foo/dispatch.ts",
    lineStart: 1,
    lineEnd: 10,
    signature: "(input: string): void",
    contentHash: "abc123",
  }
  const caller: Reference = {
    fromEntity: "packages/foo/caller.ts:caller:function",
    fromFile: "packages/foo/caller.ts",
    toEntity: entity.key,
    kind: "call",
  }
  return {
    async search(query: string) {
      return query.toLowerCase().includes("dispatch") ? [entity] : []
    },
    async getCallers() {
      return [caller]
    },
  }
}

/** A graph double whose calls never resolve — simulates a cold/hung index. */
function makeColdGraph(): SliceWiringGraph {
  return {
    search: () => new Promise<Entity[]>(() => {}),
    getCallers: () => new Promise<Reference[]>(() => {}),
  }
}

describe("buildChildPrompt — gating", () => {
  const ORIGINAL_ENV = process.env["ECON_SLICE_WIRING"]

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env["ECON_SLICE_WIRING"]
    else process.env["ECON_SLICE_WIRING"] = ORIGINAL_ENV
  })

  it("returns the prompt unchanged when no slice metadata is present", async () => {
    const prompt = "Fix the off-by-one in the paginator."
    const result = await buildChildPrompt(prompt, undefined)
    expect(result).toBe(prompt)
  })

  it("returns the prompt unchanged when ECON_SLICE_WIRING=false, even with slice metadata", async () => {
    process.env["ECON_SLICE_WIRING"] = "false"
    const prompt = "Propagate the signature change to its callers."
    const result = await buildChildPrompt(prompt, { files: ["packages/foo/bar.ts"], entities: ["dispatch"] })
    expect(result).toBe(prompt)
  })

  it("returns the prompt unchanged when ECON_SLICE_WIRING=0, even with slice metadata", async () => {
    process.env["ECON_SLICE_WIRING"] = "0"
    const prompt = "Propagate the signature change to its callers."
    const result = await buildChildPrompt(prompt, { files: ["packages/foo/bar.ts"], entities: ["dispatch"] })
    expect(result).toBe(prompt)
  })
})

describe("buildChildPrompt — graph wiring", () => {
  it("appends the ready graph's wiring block to the child prompt", async () => {
    const prompt = "Propagate the signature change to its callers."
    const result = await buildChildPrompt(prompt, { entities: ["dispatch"] }, makeReadyGraph())
    expect(result).toContain(prompt)
    expect(result).toContain("dispatch")
    expect(result).toContain("Wiring")
  })

  it("proceeds without slice context and without throwing when the graph is cold", async () => {
    const prompt = "Propagate the signature change to its callers."
    const started = Date.now()
    const result = await buildChildPrompt(prompt, { entities: ["dispatch"] }, makeColdGraph())
    const elapsed = Date.now() - started
    expect(result).toBe(prompt)
    // Bounded well under a hang: the 500ms graph-access budget, not the
    // never-resolving graph double, is what ends this call.
    expect(elapsed).toBeLessThan(2000)
  })
})
