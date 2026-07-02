import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

describe("SystemPrompt.toolUsage", () => {
  test("returns empty string for an empty array", () => {
    expect(SystemPrompt.toolUsage([])).toBe("")
  })

  test("contains the header and footer for a non-empty set", () => {
    const out = SystemPrompt.toolUsage(["read", "search", "webfetch", "bash", "edit"])
    expect(out).toContain("# Available tools")
    expect(out).toContain("Never call a tool whose id is not in the list above.")
  })

  test("lists every id and the ids are sorted and comma-joined", () => {
    const ids = ["read", "search", "webfetch", "bash", "edit"]
    const out = SystemPrompt.toolUsage(ids)
    for (const id of ids) {
      expect(out).toContain(id)
    }
    // sorted order: bash, edit, read, search, webfetch
    expect(out).toContain("bash, edit, read, search, webfetch")
  })

  test("search note present when search is in ids", () => {
    const out = SystemPrompt.toolUsage(["read", "search", "webfetch", "bash", "edit"])
    expect(out).toContain("- `search`")
  })

  test("search note absent when search is not in ids", () => {
    const out = SystemPrompt.toolUsage(["read", "bash", "edit"])
    expect(out).not.toContain("- `search`")
  })

  test("read note present when read is in ids", () => {
    const out = SystemPrompt.toolUsage(["read", "bash"])
    expect(out).toContain("- `read`")
  })

  test("read note absent when read is not in ids", () => {
    const out = SystemPrompt.toolUsage(["bash", "edit"])
    expect(out).not.toContain("- `read`")
  })

  test("webfetch note present when webfetch is in ids", () => {
    const out = SystemPrompt.toolUsage(["webfetch", "bash"])
    expect(out).toContain("- `webfetch`")
  })

  test("webfetch note absent when webfetch is not in ids", () => {
    const out = SystemPrompt.toolUsage(["bash", "edit"])
    expect(out).not.toContain("- `webfetch`")
  })

  test("de-dupes ids — duplicate read counts once", () => {
    const out = SystemPrompt.toolUsage(["read", "read"])
    // ids after dedup+sort = ["read"], so the enumeration line has exactly "read" (no comma)
    expect(out).toContain("read")
    // ensure it does not enumerate the id twice on the same line
    const enumLine = out
      .split("\n")
      .find((l) => l.includes("call each by its exact id"))!
    expect(enumLine).toBeDefined()
    const countRead = enumLine.split("read").length - 1
    expect(countRead).toBe(1)
  })
})

describe("SystemPrompt.select", () => {
  const qwenModel = { api: { id: "qwen/qwen3.7-plus" } } as any

  test("conductor: returns 2-element array and delta contains 'econ conductor'", () => {
    const agent = { name: "conductor" } as any
    const result = SystemPrompt.select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ conductor")
  })

  test("executor: returns 2-element array and delta contains 'econ executor'", () => {
    const agent = { name: "executor" } as any
    const result = SystemPrompt.select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ executor")
  })

  test("oracle: returns 2-element array and delta contains 'econ oracle'", () => {
    const agent = { name: "oracle" } as any
    const result = SystemPrompt.select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ oracle")
  })

  test("reasoner: returns 2-element array and delta contains 'econ oracle' (same delta as oracle)", () => {
    const agent = { name: "reasoner" } as any
    const result = SystemPrompt.select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ oracle")
  })

  test("non-econ agent falls back to provider() selection — returns single-element array", () => {
    const agent = { name: "build" } as any
    const result = SystemPrompt.select(qwenModel, agent)
    expect(result.length).toBeGreaterThan(0)
    expect(result).toHaveLength(1)
  })
})
