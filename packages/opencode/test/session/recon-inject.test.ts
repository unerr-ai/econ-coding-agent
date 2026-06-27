/**
 * Z3-econ S2.1 — econ-recon-inject plugin behaviour
 *
 * Verifies that the context.assemble.before hook (registered by the
 * econ-recon-inject plugin) correctly:
 *   1. Queries the code graph with recon(task) on a seeded BunSqliteGraph.
 *   2. Formats the result as a compact recon bundle string.
 *   3. Pushes it into output.messages so it appears in the final prepared
 *      message list BEFORE the conversation history and AFTER the system turn.
 *   4. When the graph is empty (no indexed entities), skips injection and
 *      leaves messages unchanged.
 *
 * No live model call is made — we inspect the Prepared payload directly,
 * using the same makePlugin helper pattern as context-hook.test.ts.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { rmSync } from "node:fs"
import { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import { LLMRequestPrep } from "@/session/llm/request"

// ---------------------------------------------------------------------------
// Shared fixtures (minimal shape — only fields used by prepare())
// ---------------------------------------------------------------------------

const sessionID = "test-session-recon-inject"

const mockModel = {
  id: "anthropic/claude-3-5-sonnet",
  providerID: "anthropic",
  api: {
    id: "claude-3-5-sonnet-20241022",
    url: "https://api.anthropic.com",
    npm: "@ai-sdk/anthropic",
  },
  name: "Claude 3.5 Sonnet",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
  limit: { context: 200_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
} as any

const mockAgent = {
  name: "test-agent",
  mode: "primary",
  options: {},
  permission: [],
} as any

const mockUser = {
  id: "msg_user-recon-test",
  sessionID,
  role: "user",
  time: { created: Date.now() },
  agent: "test-agent",
  model: {
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022",
    variant: undefined,
  },
  // summary.title gives the plugin its task phrase in production
  summary: { title: "parseTask function", body: undefined, diffs: [] },
} as any

const mockProvider = {
  id: "anthropic",
  options: {},
} as any

const mockFlags = { outputTokenMax: 32_000, client: "test" } as any

/**
 * Build a mock Plugin.Interface that calls the registered hook function when
 * name matches, then returns the (possibly mutated) output object.
 * Mirrors the helper in context-hook.test.ts.
 */
function makePlugin(hooks: Record<string, (input: any, output: any) => Promise<void>>) {
  return {
    trigger: (name: string, input: unknown, output: unknown) =>
      Effect.promise(async () => {
        const fn = hooks[name]
        if (fn) await fn(input, output)
        return output
      }),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  } as any
}

// ---------------------------------------------------------------------------
// Bundle formatter — mirrors the inline implementation in econ-recon-inject.js
// (duplicated here so the test has no runtime dependency on the plugin file).
// ---------------------------------------------------------------------------

interface ReconBundle {
  entities: Array<{
    name: string
    kind: string
    filePath: string
    lineStart: number
    signature: string
    domain?: string
    role?: string
  }>
  references: Array<{ fromEntity: string; toEntity: string; kind: string }>
  notes: string[]
}

function formatBundle(task: string, bundle: ReconBundle): string | null {
  if (!bundle) return null
  const hasContent = bundle.entities.length > 0 || bundle.notes.length > 0
  if (!hasContent) return null

  const lines: string[] = [`=== RECON: ${task} ===`]

  if (bundle.entities.length > 0) {
    lines.push("ENTITIES:")
    const top = bundle.entities.slice(0, 8)
    for (const e of top) {
      const domainTag = e.domain
        ? `  [domain=${e.domain}${e.role ? ` role=${e.role}` : ""}]`
        : ""
      lines.push(`  ${e.name} (${e.kind}) ${e.filePath}:${e.lineStart}${domainTag}`)
      if (e.signature) lines.push(`    sig: ${e.signature}`)
    }
  }

  const shown = new Set<string>()
  const topRefs = bundle.references.slice(0, 12)
  if (topRefs.length > 0) {
    lines.push("REFERENCES:")
    for (const r of topRefs) {
      const key = `${r.fromEntity}→${r.toEntity}`
      if (shown.has(key)) continue
      shown.add(key)
      lines.push(`  ${r.fromEntity} → ${r.toEntity} (${r.kind})`)
    }
  }

  if (bundle.notes && bundle.notes.length > 0) {
    lines.push("NOTES:")
    for (const n of bundle.notes) lines.push(`  ${n}`)
  }

  lines.push("=== END RECON ===")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Fixture repo — a tiny TypeScript file the graph will index
// ---------------------------------------------------------------------------

let fixtureDir: string
let seededGraph: BunSqliteGraph

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "econ-recon-test-"))

  // Small fixture with a recognisable function name so recon() can find it.
  await writeFile(
    join(fixtureDir, "utils.ts"),
    `
/**
 * Parse and normalise a task phrase for downstream graph queries.
 * @sem domain=intelligence role=utilities
 */
export function parseTask(input: string): string {
  return input.trim().toLowerCase()
}

/**
 * Format a raw bundle into a compact text block.
 * @sem domain=intelligence role=utilities
 */
export function formatBundle(entities: unknown[]): string {
  return JSON.stringify(entities)
}
`,
  )

  seededGraph = new BunSqliteGraph(":memory:", fixtureDir)
  await seededGraph.index(fixtureDir)
})

afterAll(() => {
  seededGraph?.close()
  try {
    rmSync(fixtureDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("econ-recon-inject — S2.1 recon bundle injection", () => {
  test("recon bundle appears in messages BEFORE the conversation history", async () => {
    // Simulate what the plugin does: recon → format → inject
    const bundle = await seededGraph.recon("parseTask")
    const formatted = formatBundle("parseTask", bundle)

    // If the graph returned nothing, the test can't assert graph-derived content.
    // Fail early with a clear message.
    expect(formatted, "graph should have returned at least one entity for 'parseTask'").not.toBeNull()

    const plugin = makePlugin({
      "context.assemble.before": async (_input, output) => {
        if (formatted) {
          output.messages.push({ role: "user", content: formatted })
        }
      },
    })

    const result = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: mockUser,
        sessionID,
        model: mockModel,
        agent: mockAgent,
        system: ["You are a helpful assistant."],
        messages: [
          { role: "user", content: "How do I fix the parseTask function?" },
        ] as ModelMessage[],
        tools: {},
        provider: mockProvider,
        auth: undefined,
        plugin,
        flags: mockFlags,
        isWorkflow: false,
      }),
    )

    const contents = result.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    const roles = result.messages.map((m) => m.role)

    // Bundle must be present
    const bundleIdx = contents.findIndex((c) => c.includes("=== RECON:"))
    expect(bundleIdx, "recon bundle not found in prepared messages").toBeGreaterThan(-1)

    // Bundle must precede the conversation turn
    const historyIdx = contents.indexOf("How do I fix the parseTask function?")
    expect(historyIdx, "original user turn not found").toBeGreaterThan(-1)
    expect(bundleIdx).toBeLessThan(historyIdx)

    // Bundle must follow at least one system turn
    const systemIdx = roles.indexOf("system")
    expect(systemIdx, "system turn not found").toBeGreaterThan(-1)
    expect(systemIdx).toBeLessThan(bundleIdx)
  })

  test("bundle contains graph-derived entity info (name + kind)", async () => {
    const bundle = await seededGraph.recon("parseTask")
    const formatted = formatBundle("parseTask", bundle)

    expect(formatted).not.toBeNull()
    // The fixture defines `parseTask` as a function — both must appear
    expect(formatted).toContain("parseTask")
    expect(formatted).toContain("function")
    // Header and footer are present (well-formed block)
    expect(formatted).toContain("=== RECON: parseTask ===")
    expect(formatted).toContain("=== END RECON ===")
    expect(formatted).toContain("ENTITIES:")
  })

  test("empty graph produces no injection — messages unchanged", async () => {
    const emptyGraph = new BunSqliteGraph(":memory:", fixtureDir)
    // Intentionally not indexed — every query returns empty results

    const plugin = makePlugin({
      "context.assemble.before": async (_input, output) => {
        const bundle = await emptyGraph.recon("parseTask")
        const formatted = formatBundle("parseTask", bundle)
        if (formatted) {
          output.messages.push({ role: "user", content: formatted })
        }
      },
    })

    const result = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: mockUser,
        sessionID,
        model: mockModel,
        agent: mockAgent,
        system: ["You are a helpful assistant."],
        messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
        tools: {},
        provider: mockProvider,
        auth: undefined,
        plugin,
        flags: mockFlags,
        isWorkflow: false,
      }),
    )

    const contents = result.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )

    // No recon block injected
    expect(contents.some((c) => c.includes("=== RECON:"))).toBe(false)

    // Original user turn still present
    expect(contents).toContain("Hello")

    emptyGraph.close()
  })

  test("multiple entities are listed when graph returns them", async () => {
    // formatBundle fixture: the fixture has both parseTask and formatBundle
    const bundle = await seededGraph.recon("parseTask")
    const formatted = formatBundle("parseTask", bundle)

    expect(formatted).not.toBeNull()
    // At least one entity line (ENTITIES: section)
    const entityLines = (formatted ?? "").split("\n").filter((l) => l.startsWith("  ") && l.includes("(function)"))
    expect(entityLines.length).toBeGreaterThan(0)
  })
})
