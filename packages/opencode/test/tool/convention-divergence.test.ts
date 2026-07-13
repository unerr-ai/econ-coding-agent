/**
 * detectReceiverMethodDivergence: the wave-11 stage-1 pure helper — fires the
 * one bounded rescan when added code extends an established receiver's usage
 * surface with a method the file never called (django-11848 A4 red shape),
 * language-agnostic (py/rb/sh `#` comments, ts/js/java/go/c-family `//`
 * comments, self/cls/this receivers universally excluded).
 */

import { describe, it, expect } from "bun:test"
import { detectReceiverMethodDivergence } from "../../src/tool/convention-divergence"

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
