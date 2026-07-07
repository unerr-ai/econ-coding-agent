/**
 * FTS5 search/recon/compress tests. A phrase query tokenizes into multiple
 * terms and ranks a retry-named fixture entity (matched via its NAME field)
 * above an entity that only incidentally contains "retry" in its signature
 * (bm25 column weighting); the LIKE fallback still resolves an exact
 * single-token symbol name. recon() tokenizes the full phrase (not just the
 * first word) and attaches notes for both file and entity anchors. compress()
 * keeps the highest fan-in block intact under a tight budget and truncates
 * the rest.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

const FIXTURE_DIR = join(import.meta.dir, "fixture-fts")

let graph: BunSqliteGraph

describe("BunSqliteGraph — FTS5 search, recon, compress", () => {
  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", FIXTURE_DIR)
    const stats = await graph.index(FIXTURE_DIR)
    expect(stats.entities).toBeGreaterThan(0)
  })

  afterAll(() => graph.close())

  // -------------------------------------------------------------------------
  // search — multi-term FTS5 ranking
  // -------------------------------------------------------------------------

  it("a phrase query matches the retry-named fixture entity via multi-term ranking", async () => {
    const results = await graph.search("where is retry handled")
    expect(results.some((e) => e.name === "retryHandler")).toBe(true)
  })

  it("bm25 ranks the name-match above an incidental substring match in the signature", async () => {
    const results = await graph.search("where is retry handled")
    const retryIdx = results.findIndex((e) => e.name === "retryHandler")
    const queueIdx = results.findIndex((e) => e.name === "processQueue")
    expect(retryIdx).toBeGreaterThanOrEqual(0)
    expect(queueIdx).toBeGreaterThanOrEqual(0)
    expect(retryIdx).toBeLessThan(queueIdx)
  })

  it("the LIKE fallback still finds an exact symbol name (single token, no phrase)", async () => {
    const results = await graph.search("retryHandler")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toBe("retryHandler")
  })

  it("a phrase matching only the summary text (not name/signature) finds the entity via the summary FTS column", async () => {
    // "exponential backoff" appears only in retryHandler's doc-comment summary —
    // neither its name, processQueue's signature, nor helperUtil's body/name.
    const results = await graph.search("exponential backoff")
    expect(results.some((e) => e.name === "retryHandler")).toBe(true)
  })

  it("search rows carry the captured summary text", async () => {
    const results = await graph.search("retryHandler")
    const retry = results.find((e) => e.name === "retryHandler")
    expect(retry).toBeDefined()
    expect(retry!.summary).toBe("Retries a flaky operation with exponential backoff.")
  })

  // -------------------------------------------------------------------------
  // recon — full-phrase tokenization + entity-anchored notes
  // -------------------------------------------------------------------------

  it("recon tokenizes the full phrase (not just the first word) and finds the match", async () => {
    const bundle = await graph.recon("where is retry handled")
    expect(bundle.entities.some((e) => e.name === "retryHandler")).toBe(true)
  })

  it("recon returns notes anchored to the matched entity (e:<name>), not just the file", async () => {
    await graph.upsertNote({
      anchor: "e:retryHandler",
      kind: "fct",
      polarity: "+",
      content: "retries 3x with backoff",
    })
    const bundle = await graph.recon("where is retry handled")
    expect(bundle.notes.some((n) => n.anchor === "e:retryHandler")).toBe(true)
  })

  // -------------------------------------------------------------------------
  // compress — entity-ranked trimming by fan-in
  // -------------------------------------------------------------------------

  it("compress keeps the highest fan-in block intact and truncates the rest under a tight budget", () => {
    const highBlock = "retryHandler retries the flaky call and is invoked from three separate caller files."
    const lowBlock = "helperUtil is a small helper that nothing else in this fixture calls."
    const content = `${highBlock}\n\n${lowBlock}`
    // Just enough budget for the high-fan-in block alone, not both blocks.
    const budget = Math.ceil((highBlock.length + 6) / 4)

    const compressed = graph.compress(content, budget)
    expect(compressed).toContain(highBlock)
    expect(compressed).not.toContain(lowBlock)
    expect(compressed).toContain("[truncated]")
  })

  it("compress returns content unchanged when it already fits the budget", () => {
    const short = "export function tiny(): void {}"
    expect(graph.compress(short, 100)).toBe(short)
  })
})
