/**
 * Unit tests for prompts/seeds.ts — round-F wave, W1 slice (docs/features/08-signal-bus.md
 * §11 seed priors + §3 deferral slice template). Pure string assertions: no I/O.
 */

import { describe, it, expect } from "bun:test"
import { createHash } from "node:crypto"
import {
  LOCALIZATION_SLICE_CONTENT,
  GRIND_DESIGN_SLICE_CONTENT,
  reproSliceContent,
  DEFERRAL_SLICE_PREFIX,
  buildDeferralSliceContent,
  type DeferralBrief,
} from "../../src/session/prompts/seeds"
import { type ReproVehicle } from "../../src/session/prompts/nudges"

describe("seeds.ts — §11 seed priors", () => {
  it("LOCALIZATION_SLICE_CONTENT carries the typed-mirror-over-idiom-mirror precedence sentence", () => {
    expect(LOCALIZATION_SLICE_CONTENT).toContain(
      "Precedence: typed-mirror OVERRIDES idiom-mirror — even when a neighboring helper stringifies, assign and assert the TYPED value (254, not '254').",
    )
  })

  it("LOCALIZATION_SLICE_CONTENT carries the sibling-propagation enumeration sentence", () => {
    expect(LOCALIZATION_SLICE_CONTENT).toContain(
      "When the fix changes how a construct renders or serializes, ENUMERATE every sibling class that renders the same construct and check each one as a checklist — never from memory.",
    )
  })

  it("LOCALIZATION_SLICE_CONTENT carries the tests-are-spec EXCEPTION carve-out", () => {
    expect(LOCALIZATION_SLICE_CONTENT).toContain(
      "EXCEPTION: if a visible test's expectation contradicts the issue's stated desired output, the ISSUE is the spec — do not contort the fix to keep the contradicting assertion green; state the conflict in your answer instead.",
    )
  })

  it("reproSliceContent() carries the %r/repr formatting-expectation sentence", () => {
    expect(reproSliceContent()).toContain(
      "Prefer %r/repr-shaped formatting expectations exactly as the issue states them — never normalize quote style in expected strings.",
    )
  })

  it("reproSliceContent() carries the (11) witness-breadth point (plain-sibling assert)", () => {
    expect(reproSliceContent()).toContain("(11)")
    expect(reproSliceContent()).toContain("PLAIN sibling")
  })
})

describe("seeds.ts — buildDeferralSliceContent (§3 deferral slice template)", () => {
  const brief: DeferralBrief = {
    signal: "probe_gate_exhausted",
    gateEvidence: "pinned probe ran red 3x — assert widget.attrs['maxlength'] == 254",
    probeCommand: "python repro_issue.py",
    redTail: "AssertionError: '254' != 254",
    candidates: ["widgets.py Widget.render_attrs", "forms.py BoundField.build_widget_attrs"],
    expectations: ["widget.attrs['maxlength'] == field.max_length (typed, not rendered)"],
    statedRules: ["more than 50 years ... MUST interpret"],
  }

  it("starts with DEFERRAL_SLICE_PREFIX", () => {
    const content = buildDeferralSliceContent(brief)
    expect(content.startsWith(DEFERRAL_SLICE_PREFIX)).toBe(true)
  })

  it("includes the gate evidence verbatim", () => {
    const content = buildDeferralSliceContent(brief)
    expect(content).toContain(brief.gateEvidence)
  })

  it("includes the pinned probe command and red tail when present", () => {
    const content = buildDeferralSliceContent(brief)
    expect(content).toContain(brief.probeCommand!)
    expect(content).toContain(brief.redTail!)
  })

  it("omits the probe/red-tail lines when absent", () => {
    const content = buildDeferralSliceContent({ ...brief, probeCommand: undefined, redTail: undefined })
    expect(content).not.toContain("PINNED PROBE")
    expect(content).not.toContain("RED TAIL")
  })

  it("enumerates every candidate under the choose-by-evidence header", () => {
    const content = buildDeferralSliceContent(brief)
    expect(content).toContain("CANDIDATES (choose by evidence, do not invent):")
    for (const candidate of brief.candidates) {
      expect(content).toContain(candidate)
    }
  })

  it("includes every issue-stated expectation as a binding assert", () => {
    const content = buildDeferralSliceContent(brief)
    for (const expectation of brief.expectations) {
      expect(content).toContain(expectation)
    }
  })

  it("instructs a root-most fix proven by the pinned probe, with the oracle-inversion escape", () => {
    const content = buildDeferralSliceContent(brief)
    expect(content).toContain("ROOT-MOST fix")
    expect(content).toContain("do not force it green")
  })

  it("includes every stated rule quoted, with an instruction to assert both sides of the boundary", () => {
    const content = buildDeferralSliceContent(brief)
    expect(content).toContain("STATED RULES (issue-stated boundary rules, binding — the repro must assert BOTH sides of each):")
    for (const rule of brief.statedRules) {
      expect(content).toContain(rule)
    }
  })

  it("omits the STATED RULES section when there are no stated rules", () => {
    const content = buildDeferralSliceContent({ ...brief, statedRules: [] })
    expect(content).not.toContain("STATED RULES")
  })
})

// P4 (docs/design/agnostic-hands-eyes.md §4.6/§5) — byte-parity + token-size
// audit for the profile-compiled repro seed. reproSliceContent()/
// GRIND_DESIGN_SLICE_CONTENT are large (thousands of chars); asserting a
// SHA-256 digest instead of embedding the whole blob a second time still
// proves byte-for-byte identity against the intended text without the
// transcription risk of retyping it. The goldens started as the pre-P4
// constants; reproSliceContent()'s was re-baselined once, when three benchmark
// instance ids were dropped from a parenthetical example inside
// REPRO_SLICE_TEXT (the three bug shapes they named were kept). Re-baseline
// ONLY for a deliberate prompt edit — an unexplained mismatch here means the
// seed drifted by accident, which is exactly what this guard exists to catch.
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

describe("P4 byte-parity — python/default profile snapshots", () => {
  it("reproSliceContent() (no vehicle) is byte-identical to the pre-P4 text (SHA-256 digest)", () => {
    expect(reproSliceContent().length).toBe(6165)
    expect(sha256(reproSliceContent())).toBe("b2b84e669d2eec51852fc2bb08ecffc6df607d4cb88a8ad8df097bb764dde71f")
  })

  it("GRIND_DESIGN_SLICE_CONTENT is untouched by P4 (no Python repro tokens to compile) — byte-identical (SHA-256 digest)", () => {
    expect(GRIND_DESIGN_SLICE_CONTENT.length).toBe(852)
    expect(sha256(GRIND_DESIGN_SLICE_CONTENT)).toBe("79abba93722c66a300ba1d117e9f8b87c9ee80c62aa4ba531b4772476da1e9cf")
  })
})

// V3 — the leaked-constant fix: every real consumer now calls
// reproSliceContent(vehicle) with the SESSION's actual repro vehicle
// (buildTriageTodoSkeleton -> reproPrepassTodo in slice-orchestrator.ts;
// see slice-orchestrator.test.ts for the plant-site coverage). This is the
// content-compiler seam itself: a non-python vehicle must produce prose
// naming ITS OWN repro filename/run command with zero leaked Python tokens —
// the exact leak a bare `reproSliceContent()` (python default) would have
// shipped on a non-python V3 validation target.
describe("V3 — non-python vehicle carries zero Python tokens", () => {
  const goVehicle: ReproVehicle = { ext: "go", run: "go run repro_issue.go" }

  it("names repro_issue.go and its run command, with no 'python'/'.py' anywhere", () => {
    const content = reproSliceContent(goVehicle)
    expect(content).toContain("repro_issue.go")
    expect(content).toContain("go run repro_issue.go")
    expect(content.toLowerCase()).not.toContain("python")
    expect(content).not.toContain(".py")
  })
})

// §4.6 token-size budget: a compiled seed must stay <= today's Python-only
// size, and swapping ecosystems must not blow up prompt size (§5 cost law —
// adding an ecosystem costs ~0 prompt tokens, not a growing catalog).
describe("P4 token-size audit (§4.6 size budget)", () => {
  it("the compiled python seed's length is <= today's snapshot length", () => {
    expect(reproSliceContent().length).toBeLessThanOrEqual(6167)
  })

  it("a js-profile seed's length stays within +/-10% of the python one", () => {
    const jsVehicle: ReproVehicle = { ext: "js", run: "node repro_issue.js" }
    const pythonLen = reproSliceContent().length
    const jsLen = reproSliceContent(jsVehicle).length
    expect(jsLen).toBeGreaterThanOrEqual(pythonLen * 0.9)
    expect(jsLen).toBeLessThanOrEqual(pythonLen * 1.1)
  })
})
