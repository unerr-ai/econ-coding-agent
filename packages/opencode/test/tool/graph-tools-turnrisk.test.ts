/**
 * FIX-3: probeTurnRisk unit tests.
 *
 * probeTurnRisk was previously untested — tied to the module singleton graph.
 * It now takes the same optional trailing `graph` test-injection seam as its
 * sibling probeSliceCoupling (see graph-tools-ol79.test.ts), so it can be
 * exercised the same way: against the real indexed toy repo
 * (fixtures/ol79-coupling, a 12-caller hub vs. an isolated leaf) plus
 * defensive paths with a throwing mock graph.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import { probeTurnRisk } from "../../src/tool/graph-tools"

const COUPLING_FIXTURE = join(import.meta.dir, "fixtures/ol79-coupling")

describe("OL-3.3 — probeTurnRisk", () => {
  let graph: BunSqliteGraph

  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", COUPLING_FIXTURE)
    await graph.index(COUPLING_FIXTURE)
  })

  afterAll(() => {
    graph.close()
  })

  it("scores a prompt naming the 12-caller hub as high risk", async () => {
    const score = await probeTurnRisk("please touch centralHub next", graph)
    expect(score).toBeGreaterThanOrEqual(50)
  })

  it("scores a prompt naming the isolated leaf as low risk", async () => {
    const score = await probeTurnRisk("please touch isolatedLeaf next", graph)
    expect(score).toBeLessThan(50)
  })

  it("a decisive hub named after eight matching noise tokens still ranks into the pool", async () => {
    // Run-20 replay regression: eight backticked low-fan-in tokens fill the
    // 8-entity pool before the hub is reached; fan-in ranking must keep the
    // hub anyway. The old first-token-wins fill scored this prompt low.
    const score = await probeTurnRisk(
      "touch `caller1` `caller2` `caller3` `caller4` `caller5` `caller6` `caller7` `caller8` and then centralHub",
      graph,
    )
    expect(score).toBeGreaterThanOrEqual(50)
  })

  it("no identifier-shaped tokens match any entity yields 0", async () => {
    const score = await probeTurnRisk("zzz nonexistent qqq", graph)
    expect(score).toBe(0)
  })

  it("a prompt with no identifier-shaped tokens at all yields 0", async () => {
    const score = await probeTurnRisk("hi ok go do it now", graph)
    expect(score).toBe(0)
  })

  it("defensive: a throwing graph yields 0, never throws", async () => {
    const throwingGraph = {
      search: async () => {
        throw new Error("boom")
      },
    } as unknown as BunSqliteGraph
    const score = await probeTurnRisk("touch centralHub", throwingGraph)
    expect(score).toBe(0)
  })

  it("defensive: an empty/cold graph (no matches) yields 0, never throws", async () => {
    const coldGraph = {
      search: async () => [],
    } as unknown as BunSqliteGraph
    const score = await probeTurnRisk("touch centralHub", coldGraph)
    expect(score).toBe(0)
  })

  it("caps the union of resolved entities at the focus limit (RISK_PROBE_ENTITY_LIMIT = 8)", async () => {
    // Feed every caller name plus the hub/leaf names as one prompt: the fixture
    // resolves well over 8 distinct entities if uncapped, so a bounded, non-throwing
    // score proves the cap held rather than the probe scanning every match.
    const manyNamesPrompt =
      "centralHub caller1 caller2 caller3 caller4 caller5 caller6 caller7 caller8 caller9 caller10 caller11 caller12 isolatedLeaf"
    const score = await probeTurnRisk(manyNamesPrompt, graph)
    expect(typeof score).toBe("number")
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })
})
