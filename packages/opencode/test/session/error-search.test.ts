/**
 * Tests for error-search.ts (packages/opencode/src/session/error-search.ts):
 * P5's web-search-as-a-first-class-sense (docs/design/agnostic-hands-eyes.md
 * §3 + §3.1). Covers normalizeTraceForSearch on real-shaped fixtures for
 * python/node/go/java/rust (local paths/line numbers/addresses stripped,
 * invariant message kept, undefined on non-error output), classifyTraceRoot
 * (dependency-cache-dir detection vs repo-root vs unknown), the
 * shouldSearchForError trigger table (recognized+repo-rooted suppression,
 * unrecognized/dependency-rooted/repro-escalation firing, dedupe, budget),
 * versionMismatchWarning (major disagreement fires, patch/minor silent),
 * and docUrlForDependency (version-pinned URLs, unknown ecosystem
 * undefined).
 */

import { describe, it, expect } from "bun:test"
import {
  normalizeTraceForSearch,
  classifyTraceRoot,
  shouldSearchForError,
  versionMismatchWarning,
  docUrlForDependency,
  DEFAULT_REPRO_UNRESOLVED_THRESHOLD,
  type SearchTriggerInput,
} from "../../src/session/error-search"

describe("normalizeTraceForSearch", () => {
  it("python: extracts the invariant exception line, strips the local path from the message", () => {
    const output = [
      "Traceback (most recent call last):",
      '  File "/Users/jaswanth/proj/pkg/io.py", line 10, in load',
      "    with open(path) as f:",
      "FileNotFoundError: [Errno 2] No such file or directory: '/Users/jaswanth/proj/data/input.csv'",
    ].join("\n")
    const result = normalizeTraceForSearch(output)
    expect(result).toBeDefined()
    expect(result!.query).toContain("FileNotFoundError")
    expect(result!.query).toContain("No such file or directory")
    expect(result!.query).not.toContain("/Users/jaswanth")
    expect(result!.query).not.toContain("input.csv")
  })

  it("python: plain ValueError with no embedded path survives intact", () => {
    const output = [
      "Traceback (most recent call last):",
      '  File "/Users/jaswanth/proj/pkg/mod.py", line 42, in do_thing',
      "    return int(value)",
      "ValueError: invalid literal for int() with base 10: 'abc'",
    ].join("\n")
    const result = normalizeTraceForSearch(output)
    expect(result?.query).toBe("ValueError: invalid literal for int() with base 10: 'abc'")
  })

  it("node: extracts TypeError, ignores the stack frame's path/line/col", () => {
    const output = [
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      "    at Object.<anonymous> (/Users/jaswanth/proj/src/index.js:15:20)",
      "    at Module._compile (node:internal/modules/cjs/loader:1105:14)",
    ].join("\n")
    const result = normalizeTraceForSearch(output)
    expect(result?.query).toBe("TypeError: Cannot read properties of undefined (reading 'foo')")
  })

  it("go: extracts the panic message, strips the local path + memory address in the goroutine dump", () => {
    const output = [
      "panic: runtime error: index out of range [3] with length 3",
      "",
      "goroutine 1 [running]:",
      "main.main()",
      "\t/Users/jaswanth/proj/main.go:10 +0x1a4b2c",
      "exit status 2",
    ].join("\n")
    const result = normalizeTraceForSearch(output)
    expect(result?.query).toBe("panic: runtime error: index out of range [3] with length 3")
  })

  it("java: extracts the fully-qualified exception type + message", () => {
    const output = [
      'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null',
      "\tat com.example.Main.main(Main.java:5)",
    ].join("\n")
    const result = normalizeTraceForSearch(output)
    expect(result?.query).toBe(
      'java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null',
    )
  })

  it("rust: pre-2021 quoted panic message format", () => {
    const output = [
      "thread 'main' panicked at 'index out of bounds: the len is 3 but the index is 5', src/main.rs:4:5",
      "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
    ].join("\n")
    const result = normalizeTraceForSearch(output)
    expect(result?.query).toBe("panic: index out of bounds: the len is 3 but the index is 5")
  })

  it("rust: 2021+ location-on-its-own-line panic format", () => {
    const output = [
      "thread 'main' panicked at src/main.rs:4:5:",
      "index out of bounds: the len is 3 but the index is 5",
      "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
    ].join("\n")
    const result = normalizeTraceForSearch(output)
    expect(result?.query).toBe("panic: index out of bounds: the len is 3 but the index is 5")
  })

  it("returns undefined when no recognizable error shape is present", () => {
    const output = "Running 12 tests...\nOK\nAll tests passed in 0.42s"
    expect(normalizeTraceForSearch(output)).toBeUndefined()
  })

  it("signature is a stable, lowercased dedupe key derived from the same query", () => {
    const output = "ValueError: invalid literal for int() with base 10: 'abc'\nTraceback (most recent call last):"
    // (traceback header not required to precede for this assertion's purpose is irrelevant;
    // use a real traceback so detection succeeds)
    const real = [
      "Traceback (most recent call last):",
      "ValueError: invalid literal for int() with base 10: 'abc'",
    ].join("\n")
    const result = normalizeTraceForSearch(real)
    expect(result?.signature).toBe(result?.query.toLowerCase())
  })
})

describe("classifyTraceRoot", () => {
  const repoRoot = "/Users/jaswanth/proj"

  it("python: site-packages path classifies as dependency-rooted, resolves the known dep name", () => {
    const trace =
      'File "/Users/jaswanth/.venv/lib/python3.11/site-packages/numpy/core/numeric.py", line 100, in foo'
    const result = classifyTraceRoot(trace, repoRoot, ["numpy", "requests"])
    expect(result.origin).toBe("dependency")
    expect(result.dependencyName).toBe("numpy")
  })

  it("node: node_modules (incl. scoped package) classifies as dependency-rooted", () => {
    const trace = "at Object.<anonymous> (/Users/jaswanth/proj/node_modules/@babel/core/lib/index.js:10:5)"
    const result = classifyTraceRoot(trace, repoRoot, ["@babel/core"])
    expect(result.origin).toBe("dependency")
    expect(result.dependencyName).toBe("@babel/core")
  })

  it("go: pkg/mod module cache path classifies as dependency-rooted", () => {
    const trace = "/Users/jaswanth/go/pkg/mod/github.com/pkg/errors@v0.9.1/errors.go:99"
    const result = classifyTraceRoot(trace, repoRoot, [])
    expect(result.origin).toBe("dependency")
    expect(result.dependencyName).toBe("github.com/pkg/errors")
  })

  it("rust: cargo registry source path classifies as dependency-rooted", () => {
    const trace =
      "/Users/jaswanth/.cargo/registry/src/index.crates.io-1234/serde-1.0.190/src/lib.rs:10"
    const result = classifyTraceRoot(trace, repoRoot, ["serde"])
    expect(result.origin).toBe("dependency")
    expect(result.dependencyName).toBe("serde")
  })

  it("vendor directory classifies as dependency-rooted", () => {
    const trace = "/Users/jaswanth/proj/vendor/github.com/pkg/errors/errors.go:5"
    const result = classifyTraceRoot(trace, repoRoot, [])
    expect(result.origin).toBe("dependency")
  })

  it("a path under the repo root with no dependency-cache marker classifies as repo", () => {
    const trace = 'File "/Users/jaswanth/proj/src/mymodule.py", line 12, in run'
    const result = classifyTraceRoot(trace, repoRoot, [])
    expect(result.origin).toBe("repo")
    expect(result.dependencyName).toBeUndefined()
  })

  it("neither a dependency marker nor the repo root present classifies as unknown", () => {
    const trace = "panic: runtime error: index out of range [3] with length 3"
    const result = classifyTraceRoot(trace, repoRoot, [])
    expect(result.origin).toBe("unknown")
  })
})

describe("shouldSearchForError", () => {
  function baseInput(overrides: Partial<SearchTriggerInput> = {}): SearchTriggerInput {
    return {
      trace: { query: "ValueError: bad input", signature: "valueerror: bad input" },
      recognizedByProfile: true,
      traceOrigin: { origin: "repo" },
      reproAttempts: 0,
      alreadySearchedSignatures: new Set(),
      budgetRemaining: 1,
      ...overrides,
    }
  }

  it("never fires when the trace is repo-internal AND recognized by our own parsers", () => {
    const decision = shouldSearchForError(baseInput())
    expect(decision.search).toBe(false)
  })

  it("fires when the error is unrecognized, even if repo-rooted", () => {
    const decision = shouldSearchForError(baseInput({ recognizedByProfile: false }))
    expect(decision.search).toBe(true)
    if (decision.search) expect(decision.reason).toContain("not recognized")
  })

  it("fires when the trace is dependency-rooted, even if recognized", () => {
    const decision = shouldSearchForError(
      baseInput({ traceOrigin: { origin: "dependency", dependencyName: "numpy" } }),
    )
    expect(decision.search).toBe(true)
    if (decision.search) expect(decision.reason).toContain("dependency")
  })

  it("fires as an escalation once repro attempts reach the threshold, even if recognized + repo-rooted", () => {
    const decision = shouldSearchForError(baseInput({ reproAttempts: DEFAULT_REPRO_UNRESOLVED_THRESHOLD }))
    expect(decision.search).toBe(true)
    if (decision.search) expect(decision.reason).toContain("unresolved")
  })

  it("does not fire below the repro-unresolved threshold", () => {
    const decision = shouldSearchForError(
      baseInput({ reproAttempts: DEFAULT_REPRO_UNRESOLVED_THRESHOLD - 1 }),
    )
    expect(decision.search).toBe(false)
  })

  it("never re-searches an already-searched signature this turn", () => {
    const decision = shouldSearchForError(
      baseInput({
        recognizedByProfile: false,
        alreadySearchedSignatures: new Set(["valueerror: bad input"]),
      }),
    )
    expect(decision.search).toBe(false)
    if (!decision.search) expect(decision.reason).toContain("already searched")
  })

  it("never fires past the per-turn budget", () => {
    const decision = shouldSearchForError(baseInput({ recognizedByProfile: false, budgetRemaining: 0 }))
    expect(decision.search).toBe(false)
    if (!decision.search) expect(decision.reason).toContain("budget")
  })

  it("embeds the resolved dependency version into the query when the dep is in the profile", () => {
    const decision = shouldSearchForError(
      baseInput({
        trace: { query: "AttributeError: module 'numpy' has no attribute 'int'", signature: "sig" },
        traceOrigin: { origin: "dependency", dependencyName: "numpy" },
        versions: { deps: { numpy: "1.24.0" } },
      }),
    )
    expect(decision.search).toBe(true)
    if (decision.search) {
      expect(decision.query).toContain("numpy 1.24.0")
      expect(decision.query).toContain("AttributeError")
    }
  })

  it("leaves the query unchanged when the implicated dependency has no resolved version in the profile", () => {
    const decision = shouldSearchForError(
      baseInput({
        traceOrigin: { origin: "dependency", dependencyName: "unlisted-pkg" },
        versions: { deps: { numpy: "1.24.0" } },
      }),
    )
    expect(decision.search).toBe(true)
    if (decision.search) expect(decision.query).toBe("ValueError: bad input")
  })
})

describe("versionMismatchWarning", () => {
  it("fires a one-line warning when the retrieved text's version disagrees on MAJOR", () => {
    const text = "In Django 2.2, form validation raised a plain ValidationError with no code attribute."
    const warning = versionMismatchWarning(text, { name: "Django", version: "5.0.6" })
    expect(warning).toBeDefined()
    expect(warning).toContain("Django")
    expect(warning).toContain("2.2")
    expect(warning).toContain("5.0.6")
  })

  it("stays silent when the retrieved text's version only differs by minor/patch", () => {
    const text = "As of Django 5.1, the new form renders slightly differently."
    const warning = versionMismatchWarning(text, { name: "Django", version: "5.0.6" })
    expect(warning).toBeUndefined()
  })

  it("stays silent when no version is mentioned near the dependency name", () => {
    const text = "Django's ORM lazily evaluates querysets."
    const warning = versionMismatchWarning(text, { name: "Django", version: "5.0.6" })
    expect(warning).toBeUndefined()
  })

  it("stays silent when the dependency name is not mentioned at all", () => {
    const text = "Flask 2.0 changed the default session cookie behavior."
    const warning = versionMismatchWarning(text, { name: "Django", version: "5.0.6" })
    expect(warning).toBeUndefined()
  })
})

describe("docUrlForDependency", () => {
  it("builds a version-pinned docs.rs URL for a rust crate", () => {
    expect(docUrlForDependency("serde", "1.0.190", "rust")).toBe("https://docs.rs/serde/1.0.190/serde/")
  })

  it("builds a version-pinned npm package URL for a JS/TS dependency", () => {
    expect(docUrlForDependency("axios", "1.6.0", "npm")).toBe("https://www.npmjs.com/package/axios/v/1.6.0")
  })

  it("builds django's major.minor-pinned docs URL without needing an explicit ecosystem hint", () => {
    expect(docUrlForDependency("django", "5.0.6")).toBe("https://docs.djangoproject.com/en/5.0/")
  })

  it("is case-insensitive on the django special case", () => {
    expect(docUrlForDependency("Django", "4.2.1")).toBe("https://docs.djangoproject.com/en/4.2/")
  })

  it("returns undefined for django when the version has no minor segment to pin", () => {
    expect(docUrlForDependency("django", "5")).toBeUndefined()
  })

  it("returns undefined for an unknown/unguessable ecosystem rather than guessing a URL", () => {
    expect(docUrlForDependency("requests", "2.31.0", "python")).toBeUndefined()
    expect(docUrlForDependency("some-obscure-package", "1.0.0")).toBeUndefined()
  })
})
