/**
 * detectReceiverMethodDivergence: the wave-11 stage-1 pure helper — fires the
 * one bounded rescan when added code extends an established receiver's usage
 * surface with a method the file never called (A4 red shape),
 * language-agnostic (py/rb/sh `#` comments, ts/js/java/go/c-family `//`
 * comments, self/cls/this receivers universally excluded).
 */

import { describe, it, expect } from "bun:test"
import {
  detectReceiverMethodDivergence,
  detectFamilyConflictEvidence,
  SEMANTIC_METHOD_FAMILIES,
  addedLines,
  evaluateConventionDivergenceGate,
  shouldDenyConventionDivergence,
  hasDeniedConventionDivergence,
  markConventionDivergenceDenied,
  hasDeniedConventionDivergenceSecond,
  markConventionDivergenceDeniedSecond,
} from "../../src/tool/convention-divergence"
import { conventionDivergenceNudgeText, conventionDivergenceSecondDenyNudgeText } from "../../src/session/prompts/nudges"

describe("detectReceiverMethodDivergence", () => {
  it("before has datetime.datetime(...), added has datetime.datetime.now( — FIRES with receiverSites", () => {
    const beforeContent = [
      "import datetime",
      "",
      "def parse_http_date(date):",
      "    epoch = datetime.datetime(1970, 1, 1)",
      "    return epoch",
    ].join("\n")
    const addedText = "    current_year = datetime.datetime.now().year"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).not.toBeNull()
    expect(out?.receiver).toBe("datetime.datetime")
    expect(out?.method).toBe("now")
    expect(out?.receiverSites).toEqual([4])
  })

  it("TS/JS shape: before has path.join(...), added has path.resolve( — FIRES with receiverSites", () => {
    const beforeContent = ["import path from 'path'", "", "const p = path.join(root, 'a', 'b')"].join("\n")
    const addedText = "const r = path.resolve(root, 'c')"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).not.toBeNull()
    expect(out?.receiver).toBe("path")
    expect(out?.method).toBe("resolve")
    expect(out?.receiverSites).toEqual([3])
  })

  it("silent: this.foo( in added text (receiver stop-list)", () => {
    const beforeContent = "class X {\n  bar() { return this.baz() }\n}"
    const addedText = "  method() { return this.foo() }"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })

  it("silent: R.m( already present in before", () => {
    const beforeContent = [
      "import datetime",
      "def f():",
      "    a = datetime.datetime(1970, 1, 1)",
      "    b = datetime.datetime.now()",
    ].join("\n")
    const addedText = "    c = datetime.datetime.now()"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })

  it("silent: receiver absent from before (brand-new receiver)", () => {
    const beforeContent = "def f():\n    return 1"
    const addedText = "    return newthing.doStuff()"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })

  it("silent: self. receiver excluded", () => {
    const beforeContent = "class Foo:\n    def bar(self):\n        return self.baz()"
    const addedText = "        return self.quux()"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })

  it("silent: cls. receiver excluded", () => {
    const beforeContent = "class Foo:\n    @classmethod\n    def bar(cls):\n        return cls.baz()"
    const addedText = "        return cls.quux()"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })

  it("silent: method name shorter than 3 chars", () => {
    const beforeContent = "import datetime\ndef f():\n    a = datetime.datetime(1970, 1, 1)"
    const addedText = "    b = datetime.datetime.go()"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })

  it("silent: added text has no dotted calls", () => {
    const beforeContent = "import datetime\ndef f():\n    a = datetime.datetime(1970, 1, 1)"
    const addedText = "    result = compute()"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })

  it("comment-line receiver uses in before don't count as receiverSites (# and //)", () => {
    const beforeContent = [
      "import datetime",
      "def f():",
      "    # datetime.datetime(1970, 1, 1) — example only",
      "    // datetime.datetime(1970, 1, 1) — example only",
      "    return None",
    ].join("\n")
    const addedText = "    current_year = datetime.datetime.now().year"

    const out = detectReceiverMethodDivergence({ beforeContent, addedText })
    expect(out).toBeNull()
  })
})

// -- wave 11 stage 2: addedLines ---------------------------------------------

describe("addedLines", () => {
  it("returns only the lines new to `after`, preserving order", () => {
    const before = ["a", "b", "c"].join("\n")
    const after = ["a", "b", "c", "d", "e"].join("\n")
    expect(addedLines(before, after)).toBe("d\ne")
  })

  it("a line removed and re-added elsewhere is not counted as added", () => {
    const before = ["a", "b"].join("\n")
    const after = ["b", "a"].join("\n")
    expect(addedLines(before, after)).toBe("")
  })

  it("empty before: every line in after is added", () => {
    expect(addedLines("", "x\ny")).toBe("x\ny")
  })
})

// -- wave 11 stage 2: evaluateConventionDivergenceGate / shouldDenyConventionDivergence --

describe("shouldDenyConventionDivergence", () => {
  const divergence = { receiver: "datetime.datetime", method: "now", receiverSites: [4] }
  const base = { armed: true, isTestPath: false, isNewFile: false, divergence, alreadyDenied: false }

  it("denies once: armed, non-test, existing file, a divergence, not yet denied", () => {
    expect(shouldDenyConventionDivergence(base)).toBe(true)
    expect(evaluateConventionDivergenceGate(base)).toBe("deny")
  })

  it("an already-denied session never denies again — passes on retry instead", () => {
    expect(shouldDenyConventionDivergence({ ...base, alreadyDenied: true })).toBe(false)
    expect(evaluateConventionDivergenceGate({ ...base, alreadyDenied: true })).toBe("pass-retry")
  })

  it("a test-like path never denies", () => {
    expect(shouldDenyConventionDivergence({ ...base, isTestPath: true })).toBe(false)
    expect(evaluateConventionDivergenceGate({ ...base, isTestPath: true })).toBe("silent")
  })

  it("brand-new file creation never denies", () => {
    expect(shouldDenyConventionDivergence({ ...base, isNewFile: true })).toBe(false)
    expect(evaluateConventionDivergenceGate({ ...base, isNewFile: true })).toBe("silent")
  })

  it("an unarmed session never denies", () => {
    expect(shouldDenyConventionDivergence({ ...base, armed: false })).toBe(false)
    expect(evaluateConventionDivergenceGate({ ...base, armed: false })).toBe("silent")
  })

  it("no divergence detected never denies", () => {
    expect(shouldDenyConventionDivergence({ ...base, divergence: null })).toBe(false)
    expect(evaluateConventionDivergenceGate({ ...base, divergence: null })).toBe("silent")
  })
})

// -- round-F §7 stage 3: evaluateConventionDivergenceGate's evidence-bearing second rung --

describe("evaluateConventionDivergenceGate / shouldDenyConventionDivergence — round-F second rung", () => {
  const divergence = { receiver: "datetime.datetime", method: "now", receiverSites: [4] }
  const retryBase = { armed: true, isTestPath: false, isNewFile: false, divergence, alreadyDenied: true }
  const callEvidence = { family: "time/tz", kind: "call" as const, member: "utcnow", lines: [7] }

  it("alreadyDenied + family evidence present + not yet second-denied → deny-second", () => {
    expect(evaluateConventionDivergenceGate({ ...retryBase, familyEvidence: callEvidence })).toBe("deny-second")
    expect(shouldDenyConventionDivergence({ ...retryBase, familyEvidence: callEvidence })).toBe(true)
  })

  it("no familyEvidence (no family match or no opposite-member evidence) → pass-retry, exactly as before round F", () => {
    expect(evaluateConventionDivergenceGate({ ...retryBase, familyEvidence: null })).toBe("pass-retry")
    expect(evaluateConventionDivergenceGate(retryBase)).toBe("pass-retry")
    expect(shouldDenyConventionDivergence({ ...retryBase, familyEvidence: null })).toBe(false)
  })

  it("familyEvidence present but the second deny is already spent → pass-retry (third+ attempt, fail-open)", () => {
    expect(
      evaluateConventionDivergenceGate({ ...retryBase, familyEvidence: callEvidence, alreadyDeniedSecond: true }),
    ).toBe("pass-retry")
  })

  it("familyEvidence is irrelevant before the first deny — the FIRST attempt always denies plain", () => {
    expect(
      evaluateConventionDivergenceGate({ ...retryBase, alreadyDenied: false, familyEvidence: callEvidence }),
    ).toBe("deny")
  })
})

// -- round-F §7 stage 3: hasDeniedConventionDivergenceSecond / markConventionDivergenceDeniedSecond --

describe("hasDeniedConventionDivergenceSecond / markConventionDivergenceDeniedSecond", () => {
  it("a fresh session has not spent its second deny; marking it flips the flag for that session only", () => {
    const sessionA = "conv-div-second-store-session-a"
    const sessionB = "conv-div-second-store-session-b"
    expect(hasDeniedConventionDivergenceSecond(sessionA)).toBe(false)
    markConventionDivergenceDeniedSecond(sessionA)
    expect(hasDeniedConventionDivergenceSecond(sessionA)).toBe(true)
    expect(hasDeniedConventionDivergenceSecond(sessionB)).toBe(false)
  })
})

// -- round-F §7 stage 3: SEMANTIC_METHOD_FAMILIES / detectFamilyConflictEvidence --

describe("SEMANTIC_METHOD_FAMILIES", () => {
  it("the first family is time/tz with now/utcnow/localtime/today", () => {
    expect(SEMANTIC_METHOD_FAMILIES["time/tz"]).toEqual(["now", "utcnow", "localtime", "today"])
  })
})

describe("detectFamilyConflictEvidence", () => {
  it("null when the method isn't in any known family", () => {
    const out = detectFamilyConflictEvidence({
      beforeContent: "import path\nconst p = path.join(root, 'a')",
      receiver: "path",
      method: "resolve",
    })
    expect(out).toBeNull()
  })

  it("call evidence: another family member already called on the same receiver (utcnow beside now)", () => {
    const beforeContent = [
      "import datetime",
      "def parse_http_date(date):",
      "    epoch = datetime.datetime.utcnow()",
      "    return epoch",
    ].join("\n")
    const out = detectFamilyConflictEvidence({ beforeContent, receiver: "datetime.datetime", method: "now" })
    expect(out).not.toBeNull()
    expect(out?.family).toBe("time/tz")
    expect(out?.kind).toBe("call")
    expect(out?.member).toBe("utcnow")
    expect(out?.lines).toEqual([3])
  })

  it('docstring evidence: "UTC" inside a multi-line docstring body (not the opening-quote line) when no opposite-member call exists', () => {
    const beforeContent = [
      "import datetime",
      "def parse_http_date(date):",
      '    """',
      "    Parse an HTTP date.",
      "",
      "    Return an integer expressed in seconds since the epoch, in UTC.",
      '    """',
      "    epoch = datetime.datetime(1970, 1, 1)",
      "    return epoch",
    ].join("\n")
    const out = detectFamilyConflictEvidence({ beforeContent, receiver: "datetime.datetime", method: "now" })
    expect(out).not.toBeNull()
    expect(out?.family).toBe("time/tz")
    expect(out?.kind).toBe("docstring")
    expect(out?.token).toBe("UTC")
  })

  it('a bare "UTC" appearing only in plain (non-comment, non-docstring) code is NOT evidence', () => {
    const beforeContent = [
      "import datetime",
      "def f():",
      "    UTC_LABEL = 'not a docstring'",
      "    epoch = datetime.datetime(1970, 1, 1)",
      "    return epoch",
    ].join("\n")
    const out = detectFamilyConflictEvidence({ beforeContent, receiver: "datetime.datetime", method: "now" })
    expect(out).toBeNull()
  })

  it("no evidence at all (family match, but no opposite-member call and no UTC token) → null", () => {
    const beforeContent = [
      "import datetime",
      "def f():",
      "    epoch = datetime.datetime(1970, 1, 1)",
      "    return epoch",
    ].join("\n")
    const out = detectFamilyConflictEvidence({ beforeContent, receiver: "datetime.datetime", method: "now" })
    expect(out).toBeNull()
  })
})

// -- wave 11 stage 2: per-session store --------------------------------------

describe("hasDeniedConventionDivergence / markConventionDivergenceDenied", () => {
  it("a fresh session has not been denied; marking it flips the flag for that session only", () => {
    const sessionA = "conv-div-store-session-a"
    const sessionB = "conv-div-store-session-b"
    expect(hasDeniedConventionDivergence(sessionA)).toBe(false)
    markConventionDivergenceDenied(sessionA)
    expect(hasDeniedConventionDivergence(sessionA)).toBe(true)
    expect(hasDeniedConventionDivergence(sessionB)).toBe(false)
  })
})

// -- wave 11 stage 2: conventionDivergenceNudgeText --------------------------

describe("conventionDivergenceNudgeText", () => {
  it("names the receiver, method, and receiver sites — never an alternative", () => {
    const text = conventionDivergenceNudgeText("datetime.datetime", "now", [4])
    expect(text).toContain("datetime.datetime.now(")
    expect(text).toContain("datetime.datetime")
    expect(text).toContain("line(s) 4")
    expect(text).toContain("fires once per task")
    expect(text).toContain("an identical retry will be accepted")
  })
})

// -- round-F §7 stage 3: conventionDivergenceSecondDenyNudgeText --

describe("conventionDivergenceSecondDenyNudgeText", () => {
  it("quotes the opposite-member call-site line numbers verbatim for call evidence", () => {
    const text = conventionDivergenceSecondDenyNudgeText("datetime.datetime", "now", {
      family: "time/tz",
      kind: "call",
      member: "utcnow",
      lines: [3],
    })
    expect(text).toContain("datetime.datetime.utcnow(")
    expect(text).toContain("line(s) 3")
    expect(text).toContain("An identical retry after this second pause will be accepted")
  })

  it("quotes the docstring token verbatim for docstring evidence", () => {
    const text = conventionDivergenceSecondDenyNudgeText("datetime.datetime", "now", {
      family: "time/tz",
      kind: "docstring",
      token: "UTC",
    })
    expect(text).toContain('"UTC"')
    expect(text).toContain("An identical retry after this second pause will be accepted")
  })
})
