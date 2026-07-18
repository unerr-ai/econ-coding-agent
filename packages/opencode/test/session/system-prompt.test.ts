import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import type { Agent } from "../../src/agent/agent"
import { select, toolUsage } from "../../src/session/prompts"

// select() only reads agent.name for econ tiers; model is unused on that branch.
const conductor = { name: "conductor" } as unknown as Agent.Info
const model = { api: { id: "deepseek-v4-flash" }, providerID: "openrouter" } as unknown as Provider.Model

describe("SystemPrompt.select", () => {
  test("the conductor prompt carries the typed-slice decomposition guidance (bullet 2a) — only-when policy", () => {
    const out = select(model, conductor).join("\n")
    expect(out).toContain("sliceType")
    expect(out).toContain("Decompose into typed")
    expect(out).toContain("ONLY when")
  })

  test("the conductor prompt states inline is the default (bullet 2)", () => {
    const out = select(model, conductor).join("\n")
    expect(out).toContain("Default to inline")
  })

  test("the conductor prompt's decompose-only-when policy includes the parallel independent-slices condition", () => {
    const out = select(model, conductor).join("\n")
    expect(out).toContain("genuinely independent")
    expect(out).toContain("can run in parallel")
  })

  test("the conductor prompt states untyped todos never spawn a child session (bullet 2b)", () => {
    const out = select(model, conductor).join("\n")
    expect(out).toContain("untyped items (no `sliceType`) never spawn a child session")
  })
})

describe("SystemPrompt.toolUsage", () => {
  test("returns empty string for an empty array", () => {
    expect(toolUsage([])).toBe("")
  })

  test("contains the header and footer for a non-empty set", () => {
    const out = toolUsage(["read", "search", "webfetch", "bash", "edit"])
    expect(out).toContain("# Available tools")
    expect(out).toContain("Never call a tool whose id is not in the list above.")
  })

  test("lists every id and the ids are sorted and comma-joined", () => {
    const ids = ["read", "search", "webfetch", "bash", "edit"]
    const out = toolUsage(ids)
    for (const id of ids) {
      expect(out).toContain(id)
    }
    // sorted order: bash, edit, read, search, webfetch
    expect(out).toContain("bash, edit, read, search, webfetch")
  })

  test("search note present when search is in ids", () => {
    const out = toolUsage(["read", "search", "webfetch", "bash", "edit"])
    expect(out).toContain("- `search`")
  })

  test("search note absent when search is not in ids", () => {
    const out = toolUsage(["read", "bash", "edit"])
    expect(out).not.toContain("- `search`")
  })

  test("read note present when read is in ids", () => {
    const out = toolUsage(["read", "bash"])
    expect(out).toContain("- `read`")
  })

  test("read note absent when read is not in ids", () => {
    const out = toolUsage(["bash", "edit"])
    expect(out).not.toContain("- `read`")
  })

  test("get_references note present when get_references is in ids (G1)", () => {
    const out = toolUsage(["get_references", "bash"])
    expect(out).toContain("- `get_references`")
    expect(out).toContain("before editing a widely-used entity")
  })

  test("get_references note absent when get_references is not in ids", () => {
    const out = toolUsage(["bash", "edit"])
    expect(out).not.toContain("- `get_references`")
  })

  test("webfetch note present when webfetch is in ids", () => {
    const out = toolUsage(["webfetch", "bash"])
    expect(out).toContain("- `webfetch`")
  })

  test("webfetch note absent when webfetch is not in ids", () => {
    const out = toolUsage(["bash", "edit"])
    expect(out).not.toContain("- `webfetch`")
  })

  test("batching note present when more than one tool id (OL-9.4a, hardened per L1.2b)", () => {
    const out = toolUsage(["read", "search"])
    expect(out).toContain(
      "- RULE: before sending, count your tool calls. If this message has ONE tool call and another independent read/search/command is already known to be needed, you are wasting a full round trip — add it to THIS message. Independent = neither call needs the other's output; example: reading a file AND running its tests = two calls, ONE message. Only a dependency chain — the next call needs this call's output — justifies a single-call message.",
    )
  })

  test("batching note absent for a single tool id", () => {
    const out = toolUsage(["read"])
    expect(out).not.toContain("RULE: before sending, count your tool calls")
  })

  test("eviction contract present for ANY non-empty tool set (L2.3 — cleared results announced, carry facts forward)", () => {
    // Single-tool set on purpose: unlike the batch rule, the eviction contract is not gated on
    // ids.length > 1 — masking clears completed tool results regardless of toolset size.
    const out = toolUsage(["read"])
    expect(out).toContain(
      "- As the session grows, older tool results may be cleared from your context mid-session — replaced by `[Old tool result content cleared]` or a one-line summary. Carry the facts you still need forward in your own words (paths, symbols, key output lines, conclusions) as you work, instead of planning to re-read a result later.",
    )
  })

  test("verify-once rule present when bash is in ids (L3.3 — one green run is the finish line)", () => {
    const out = toolUsage(["bash"])
    expect(out).toContain(
      "- RULE: verify once, at the finish line. Do not re-run a test suite that already passed unless a file has changed since that run — a second green proves nothing new and wastes a step. One green run of the full relevant suite IS the finish line, not N runs of it.",
    )
  })

  test("verify-once rule absent when bash is not in ids", () => {
    // No bash → no way to run a suite → the rule would be noise; it must be gated off.
    const out = toolUsage(["read", "search", "edit"])
    expect(out).not.toContain("RULE: verify once, at the finish line")
  })

  test("de-dupes ids — duplicate read counts once", () => {
    const out = toolUsage(["read", "read"])
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
    const result = select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ conductor")
  })

  test("executor: returns 2-element array and delta contains 'econ executor'", () => {
    const agent = { name: "executor" } as any
    const result = select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ executor")
  })

  test("oracle: returns 2-element array and delta contains 'econ oracle'", () => {
    const agent = { name: "oracle" } as any
    const result = select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ oracle")
  })

  test("reasoner: returns 2-element array and delta contains 'econ reasoner' (its own delta, distinct from oracle)", () => {
    const agent = { name: "reasoner" } as any
    const result = select(qwenModel, agent)
    expect(result).toHaveLength(2)
    expect(result[1]).toContain("econ reasoner")
  })

  test("non-econ agent falls back to provider() selection — returns single-element array", () => {
    const agent = { name: "build" } as any
    const result = select(qwenModel, agent)
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
      const result = select(qwenModel, agent)
      expect(result).toHaveLength(2)
      expect(result[1]).toContain(marker)
    })

    test(`${persona}: delta carries the shared batching directive (OL-9.4a, hardened per L1.2b)`, () => {
      const agent = { name: persona } as any
      const result = select(qwenModel, agent)
      expect(result[1]).toContain("RULE: before sending, count your tool calls.")
    })
  }
})

describe("SystemPrompt.toolUsage — persona toolsets (OL-9.2a)", () => {
  test("explorer's reduced toolset (no bash) omits the never-bash-for-reads note", () => {
    const out = toolUsage(["read", "search", "file_outline", "webfetch", "websearch"])
    expect(out).not.toContain("never `bash`")
  })

  test("applier's toolset (includes bash) keeps the never-bash-for-reads note", () => {
    const out = toolUsage(["read", "search", "file_outline", "bash", "edit"])
    expect(out).toContain("never `bash`")
  })
})
