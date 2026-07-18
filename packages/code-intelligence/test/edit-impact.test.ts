/**
 * Unit tests for edit-impact.ts: computeEditImpact and renderInlineBlastRadius.
 * Uses a synthetic mock EditImpactGraph — no real indexing required.
 */

import { describe, it, expect } from "bun:test"
import type { Entity, Reference } from "../src/index.js"
import type { EditImpactGraph, BreakingChange } from "../src/edit-impact.js"
import type { ExtractedEntity } from "../src/ast-extractor.js"
import {
  computeEditImpact,
  renderInlineBlastRadius,
  DEFAULT_EDIT_IMPACT_CONFIG,
  detectBreakingChanges,
  renderBreakingChangeWarning,
} from "../src/edit-impact.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(name: string, filePath: string, signature: string): Entity {
  return {
    key: `${filePath}:${name}:function`,
    name,
    kind: "function",
    filePath,
    lineStart: 1,
    lineEnd: 10,
    signature,
    contentHash: "deadbeef",
  }
}

function makeRef(fromEntityKey: string, fromFile: string, toEntity: string): Reference {
  return { fromEntity: fromEntityKey, fromFile, toEntity, kind: "call" }
}

// ---------------------------------------------------------------------------
// Fixture entities
// ---------------------------------------------------------------------------

const myFunc = makeEntity("myFunc", "src/foo.ts", "function myFunc(a: string)")

// Two callers of myFunc from distinct non-test files
const callerRefs: Reference[] = [
  makeRef("src/caller1.ts:useMyFunc:function", "src/caller1.ts", "myFunc"),
  makeRef("src/caller2.ts:callMyFunc:function", "src/caller2.ts", "myFunc"),
]

// Entity with only 1 caller (below default minCallersToWarn=2)
const rareFunc = makeEntity("rareFunc", "src/rare.ts", "function rareFunc(x: number)")
const rareCallerRefs: Reference[] = [
  makeRef("src/only.ts:onlyCaller:function", "src/only.ts", "rareFunc"),
]

// Old content: myFunc has 1 parameter
const oldContent = "function myFunc(a: string) { return a; }"
// New content: myFunc gains a second parameter → parameter_added
const newContentAdded = "function myFunc(a: string, b: number) { return a + b; }"
// New content: same signature as old → body-only change
const newContentBodyOnly = "function myFunc(a: string) { return a.trim(); }"

// ---------------------------------------------------------------------------
// Mock graph
// ---------------------------------------------------------------------------

function makeMockGraph(overrides: Partial<EditImpactGraph> = {}): EditImpactGraph {
  return {
    async getEntitiesInFile(filePath) {
      if (filePath === "src/foo.ts") return [myFunc]
      if (filePath === "src/rare.ts") return [rareFunc]
      return []
    },
    async getCallers(entityKey) {
      // computeEditImpact now passes the full entity key — resolve the bare
      // name the same way BunSqliteGraph does.
      const name = entityKey.includes(":") ? (entityKey.split(":")[1] ?? entityKey) : entityKey
      if (name === "myFunc") return callerRefs
      if (name === "rareFunc") return rareCallerRefs
      return []
    },
    ...overrides,
  }
}

const mockGraph = makeMockGraph()

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeEditImpact", () => {
  it("(1) parameter_added change to entity with ≥2 callers yields one CascadeWarning", async () => {
    const warnings = await computeEditImpact(
      mockGraph,
      "src/foo.ts",
      oldContent,
      newContentAdded,
      DEFAULT_EDIT_IMPACT_CONFIG,
    )

    expect(warnings).toHaveLength(1)
    const w = warnings[0]!
    expect(w.change_type).toBe("parameter_added")
    expect(w.changed_entity).toBe("myFunc")
    expect(w.blast_radius.total_at_risk).toBeGreaterThanOrEqual(2)
  })

  it("(2) body-only edit (signature unchanged) yields []", async () => {
    const warnings = await computeEditImpact(
      mockGraph,
      "src/foo.ts",
      oldContent,
      newContentBodyOnly,
      DEFAULT_EDIT_IMPACT_CONFIG,
    )

    expect(warnings).toHaveLength(0)
  })

  it("(3) entity below minCallersToWarn yields []", async () => {
    const warnings = await computeEditImpact(
      mockGraph,
      "src/rare.ts",
      "function rareFunc(x: number) { return x; }",
      "function rareFunc(x: number, y: number) { return x + y; }",
      DEFAULT_EDIT_IMPACT_CONFIG, // minCallersToWarn=2, but rareFunc has only 1 caller
    )

    expect(warnings).toHaveLength(0)
  })

  it("emits direct_callers with correct bare names from fromEntity keys", async () => {
    const warnings = await computeEditImpact(
      mockGraph,
      "src/foo.ts",
      oldContent,
      newContentAdded,
      DEFAULT_EDIT_IMPACT_CONFIG,
    )

    const direct = warnings[0]!.blast_radius.direct_callers
    // fromEntity = "src/caller1.ts:useMyFunc:function" → split(":")[1] = "useMyFunc"
    expect(direct.some((c) => c.entity === "useMyFunc")).toBe(true)
    expect(direct.some((c) => c.entity === "callMyFunc")).toBe(true)
  })

  it("(5) an import edge + a call edge from the same file count as ONE distinct caller", async () => {
    // dupFunc has exactly 2 callers by raw edge count, but both edges come
    // from the SAME file: a file-level import edge (fromEntity="") and a
    // named call edge (fromEntity="useDupFunc") — one relationship, not two.
    const dupFunc = makeEntity("dupFunc", "src/dup.ts", "function dupFunc(a: string)")
    const dupRefs: Reference[] = [
      makeRef("", "src/dupCaller.ts", "dupFunc"),
      makeRef("src/dupCaller.ts:useDupFunc:function", "src/dupCaller.ts", "dupFunc"),
    ]
    const dupGraph = makeMockGraph({
      async getEntitiesInFile(filePath) {
        if (filePath === "src/dup.ts") return [dupFunc]
        return []
      },
      async getCallers(entityKey) {
        const name = entityKey.includes(":") ? (entityKey.split(":")[1] ?? entityKey) : entityKey
        if (name === "dupFunc") return dupRefs
        return []
      },
    })

    const warnings = await computeEditImpact(
      dupGraph,
      "src/dup.ts",
      "function dupFunc(a: string) { return a; }",
      "function dupFunc(a: string, b: number) { return a + b; }",
      { minCallersToWarn: 1, includeTests: true },
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.blast_radius.total_at_risk).toBe(1)
    expect(warnings[0]!.blast_radius.direct_callers).toHaveLength(1)
  })
})

describe("renderInlineBlastRadius", () => {
  it("(4) produces a string containing 'ur|rsk' and the entity name", async () => {
    const warnings = await computeEditImpact(
      mockGraph,
      "src/foo.ts",
      oldContent,
      newContentAdded,
      DEFAULT_EDIT_IMPACT_CONFIG,
    )

    const result = renderInlineBlastRadius(warnings)
    expect(result).not.toBeNull()
    expect(result).toContain("ur|rsk")
    expect(result).toContain("myFunc")
  })

  it("returns null for empty warnings array", () => {
    expect(renderInlineBlastRadius([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// G3 — detectBreakingChanges / renderBreakingChangeWarning
// ---------------------------------------------------------------------------

function makeExtracted(name: string, kind: string, signature: string): ExtractedEntity {
  return { name, kind, signature, lineStart: 1, lineEnd: 3, contentHash: "deadbeef" }
}

const removedFunc = makeEntity("removedFunc", "src/gone.ts", "function removedFunc(a: string)")
const keptFunc = makeEntity("keptFunc", "src/gone.ts", "function keptFunc(): void")
const removedFuncCallers: Reference[] = [
  makeRef("src/user1.ts:useRemoved:function", "src/user1.ts", "removedFunc"),
  makeRef("src/user2.ts:useRemoved2:function", "src/user2.ts", "removedFunc"),
]
// keptFunc has no callers configured below — used for the "removed, zero
// outside callers" case.
const goneOldContent =
  "export function removedFunc(a: string) { return a }\nexport function keptFunc(): void {}\n"

const breakingGraph: EditImpactGraph = {
  async getEntitiesInFile(filePath) {
    if (filePath === "src/gone.ts") return [removedFunc, keptFunc]
    return []
  },
  async getCallers(entityKey) {
    const name = entityKey.includes(":") ? (entityKey.split(":")[1] ?? entityKey) : entityKey
    if (name === "removedFunc") return removedFuncCallers
    return []
  },
}

describe("detectBreakingChanges", () => {
  it("(1) a removed exported entity with outside-file callers is reported as 'removed'", async () => {
    const postEntities = [makeExtracted("keptFunc", "function", "function keptFunc(): void")]
    const changes = await detectBreakingChanges(breakingGraph, goneOldContent, [removedFunc, keptFunc], postEntities)

    expect(changes).toHaveLength(1)
    expect(changes[0]!.entity_name).toBe("removedFunc")
    expect(changes[0]!.change_type).toBe("removed")
    expect(changes[0]!.callers_total).toBe(2)
    expect(changes[0]!.callers).toHaveLength(2)
  })

  it("(2) an exported entity whose re-parsed signature differs is reported as 'signature_changed'", async () => {
    const postEntities = [
      makeExtracted("removedFunc", "function", "function removedFunc(a: string, b: number)"),
      makeExtracted("keptFunc", "function", "function keptFunc(): void"),
    ]
    const changes = await detectBreakingChanges(breakingGraph, goneOldContent, [removedFunc, keptFunc], postEntities)

    expect(changes).toHaveLength(1)
    expect(changes[0]!.entity_name).toBe("removedFunc")
    expect(changes[0]!.change_type).toBe("signature_changed")
  })

  it("(3) a removed entity with zero outside-file callers is silently dropped", async () => {
    // keptFunc removed instead of removedFunc — keptFunc has no callers.
    const postEntities = [makeExtracted("removedFunc", "function", "function removedFunc(a: string)")]
    const changes = await detectBreakingChanges(breakingGraph, goneOldContent, [removedFunc, keptFunc], postEntities)

    expect(changes).toHaveLength(0)
  })

  it("(4) an entity never declared with `export` stays silent even with graph callers", async () => {
    const internalFunc = makeEntity("internalHelper", "src/gone.ts", "function internalHelper(): number")
    const internalGraph: EditImpactGraph = {
      async getEntitiesInFile(filePath) {
        if (filePath === "src/gone.ts") return [internalFunc]
        return []
      },
      async getCallers() {
        // A graph edge here would be unusual for a name never exported, but
        // the isExportedName gate must suppress the warning regardless.
        return [makeRef("src/user1.ts:useIt:function", "src/user1.ts", "internalHelper")]
      },
    }
    const oldContentNoExport =
      "function internalHelper(): number { return 1 }\nexport function otherThing(): number { return 2 }\n"
    const postEntities = [makeExtracted("otherThing", "function", "function otherThing(): number")]

    const changes = await detectBreakingChanges(internalGraph, oldContentNoExport, [internalFunc], postEntities)
    expect(changes).toHaveLength(0)
  })

  it("(5) a post-parse yielding zero entities for a file that had entities is treated as a parser miss, not a mass removal", async () => {
    const changes = await detectBreakingChanges(breakingGraph, goneOldContent, [removedFunc, keptFunc], [])
    expect(changes).toHaveLength(0)
  })
})

describe("renderBreakingChangeWarning", () => {
  it("produces a string containing 'ur|brk', the entity name, and the change verb", async () => {
    const postEntities = [makeExtracted("keptFunc", "function", "function keptFunc(): void")]
    const changes = await detectBreakingChanges(breakingGraph, goneOldContent, [removedFunc, keptFunc], postEntities)

    const result = renderBreakingChangeWarning(changes)
    expect(result).not.toBeNull()
    expect(result).toContain("ur|brk")
    expect(result).toContain("removedFunc")
    expect(result).toContain("removed")
  })

  it("returns null for an empty changes array", () => {
    expect(renderBreakingChangeWarning([])).toBeNull()
  })

  it("appends text_occurrences when present", () => {
    const change: BreakingChange = {
      entity_name: "removedFunc",
      entity_key: "src/gone.ts:removedFunc:function",
      entity_file: "src/gone.ts",
      change_type: "removed",
      callers: [{ file: "src/user1.ts", entity: "useRemoved", line: 0, isTest: false }],
      callers_total: 1,
      text_occurrences: [{ file: "config/routes.json", line: 4 }],
    }
    const result = renderBreakingChangeWarning([change])
    expect(result).toContain("config/routes.json:4")
  })
})
