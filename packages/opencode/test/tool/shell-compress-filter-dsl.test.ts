import { describe, expect, it } from "bun:test"
import path from "path"
import { applyUserFilter } from "../../src/tool/shell-compress/strategies/filter-dsl"
import { tmpdir } from "../fixture/fixture"

async function withFilters(toml: string) {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, ".econ", "filters.toml"), toml)
  return tmp
}

describe("applyUserFilter — missing config is a no-op", () => {
  it("returns null when .econ/filters.toml does not exist", async () => {
    await using tmp = await tmpdir()
    expect(applyUserFilter("anything", "some output", tmp.path)).toBeNull()
  })
})

describe("applyUserFilter — match_command + strip_lines_matching", () => {
  it("strips noise lines only for the matching command", async () => {
    await using tmp = await withFilters(
      ["[filters.mytool]", 'match_command = "^mytool\\\\b"', 'strip_lines_matching = ["^noise"]'].join("\n"),
    )

    const result = applyUserFilter("mytool run", "noise line 1\nkeep this\nnoise line 2", tmp.path)
    expect(result).not.toBeNull()
    expect(result?.text).toBe("keep this")
    expect(result?.name).toBe("mytool")

    // A non-matching command falls through (null) so the caller uses the built-in classifier.
    expect(applyUserFilter("othertool run", "noise line 1\nkeep this", tmp.path)).toBeNull()
  })
})

describe("applyUserFilter — keep_lines_matching", () => {
  it("keeps only lines matching the allow-list", async () => {
    await using tmp = await withFilters(
      ["[filters.errors-only]", 'match_command = "^mytool\\\\b"', 'keep_lines_matching = ["ERROR"]'].join("\n"),
    )

    const result = applyUserFilter("mytool build", "info: starting\nERROR: boom\ninfo: done", tmp.path)
    expect(result?.text).toBe("ERROR: boom")
  })
})

describe("applyUserFilter — replace directive", () => {
  it("applies a regex replace before strip/keep", async () => {
    await using tmp = await withFilters(
      [
        "[filters.mytool]",
        'match_command = "^mytool\\\\b"',
        'replace = [{ pattern = "secret-token-\\\\d+", replacement = "<tok>" }]',
      ].join("\n"),
    )

    const result = applyUserFilter("mytool run", "auth=secret-token-12345 ok", tmp.path)
    expect(result?.text).toBe("auth=<tok> ok")
  })
})

describe("applyUserFilter — truncate_lines_at / max_lines / tail_lines", () => {
  it("truncates long lines at the configured width", async () => {
    await using tmp = await withFilters(
      ["[filters.mytool]", 'match_command = "^mytool\\\\b"', "truncate_lines_at = 10"].join("\n"),
    )

    const result = applyUserFilter("mytool run", "0123456789ABCDEF", tmp.path)
    expect(result?.text).toBe("0123456789…")
  })

  it("caps to max_lines with a suppressed-count marker", async () => {
    await using tmp = await withFilters(
      ["[filters.mytool]", 'match_command = "^mytool\\\\b"', "max_lines = 2"].join("\n"),
    )

    const lines = ["a", "b", "c", "d"].join("\n")
    const result = applyUserFilter("mytool run", lines, tmp.path)
    expect(result?.text).toBe("a\nb\n… (2 more lines suppressed)")
  })

  it("keeps only the tail with an earlier-suppressed marker", async () => {
    await using tmp = await withFilters(
      ["[filters.mytool]", 'match_command = "^mytool\\\\b"', "tail_lines = 2"].join("\n"),
    )

    const lines = ["a", "b", "c", "d"].join("\n")
    const result = applyUserFilter("mytool run", lines, tmp.path)
    expect(result?.text).toBe("… (2 earlier lines suppressed)\nc\nd")
  })
})

describe("applyUserFilter — on_empty", () => {
  it("falls back to on_empty when every line is stripped", async () => {
    await using tmp = await withFilters(
      [
        "[filters.mytool]",
        'match_command = "^mytool\\\\b"',
        'strip_lines_matching = [".*"]',
        'on_empty = "no output"',
      ].join("\n"),
    )

    const result = applyUserFilter("mytool run", "anything\nat all", tmp.path)
    expect(result?.text).toBe("no output")
  })
})

describe("applyUserFilter — first-matching-filter-wins", () => {
  it("uses the first filter section that matches, ignoring later ones", async () => {
    await using tmp = await withFilters(
      [
        "[filters.first]",
        'match_command = "^mytool\\\\b"',
        'on_empty = "first"',
        'strip_lines_matching = [".*"]',
        "",
        "[filters.second]",
        'match_command = "^mytool\\\\b"',
        'on_empty = "second"',
        'strip_lines_matching = [".*"]',
      ].join("\n"),
    )

    const result = applyUserFilter("mytool run", "anything", tmp.path)
    expect(result?.name).toBe("first")
    expect(result?.text).toBe("first")
  })
})
