/**
 * Unit tests for qe.ts: qeVerdict (pure self-consistency check), runQeVeto
 * (sampler-driven orchestration wrapper), and shouldVetoCheapOutput (the
 * combined abstention + QE entry point).
 */

import { describe, it, expect } from "bun:test"
import {
  qeVerdict,
  runQeVeto,
  shouldVetoCheapOutput,
  DEFAULT_AGREEMENT_THRESHOLD,
} from "../src/qe.js"

// ---------------------------------------------------------------------------
// qeVerdict — pure decision core
// ---------------------------------------------------------------------------

describe("qeVerdict", () => {
  it("passes on fewer than 2 samples (nothing to compare)", () => {
    const result = qeVerdict(["only one sample here"])
    expect(result.verdict).toBe("pass")
    expect(result.agreement).toBe(1)
  })

  it("passes on identical samples (perfect agreement)", () => {
    const sample = "function add(a, b) { return a + b }"
    const result = qeVerdict([sample, sample])
    expect(result.verdict).toBe("pass")
    expect(result.agreement).toBe(1)
  })

  it("passes on samples with high token overlap", () => {
    const a = "function add(a, b) { return a + b } // sums two numbers"
    const b = "function add(a, b) { return a + b } // sum two numbers"
    const result = qeVerdict([a, b])
    expect(result.verdict).toBe("pass")
    expect(result.agreement).toBeGreaterThanOrEqual(DEFAULT_AGREEMENT_THRESHOLD)
  })

  it("vetoes on divergent samples — seeded silent-wrong fixture", () => {
    // Two samples that answer the same prompt completely differently: one
    // confidently returns a hardcoded wrong value, the other a real
    // implementation — the classic silent-wrong cheap-tier cliff.
    const confidentlyWrong = "function isPrime(n) { return true }"
    const actualImplementation =
      "function isPrime(n) { if (n < 2) return false; for (let i = 2; i * i <= n; i++) { if (n % i === 0) return false } return true }"
    const result = qeVerdict([confidentlyWrong, actualImplementation])
    expect(result.verdict).toBe("veto")
    expect(result.agreement).toBeLessThan(DEFAULT_AGREEMENT_THRESHOLD)
  })

  it("respects a custom agreementThreshold", () => {
    const a = "alpha beta gamma"
    const b = "alpha beta delta"
    // Jaccard here: intersection {alpha,beta}=2, union {alpha,beta,gamma,delta}=4 -> 0.5
    const lenient = qeVerdict([a, b], { agreementThreshold: 0.3 })
    expect(lenient.verdict).toBe("pass")

    const strict = qeVerdict([a, b], { agreementThreshold: 0.9 })
    expect(strict.verdict).toBe("veto")
  })
})

// ---------------------------------------------------------------------------
// runQeVeto — orchestration wrapper
// ---------------------------------------------------------------------------

describe("runQeVeto", () => {
  it("passes when the drawn sample agrees with the first", async () => {
    const first = "export function sum(a, b) { return a + b }"
    const result = await runQeVeto(first, async () => first)
    expect(result.verdict).toBe("pass")
    expect(result.samples.length).toBe(2)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("vetoes when the drawn sample diverges from the first", async () => {
    const first = "function isPrime(n) { return true }"
    const divergent =
      "function isPrime(n) { if (n < 2) return false; for (let i = 2; i * i <= n; i++) { if (n % i === 0) return false } return true }"
    const result = await runQeVeto(first, async () => divergent)
    expect(result.verdict).toBe("veto")
  })

  it("returns verdict=skipped when the budget is exceeded", async () => {
    const first = "some cheap-tier output"
    const slowGenerate = () => new Promise<string>((resolve) => setTimeout(() => resolve(first), 200))
    const result = await runQeVeto(first, slowGenerate, { budgetMs: 5 })
    expect(result.verdict).toBe("skipped")
    expect(result.reason).toContain("budget")
  })

  it("returns verdict=skipped immediately when budgetMs is 0", async () => {
    const first = "some cheap-tier output"
    let called = false
    const result = await runQeVeto(
      first,
      async () => {
        called = true
        return first
      },
      { budgetMs: 0 },
    )
    expect(result.verdict).toBe("skipped")
    expect(called).toBe(false)
  })

  it("degrades to skipped when the sampler throws", async () => {
    const first = "some cheap-tier output"
    const result = await runQeVeto(first, async () => {
      throw new Error("sampler unavailable")
    })
    expect(result.verdict).toBe("skipped")
  })

  it("sums estimateTokenCost over only the drawn extra samples", async () => {
    const first = "alpha beta gamma"
    const result = await runQeVeto(first, async () => "alpha beta gamma", {
      estimateTokenCost: (sample) => sample.split(" ").length,
    })
    expect(result.estimatedTokenCost).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// shouldVetoCheapOutput — combined entry point
// ---------------------------------------------------------------------------

describe("shouldVetoCheapOutput", () => {
  it("short-circuits on abstention — never calls the sampler", async () => {
    let called = false
    const result = await shouldVetoCheapOutput({ abstain: true, text: "[[ABSTAIN]]" }, async () => {
      called = true
      return "should never be drawn"
    })
    expect(result.veto).toBe(true)
    expect(result.reason).toContain("abstained")
    expect(result.qe).toBeUndefined()
    expect(called).toBe(false)
  })

  it("runs QE and passes when not abstained and samples agree", async () => {
    const text = "function add(a, b) { return a + b }"
    const result = await shouldVetoCheapOutput({ text }, async () => text)
    expect(result.veto).toBe(false)
    expect(result.qe).toBeDefined()
    expect(result.qe?.verdict).toBe("pass")
  })

  it("vetoes on qe_low when not abstained but samples diverge", async () => {
    const text = "function isPrime(n) { return true }"
    const divergent =
      "function isPrime(n) { if (n < 2) return false; for (let i = 2; i * i <= n; i++) { if (n % i === 0) return false } return true }"
    const result = await shouldVetoCheapOutput({ text }, async () => divergent)
    expect(result.veto).toBe(true)
    expect(result.reason).toContain("qe veto")
  })
})
