import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractEdges, extractEntities } from "../src/ast-extractor"

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

// I2 — CommonJS require() import bindings (express-era Node code uses require,
// not ES import; without this the indexer registered zero import bindings and
// dropped every cross-file call edge in CommonJS repos).
describe("extractEdges — CommonJS require() bindings", () => {
  test("named destructuring require: import edge + cross-file call edge", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-cjs-"))
    writeFileSync(join(dir, "core.js"), "module.exports.validateEntry = function (x) { return x }\n")
    const callerFile = join(dir, "caller.js")
    const src = [
      'const { validateEntry } = require("./core")',
      "",
      "function run(x) {",
      "  return validateEntry(x);",
      "}",
    ].join("\n")
    const entities = extractEntities(src, callerFile)
    const edges = extractEdges(src, callerFile, entities)
    const expectedToFile = join(dir, "core.js")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "validateEntry")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    const callEdge = edges.find((e) => e.kind === "call" && e.toEntity === "validateEntry")
    expect(callEdge).toBeDefined()
    expect(callEdge?.fromEntity).toBe("run")
    expect(callEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("named destructuring with rename: call resolves via local name, import edge keeps source name", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-cjs-"))
    writeFileSync(join(dir, "core.js"), "module.exports.validateEntry = function (x) { return x }\n")
    const callerFile = join(dir, "caller.js")
    const src = [
      'const { validateEntry: ve } = require("./core")',
      "",
      "function run(x) {",
      "  return ve(x);",
      "}",
    ].join("\n")
    const entities = extractEntities(src, callerFile)
    const edges = extractEdges(src, callerFile, entities)
    const expectedToFile = join(dir, "core.js")

    const importEdge = edges.find((e) => e.kind === "import")
    expect(importEdge?.toEntity).toBe("validateEntry")
    expect(importEdge?.toFile).toBe(expectedToFile)

    const callEdge = edges.find((e) => e.kind === "call")
    expect(callEdge?.toEntity).toBe("ve")
    expect(callEdge?.fromEntity).toBe("run")
    expect(callEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("whole-module require: property-call resolves through the local binding", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-cjs-"))
    writeFileSync(join(dir, "core.js"), "module.exports.validateEntry = function (x) { return x }\n")
    const callerFile = join(dir, "caller.js")
    const src = [
      'var core = require("./core")',
      "",
      "function run(x) {",
      "  return core.validateEntry(x);",
      "}",
    ].join("\n")
    const entities = extractEntities(src, callerFile)
    const edges = extractEdges(src, callerFile, entities)
    const expectedToFile = join(dir, "core.js")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "core")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    const callEdge = edges.find((e) => e.kind === "call" && e.toEntity === "validateEntry")
    expect(callEdge).toBeDefined()
    expect(callEdge?.fromEntity).toBe("run")
    expect(callEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("indented require inside a function body still registers (lazy in-function require idiom)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-cjs-"))
    writeFileSync(join(dir, "core.js"), "module.exports.validateEntry = function (x) { return x }\n")
    const callerFile = join(dir, "caller.js")
    const src = [
      "function run(x) {",
      '  const { validateEntry } = require("./core")',
      "  return validateEntry(x);",
      "}",
    ].join("\n")
    const entities = extractEntities(src, callerFile)
    const edges = extractEdges(src, callerFile, entities)
    const expectedToFile = join(dir, "core.js")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "validateEntry")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("external module require: null toFile import edge, and no call edge (unresolved)", () => {
    const callerFile = join(tmpdir(), "ast-extractor-cjs-external-caller.js")
    const src = [
      'const fs = require("fs")',
      "",
      "function run(p) {",
      "  return fs.readFileSync(p);",
      "}",
    ].join("\n")
    const entities = extractEntities(src, callerFile)
    const edges = extractEdges(src, callerFile, entities)

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "fs")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBeNull()

    const callEdge = edges.find((e) => e.kind === "call" && e.toEntity === "readFileSync")
    expect(callEdge).toBeUndefined()
  })
})

// Wave 5 — Python import resolution (relative dot-hops, absolute dotted
// against the importing file's source root, submodule-from-package, plain
// `import`, and external/stdlib modules staying unresolved).
describe("extractEdges — Python import resolution", () => {
  test("relative import, one dot: from .base import Model resolves within the same package dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "__init__.py"), "")
    writeFileSync(join(dir, "pkg", "base.py"), "class Model:\n    pass\n")
    const modFile = join(dir, "pkg", "mod.py")
    const src = "from .base import Model\n"
    const edges = extractEdges(src, modFile)
    const expectedToFile = join(dir, "pkg", "base.py")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "Model")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("relative import, two dots: from ..base import Model walks up one package level", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "__init__.py"), "")
    writeFileSync(join(dir, "pkg", "base.py"), "class Model:\n    pass\n")
    mkdirSync(join(dir, "pkg", "sub"))
    writeFileSync(join(dir, "pkg", "sub", "__init__.py"), "")
    const modFile = join(dir, "pkg", "sub", "mod.py")
    const src = "from ..base import Model\n"
    const edges = extractEdges(src, modFile)
    const expectedToFile = join(dir, "pkg", "base.py")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "Model")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("absolute dotted intra-package: from pkg.base import Model resolves against the source root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "__init__.py"), "")
    writeFileSync(join(dir, "pkg", "base.py"), "class Model:\n    pass\n")
    mkdirSync(join(dir, "pkg", "sub"))
    writeFileSync(join(dir, "pkg", "sub", "__init__.py"), "")
    const modFile = join(dir, "pkg", "sub", "mod.py")
    const src = "from pkg.base import Model\n"
    const edges = extractEdges(src, modFile)
    const expectedToFile = join(dir, "pkg", "base.py")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "Model")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("submodule-from-package: from pkg import base resolves to the submodule file, not the package __init__", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "__init__.py"), "")
    writeFileSync(join(dir, "pkg", "base.py"), "class Model:\n    pass\n")
    const callerFile = join(dir, "caller.py")
    const src = "from pkg import base\n"
    const edges = extractEdges(src, callerFile)
    const expectedToFile = join(dir, "pkg", "base.py")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "base")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("plain import x.y binds the final segment and resolves it against the source root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "__init__.py"), "")
    writeFileSync(join(dir, "pkg", "base.py"), "class Model:\n    pass\n")
    const callerFile = join(dir, "caller.py")
    const src = "import pkg.base\n"
    const edges = extractEdges(src, callerFile)
    const expectedToFile = join(dir, "pkg", "base.py")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "base")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("external stdlib module: import os stays unresolved (null toFile)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    const callerFile = join(dir, "caller.py")
    const src = "import os\n"
    const edges = extractEdges(src, callerFile)

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "os")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBeNull()

    rmSync(dir, { recursive: true, force: true })
  })
})
