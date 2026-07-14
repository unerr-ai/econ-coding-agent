/**
 * Tests for the repro-fidelity judge (F9a) — the pure parse/validate
 * pipeline (`parseReproFidelityResponse`) plus its one-shot dispatch
 * (`runReproFidelityJudge`), using arming-judge's scripted-LLM-stub pattern:
 * `complete` is a plain mocked callback, never a real provider. Table:
 * faithful verdict -> no nudge; gaps verdict -> nudge text contains each gap;
 * malformed LLM output -> faithful no-op; LLM throw -> faithful no-op.
 *
 * F14b adds the deterministic assert-teeth backstop: `hasAssertionTeeth`'s
 * truth table, and `applyAssertionTeethGap`'s gap-merge behavior (forces a
 * gap verdict even when the judge said faithful/degraded). RF-4 adds two
 * more of the same shape: `detectRenderedAssert`/`applyRenderedAssertGap`
 * (rendered/serialized-surface asserts) and `missingRequiredLiterals`/
 * `applyRequiredLiteralsGap` (§6 issue-derived literal coverage). RF-5 adds
 * a third tooth of the same shape — `detectStringifiedMirrorAssert`/
 * `applyStringifiedMirrorGap` (django-11790's stringified-expected-side
 * assert) — plus prompt-plumbing coverage for `runReproFidelityJudge`'s
 * optional `statedRules` boundary rubric. RF-8 adds a fifth tooth,
 * `detectNumericStringConflict`/`applyNumericStringConflictGap`, for
 * django-11790's later `if`/`failures.append` evasion (a quoted pure-int
 * literal on one line vs. the same digit sequence bare elsewhere), plus
 * `detectTypeUnfaithfulRepro`, the mirror+conflict composite consumed by
 * a finish-time re-check. The
 * `dispatchPinnedReproFidelity` wiring in prompt.ts (the shared dispatch
 * both pin sites call) is an Effect-generator closure over turn-loop state
 * (sessionID, sessions, lastUser, the per-turn `reproFidelityJudgedThisTurn`
 * flag) — not practical to unit test in isolation here; its two exported
 * building blocks (`hasAssertionTeeth`, `applyAssertionTeethGap`) are
 * covered directly below instead.
 */

import { describe, test, expect } from "bun:test"
import {
  parseReproFidelityResponse,
  runReproFidelityJudge,
  hasAssertionTeeth,
  applyAssertionTeethGap,
  ASSERTION_TEETH_GAP,
  detectRenderedAssert,
  applyRenderedAssertGap,
  RENDERED_ASSERT_GAP,
  missingRequiredLiterals,
  applyRequiredLiteralsGap,
  detectStringifiedMirrorAssert,
  applyStringifiedMirrorGap,
  STRINGIFIED_MIRROR_GAP,
  detectNumericStringConflict,
  applyNumericStringConflictGap,
  NUMERIC_STRING_CONFLICT_GAP,
  detectTypeUnfaithfulRepro,
  DEGRADED_REPRO_FIDELITY,
  REPRO_FIDELITY_MAX_GAPS,
  REPRO_FIDELITY_MAX_GAP_CHARS,
  type ReproFidelityComplete,
} from "../../src/session/repro-fidelity-judge"
import { reproFidelityNudgeText } from "../../src/session/prompts/nudges"
import { REPRO_FIDELITY_SYSTEM_PROMPT } from "../../src/session/prompts/judges"

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

  test("statedRules renders each rule and the both-sides instruction into the prompt", async () => {
    let seenUser = ""
    const complete: ReproFidelityComplete = async ({ user }) => {
      seenUser = user
      return JSON.stringify({ faithful: true, gaps: [] })
    }
    const statedRules = ["more than 50 years in the future MUST interpret as past"]
    await runReproFidelityJudge({ issueText, reproContent, complete, statedRules })
    expect(seenUser).toContain(statedRules[0])
    expect(seenUser).toContain("assert behavior on BOTH sides of the stated boundary")
  })

  test("absent statedRules leaves the prompt byte-for-byte unchanged", async () => {
    let seenUser = ""
    const complete: ReproFidelityComplete = async ({ user }) => {
      seenUser = user
      return JSON.stringify({ faithful: true, gaps: [] })
    }
    await runReproFidelityJudge({ issueText, reproContent, complete })
    expect(seenUser).toBe(`## Issue\n${issueText}\n\n## Pinned reproduction\n${reproContent}`)
  })

  test("empty statedRules array also leaves the prompt unchanged", async () => {
    let seenUser = ""
    const complete: ReproFidelityComplete = async ({ user }) => {
      seenUser = user
      return JSON.stringify({ faithful: true, gaps: [] })
    }
    await runReproFidelityJudge({ issueText, reproContent, complete, statedRules: [] })
    expect(seenUser).toBe(`## Issue\n${issueText}\n\n## Pinned reproduction\n${reproContent}`)
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

  test("F15d — tells the model to verify each gap against the issue text and ignore an invented one", () => {
    const text = reproFidelityNudgeText(["some gap"])
    expect(text).toContain("Verify each gap above against the issue text yourself")
    expect(text).toContain("ignore any gap here that asserts something the issue itself does not state")
  })
})

describe("REPRO_FIDELITY_SYSTEM_PROMPT", () => {
  test("F15d — forbids the judge from inventing an expectation the issue does not state", () => {
    expect(REPRO_FIDELITY_SYSTEM_PROMPT).toContain("never invent an expectation the issue text does not state")
    expect(REPRO_FIDELITY_SYSTEM_PROMPT).toContain("omit that gap entirely rather than assert one")
  })
})

describe("hasAssertionTeeth", () => {
  test.each([
    ["assert response.status_code == 200", true],
    ["raise ValueError('mismatch')", true],
    ["sys.exit(1)", true],
    ["exit(2)", true],
    ["process.exit(1)", true],
    ["exit 1", true],
    ["throw new Error('mismatch')", true],
    ["os._exit(3)", true],
  ])("%s -> %s", (content, expected) => {
    expect(hasAssertionTeeth(content)).toBe(expected)
  })

  test.each([
    ['print(f"EXPECTED {expected} ACTUAL {actual}")', false],
    ["exit(0)", false],
    ["sys.exit()", false],
    ["sys.exit(0)", false],
    ["# this needs an assertion eventually", false],
    ["", false],
  ])("%s -> %s", (content, expected) => {
    expect(hasAssertionTeeth(content)).toBe(expected)
  })

  test("a bare word boundary means 'assertion' (not 'assert') does not count — documented limitation", () => {
    // Plain word-boundary regex is intentional (F14b spec): \bassert\b does
    // not match inside "assertion" (no boundary between "assert" and "ion").
    expect(hasAssertionTeeth("# add an assertion here later")).toBe(false)
  })

  test("shell exit with a multi-digit nonzero code counts", () => {
    expect(hasAssertionTeeth("exit 10")).toBe(true)
  })
})

describe("applyAssertionTeethGap", () => {
  const faithfulVerdict = { faithful: true, gaps: [] }

  test("toothless content forces a gap verdict even when the judge said faithful", () => {
    const merged = applyAssertionTeethGap(faithfulVerdict, 'print("EXPECTED 1 ACTUAL 2")')
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toEqual([ASSERTION_TEETH_GAP])
  })

  test("toothless content forces a gap verdict even when the judge already reported other gaps", () => {
    const judgeVerdict = { faithful: false, gaps: ["asserts the wrong field"] }
    const merged = applyAssertionTeethGap(judgeVerdict, 'print("EXPECTED 1 ACTUAL 2")')
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toEqual(["asserts the wrong field", ASSERTION_TEETH_GAP])
  })

  test("content with real assertion teeth is a no-op — same verdict reference returned", () => {
    const verdict = faithfulVerdict
    const merged = applyAssertionTeethGap(verdict, "assert response.status_code == 200")
    expect(merged).toBe(verdict)
  })

  test("the merged gap list is reclamped to REPRO_FIDELITY_MAX_GAPS", () => {
    const judgeVerdict = {
      faithful: false,
      gaps: Array.from({ length: REPRO_FIDELITY_MAX_GAPS }, (_, i) => `gap ${i}`),
    }
    const merged = applyAssertionTeethGap(judgeVerdict, 'print("no teeth here")')
    expect(merged.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
    expect(merged.gaps).not.toContain(ASSERTION_TEETH_GAP)
  })
})

describe("detectRenderedAssert", () => {
  test("fires on a substring assert against a rendered HTML variable", () => {
    expect(detectRenderedAssert('assert \'maxlength="254"\' in html')).toBeDefined()
  })

  test("fires on an assertIn shape against a rendered variable", () => {
    expect(detectRenderedAssert('assertIn("maxlength=\\"254\\"", rendered)')).toBeDefined()
  })

  test("fires on a compared expression wrapped in str(...)", () => {
    expect(detectRenderedAssert("assert str(field.max_length) == '254'")).toBeDefined()
  })

  test("does NOT fire on a plain typed-equality assert", () => {
    expect(detectRenderedAssert('assert form.fields["username"].max_length == 254')).toBeUndefined()
  })

  test("does NOT fire on content with no assert at all", () => {
    expect(detectRenderedAssert('print("no assertion here")')).toBeUndefined()
  })
})

describe("applyRenderedAssertGap", () => {
  const faithfulVerdict = { faithful: true, gaps: [] }

  test("a rendered-assert hit forces a gap verdict even when the judge said faithful", () => {
    const merged = applyRenderedAssertGap(faithfulVerdict, 'assert \'maxlength="254"\' in html')
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toEqual([RENDERED_ASSERT_GAP])
  })

  test("content with no rendered-assert shape is a no-op — same verdict reference returned", () => {
    const verdict = faithfulVerdict
    const merged = applyRenderedAssertGap(verdict, 'assert form.fields["username"].max_length == 254')
    expect(merged).toBe(verdict)
  })
})

describe("missingRequiredLiterals / applyRequiredLiteralsGap", () => {
  const reproContent = "assert response.status_code == 200\n"

  test("a literal present in the repro is not reported missing", () => {
    expect(missingRequiredLiterals('assert x == "254"', ["254"])).toEqual([])
  })

  test("a literal absent from the repro is reported missing", () => {
    expect(missingRequiredLiterals(reproContent, ['"name" DESC'])).toEqual(['"name" DESC'])
  })

  test("undefined/empty requiredLiterals yields no misses", () => {
    expect(missingRequiredLiterals(reproContent, undefined)).toEqual([])
    expect(missingRequiredLiterals(reproContent, [])).toEqual([])
  })

  test("a missing required literal forces a gap naming it, even when the judge said faithful", () => {
    const faithfulVerdict = { faithful: true, gaps: [] }
    const merged = applyRequiredLiteralsGap(faithfulVerdict, reproContent, ['"name" DESC'])
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toHaveLength(1)
    expect(merged.gaps[0]).toContain('"name" DESC')
  })

  test("a present required literal is a no-op — same verdict reference returned", () => {
    const verdict = { faithful: true, gaps: [] }
    const merged = applyRequiredLiteralsGap(verdict, reproContent, ["status_code"])
    expect(merged).toBe(verdict)
  })

  test("the merged gap list is reclamped to REPRO_FIDELITY_MAX_GAPS", () => {
    const judgeVerdict = {
      faithful: false,
      gaps: Array.from({ length: REPRO_FIDELITY_MAX_GAPS }, (_, i) => `gap ${i}`),
    }
    const merged = applyRequiredLiteralsGap(judgeVerdict, reproContent, ['"name" DESC'])
    expect(merged.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
  })
})

describe("detectStringifiedMirrorAssert", () => {
  test("django-11790's exact line fires", () => {
    const line = "assert widget_maxlength == str(expected_max_length), ("
    expect(detectStringifiedMirrorAssert(line)).toBe(line)
  })

  test("assertEqual with the str(...) mirror on the second arg fires", () => {
    const line = "assertEqual(widget.attrs['maxlength'], str(max_length))"
    expect(detectStringifiedMirrorAssert(line)).toBe(line)
  })

  test("does NOT fire when str(...) wraps the SUBJECT, not the expected side (plain assert)", () => {
    expect(detectStringifiedMirrorAssert("assert str(Suit.HEART) == '1'")).toBeUndefined()
  })

  test("does NOT fire when str(...) wraps the subject and the other arg is a literal (assertEqual)", () => {
    expect(detectStringifiedMirrorAssert("assertEqual(str(member), 'value')")).toBeUndefined()
  })

  test("does NOT fire on a plain typed-equality assert", () => {
    expect(detectStringifiedMirrorAssert("assert form.fields['username'].max_length == 255")).toBeUndefined()
  })

  test("does NOT fire on a membership assert", () => {
    expect(detectStringifiedMirrorAssert("assert 'maxlength' in attrs")).toBeUndefined()
  })

  test("does NOT fire on str() outside an assert line", () => {
    expect(detectStringifiedMirrorAssert('print(f"{str(x)}")')).toBeUndefined()
  })

  test("does NOT fire on a bare typed-equality assert with no str() at all", () => {
    expect(detectStringifiedMirrorAssert("assert value == expected")).toBeUndefined()
  })

  test("does NOT fire on a strftime line", () => {
    expect(
      detectStringifiedMirrorAssert('assert event.created_at.strftime("%Y-%m-%d") == "2024-01-01"'),
    ).toBeUndefined()
  })

  test("does NOT fire anywhere in a full realistic multi-line repro with typed asserts", () => {
    const reproContent = `
import django
from myapp.models import Widget

widget = Widget.objects.get(pk=1)
field = widget._meta.get_field("name")
assert field.max_length == 254
assert isinstance(field.max_length, int)
print(f"max_length type: {type(field.max_length)}")
assert widget.name.startswith("test")
assertEqual(widget.attrs["maxlength"], 254)
`
    expect(detectStringifiedMirrorAssert(reproContent)).toBeUndefined()
  })

  test("django-11790's ALIASED evasion fires — expected = str(...) one hop up, plain assert compares the alias", () => {
    const reproContent = `expected = str(form.fields['username'].max_length)
assert widget_attrs['maxlength'] == expected, (
    "Expected maxlength=%r, got %r" % (expected, widget_attrs['maxlength'])
)`
    expect(detectStringifiedMirrorAssert(reproContent)).toBe("assert widget_attrs['maxlength'] == expected, (")
  })

  test("does NOT fire on the aliased SUBJECT-stringify __str__ shape (actual = str(member); assert actual == '1')", () => {
    const reproContent = ["actual = str(member)", "assert actual == '1'"].join("\n")
    expect(detectStringifiedMirrorAssert(reproContent)).toBeUndefined()
  })

  test("does NOT fire when the aliased str() is compared against a plain (non-chain) rendered variable", () => {
    const reproContent = ["expected = str(obj.value)", "assert rendered == expected"].join("\n")
    expect(detectStringifiedMirrorAssert(reproContent)).toBeUndefined()
  })
})

describe("applyStringifiedMirrorGap", () => {
  const faithfulVerdict = { faithful: true, gaps: [] }

  test("a stringified-mirror hit forces a gap verdict even when the judge said faithful, naming the offending line", () => {
    const reproContent = "assert widget_maxlength == str(expected_max_length), ("
    const merged = applyStringifiedMirrorGap(faithfulVerdict, reproContent)
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toHaveLength(1)
    expect(merged.gaps[0]).toContain(reproContent)
    expect(merged.gaps[0]).toContain(STRINGIFIED_MIRROR_GAP)
  })

  test("content with no stringified-mirror shape is a no-op — same verdict reference returned", () => {
    const verdict = faithfulVerdict
    const merged = applyStringifiedMirrorGap(verdict, "assert form.fields['username'].max_length == 254")
    expect(merged).toBe(verdict)
  })

  test("applying twice on the same content dedupes — the gap is not added a second time", () => {
    const reproContent = "assert x == str(y)"
    const once = applyStringifiedMirrorGap(faithfulVerdict, reproContent)
    const twice = applyStringifiedMirrorGap(once, reproContent)
    expect(twice.gaps).toHaveLength(1)
    expect(twice.gaps).toEqual(once.gaps)
  })

  test("the merged gap list is reclamped to REPRO_FIDELITY_MAX_GAPS, with the mirror gap surviving at index 0", () => {
    const judgeVerdict = {
      faithful: false,
      gaps: Array.from({ length: REPRO_FIDELITY_MAX_GAPS }, (_, i) => `gap ${i}`),
    }
    const merged = applyStringifiedMirrorGap(judgeVerdict, "assert x == str(y)")
    expect(merged.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
    expect(merged.gaps[0]).toContain(STRINGIFIED_MIRROR_GAP)
  })
})

describe("detectNumericStringConflict", () => {
  test("MUST-FIRE: django-11790's final if/failures.append pair — quoted '150' vs bare 150 elsewhere", () => {
    const reproContent = [
      "if field.max_length != 150:",
      '    failures.append(f"field.max_length = {field.max_length!r}, expected 150")',
      "",
      "if widget.attrs.get('maxlength') != '150':",
      "    failures.append(",
      "        f\"widget.attrs['maxlength'] = {widget.attrs.get('maxlength')!r}, \"",
      "        f\"expected '150'. all widget attrs = {dict(widget.attrs)}\"",
      "    )",
    ].join("\n")
    const result = detectNumericStringConflict(reproContent)
    expect(result).toBeDefined()
    expect(result).toContain("if widget.attrs.get('maxlength') != '150':")
    expect(result).toContain("if field.max_length != 150:")
  })

  test("MUST-FIRE: assert-style quoted numeral vs a bare integer elsewhere", () => {
    const reproContent = ["expected_code = 254", "assert response_code == '254'"].join("\n")
    const result = detectNumericStringConflict(reproContent)
    expect(result).toBeDefined()
    expect(result).toContain("assert response_code == '254'")
    expect(result).toContain("expected_code = 254")
  })

  test("MUST-FIRE: assertEqual(...) call with a quoted numeral vs a bare integer elsewhere", () => {
    const reproContent = [
      "assertEqual(widget.attrs.get('maxlength'), '150')",
      "assert field.max_length == 150",
    ].join("\n")
    const result = detectNumericStringConflict(reproContent)
    expect(result).toBeDefined()
    expect(result).toContain("assertEqual(widget.attrs.get('maxlength'), '150')")
    expect(result).toContain("assert field.max_length == 150")
  })

  test("does NOT fire when str(...) wraps the SUBJECT, even with a bare match elsewhere", () => {
    const reproContent = ["choice_value = 1", "assert str(choice) == '1'"].join("\n")
    expect(detectNumericStringConflict(reproContent)).toBeUndefined()
  })

  test("does NOT fire on a quoted numeral with no bare co-occurrence — could be a legitimately string-typed API value", () => {
    expect(detectNumericStringConflict("assert x == '150'")).toBeUndefined()
  })

  test("does NOT fire on a version-string literal", () => {
    const reproContent = ["minor = 39", "assert django.VERSION_STR == '3.9'"].join("\n")
    expect(detectNumericStringConflict(reproContent)).toBeUndefined()
  })

  test("does NOT fire on a quoted literal with embedded quote marks around non-numeral text (12039's real shape)", () => {
    const reproContent = [
      'expected1 = \'CREATE INDEX "idx" ON "schema_author" ("name" DESC)\'',
      "assert out1 == expected1, (out1, expected1)",
      "count = 150",
    ].join("\n")
    expect(detectNumericStringConflict(reproContent)).toBeUndefined()
  })

  test("does NOT fire on a construction-only line — no comparison at all", () => {
    const reproContent = ["attrs = {'maxlength': '150'}", "count = 150"].join("\n")
    expect(detectNumericStringConflict(reproContent)).toBeUndefined()
  })

  test("does NOT fire on a repr-formatted line", () => {
    const reproContent = ["count = 150", "assert f\"{x!r}\" == \"'150'\""].join("\n")
    expect(detectNumericStringConflict(reproContent)).toBeUndefined()
  })

  test("REAL-FIXTURE — fires on django-11790's actual arena repro_issue.py", () => {
    const reproContent = `"""
Regression per #27515 followup / forum report:
AuthenticationForm's username field does not render with a maxlength
HTML attribute on its <input>. Per the issue, the username widget MUST
carry a \`maxlength\` HTML attribute whose value mirrors the User model's
USERNAME_FIELD max_length (150 for the default User).

Checks below cover the issue's expectation at the API level so the
underlying value (150) is compared exactly, not just inferred from
rendered HTML.
"""
import django
from django.conf import settings

settings.configure(
    DEBUG=True,
    DATABASES={
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': ':memory:',
        }
    },
    INSTALLED_APPS=[
        'django.contrib.auth',
        'django.contrib.contenttypes',
    ],
    USE_TZ=True,
)
django.setup()

from django.contrib.auth.forms import AuthenticationForm

form = AuthenticationForm()
field = form.fields['username']
widget = field.widget
rendered_html = str(form['username'])

failures = []

if field.max_length != 150:
    failures.append(f"field.max_length = {field.max_length!r}, expected 150")

if widget.attrs.get('maxlength') != '150':
    failures.append(
        f"widget.attrs['maxlength'] = {widget.attrs.get('maxlength')!r}, "
        f"expected '150'. all widget attrs = {dict(widget.attrs)}"
    )

if 'maxlength' not in rendered_html:
    failures.append(f"rendered HTML has no maxlength attr: {rendered_html!r}")

if failures:
    print('REPRO RED — bug present:')
    for line in failures:
        print('  -', line)
    raise SystemExit(1)

print('REPRO GREEN — no bug.')
`
    expect(detectNumericStringConflict(reproContent)).toBeDefined()
  })
})

describe("applyNumericStringConflictGap", () => {
  const faithfulVerdict = { faithful: true, gaps: [] }

  test("a numeral/string conflict forces a gap verdict even when the judge said faithful, naming both lines", () => {
    const reproContent = ["expected_code = 254", "assert response_code == '254'"].join("\n")
    const merged = applyNumericStringConflictGap(faithfulVerdict, reproContent)
    expect(merged.faithful).toBe(false)
    expect(merged.gaps).toHaveLength(1)
    expect(merged.gaps[0]).toContain("assert response_code == '254'")
    expect(merged.gaps[0]).toContain("expected_code = 254")
    expect(merged.gaps[0]).toContain(NUMERIC_STRING_CONFLICT_GAP)
  })

  test("content with no conflict is a no-op — same verdict reference returned", () => {
    const verdict = faithfulVerdict
    const merged = applyNumericStringConflictGap(verdict, "assert x == '150'")
    expect(merged).toBe(verdict)
  })

  test("applying twice on the same content dedupes — the gap is not added a second time", () => {
    const reproContent = ["expected_code = 254", "assert response_code == '254'"].join("\n")
    const once = applyNumericStringConflictGap(faithfulVerdict, reproContent)
    const twice = applyNumericStringConflictGap(once, reproContent)
    expect(twice.gaps).toHaveLength(1)
    expect(twice.gaps).toEqual(once.gaps)
  })

  test("the merged gap list is reclamped to REPRO_FIDELITY_MAX_GAPS, with the conflict gap surviving at index 0", () => {
    const judgeVerdict = {
      faithful: false,
      gaps: Array.from({ length: REPRO_FIDELITY_MAX_GAPS }, (_, i) => `gap ${i}`),
    }
    const reproContent = ["expected_code = 254", "assert response_code == '254'"].join("\n")
    const merged = applyNumericStringConflictGap(judgeVerdict, reproContent)
    expect(merged.gaps).toHaveLength(REPRO_FIDELITY_MAX_GAPS)
    expect(merged.gaps[0]).toContain(NUMERIC_STRING_CONFLICT_GAP)
  })
})

describe("detectTypeUnfaithfulRepro", () => {
  test("mirror-fires case returns the stringified-mirror line", () => {
    const line = "assert widget_maxlength == str(expected_max_length), ("
    expect(detectTypeUnfaithfulRepro(line)).toBe(line)
  })

  test("conflict-fires case falls through to the numeral/string conflict when the mirror check finds nothing", () => {
    const reproContent = [
      "if field.max_length != 150:",
      "    failures.append('nope')",
      "if widget.attrs.get('maxlength') != '150':",
      "    failures.append('nope')",
    ].join("\n")
    expect(detectStringifiedMirrorAssert(reproContent)).toBeUndefined()
    const result = detectTypeUnfaithfulRepro(reproContent)
    expect(result).toBeDefined()
    expect(result).toEqual(detectNumericStringConflict(reproContent))
  })

  test("neither check fires on a plain typed-equality assert", () => {
    expect(detectTypeUnfaithfulRepro("assert response.status_code == 200")).toBeUndefined()
  })

  test("REAL-FIXTURE — does NOT fire on arena-11848's passing-run assert/comparison lines", () => {
    const reproContent = `def check(label, actual, expected):
    assert actual == expected, (
        f"{label}: expected {expected!r}, got {actual!r}"
    )
`
    expect(detectTypeUnfaithfulRepro(reproContent)).toBeUndefined()
  })

  test("REAL-FIXTURE — does NOT fire on arena-12039's passing-run assert/comparison lines", () => {
    const reproContent = `c = Columns(qtable, ['name'], qn, col_suffixes=['DESC'])
out1 = 'CREATE INDEX "idx" ON "schema_author" (' + str(c) + ')'
expected1 = 'CREATE INDEX "idx" ON "schema_author" ("name" DESC)'
assert out1 == expected1, (out1, expected1)

ic = IndexColumns(qtable, ['name'], qn, col_suffixes=[''], opclasses=['text_pattern_ops'])
out2 = 'CREATE INDEX "idx" ON "schema_author" (' + str(ic) + ')'
expected2 = 'CREATE INDEX "idx" ON "schema_author" ("name" text_pattern_ops)'
assert out2 == expected2, (out2, expected2)

ic = IndexColumns(qtable, ['name'], qn, col_suffixes=['DESC'], opclasses=['text_pattern_ops'])
out3 = str(ic)
expected3 = '"name" text_pattern_ops DESC'
assert out3 == expected3, (out3, expected3)

c = Columns(qtable, ['name'], qn, col_suffixes=[''])
assert str(c) == '"name"'

c = Columns(qtable, ['a', 'b'], qn)
assert str(c) == '"a", "b"'
`
    expect(detectTypeUnfaithfulRepro(reproContent)).toBeUndefined()
  })

  test("REAL-FIXTURE — fires on arena-11790's attempt-2 aliased evasion repro via the mirror path", () => {
    const reproContent = `form = AuthenticationForm()
widget_attrs = form.fields['username'].widget.attrs
assert 'maxlength' in widget_attrs, (
    "Regression: missing 'maxlength'. attrs=%r" % dict(widget_attrs)
)
expected = str(form.fields['username'].max_length)
assert widget_attrs['maxlength'] == expected, (
    "Expected maxlength=%r, got %r" % (expected, widget_attrs['maxlength'])
)`
    const result = detectTypeUnfaithfulRepro(reproContent)
    expect(result).toBeDefined()
    expect(result).toBe(detectStringifiedMirrorAssert(reproContent))
    expect(result).toBe("assert widget_attrs['maxlength'] == expected, (")
  })
})
