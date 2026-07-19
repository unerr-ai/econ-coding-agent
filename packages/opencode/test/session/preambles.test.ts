/**
 * P4b — the read-only playbook line in `triagePreamble`. A turn made ENTIRELY of
 * read-only goals (qa/research/audit/run-only) must carry the READ-ONLY steer so
 * the conductor answers-and-stops instead of authoring a repro / editing / running
 * the suite. A turn with any fix goal (diagnosis/build/refactor) must NOT — its
 * fix machinery stays armed. Paired with the degraded-arming stand-down in
 * prompt.ts (which holds the conductor's todos inline) and verdictIsReadOnly
 * (arming-judge.ts), which both this line and that stand-down gate on.
 */

import { describe, test, expect, afterEach } from "bun:test"
import {
  triagePreamble,
  timeBudgetLine,
  degradedTurnPreamble,
  timeBudgetCheckpointLine,
  OPS_PLAYBOOK,
  TEST_EDIT_GATE_RULE,
} from "../../src/session/prompts/preambles"
import { decideArming } from "../../src/session/arming-judge"
import type { TriageGoal, TriageVerdict } from "../../src/session/turn-triage"

function verdictOf(goals: TriageGoal[], confidence: "high" | "low" = "high"): TriageVerdict {
  return { goals, constraints: [], confidence }
}

const preambleOf = (verdict: TriageVerdict): string => triagePreamble(verdict, decideArming(verdict))

describe("triagePreamble — read-only playbook", () => {
  test("a pure qa turn carries the READ-ONLY steer", () => {
    const text = preambleOf(verdictOf([{ quote: "where is resolve_redirects", shape: "qa", deliverable: "answer" }]))
    expect(text).toContain("READ-ONLY TURN")
    expect(text).toContain("OUT OF SCOPE")
  })

  test("audit / research / run-only turns also carry it", () => {
    for (const shape of ["audit", "research", "run-only"] as const) {
      const text = preambleOf(verdictOf([{ quote: "review the retry path", shape, deliverable: "report" }]))
      expect(text, `shape ${shape} must steer read-only`).toContain("READ-ONLY TURN")
    }
  })

  test("a diagnosis/build/refactor turn does NOT carry the read-only steer (fix harness stays armed)", () => {
    for (const shape of ["diagnosis-vague", "diagnosis-grounded", "build", "refactor"] as const) {
      const text = preambleOf(verdictOf([{ quote: "fix the bug", shape, deliverable: "fixed" }]))
      expect(text, `shape ${shape} must NOT steer read-only`).not.toContain("READ-ONLY TURN")
    }
  })

  test("a COMPOUND turn (qa + diagnosis) does NOT carry the read-only steer — the fix goal keeps the harness armed", () => {
    const text = preambleOf(
      verdictOf([
        { quote: "explain how redirect handling works", shape: "qa", deliverable: "answer" },
        { quote: "fix the failing redirect test", shape: "diagnosis-grounded", deliverable: "test green" },
      ]),
    )
    expect(text).not.toContain("READ-ONLY TURN")
  })
})

describe("triagePreamble — diagnosis playbook", () => {
  test("a diagnosis-shaped verdict carries the DIAGNOSIS PLAYBOOK line", () => {
    for (const shape of ["diagnosis-grounded", "diagnosis-vague"] as const) {
      const text = preambleOf(verdictOf([{ quote: "fix the bug", shape, deliverable: "fixed" }]))
      expect(text, `shape ${shape} must carry the diagnosis playbook`).toContain("DIAGNOSIS PLAYBOOK")
    }
  })

  test("a build-only verdict does NOT carry the DIAGNOSIS PLAYBOOK line", () => {
    const text = preambleOf(verdictOf([{ quote: "add a retry to the boot path", shape: "build", deliverable: "shipped" }]))
    expect(text).not.toContain("DIAGNOSIS PLAYBOOK")
  })
})

describe("triagePreamble — ops playbook (D5, 09-ops-hands.md)", () => {
  test("a build-only verdict carries the OPS PLAYBOOK line", () => {
    const text = preambleOf(verdictOf([{ quote: "build the pmars binary", shape: "build", deliverable: "binary installed" }]))
    expect(text).toContain("OPS PLAYBOOK")
  })

  test("a run-only verdict also carries the OPS PLAYBOOK line", () => {
    const text = preambleOf(verdictOf([{ quote: "run the migration script", shape: "run-only", deliverable: "migration applied" }]))
    expect(text).toContain("OPS PLAYBOOK")
  })

  test("a verdict containing a diagnosis-shaped goal does NOT carry the OPS PLAYBOOK line", () => {
    const text = preambleOf(
      verdictOf([
        { quote: "build the artifact", shape: "build", deliverable: "artifact built" },
        { quote: "fix the failing build step", shape: "diagnosis-grounded", deliverable: "build green" },
      ]),
    )
    expect(text).not.toContain("OPS PLAYBOOK")
  })

  test("a pure qa verdict does NOT carry the OPS PLAYBOOK line", () => {
    const text = preambleOf(verdictOf([{ quote: "where is resolve_redirects", shape: "qa", deliverable: "answer" }]))
    expect(text).not.toContain("OPS PLAYBOOK")
  })
})

describe("triagePreamble — deadline line (D5, 09-ops-hands.md)", () => {
  const previous = process.env.ECON_TASK_DEADLINE_MS

  afterEach(() => {
    if (previous === undefined) delete process.env.ECON_TASK_DEADLINE_MS
    else process.env.ECON_TASK_DEADLINE_MS = previous
  })

  test("carries a Time budget line when ECON_TASK_DEADLINE_MS is set", () => {
    process.env.ECON_TASK_DEADLINE_MS = String(Date.now() + 5 * 60_000)
    const text = preambleOf(verdictOf([{ quote: "build the artifact", shape: "build", deliverable: "artifact built" }]))
    expect(text).toMatch(/Time budget: ~\d+m remaining for this task\./)
  })

  test("omits the Time budget line when ECON_TASK_DEADLINE_MS is unset", () => {
    delete process.env.ECON_TASK_DEADLINE_MS
    const text = preambleOf(verdictOf([{ quote: "build the artifact", shape: "build", deliverable: "artifact built" }]))
    expect(text).not.toContain("Time budget:")
  })

  test("omits the Time budget line when ECON_TASK_DEADLINE_MS is unparsable", () => {
    process.env.ECON_TASK_DEADLINE_MS = "not-a-number"
    const text = preambleOf(verdictOf([{ quote: "build the artifact", shape: "build", deliverable: "artifact built" }]))
    expect(text).not.toContain("Time budget:")
  })
})

describe("timeBudgetLine", () => {
  const previous = process.env.ECON_TASK_DEADLINE_MS

  afterEach(() => {
    if (previous === undefined) delete process.env.ECON_TASK_DEADLINE_MS
    else process.env.ECON_TASK_DEADLINE_MS = previous
  })

  test("returns null when ECON_TASK_DEADLINE_MS is unset", () => {
    delete process.env.ECON_TASK_DEADLINE_MS
    expect(timeBudgetLine()).toBeNull()
  })

  test("returns the Time budget line when ECON_TASK_DEADLINE_MS is set", () => {
    process.env.ECON_TASK_DEADLINE_MS = String(Date.now() + 5 * 60_000)
    expect(timeBudgetLine()).toMatch(/^Time budget: ~\d+m remaining for this task\.$/)
  })
})

describe("degradedTurnPreamble (H4.2 — F09 residual close: OPS_PLAYBOOK survives the null-verdict degrade path)", () => {
  const previous = process.env.ECON_TASK_DEADLINE_MS

  afterEach(() => {
    if (previous === undefined) delete process.env.ECON_TASK_DEADLINE_MS
    else process.env.ECON_TASK_DEADLINE_MS = previous
  })

  test("carries TEST_EDIT_GATE_RULE and OPS_PLAYBOOK even with no triage verdict at all", () => {
    delete process.env.ECON_TASK_DEADLINE_MS
    const text = degradedTurnPreamble()
    expect(text).toContain(TEST_EDIT_GATE_RULE)
    expect(text).toContain(OPS_PLAYBOOK)
  })

  test("also carries the deadline line when ECON_TASK_DEADLINE_MS is set — mirrors timeBudgetLine's own precedent", () => {
    process.env.ECON_TASK_DEADLINE_MS = String(Date.now() + 5 * 60_000)
    expect(degradedTurnPreamble()).toMatch(/Time budget: ~\d+m remaining for this task\./)
  })

  test("omits the deadline line when ECON_TASK_DEADLINE_MS is unset", () => {
    delete process.env.ECON_TASK_DEADLINE_MS
    expect(degradedTurnPreamble()).not.toContain("Time budget:")
  })
})

describe("timeBudgetCheckpointLine (H4.2 — T-minus time-budget checkpoint)", () => {
  const previous = process.env.ECON_TASK_DEADLINE_MS

  afterEach(() => {
    if (previous === undefined) delete process.env.ECON_TASK_DEADLINE_MS
    else process.env.ECON_TASK_DEADLINE_MS = previous
  })

  test("returns null when no deadline is set", () => {
    delete process.env.ECON_TASK_DEADLINE_MS
    expect(timeBudgetCheckpointLine(`sess-${Math.random()}`)).toBeNull()
  })

  test("returns null when the deadline is unparsable", () => {
    process.env.ECON_TASK_DEADLINE_MS = "not-a-number"
    expect(timeBudgetCheckpointLine(`sess-${Math.random()}`)).toBeNull()
  })

  test("stays silent while more than ~20% of the budget remains", () => {
    const sessionID = `sess-${Math.random()}`
    const start = 1_000_000
    process.env.ECON_TASK_DEADLINE_MS = String(start + 100_000)
    expect(timeBudgetCheckpointLine(sessionID, start)).toBeNull() // baseline call: 100% remaining
    expect(timeBudgetCheckpointLine(sessionID, start + 50_000)).toBeNull() // 50% remaining
  })

  test("fires the converting nudge exactly once when remaining drops to ~20% or less", () => {
    const sessionID = `sess-${Math.random()}`
    const start = 2_000_000
    process.env.ECON_TASK_DEADLINE_MS = String(start + 100_000)
    expect(timeBudgetCheckpointLine(sessionID, start)).toBeNull() // baseline call, 100% remaining
    const nudge = timeBudgetCheckpointLine(sessionID, start + 85_000) // 15% remaining
    expect(nudge).toContain("checkpoint now: make the current best end-state verifiable and stop exploring")
    expect(timeBudgetCheckpointLine(sessionID, start + 90_000)).toBeNull() // already fired once — never again
  })

  test("a fresh session's baseline is independent of another session's state", () => {
    const sessionA = `sess-a-${Math.random()}`
    const sessionB = `sess-b-${Math.random()}`
    const start = 3_000_000
    process.env.ECON_TASK_DEADLINE_MS = String(start + 100_000)
    const nudgeA = timeBudgetCheckpointLine(sessionA, start + 90_000) // sessionA's first call is already at 10% — fires immediately, baseline = 100000-90000=10000... guard below
    // sessionA's baseline is captured AT this first call (totalMs = deadline-now = 10000),
    // so its own fraction is 100% remaining relative to ITS OWN baseline and stays null —
    // only a session whose baseline predates the low-remaining call can fire.
    expect(nudgeA).toBeNull()
    expect(timeBudgetCheckpointLine(sessionB, start)).toBeNull() // sessionB baseline call
  })
})
