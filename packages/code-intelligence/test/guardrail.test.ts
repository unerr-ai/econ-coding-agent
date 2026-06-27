/**
 * Unit tests for guardrail.ts: the in-loop governance gate decision engine.
 * Uses a synthetic EditImpactGraph — no indexing required. The first test is
 * the S6.3 DONE-WHEN: a breaking signature edit is blocked before it lands.
 */

import { describe, it, expect } from "bun:test"
import type { Entity, Reference } from "../src/index.js"
import type { EditImpactGraph } from "../src/edit-impact.js"
import { evaluateEdit, createGuardrailState, DEFAULT_GUARDRAIL_CONFIG } from "../src/guardrail.js"

// ---------------------------------------------------------------------------
// Synthetic graph
// ---------------------------------------------------------------------------

const TARGET: Entity = {
  key: "src/api.ts:doThing:function",
  name: "doThing",
  kind: "function",
  filePath: "src/api.ts",
  lineStart: 10,
  lineEnd: 20,
  signature: "function doThing(a, b)",
  contentHash: "deadbeef",
}

// Three distinct callers of doThing (two source, one test).
const CALLERS: Reference[] = [
  { fromEntity: "src/foo.ts:useFoo:function", fromFile: "src/foo.ts", toEntity: "doThing", kind: "call" },
  { fromEntity: "src/bar.ts:useBar:function", fromFile: "src/bar.ts", toEntity: "doThing", kind: "call" },
  { fromEntity: "src/api.test.ts:t:function", fromFile: "src/api.test.ts", toEntity: "doThing", kind: "call" },
]

const graph: EditImpactGraph = {
  async getEntitiesInFile(filePath) {
    return filePath === "src/api.ts" ? [TARGET] : []
  },
  async getCallers(name) {
    return name === "doThing" ? CALLERS : []
  },
}

// An edit that adds a parameter to doThing's signature (breaking).
const BREAKING = {
  tool: "edit",
  filePath: "src/api.ts",
  oldContent: "function doThing(a, b)",
  newContent: "function doThing(a, b, c)",
}

// A body-only edit that leaves the signature untouched.
const BODY_ONLY = {
  tool: "edit",
  filePath: "src/api.ts",
  oldContent: "  const x = a + b",
  newContent: "  const x = a * b",
}

describe("evaluateEdit — S6.3 governance gate", () => {
  it("BLOCKS a breaking signature edit with callers before it lands (DONE-WHEN)", async () => {
    const state = createGuardrailState()
    const d = await evaluateEdit(graph, BREAKING, state)
    expect(d.verdict).toBe("block")
    expect(d.cascades.length).toBe(1)
    expect(d.cascades[0]!.change_type).toBe("parameter_added")
    expect(d.cascades[0]!.blast_radius.total_at_risk).toBeGreaterThanOrEqual(1)
    expect(d.reason).toContain("doThing")
    expect(d.reason).toContain("ur|rsk")
    expect(d.loopBroken).toBe(false)
  })

  it("ALLOWS a body-only edit (no signature change)", async () => {
    const state = createGuardrailState()
    const d = await evaluateEdit(graph, BODY_ONLY, state)
    expect(d.verdict).toBe("allow")
    expect(d.cascades.length).toBe(0)
  })

  it("retry-loop-breaker releases the block after retryLoopLimit identical attempts", async () => {
    const state = createGuardrailState()
    const limit = DEFAULT_GUARDRAIL_CONFIG.retryLoopLimit
    let last
    for (let i = 0; i < limit; i++) {
      last = await evaluateEdit(graph, BREAKING, state)
    }
    // First (limit-1) attempts block; the limit-th flips to a loop-broken warn.
    expect(last!.verdict).toBe("warn")
    expect(last!.loopBroken).toBe(true)
  })

  it("clears the retry ledger once the model stops proposing the blocked edit", async () => {
    const state = createGuardrailState()
    await evaluateEdit(graph, BREAKING, state) // block, count=1
    expect(state.retries.has("src/api.ts")).toBe(true)
    await evaluateEdit(graph, BODY_ONLY, state) // clean → ledger cleared
    expect(state.retries.has("src/api.ts")).toBe(false)
  })

  it("WARNS (not blocks) on an architecture-boundary crossing", async () => {
    const state = createGuardrailState()
    const emptyGraph: EditImpactGraph = {
      async getEntitiesInFile() {
        return []
      },
      async getCallers() {
        return []
      },
    }
    const d = await evaluateEdit(
      emptyGraph,
      {
        tool: "write",
        filePath: "packages/code-intelligence/src/foo.ts",
        oldContent: null,
        newContent: `import { x } from "../../opencode/bar.js"\n`,
      },
      state,
    )
    expect(d.verdict).toBe("warn")
    expect(d.boundaryViolations.length).toBeGreaterThanOrEqual(1)
  })
})
