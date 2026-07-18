/**
 * G1 — get_references row-building tests. Exercises `buildReferenceRows`
 * (graph-tools-enrich.ts) directly against an in-memory mock `RefGraphPort` —
 * no Effect runtime, no real BunSqliteGraph — matching the sibling
 * enrichEntities tests in graph-tools-sprint2b.test.ts.
 */
import { describe, it, expect } from "bun:test"
import {
  buildReferenceRows,
  RSK_CALLER_THRESHOLD,
  type RefEntity,
  type RefEdge,
  type RefGraphPort,
} from "../../src/tool/graph-tools-enrich"

// ---------------------------------------------------------------------------
// Mock graph fixture
// ---------------------------------------------------------------------------
//
//   caller1..caller12 → hub          (12 callers — chokepoint fan-in)
//   hub               → aggregator   (aggregator's one caller is the hub itself,
//                                      so a "callers of aggregator" row surfaces
//                                      hub's own high fan-in)
//   tip → mid → root                 (a 2-hop chain for depth:2)
//   cycleA ⇄ cycleB                  (a mutual pair for the cycle guard)
//   leaf                             (indexed, zero callers)
//
const ENTITIES: Record<string, RefEntity> = {
  "hub.ts:hub:function": { name: "hub", kind: "function", filePath: "hub.ts", lineStart: 1 },
  "aggregator.ts:aggregator:function": { name: "aggregator", kind: "function", filePath: "aggregator.ts", lineStart: 1 },
  "leaf.ts:leaf:function": { name: "leaf", kind: "function", filePath: "leaf.ts", lineStart: 1 },
  "root.ts:root:function": { name: "root", kind: "function", filePath: "root.ts", lineStart: 1 },
  "mid.ts:mid:function": { name: "mid", kind: "function", filePath: "mid.ts", lineStart: 1 },
  "tip.ts:tip:function": { name: "tip", kind: "function", filePath: "tip.ts", lineStart: 1 },
  "cycleA.ts:cycleA:function": { name: "cycleA", kind: "function", filePath: "cycleA.ts", lineStart: 1 },
  "cycleB.ts:cycleB:function": { name: "cycleB", kind: "function", filePath: "cycleB.ts", lineStart: 1 },
}
// caller1..caller12 carry semantic fields on caller1 only, to verify propagation.
for (let i = 1; i <= 12; i++) {
  ENTITIES[`caller${i}.ts:caller${i}:function`] = {
    name: `caller${i}`,
    kind: "function",
    filePath: `caller${i}.ts`,
    lineStart: 1,
    ...(i === 1 ? { domain: "routing", role: "dispatch", summary: "Routes the turn to a tier." } : {}),
  }
}

function edge(fromEntity: string, fromFile: string, toEntity: string): RefEdge {
  return { fromEntity, fromFile, toEntity, kind: "call" }
}

const CALLERS_BY_KEY: Record<string, RefEdge[]> = {
  "hub.ts:hub:function": Array.from({ length: 12 }, (_, i) => edge(`caller${i + 1}`, `caller${i + 1}.ts`, "hub")),
  "aggregator.ts:aggregator:function": [edge("hub", "hub.ts", "aggregator")],
  "root.ts:root:function": [edge("mid", "mid.ts", "root")],
  "mid.ts:mid:function": [edge("tip", "tip.ts", "mid")],
  "cycleA.ts:cycleA:function": [edge("cycleB", "cycleB.ts", "cycleA")],
  "cycleB.ts:cycleB:function": [edge("cycleA", "cycleA.ts", "cycleB")],
  // leaf.ts:leaf:function intentionally absent → zero callers
}

// Real-graph shape (BunSqliteGraph.getReferences): every edge shares the QUERIED
// entity's from side — only toEntity varies. An import + call pair to the same
// target is one callee, not two.
const CALLEES_BY_KEY: Record<string, RefEdge[]> = {
  "mid.ts:mid:function": [
    { fromEntity: "mid", fromFile: "mid.ts", toEntity: "root", kind: "import" },
    { fromEntity: "mid", fromFile: "mid.ts", toEntity: "root", kind: "call" },
    { fromEntity: "mid", fromFile: "mid.ts", toEntity: "leaf", kind: "call" },
  ],
}

// Bare name OR full "<filePath>:<name>:<kind>" key → the canonical key, matching
// BunSqliteGraph.getEntity's own two-step resolution (getCallers/getReferences on
// the real graph resolve the same way before querying edges).
function resolveCanonicalKey(entityKey: string): string | null {
  if (ENTITIES[entityKey]) return entityKey
  const hit = Object.entries(ENTITIES).find(([, e]) => e.name === entityKey)
  return hit ? hit[0] : null
}

function makeMockGraph(): RefGraphPort {
  return {
    async getEntity(key) {
      const canonical = resolveCanonicalKey(key)
      return canonical ? ENTITIES[canonical]! : null
    },
    async getEntitiesInFile(filePath) {
      return Object.values(ENTITIES).filter((e) => e.filePath === filePath)
    },
    async getCallers(entityKey) {
      const canonical = resolveCanonicalKey(entityKey)
      return canonical ? (CALLERS_BY_KEY[canonical] ?? []) : []
    },
    async getReferences(entityKey) {
      const canonical = resolveCanonicalKey(entityKey)
      return canonical ? (CALLEES_BY_KEY[canonical] ?? []) : []
    },
  }
}

describe("buildReferenceRows", () => {
  it("callers output carries file/line/kind/fan_in and propagates semantic fields", async () => {
    const graph = makeMockGraph()
    const { rows, truncated, signals } = await buildReferenceRows({
      graph,
      entityKey: "hub",
      direction: "callers",
      limit: 25,
    })

    expect(truncated).toBe(false)
    expect(rows.length).toBe(12)
    for (const row of rows) {
      expect(row.file.length).toBeGreaterThan(0)
      expect(typeof row.line).toBe("number")
      expect(row.kind).toBe("function")
      expect(typeof row.fan_in).toBe("number")
      expect(row.hop).toBe(1)
    }
    const caller1Row = rows.find((r) => r.name === "caller1")
    expect(caller1Row?.domain).toBe("routing")
    expect(caller1Row?.role).toBe("dispatch")
    expect(caller1Row?.summary).toBe("Routes the turn to a tier.")
    // Only caller1 is @sem-annotated in the fixture; no chokepoint at this fan-in (0 each).
    expect(signals.length).toBe(0)
  })

  it("marks a row a chokepoint when ITS OWN fan-in meets RSK_CALLER_THRESHOLD, with a ur|rsk signal", async () => {
    const graph = makeMockGraph()
    // aggregator's one caller is `hub`, which itself has 12 callers (>= RSK_CALLER_THRESHOLD).
    const { rows, signals } = await buildReferenceRows({
      graph,
      entityKey: "aggregator",
      direction: "callers",
    })

    expect(rows.length).toBe(1)
    const hubRow = rows[0]!
    expect(hubRow.name).toBe("hub")
    expect(hubRow.fan_in).toBe(12)
    expect(hubRow.fan_in).toBeGreaterThanOrEqual(RSK_CALLER_THRESHOLD)
    expect(hubRow.chokepoint).toBe(true)
    expect(signals.length).toBe(1)
    expect(signals[0]).toContain("ur|rsk")
    expect(signals[0]).toContain("chokepoint")
    expect(signals[0]).toContain("hub")
  })

  it("depth:2 walks one bounded hop further, tagging rows with their hop", async () => {
    const graph = makeMockGraph()
    const { rows, truncated } = await buildReferenceRows({
      graph,
      entityKey: "root",
      direction: "callers",
      depth: 2,
    })

    expect(truncated).toBe(false)
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({ name: "mid", hop: 1 })
    expect(rows[1]).toMatchObject({ name: "tip", hop: 2 })
  })

  it("depth:2 is cycle-safe — a mutual caller pair never loops back to the origin or duplicates", async () => {
    const graph = makeMockGraph()
    const { rows } = await buildReferenceRows({
      graph,
      entityKey: "cycleA",
      direction: "callers",
      depth: 2,
    })

    // hop1 finds cycleB; hop2 (cycleB's callers) finds cycleA again, but cycleA is the
    // origin (visited-seeded) so it's dropped — never an infinite walk, never a duplicate row.
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ name: "cycleB", hop: 1 })
  })

  it("degrades to an empty result (never throws) for an unindexed entity", async () => {
    const graph = makeMockGraph()
    const { rows, truncated, signals } = await buildReferenceRows({
      graph,
      entityKey: "doesNotExistAnywhere",
      direction: "callers",
    })

    expect(rows).toEqual([])
    expect(truncated).toBe(false)
    expect(signals).toEqual([])
  })

  it("an indexed entity with zero callers also yields a graceful empty result", async () => {
    const graph = makeMockGraph()
    const { rows } = await buildReferenceRows({
      graph,
      entityKey: "leaf",
      direction: "callers",
    })

    expect(rows).toEqual([])
  })

  it("callees are deduped by target, never collapsed by their shared from side", async () => {
    const graph = makeMockGraph()
    const { rows, truncated } = await buildReferenceRows({
      graph,
      entityKey: "mid",
      direction: "callees",
    })

    // mid's edges: import+call to root (one callee) + call to leaf. A from-side
    // dedupe would collapse all three into a single row — the original bug.
    expect(truncated).toBe(false)
    expect(rows.length).toBe(2)
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual(["leaf", "root"])
    const rootRow = rows.find((r) => r.name === "root")!
    expect(rootRow.file).toBe("root.ts")
    expect(rootRow.hop).toBe(1)
  })
})
