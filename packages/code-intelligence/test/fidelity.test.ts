/**
 * S2.5 fidelity-gate regression set.
 *
 * Verifies three things:
 *  1. assessFidelity correctly detects surviving vs. missing answer keys.
 *  2. gateCompression returns the compressed output when all keys survive
 *     (gate green) and returns the original when any key is missing (gate red).
 *  3. Each sibling compressor (trim.ts / BM25 / prune.ts) is exercised with
 *     real answer keys — normal compression keeps every key; a deliberately
 *     too-aggressive compression is correctly REJECTED by the gate.
 */

import { describe, it, expect } from "bun:test"
import { assessFidelity, gateCompression } from "../src/fidelity.ts"
import { smartTruncate } from "../src/trim.ts"
import { splitMarkdownIntoPassages } from "../src/webfetch/passage-split.ts"
import { rankPassagesByPrompt } from "../src/webfetch/bm25.ts"
import { pruneWindow } from "../src/prune.ts"
import type { Message, TextPart, ToolPart } from "../src/prune.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Join passage texts for serialisation in gate calls. */
function passagesToText(passages: ReturnType<typeof splitMarkdownIntoPassages>): string {
  return passages.map((p) => (p.heading ? `# ${p.heading}\n${p.text}` : p.text)).join("\n\n")
}

/** Serialise all message content (text parts + tool outputs) for fidelity checking. */
function messagesToText(messages: Message[]): string {
  return messages
    .flatMap((m) =>
      m.parts.map((p) => {
        if (p.type === "text") return (p as TextPart).text
        if (p.type === "tool") {
          const tp = p as ToolPart
          return typeof tp.state.output === "string" ? tp.state.output : ""
        }
        return ""
      }),
    )
    .filter(Boolean)
    .join("\n")
}

let _id = 0
function nextId(): string {
  return `fid_${String(++_id).padStart(4, "0")}`
}

function userMsg(text: string): Message {
  return {
    info: { id: nextId(), role: "user" },
    parts: [{ type: "text", text } satisfies TextPart],
  }
}

function assistantText(text: string): Message {
  return {
    info: { id: nextId(), role: "assistant" },
    parts: [{ type: "text", text } satisfies TextPart],
  }
}

function toolCall(tool: string, input: Record<string, unknown>, output: string): Message {
  const part: ToolPart = {
    type: "tool",
    callID: `call_${nextId()}`,
    tool,
    state: { status: "completed", input, output, title: tool },
  }
  return {
    info: { id: nextId(), role: "assistant" },
    parts: [part],
  }
}

// ---------------------------------------------------------------------------
// assessFidelity — unit cases
// ---------------------------------------------------------------------------

describe("assessFidelity — no keys", () => {
  it("reports kept:true and correct tokensSaved when no keys are required", () => {
    const before = "The quick brown fox jumps over the lazy dog"
    const after = "The quick brown fox"
    const verdict = assessFidelity({ before, after })
    expect(verdict.kept).toBe(true)
    expect(verdict.fidelityScore).toBe(1.0)
    expect(verdict.missing).toEqual([])
    expect(verdict.tokensSaved).toBeGreaterThan(0)
  })
})

describe("assessFidelity — all keys present", () => {
  it("reports kept:true when all keys survive", () => {
    const before = "Error: ENOENT at line 42 in config.ts"
    const after = "Error: ENOENT at line 42 in config.ts"
    const verdict = assessFidelity({ before, after, answerKey: ["ENOENT", "line 42"] })
    expect(verdict.kept).toBe(true)
    expect(verdict.fidelityScore).toBe(1.0)
    expect(verdict.missing).toEqual([])
  })
})

describe("assessFidelity — key missing", () => {
  it("reports kept:false and lists the missing key", () => {
    const before = "Error: ENOENT at line 42 in config.ts — see AUTH_SECRET"
    const after = "Error: ENOENT at line 42 in config.ts"
    const verdict = assessFidelity({ before, after, answerKey: ["ENOENT", "AUTH_SECRET"] })
    expect(verdict.kept).toBe(false)
    expect(verdict.fidelityScore).toBeCloseTo(0.5)
    expect(verdict.missing).toContain("AUTH_SECRET")
    expect(verdict.missing).not.toContain("ENOENT")
  })
})

describe("assessFidelity — both mustContain and answerKey merged", () => {
  it("merges mustContain and answerKey before checking", () => {
    const verdict = assessFidelity({
      before: "alpha beta gamma",
      after: "alpha",
      mustContain: ["alpha"],
      answerKey: ["beta"],
    })
    expect(verdict.kept).toBe(false)
    expect(verdict.missing).toContain("beta")
  })
})

// ---------------------------------------------------------------------------
// gateCompression — gate-pass and gate-reject with a simple string compressor
// ---------------------------------------------------------------------------

describe("gateCompression — gate passes", () => {
  it("returns the compressed output when all answer keys survive", () => {
    // Compressor: keep only the first sentence
    const input = "CRITICAL_KEY survived. Extra noise. More noise."
    const compress = (s: string) => s.split(".")[0]! + "."
    const { output, verdict, degraded } = gateCompression(compress, input, ["CRITICAL_KEY"])
    expect(verdict.kept).toBe(true)
    expect(degraded).toBe(false)
    expect(output).toBe("CRITICAL_KEY survived.")
  })
})

describe("gateCompression — gate rejects (over-aggressive)", () => {
  it("falls back to the original when a key is lost", () => {
    // Compressor drops the key-bearing second sentence
    const input = "Preamble. CRITICAL_KEY is here. Tail."
    const compress = (_s: string) => "Preamble. Tail."
    const { output, verdict, degraded } = gateCompression(compress, input, ["CRITICAL_KEY"])
    expect(verdict.kept).toBe(false)
    expect(degraded).toBe(true)
    expect(output).toBe(input) // original returned, not "Preamble. Tail."
  })
})

// ---------------------------------------------------------------------------
// Regression: trim.ts (smartTruncate)
// ---------------------------------------------------------------------------

/**
 * Build a large synthetic text:
 *   - Head: contains HEAD_SENTINEL
 *   - Middle: contains MIDDLE_SENTINEL
 *   - Tail: contains TAIL_SENTINEL
 */
function buildLargeText(): string {
  const head = `HEAD_SENTINEL: function setup() {\n` + "  const x = 1\n".repeat(20)
  const middle = Array.from({ length: 120 }, (_, i) => `  // filler line ${i}`).join("\n")
  const midSentinel = "\n  // MIDDLE_SENTINEL: the answer is 42\n"
  const tail = "}\n" + "// tail comment\n".repeat(15) + "// TAIL_SENTINEL: exports ready\n"
  return head + middle + midSentinel + middle + tail
}

describe("regression: trim.ts — answer keys in head/tail survive normal compression", () => {
  it("both HEAD and TAIL sentinels survive a moderate budget trim (gate green)", () => {
    const text = buildLargeText()
    // Wrap smartTruncate so it returns a string
    const compressor = (s: string) => smartTruncate(s, { budget: 300 }).text
    const { output, verdict, degraded } = gateCompression(compressor, text, [
      "HEAD_SENTINEL",
      "TAIL_SENTINEL",
    ])
    expect(verdict.kept).toBe(true)
    expect(degraded).toBe(false)
    // The compressed output must be smaller
    expect((output as string).length).toBeLessThan(text.length)
  })
})

describe("regression: trim.ts — over-aggressive compression loses MIDDLE_SENTINEL (gate red)", () => {
  it("gate rejects the save when MIDDLE_SENTINEL is elided (budget=50)", () => {
    const text = buildLargeText()
    // budget=50 is tiny — middle is completely elided
    const compressor = (s: string) => smartTruncate(s, { budget: 50 }).text
    const { verdict, degraded } = gateCompression(compressor, text, [
      "HEAD_SENTINEL",
      "MIDDLE_SENTINEL",
    ])
    // MIDDLE_SENTINEL lives in the elided section — gate must fire
    expect(verdict.kept).toBe(false)
    expect(degraded).toBe(true)
    expect(verdict.missing).toContain("MIDDLE_SENTINEL")
  })
})

// ---------------------------------------------------------------------------
// Regression: webfetch BM25 ranker
// ---------------------------------------------------------------------------

/**
 * Build a small markdown corpus with a clearly relevant passage containing
 * BM25_TARGET_PHRASE, plus several irrelevant sections.
 */
function buildMarkdownCorpus(): string {
  return `
# Introduction
This document covers the general setup and installation of the software.
Installation is straightforward. Follow the steps in the README to get started.
The software supports multiple platforms and is widely deployed in production.

# Configuration
Configuration is done via environment variables. Set the required keys before
starting the server. The configuration file supports YAML and JSON formats.
Refer to the documentation for the full list of supported options and defaults.

# BM25_TARGET_PHRASE: Ranking Algorithm Details
BM25 is a probabilistic ranking function used in full-text search engines.
It extends TF-IDF by normalising for document length. The BM25 score is
computed per term as IDF multiplied by a TF normalisation factor. Parameters
k1 (typically 1.5) and b (typically 0.75) control term-frequency saturation
and length normalisation respectively. This section contains the answer.

# Error Handling
Handle errors by wrapping calls in try/catch blocks. Implement exponential
back-off for retries. Log all errors with a correlation ID so they can be
traced across distributed systems. Never swallow errors silently.

# Testing
Use mock adapters in test environments to avoid real network calls. Reset
state between tests to prevent leakage. Integration tests should run against
a dedicated test tenant. Measure coverage but don't treat it as the only goal.
`.trim()
}

describe("regression: BM25 — query-relevant passage with BM25_TARGET_PHRASE survives (gate green)", () => {
  it("top-3 passages include BM25_TARGET_PHRASE when ranked by relevant query", () => {
    const markdown = buildMarkdownCorpus()
    const passages = splitMarkdownIntoPassages(markdown)

    const compressor = (ps: typeof passages) =>
      rankPassagesByPrompt(ps, { prompt: "BM25 ranking algorithm details", topK: 3 })

    const { verdict, degraded } = gateCompression(compressor, passages, ["BM25_TARGET_PHRASE"], {
      serializeBefore: passagesToText,
      serializeAfter: passagesToText,
    })

    expect(verdict.kept).toBe(true)
    expect(degraded).toBe(false)
  })
})

describe("regression: BM25 — topK=1 with unrelated query loses BM25_TARGET_PHRASE (gate red)", () => {
  it("gate rejects when topK=1 and the returned passage does not contain BM25_TARGET_PHRASE", () => {
    const markdown = buildMarkdownCorpus()
    const passages = splitMarkdownIntoPassages(markdown)

    // Force topK=1 with a query about error handling — wrong section wins
    const compressor = (ps: typeof passages) =>
      rankPassagesByPrompt(ps, { prompt: "error handling retry back-off", topK: 1 })

    const { verdict, degraded } = gateCompression(compressor, passages, ["BM25_TARGET_PHRASE"], {
      serializeBefore: passagesToText,
      serializeAfter: passagesToText,
    })

    // The target phrase lives in the BM25 section, not error-handling → missing
    expect(verdict.kept).toBe(false)
    expect(degraded).toBe(true)
    expect(verdict.missing).toContain("BM25_TARGET_PHRASE")
  })
})

// ---------------------------------------------------------------------------
// Regression: prune.ts (pruneWindow)
// ---------------------------------------------------------------------------

describe("regression: prune.ts — RECENT_FACT in keepLastN messages survives pruning (gate green)", () => {
  it("answer key in a recent message is never dropped", () => {
    // Build a window that is large enough to trigger pruning
    const bigOutput = "x".repeat(3000)
    const oldMessages: Message[] = Array.from({ length: 20 }, (_, i) => [
      userMsg(`user question ${i}`),
      toolCall("read_file", { path: `/file_${i}.ts` }, bigOutput),
    ]).flat()

    // The answer key is in a very recent message (the last one)
    const recentMessages: Message[] = [
      userMsg("What is the answer?"),
      assistantText("RECENT_FACT: the answer is forty-two"),
    ]

    const allMessages = [...oldMessages, ...recentMessages]

    const compressor = (msgs: Message[]) =>
      pruneWindow(msgs, { tokenBudget: 2000, keepLastN: 4 }).messages

    const { verdict, degraded } = gateCompression(compressor, allMessages, ["RECENT_FACT"], {
      serializeBefore: messagesToText,
      serializeAfter: messagesToText,
    })

    expect(verdict.kept).toBe(true)
    expect(degraded).toBe(false)
    expect(verdict.tokensSaved).toBeGreaterThan(0)
  })
})

describe("regression: prune.ts — stale tool output dropped but recent text preserved", () => {
  it("gate stays green when old tool outputs are pruned but recent text survives", () => {
    // Old stale tool output (same tool+input repeated — will be deduped)
    const staleOutput = "x".repeat(2000)
    const oldMessages: Message[] = Array.from({ length: 10 }, () => [
      userMsg("read the config"),
      toolCall("read_file", { path: "/config.ts" }, staleOutput),
    ]).flat()

    const recentMessages: Message[] = [
      userMsg("summarise"),
      assistantText("PRESERVED_KEY: summary complete. Config loaded successfully."),
    ]

    const allMessages = [...oldMessages, ...recentMessages]

    const compressor = (msgs: Message[]) =>
      pruneWindow(msgs, { tokenBudget: 1000, keepLastN: 2 }).messages

    const { verdict, degraded } = gateCompression(compressor, allMessages, ["PRESERVED_KEY"], {
      serializeBefore: messagesToText,
      serializeAfter: messagesToText,
    })

    expect(verdict.kept).toBe(true)
    expect(degraded).toBe(false)
  })
})
