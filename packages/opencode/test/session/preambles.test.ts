/**
 * P4b — the read-only playbook line in `triagePreamble`. A turn made ENTIRELY of
 * read-only goals (qa/research/audit/run-only) must carry the READ-ONLY steer so
 * the conductor answers-and-stops instead of authoring a repro / editing / running
 * the suite. A turn with any fix goal (diagnosis/build/refactor) must NOT — its
 * fix machinery stays armed. Paired with the degraded-arming stand-down in
 * prompt.ts (which holds the conductor's todos inline) and verdictIsReadOnly
 * (arming-judge.ts), which both this line and that stand-down gate on.
 */

import { describe, test, expect } from "bun:test"
import { triagePreamble } from "../../src/session/prompts/preambles"
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
