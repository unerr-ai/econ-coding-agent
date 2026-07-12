/**
 * Tests for the repro-fidelity judge (F9a) — the pure parse/validate
 * pipeline (`parseReproFidelityResponse`) plus its one-shot dispatch
 * (`runReproFidelityJudge`), using arming-judge's scripted-LLM-stub pattern:
 * `complete` is a plain mocked callback, never a real provider. Table:
 * faithful verdict -> no nudge; gaps verdict -> nudge text contains each gap;
 * malformed LLM output -> faithful no-op; LLM throw -> faithful no-op.
 */

import { describe, test, expect } from "bun:test"
import {
  parseReproFidelityResponse,
  runReproFidelityJudge,
  DEGRADED_REPRO_FIDELITY,
  REPRO_FIDELITY_MAX_GAPS,
  REPRO_FIDELITY_MAX_GAP_CHARS,
  type ReproFidelityComplete,
} from "../../src/session/repro-fidelity-judge"
import { reproFidelityNudgeText } from "../../src/session/prompts/nudges"

describe("parseReproFidelityResponse", () => {
  test("a faithful verdict with no gaps parses", () => {
    const raw = JSON.stringify({ faithful: true, gaps: [] })
    expect(parseReproFidelityResponse(raw)).toEqual({ faithful: true, gaps: [] })
  })

  test("an unfaithful verdict carries its gaps through", () => {
    const raw = JSON.stringify({ faithful: false, gaps: ["asserts HTML maxlength, not the int value"] })
    expect(parseReproFidelityResponse(raw)).toEqual({
      faithful: false,
      gaps: ["asserts HTML maxlength, not the int value"],
    })
  })

  test("gaps beyond REPRO_FIDELITY_MAX_GAPS are clamped", () => {
    const raw = JSON.stringify({ faithful: false, gaps: ["a", "b", "c", "d", "e"] })
    const verdict = parseReproFidelityResponse(raw)
    expect(verdict).not.toBeNull()
    expect(verdict!.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
    expect(verdict!.gaps).toEqual(["a", "b", "c"])
  })

  test("a gap longer than REPRO_FIDELITY_MAX_GAP_CHARS is truncated, not dropped", () => {
    const longGap = "x".repeat(200)
    const raw = JSON.stringify({ faithful: false, gaps: [longGap] })
    const verdict = parseReproFidelityResponse(raw)
    expect(verdict).not.toBeNull()
    expect(verdict!.gaps[0]).toHaveLength(REPRO_FIDELITY_MAX_GAP_CHARS)
  })

  test("a non-string gap entry is dropped, not corrected", () => {
    const raw = JSON.stringify({ faithful: false, gaps: ["real gap", 42, null] })
    const verdict = parseReproFidelityResponse(raw)
    expect(verdict!.gaps).toEqual(["real gap"])
  })

  test("a missing faithful field fails validation", () => {
    const raw = JSON.stringify({ gaps: [] })
    expect(parseReproFidelityResponse(raw)).toBeNull()
  })

  test("malformed JSON fails validation", () => {
    expect(parseReproFidelityResponse("{not valid json")).toBeNull()
  })

  test("no JSON object at all fails validation", () => {
    expect(parseReproFidelityResponse("I cannot judge this.")).toBeNull()
  })

  test("empty raw text fails validation", () => {
    expect(parseReproFidelityResponse("")).toBeNull()
  })
})

describe("runReproFidelityJudge", () => {
  const issueText = 'The issue quotes str(Choices.RED) and expects "Red", not the raw enum value.'
  const reproContent = 'assert response.content.decode().count(\'maxlength="254"\') == 1\n'

  test("a faithful verdict needs no nudge", async () => {
    const complete: ReproFidelityComplete = async () => JSON.stringify({ faithful: true, gaps: [] })
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict.faithful).toBe(true)
    expect(verdict.gaps).toHaveLength(0)
  })

  test("a gaps verdict's nudge text contains each gap", async () => {
    const gaps = ["asserts HTML maxlength, not the int value", "no assert on str(Choices.RED) itself"]
    const complete: ReproFidelityComplete = async () => JSON.stringify({ faithful: false, gaps })
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict.faithful).toBe(false)
    const nudge = reproFidelityNudgeText([...verdict.gaps])
    for (const gap of gaps) expect(nudge).toContain(gap)
  })

  test("malformed LLM output degrades to the faithful no-op", async () => {
    const complete: ReproFidelityComplete = async () => "{not valid json"
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict).toEqual(DEGRADED_REPRO_FIDELITY)
  })

  test("a thrown completion degrades to the faithful no-op", async () => {
    const complete: ReproFidelityComplete = async () => {
      throw new Error("provider unavailable")
    }
    const verdict = await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(verdict).toEqual(DEGRADED_REPRO_FIDELITY)
  })

  test("the completion request carries the issue text and repro content", async () => {
    let seenUser = ""
    let seenSystem = ""
    const complete: ReproFidelityComplete = async ({ system, user }) => {
      seenSystem = system
      seenUser = user
      return JSON.stringify({ faithful: true, gaps: [] })
    }
    await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(seenSystem).toContain("repro-fidelity judge")
    expect(seenUser).toContain(issueText)
    expect(seenUser).toContain(reproContent)
  })
})

describe("reproFidelityNudgeText", () => {
  test("names each gap and the re-run-STILL-RED instruction", () => {
    const gaps = ["asserts HTML maxlength, not the int value"]
    const text = reproFidelityNudgeText(gaps)
    expect(text).toContain(gaps[0])
    expect(text.toUpperCase()).toContain("STILL RED")
  })

  test("names every gap when there are several", () => {
    const gaps = ["gap one here", "gap two here"]
    const text = reproFidelityNudgeText(gaps)
    for (const gap of gaps) expect(text).toContain(gap)
  })
})
