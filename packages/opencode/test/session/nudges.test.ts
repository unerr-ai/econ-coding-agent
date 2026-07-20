/**
 * Unit tests for prompts/nudges.ts — seenRedInversionNudgeText (the
 * oracle-inversion nudge: a committed test's expectation contradicts the
 * issue's stated desired output, so the F18 seen-red gate marks that red
 * SANCTIONED rather than nudging the model to make it green).
 */

import { describe, test, expect } from "bun:test"
import {
  seenRedInversionNudgeText,
  reproDriftNudgeText,
  reproDriftEscalationNudgeText,
  convergeNowNudgeText,
  type ReproVehicle,
} from "../../src/session/prompts/nudges"

describe("seenRedInversionNudgeText", () => {
  test("a single sanctioned entry: SANCTIONED, singular framing, and the command", () => {
    const text = seenRedInversionNudgeText([{ command: "pytest tests/test_widget.py" }])
    expect(text).toContain("SANCTIONED")
    expect(text).toContain("This red is")
    expect(text).toContain("`pytest tests/test_widget.py`")
  })

  test("multiple sanctioned entries: plural framing, and every command", () => {
    const text = seenRedInversionNudgeText([
      { command: "pytest tests/test_widget.py" },
      { command: "pytest tests/test_forms.py" },
    ])
    expect(text).toContain("SANCTIONED")
    expect(text).toContain("These reds are")
    expect(text).toContain("`pytest tests/test_widget.py`")
    expect(text).toContain("`pytest tests/test_forms.py`")
  })

  test("includes the desired/buggy literals in the evidence line when both are present", () => {
    const text = seenRedInversionNudgeText([
      { command: "pytest tests/test_widget.py", desiredLiteral: "254", buggyLiteral: "'254'" },
    ])
    expect(text).toContain("254")
    expect(text).toContain("'254'")
    expect(text).toContain("the issue's stated desired form")
  })

  test("omits the evidence line when only one of desired/buggy literal is present", () => {
    const text = seenRedInversionNudgeText([{ command: "pytest tests/test_widget.py", desiredLiteral: "254" }])
    expect(text).not.toContain("the issue's stated desired form")
  })
})

// P4 (docs/design/agnostic-hands-eyes.md §4.6) — byte-parity snapshots for
// the python/default profile: every repro-drift/converge nudge above was
// re-signed to take a `vehicle` parameter, defaulting to
// `PYTHON_REPRO_VEHICLE`, and MUST still emit exactly the pre-P4 hardcoded
// text when called with no vehicle (or the python one explicitly) — the
// mini-10 benchmark surface stays bit-stable. These literals were captured
// from nudges.ts BEFORE the profile-compilation refactor landed.
describe("P4 byte-parity — python/default profile snapshots", () => {
  test("reproDriftNudgeText('inline-repro') is byte-identical to the pre-P4 text", () => {
    expect(reproDriftNudgeText("inline-repro")).toBe(
      "You ran an inline `python -c`/heredoc command carrying an assertion instead of a file. An inline command cannot be pinned as this turn's verification contract — the turn-end gate has nothing to re-run. Write that exact assertion into a file named `repro_issue.py` at the repo root and run `python repro_issue.py` as its own single command.",
    )
  })

  test("reproDriftNudgeText('suite-edit-denied') is byte-identical to the pre-P4 text", () => {
    expect(reproDriftNudgeText("suite-edit-denied")).toBe(
      "Your edit to the existing test suite was denied by the no-test-edit gate. Modifying the committed suite cannot substitute for a reproduction — creating NEW scratch files is allowed, changing the oracle is not. Write a NEW file, `repro_issue.py` at the repo root (never inside the tests/ tree), importing ONLY from the installed package (never from a tests.* module — define minimal stand-in classes inline if you need one), asserting the issue's expected behavior and run it standalone as `python repro_issue.py`.",
    )
  })

  test("reproDriftNudgeText('unpinnable-red') is byte-identical to the pre-P4 text", () => {
    expect(reproDriftNudgeText("unpinnable-red")).toBe(
      "Your failing command was a whole-suite run or a multi-line/batched script. Neither can be pinned as this turn's reproduction — the gate needs one single, targeted command to re-run. Isolate the same failure into a single-command file, `repro_issue.py` at the repo root, and run it alone as `python repro_issue.py`.",
    )
  })

  test("reproDriftNudgeText('pinned-repro-deleted') (no vehicle-shaped text; unaffected by profile) is byte-identical", () => {
    expect(reproDriftNudgeText("pinned-repro-deleted")).toBe(
      "You deleted `the pinned repro file`, but it is this turn's pinned verification contract — the done-gate re-runs `the pinned command` and a missing file counts as RED. Recreate the file exactly as it was and leave it in place until the turn ends; it is untracked and never enters the patch.",
    )
  })

  test("reproDriftEscalationNudgeText() is byte-identical to the pre-P4 REPRO_DRIFT_ESCALATION_NUDGE text", () => {
    expect(reproDriftEscalationNudgeText()).toBe(
      "You have drifted from the repro contract three times without pinning a reproduction — inline commands, a denied suite edit, or an unpinnable run, never a file. " +
        "Write the exact assertion into `repro_issue.py` at the repo root and run it ALONE as `python repro_issue.py`, confirming it is RED before any fix. " +
        "This is the last reminder on this turn.",
    )
  })

  test("convergeNowNudgeText() is byte-identical to the pre-P4 text", () => {
    expect(convergeNowNudgeText(8)).toBe(
      "Your source fix landed 8 steps ago and no reproduction has been pinned — continued broad verification is not converging. Do ONE of these now: (a) make a single-file repro run — `repro_issue.py` at the repo ROOT, one command, `python repro_issue.py` — confirming your fix (it must fail on the pre-fix code for the issue's reason); or (b) FINISH: give your final answer now, stating plainly what you verified and what you could not. Do not start any new investigation.",
    )
  })
})

// §5 single-ecosystem rule: a non-python profile's compiled nudge names
// exactly the ONE vehicle it was given — never a leftover Python token and
// never a second ecosystem's tokens alongside it.
describe("P4 single-ecosystem rule — non-python vehicle compiles cleanly", () => {
  const goVehicle: ReproVehicle = { ext: "go", run: "go run repro_issue.go" }

  test("reproDriftNudgeText names only the Go vehicle, no leftover python tokens", () => {
    const text = reproDriftNudgeText("unpinnable-red", undefined, goVehicle)
    expect(text).toContain("repro_issue.go")
    expect(text).toContain("go run repro_issue.go")
    expect(text).not.toContain("repro_issue.py")
    expect(text).not.toContain("python")
  })

  test("convergeNowNudgeText names only the Go vehicle, no leftover python tokens", () => {
    const text = convergeNowNudgeText(4, goVehicle)
    expect(text).toContain("repro_issue.go")
    expect(text).toContain("go run repro_issue.go")
    expect(text).not.toContain("repro_issue.py")
    expect(text).not.toContain("python")
  })
})
