/**
 * Tests for roundtrip-witness.ts (H1 tooth 2, gap-closure-plan §2.7):
 * `findRoundtripCounterpart`'s pure name-pairing over the live failure
 * shapes (parse-only, inverted unescape, param-never-threaded) and
 * `synthesizeRoundtripWitness`'s graph-stub
 * wiring (never throws, degrades to undefined on a graph error).
 */
import { describe, test, expect } from "bun:test"
import {
  findRoundtripCounterpart,
  synthesizeRoundtripWitness,
  type EntityNameSource,
} from "../../src/session/roundtrip-witness"

describe("findRoundtripCounterpart", () => {
  test("parse-only shape: parse_date pairs with format_date (parse<->format)", () => {
    expect(findRoundtripCounterpart("parse_date", ["parse_date", "format_date", "validate_date"])).toBe(
      "format_date",
    )
  })

  test("parse also pairs with serialize when both are present", () => {
    expect(findRoundtripCounterpart("parse_config", ["parse_config", "serialize_config"])).toBe("serialize_config")
  })

  test("inverted-unescape shape: escape_html pairs with unescape_html", () => {
    expect(findRoundtripCounterpart("escape_html", ["escape_html", "unescape_html", "strip_tags"])).toBe(
      "unescape_html",
    )
  })

  test("param-never-threaded shape: read_config pairs with write_config", () => {
    expect(findRoundtripCounterpart("read_config", ["read_config", "write_config"])).toBe("write_config")
  })

  test("camelCase and dotted (Class.method) names pair the same way", () => {
    expect(findRoundtripCounterpart("Widget.parse", ["Widget.parse", "Widget.serialize"])).toBe("Widget.serialize")
    expect(findRoundtripCounterpart("loadState", ["loadState", "dumpState"])).toBe("dumpState")
  })

  test("no relation word in the focus name yields undefined", () => {
    expect(findRoundtripCounterpart("compute_total", ["parse_date", "format_date"])).toBeUndefined()
  })

  test("a relation word present but no matching stem yields undefined (precision over recall)", () => {
    expect(findRoundtripCounterpart("parse_date", ["serialize_time"])).toBeUndefined()
  })

  test("the focus name itself is excluded from matching against itself", () => {
    expect(findRoundtripCounterpart("parse_date", ["parse_date"])).toBeUndefined()
  })

  test("no siblings at all yields undefined", () => {
    expect(findRoundtripCounterpart("parse_date", [])).toBeUndefined()
  })
})

describe("synthesizeRoundtripWitness", () => {
  test("resolves the counterpart from the graph's file siblings", async () => {
    const graph: EntityNameSource = {
      getEntitiesInFile: async () => [{ name: "escape_html" }, { name: "unescape_html" }],
    }
    expect(await synthesizeRoundtripWitness(graph, "escape_html", "util.py")).toBe("unescape_html")
  })

  test("a graph error degrades to undefined, never throws", async () => {
    const graph: EntityNameSource = {
      getEntitiesInFile: async () => {
        throw new Error("db closed")
      },
    }
    expect(await synthesizeRoundtripWitness(graph, "escape_html", "util.py")).toBeUndefined()
  })

  test("no counterpart present yields undefined", async () => {
    const graph: EntityNameSource = {
      getEntitiesInFile: async () => [{ name: "escape_html" }],
    }
    expect(await synthesizeRoundtripWitness(graph, "escape_html", "util.py")).toBeUndefined()
  })
})
