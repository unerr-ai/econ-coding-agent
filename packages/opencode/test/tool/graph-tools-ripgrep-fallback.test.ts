/**
 * Graph-tools ripgrep downgrade tests: prove that when the code graph is
 * unavailable (module load / construction / query error) or still indexing,
 * the content-search tools degrade to inbuilt ripgrep results instead of
 * hard-erroring or surfacing a misleading "still indexing" string.
 *
 * These exercise `ripgrepFallback` — the single floor every content-search
 * tool (recon, search, refs, get_references) routes to on ANY graph failure —
 * directly against the code-intelligence fixture dir, so no forced graph
 * failure is needed. The tool execute paths all `return ripgrepFallback(...)`
 * on their graph-failure / not-ready branches (graph-tools.ts).
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { join } from "node:path"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ripgrepFallback } from "../../src/tool/graph-tools"
import { testEffect } from "../lib/effect"

// Reuse the code-intelligence fixtures (same repo). `greet` is a symbol defined
// in a.ts; grepping it must return real ripgrep matches.
const FIXTURE_DIR = join(import.meta.dir, "../../../code-intelligence/test/fixture")

const it = testEffect(Ripgrep.defaultLayer)

describe("graph tools — ripgrep downgrade on graph failure/unavailable", () => {
  it.effect(
    "recon downgrade: a task phrase yields ripgrep matches, not an error",
    () =>
      Effect.gen(function* () {
        const ripgrep = yield* Ripgrep.Service
        const result = yield* Effect.promise(() =>
          ripgrepFallback(ripgrep, { tool: "recon", query: "greet", cwd: FIXTURE_DIR }),
        )
        expect(result.title).toBe("recon")
        expect(result.output).toContain("greet")
        expect(result.output).toContain("[ripgrep fallback]")
        expect(result.metadata.fallback).toBe("ripgrep")
      }),
    30_000,
  )

  it.effect(
    "search/symbol downgrade: a symbol name degrades to a literal name grep",
    () =>
      Effect.gen(function* () {
        const ripgrep = yield* Ripgrep.Service
        const result = yield* Effect.promise(() =>
          // symbol mode isn't text-searchable, so the downgrade greps the name literally.
          ripgrepFallback(ripgrep, { tool: "search", query: "Calculator", mode: "symbol", cwd: FIXTURE_DIR }),
        )
        expect(result.output).toContain("Calculator")
        expect(result.output).toContain("[ripgrep fallback]")
      }),
    30_000,
  )

  it.effect(
    "get_references downgrade: an entity name yields ripgrep occurrences, never a throw",
    () =>
      Effect.gen(function* () {
        const ripgrep = yield* Ripgrep.Service
        const result = yield* Effect.promise(() =>
          ripgrepFallback(ripgrep, { tool: "get_references", query: "greet", cwd: FIXTURE_DIR }),
        )
        expect(result.title).toBe("get_references")
        expect(result.output).toContain("greet")
        expect(result.output).toContain("[ripgrep fallback]")
      }),
    30_000,
  )

  it.effect(
    "regex mode passes the pattern through unescaped",
    () =>
      Effect.gen(function* () {
        const ripgrep = yield* Ripgrep.Service
        const result = yield* Effect.promise(() =>
          ripgrepFallback(ripgrep, { tool: "search", query: "gre+t", mode: "regex", cwd: FIXTURE_DIR }),
        )
        expect(result.output).toContain("greet")
        expect(result.output).toContain("[ripgrep fallback]")
      }),
    30_000,
  )

  it.effect(
    "no matches returns a graceful result (never throws, never 'still indexing')",
    () =>
      Effect.gen(function* () {
        const ripgrep = yield* Ripgrep.Service
        const result = yield* Effect.promise(() =>
          ripgrepFallback(ripgrep, { tool: "search", query: "zzz_no_such_symbol_qqq", cwd: FIXTURE_DIR }),
        )
        expect(typeof result.output).toBe("string")
        expect(result.output).toContain("[ripgrep fallback]")
        expect(result.output).not.toContain("still indexing")
        expect(result.metadata.fallback).toBe("ripgrep")
      }),
    30_000,
  )
})
