/**
 * Tests for packages/code-intelligence/src/slice-wiring.ts (OL-7.7)
 *
 * Verifies three contracts:
 *  (a) The wiring block stays within its hard token cap and marks truncation
 *      explicitly rather than silently dropping content.
 *  (b) A cold/erroring graph degrades to an empty wiring block instead of
 *      throwing.
 *  (c) externalUnknowns render as a bounded placeholder section.
 */
import { describe, it, expect } from "bun:test"
import { assembleSliceWiring, type SliceWiringGraph } from "../src/slice-wiring.ts"
import type { Entity, Reference } from "../src/index.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<Entity> & { name: string }): Entity {
  return {
    key: `packages/foo/${overrides.name}.ts:${overrides.name}:function`,
    kind: "function",
    filePath: `packages/foo/${overrides.name}.ts`,
    lineStart: 1,
    lineEnd: 20,
    signature: `(input: string): void`,
    contentHash: "abc123",
    ...overrides,
  }
}

function makeCaller(fromEntity: string, fromFile: string): Reference {
  return { fromEntity, fromFile, toEntity: "target", kind: "call" }
}

/** A graph double with a fixed entity/caller table — no bun:sqlite involved. */
function makeStubGraph(opts: {
  entities: Entity[]
  callersByKey?: Record<string, Reference[]>
}): SliceWiringGraph {
  return {
    async search(query: string) {
      const q = query.toLowerCase()
      return opts.entities.filter((e) => e.name.toLowerCase().includes(q))
    },
    async getCallers(entityKey: string) {
      return opts.callersByKey?.[entityKey] ?? []
    },
  }
}

// ---------------------------------------------------------------------------
// (a) Hard token cap
// ---------------------------------------------------------------------------

describe("assembleSliceWiring — token cap", () => {
  it("stays within the given token budget and marks truncation explicitly", async () => {
    // Eight distinct entities, each with a long caller list, forced through a
    // tiny budget so at least one entity must be dropped.
    const entities = Array.from({ length: 8 }, (_, i) => makeEntity({ name: `handleRequest${i}` }))
    const callersByKey: Record<string, Reference[]> = {}
    for (const e of entities) {
      callersByKey[e.key] = Array.from({ length: 10 }, (_, i) => makeCaller(`caller${i}`, `packages/bar/caller${i}.ts`))
    }
    const graph = makeStubGraph({ entities, callersByKey })

    const result = await assembleSliceWiring(
      { text: "wire up handleRequest0 handleRequest1 handleRequest2", tokenBudget: 200 },
      graph,
    )

    expect(result.truncated).toBe(true)
    expect(result.text).toContain("[wiring truncated")
    expect(result.estimatedTokens).toBeLessThanOrEqual(200 + 60) // budget + marker/heading overhead
  })

  it("does not truncate when everything fits comfortably", async () => {
    const entity = makeEntity({ name: "smallHelper" })
    const graph = makeStubGraph({ entities: [entity], callersByKey: { [entity.key]: [makeCaller("caller0", "packages/bar/caller0.ts")] } })

    const result = await assembleSliceWiring({ text: "touch smallHelper please", tokenBudget: 2500 }, graph)

    expect(result.truncated).toBe(false)
    expect(result.text).not.toContain("[wiring truncated")
    expect(result.text).toContain("smallHelper")
    expect(result.entityCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// (b) Graceful degrade
// ---------------------------------------------------------------------------

describe("assembleSliceWiring — graceful degrade", () => {
  it("returns an empty wiring block instead of throwing when the graph is cold (search throws)", async () => {
    const coldGraph: SliceWiringGraph = {
      async search() {
        throw new Error("index not ready")
      },
      async getCallers() {
        throw new Error("index not ready")
      },
    }

    const result = await assembleSliceWiring({ text: "wire up handleRequest" }, coldGraph)

    expect(result).toEqual({ text: "", estimatedTokens: 0, truncated: false, entityCount: 0 })
  })

  it("returns an empty wiring block when the graph resolves no entities", async () => {
    const emptyGraph = makeStubGraph({ entities: [] })

    const result = await assembleSliceWiring({ text: "nothing matches this prompt text" }, emptyGraph)

    expect(result.text).toBe("")
    expect(result.entityCount).toBe(0)
  })

  it("skips an entity whose getCallers call throws rather than failing the whole block", async () => {
    const entity = makeEntity({ name: "flaky" })
    const graph: SliceWiringGraph = {
      async search() {
        return [entity]
      },
      async getCallers() {
        throw new Error("boom")
      },
    }

    const result = await assembleSliceWiring({ text: "touch flaky" }, graph)

    expect(result.text).toContain("flaky")
    expect(result.text).toContain("Callers: none found")
  })
})

// ---------------------------------------------------------------------------
// (c) External unknowns placeholder
// ---------------------------------------------------------------------------

describe("assembleSliceWiring — external unknowns", () => {
  it("renders a bounded External Unknowns section instructing a web lookup", async () => {
    const graph = makeStubGraph({ entities: [] })

    const result = await assembleSliceWiring(
      { text: "irrelevant", externalUnknowns: ["latest Stripe webhook signature format"] },
      graph,
    )

    expect(result.text).toContain("## External Unknowns")
    expect(result.text).toContain("latest Stripe webhook signature format")
    expect(result.text).toContain("bounded web lookup")
  })
})

// ---------------------------------------------------------------------------
// (d) Caller dedup
// ---------------------------------------------------------------------------

describe("assembleSliceWiring — caller dedup", () => {
  it("an import edge + a call edge from the same file render as ONE distinct caller", async () => {
    const entity = makeEntity({ name: "dupTarget" })
    const graph = makeStubGraph({
      entities: [entity],
      callersByKey: {
        [entity.key]: [
          makeCaller("", "packages/bar/dupCaller.ts"),
          makeCaller("useDupTarget", "packages/bar/dupCaller.ts"),
        ],
      },
    })

    const result = await assembleSliceWiring({ text: "touch dupTarget" }, graph)

    expect(result.text).toContain("Callers (1):")
  })
})
