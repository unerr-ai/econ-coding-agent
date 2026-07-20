/**
 * Unit + integration tests for the G2 universal index-suffix import
 * fallback (docs/design/agnostic-hands-eyes.md §5.1 tier 1 + §7.2):
 * resolveViaSuffixIndex/buildSuffixIndex/suffixTokens are the pure,
 * language-blind matcher; BunSqliteGraph.resolveImportSuffixFallback()
 * wires them into index() as a post-pass, surfaced via
 * importFallbackStats().
 */
import { describe, it, expect, afterEach } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteGraph, buildSuffixIndex, resolveViaSuffixIndex, suffixTokens } from "../src/bun-sqlite-graph.js"

describe("suffixTokens", () => {
  it("splits on every separator (. / \\ :: -), collapsing runs, dropping empties", () => {
    expect(suffixTokens("app/models/user")).toEqual(["app", "models", "user"])
    expect(suffixTokens("pkg.mod.Widget")).toEqual(["pkg", "mod", "Widget"])
    expect(suffixTokens("std::collections::HashMap")).toEqual(["std", "collections", "HashMap"])
    expect(suffixTokens("a-kebab-name")).toEqual(["a", "kebab", "name"])
    expect(suffixTokens("win\\style\\path")).toEqual(["win", "style", "path"])
    expect(suffixTokens("")).toEqual([])
  })
})

describe("resolveViaSuffixIndex — the matcher contract", () => {
  it("one-match resolution: a unique 3-segment suffix resolves", () => {
    const index = buildSuffixIndex(["/repo/app/models/user.py", "/repo/app/other/thing.py"])
    expect(resolveViaSuffixIndex("app/models/user", index)).toEqual({ file: "/repo/app/models/user.py" })
  })

  it("multi-match ambiguity: two files sharing a stem in different dirs record the count, never a silent NULL", () => {
    const index = buildSuffixIndex(["/repo/a/utils.go", "/repo/b/utils.go"])
    expect(resolveViaSuffixIndex("utils", index)).toEqual({ count: 2 })
  })

  it("zero-match external: a specifier matching nothing in the index resolves to null (correctly unresolved forever)", () => {
    const index = buildSuffixIndex(["/repo/app/models/user.py"])
    expect(resolveViaSuffixIndex("os", index)).toBeNull()
  })

  it("extension-blind matching across two different file extensions, same mechanism, no per-language branch", () => {
    const goIndex = buildSuffixIndex(["/repo/pkg/config.go"])
    expect(resolveViaSuffixIndex("pkg/config", goIndex)).toEqual({ file: "/repo/pkg/config.go" })

    const pyIndex = buildSuffixIndex(["/repo/app/config.py"])
    expect(resolveViaSuffixIndex("app/config", pyIndex)).toEqual({ file: "/repo/app/config.py" })
  })

  it("single-segment guard: a common stem (utils) present in multiple dirs stays ambiguous, never falsely resolved", () => {
    const index = buildSuffixIndex(["/repo/moduleA/utils.js", "/repo/moduleB/utils.js", "/repo/moduleC/other.js"])
    expect(resolveViaSuffixIndex("utils", index)).toEqual({ count: 2 })
    // A genuinely unique stem in the same index still resolves — the guard
    // above isn't just "always ambiguous", it's specific to the shared stem.
    expect(resolveViaSuffixIndex("other", index)).toEqual({ file: "/repo/moduleC/other.js" })
  })

  it("cascades from longest to shortest: a 3-segment miss falls back to a 2-segment hit rather than stopping", () => {
    const index = buildSuffixIndex(["/repo/pkg/app/config.go"])
    // "x/app/config" has no 3-segment match ("x/app/config" != "pkg/app/config"
    // suffix), but its trailing 2 segments ("app/config") do.
    expect(resolveViaSuffixIndex("x/app/config", index)).toEqual({ file: "/repo/pkg/app/config.go" })
  })

  it("prefers the longest matching length even when a shorter length alone would be noisier/ambiguous", () => {
    const index = buildSuffixIndex(["/repo/x/a/b/c.rs", "/repo/other/z/c.rs", "/repo/another/w/c.rs"])
    // Only one file's trailing 3 segments are "a/b/c" — resolved there, even
    // though "c" alone (trailing 1) matches three files and would have been
    // ambiguous had the ladder started short instead of long.
    expect(resolveViaSuffixIndex("a/b/c", index)).toEqual({ file: "/repo/x/a/b/c.rs" })
  })
})

describe("resolveViaSuffixIndex — G3 guard (a): full-specifier verification for specifiers with more than 3 tokens", () => {
  it("collapses a same-trailing-3-token collision when only one candidate's FULL path matches the specifier", () => {
    const index = buildSuffixIndex(["/repo/w/x/y/z.java", "/repo/q/x/y/z.java"])
    // Both files share the trailing 3 tokens ("x/y/z") the probe window
    // caps at, so the RAW 3-token probe alone would report 2 candidates
    // (ambiguous) — guard (a) survives only the one whose FULL 4-token
    // path ("w/x/y/z") actually matches the specifier's full token
    // sequence, collapsing java's dotted-package false-ambiguity class.
    expect(resolveViaSuffixIndex("w.x.y.z", index)).toEqual({ file: "/repo/w/x/y/z.java" })
  })

  it("stays genuinely ambiguous when more than one candidate's FULL path matches the specifier", () => {
    const index = buildSuffixIndex(["/repo/one/w/x/y/z.java", "/repo/two/w/x/y/z.java"])
    expect(resolveViaSuffixIndex("w.x.y.z", index)).toEqual({ count: 2 })
  })

  it("does not apply the guard when the specifier has 3 or fewer tokens (the probe window's own cap)", () => {
    const index = buildSuffixIndex(["/repo/w/x/y.java", "/repo/q/x/y.java"])
    expect(resolveViaSuffixIndex("w.x.y", index)).toEqual({ file: "/repo/w/x/y.java" })
  })
})

describe("resolveViaSuffixIndex — G3 guard (b): sibling guard for single-token specifiers", () => {
  it("trusts a lone single-token match only when it sits in the same directory as the importing file", () => {
    const index = buildSuffixIndex(["/repo/app/datetime.py"])
    expect(resolveViaSuffixIndex("datetime", index, "/repo/app/caller.py")).toEqual({ file: "/repo/app/datetime.py" })
  })

  it("rejects a lone single-token match in a DIFFERENT directory — recorded ambiguous, never silently resolved", () => {
    const index = buildSuffixIndex(["/repo/django/datetime.py"])
    expect(resolveViaSuffixIndex("datetime", index, "/repo/app/caller.py")).toEqual({ count: 1 })
  })

  it("skips the sibling guard entirely when fromFile is omitted (backward compatible)", () => {
    const index = buildSuffixIndex(["/repo/django/datetime.py"])
    expect(resolveViaSuffixIndex("datetime", index)).toEqual({ file: "/repo/django/datetime.py" })
  })

  it("never applies the sibling guard to a multi-token specifier's lone match", () => {
    const index = buildSuffixIndex(["/repo/django/utils/datetime.py"])
    expect(resolveViaSuffixIndex("utils/datetime", index, "/repo/app/caller.py")).toEqual({
      file: "/repo/django/utils/datetime.py",
    })
  })
})

describe("BunSqliteGraph — G2 suffix fallback wired into index()", () => {
  let dir: string
  let graph: BunSqliteGraph

  afterEach(async () => {
    graph?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("resolves one, leaves one ambiguous, and leaves one external — all through importFallbackStats()", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-suffix-fallback-"))
    await mkdir(join(dir, "widgets"), { recursive: true })
    await mkdir(join(dir, "extra1"), { recursive: true })
    await mkdir(join(dir, "extra2"), { recursive: true })
    await mkdir(join(dir, "cmd"), { recursive: true })
    await mkdir(join(dir, "cmd2"), { recursive: true })

    // Go's row (G3, manifestPrefix) only resolves an in-module specifier
    // against a go.mod's module path — none exists in this fixture, so
    // every specifier still lands toFile:null at row-resolution time and
    // the fallback below is the only thing that can ever resolve it here.
    await writeFile(join(dir, "widgets", "pkg.go"), "package widgets\n\nfunc Widget() {}\n")
    await writeFile(join(dir, "extra1", "dup.go"), "package extra1\n")
    await writeFile(join(dir, "extra2", "dup.go"), "package extra2\n")
    await writeFile(
      join(dir, "cmd", "main.go"),
      ['package main', '', 'import (', '\t"somewhere/pkg"', '\t"fmt"', ')', '', 'func main() {}', ''].join("\n"),
    )
    await writeFile(join(dir, "cmd2", "main2.go"), ['package main', '', 'import "x/dup"', '', 'func main() {}', ''].join("\n"))

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    const stats = graph.importFallbackStats()
    expect(stats["go"]).toEqual({ resolvedByRow: 0, resolvedByFallback: 1, ambiguous: 1, externalUnmatched: 1 })

    // edgeCoverage()'s row shape is unchanged (G4b contract); it just now
    // counts the fallback-resolved edge as resolved too.
    const coverage = graph.edgeCoverage()
    expect(coverage["go"]).toEqual({ files: 5, imports: 3, resolvedImports: 1, calls: 0 })
  })

  it("is idempotent: a second index() run doesn't re-touch already-attempted edges", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-suffix-fallback-idem-"))
    await mkdir(join(dir, "widgets"), { recursive: true })
    await writeFile(join(dir, "widgets", "pkg.go"), "package widgets\n\nfunc Widget() {}\n")
    await writeFile(join(dir, "main.go"), ['package main', '', 'import "somewhere/pkg"', '', 'func main() {}', ''].join("\n"))

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)
    const first = graph.importFallbackStats()
    await graph.index(dir)
    const second = graph.importFallbackStats()

    expect(second["go"]).toEqual(first["go"])
    expect(second["go"]).toEqual({ resolvedByRow: 0, resolvedByFallback: 1, ambiguous: 0, externalUnmatched: 0 })
  })
})
