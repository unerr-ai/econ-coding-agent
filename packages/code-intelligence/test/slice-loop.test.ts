/**
 * Unit tests for slice-loop.ts (OL-7.3 + OL-2.2) — the execute-cheap-then-verify
 * state machine. Everything external is an injected double: dispatch, the sound
 * command runner, the judge/QE samplers, and (where useful) allocation. No live
 * model, no real shell. Covers: happy path (all cheap),
 * verifier-reject → ladder climb (executor→conductor first, re-verified per
 * hop) with a compiled failure brief + double-pay, the recon ladder cap
 * (stops at the conductor, never the oracle), the escalation brief's prior-
 * attempt context digest (+ its truncation), design → oracle direct,
 * judge rung on the untestable cell, DAG ordering, the planWaves
 * scheduler (cycle / unknown-dep), and the U3 failure-containment bracket
 * (track/restore around editable attempts, read-only slices never
 * bracketed, the REVERTED diff on the escalation brief and on ladder
 * exhaustion, escalation provenance, and a zero-behavior-change absent dep).
 */

import { describe, it, expect } from "bun:test"
import {
  runSliceLoop,
  planWaves,
  escalateTier,
  buildLadderInput,
  withUpstreamContext,
  sliceTimeoutMs,
  overallLoopBudgetMs,
  SliceTimeoutError,
  RECON_VERIFY_TIMEOUT_MS,
  MECHANICAL_DESIGN_TIMEOUT_MS,
  ESCALATION_TIMEOUT_FACTOR,
  LOOP_BUDGET_FACTOR,
  SAME_TIER_RETRY_BUDGET,
  type LoopSlice,
  type SliceLoopDeps,
  type SliceDispatchRequest,
  type SliceDispatchResult,
  type SliceOutcome,
} from "../src/slice-loop.js"
import type { CommandResult, VerifyCommand } from "../src/verifier.js"
import { ECON_TIER_BINDING } from "../src/model-registry.js"
import type { EconTier } from "../src/region.js"

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const okResult = (text: string): SliceDispatchResult => ({
  text,
  trajectory: { events: [] },
})

/** A dispatch double that records every request and returns per-tier canned output + usage. */
function recordingDispatch(opts?: {
  onCheap?: (req: SliceDispatchRequest) => SliceDispatchResult
  onEscalated?: (req: SliceDispatchRequest) => SliceDispatchResult
}) {
  const calls: SliceDispatchRequest[] = []
  const dispatch = async (req: SliceDispatchRequest): Promise<SliceDispatchResult> => {
    calls.push({ ...req })
    if (req.escalated) return opts?.onEscalated?.(req) ?? okResult(`escalated:${req.sliceId}`)
    return opts?.onCheap?.(req) ?? okResult(`cheap:${req.sliceId}`)
  }
  return { dispatch, calls }
}

const passRunner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "ok", stderr: "" })
const failRunner = async (c: VerifyCommand): Promise<CommandResult> => ({
  exitCode: 1,
  stdout: "",
  stderr: `${c.kind} failed: TS2322 type mismatch`,
})

/** A snapshot double (U3) that records every track/restore/diff call in order, so a test can assert bracket ordering without a real git shadow repo. */
function fakeSnapshot(opts?: { diffText?: string }) {
  const calls: Array<{ fn: "track" | "restore" | "diff"; hash?: string }> = []
  let trackCount = 0
  const snapshot = {
    track: async (): Promise<string | undefined> => {
      trackCount += 1
      calls.push({ fn: "track" })
      return `hash-${trackCount}`
    },
    restore: async (hash: string): Promise<void> => {
      calls.push({ fn: "restore", hash })
    },
    diff: async (hash: string): Promise<string> => {
      calls.push({ fn: "diff", hash })
      return opts?.diffText ?? `diff-for-${hash}`
    },
  }
  return { snapshot, calls }
}

// ---------------------------------------------------------------------------
// Happy path — all slices pass cheap
// ---------------------------------------------------------------------------

describe("runSliceLoop — happy path (all cheap)", () => {
  it("runs every slice on its allocated cheap tier and never escalates", async () => {
    const { dispatch, calls } = recordingDispatch()
    const slices: LoopSlice[] = [
      { id: "edit", prompt: "propagate signature", sliceType: "mechanical", coupling: "high", testStrength: "testable", verifyCommands: [{ kind: "typecheck", command: "tsc" }] },
      { id: "recon", prompt: "map callers", sliceType: "recon", coupling: "low", testStrength: "testable", verifyCommands: [{ kind: "test", command: "bun test" }] },
    ]
    const result = await runSliceLoop(slices, { dispatch, runCommand: passRunner })

    expect(result.engaged).toBe(true)
    expect(result.outcomes.every((o) => o.state === "accepted")).toBe(true)
    // CORE INVARIANT: the high-coupling *testable* slice stayed on the executor.
    expect(result.outcomes[0].tier).toBe("executor")
    expect(result.ledger.escalations).toBe(0)
    expect(result.ledger.totalWastedCost).toBe(0)
    expect(calls.every((c) => c.escalated === false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reject → climb the ladder with a compiled brief + double-pay
// ---------------------------------------------------------------------------

describe("runSliceLoop — reject climbs the ladder (OL-2.2 + double-pay)", () => {
  const slice: LoopSlice = {
    id: "prop",
    prompt: "propagate the refresh signature to all callers",
    sliceType: "mechanical",
    coupling: "low",
    testStrength: "testable",
    verifyCommands: [{ kind: "typecheck", command: "tsc --noEmit" }],
    wiring: "refreshToken() has 40 callers across auth/",
  }

  it("rescues a failed executor slice with a same-tier squeeze retry (M2, re-verified) and records double-pay", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING.executor, cost: 0.001, tokens: { input: 100, output: 200 } } }),
      onEscalated: () => ({ text: "fixed patch", trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING.conductor, cost: 0.02, tokens: { input: 300, output: 400 } } }),
    })
    // The cheap attempt fails its sound check; the same-tier squeeze retry passes.
    let runs = 0
    const flakyRunner = async (c: VerifyCommand): Promise<CommandResult> =>
      runs++ === 0
        ? { exitCode: 1, stdout: "", stderr: `${c.kind} failed: TS2322 type mismatch` }
        : { exitCode: 0, stdout: "ok", stderr: "" }
    const result = await runSliceLoop([slice], { dispatch, runCommand: flakyRunner })

    const outcome = result.outcomes[0]
    expect(outcome.state).toBe("escalated")
    expect(outcome.output).toBe("fixed patch")
    expect(outcome.escalation?.tier).toBe("executor") // squeeze — same tier, not a climb (M2)
    expect(outcome.verdict.accepted).toBe(true) // the rescue's verdict, not the cheap one

    // Two dispatches: cheap (executor, not escalated) then the same-tier squeeze retry.
    expect(calls.length).toBe(2)
    expect(calls[0].escalated).toBe(false)
    expect(calls[0].tier).toBe("executor")
    expect(calls[1].escalated).toBe(true)
    expect(calls[1].tier).toBe("executor")

    // The escalation prompt is a COMPILED BRIEF (bounded failure evidence) plus the
    // prior attempt's digested context (OL rescue continuity) — never the raw transcript
    // smuggled into the failure evidence itself.
    const briefText = calls[1].prompt
    expect(briefText).toContain("## Failure Evidence")
    expect(briefText).toContain("typecheck")
    expect(briefText).toContain("refreshToken() has 40 callers across auth/") // wiring, not transcript
    const failureEvidenceSection = briefText.slice(0, briefText.indexOf("## Prior attempt's gathered context"))
    expect(failureEvidenceSection).not.toContain("bad patch") // failure evidence stays bounded evidence
    // ...but the prior-attempt digest legitimately carries the raw cheap output now (build-on-this context).
    expect(briefText).toContain("## Prior attempt's gathered context (build on this — do NOT redo its recon)")
    expect(briefText).toContain("bad patch")

    // Double-pay: the discarded cheap spend is recorded net.
    expect(result.ledger.escalations).toBe(1)
    expect(result.ledger.totalWastedCost).toBeCloseTo(0.001, 6)
    expect(outcome.escalation?.record.totalCost).toBeCloseTo(0.021, 6)
  })

  it("squeezes the executor to its budget while converging, climbs to the conductor, squeezes there too, then settles unverified (frozen sequences 1+2)", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING.executor, cost: 0.001, tokens: { input: 100, output: 200 } } }),
      onEscalated: (req) => ({ text: `rescue:${req.tier}`, trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING[req.tier], cost: 0.02, tokens: { input: 300, output: 400 } } }),
    })
    // A new exit code (→ a new MISSING line, a new signature) every call, and
    // it never passes — isolates the squeeze budget (SAME_TIER_RETRY_BUDGET)
    // as the thing that ends each tier's squeezing, not a signature repeat.
    let call = 0
    const everConverging = async (): Promise<CommandResult> => {
      call += 1
      return { exitCode: call, stdout: "", stderr: `attempt ${call}` }
    }
    const result = await runSliceLoop([slice], { dispatch, runCommand: everConverging })

    const outcome = result.outcomes[0]
    // Sequence 1: executor(rejA) → squeeze exec(rejB) → squeeze exec(rejC,
    // budget=2 spent) → CLIMB conductor. Sequence 2: the conductor ALSO
    // rejects, so it squeezes there too, spends its own budget, and — because
    // a non-critical slice's climb depth is 1 — settles unverified AT the
    // conductor, never reaching the reasoner. The INVARIANT: it reached (and
    // squeezed) the conductor before settling; a stalled/exhausted squeeze
    // never denies the one climb a non-critical slice is owed.
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "executor", "conductor", "conductor", "conductor"])
    expect(calls.map((c) => c.escalated)).toEqual([false, true, true, true, true, true])
    expect(outcome.state).toBe("unverified")
    expect(outcome.escalation?.tier).toBe("conductor")
    expect(outcome.attempts).toBe(6)

    // 5 discarded hops (2 squeezes + 1 climb + 2 squeezes), all recorded net —
    // plus the discarded cheap attempt (0.001 + 4*0.02 rescue hops; the final,
    // still-rejected 6th call is the settle point, not itself "wasted" spend).
    expect(result.ledger.escalations).toBe(5)
    expect(result.ledger.totalWastedCost).toBeCloseTo(0.081, 6)
  })

  it("stalls on a repeated signature at the executor and climbs immediately — still reaches the conductor (frozen sequence 3)", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING.executor, cost: 0.001, tokens: { input: 100, output: 200 } } }),
      onEscalated: (req) => ({ text: `rescue:${req.tier}`, trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING[req.tier], cost: 0.02, tokens: { input: 300, output: 400 } } }),
    })
    const result = await runSliceLoop([slice], { dispatch, runCommand: failRunner, maxAttempts: () => 4 })

    const outcome = result.outcomes[0]
    // failRunner's repeated signature means the executor gets exactly one
    // squeeze retry (converging on the first look, stalling on the repeat)
    // before climbing; the conductor then gets its own one squeeze before its
    // signature repeats too, and — non-critical climb depth = 1 — settles
    // unverified AT the conductor without ever reaching the reasoner.
    expect(outcome.state).toBe("unverified")
    expect(outcome.escalation?.tier).toBe("conductor")
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "conductor", "conductor"])
    expect(result.ledger.escalations).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// M2 — squeeze the tier before escalating: a rejected attempt retries the
// SAME tier while its failure signature is still converging, and climbs only
// on stall (signature repeats, or SAME_TIER_RETRY_BUDGET is spent).
// ---------------------------------------------------------------------------

describe("runSliceLoop — M2 same-tier squeeze retry", () => {
  const squeezeSlice: LoopSlice = {
    id: "s",
    prompt: "p",
    sliceType: "mechanical",
    coupling: "low",
    testStrength: "testable",
    verifyCommands: [{ kind: "typecheck", command: "tsc" }],
  }

  it("retries the same tier while the failure signature keeps changing, up to SAME_TIER_RETRY_BUDGET, then climbs", async () => {
    const { dispatch, calls } = recordingDispatch()
    let call = 0
    // A new exit code (→ a new MISSING line, a new signature) every call — never repeats.
    const everNewSignature = async (): Promise<CommandResult> => {
      call += 1
      return { exitCode: call, stdout: "", stderr: `attempt ${call}` }
    }
    const provenance: Array<{ fromTier: string; toTier: string; rungReason: string }> = []
    const result = await runSliceLoop([squeezeSlice], {
      dispatch,
      runCommand: everNewSignature,
      maxAttempts: () => 4,
      onProvenance: (e) => provenance.push(e),
    })

    // 1 cheap attempt + SAME_TIER_RETRY_BUDGET (2) same-tier squeeze retries —
    // the squeeze budget (not the attempt backstop) is what climbs it, even
    // though the signature was still changing on every call. everNewSignature
    // never passes, so the conductor hop also rejects; a non-critical slice's
    // climb depth (1) then settles it unverified AT the conductor.
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "executor", "conductor"])
    expect(calls.filter((c) => c.tier === "executor").length).toBe(1 + SAME_TIER_RETRY_BUDGET)
    expect(provenance.map((p) => p.rungReason.includes("squeeze-retry"))).toEqual([true, true, false])
    expect(provenance[2]).toMatchObject({ fromTier: "executor", toTier: "conductor" })
    expect(result.outcomes[0].state).toBe("unverified")
    expect(result.outcomes[0].escalation?.tier).toBe("conductor")
  })

  it("stalls and climbs immediately when the retry's signature repeats (no new failure surfaced)", async () => {
    const { dispatch, calls } = recordingDispatch()
    const provenance: Array<{ fromTier: string; toTier: string; rungReason: string }> = []
    const result = await runSliceLoop([squeezeSlice], {
      dispatch,
      runCommand: failRunner, // deterministic — same stderr/exit every call, so the same MISSING line every time
      maxAttempts: () => 3,
      onProvenance: (e) => provenance.push(e),
    })

    // The one squeeze retry's signature is identical to the cheap attempt's —
    // no new information surfaced — so it climbs on the very next hop instead
    // of spending its remaining squeeze budget.
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "conductor"])
    expect(provenance[0].rungReason).toContain("squeeze-retry")
    expect(provenance[1].rungReason).not.toContain("squeeze-retry")
    expect(provenance[1]).toMatchObject({ fromTier: "executor", toTier: "conductor" })
    expect(result.outcomes[0].state).toBe("unverified")
  })

  it("INVARIANT: a non-critical slice that rejects at every dispatch always reaches the conductor before settling unverified — squeeze never denies the climb", async () => {
    const { dispatch, calls } = recordingDispatch()
    const result = await runSliceLoop([squeezeSlice], { dispatch, runCommand: failRunner })

    // failRunner repeats the same signature every call: the squeeze stalls
    // immediately at the executor (climbs early), squeezes once more at the
    // conductor (fresh signature there), stalls again, and — non-critical
    // climb depth = 1 — settles unverified AT the conductor. MAX_SLICE_ATTEMPTS
    // (8, a backstop) is nowhere near binding here — the squeeze-budget /
    // stall-guard / climb-depth mechanics are what stop it, and a climb to
    // "conductor" happens before the settle either way.
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "conductor", "conductor"])
    expect(calls.some((c) => c.tier === "conductor")).toBe(true) // reached the conductor
    expect(result.outcomes[0].attempts).toBe(4)
    expect(result.outcomes[0].state).toBe("unverified")
    expect(result.outcomes[0].escalation?.tier).toBe("conductor")
  })

  it("never squeeze-retries a read-only (recon/verify) slice — unchanged, caps at 1 dispatch", async () => {
    const { dispatch, calls } = recordingDispatch()
    const slice: LoopSlice = {
      id: "explore",
      prompt: "map callers",
      sliceType: "recon",
      testStrength: "testable",
      verifyCommands: [{ kind: "test", command: "bun test" }],
    }
    const result = await runSliceLoop([slice], { dispatch, runCommand: failRunner })

    expect(calls.map((c) => c.tier)).toEqual(["executor"])
    expect(result.outcomes[0].attempts).toBe(1)
    expect(result.outcomes[0].state).toBe("unverified")
  })
})

// ---------------------------------------------------------------------------
// M3 — consequence (high coupling, or risk over the allocator's tiebreak) no
// longer buys the generator extra climbs: every slice, critical or not, is
// bounded by the same maxClimbs. A critical slice that stays unverified once
// its climb budget is spent settles LOUDLY (a distinct provenance marker,
// critical-unverified-review) instead of force-climbing toward the oracle —
// the turn owner reviews it; the generator is never paid more for it.
// ---------------------------------------------------------------------------

describe("runSliceLoop — M3 loud-for-review (critical slices bounded by maxClimbs, never force-climbed)", () => {
  it("does not force a climb past maxClimbs even when a further climb would have passed — settles unverified, loud", async () => {
    const { dispatch, calls } = recordingDispatch()
    let call = 0
    const passFromReasonerOn = async (): Promise<CommandResult> => {
      call += 1
      return call <= 4 ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "ok", stderr: "" }
    }
    const slice: LoopSlice = {
      id: "s",
      prompt: "p",
      sliceType: "mechanical",
      coupling: "high",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const provenance: Array<{ fromTier: string; toTier: string; rungReason: string }> = []
    const result = await runSliceLoop([slice], { dispatch, runCommand: passFromReasonerOn, onProvenance: (e) => provenance.push(e) })

    const outcome = result.outcomes[0]
    // executor(fail) → squeeze exec stalls immediately (identical "boom"
    // signature) → climb conductor(fail) → squeeze conductor stalls too —
    // maxClimbs (1) is now spent, so the slice settles unverified AT the
    // conductor even though a 5th dispatch (reasoner) would have passed:
    // criticality no longer buys the extra climb to find out.
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "conductor", "conductor"])
    expect(outcome.state).toBe("unverified")
    expect(outcome.escalation?.tier).toBe("conductor")
    expect(outcome.attempts).toBe(4)
    const loud = provenance.find((p) => p.rungReason === "critical-unverified-review")
    expect(loud).toBeDefined()
    expect(loud).toMatchObject({ fromTier: "conductor", toTier: "conductor" })
  })

  it("settles unverified at its maxClimbs bound with a loud critical-unverified-review marker — never a silent accept", async () => {
    const { dispatch, calls } = recordingDispatch()
    const slice: LoopSlice = {
      id: "s",
      prompt: "p",
      sliceType: "mechanical",
      coupling: "high",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const provenance: Array<{ fromTier: string; toTier: string; rungReason: string }> = []
    const result = await runSliceLoop([slice], { dispatch, runCommand: failRunner, onProvenance: (e) => provenance.push(e) })

    const outcome = result.outcomes[0]
    // failRunner never passes and always repeats the same signature: one
    // squeeze stalls immediately at the executor, one climb to the
    // conductor, one more squeeze stalls there too — maxClimbs (1) is
    // spent, so it settles unverified AT the conductor, never climbing
    // toward the oracle — LOUDLY (a distinct provenance marker).
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "conductor", "conductor"])
    expect(outcome.state).toBe("unverified")
    expect(outcome.escalation?.tier).toBe("conductor")
    const loud = provenance.find((p) => p.rungReason === "critical-unverified-review")
    expect(loud).toBeDefined()
    expect(loud).toMatchObject({ fromTier: "conductor", toTier: "conductor" })
  })

  it("leaves a non-critical slice unaffected — settles unverified at the same budget's ceiling, same as before", async () => {
    const { dispatch, calls } = recordingDispatch()
    const slice: LoopSlice = {
      id: "s",
      prompt: "p",
      sliceType: "mechanical",
      coupling: "low",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const provenance: Array<{ fromTier: string; toTier: string; rungReason: string }> = []
    const result = await runSliceLoop([slice], { dispatch, runCommand: failRunner, onProvenance: (e) => provenance.push(e) })

    // Squeeze stalls at the executor (climb early), squeezes once more at the
    // conductor, stalls again — climb depth = 1 for every slice alike, so it
    // settles AT the conductor with no loud marker (that's critical-only).
    expect(calls.map((c) => c.tier)).toEqual(["executor", "executor", "conductor", "conductor"])
    expect(result.outcomes[0].state).toBe("unverified")
    expect(provenance.some((p) => p.rungReason === "critical-unverified-review")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Read-only (recon/verify) attempt cap — a failed verify is information for
// the parent, not grounds to re-run; these slices never climb the ladder
// (OL-9.5d).
// ---------------------------------------------------------------------------

describe("runSliceLoop — read-only slice attempt cap (no ladder at all, OL-9.5d)", () => {
  it("caps a recon slice at 1 dispatch on a rejecting verdict, ending unverified with no escalation hop", async () => {
    const slice: LoopSlice = {
      id: "explore",
      prompt: "map every caller of refreshToken",
      sliceType: "recon",
      testStrength: "testable",
      verifyCommands: [{ kind: "test", command: "bun test" }],
    }
    const { dispatch, calls } = recordingDispatch()
    const result = await runSliceLoop([slice], { dispatch, runCommand: failRunner })

    const outcome = result.outcomes[0]
    expect(outcome.state).toBe("unverified")
    // Read-only slices cap at 1 attempt — never dispatch the rescue hop.
    expect(calls.map((c) => c.tier)).toEqual(["executor"])
    expect(outcome.attempts).toBe(1)
  })

  it("caps a verify slice at 1 dispatch too", async () => {
    const slice: LoopSlice = {
      id: "check",
      prompt: "verify the migration ran cleanly",
      sliceType: "verify",
      testStrength: "testable",
      verifyCommands: [{ kind: "test", command: "bun test" }],
    }
    const { dispatch, calls } = recordingDispatch()
    const result = await runSliceLoop([slice], { dispatch, runCommand: failRunner })

    expect(result.outcomes[0].state).toBe("unverified")
    expect(calls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Untestable slice accepted-unverified, not laddered — the run-8 regression:
// derived slices carry no sound spec, so the old default-reject fallback ×
// the (then-uncapped) ladder meant up to 4 dispatches of already-finished
// work (8 distinct briefs -> 62 runner sessions; "Apply the fix" dispatched
// 5x). OL-9.5d: absence of a check is not evidence of failure.
// ---------------------------------------------------------------------------

describe("runSliceLoop — untestable slice accepted unverified, not laddered (run-8 regression)", () => {
  it("accepts a slice with no sound spec, no extension rung, and no QE sampler on the cheap attempt alone", async () => {
    const { dispatch, calls } = recordingDispatch()
    const slice: LoopSlice = { id: "s", prompt: "do the thing", sliceType: "mechanical" }
    const result = await runSliceLoop([slice], { dispatch })

    const outcome = result.outcomes[0]
    expect(outcome.verdict.accepted).toBe(true)
    expect(outcome.verdict.unverified).toBe(true)
    expect(outcome.state).toBe("unverified")
    expect(outcome.attempts).toBe(1)
    expect(calls.length).toBe(1) // no ladder climb — a reject-free path never enters it
  })
})

// ---------------------------------------------------------------------------
// Escalation brief carries the failed attempt's gathered context (rescue continuity)
// ---------------------------------------------------------------------------

describe("runSliceLoop — escalation brief carries the prior attempt's context", () => {
  const slice: LoopSlice = {
    id: "prop",
    prompt: "propagate the refresh signature to all callers",
    sliceType: "mechanical",
    coupling: "high",
    testStrength: "testable",
    verifyCommands: [{ kind: "typecheck", command: "tsc --noEmit" }],
  }

  it("digests the failed attempt's edited files + commands into the escalation brief", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({
        text: "bad patch",
        trajectory: {
          events: [
            { kind: "file-edit", filePath: "src/auth/refresh.ts" },
            { kind: "command", command: "bun test src/auth" },
          ],
        },
      }),
    })
    await runSliceLoop([slice], { dispatch, runCommand: failRunner })

    const escalatedPrompt = calls[1].prompt
    expect(escalatedPrompt).toContain(
      "## Prior attempt's gathered context (build on this — do NOT redo its recon)",
    )
    expect(escalatedPrompt).toContain("Files already edited: src/auth/refresh.ts")
    expect(escalatedPrompt).toContain("Commands already run: bun test src/auth")
  })

  it("truncates a prior attempt's text longer than 6000 chars and keeps the brief bounded", async () => {
    const longText = "y".repeat(6500)
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: longText, trajectory: { events: [] } }),
    })
    await runSliceLoop([slice], { dispatch, runCommand: failRunner })

    const escalatedPrompt = calls[1].prompt
    expect(escalatedPrompt).toContain("…[truncated]")
    expect(escalatedPrompt).not.toContain(longText)
  })
})

// ---------------------------------------------------------------------------
// Design slice → reasoner direct
// ---------------------------------------------------------------------------

describe("runSliceLoop — design slice routes to the reasoner directly", () => {
  it("dispatches a design slice on the reasoner (no cheap-first hop for the irreducible-reasoning type)", async () => {
    const { dispatch, calls } = recordingDispatch()
    const slice: LoopSlice = { id: "design", prompt: "design the token-refresh interface", sliceType: "design" }
    // QE sampler agrees with the cheap output so the untestable design slice is accepted.
    const result = await runSliceLoop([slice], { dispatch, qeGenerate: async () => "cheap:design" })

    expect(calls[0].tier).toBe("reasoner")
    expect(result.outcomes[0].allocation.tier).toBe("reasoner")
    expect(result.outcomes[0].state).toBe("accepted")
  })
})

// ---------------------------------------------------------------------------
// Judge rung on the untestable + high-coupling cell
// ---------------------------------------------------------------------------

describe("runSliceLoop — cross-model judge rung (untestable + coupled)", () => {
  const judged: LoopSlice = { id: "j", prompt: "reshape the public API", coupling: "high", testStrength: "untestable", wiring: "API is exported from index" }

  it("accepts when the judge rules [[ACCEPT]]", async () => {
    const { dispatch } = recordingDispatch()
    const result = await runSliceLoop([judged], { dispatch, judgeGenerate: async () => "[[ACCEPT]] shape is right" })
    expect(result.outcomes[0].allocation.verification).toBe("judge")
    expect(result.outcomes[0].verdict.rung).toBe("judge")
    expect(result.outcomes[0].state).toBe("accepted")
  })

  it("marks unverified (no higher tier) when the judge rules [[REJECT]] at the oracle", async () => {
    const { dispatch } = recordingDispatch()
    const result = await runSliceLoop([judged], { dispatch, judgeGenerate: async () => "[[REJECT]] breaks a caller" })
    // Already on the oracle; escalateTier(oracle) === oracle → accept flagged unverified.
    expect(result.outcomes[0].state).toBe("unverified")
    expect(result.outcomes[0].verdict.accepted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DAG ordering
// ---------------------------------------------------------------------------

describe("runSliceLoop — dependency ordering", () => {
  it("runs dependent slices in series and independent slices in the same wave", async () => {
    const order: string[] = []
    const dispatch = async (req: SliceDispatchRequest): Promise<SliceDispatchResult> => {
      order.push(req.sliceId)
      return okResult(`cheap:${req.sliceId}`)
    }
    const slices: LoopSlice[] = [
      { id: "design", prompt: "design", sliceType: "design" },
      { id: "propA", prompt: "prop A", deps: ["design"], testStrength: "testable", verifyCommands: [{ kind: "test", command: "t" }] },
      { id: "propB", prompt: "prop B", deps: ["design"], testStrength: "testable", verifyCommands: [{ kind: "test", command: "t" }] },
    ]
    const deps: SliceLoopDeps = { dispatch, runCommand: passRunner, qeGenerate: async () => "cheap:design" }
    const result = await runSliceLoop(slices, deps)

    expect(result.waves).toEqual([["design"], ["propA", "propB"]])
    // design must run before both propagations.
    expect(order.indexOf("design")).toBeLessThan(order.indexOf("propA"))
    expect(order.indexOf("design")).toBeLessThan(order.indexOf("propB"))
    expect(result.outcomes.map((o) => o.id)).toEqual(["design", "propA", "propB"])
  })
})

// ---------------------------------------------------------------------------
// withUpstreamContext — thread dependency outputs into a dependent slice
// ---------------------------------------------------------------------------

describe("withUpstreamContext", () => {
  /** A minimal SliceOutcome fixture — withUpstreamContext only reads id/state/output. */
  const fakeOutcome = (id: string, output: string): SliceOutcome => ({ id, state: "accepted", output }) as unknown as SliceOutcome

  it("appends '## Upstream slice results' + each dep's output when outcomes exist", () => {
    const slice: LoopSlice = { id: "b", prompt: "implement it", deps: ["a"] }
    const outcomes = new Map([["a", fakeOutcome("a", "the concrete patch")]])
    const result = withUpstreamContext(slice, outcomes)
    expect(result.prompt).toContain("implement it")
    expect(result.prompt).toContain("## Upstream slice results")
    expect(result.prompt).toContain("the concrete patch")
  })

  it("returns the same slice unchanged when there are no deps", () => {
    const noDeps: LoopSlice = { id: "b", prompt: "implement it" }
    expect(withUpstreamContext(noDeps, new Map())).toBe(noDeps)
  })

  it("returns the same slice unchanged when the only dep's output is empty", () => {
    const slice: LoopSlice = { id: "b", prompt: "implement it", deps: ["a"] }
    const outcomes = new Map([["a", fakeOutcome("a", "   ")]])
    expect(withUpstreamContext(slice, outcomes)).toBe(slice)
  })

  it("truncates an upstream output longer than 6000 chars", () => {
    const slice: LoopSlice = { id: "b", prompt: "implement it", deps: ["a"] }
    const longOutput = "x".repeat(6100)
    const outcomes = new Map([["a", fakeOutcome("a", longOutput)]])
    const result = withUpstreamContext(slice, outcomes)
    expect(result.prompt).toContain("…[truncated]")
    expect(result.prompt).not.toContain(longOutput)
  })
})

// ---------------------------------------------------------------------------
// runSliceLoop — a dependent slice's dispatched prompt carries its upstream output
// ---------------------------------------------------------------------------

describe("runSliceLoop — dependent slice receives its dependency's output", () => {
  it("threads A's output into B's dispatched prompt", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: (req) => okResult(req.sliceId === "a" ? "A's concrete output" : `cheap:${req.sliceId}`),
    })
    const slices: LoopSlice[] = [
      { id: "a", prompt: "design it", testStrength: "testable", verifyCommands: [{ kind: "test", command: "t" }] },
      { id: "b", prompt: "implement it", deps: ["a"], testStrength: "testable", verifyCommands: [{ kind: "test", command: "t" }] },
    ]
    const result = await runSliceLoop(slices, { dispatch, runCommand: passRunner })

    expect(result.outcomes.every((o) => o.state === "accepted")).toBe(true)
    const bCall = calls.find((c) => c.sliceId === "b")
    expect(bCall?.prompt).toContain("A's concrete output")
  })
})

// ---------------------------------------------------------------------------
// planWaves + escalateTier (pure helpers)
// ---------------------------------------------------------------------------

describe("planWaves", () => {
  it("groups independent slices and serialises dependents", () => {
    const waves = planWaves([
      { id: "a", prompt: "" },
      { id: "b", prompt: "" },
      { id: "c", prompt: "", deps: ["a", "b"] },
    ])
    expect(waves).toEqual([["a", "b"], ["c"]])
  })

  it("throws on an unknown dependency", () => {
    expect(() => planWaves([{ id: "a", prompt: "", deps: ["ghost"] }])).toThrow(/unknown slice/)
  })

  it("throws on a dependency cycle", () => {
    expect(() =>
      planWaves([
        { id: "a", prompt: "", deps: ["b"] },
        { id: "b", prompt: "", deps: ["a"] },
      ]),
    ).toThrow(/cycle/)
  })
})

describe("escalateTier", () => {
  it("climbs one hop up the capability ladder and caps at the oracle", () => {
    expect(escalateTier("executor")).toBe("conductor")
    expect(escalateTier("conductor")).toBe("reasoner")
    expect(escalateTier("reasoner")).toBe("oracle")
    expect(escalateTier("oracle")).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// buildLadderInput — the allocation → ladder rung mapping
// ---------------------------------------------------------------------------

describe("buildLadderInput — allocation→ladder rung mapping", () => {
  const slice: LoopSlice = { id: "s", prompt: "p", verifyCommands: [{ kind: "typecheck", command: "tsc" }] }
  const result = okResult("out")

  it("offers verifyCommands to the sound rung when a runner exists", () => {
    const input = buildLadderInput(slice, { tier: "executor", verification: "sound", reason: "" }, result, { dispatch: async () => result, runCommand: passRunner })
    expect(input.spec.commands.length).toBe(1)
    expect(input.extraRung).toBeUndefined()
  })

  it("omits sound commands when no runner is injected (sound inapplicable)", () => {
    const input = buildLadderInput(slice, { tier: "executor", verification: "sound", reason: "" }, result, { dispatch: async () => result })
    expect(input.spec.commands.length).toBe(0)
  })

  it("attaches the judge extraRung only for the judge cell", () => {
    const j = buildLadderInput(slice, { tier: "oracle", verification: "judge", reason: "" }, result, { dispatch: async () => result, judgeGenerate: async () => "[[ACCEPT]]" })
    expect(j.extraRung).toBeDefined()
    const q = buildLadderInput(slice, { tier: "executor", verification: "qe", reason: "" }, result, { dispatch: async () => result, judgeGenerate: async () => "[[ACCEPT]]" })
    expect(q.extraRung).toBeUndefined()
  })

  it("attaches the QE fallback whenever a QE sampler exists", () => {
    const input = buildLadderInput(slice, { tier: "executor", verification: "qe", reason: "" }, result, { dispatch: async () => result, qeGenerate: async () => "out" })
    expect(input.qe).toBeDefined()
  })

  it("carries slice.probeCommand into spec.probeCommand", () => {
    const probeCommand: VerifyCommand = { kind: "test", command: "bun test path/to/repro.test.ts" }
    const probed: LoopSlice = { ...slice, probeCommand }
    const input = buildLadderInput(probed, { tier: "executor", verification: "sound", reason: "" }, result, { dispatch: async () => result, runCommand: passRunner })
    expect(input.spec.probeCommand).toEqual(probeCommand)
  })

  it("omits spec.probeCommand when the slice has none", () => {
    const input = buildLadderInput(slice, { tier: "executor", verification: "sound", reason: "" }, result, { dispatch: async () => result, runCommand: passRunner })
    expect(input.spec.probeCommand).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// OL-9.3b — read-only-lane bash-write guard reaches the verifier verdict
// ---------------------------------------------------------------------------

describe("runSliceLoop — OL-9.3b bash-write guard reaches the verifier verdict", () => {
  it("rejects a recon slice's cheap attempt on a write-shaped bash command; read-only slices cap at 1 dispatch, no escalation brief (OL-9.5d)", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({
        text: "found the callers",
        trajectory: { events: [{ kind: "command", command: "cat > src/x.js" }] },
      }),
    })
    const slice: LoopSlice = { id: "explore", prompt: "map callers", sliceType: "recon" }
    const result = await runSliceLoop([slice], { dispatch })

    expect(result.outcomes[0].state).toBe("unverified")
    expect(calls.length).toBe(1) // read-only slices never climb the ladder — no brief is even compiled
    const flags = result.outcomes[0].verdict.behavior.flags
    expect(flags.map((f) => f.kind)).toContain("write-shaped-command-in-read-only-slice")
    expect(flags.find((f) => f.kind === "write-shaped-command-in-read-only-slice")?.detail).toContain("cat > src/x.js")
  })

  it("does not reject the same write-shaped bash command in a mechanical slice", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({
        text: "done",
        trajectory: { events: [{ kind: "command", command: "cat > src/x.js" }] },
      }),
    })
    const slice: LoopSlice = {
      id: "edit",
      prompt: "do it",
      sliceType: "mechanical",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const result = await runSliceLoop([slice], { dispatch, runCommand: passRunner })

    expect(result.outcomes[0].state).toBe("accepted")
    expect(result.outcomes[0].verdict.behavior.suspicious).toBe(false)
    expect(calls.length).toBe(1) // never escalated
  })
})

// ---------------------------------------------------------------------------
// OL-9.3e — per-slice wall-clock budget
// ---------------------------------------------------------------------------

describe("runSlice — OL-9.3e per-slice wall-clock budget", () => {
  it("sliceTimeoutMs uses the recon/verify cap for read-only slices and the mechanical/design cap otherwise", () => {
    expect(sliceTimeoutMs("recon")).toBe(RECON_VERIFY_TIMEOUT_MS)
    expect(sliceTimeoutMs("verify")).toBe(RECON_VERIFY_TIMEOUT_MS)
    expect(sliceTimeoutMs("mechanical")).toBe(MECHANICAL_DESIGN_TIMEOUT_MS)
    expect(sliceTimeoutMs("design")).toBe(MECHANICAL_DESIGN_TIMEOUT_MS)
    expect(sliceTimeoutMs(undefined)).toBe(MECHANICAL_DESIGN_TIMEOUT_MS)
  })

  it("caps a recon slice's cheap dispatch at RECON_VERIFY_TIMEOUT_MS", async () => {
    const seen: number[] = []
    const dispatchTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      seen.push(ms)
      return p
    }
    const slice: LoopSlice = {
      id: "s",
      prompt: "p",
      sliceType: "recon",
      testStrength: "testable",
      verifyCommands: [{ kind: "test", command: "t" }],
    }
    await runSliceLoop([slice], { dispatch: async () => okResult("out"), runCommand: passRunner, dispatchTimeout })
    expect(seen).toEqual([RECON_VERIFY_TIMEOUT_MS])
  })

  it("caps an untyped slice's cheap dispatch at MECHANICAL_DESIGN_TIMEOUT_MS (the default)", async () => {
    const seen: number[] = []
    const dispatchTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      seen.push(ms)
      return p
    }
    const slice: LoopSlice = { id: "s", prompt: "p", testStrength: "testable", verifyCommands: [{ kind: "test", command: "t" }] }
    await runSliceLoop([slice], { dispatch: async () => okResult("out"), runCommand: passRunner, dispatchTimeout })
    expect(seen).toEqual([MECHANICAL_DESIGN_TIMEOUT_MS])
  })

  it("scales an escalation hop's cap by ESCALATION_TIMEOUT_FACTOR", async () => {
    const seen: number[] = []
    const dispatchTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      seen.push(ms)
      return p
    }
    let runs = 0
    const flakyRunner = async (c: VerifyCommand): Promise<CommandResult> =>
      runs++ === 0 ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "ok", stderr: "" }
    const slice: LoopSlice = {
      id: "s",
      prompt: "p",
      sliceType: "mechanical",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    await runSliceLoop([slice], { dispatch: async () => okResult("out"), runCommand: flakyRunner, dispatchTimeout })
    expect(seen[0]).toBe(MECHANICAL_DESIGN_TIMEOUT_MS)
    expect(seen[1]).toBe(Math.ceil(MECHANICAL_DESIGN_TIMEOUT_MS * ESCALATION_TIMEOUT_FACTOR))
  })

  it("fails loud with timeout evidence when the cheap attempt exceeds its budget, then climbs the ladder like any other reject", async () => {
    let call = 0
    const dispatchTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      call += 1
      if (call === 1) throw new SliceTimeoutError(ms)
      return p
    }
    const { dispatch, calls } = recordingDispatch()
    const slice: LoopSlice = {
      id: "s",
      prompt: "p",
      sliceType: "mechanical",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const result = await runSliceLoop([slice], { dispatch, runCommand: passRunner, dispatchTimeout })

    expect(calls.length).toBe(2)
    expect(calls[0].escalated).toBe(false)
    expect(calls[1].escalated).toBe(true)
    expect(calls[1].prompt).toContain("wall-clock budget")

    const outcome = result.outcomes[0]
    expect(outcome.state).toBe("escalated") // the rescue's real dispatch succeeded and passed sound
    expect(outcome.verdict.accepted).toBe(true)
  })

  it("ends unverified with a timeout verdict on the cheap hop, never hanging — read-only slices cap at 1, no rescue hop (OL-9.5d)", async () => {
    const dispatchTimeout = async <T,>(_p: Promise<T>, ms: number): Promise<T> => {
      throw new SliceTimeoutError(ms)
    }
    const { dispatch, calls } = recordingDispatch()
    const slice: LoopSlice = { id: "s", prompt: "p", sliceType: "recon" }
    const result = await runSliceLoop([slice], { dispatch, dispatchTimeout })

    const outcome = result.outcomes[0]
    expect(outcome.state).toBe("unverified")
    expect(outcome.verdict.rung).toBe("timeout")
    expect(outcome.verdict.reason).toContain("wall-clock budget")
    // Recon is read-only — its attempt cap is 1: no rescue hop is ever dispatched.
    expect(calls.map((c) => c.tier)).toEqual(["executor"])
  })
})

// ---------------------------------------------------------------------------
// OL-9.3e — overall loop budget (derived from the plan; exhaustion fails loud)
// ---------------------------------------------------------------------------

describe("overallLoopBudgetMs — OL-9.3e overall loop budget", () => {
  it("sums each slice's own base cap times LOOP_BUDGET_FACTOR", () => {
    const slices: LoopSlice[] = [
      { id: "a", prompt: "", sliceType: "recon" },
      { id: "b", prompt: "", sliceType: "mechanical" },
    ]
    const expected = Math.ceil((RECON_VERIFY_TIMEOUT_MS + MECHANICAL_DESIGN_TIMEOUT_MS) * LOOP_BUDGET_FACTOR)
    expect(overallLoopBudgetMs(slices)).toBe(expected)
  })
})

describe("runSliceLoop — OL-9.3e overall loop budget fails loud", () => {
  it("passes the plan-derived budget to loopTimeout", async () => {
    const seen: number[] = []
    const loopTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      seen.push(ms)
      return p
    }
    const slices: LoopSlice[] = [{ id: "a", prompt: "", sliceType: "recon" }]
    await runSliceLoop(slices, { dispatch: async () => okResult("x"), loopTimeout })
    expect(seen).toEqual([overallLoopBudgetMs(slices)])
  })

  it("throws a descriptive error when the overall budget is exhausted, never hanging the wave loop", async () => {
    const loopTimeout = async <T,>(_p: Promise<T>, ms: number): Promise<T> => {
      throw new SliceTimeoutError(ms)
    }
    const { dispatch } = recordingDispatch()
    const slice: LoopSlice = { id: "s", prompt: "p" }
    await expect(runSliceLoop([slice], { dispatch, loopTimeout })).rejects.toThrow(/overall budget/)
  })
})

// ---------------------------------------------------------------------------
// OL-9.4c — escalation brief states the MISSING objective + already-read files
// ---------------------------------------------------------------------------

describe("runSliceLoop — OL-9.4c missing-evidence objective + already-read files", () => {
  const slice: LoopSlice = {
    id: "prop",
    prompt: "propagate the refresh signature to all callers",
    sliceType: "mechanical",
    coupling: "high",
    testStrength: "testable",
    verifyCommands: [{ kind: "typecheck", command: "tsc --noEmit" }],
  }

  it("states the rejecting rung's MISSING line as the rescue's objective and lists files the prior attempt already read", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({
        text: "bad patch",
        trajectory: {
          events: [
            { kind: "file-read", filePath: "src/auth/refresh.ts" },
            { kind: "file-read", filePath: "src/auth/token.ts" },
          ],
        },
      }),
    })
    await runSliceLoop([slice], { dispatch, runCommand: failRunner })

    const escalatedPrompt = calls[1].prompt
    expect(escalatedPrompt).toContain("Your objective: MISSING:")
    expect(escalatedPrompt).toContain(
      "## Already read by the prior attempt — trust the digest above; re-read a file ONLY if the missing evidence requires quoting it",
    )
    expect(escalatedPrompt).toContain("src/auth/refresh.ts, src/auth/token.ts")
  })

  it("omits the already-read section when the prior attempt read nothing", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] } }),
    })
    await runSliceLoop([slice], { dispatch, runCommand: failRunner })

    expect(calls[1].prompt).not.toContain("Already read by the prior attempt")
  })
})

// ---------------------------------------------------------------------------
// OL-9.4c — first-pass/attempts telemetry
// ---------------------------------------------------------------------------

describe("runSliceLoop — OL-9.4c first-pass/attempts telemetry", () => {
  it("counts a single first-time pass as 1 slice / 1 first-attempt pass / 1 total attempt", async () => {
    const { dispatch } = recordingDispatch()
    const slice: LoopSlice = {
      id: "edit",
      prompt: "do it",
      sliceType: "mechanical",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const result = await runSliceLoop([slice], { dispatch, runCommand: passRunner })

    expect(result.outcomes[0].attempts).toBe(1)
    expect(result.telemetry).toEqual({
      slicesDispatched: 1,
      firstAttemptPasses: 1,
      totalAttempts: 1,
      attemptsPerSlice: 1,
      firstPassRate: 1,
    })
  })

  it("counts a rescued slice's escalation hop as a second attempt, dragging firstPassRate down", async () => {
    const { dispatch } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] } }),
      onEscalated: () => ({ text: "fixed patch", trajectory: { events: [] } }),
    })
    let runs = 0
    const flakyRunner = async (): Promise<CommandResult> =>
      runs++ === 0 ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "ok", stderr: "" }
    const slice: LoopSlice = {
      id: "prop",
      prompt: "propagate the refresh signature",
      sliceType: "mechanical",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const result = await runSliceLoop([slice], { dispatch, runCommand: flakyRunner })

    expect(result.outcomes[0].state).toBe("escalated")
    expect(result.outcomes[0].attempts).toBe(2)
    expect(result.telemetry).toEqual({
      slicesDispatched: 1,
      firstAttemptPasses: 0,
      totalAttempts: 2,
      attemptsPerSlice: 2,
      firstPassRate: 0,
    })
  })

  it("counts a timed-out cheap attempt's rescue hop as a second attempt too", async () => {
    let call = 0
    const dispatchTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      call += 1
      if (call === 1) throw new SliceTimeoutError(ms)
      return p
    }
    const { dispatch } = recordingDispatch()
    const slice: LoopSlice = {
      id: "s",
      prompt: "p",
      sliceType: "mechanical",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const result = await runSliceLoop([slice], { dispatch, runCommand: passRunner, dispatchTimeout })

    expect(result.outcomes[0].state).toBe("escalated")
    expect(result.outcomes[0].attempts).toBe(2)
    expect(result.telemetry.totalAttempts).toBe(2)
    expect(result.telemetry.firstPassRate).toBe(0)
  })

  it("aggregates across mixed slices: one first-time pass, one rescued", async () => {
    const { dispatch } = recordingDispatch({
      onCheap: (req) =>
        req.sliceId === "b" ? { text: "bad patch", trajectory: { events: [] } } : okResult(`cheap:${req.sliceId}`),
      onEscalated: () => ({ text: "fixed patch", trajectory: { events: [] } }),
    })
    let runs = 0
    const flakyRunner = async (c: VerifyCommand): Promise<CommandResult> => {
      if (c.command !== "b-check") return { exitCode: 0, stdout: "ok", stderr: "" }
      return runs++ === 0 ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "ok", stderr: "" }
    }
    const slices: LoopSlice[] = [
      { id: "a", prompt: "a", testStrength: "testable", verifyCommands: [{ kind: "test", command: "a-check" }] },
      { id: "b", prompt: "b", testStrength: "testable", verifyCommands: [{ kind: "test", command: "b-check" }] },
    ]
    const result = await runSliceLoop(slices, { dispatch, runCommand: flakyRunner })

    expect(result.telemetry).toEqual({
      slicesDispatched: 2,
      firstAttemptPasses: 1,
      totalAttempts: 3,
      attemptsPerSlice: 1.5,
      firstPassRate: 0.5,
    })
  })
})

// ---------------------------------------------------------------------------
// U3 — failure-containment bracket (OL-ORCH-4.3): track()/restore() around
// every editable attempt, read-only slices never bracketed, the REVERTED
// diff riding the escalation brief (and the failure result on exhaustion),
// escalation provenance, and zero behavior change with the dep absent.
// ---------------------------------------------------------------------------

describe("runSliceLoop — failure-containment bracket (U3, OL-ORCH-4.3)", () => {
  const editableSlice: LoopSlice = {
    id: "prop",
    prompt: "propagate the refresh signature to all callers",
    sliceType: "mechanical",
    coupling: "low",
    testStrength: "testable",
    verifyCommands: [{ kind: "typecheck", command: "tsc --noEmit" }],
  }

  it("tracks before the cheap attempt and never restores when it is accepted", async () => {
    const { dispatch } = recordingDispatch()
    const { snapshot, calls } = fakeSnapshot()
    const result = await runSliceLoop([editableSlice], { dispatch, runCommand: passRunner, snapshot })

    expect(result.outcomes[0].state).toBe("accepted")
    expect(calls.map((c) => c.fn)).toEqual(["track"])
  })

  it("never calls the snapshot dep for a read-only (recon) slice", async () => {
    const slice: LoopSlice = {
      id: "explore",
      prompt: "map every caller of refreshToken",
      sliceType: "recon",
      testStrength: "testable",
      verifyCommands: [{ kind: "test", command: "bun test" }],
    }
    const { dispatch } = recordingDispatch()
    const { snapshot, calls } = fakeSnapshot()
    const result = await runSliceLoop([slice], { dispatch, runCommand: failRunner, snapshot })

    expect(result.outcomes[0].state).toBe("unverified")
    expect(calls.length).toBe(0)
  })

  it("on a reject that escalates: diffs BEFORE restoring, restores, tracks a fresh hash for the rescue, and the brief carries the REVERTED diff", async () => {
    const { dispatch, calls: dispatchCalls } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] } }),
      onEscalated: () => ({ text: "fixed patch", trajectory: { events: [] } }),
    })
    const { snapshot, calls } = fakeSnapshot({ diffText: "diff --git a/x.ts b/x.ts\n+broken" })
    let runs = 0
    const flakyRunner = async (): Promise<CommandResult> =>
      runs++ === 0 ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "ok", stderr: "" }
    const result = await runSliceLoop([editableSlice], { dispatch, runCommand: flakyRunner, snapshot })

    expect(result.outcomes[0].state).toBe("escalated")
    expect(calls.map((c) => c.fn)).toEqual(["track", "diff", "restore", "track"])
    expect(calls[1]).toEqual({ fn: "diff", hash: "hash-1" }) // diff captured BEFORE restore
    expect(calls[2]).toEqual({ fn: "restore", hash: "hash-1" })

    const briefText = dispatchCalls[1].prompt
    expect(briefText).toContain("## Prior attempt's diff — REVERTED")
    expect(briefText).toContain(
      "These edits have been REVERTED — the tree is clean; treat this as context about a failed approach, do not assume the edits exist.",
    )
    expect(briefText).toContain("diff --git a/x.ts b/x.ts\n+broken")
  })

  it("on ladder exhaustion: restores the last hop too and returns its diff on the outcome for the turn owner", async () => {
    const { dispatch } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] } }),
      onEscalated: () => ({ text: "still bad", trajectory: { events: [] } }),
    })
    const { snapshot, calls } = fakeSnapshot({ diffText: "diff --git a/y.ts b/y.ts\n+still-broken" })
    const result = await runSliceLoop([editableSlice], { dispatch, runCommand: failRunner, snapshot })

    const outcome = result.outcomes[0]
    expect(outcome.state).toBe("unverified") // non-critical climb depth (1) exhausted at the conductor
    expect(outcome.revertedDiff).toBe("diff --git a/y.ts b/y.ts\n+still-broken")
    // 3 rescue hops (squeeze executor, climb conductor, squeeze conductor) —
    // each restores — plus the final settle-unverified restore = 4.
    expect(calls.filter((c) => c.fn === "restore").length).toBe(4)
  })

  it("caps the reverted diff at ~4000 chars with a truncation marker before it reaches the brief", async () => {
    const longDiff = "x".repeat(5000)
    const { dispatch, calls: dispatchCalls } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] } }),
    })
    const { snapshot } = fakeSnapshot({ diffText: longDiff })
    await runSliceLoop([editableSlice], { dispatch, runCommand: failRunner, snapshot })

    const briefText = dispatchCalls[1].prompt
    expect(briefText).toContain("…[truncated]")
    expect(briefText).not.toContain(longDiff)
  })

  it("emits onProvenance once per rescue hop naming fromTier/toTier/rungReason — a squeeze retry reports fromTier===toTier", async () => {
    const { dispatch } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] } }),
      onEscalated: (req) => ({ text: `rescue:${req.tier}`, trajectory: { events: [] } }),
    })
    const provenance: Array<{ sliceId: string; fromTier: string; toTier: string; rungReason: string }> = []
    await runSliceLoop([editableSlice], { dispatch, runCommand: failRunner, onProvenance: (e) => provenance.push(e) })

    // failRunner repeats the same signature: squeeze executor (stalls on
    // repeat), climb to conductor, squeeze conductor (stalls again) — 3
    // rescue hops, one onProvenance emission each. Non-critical climb depth
    // (1) then settles it unverified at the conductor.
    expect(provenance.length).toBe(3)
    expect(provenance[0]).toMatchObject({ sliceId: "prop", fromTier: "executor", toTier: "executor" })
    expect(provenance[0].rungReason).toContain("squeeze-retry")
    expect(provenance[1]).toMatchObject({ sliceId: "prop", fromTier: "executor", toTier: "conductor" })
    expect(provenance[1].rungReason).not.toContain("squeeze-retry")
    expect(provenance[2]).toMatchObject({ sliceId: "prop", fromTier: "conductor", toTier: "conductor" })
    expect(provenance[2].rungReason).toContain("squeeze-retry")
  })

  it("makes zero snapshot/provenance calls and leaves the ladder byte-identical when both deps are absent", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: "bad patch", trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING.executor, cost: 0.001, tokens: { input: 100, output: 200 } } }),
      onEscalated: () => ({ text: "fixed patch", trajectory: { events: [] }, usage: { model: ECON_TIER_BINDING.conductor, cost: 0.02, tokens: { input: 300, output: 400 } } }),
    })
    let runs = 0
    const flakyRunner = async (): Promise<CommandResult> =>
      runs++ === 0 ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "ok", stderr: "" }
    const result = await runSliceLoop([editableSlice], { dispatch, runCommand: flakyRunner })

    const outcome = result.outcomes[0]
    expect(outcome.state).toBe("escalated")
    expect(outcome.output).toBe("fixed patch")
    expect(outcome.revertedDiff).toBeUndefined()
    expect(calls.length).toBe(2)
    // Double-pay booking is unaffected by the (absent) bracket — same amounts as the non-U3 escalation test.
    expect(result.ledger.escalations).toBe(1)
    expect(result.ledger.totalWastedCost).toBeCloseTo(0.001, 6)
    expect(outcome.escalation?.record.totalCost).toBeCloseTo(0.021, 6)
  })
})

// ---------------------------------------------------------------------------
// FSM table — orchestration-fsm.ts's `sliceTransition` reducer now owns the
// squeeze-vs-climb-vs-settle decision (replacing the old implicit local
// tuple: attempts/sameTierRetries/climbs/atTier/lastSignatureAtTier). This
// table proves the swap kept every dispatch sequence above byte-identical,
// plus the run-8 fix: `isSliceTerminal` is the only thing that stops
// dispatching, so a settled slice's dispatch count always equals its
// `attempts` — never re-dispatched once terminal.
// ---------------------------------------------------------------------------

describe("runSliceLoop — FSM table (sliceTransition drives squeeze/climb/settle, behavior preserved)", () => {
  const fsmSlice = (coupling: "low" | "high"): LoopSlice => ({
    id: "s",
    prompt: "p",
    sliceType: "mechanical",
    coupling,
    testStrength: "testable",
    verifyCommands: [{ kind: "typecheck", command: "tsc" }],
  })

  type FsmCase = {
    name: string
    slice: LoopSlice
    runCommand: (c: VerifyCommand) => Promise<CommandResult>
    expectTiers: EconTier[]
    expectState: "accepted" | "escalated" | "unverified"
    expectAttempts: number
  }

  const cases: FsmCase[] = [
    {
      name: "accept-first — the cheap attempt passes, no rescue hop",
      slice: fsmSlice("low"),
      runCommand: passRunner,
      expectTiers: ["executor"],
      expectState: "accepted",
      expectAttempts: 1,
    },
    {
      name: "squeeze→accept — a same-tier retry converges and passes",
      slice: fsmSlice("low"),
      runCommand: (() => {
        let call = 0
        return async (): Promise<CommandResult> =>
          call++ === 0 ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "ok", stderr: "" }
      })(),
      expectTiers: ["executor", "executor"],
      expectState: "escalated",
      expectAttempts: 2,
    },
    {
      name: "squeeze-stall→climb — a repeated signature stops the squeeze after one retry, then the climb passes",
      slice: fsmSlice("low"),
      runCommand: (() => {
        let call = 0
        return async (c: VerifyCommand): Promise<CommandResult> => {
          call += 1
          return call <= 2
            ? { exitCode: 1, stdout: "", stderr: `${c.kind} failed: TS2322 type mismatch` }
            : { exitCode: 0, stdout: "ok", stderr: "" }
        }
      })(),
      expectTiers: ["executor", "executor", "conductor"],
      expectState: "escalated",
      expectAttempts: 3,
    },
    {
      name: "critical exhaustion→unverified — bounded by the same maxClimbs as non-critical, settles loud not deep",
      slice: fsmSlice("high"),
      runCommand: failRunner,
      expectTiers: ["executor", "executor", "conductor", "conductor"],
      expectState: "unverified",
      expectAttempts: 4,
    },
    {
      name: "exhaustion→unverified — a non-critical slice settles at its one-climb budget",
      slice: fsmSlice("low"),
      runCommand: failRunner,
      expectTiers: ["executor", "executor", "conductor", "conductor"],
      expectState: "unverified",
      expectAttempts: 4,
    },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      const { dispatch, calls } = recordingDispatch({
        onEscalated: (req) => ({ text: `rescue:${req.tier}`, trajectory: { events: [] } }),
      })
      const result = await runSliceLoop([c.slice], { dispatch, runCommand: c.runCommand })
      const outcome = result.outcomes[0]

      expect(calls.map((call) => call.tier)).toEqual(c.expectTiers)
      expect(outcome.state).toBe(c.expectState)
      expect(outcome.attempts).toBe(c.expectAttempts)
      // The run-8 invariant: dispatch count must exactly equal attempts —
      // no extra hop after the reducer's terminal state settles the slice.
      expect(calls.length).toBe(c.expectAttempts)
    })
  }

  it("dispatches each slice in a dependency chain exactly once — a settled slice is never re-dispatched by a later wave", async () => {
    const { dispatch, calls } = recordingDispatch()
    const verifyCommands = [{ kind: "typecheck" as const, command: "tsc" }]
    const chain: LoopSlice[] = [
      { id: "a", prompt: "a", sliceType: "mechanical", coupling: "low", testStrength: "testable", verifyCommands },
      { id: "b", prompt: "b", sliceType: "mechanical", coupling: "low", testStrength: "testable", verifyCommands, deps: ["a"] },
      { id: "c", prompt: "c", sliceType: "mechanical", coupling: "low", testStrength: "testable", verifyCommands, deps: ["b"] },
    ]
    const result = await runSliceLoop(chain, { dispatch, runCommand: passRunner })

    expect(result.waves).toEqual([["a"], ["b"], ["c"]])
    expect(calls.filter((call) => call.sliceId === "a").length).toBe(1)
    expect(calls.filter((call) => call.sliceId === "b").length).toBe(1)
    expect(calls.filter((call) => call.sliceId === "c").length).toBe(1)
    expect(result.outcomes.every((o) => o.state === "accepted")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task #48 — posterior-uncertainty gate: a green sound-rung verdict on a
// prior-flagged (ambiguous/hard) slice still earns ONE generator escalation
// when the posterior signal reads high. Unflagged or confident slices accept
// on green unchanged — the cost thesis never inverts.
// ---------------------------------------------------------------------------

describe("runSliceLoop — posterior-uncertainty gate (task #48)", () => {
  // hardness:"hard" floors allocateSlice's generator tier at "reasoner"
  // (allocation.ts's difficulty floor); no `snapshot` dep is injected so the
  // mechanical round-down (evaluator.ts step 3) stays blocked (containment
  // unavailable) and the tier holds at "reasoner" — escalateTier("reasoner")
  // is "oracle", giving a clean, deterministic one-hop climb to assert on.
  const flaggedSlice: LoopSlice = {
    id: "flagged",
    prompt: "p",
    sliceType: "mechanical",
    coupling: "low",
    testStrength: "testable",
    verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    hardness: "hard",
  }

  it("green + prior-flagged + high uncertainty (confidenceGenerate fallback) ⇒ exactly one extra generator escalation", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: "cheap patch", trajectory: { events: [] } }),
      onEscalated: (req) => ({ text: `reviewed:${req.tier}`, trajectory: { events: [] } }),
    })
    const provenance: Array<{ fromTier: string; toTier: string; rungReason: string }> = []
    const result = await runSliceLoop([flaggedSlice], {
      dispatch,
      runCommand: passRunner, // both the cheap attempt and the review re-verify green
      confidenceGenerate: async () => 0.1, // low self-confidence → high uncertainty
      onProvenance: (e) => provenance.push(e),
    })

    const outcome = result.outcomes[0]
    expect(calls.map((c) => c.tier)).toEqual(["reasoner", "oracle"])
    expect(calls.map((c) => c.escalated)).toEqual([false, true])
    expect(outcome.attempts).toBe(2)
    expect(outcome.state).toBe("escalated")
    expect(outcome.output).toBe("reviewed:oracle")
    const loud = provenance.find((p) => p.rungReason === "posterior-uncertain-review")
    expect(loud).toBeDefined()
    expect(loud).toMatchObject({ fromTier: "reasoner", toTier: "oracle" })
  })

  it("prefers a dispatch-supplied result.uncertainty over the confidenceGenerate fallback", async () => {
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({
        text: "cheap patch",
        trajectory: { events: [] },
        uncertainty: { kind: "perplexity", value: 10, high: true },
      }),
      onEscalated: (req) => ({ text: `reviewed:${req.tier}`, trajectory: { events: [] } }),
    })
    let confidenceGenerateCalls = 0
    const result = await runSliceLoop([flaggedSlice], {
      dispatch,
      runCommand: passRunner,
      confidenceGenerate: async () => {
        confidenceGenerateCalls += 1
        return 0.99 // would NOT escalate if consulted — proves the fallback never ran
      },
    })

    expect(confidenceGenerateCalls).toBe(0)
    expect(calls.length).toBe(2)
    expect(result.outcomes[0].attempts).toBe(2)
    expect(result.outcomes[0].state).toBe("escalated")
  })

  it("green + unflagged ⇒ accepts unchanged, even with a high-uncertainty confidenceGenerate", async () => {
    const unflaggedSlice: LoopSlice = {
      id: "plain",
      prompt: "p",
      sliceType: "mechanical",
      coupling: "low",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
    }
    const { dispatch, calls } = recordingDispatch()
    const result = await runSliceLoop([unflaggedSlice], {
      dispatch,
      runCommand: passRunner,
      confidenceGenerate: async () => 0.05, // very low confidence — would trigger if flagged
    })

    const outcome = result.outcomes[0]
    expect(calls.length).toBe(1)
    expect(outcome.attempts).toBe(1)
    expect(outcome.state).toBe("accepted")
  })

  it("green + prior-flagged (ambiguous) + confident ⇒ accepts unchanged, no escalation", async () => {
    const ambiguousSlice: LoopSlice = {
      id: "amb",
      prompt: "p",
      sliceType: "mechanical",
      coupling: "low",
      testStrength: "testable",
      verifyCommands: [{ kind: "typecheck", command: "tsc" }],
      ambiguity: "ambiguous",
    }
    const { dispatch, calls } = recordingDispatch()
    const result = await runSliceLoop([ambiguousSlice], {
      dispatch,
      runCommand: passRunner,
      confidenceGenerate: async () => 0.95, // high confidence → uncertainty below the threshold
    })

    const outcome = result.outcomes[0]
    expect(calls.length).toBe(1)
    expect(outcome.attempts).toBe(1)
    expect(outcome.state).toBe("accepted")
  })

  it("falls back to the cheap accepted output when the escalation review itself fails re-verification", async () => {
    let runs = 0
    const cheapPassesReviewFails = async (): Promise<CommandResult> => {
      runs += 1
      return runs === 1 ? { exitCode: 0, stdout: "ok", stderr: "" } : { exitCode: 1, stdout: "", stderr: "typecheck failed: TS2322" }
    }
    const { dispatch, calls } = recordingDispatch({
      onCheap: () => ({ text: "cheap patch", trajectory: { events: [] } }),
      onEscalated: (req) => ({ text: `reviewed:${req.tier}`, trajectory: { events: [] } }),
    })
    const result = await runSliceLoop([flaggedSlice], {
      dispatch,
      runCommand: cheapPassesReviewFails,
      confidenceGenerate: async () => 0.1,
    })

    const outcome = result.outcomes[0]
    // Second dispatch DID happen (the one-shot review), but its re-verification
    // rejected — never force-replace a proven-green result with one that failed.
    expect(calls.length).toBe(2)
    expect(outcome.attempts).toBe(2)
    expect(outcome.state).toBe("accepted")
    expect(outcome.output).toBe("cheap patch")
  })

  it("never fires on a read-only (recon/verify) slice even when flagged + confidenceGenerate reads high", async () => {
    const reconSlice: LoopSlice = {
      id: "recon-flagged",
      prompt: "p",
      sliceType: "recon",
      testStrength: "testable",
      verifyCommands: [{ kind: "test", command: "bun test" }],
      hardness: "hard",
    }
    const { dispatch, calls } = recordingDispatch()
    const result = await runSliceLoop([reconSlice], {
      dispatch,
      runCommand: passRunner,
      confidenceGenerate: async () => 0.05,
    })

    expect(calls.length).toBe(1)
    expect(result.outcomes[0].attempts).toBe(1)
    expect(result.outcomes[0].state).toBe("accepted")
  })
})
