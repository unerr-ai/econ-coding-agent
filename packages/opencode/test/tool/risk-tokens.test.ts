/**
 * candidateRiskTokens: symbol-shaped tokens must beat prose to the RISK_MAX_TOKENS
 * budget cap (prose filled the cap before mergeDefs/$ZodObject/safeExtend were
 * ever read).
 */

import { describe, it, expect } from "bun:test"
import { candidateRiskTokens } from "../../src/tool/graph-tools"

describe("candidateRiskTokens — symbol-shaped tokens beat prose", () => {
  it("a fix-turn-shaped prompt: surfaces mergeDefs/$ZodObject/safeExtend, drops burned prose", () => {
    const prompt =
      "Now fix it properly in the schema-composition core. The bug lives in the merge() helper in " +
      "packages/zod/src/v4/core/util.ts, which builds the merged definition via mergeDefs and clone, " +
      "and interacts with $ZodObject, extend, safeExtend and the catchall semantics."
    const out = candidateRiskTokens(prompt)
    expect(out).toContain("mergeDefs")
    expect(out).toContain("$ZodObject")
    expect(out).toContain("safeExtend")
    expect(out.map((t) => t.toLowerCase())).not.toContain("properly")
    expect(out.map((t) => t.toLowerCase())).not.toContain("lives")
    expect(out.map((t) => t.toLowerCase())).not.toContain("builds")
  })

  it("an audit-turn-shaped prompt: surfaces $ZodObject/mergeDefs/safeExtend despite instruction-prose opener", () => {
    const prompt =
      "Before we ship this, audit the blast radius of your change across the schema-composition core. " +
      "The touched helper sits under $ZodObject composition: merge, mergeDefs, clone, extend, safeExtend, catchall"
    const out = candidateRiskTokens(prompt)
    expect(out).toContain("$ZodObject")
    expect(out).toContain("mergeDefs")
    expect(out).toContain("safeExtend")
  })

  it("a prose-only prompt still returns prose tokens (pass 2 works)", () => {
    const out = candidateRiskTokens("Please take a careful look at the overall layout again")
    expect(out.length).toBeGreaterThan(0)
  })

  it("recognizes backticked, snake_case, and dotted forms as symbol-shaped", () => {
    const prompt = "renders `fooBar` correctly, touches foo_bar and a.b.fooHelper directly"
    const out = candidateRiskTokens(prompt)
    expect(out).toContain("fooBar")
    expect(out).toContain("foo_bar")
    expect(out).toContain("fooHelper")
  })

  it("a plain-lowercase backticked word is symbol-shaped purely via the backtick", () => {
    const prompt = "the fix touches `merge` under the hood, please verify behavior across the board"
    const out = candidateRiskTokens(prompt)
    // "merge" is backticked so it must win a pass-1 slot ahead of any prose token
    // that appears later in the sentence.
    expect(out[0]).toBe("merge")
  })

  it("keeps the cap at 12 and dedupes case-insensitively", () => {
    const prompt =
      "MergeDefs mergedefs MERGEDEFS $ZodObject zodobject safeExtend SAFEEXTEND foo_bar FOO_BAR " +
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"
    const out = candidateRiskTokens(prompt)
    expect(out.length).toBeLessThanOrEqual(12)
    const lowered = out.map((t) => t.toLowerCase())
    expect(new Set(lowered).size).toBe(lowered.length)
  })
})
