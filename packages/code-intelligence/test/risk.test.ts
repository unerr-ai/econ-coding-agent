/**
 * Unit tests for risk.ts: computeRisk and computeTurnRisk.
 * Uses a synthetic mock RiskGraph — no indexing required.
 */

import { describe, it, expect } from "bun:test"
import type { Entity, Reference } from "../src/index.js"
import type { RiskGraph } from "../src/risk.js"
import { computeRisk, computeTurnRisk, couplingConfidence } from "../src/risk.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(
  name: string,
  filePath: string,
  lineStart: number,
  lineEnd: number
): Entity {
  return {
    key: `${filePath}:${name}:function`,
    name,
    kind: "function",
    filePath,
    lineStart,
    lineEnd,
    signature: `function ${name}()`,
    contentHash: "deadbeef",
  }
}

function makeRef(fromEntity: string, fromFile: string, toEntity: string): Reference {
  return { fromEntity, fromFile, toEntity, kind: "import" }
}

// ---------------------------------------------------------------------------
// Fixture entities
// ---------------------------------------------------------------------------

// "central" — 10 direct callers from distinct files, large body (80 lines)
const central = makeEntity("central", "core.ts", 1, 80)

// "leaf" — no callers, tiny body (3 lines)
const leaf = makeEntity("leaf", "utils.ts", 5, 8)

// Helper entities that live in the caller files (for BFS level 2)
const callerFiles = Array.from({ length: 10 }, (_, i) => `caller${i}.ts`)
const helperEntities = callerFiles.map((f, i) => makeEntity(`helper${i}`, f, 1, 5))

// "bridge" — 1 direct caller of central AND 5 entities call bridge (medium risk)
const bridge = makeEntity("bridge", "bridge.ts", 10, 30)
const bridgeCallerFiles = Array.from({ length: 5 }, (_, i) => `bridgeCaller${i}.ts`)

// "dupCalled" — one caller FILE that contributes both an import edge
// (fromEntity="") and a named call edge for the same relationship; must
// count as 1 distinct caller, not 2.
const dupCalled = makeEntity("dupCalled", "dup.ts", 1, 5)

// ---------------------------------------------------------------------------
// Mock graph
// ---------------------------------------------------------------------------

const mockGraph: RiskGraph = {
  async getEntity(key) {
    const name = key.includes(":") ? key.split(":")[1] ?? key : key
    const all = [central, leaf, bridge, dupCalled, ...helperEntities]
    return all.find((e) => e.name === name) ?? null
  },

  async getCallers(entityKey) {
    const name = entityKey.includes(":") ? entityKey.split(":")[1] ?? entityKey : entityKey

    if (name === "central") {
      // 10 direct caller references, each from a distinct file
      return callerFiles.map((f, i) =>
        makeRef(`helper${i}`, f, "central")
      )
    }
    if (name === "bridge") {
      return bridgeCallerFiles.map((f, i) =>
        makeRef(`bc${i}`, f, "bridge")
      )
    }
    if (name === "dupCalled") {
      // Same caller file, two edges: a file-level import edge (fromEntity="")
      // and a named call edge — one relationship, not two distinct callers.
      return [
        makeRef("", "dupCaller.ts", "dupCalled"),
        makeRef("useDupCalled", "dupCaller.ts", "dupCalled"),
      ]
    }
    return []
  },

  async getReferences(entityKey) {
    // central calls nothing; leaf calls nothing; bridge calls central
    const name = entityKey.includes(":") ? entityKey.split(":")[1] ?? entityKey : entityKey
    if (name === "bridge") {
      return [makeRef("bridge", "bridge.ts", "central")]
    }
    return []
  },

  async getEntitiesInFile(filePath) {
    const i = callerFiles.indexOf(filePath)
    if (i >= 0) return [helperEntities[i]!]
    return []
  },
}

// ---------------------------------------------------------------------------
// computeRisk — bounds and separation
// ---------------------------------------------------------------------------

describe("computeRisk — bounds", () => {
  it("score is always in [0, 100] for central", async () => {
    const { score } = await computeRisk(mockGraph, central)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  it("score is always in [0, 100] for leaf", async () => {
    const { score } = await computeRisk(mockGraph, leaf)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })
})

describe("computeRisk — high vs low separation", () => {
  it("high-fan-in entity (central) scores strictly higher than leaf", async () => {
    const { score: scoreC } = await computeRisk(mockGraph, central)
    const { score: scoreL } = await computeRisk(mockGraph, leaf)
    expect(scoreC).toBeGreaterThan(scoreL)
  })

  it("leaf entity has a low score (< 20)", async () => {
    const { score } = await computeRisk(mockGraph, leaf)
    expect(score).toBeLessThan(20)
  })

  it("central entity has a meaningfully high score (> 30)", async () => {
    const { score } = await computeRisk(mockGraph, central)
    expect(score).toBeGreaterThan(30)
  })
})

describe("computeRisk — factor values", () => {
  it("exposes all four factor fields with correct types", async () => {
    const { factors } = await computeRisk(mockGraph, central)
    expect(typeof factors.fanIn).toBe("number")
    expect(typeof factors.blastRadius).toBe("number")
    expect(typeof factors.centrality).toBe("number")
    expect(typeof factors.cx).toBe("number")
  })

  it("central fanIn equals 10 (number of direct caller refs)", async () => {
    const { factors } = await computeRisk(mockGraph, central)
    expect(factors.fanIn).toBe(10)
  })

  it("central blastRadius ≥ fanIn (transitive ≥ direct)", async () => {
    const { factors } = await computeRisk(mockGraph, central)
    // Blast radius = unique caller files = 10 (no transitive depth since helpers have 0 callers)
    expect(factors.blastRadius).toBeGreaterThanOrEqual(factors.fanIn)
  })

  it("central centrality equals fanIn + fanOut", async () => {
    const callerCount = 10
    const calleeCount = 0 // central calls nothing
    const { factors } = await computeRisk(mockGraph, central)
    expect(factors.centrality).toBe(callerCount + calleeCount)
  })

  it("central cx reflects body line count", async () => {
    const { factors } = await computeRisk(mockGraph, central)
    // central: lineStart=1, lineEnd=80 → cx = 80-1 = 79
    expect(factors.cx).toBe(79)
  })

  it("leaf cx is small (3 lines)", async () => {
    const { factors } = await computeRisk(mockGraph, leaf)
    // leaf: lineStart=5, lineEnd=8 → cx = 8-5 = 3
    expect(factors.cx).toBe(3)
  })

  it("an import edge + a call edge from the same file count as ONE distinct fanIn caller", async () => {
    const { factors } = await computeRisk(mockGraph, dupCalled)
    // dupCalled has 2 raw edges from dupCaller.ts (one import, one call) —
    // both describe the same dependency, so fanIn must be 1, not 2.
    expect(factors.fanIn).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// computeTurnRisk
// ---------------------------------------------------------------------------

describe("computeTurnRisk", () => {
  it("returns null for an empty entity list", async () => {
    const result = await computeTurnRisk(mockGraph, [])
    expect(result).toBeNull()
  })

  it("score is in [0, 100]", async () => {
    const result = await computeTurnRisk(mockGraph, [central, leaf])
    expect(result).not.toBeNull()
    expect(result!.score).toBeGreaterThanOrEqual(0)
    expect(result!.score).toBeLessThanOrEqual(100)
  })

  it("picks the highest-risk entity as topEntity", async () => {
    const result = await computeTurnRisk(mockGraph, [leaf, central])
    expect(result!.topEntity.name).toBe("central")
  })

  it("score equals the topEntity score", async () => {
    const result = await computeTurnRisk(mockGraph, [central, leaf])
    expect(result!.score).toBe(result!.perEntity[0]!.result.score)
  })

  it("perEntity has one entry per input entity", async () => {
    const result = await computeTurnRisk(mockGraph, [central, leaf, bridge])
    expect(result!.perEntity).toHaveLength(3)
  })

  it("perEntity is sorted descending by score", async () => {
    const result = await computeTurnRisk(mockGraph, [leaf, central, bridge])
    const scores = result!.perEntity.map((e) => e.result.score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!)
    }
  })

  it("single-entity turn returns that entity as topEntity", async () => {
    const result = await computeTurnRisk(mockGraph, [leaf])
    expect(result!.topEntity.name).toBe("leaf")
    expect(result!.perEntity).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// P6 — couplingConfidence + computeRisk's coverage field
// ---------------------------------------------------------------------------

describe("couplingConfidence — boundaries", () => {
  it("coverage missing entirely → unknown", () => {
    expect(couplingConfidence(undefined)).toBe("unknown")
  })

  it("zero imports extracted, files >= 2 → unknown (the go/java/rust/c/cpp extraction gap — P6's interim signal)", () => {
    expect(couplingConfidence({ files: 2, imports: 0, resolvedImports: 0 })).toBe("unknown")
  })

  it("zero imports extracted, files === 1 → measured (too thin to tell 'no resolver' from 'genuinely no imports')", () => {
    expect(couplingConfidence({ files: 1, imports: 0, resolvedImports: 0 })).toBe("measured")
  })

  it("0 resolved out of a nonzero import count → unknown", () => {
    expect(couplingConfidence({ files: 5, imports: 10, resolvedImports: 0 })).toBe("unknown")
  })

  it("9% resolved → unknown (below the 0.10 floor)", () => {
    expect(couplingConfidence({ files: 20, imports: 100, resolvedImports: 9 })).toBe("unknown")
  })

  it("a 5% ratio → unknown", () => {
    expect(couplingConfidence({ files: 10, imports: 100, resolvedImports: 5 })).toBe("unknown")
  })

  it("10% resolved → measured (at the floor, not below it)", () => {
    expect(couplingConfidence({ files: 20, imports: 100, resolvedImports: 10 })).toBe("measured")
  })

  it("python-shaped coverage at 80% resolved → measured", () => {
    expect(couplingConfidence({ files: 3036, imports: 5000, resolvedImports: 4000 })).toBe("measured")
  })

  it("typescript-shaped coverage at 37% resolved → measured", () => {
    expect(couplingConfidence({ files: 12, imports: 100, resolvedImports: 37 })).toBe("measured")
  })

  it("85% resolved → measured", () => {
    expect(couplingConfidence({ files: 20, imports: 100, resolvedImports: 85 })).toBe("measured")
  })
})

describe("computeRisk — coverage field", () => {
  it("defaults to measured when the caller passes no coverage argument (today's Python/TS paths, unchanged behavior)", async () => {
    const result = await computeRisk(mockGraph, leaf)
    expect(result.coverage).toBe("measured")
  })

  it("reports unknown when given zero-resolution coverage for the entity's language", async () => {
    const result = await computeRisk(mockGraph, leaf, { files: 5, imports: 20, resolvedImports: 0 })
    expect(result.coverage).toBe("unknown")
  })

  it("reports measured when given well-resolved coverage", async () => {
    const result = await computeRisk(mockGraph, leaf, { files: 5, imports: 20, resolvedImports: 17 })
    expect(result.coverage).toBe("measured")
  })

  it("score/factors are unaffected by the coverage argument — same inputs, same score either way", async () => {
    const withoutCoverage = await computeRisk(mockGraph, central)
    const withUnknownCoverage = await computeRisk(mockGraph, central, { files: 5, imports: 5, resolvedImports: 0 })
    expect(withUnknownCoverage.score).toBe(withoutCoverage.score)
    expect(withUnknownCoverage.factors).toEqual(withoutCoverage.factors)
  })
})
