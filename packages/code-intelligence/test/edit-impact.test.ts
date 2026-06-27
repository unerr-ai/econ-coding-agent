/**
 * Unit tests for edit-impact.ts: computeEditImpact and renderInlineBlastRadius.
 * Uses a synthetic mock EditImpactGraph — no real indexing required.
 */

import { describe, it, expect } from "bun:test"
import type { Entity, Reference } from "../src/index.js"
import type { EditImpactGraph } from "../src/edit-impact.js"
import {
  computeEditImpact,
  renderInlineBlastRadius,
  DEFAULT_EDIT_IMPACT_CONFIG,
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
    async getCallers(entityName) {
      if (entityName === "myFunc") return callerRefs
      if (entityName === "rareFunc") return rareCallerRefs
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
