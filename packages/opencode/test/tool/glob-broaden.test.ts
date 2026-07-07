import { describe, expect, it } from "bun:test"
import { broadenPattern } from "../../src/tool/glob"

describe("broadenPattern", () => {
  it("broadens a metacharacter-free single-segment miss to a recursive last-segment wildcard", () => {
    expect(broadenPattern("jest.config")).toBe("**/jest.config*")
  })

  it("uses only the final segment of a multi-segment pattern", () => {
    expect(broadenPattern("test/plugin/timezone")).toBe("**/timezone*")
  })

  const WITH_METACHARACTERS = ["test/**/timezone*", "*.ts", "test/plugin/timezone?", "test/plugin/{a,b}", "a[bc]d"]

  it.each(WITH_METACHARACTERS)("leaves a pattern with glob metacharacters (%s) untouched", (pattern) => {
    expect(broadenPattern(pattern)).toBeUndefined()
  })

  it("returns undefined when the broadened form is identical to the input", () => {
    expect(broadenPattern("**/jest.config*")).toBeUndefined()
  })
})
