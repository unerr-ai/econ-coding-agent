import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import type { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"

// select() only reads agent.name for econ tiers; model is unused on that branch.
const conductor = { name: "conductor" } as unknown as Agent.Info
const model = { api: { id: "deepseek-v4-flash" }, providerID: "openrouter" } as unknown as Provider.Model

describe("SystemPrompt.select", () => {
  test("the conductor prompt carries the typed-slice decomposition guidance (bullet 2a) — only-when policy", () => {
    const out = SystemPrompt.select(model, conductor).join("\n")
    expect(out).toContain("sliceType")
    expect(out).toContain("Decompose into typed")
    expect(out).toContain("ONLY when")
  })

  test("the conductor prompt states inline is the default (bullet 2)", () => {
    const out = SystemPrompt.select(model, conductor).join("\n")
    expect(out).toContain("Default to inline")
  })

  test("the conductor prompt's decompose-only-when policy includes the parallel independent-slices condition", () => {
    const out = SystemPrompt.select(model, conductor).join("\n")
    expect(out).toContain("genuinely independent")
    expect(out).toContain("can run in parallel")
  })

  test("the conductor prompt states untyped todos never spawn a child session (bullet 2b)", () => {
    const out = SystemPrompt.select(model, conductor).join("\n")
    expect(out).toContain("untyped items (no `sliceType`) never spawn a child session")
  })
})

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

  test("batching note present when more than one tool id (OL-9.4a)", () => {
    const out = SystemPrompt.toolUsage(["read", "search"])
    expect(out).toContain("Batch independent tool calls into the same response")
  })

  test("batching note absent for a single tool id", () => {
    const out = SystemPrompt.toolUsage(["read"])
    expect(out).not.toContain("Batch independent tool calls into the same response")
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

describe("SystemPrompt.select — personas (OL-9.1a)", () => {
  const qwenModel = { api: { id: "qwen/qwen3.7-plus" } } as any
  const PERSONA_MARKER: Record<string, string> = {
    explorer: "econ explorer",
    runner: "econ runner",
    applier: "econ applier",
    author: "econ author",
    researcher: "econ researcher",
    procedure: "econ procedure",
  }

  for (const [persona, marker] of Object.entries(PERSONA_MARKER)) {
    test(`${persona}: returns 2-element array and delta contains '${marker}'`, () => {
      const agent = { name: persona } as any
      const result = SystemPrompt.select(qwenModel, agent)
      expect(result).toHaveLength(2)
      expect(result[1]).toContain(marker)
    })

    test(`${persona}: delta carries the shared batching directive (OL-9.4a)`, () => {
      const agent = { name: persona } as any
      const result = SystemPrompt.select(qwenModel, agent)
      expect(result[1]).toContain(
        "Issue every independent tool call in the SAME response — reads of different files, parallel searches, independent commands.",
      )
    })
  }
})

describe("SystemPrompt.toolUsage — persona toolsets (OL-9.2a)", () => {
  test("explorer's reduced toolset (no bash) omits the never-bash-for-reads note", () => {
    const out = SystemPrompt.toolUsage(["read", "search", "file_outline", "webfetch", "websearch"])
    expect(out).not.toContain("never `bash`")
  })

  test("applier's toolset (includes bash) keeps the never-bash-for-reads note", () => {
    const out = SystemPrompt.toolUsage(["read", "search", "file_outline", "bash", "edit"])
    expect(out).toContain("never `bash`")
  })
})
