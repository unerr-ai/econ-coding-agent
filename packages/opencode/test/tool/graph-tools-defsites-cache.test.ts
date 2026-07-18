/**
 * G4 (wave-G item 2) — shared definition-sites cache. resolveIssueSymbolSites
 * (the ~50ms/miss graph.search + precision-filter pass) is shared between
 * `issueSymbolDefinitionSites` and `issueSymbolDefinitionSitesIfReady`
 * through a module-level, per-graph-instance cache keyed by symbol — a
 * repeat resolution for the same symbol against the same graph instance
 * must not re-hit graph.search, and two different graph instances must
 * never share results. Mirrors issue-symbol-extraction.test.ts's stub-graph
 * style (counts calls via a wrapped `search`), no live graph needed.
 */
import { describe, it, expect } from "bun:test"
import type { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import { issueSymbolDefinitionSites, issueSymbolDefinitionSitesIfReady } from "../../src/tool/graph-tools"

function countingStubGraph(hit: { name: string; filePath: string; kind: string }) {
  let calls = 0
  const stub = {
    search: async () => {
      calls++
      return [hit]
    },
  } as unknown as BunSqliteGraph
  return { stub, callCount: () => calls }
}

describe("G4 — shared definition-sites cache", () => {
  it("a repeated symbol against the SAME graph instance hits graph.search only once", async () => {
    const { stub, callCount } = countingStubGraph({
      name: "Widget",
      filePath: "django/forms/widgets.py",
      kind: "class",
    })

    const first = await issueSymbolDefinitionSites("`Widget` renders wrong", stub)
    const second = await issueSymbolDefinitionSites("`Widget` renders wrong again", stub)

    expect(first).toEqual([{ symbol: "Widget", kind: "class", file: "django/forms/widgets.py" }])
    expect(second).toEqual([{ symbol: "Widget", kind: "class", file: "django/forms/widgets.py" }])
    expect(callCount()).toBe(1)
  })

  it("issueSymbolDefinitionSitesIfReady shares the cache issueSymbolDefinitionSites populated", async () => {
    const { stub, callCount } = countingStubGraph({
      name: "AuthForm",
      filePath: "django/contrib/auth/forms.py",
      kind: "class",
    })

    await issueSymbolDefinitionSites("`AuthForm` rejects a valid login", stub)
    expect(callCount()).toBe(1)

    const viaIfReady = await issueSymbolDefinitionSitesIfReady("`AuthForm` rejects a valid login", stub)
    expect(viaIfReady).toEqual([{ symbol: "AuthForm", kind: "class", file: "django/contrib/auth/forms.py" }])
    expect(callCount()).toBe(1)
  })

  it("two different graph instances never share cached results (no cross-repo leakage)", async () => {
    const a = countingStubGraph({ name: "Widget", filePath: "repo-a/widgets.py", kind: "class" })
    const b = countingStubGraph({ name: "Widget", filePath: "repo-b/widgets.py", kind: "class" })

    const fromA = await issueSymbolDefinitionSites("`Widget` bug", a.stub)
    const fromB = await issueSymbolDefinitionSites("`Widget` bug", b.stub)

    expect(fromA).toEqual([{ symbol: "Widget", kind: "class", file: "repo-a/widgets.py" }])
    expect(fromB).toEqual([{ symbol: "Widget", kind: "class", file: "repo-b/widgets.py" }])
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(1)
  })

  it("a different symbol against the same graph instance is resolved independently (its own cache entry)", async () => {
    let calls = 0
    const stub = {
      search: async (query: string) => {
        calls++
        if (query === "Widget") return [{ name: "Widget", filePath: "a.py", kind: "class" }]
        if (query === "Field") return [{ name: "Field", filePath: "b.py", kind: "class" }]
        return []
      },
    } as unknown as BunSqliteGraph

    const widget = await issueSymbolDefinitionSites("`Widget` bug", stub)
    const field = await issueSymbolDefinitionSites("`Field` bug", stub)
    const widgetAgain = await issueSymbolDefinitionSites("`Widget` again", stub)

    expect(widget).toEqual([{ symbol: "Widget", kind: "class", file: "a.py" }])
    expect(field).toEqual([{ symbol: "Field", kind: "class", file: "b.py" }])
    expect(widgetAgain).toEqual([{ symbol: "Widget", kind: "class", file: "a.py" }])
    expect(calls).toBe(2) // one per distinct symbol, the repeat is served from cache
  })
})
