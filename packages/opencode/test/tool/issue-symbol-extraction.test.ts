/**
 * Wave 7 — extractIssueSymbols: pure symbol extraction over an issue text
 * (no graph access — `issue-symbol-definition-sites.test.ts`-shaped graph
 * grounding would need a fixture graph and lives with the hub-design-judge
 * live-fire work instead). Mirrors risk-tokens.test.ts's table shape for
 * candidateRiskTokens, its sibling extractor in the same file.
 */

import { describe, it, expect } from "bun:test"
import { extractIssueSymbols } from "../../src/tool/graph-tools"

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
})
