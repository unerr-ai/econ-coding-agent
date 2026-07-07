/**
 * Semantic-layer tests: index fixture files containing `@sem domain=<tag> role=<tag>`
 * doc comments and assert that getEntity / search / recon carry domain and role.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"
import { makeReconTool } from "../src/tools.js"

const FIXTURE_DIR = join(import.meta.dir, "fixture")

let graph: BunSqliteGraph

describe("Semantic layer — @sem domain/role extraction and propagation", () => {
  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", FIXTURE_DIR)
    const stats = await graph.index(FIXTURE_DIR)
    expect(stats.entities).toBeGreaterThan(0)
  })

  afterAll(() => graph.close())

  // -------------------------------------------------------------------------
  // getEntity — annotated function
  // -------------------------------------------------------------------------

  it("getEntity returns domain and role for @sem-annotated function", async () => {
    const entity = await graph.getEntity("computeRisk")
    expect(entity).not.toBeNull()
    expect(entity!.domain).toBe("risk")
    expect(entity!.role).toBe("analysis")
  })

  // -------------------------------------------------------------------------
  // getEntity — annotated class
  // -------------------------------------------------------------------------

  it("getEntity returns domain and role for @sem-annotated class", async () => {
    const entity = await graph.getEntity("ModelRouter")
    expect(entity).not.toBeNull()
    expect(entity!.domain).toBe("routing")
    expect(entity!.role).toBe("decision")
  })

  // -------------------------------------------------------------------------
  // Unannotated entity — domain/role absent
  // -------------------------------------------------------------------------

  it("getEntity returns undefined domain/role for unannotated entity", async () => {
    const entity = await graph.getEntity("unannotated")
    expect(entity).not.toBeNull()
    expect(entity!.domain).toBeUndefined()
    expect(entity!.role).toBeUndefined()
  })

  it("existing fixture entity (greet) has no domain/role", async () => {
    const entity = await graph.getEntity("greet")
    expect(entity).not.toBeNull()
    expect(entity!.domain).toBeUndefined()
    expect(entity!.role).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // search — domain/role propagated through rowToEntity
  // -------------------------------------------------------------------------

  it("search results carry domain/role for annotated entities", async () => {
    const results = await graph.search("computeRisk")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.domain).toBe("risk")
    expect(results[0]!.role).toBe("analysis")
  })

  it("search results for ModelRouter carry routing/decision tags", async () => {
    const results = await graph.search("ModelRouter")
    const router = results.find((e) => e.name === "ModelRouter")
    expect(router).toBeDefined()
    expect(router!.domain).toBe("routing")
    expect(router!.role).toBe("decision")
  })

  // -------------------------------------------------------------------------
  // recon — domain/role in bundle entities
  // -------------------------------------------------------------------------

  it("recon bundle entities carry domain/role for matched annotated entity", async () => {
    const bundle = await graph.recon("risk analysis")
    const risk = bundle.entities.find((e) => e.name === "computeRisk")
    expect(risk).toBeDefined()
    expect(risk!.domain).toBe("risk")
    expect(risk!.role).toBe("analysis")
  })

  it("recon tool JSON output includes domain/role fields", async () => {
    const tool = makeReconTool(graph)
    // "router" is a substring of "ModelRouter" — recon searches entity names via LIKE
    const raw = await tool.execute({ task: "router" })
    const bundle = JSON.parse(raw)
    const router = bundle.entities.find((e: { name: string }) => e.name === "ModelRouter")
    expect(router).toBeDefined()
    expect(router.domain).toBe("routing")
    expect(router.role).toBe("decision")
  })

  // -------------------------------------------------------------------------
  // summary — doc-comment prose capture
  // -------------------------------------------------------------------------

  it("captures the prose summary preceding an @sem-annotated entity", async () => {
    const entity = await graph.getEntity("computeRisk")
    expect(entity).not.toBeNull()
    expect(entity!.summary).toBe(
      "Computes a risk score for an entity based on its import fan-in count. Used to gate expensive escalation decisions."
    )
  })

  it("entity with no doc comment has undefined summary", async () => {
    const entity = await graph.getEntity("Calculator.add")
    expect(entity).not.toBeNull()
    expect(entity!.summary).toBeUndefined()
  })

  it("name-echo prose (camelCase-split match) yields undefined summary", async () => {
    const entity = await graph.getEntity("normalizePath")
    expect(entity).not.toBeNull()
    expect(entity!.summary).toBeUndefined()
  })

  it("getEntitiesInFile rows carry summary", async () => {
    const entities = await graph.getEntitiesInFile("sem.ts")
    const risk = entities.find((e) => e.name === "computeRisk")
    expect(risk).toBeDefined()
    expect(risk!.summary).toBe(
      "Computes a risk score for an entity based on its import fan-in count. Used to gate expensive escalation decisions."
    )
  })
})
