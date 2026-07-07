import { describe, expect, test } from "bun:test"
import { extractEntities } from "../src/ast-extractor"

// I1 — assignment-style definitions (the classic-JS idiom the express decode
// showed the indexer was blind to: 55 entities repo-wide, 2 in lib/response.js).
describe("extractEntities — assignment-style definitions", () => {
  test("named function expression on a plain receiver: res.send = function send(body)", () => {
    const src = [
      "var res = Object.create(http.ServerResponse.prototype)",
      "",
      "res.send = function send(body) {",
      "  var chunk = body;",
      "  return this;",
      "}",
    ].join("\n")
    const entities = extractEntities(src, "lib/response.js")
    const send = entities.find((e) => e.name === "res.send")
    expect(send).toBeDefined()
    expect(send?.kind).toBe("method")
    expect(send?.parentClass).toBe("res")
    expect(send?.signature).toBe("(body)")
  })

  test("prototype assignment collapses to the class: Foo.prototype.bar", () => {
    const src = ["function Foo() {}", "", "Foo.prototype.bar = function () {", "  return 1;", "}"].join("\n")
    const entities = extractEntities(src, "lib/foo.js")
    const bar = entities.find((e) => e.name === "Foo.bar")
    expect(bar).toBeDefined()
    expect(bar?.parentClass).toBe("Foo")
  })

  test("CommonJS export receivers are wrappers, not parents", () => {
    const src = [
      "exports.parse = function parse(input) {",
      "  return input;",
      "}",
      "",
      "module.exports.init = async function (opts) {",
      "  return opts;",
      "}",
    ].join("\n")
    const entities = extractEntities(src, "lib/parser.js")
    const parse = entities.find((e) => e.name === "parse")
    expect(parse).toBeDefined()
    expect(parse?.parentClass).toBeUndefined()
    const init = entities.find((e) => e.name === "init")
    expect(init).toBeDefined()
    expect(init?.parentClass).toBeUndefined()
  })

  test("arrow-function assignment: api.fetchUser = async (id) =>", () => {
    const src = ["api.fetchUser = async (id) => {", "  return db.get(id);", "}"].join("\n")
    const entities = extractEntities(src, "src/api.js")
    const fetchUser = entities.find((e) => e.name === "api.fetchUser")
    expect(fetchUser).toBeDefined()
    expect(fetchUser?.kind).toBe("method")
  })

  test("non-function assignments and comparisons do not index", () => {
    const src = [
      "res.locals = {}",
      "config.port = 3000",
      "a.b === c",
      "counts.total += tally(x)",
      "res.type = mime.lookup(path)",
    ].join("\n")
    const entities = extractEntities(src, "src/misc.js")
    expect(entities).toHaveLength(0)
  })

  test("existing declaration patterns are unaffected", () => {
    const src = [
      "export function top(a) {",
      "  return a;",
      "}",
      "",
      "export class Widget {",
      "  render(props) {",
      "    return props;",
      "  }",
      "}",
    ].join("\n")
    const entities = extractEntities(src, "src/widget.ts")
    expect(entities.map((e) => e.name)).toEqual(["top", "Widget", "Widget.render"])
  })
})
