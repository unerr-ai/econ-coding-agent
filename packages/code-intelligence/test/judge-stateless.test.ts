/**
 * OL-9.2c judge-stateless invariant: every verification call — the
 * cross-model judge (judge.ts), the RM rung (rm-verifier.ts), and each
 * escalation hop's ladder input in slice-loop.ts — is constructed FRESH per
 * call: no session, transcript, or mutable context is carried between two
 * verdicts. Verifier de-correlation is a design pillar (§4.3): a judge that
 * remembered a prior attempt's output could rubber-stamp a rescue instead of
 * judging it on its own merits. The code already guarantees this
 * structurally (each call builds its own closure/input from only its own
 * arguments) — these tests encode that structure so a future refactor can't
 * silently reintroduce shared state.
 */

import { describe, it, expect } from "bun:test"
import { runCrossModelJudge, judgeRung, type CrossModelJudgeInput } from "../src/judge.js"
import { createRmVerifierRung, type RmClient } from "../src/rm-verifier.js"
import { resolveVerifierTier } from "../src/model-registry.js"
import { buildLadderInput, type LoopSlice, type SliceDispatchResult, type SliceLoopDeps } from "../src/slice-loop.js"
import type { SoundVerdict, BehaviorResult, SliceTrajectory } from "../src/verifier.js"

const cleanSound: SoundVerdict = { rung: "sound", pass: true, failures: [], applicable: false }
const cleanBehavior: BehaviorResult = { suspicious: false, flags: [] }
const cleanTrajectory: SliceTrajectory = { events: [] }
const cleanCtx = { sound: cleanSound, behavior: cleanBehavior, trajectory: cleanTrajectory }

// ---------------------------------------------------------------------------
// runCrossModelJudge — each call's prompt comes from only that call's input
// ---------------------------------------------------------------------------

describe("OL-9.2c judge-stateless invariant — runCrossModelJudge", () => {
  it("builds each call's prompt from only that call's own input — no leakage across two verdicts", async () => {
    const seen: string[] = []
    const generate = async (prompt: string) => {
      seen.push(prompt)
      return "[[ACCEPT]] ok"
    }
    const inputA: CrossModelJudgeInput = { task: "task A", output: "OUTPUT_A_SECRET", generate }
    const inputB: CrossModelJudgeInput = { task: "task B", output: "OUTPUT_B_SECRET", generate }

    await runCrossModelJudge(inputA)
    await runCrossModelJudge(inputB)

    expect(seen.length).toBe(2)
    expect(seen[0]).toContain("OUTPUT_A_SECRET")
    expect(seen[0]).not.toContain("OUTPUT_B_SECRET")
    expect(seen[1]).toContain("OUTPUT_B_SECRET")
    expect(seen[1]).not.toContain("OUTPUT_A_SECRET")
  })
})

// ---------------------------------------------------------------------------
// judgeRung — two closures are independent, neither leaks into the other
// ---------------------------------------------------------------------------

describe("OL-9.2c judge-stateless invariant — judgeRung closures", () => {
  it("two judgeRung closures are independent — one's verdict never affects the other's", async () => {
    const rungA = judgeRung({ task: "t", output: "a", generate: async () => "[[ACCEPT]]" })
    const rungB = judgeRung({ task: "t", output: "b", generate: async () => "[[REJECT]]" })

    const verdictA = await rungA(cleanCtx)
    const verdictB = await rungB(cleanCtx)
    expect(verdictA?.pass).toBe(true)
    expect(verdictB?.pass).toBe(false)

    // Re-invoking rungA (fresh ctx each time) still reflects only its own closed-over input.
    const verdictAAgain = await rungA(cleanCtx)
    expect(verdictAAgain?.pass).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createRmVerifierRung — no accumulation of ctx across calls
// ---------------------------------------------------------------------------

describe("OL-9.2c judge-stateless invariant — createRmVerifierRung", () => {
  it("passes only the current call's ctx to the client — no accumulation across calls", async () => {
    const calls: unknown[] = []
    const client: RmClient = async (_endpoint, input) => {
      calls.push(input)
      return { score: 1 }
    }
    const rung = createRmVerifierRung(resolveVerifierTier("https://rm.example.com/score"), client)

    const trajA: SliceTrajectory = { events: [{ kind: "command", command: "A_ONLY" }] }
    const trajB: SliceTrajectory = { events: [{ kind: "command", command: "B_ONLY" }] }
    await rung({ ...cleanCtx, trajectory: trajA })
    await rung({ ...cleanCtx, trajectory: trajB })

    expect(calls.length).toBe(2)
    expect(calls[0]).toEqual({ trajectory: trajA, sound: cleanSound, behavior: cleanBehavior })
    expect(calls[1]).toEqual({ trajectory: trajB, sound: cleanSound, behavior: cleanBehavior })
  })
})

// ---------------------------------------------------------------------------
// slice-loop's buildLadderInput — a fresh extraRung closure per attempt
// ---------------------------------------------------------------------------

describe("OL-9.2c judge-stateless invariant — slice-loop's buildLadderInput", () => {
  it("constructs a fresh extraRung per attempt — the escalated hop's judge prompt carries none of the cheap hop's output", async () => {
    const seenPrompts: string[] = []
    const judgeGenerate = async (prompt: string) => {
      seenPrompts.push(prompt)
      return "[[ACCEPT]]"
    }
    const slice: LoopSlice = { id: "s1", prompt: "do the thing", wiring: "wiring facts" }
    const allocation = { tier: "oracle" as const, verification: "judge" as const, reason: "" }
    const deps: SliceLoopDeps = { dispatch: async () => ({ text: "", trajectory: { events: [] } }), judgeGenerate }

    const cheapResult: SliceDispatchResult = { text: "CHEAP_OUTPUT_SECRET", trajectory: { events: [] } }
    const escalatedResult: SliceDispatchResult = { text: "ESCALATED_OUTPUT_SECRET", trajectory: { events: [] } }

    const ladderA = buildLadderInput(slice, allocation, cheapResult, deps)
    const ladderB = buildLadderInput(slice, allocation, escalatedResult, deps)

    // Each attempt gets its OWN extraRung closure — never a shared/mutated one.
    expect(ladderA.extraRung).toBeDefined()
    expect(ladderA.extraRung).not.toBe(ladderB.extraRung)

    await ladderA.extraRung?.(cleanCtx)
    await ladderB.extraRung?.(cleanCtx)

    expect(seenPrompts.length).toBe(2)
    expect(seenPrompts[0]).toContain("CHEAP_OUTPUT_SECRET")
    expect(seenPrompts[0]).not.toContain("ESCALATED_OUTPUT_SECRET")
    expect(seenPrompts[1]).toContain("ESCALATED_OUTPUT_SECRET")
    expect(seenPrompts[1]).not.toContain("CHEAP_OUTPUT_SECRET")
  })
})
