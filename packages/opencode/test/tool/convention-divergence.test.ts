/**
 * detectReceiverMethodDivergence: the wave-11 stage-1 pure helper — fires the
 * one bounded rescan when added code extends an established receiver's usage
 * surface with a method the file never called (django-11848 A4 red shape),
 * language-agnostic (py/rb/sh `#` comments, ts/js/java/go/c-family `//`
 * comments, self/cls/this receivers universally excluded).
 */

import { describe, it, expect } from "bun:test"
import {
  detectReceiverMethodDivergence,
  addedLines,
  evaluateConventionDivergenceGate,
  shouldDenyConventionDivergence,
  hasDeniedConventionDivergence,
  markConventionDivergenceDenied,
} from "../../src/tool/convention-divergence"
import { conventionDivergenceNudgeText } from "../../src/session/prompts/nudges"

describe("detectReceiverMethodDivergence", () => {
  it("11848 shape: before has datetime.datetime(...), added has datetime.datetime.now( — FIRES with receiverSites", () => {
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
