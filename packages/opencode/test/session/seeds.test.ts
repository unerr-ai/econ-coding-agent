/**
 * Unit tests for prompts/seeds.ts — round-F wave, W1 slice (docs/features/08-signal-bus.md
 * §11 seed priors + §3 deferral slice template). Pure string assertions: no I/O.
 */

import { describe, it, expect } from "bun:test"
import {
  LOCALIZATION_SLICE_CONTENT,
  REPRO_SLICE_CONTENT,
  DEFERRAL_SLICE_PREFIX,
  buildDeferralSliceContent,
  type DeferralBrief,
} from "../../src/session/prompts/seeds"

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

  it("REPRO_SLICE_CONTENT carries the %r/repr formatting-expectation sentence", () => {
    expect(REPRO_SLICE_CONTENT).toContain(
      "Prefer %r/repr-shaped formatting expectations exactly as the issue states them — never normalize quote style in expected strings.",
    )
  })

  it("REPRO_SLICE_CONTENT carries the (11) witness-breadth point (plain-sibling assert)", () => {
    expect(REPRO_SLICE_CONTENT).toContain("(11)")
    expect(REPRO_SLICE_CONTENT).toContain("PLAIN sibling")
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
