/**
 * Unit tests for judge.ts: the cross-model judge rung (OL-7.8 / OL-7.3).
 * All samplers are injected doubles — no live model. Covers verdict parsing
 * (accept / reject / reject-wins-over-accept / unparseable → undefined),
 * defensive degradation on a thrown sampler, the prompt shape, and the
 * ExtraRungFn adapter that plugs into the verifier ladder.
 */

import { describe, it, expect } from "bun:test"
import { runCrossModelJudge, buildJudgePrompt, judgeRung } from "../src/judge.js"

const base = { task: "add a null guard to parseConfig", output: "return cfg ?? {}" }

describe("runCrossModelJudge — verdict parsing", () => {
  it("passes on an [[ACCEPT]] token", async () => {
    const v = await runCrossModelJudge({ ...base, generate: async () => "[[ACCEPT]] handles the null case" })
    expect(v?.rung).toBe("judge")
    expect(v?.pass).toBe(true)
  })

  it("fails on a [[REJECT]] token", async () => {
    const v = await runCrossModelJudge({ ...base, generate: async () => "[[REJECT]] misses the array case" })
    expect(v?.pass).toBe(false)
  })

  it("lets an explicit reject win when both tokens appear (safe direction)", async () => {
    const v = await runCrossModelJudge({ ...base, generate: async () => "could ACCEPT but I REJECT it" })
    expect(v?.pass).toBe(false)
  })

  it("returns undefined (degrade to next rung) on an unparseable reply", async () => {
    const v = await runCrossModelJudge({ ...base, generate: async () => "hmm, not sure" })
    expect(v).toBeUndefined()
  })

  it("returns undefined (degrade) when the sampler throws — never blocks the slice", async () => {
    const v = await runCrossModelJudge({
      ...base,
      generate: async () => {
        throw new Error("judge endpoint down")
      },
    })
    expect(v).toBeUndefined()
  })
})

describe("buildJudgePrompt", () => {
  it("includes the task and output, and the wiring only when supplied", () => {
    const withoutWiring = buildJudgePrompt({ ...base, generate: async () => "" })
    expect(withoutWiring).toContain(base.task)
    expect(withoutWiring).toContain(base.output)
    expect(withoutWiring).not.toContain("## Wiring")

    const withWiring = buildJudgePrompt({ ...base, wiring: "parseConfig has 3 callers", generate: async () => "" })
    expect(withWiring).toContain("## Wiring")
    expect(withWiring).toContain("parseConfig has 3 callers")
  })

  it("instructs the judge to name a MISSING line on reject (OL-9.4c)", () => {
    const prompt = buildJudgePrompt({ ...base, generate: async () => "" })
    expect(prompt).toContain("MISSING:")
  })

  it("asks the boundary-input question — empty/zero/falsy variants of every repro input", () => {
    const prompt = buildJudgePrompt({ ...base, generate: async () => "" })
    expect(prompt).toContain("empty/zero/falsy variant")
    expect(prompt).toContain("check, don't assume")
  })

  it("asks the sibling-branch consistency question", () => {
    const prompt = buildJudgePrompt({ ...base, generate: async () => "" })
    expect(prompt).toContain("sibling branch(es)")
    expect(prompt).toContain("parallel case set")
  })
})

// ---------------------------------------------------------------------------
// runCrossModelJudge — OL-9.4c MISSING-evidence parsing on reject
// ---------------------------------------------------------------------------

describe("runCrossModelJudge — OL-9.4c MISSING evidence on reject", () => {
  it("parses the judge's own MISSING line into the verdict", async () => {
    const v = await runCrossModelJudge({
      ...base,
      generate: async () => "[[REJECT]] misses the array case\nMISSING: a test asserting parseConfig([]) returns {}",
    })
    expect(v?.pass).toBe(false)
    expect(v?.missing).toBe("MISSING: a test asserting parseConfig([]) returns {}")
  })

  it("synthesizes a generic MISSING line when the judge rejects without naming one", async () => {
    const v = await runCrossModelJudge({ ...base, generate: async () => "[[REJECT]] misses the array case" })
    expect(v?.pass).toBe(false)
    expect(v?.missing).toBeDefined()
    expect(v?.missing).toContain("MISSING:")
  })

  it("never sets missing on an accepted verdict", async () => {
    const v = await runCrossModelJudge({ ...base, generate: async () => "[[ACCEPT]] handles the null case" })
    expect(v?.pass).toBe(true)
    expect(v?.missing).toBeUndefined()
  })
})

describe("judgeRung — ExtraRungFn adapter", () => {
  it("produces a rung fn the ladder can call with the sound/behavior ctx", async () => {
    const fn = judgeRung({ ...base, generate: async () => "[[ACCEPT]] fine" })
    const verdict = await fn({
      sound: { rung: "sound", pass: true, failures: [], applicable: false },
      behavior: { suspicious: false, flags: [] },
      trajectory: { events: [] },
    })
    expect(verdict?.rung).toBe("judge")
    expect(verdict?.pass).toBe(true)
  })
})
