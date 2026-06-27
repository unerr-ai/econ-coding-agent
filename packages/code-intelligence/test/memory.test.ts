/**
 * Unit tests for memory.ts: parseSentinels and InMemoryMemoryStore.
 */

import { describe, it, expect } from "bun:test"
import {
  parseSentinels,
  InMemoryMemoryStore,
} from "./../src/memory.js"
import type { AnchoredNote } from "./../src/memory.js"

// ---------------------------------------------------------------------------
// parseSentinels
// ---------------------------------------------------------------------------

describe("parseSentinels", () => {
  it("parses a well-formed sentinel line", () => {
    const text = "unerr-save: note wrn|f:src/x.ts|-|do not mock the db"
    const notes = parseSentinels(text)
    expect(notes).toHaveLength(1)
    const note = notes[0]!
    expect(note.kind).toBe("wrn")
    expect(note.anchor).toBe("f:src/x.ts")
    expect(note.polarity).toBe("-")
    expect(note.content).toBe("do not mock the db")
  })

  it("preserves pipe characters inside the content field", () => {
    const text = "unerr-save: note fct|e:SomeClass|+|content with | a pipe inside"
    const notes = parseSentinels(text)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toBe("content with | a pipe inside")
  })

  it("returns [] for a non-sentinel line", () => {
    const notes = parseSentinels("just a regular log line")
    expect(notes).toHaveLength(0)
  })

  it("returns [] for an empty string", () => {
    expect(parseSentinels("")).toHaveLength(0)
  })

  it("ignores lines with an unknown kind", () => {
    const notes = parseSentinels("unerr-save: note xyz|f:src/a.ts|+|content")
    expect(notes).toHaveLength(0)
  })

  it("ignores lines with an invalid polarity", () => {
    const notes = parseSentinels("unerr-save: note cnv|f:src/a.ts|?|content")
    expect(notes).toHaveLength(0)
  })

  it("parses multiple sentinel lines in a single block of text", () => {
    const text = [
      "some preamble",
      "unerr-save: note rul|f:src/b.ts|-|no shell reads",
      "middle line",
      "unerr-save: note dec|e:Router|+|always escalate on risk > 80",
    ].join("\n")
    const notes = parseSentinels(text)
    expect(notes).toHaveLength(2)
    expect(notes[0]!.kind).toBe("rul")
    expect(notes[1]!.kind).toBe("dec")
  })
})

// ---------------------------------------------------------------------------
// InMemoryMemoryStore
// ---------------------------------------------------------------------------

describe("InMemoryMemoryStore", () => {
  it("round-trips: save then recallForAnchors returns the note", async () => {
    const store = new InMemoryMemoryStore()
    const note: AnchoredNote = {
      kind: "wrn",
      anchor: "f:src/x.ts",
      polarity: "-",
      content: "do not mock the db",
    }
    await store.save(note)
    const recalled = await store.recallForAnchors(["f:src/x.ts"])
    expect(recalled).toHaveLength(1)
    expect(recalled[0]).toEqual(note)
  })

  it("recallForAnchors filters by anchor — unrelated anchors not returned", async () => {
    const store = new InMemoryMemoryStore()
    await store.save({ kind: "fct", anchor: "f:src/a.ts", polarity: "+", content: "fact A" })
    await store.save({ kind: "fct", anchor: "f:src/b.ts", polarity: "+", content: "fact B" })
    const recalled = await store.recallForAnchors(["f:src/a.ts"])
    expect(recalled).toHaveLength(1)
    expect(recalled[0]!.content).toBe("fact A")
  })

  it("recallForAnchors returns [] when no anchors match", async () => {
    const store = new InMemoryMemoryStore()
    await store.save({ kind: "cnv", anchor: "f:src/c.ts", polarity: "~", content: "mixed" })
    const recalled = await store.recallForAnchors(["f:src/other.ts"])
    expect(recalled).toHaveLength(0)
  })

  it("captureRule returns null (stub)", () => {
    const store = new InMemoryMemoryStore()
    expect(store.captureRule("always use X")).toBeNull()
  })
})
