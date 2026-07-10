import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import {
  checkReadDedup,
  clearReadDedup,
  dropReadDedup,
  hashContent,
  seedReadDedup,
  computeContentHash,
} from "@/tool/_shared/read-dedup"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  clearReadDedup()
})

const ctx = {
  sessionID: SessionID.make("ses_dedup_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const readLayer = () =>
  Layer.mergeAll(
    Agent.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

const run = Effect.fn("ReadDedupTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ReadTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadDedupTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const put = Effect.fn("ReadDedupTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

describe("tool.read dedup guard", () => {
  it.live("returns a short notice on a byte-identical repeat read", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "dedup.txt")
      yield* put(filePath, "hello world")

      const first = yield* exec(dir, { filePath })
      expect(first.output).toContain("hello world")
      expect(first.output).not.toContain("[read-dedup]")

      const second = yield* exec(dir, { filePath })
      // L3.2 stub: marker, step provenance, carry-forward steering, escape hatch —
      // never impersonating fresh output.
      expect(second.output).toContain("[read-dedup]")
      expect(second.output).toContain("unchanged since step msg_test")
      expect(second.output).toContain("this exact range")
      expect(second.output).toContain("the file has not been modified")
      expect(second.output).toContain("it may have been summarized; carry facts forward")
      expect(second.output).toContain("force:true")
      expect(second.output).not.toContain("hello world")
    }),
  )

  it.live("force:true bypasses the memo and refreshes it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "dedup.txt")
      yield* put(filePath, "hello world")

      yield* exec(dir, { filePath })
      const deduped = yield* exec(dir, { filePath })
      expect(deduped.output).toContain("[read-dedup]")

      const forced = yield* exec(dir, { filePath, force: true })
      expect(forced.output).toContain("hello world")
      expect(forced.output).not.toContain("[read-dedup]")

      // force refreshed the memo, so the very next plain repeat is deduped again.
      const again = yield* exec(dir, { filePath })
      expect(again.output).toContain("[read-dedup]")
    }),
  )

  it.live("a changed file returns full content and re-arms the memo", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "dedup.txt")
      yield* put(filePath, "version one")

      const first = yield* exec(dir, { filePath })
      expect(first.output).toContain("version one")

      yield* put(filePath, "version two")
      const second = yield* exec(dir, { filePath })
      expect(second.output).toContain("version two")
      expect(second.output).not.toContain("[read-dedup]")

      const third = yield* exec(dir, { filePath })
      expect(third.output).toContain("[read-dedup]")
    }),
  )

  it.live("a different offset/limit range is unaffected by a memoized range", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "dedup.txt")
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(filePath, lines)

      yield* exec(dir, { filePath, offset: 1, limit: 5 })
      const repeat = yield* exec(dir, { filePath, offset: 1, limit: 5 })
      expect(repeat.output).toContain("[read-dedup]")

      const otherRange = yield* exec(dir, { filePath, offset: 6, limit: 5 })
      expect(otherRange.output).toContain("line6")
      expect(otherRange.output).not.toContain("[read-dedup]")
    }),
  )

  it.live("a range that is a strict subset of a prior full read hits with a within-earlier-read notice", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "dedup.txt")
      const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(filePath, lines)

      yield* exec(dir, { filePath })
      const slice = yield* exec(dir, { filePath, offset: 10, limit: 15 })
      expect(slice.output).toContain("[read-dedup]")
      expect(slice.output).toContain("unchanged since step msg_test")
      expect(slice.output).toContain("already delivered within an earlier read")
      expect(slice.output).toContain("lines 1-50")
      expect(slice.output).toContain("carry facts forward")
      expect(slice.output).toContain("force:true")
      expect(slice.output).not.toContain("line10:")
    }),
  )
})

describe("read-dedup range containment", () => {
  test("a strict subset of an already-delivered range hits, not exact", () => {
    clearReadDedup()
    const hash = hashContent("whole file content")
    const full = checkReadDedup({ sessionID: "ses_subset", filePath: "/tmp/subset.txt", start: 1, end: 2001, fileHash: hash })
    expect(full.hit).toBe(false)

    const slice = checkReadDedup({ sessionID: "ses_subset", filePath: "/tmp/subset.txt", start: 10, end: 25, fileHash: hash })
    expect(slice.hit).toBe(true)
    expect(slice.exact).toBe(false)
    expect(slice.covering).toEqual({ start: 1, end: 2001 })
  })

  test("an exact repeat is the subset special case and reports exact:true", () => {
    clearReadDedup()
    const hash = hashContent("whole file content")
    checkReadDedup({ sessionID: "ses_exact", filePath: "/tmp/exact.txt", start: 1, end: 50, fileHash: hash })

    const repeat = checkReadDedup({ sessionID: "ses_exact", filePath: "/tmp/exact.txt", start: 1, end: 50, fileHash: hash })
    expect(repeat.hit).toBe(true)
    expect(repeat.exact).toBe(true)
  })

  test("a disjoint range misses", () => {
    clearReadDedup()
    const hash = hashContent("whole file content")
    checkReadDedup({ sessionID: "ses_disjoint", filePath: "/tmp/disjoint.txt", start: 1, end: 50, fileHash: hash })

    const disjoint = checkReadDedup({ sessionID: "ses_disjoint", filePath: "/tmp/disjoint.txt", start: 100, end: 150, fileHash: hash })
    expect(disjoint.hit).toBe(false)
  })

  test("a range that partially overlaps but is not fully contained misses", () => {
    clearReadDedup()
    const hash = hashContent("whole file content")
    checkReadDedup({ sessionID: "ses_overlap", filePath: "/tmp/overlap.txt", start: 1, end: 100, fileHash: hash })

    const overlap = checkReadDedup({ sessionID: "ses_overlap", filePath: "/tmp/overlap.txt", start: 80, end: 150, fileHash: hash })
    expect(overlap.hit).toBe(false)
  })
})

describe("read-dedup step provenance (L3.2)", () => {
  test("a hit returns the messageID of the step that delivered the covering range, not the repeat's", () => {
    clearReadDedup()
    const hash = hashContent("whole file content")
    checkReadDedup({
      sessionID: "ses_prov",
      filePath: "/tmp/prov.txt",
      start: 1,
      end: 100,
      fileHash: hash,
      messageID: "msg_delivered",
    })

    const repeat = checkReadDedup({
      sessionID: "ses_prov",
      filePath: "/tmp/prov.txt",
      start: 10,
      end: 20,
      fileHash: hash,
      messageID: "msg_repeat",
    })
    expect(repeat.hit).toBe(true)
    expect(repeat.messageID).toBe("msg_delivered")
  })
})

describe("read-dedup truncated-prior-result guard (L3.2)", () => {
  // A stub pointing at a budget/ceiling-truncated result is a trap: the session
  // wrapper (session/tools.ts) calls dropReadDedup when it cuts a read result, so
  // the memo forgets the range the model never fully saw.
  test("dropReadDedup: the next identical read misses (fresh re-delivery), then re-arms", () => {
    clearReadDedup()
    const hash = hashContent("whole file content")
    checkReadDedup({
      sessionID: "ses_trunc",
      filePath: "/tmp/trunc.txt",
      start: 1,
      end: 200,
      fileHash: hash,
      messageID: "msg_truncated",
    })

    dropReadDedup("ses_trunc", "/tmp/trunc.txt")

    const fresh = checkReadDedup({
      sessionID: "ses_trunc",
      filePath: "/tmp/trunc.txt",
      start: 1,
      end: 200,
      fileHash: hash,
      messageID: "msg_fresh",
    })
    expect(fresh.hit).toBe(false)

    // The fresh (untruncated) delivery re-armed the memo with its own provenance.
    const repeat = checkReadDedup({
      sessionID: "ses_trunc",
      filePath: "/tmp/trunc.txt",
      start: 1,
      end: 200,
      fileHash: hash,
      messageID: "msg_later",
    })
    expect(repeat.hit).toBe(true)
    expect(repeat.messageID).toBe("msg_fresh")
  })

  test("dropReadDedup is per-file: other files in the session keep their ranges", () => {
    clearReadDedup()
    const hash = hashContent("whole file content")
    checkReadDedup({ sessionID: "ses_perfile", filePath: "/tmp/a.txt", start: 1, end: 50, fileHash: hash })
    checkReadDedup({ sessionID: "ses_perfile", filePath: "/tmp/b.txt", start: 1, end: 50, fileHash: hash })

    dropReadDedup("ses_perfile", "/tmp/a.txt")

    expect(
      checkReadDedup({ sessionID: "ses_perfile", filePath: "/tmp/b.txt", start: 1, end: 50, fileHash: hash }).hit,
    ).toBe(true)
    // /tmp/a.txt was dropped: this call misses (and re-records).
    expect(
      checkReadDedup({ sessionID: "ses_perfile", filePath: "/tmp/a.txt", start: 1, end: 50, fileHash: hash }).hit,
    ).toBe(false)
  })
})

describe("read-dedup fileHash re-arm", () => {
  test("a changed fileHash drops every stored range for that path and misses", () => {
    clearReadDedup()
    const hashA = hashContent("version one")
    const hashB = hashContent("version two")
    checkReadDedup({ sessionID: "ses_rearm", filePath: "/tmp/rearm.txt", start: 1, end: 50, fileHash: hashA })

    const changed = checkReadDedup({ sessionID: "ses_rearm", filePath: "/tmp/rearm.txt", start: 1, end: 50, fileHash: hashB })
    expect(changed.hit).toBe(false)

    // Re-armed with the new hash — the very next repeat hits again.
    const repeat = checkReadDedup({ sessionID: "ses_rearm", filePath: "/tmp/rearm.txt", start: 1, end: 50, fileHash: hashB })
    expect(repeat.hit).toBe(true)
    expect(repeat.exact).toBe(true)
  })
})

describe("read-dedup memo TTL invalidation", () => {
  test("a repeat read within the TTL window hits", () => {
    clearReadDedup()
    const now = Date.now()
    const hash = hashContent("hello world")
    const first = checkReadDedup({ sessionID: "ses_ttl", filePath: "/tmp/a.txt", start: 1, end: 2001, fileHash: hash, now })
    expect(first.hit).toBe(false)

    const second = checkReadDedup({
      sessionID: "ses_ttl",
      filePath: "/tmp/a.txt",
      start: 1,
      end: 2001,
      fileHash: hash,
      now: now + 1_000,
    })
    expect(second.hit).toBe(true)
  })

  test("a repeat read past the TTL window misses and re-arms — the compaction fallback", () => {
    clearReadDedup()
    const now = Date.now()
    const hash = hashContent("hello world")
    checkReadDedup({ sessionID: "ses_ttl", filePath: "/tmp/b.txt", start: 1, end: 2001, fileHash: hash, now })

    const afterTtl = now + 30 * 60 * 1000 + 1
    const expired = checkReadDedup({
      sessionID: "ses_ttl",
      filePath: "/tmp/b.txt",
      start: 1,
      end: 2001,
      fileHash: hash,
      now: afterTtl,
    })
    expect(expired.hit).toBe(false)

    const rearmed = checkReadDedup({
      sessionID: "ses_ttl",
      filePath: "/tmp/b.txt",
      start: 1,
      end: 2001,
      fileHash: hash,
      now: afterTtl + 1_000,
    })
    expect(rearmed.hit).toBe(true)
  })
})

describe("read-dedup force bypass", () => {
  test("force:true bypasses the hit check but still records the range", () => {
    clearReadDedup()
    const hash = hashContent("hello world")
    checkReadDedup({ sessionID: "ses_force", filePath: "/tmp/force.txt", start: 1, end: 50, fileHash: hash })

    const forced = checkReadDedup({
      sessionID: "ses_force",
      filePath: "/tmp/force.txt",
      start: 1,
      end: 50,
      fileHash: hash,
      force: true,
    })
    expect(forced.hit).toBe(false)

    const again = checkReadDedup({ sessionID: "ses_force", filePath: "/tmp/force.txt", start: 1, end: 50, fileHash: hash })
    expect(again.hit).toBe(true)
  })
})

describe("read-dedup session-wide LRU cap", () => {
  test("the oldest range is evicted once the session exceeds the ~200 cap", () => {
    clearReadDedup()
    const hash = hashContent("hello world")
    const sessionID = "ses_lru"

    // Fill the memo with 200 disjoint ranges across distinct files — right at the cap.
    for (let i = 0; i < 200; i++) {
      checkReadDedup({ sessionID, filePath: `/tmp/lru-${i}.txt`, start: 1, end: 10, fileHash: hash })
    }

    // Still under/at the cap — the first range is still a hit, and touching it
    // moves it to the MRU end.
    const stillHit = checkReadDedup({ sessionID, filePath: "/tmp/lru-0.txt", start: 1, end: 10, fileHash: hash })
    expect(stillHit.hit).toBe(true)

    // One more distinct range pushes the session over the cap, evicting the new LRU tail.
    checkReadDedup({ sessionID, filePath: "/tmp/lru-200.txt", start: 1, end: 10, fileHash: hash })

    const evicted = checkReadDedup({ sessionID, filePath: "/tmp/lru-1.txt", start: 1, end: 10, fileHash: hash })
    expect(evicted.hit).toBe(false)
  })
})

describe("read-dedup seed-from-write", () => {
  test("seeding from content and hashing the same content the way read.ts would agree — a subset range hits", () => {
    clearReadDedup()
    const content = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n")
    seedReadDedup({ sessionID: "ses_seed_subset", filePath: "/tmp/seed-subset.txt", content })

    const { fileHash } = computeContentHash(content)
    const slice = checkReadDedup({
      sessionID: "ses_seed_subset",
      filePath: "/tmp/seed-subset.txt",
      start: 5,
      end: 10,
      fileHash,
    })
    expect(slice.hit).toBe(true)
    expect(slice.exact).toBe(false)
  })

  test("a seeded write misses on a subsequent read of genuinely different content", () => {
    clearReadDedup()
    seedReadDedup({ sessionID: "ses_seed_diff", filePath: "/tmp/seed-diff.txt", content: "version one\nline two" })

    const changedHash = computeContentHash("version two\nline two").fileHash
    const check = checkReadDedup({
      sessionID: "ses_seed_diff",
      filePath: "/tmp/seed-diff.txt",
      start: 1,
      end: 3,
      fileHash: changedHash,
    })
    expect(check.hit).toBe(false)
  })

  test("TTL still applies to a seeded range", () => {
    clearReadDedup()
    const content = "hello\nworld"
    const now = Date.now()
    seedReadDedup({ sessionID: "ses_seed_ttl", filePath: "/tmp/seed-ttl.txt", content, now })

    const { fileHash } = computeContentHash(content)
    const afterTtl = now + 30 * 60 * 1000 + 1
    const expired = checkReadDedup({
      sessionID: "ses_seed_ttl",
      filePath: "/tmp/seed-ttl.txt",
      start: 1,
      end: 2,
      fileHash,
      now: afterTtl,
    })
    expect(expired.hit).toBe(false)
  })

  test("content that would trip read.ts's own byte cap is not seeded", () => {
    clearReadDedup()
    const bigContent = Array.from({ length: 5000 }, (_, i) => `line number ${i} of the big file`).join("\n")
    expect(computeContentHash(bigContent).exceedsReadCap).toBe(true)

    seedReadDedup({ sessionID: "ses_seed_cap", filePath: "/tmp/seed-cap.txt", content: bigContent })

    // If seeding had (wrongly) stored a range, this matching-hash check on a
    // tiny subset would hit. Since the cap trips, nothing was stored.
    const { fileHash } = computeContentHash(bigContent)
    const check = checkReadDedup({
      sessionID: "ses_seed_cap",
      filePath: "/tmp/seed-cap.txt",
      start: 1,
      end: 5,
      fileHash,
    })
    expect(check.hit).toBe(false)
  })

  it.live("a write-seeded file hits on a real subset read through the read tool", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "seeded.txt")
      const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(filePath, content)
      seedReadDedup({ sessionID: ctx.sessionID, filePath, content })

      const slice = yield* exec(dir, { filePath, offset: 5, limit: 5 })
      expect(slice.output).toContain("[read-dedup]")
      expect(slice.output).not.toContain("line5:")
    }),
  )
})
