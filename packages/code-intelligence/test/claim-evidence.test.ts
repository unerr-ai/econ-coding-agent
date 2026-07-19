import { describe, it, expect } from "bun:test"
import { checkClaimCoverage } from "../src/claim-evidence.ts"
import type { Claim, Evidence } from "../src/claim-evidence.ts"

const fixedClaim = (items: string[]): Claim => ({ kind: "fixed", scope: { kind: "witnesses", items } })

describe("checkClaimCoverage", () => {
  it("covers when every claimed item passes", () => {
    const claim = fixedClaim(["w1", "w2"])
    const evidence: Evidence = {
      scope: { kind: "witnesses", items: ["w1", "w2"] },
      items: [
        { id: "w1", verdict: "pass" },
        { id: "w2", verdict: "pass" },
      ],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.covered).toBe(true)
    expect(v.missing).toEqual([])
    expect(v.verifiedScope).toBe("2/2 witnesses verified")
  })

  it("rejects a strict-subset repro (the H1 14369 shape: 2 of 3 witnesses)", () => {
    const claim = fixedClaim(["case-a", "case-b", "case-c"])
    const evidence: Evidence = {
      scope: { kind: "witnesses", items: ["case-a", "case-b"] },
      items: [
        { id: "case-a", verdict: "pass" },
        { id: "case-b", verdict: "pass" },
      ],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.covered).toBe(false)
    expect(v.missing).toEqual(["case-c"])
    expect(v.verifiedScope).toContain("2/3 witnesses verified")
    expect(v.verifiedScope).toContain("1 unchecked")
  })

  it("subtracts the baseline: pre-existing reds are env facts, not failures (H8 8707 shape)", () => {
    const claim: Claim = { kind: "no_regressions", scope: { kind: "tests", items: ["t_new"] } }
    const evidence: Evidence = {
      scope: { kind: "tests", items: ["t_new", "t_np_int_a", "t_np_int_b"] },
      items: [
        { id: "t_new", verdict: "pass" },
        { id: "t_np_int_a", verdict: "fail", detail: "np.int removed in numpy>=1.20" },
        { id: "t_np_int_b", verdict: "fail" },
      ],
      baseline: ["t_np_int_a", "t_np_int_b"],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.covered).toBe(true)
    expect(v.failing).toEqual([])
    expect(v.preExisting).toEqual(["t_np_int_a", "t_np_int_b"])
    expect(v.verifiedScope).toContain("pre-existing (env)")
  })

  it("a new red outside the claim scope still blocks coverage (8872 subset-green shape)", () => {
    const claim: Claim = { kind: "no_regressions", scope: { kind: "tests", items: ["t1"] } }
    const evidence: Evidence = {
      scope: { kind: "tests", items: ["t1", "t_neighbor"] },
      items: [
        { id: "t1", verdict: "pass" },
        { id: "t_neighbor", verdict: "fail" },
      ],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.covered).toBe(false)
    expect(v.failing).toEqual(["t_neighbor"])
  })

  it("unverified blocks like absent — no promotion on partial execution", () => {
    const claim: Claim = { kind: "done", scope: { kind: "deliverables", items: ["out.bin", "check:make test"] } }
    const evidence: Evidence = {
      scope: { kind: "deliverables", items: ["out.bin", "check:make test"] },
      items: [
        { id: "out.bin", verdict: "pass" },
        { id: "check:make test", verdict: "unverified", detail: "command not run" },
      ],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.covered).toBe(false)
    expect(v.missing).toEqual(["check:make test"])
  })

  it("worst-verdict-wins on duplicate ids — a flaky pass never masks a recorded fail", () => {
    const claim = fixedClaim(["w1"])
    const evidence: Evidence = {
      scope: { kind: "witnesses", items: ["w1"] },
      items: [
        { id: "w1", verdict: "fail" },
        { id: "w1", verdict: "pass" },
      ],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.covered).toBe(false)
    expect(v.failing).toEqual(["w1"])
    expect(v.missing).toEqual(["w1"])
  })
})
