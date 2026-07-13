/**
 * Wave 7/8b — extractIssueSymbols: pure symbol extraction over an issue text
 * (no graph access). Mirrors risk-tokens.test.ts's table shape for
 * candidateRiskTokens, its sibling extractor in the same file. Wave 8b adds
 * `issueSymbolDefinitionSites`/`issueSymbolDefinitionSitesIfReady` coverage
 * against a stub graph — the quality rules (exact-name only, test-path drop,
 * `.py` passthrough, last-segment retry) live in `resolveIssueSymbolSites`.
 */

import { describe, it, expect } from "bun:test"
import type { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import {
  extractIssueSymbols,
  issueSymbolDefinitionSites,
  issueSymbolDefinitionSitesIfReady,
} from "../../src/tool/graph-tools"

describe("extractIssueSymbols", () => {
  it("captures a backtick-quoted dotted span verbatim", () => {
    const out = extractIssueSymbols("The bug is in `widget.attrs['maxlength']` — it should be an int.")
    expect(out).toContain("widget.attrs['maxlength']")
  })

  it("captures a CamelCase identifier outside backticks", () => {
    const out = extractIssueSymbols("HubEditGate blocks a second edit to the same shared module.")
    expect(out).toContain("HubEditGate")
  })

  it("captures a dotted identifier outside backticks", () => {
    const out = extractIssueSymbols("The fix touches widget.attrs directly, not the caller.")
    expect(out).toContain("widget.attrs")
  })

  it("drops pure-lowercase prose words", () => {
    const out = extractIssueSymbols("the issue affects how the value renders on the page")
    expect(out).toHaveLength(0)
  })

  it("dedupes case-insensitively", () => {
    const out = extractIssueSymbols("`Field.eq` fails; field.eq is also wrong.")
    expect(out.filter((s) => s.toLowerCase() === "field.eq")).toHaveLength(1)
  })

  it("caps at 8 symbols", () => {
    const backticked = Array.from({ length: 12 }, (_, i) => `\`Symbol${i}.method\``).join(" and ")
    const out = extractIssueSymbols(backticked)
    expect(out).toHaveLength(8)
  })

  it("an empty issue text returns no symbols", () => {
    expect(extractIssueSymbols("")).toEqual([])
  })

  it("drops bare ALL-CAPS tokens (SQL keywords, acronyms)", () => {
    const out = extractIssueSymbols(
      "The migration issues CREATE INDEX on the column; docs use HTML markup and an RFC reference.",
    )
    expect(out).not.toContain("CREATE")
    expect(out).not.toContain("INDEX")
    expect(out).not.toContain("HTML")
    expect(out).not.toContain("RFC")
  })

  it("drops domain-like tokens", () => {
    const out = extractIssueSymbols("See code.djangoproject.com/ticket/123 or github.com/django/django for details.")
    expect(out).not.toContain("code.djangoproject.com")
    expect(out).not.toContain("github.com")
  })

  it("keeps a dotted identifier whose last segment is ALL-CAPS", () => {
    const out = extractIssueSymbols("The fix touches models.CASCADE directly.")
    expect(out).toContain("models.CASCADE")
  })

  it("keeps a lowercase dotted module path (not a domain — no TLD-shaped ending)", () => {
    const out = extractIssueSymbols("The bug is in django.utils.http.parse_http_date.")
    expect(out).toContain("django.utils.http.parse_http_date")
  })
})

describe("issueSymbolDefinitionSites — quality-filtered resolution (stub graph)", () => {
  it("keeps only the exact-name match, dropping a longer substring hit", async () => {
    const stubGraph = {
      search: async () => [
        { name: "AdminAuthenticationForm", filePath: "django/contrib/admin/forms.py", kind: "class" },
        { name: "AuthenticationForm", filePath: "django/contrib/auth/forms.py", kind: "class" },
      ],
    } as unknown as BunSqliteGraph
    const sites = await issueSymbolDefinitionSites("`AuthenticationForm` rejects a valid login", stubGraph)
    expect(sites).toEqual([{ symbol: "AuthenticationForm", kind: "class", file: "django/contrib/auth/forms.py" }])
  })

  it("drops a test-path row and keeps the source row", async () => {
    const stubGraph = {
      search: async () => [
        { name: "Widget", filePath: "django/forms/tests/test_widgets.py", kind: "class" },
        { name: "Widget", filePath: "django/forms/widgets.py", kind: "class" },
      ],
    } as unknown as BunSqliteGraph
    const sites = await issueSymbolDefinitionSites("`Widget` renders wrong", stubGraph)
    expect(sites).toEqual([{ symbol: "Widget", kind: "class", file: "django/forms/widgets.py" }])
  })

  it("retries on the last dotted segment when the full-token search misses", async () => {
    const calls: string[] = []
    const stubGraph = {
      search: async (query: string) => {
        calls.push(query)
        if (query === "django.db.backends.ddl_references.Columns") return []
        return [{ name: "Columns", filePath: "django/db/backends/ddl_references.py", kind: "class" }]
      },
    } as unknown as BunSqliteGraph
    const sites = await issueSymbolDefinitionSites(
      "`django.db.backends.ddl_references.Columns` resolves to nothing",
      stubGraph,
    )
    expect(sites).toEqual([
      { symbol: "django.db.backends.ddl_references.Columns", kind: "class", file: "django/db/backends/ddl_references.py" },
    ])
    expect(calls).toEqual(["django.db.backends.ddl_references.Columns", "Columns"])
  })

  it("a .py-shaped symbol passes through as a file site with no graph call", async () => {
    let searchCalls = 0
    const stubGraph = {
      search: async () => {
        searchCalls++
        return []
      },
    } as unknown as BunSqliteGraph
    const sites = await issueSymbolDefinitionSites("The fix belongs in `django/contrib/auth/forms.py`", stubGraph)
    expect(sites).toEqual([
      { symbol: "django/contrib/auth/forms.py", kind: "file", file: "django/contrib/auth/forms.py" },
    ])
    expect(searchCalls).toBe(0)
  })
})

describe("issueSymbolDefinitionSitesIfReady", () => {
  it("resolves against a ready (unregistered) stub graph and returns an array, not null", async () => {
    const stubGraph = {
      search: async () => [{ name: "Widget", filePath: "django/forms/widgets.py", kind: "class" }],
    } as unknown as BunSqliteGraph
    const sites = await issueSymbolDefinitionSitesIfReady("`Widget` renders wrong", stubGraph)
    expect(sites).toEqual([{ symbol: "Widget", kind: "class", file: "django/forms/widgets.py" }])
  })
})
