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

// Wave G (G1) — generic resolver parity cases the two hand-written resolvers
// didn't previously have unit coverage for: Python's bare-relative-import and
// repoRoot/src fallback branches, and JS/TS index.* directory-import probing.
describe("extractEdges — Python resolution parity (wave G kernel)", () => {
  test("bare relative import: from . import X resolves to the package's own __init__.py", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "__init__.py"), "class Model:\n    pass\n")
    const modFile = join(dir, "pkg", "sub.py")
    const src = "from . import Model\n"
    const edges = extractEdges(src, modFile)
    const expectedToFile = join(dir, "pkg", "__init__.py")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "Model")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })

  test("repoRoot + src/ fallback: absolute dotted import resolves via repoRoot/src when the source-root walk misses", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-py-"))
    const repoRoot = join(dir, "repo")
    mkdirSync(join(repoRoot, "src", "pkg"), { recursive: true })
    writeFileSync(join(repoRoot, "src", "pkg", "target.py"), "class Target:\n    pass\n")
    // No __init__.py anywhere near the caller — the source-root walk stops
    // immediately, so only the repoRoot/src fallback can find the target.
    const callerFile = join(repoRoot, "caller.py")
    const src = "import pkg.target\n"
    const edges = extractEdges(src, callerFile, [], repoRoot)
    const expectedToFile = join(repoRoot, "src", "pkg", "target.py")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "target")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })
})

describe("extractEdges — JS/TS relative import resolution (wave G kernel)", () => {
  test("index.* probing: importing a directory with no same-name file resolves to its index file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-js-index-"))
    mkdirSync(join(dir, "utils"))
    writeFileSync(join(dir, "utils", "index.ts"), "export function helper() {}\n")
    const callerFile = join(dir, "caller.ts")
    const src = 'import { helper } from "./utils"\n'
    const edges = extractEdges(src, callerFile)
    const expectedToFile = join(dir, "utils", "index.ts")

    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "helper")
    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(expectedToFile)

    rmSync(dir, { recursive: true, force: true })
  })
})

// Wave G — generic per-language import EXTRACTION + RESOLUTION for the five
// languages that previously produced zero import edges. `toEntity` stores
// the FULL specifier (G3, not just its last segment); each row now also
// has resolution data, so a same-repo specifier resolves at extraction
// time via the same generic `resolveGenericImport` kernel JS/TS/Python use
// — an external/library specifier (no on-disk match) still correctly stays
// `toFile: null`.
describe("extractEdges — Go import extraction (G3: full specifier + manifestPrefix resolution)", () => {
  test("single-line and factored import block: full specifiers extract, external packages stay unresolved", () => {
    const src = [
      "package main",
      "",
      'import "fmt"',
      "",
      "import (",
      '\t"os"',
      '\tmyalias "github.com/foo/bar"',
      ")",
      "",
      "func main() {}",
    ].join("\n")
    const edges = extractEdges(src, "caller.go")
    const importEdges = edges.filter((e) => e.kind === "import")
    const toEntities = importEdges.map((e) => e.toEntity).sort()

    expect(toEntities).toEqual(["fmt", "github.com/foo/bar", "os"])
    for (const e of importEdges) expect(e.toFile).toBeNull()
  })

  test("manifestPrefix resolution: an in-module import strips the go.mod module prefix and resolves to the package dir's representative .go file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-go-manifest-"))
    writeFileSync(join(dir, "go.mod"), "module example.com/widget\n\ngo 1.21\n")
    mkdirSync(join(dir, "sub"), { recursive: true })
    writeFileSync(join(dir, "sub", "sub.go"), "package sub\n")
    const callerFile = join(dir, "caller.go")
    const src = 'import "example.com/widget/sub"\n'
    const edges = extractEdges(src, callerFile)
    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "example.com/widget/sub")

    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(join(dir, "sub", "sub.go"))

    rmSync(dir, { recursive: true, force: true })
  })
})

describe("extractEdges — Java import extraction (G3: full specifier + source-root resolution)", () => {
  test("import and import static: full specifiers extract, external classes stay unresolved", () => {
    const src = ["import java.util.List;", "import static java.util.Map.Entry;", "", "public class Foo {}"].join("\n")
    const edges = extractEdges(src, "Caller.java")
    const importEdges = edges.filter((e) => e.kind === "import")
    const toEntities = importEdges.map((e) => e.toEntity).sort()

    expect(toEntities).toEqual(["java.util.List", "java.util.Map.Entry"])
    for (const e of importEdges) expect(e.toFile).toBeNull()
  })

  test("repoRoot/src/main/java resolution: a dotted package path resolves to its .java file under the source root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-java-srcroot-"))
    mkdirSync(join(dir, "src", "main", "java", "com", "example"), { recursive: true })
    writeFileSync(
      join(dir, "src", "main", "java", "com", "example", "Widget.java"),
      "package com.example;\npublic class Widget {}\n"
    )
    const callerFile = join(dir, "src", "main", "java", "com", "example", "Caller.java")
    const src = "import com.example.Widget;\n\npublic class Caller {}\n"
    const edges = extractEdges(src, callerFile, [], dir)
    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "com.example.Widget")

    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(join(dir, "src", "main", "java", "com", "example", "Widget.java"))

    rmSync(dir, { recursive: true, force: true })
  })
})

describe("extractEdges — Rust import extraction (G3: full specifier + marker resolution)", () => {
  test("use statements (plain, crate-relative, aliased, grouped): full specifiers extract, external crates stay unresolved", () => {
    const src = [
      "use std::collections::HashMap;",
      "use crate::module::Thing;",
      "use a::b::{c, d};",
      "use a::b::c as e;",
    ].join("\n")
    const edges = extractEdges(src, "caller.rs")
    const importEdges = edges.filter((e) => e.kind === "import")
    const toEntities = importEdges.map((e) => e.toEntity).sort()

    // Grouped `use a::b::{c, d}` emits one edge for the group path
    // ("a::b::{c, d}" -> "a::b"), not one per leaf — acceptable per spec.
    expect(toEntities).toEqual(["a::b", "a::b::c", "crate::module::Thing", "std::collections::HashMap"])
    for (const e of importEdges) expect(e.toFile).toBeNull()
  })

  test("self:: resolves within the same directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-rust-self-"))
    writeFileSync(join(dir, "sibling.rs"), "pub fn hello() {}\n")
    const callerFile = join(dir, "caller.rs")
    const src = "use self::sibling;\n"
    const edges = extractEdges(src, callerFile)
    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "self::sibling")

    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(join(dir, "sibling.rs"))

    rmSync(dir, { recursive: true, force: true })
  })

  test("super:: resolves one directory up, repeating like python's dot-hop", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-rust-super-"))
    writeFileSync(join(dir, "parent_mod.rs"), "pub fn hi() {}\n")
    mkdirSync(join(dir, "child"))
    const callerFile = join(dir, "child", "caller.rs")
    const src = "use super::parent_mod;\n"
    const edges = extractEdges(src, callerFile)
    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "super::parent_mod")

    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(join(dir, "parent_mod.rs"))

    rmSync(dir, { recursive: true, force: true })
  })

  test("crate:: resolves against the nearest src/ ancestor (rootStrategies, not a dirname hop)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-rust-crate-"))
    mkdirSync(join(dir, "src", "deep"), { recursive: true })
    writeFileSync(join(dir, "src", "lib.rs"), "pub mod deep;\n")
    const callerFile = join(dir, "src", "deep", "caller.rs")
    const src = "use crate::lib;\n"
    const edges = extractEdges(src, callerFile)
    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "crate::lib")

    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(join(dir, "src", "lib.rs"))

    rmSync(dir, { recursive: true, force: true })
  })
})

describe("extractEdges — C/C++ import extraction (G3: implicit relative + angle-external guard)", () => {
  test("quoted (relative-capable) and angle-bracket (external, fallbackEligible:false) includes: full specifiers extract", () => {
    const src = ['#include "sub/local.h"', "#include <stdio.h>", ""].join("\n")
    const edges = extractEdges(src, "caller.c")
    const importEdges = edges.filter((e) => e.kind === "import")
    const toEntities = importEdges.map((e) => e.toEntity).sort()

    expect(toEntities).toEqual(["stdio.h", "sub/local.h"])
    const quoted = importEdges.find((e) => e.toEntity === "sub/local.h")
    const angle = importEdges.find((e) => e.toEntity === "stdio.h")
    expect(quoted?.toFile).toBeNull()
    expect(quoted?.external).toBeUndefined()
    expect(angle?.toFile).toBeNull()
    expect(angle?.external).toBe(true)
  })

  test("cpp header extraction mirrors c — angle include never reaches resolution, quoted include does", () => {
    const src = ['#include "vector_utils.hpp"', "#include <vector>", ""].join("\n")
    const edges = extractEdges(src, "caller.cpp")
    const importEdges = edges.filter((e) => e.kind === "import")
    const toEntities = importEdges.map((e) => e.toEntity).sort()

    expect(toEntities).toEqual(["vector", "vector_utils.hpp"])
    const angle = importEdges.find((e) => e.toEntity === "vector")
    expect(angle?.external).toBe(true)
    expect(angle?.toFile).toBeNull()
  })

  test("quoted include resolves relative to the including file's own directory first", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-c-relative-"))
    writeFileSync(join(dir, "local.h"), "#pragma once\n")
    const callerFile = join(dir, "caller.c")
    const src = '#include "local.h"\n'
    const edges = extractEdges(src, callerFile)
    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "local.h")

    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(join(dir, "local.h"))

    rmSync(dir, { recursive: true, force: true })
  })

  test("quoted include falls through to repoRoot/include when not found next to the including file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-extractor-c-fallthrough-"))
    mkdirSync(join(dir, "include"), { recursive: true })
    writeFileSync(join(dir, "include", "shared.h"), "#pragma once\n")
    mkdirSync(join(dir, "src"))
    const callerFile = join(dir, "src", "caller.c")
    const src = '#include "shared.h"\n'
    const edges = extractEdges(src, callerFile, [], dir)
    const importEdge = edges.find((e) => e.kind === "import" && e.toEntity === "shared.h")

    expect(importEdge).toBeDefined()
    expect(importEdge?.toFile).toBe(join(dir, "include", "shared.h"))

    rmSync(dir, { recursive: true, force: true })
  })
})
