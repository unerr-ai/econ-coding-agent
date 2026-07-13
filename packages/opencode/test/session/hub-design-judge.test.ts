/**
 * Tests for the hub-design judge (Wave 7, Wave 8/O-J1) — the pure
 * parse/validate pipeline (`parseHubDesignResponse`) plus its one-shot
 * dispatch (`runHubDesignJudge`), using repro-fidelity-judge's
 * scripted-LLM-stub pattern: `complete` is a plain mocked callback, never a
 * real provider. Table: clean JSON verdict -> parses; fenced JSON -> parses;
 * long reasoning prose before the JSON -> parses; two JSON objects -> the
 * LAST one wins; garbage/thrown completion -> degrades to
 * `{ verdict: DEGRADED_HUB_DESIGN, rawHead? }`; the completion request
 * carries the issue text, bounced files, and definition sites; a
 * well-formed verdict whose `file` names none of the candidate
 * `definitionSites` also degrades (with `rawHead`) — the judge must not
 * re-litigate the site choice the graph's band-filtered allowlist already
 * made — while an empty `definitionSites` list leaves the judge's file
 * choice unchecked.
 *
 * The `hubDesignDispatch` wiring in prompt.ts (the reasoner-tier dispatch
 * the hub-shopping trigger calls) is an Effect-generator closure over
 * turn-loop state (sessionID, sessions, lastUser, the per-turn
 * `hubDesignPrepassPlanted` flag) — not practical to unit test in isolation
 * here, same as `dispatchPinnedReproFidelity` in repro-fidelity-judge.test.ts.
 */

import { describe, test, expect } from "bun:test"
import {
  parseHubDesignResponse,
  runHubDesignJudge,
  DEGRADED_HUB_DESIGN,
  type HubDesignComplete,
} from "../../src/session/hub-design-judge"
import { HUB_DESIGN_SYSTEM_PROMPT } from "../../src/session/prompts/judges"

describe("parseHubDesignResponse", () => {
  test("a clean verdict parses", () => {
    const raw = JSON.stringify({
      file: "django/forms/widgets.py",
      entity: "Widget.value_from_datadict",
      change: "coerce the value at the source, not at the caller",
    })
    expect(parseHubDesignResponse(raw)).toEqual({
      file: "django/forms/widgets.py",
      entity: "Widget.value_from_datadict",
      change: "coerce the value at the source, not at the caller",
    })
  })

  test("a fenced JSON block parses", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ file: "a.py", entity: "Foo", change: "fix it there" }) +
      "\n```"
    expect(parseHubDesignResponse(raw)).toEqual({ file: "a.py", entity: "Foo", change: "fix it there" })
  })

  test("trailing prose after the JSON object is tolerated", () => {
    const raw = `${JSON.stringify({ file: "a.py", entity: "Foo", change: "fix it there" })}\n\nLet me know if you need more.`
    expect(parseHubDesignResponse(raw)).toEqual({ file: "a.py", entity: "Foo", change: "fix it there" })
  })

  test("a missing field fails validation", () => {
    const raw = JSON.stringify({ file: "a.py", entity: "Foo" })
    expect(parseHubDesignResponse(raw)).toBeNull()
  })

  test("a blank field fails validation", () => {
    const raw = JSON.stringify({ file: "  ", entity: "Foo", change: "fix it there" })
    expect(parseHubDesignResponse(raw)).toBeNull()
  })

  test("malformed JSON fails validation", () => {
    expect(parseHubDesignResponse("{not valid json")).toBeNull()
  })

  test("no JSON object at all fails validation", () => {
    expect(parseHubDesignResponse("I cannot decide this.")).toBeNull()
  })

  test("empty raw text fails validation", () => {
    expect(parseHubDesignResponse("")).toBeNull()
  })

  test("JSON preceded by long reasoning prose parses", () => {
    const reasoning =
      "Let me think through this step by step. First, the issue mentions Field rendering its value incorrectly. " +
      "The widget.attrs dict is populated from the field's formfield() method, so the type coercion must happen there " +
      "rather than at the template layer. Looking at the definition sites, Field.formfield is the root-most site. " +
      "I'll answer with that.\n\n"
    const raw =
      reasoning +
      JSON.stringify({ file: "django/db/models/fields/__init__.py", entity: "Field.formfield", change: "cast to int" })
    expect(parseHubDesignResponse(raw)).toEqual({
      file: "django/db/models/fields/__init__.py",
      entity: "Field.formfield",
      change: "cast to int",
    })
  })

  test("JSON inside a ```json fence at the end of a reasoning tail parses", () => {
    const raw =
      "Reasoning about the fix first...\n\n" +
      "```json\n" +
      JSON.stringify({ file: "a.py", entity: "Foo", change: "fix it there" }) +
      "\n```"
    expect(parseHubDesignResponse(raw)).toEqual({ file: "a.py", entity: "Foo", change: "fix it there" })
  })

  test("two JSON objects — the last one wins", () => {
    const raw =
      JSON.stringify({ file: "wrong.py", entity: "Wrong", change: "a discarded first attempt" }) +
      "\n\nActually, re-checking the graph evidence, the real defining module is different:\n\n" +
      JSON.stringify({ file: "right.py", entity: "Right", change: "the actual final answer" })
    expect(parseHubDesignResponse(raw)).toEqual({ file: "right.py", entity: "Right", change: "the actual final answer" })
  })
})

describe("runHubDesignJudge", () => {
  const issueText = "The bug is in how Field renders its value — `widget.attrs['maxlength']` should be an int."
  const bouncedFiles = ["django/db/models/base.py", "django/forms/widgets.py"]
  const definitionSites = [
    { symbol: "Field", kind: "class", file: "django/db/models/fields/__init__.py" },
    { symbol: "widget.attrs", kind: "variable", file: "django/forms/widgets.py" },
  ]

  test("a well-formed verdict is returned as-is", async () => {
    const complete: HubDesignComplete = async () =>
      JSON.stringify({ file: "django/db/models/fields/__init__.py", entity: "Field.formfield", change: "cast to int before assigning attrs" })
    const result = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete })
    expect(result.verdict).toEqual({
      file: "django/db/models/fields/__init__.py",
      entity: "Field.formfield",
      change: "cast to int before assigning attrs",
    })
    expect(result.rawHead).toBeUndefined()
  })

  test("malformed LLM output degrades to DEGRADED_HUB_DESIGN with rawHead present", async () => {
    const complete: HubDesignComplete = async () => "{not valid json"
    const result = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete })
    expect(result.verdict).toEqual(DEGRADED_HUB_DESIGN)
    expect(result.rawHead).toBe("{not valid json")
  })

  test("garbage prose with no JSON degrades to DEGRADED_HUB_DESIGN with rawHead present", async () => {
    const complete: HubDesignComplete = async () => "I cannot decide this."
    const result = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete })
    expect(result.verdict).toEqual(DEGRADED_HUB_DESIGN)
    expect(result.rawHead).toBe("I cannot decide this.")
  })

  test("a very long degraded response is truncated to 200 chars in rawHead", async () => {
    const longRaw = "x".repeat(500)
    const complete: HubDesignComplete = async () => longRaw
    const result = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete })
    expect(result.verdict).toEqual(DEGRADED_HUB_DESIGN)
    expect(result.rawHead).toBe(longRaw.slice(0, 200))
    expect(result.rawHead?.length).toBe(200)
  })

  test("a thrown completion degrades to DEGRADED_HUB_DESIGN with no rawHead", async () => {
    const complete: HubDesignComplete = async () => {
      throw new Error("provider unavailable")
    }
    const result = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete })
    expect(result.verdict).toEqual(DEGRADED_HUB_DESIGN)
    expect(result.rawHead).toBeUndefined()
  })

  test("the completion request carries the issue text, bounced files, and definition sites", async () => {
    let seenUser = ""
    let seenSystem = ""
    const complete: HubDesignComplete = async ({ system, user }) => {
      seenSystem = system
      seenUser = user
      return JSON.stringify({ file: "a.py", entity: "Foo", change: "fix it there" })
    }
    await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete })
    expect(seenSystem).toBe(HUB_DESIGN_SYSTEM_PROMPT)
    expect(seenUser).toContain(issueText)
    for (const file of bouncedFiles) expect(seenUser).toContain(file)
    for (const site of definitionSites) {
      expect(seenUser).toContain(site.symbol)
      expect(seenUser).toContain(site.kind)
      expect(seenUser).toContain(site.file)
    }
  })

  test("empty definition sites still produce a valid prompt", async () => {
    let seenUser = ""
    const complete: HubDesignComplete = async ({ user }) => {
      seenUser = user
      return JSON.stringify({ file: "a.py", entity: "Foo", change: "fix it there" })
    }
    await runHubDesignJudge({ issueText, bouncedFiles, definitionSites: [], complete })
    expect(seenUser).toContain("(none found)")
  })

  test("a verdict naming a file outside the candidate definition sites degrades, with rawHead", async () => {
    const raw = JSON.stringify({ file: "django/db/models/query_utils.py", entity: "Q", change: "wrong layer" })
    const complete: HubDesignComplete = async () => raw
    const result = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete })
    expect(result.verdict).toEqual(DEGRADED_HUB_DESIGN)
    expect(result.rawHead).toBe(raw.slice(0, 200))
  })

  test("the same out-of-list file is delivered as-is when definitionSites is empty", async () => {
    const complete: HubDesignComplete = async () =>
      JSON.stringify({ file: "django/db/models/query_utils.py", entity: "Q", change: "free choice" })
    const result = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites: [], complete })
    expect(result.verdict).toEqual({
      file: "django/db/models/query_utils.py",
      entity: "Q",
      change: "free choice",
    })
    expect(result.rawHead).toBeUndefined()
  })

  test("a verdict naming a listed site — relative exact match or path-boundary-suffix form — is delivered as-is", async () => {
    const exact: HubDesignComplete = async () =>
      JSON.stringify({ file: "django/forms/widgets.py", entity: "Widget", change: "fix render" })
    const exactResult = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete: exact })
    expect(exactResult.verdict).toEqual({ file: "django/forms/widgets.py", entity: "Widget", change: "fix render" })
    expect(exactResult.rawHead).toBeUndefined()

    const suffix: HubDesignComplete = async () =>
      JSON.stringify({ file: "/repo/django/forms/widgets.py", entity: "Widget", change: "fix render" })
    const suffixResult = await runHubDesignJudge({ issueText, bouncedFiles, definitionSites, complete: suffix })
    expect(suffixResult.verdict).toEqual({ file: "/repo/django/forms/widgets.py", entity: "Widget", change: "fix render" })
    expect(suffixResult.rawHead).toBeUndefined()
  })
})

describe("HUB_DESIGN_SYSTEM_PROMPT", () => {
  test("forbids coercions/conversions at consumption or assignment sites", () => {
    expect(HUB_DESIGN_SYSTEM_PROMPT).toContain("NOT acceptable answers")
    expect(HUB_DESIGN_SYSTEM_PROMPT.toLowerCase()).toContain("coercions/conversions/wrappers at consumption or assignment sites")
  })

  test("asks for the ROOT-MOST fix site as strict JSON", () => {
    expect(HUB_DESIGN_SYSTEM_PROMPT).toContain("ROOT-MOST fix site")
    expect(HUB_DESIGN_SYSTEM_PROMPT).toContain('"file"')
    expect(HUB_DESIGN_SYSTEM_PROMPT).toContain('"entity"')
    expect(HUB_DESIGN_SYSTEM_PROMPT).toContain('"change"')
  })

  test("instructs the model to end with the JSON object on its own final line", () => {
    expect(HUB_DESIGN_SYSTEM_PROMPT).toContain("End your response with the JSON object on its own final line.")
  })
})
