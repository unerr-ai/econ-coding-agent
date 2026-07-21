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

  it("rejects a strict-subset repro (asserting only 2 of 3 issue-stated witnesses)", () => {
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

  it("subtracts the baseline: pre-existing reds from an unrelated dependency/version mismatch are env facts, not failures", () => {
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

  it("a new red outside the claim scope still blocks coverage (subset-green shape)", () => {
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

  it("covered:false does NOT imply a regression — missing still counts baseline-excused reds", () => {
    // Every red here is pre-existing (env), not model-induced: `failing` is
    // correctly empty and `preExisting` correctly non-empty. But `missing` is
    // "claimed scope items whose worst verdict isn't pass" — it counts these
    // baseline-excused reds too, so `covered` still comes back false. A caller
    // that reads `!covered` as "a regression happened" therefore fires a false
    // regression nudge naming zero tests — an unfalsifiable complaint, which a
    // model can only answer by widening test scope until the turn exhausts its
    // budget. Any repo carrying a pre-existing environment red trips this on
    // every turn. The correct "did anything genuinely regress" check is
    // `failing.length > 0`, never `!covered`.
    const claim: Claim = {
      kind: "no_regressions",
      scope: { kind: "tests", items: ["t_ok", "t_env_a", "t_env_b"] },
    }
    const evidence: Evidence = {
      scope: { kind: "tests", items: ["t_ok", "t_env_a", "t_env_b"] },
      items: [
        { id: "t_ok", verdict: "pass" },
        { id: "t_env_a", verdict: "fail", detail: "pre-existing env break" },
        { id: "t_env_b", verdict: "fail", detail: "pre-existing env break" },
      ],
      baseline: ["t_env_a", "t_env_b"],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.failing).toEqual([])
    expect(v.preExisting).toEqual(["t_env_a", "t_env_b"])
    expect(v.covered).toBe(false)
    expect(v.verifiedScope).toBe("1/3 tests verified (2 pre-existing (env))")
  })

  it("distinguishes a baseline-excused red from a genuinely new one, per test-id not per-file", () => {
    const claim: Claim = {
      kind: "no_regressions",
      scope: { kind: "tests", items: ["test_models.py::test_env_broken", "test_models.py::test_new_regression"] },
    }
    const evidence: Evidence = {
      scope: { kind: "tests", items: ["test_models.py::test_env_broken", "test_models.py::test_new_regression"] },
      items: [
        { id: "test_models.py::test_env_broken", verdict: "fail", detail: "pre-existing env break" },
        { id: "test_models.py::test_new_regression", verdict: "fail", detail: "model-induced regression" },
      ],
      baseline: ["test_models.py::test_env_broken"],
    }
    const v = checkClaimCoverage(claim, evidence)
    expect(v.failing).toEqual(["test_models.py::test_new_regression"])
    expect(v.preExisting).toEqual(["test_models.py::test_env_broken"])
    expect(v.covered).toBe(false)
  })
})
