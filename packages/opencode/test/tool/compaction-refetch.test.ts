import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { CompactionRefetchTool } from "@/tool/compaction-refetch"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.buildLayer(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])),
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const addAssistant = Effect.fn("Test.addAssistant")(function* (sessionID: SessionID) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: id,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Info)
  return id
})

function toolPartBase(input: { id: PartID; sessionID: SessionID; messageID: MessageID; tool: string; output: string }) {
  return {
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool" as const,
    callID: `call_${input.id}`,
    tool: input.tool,
    state: {
      status: "completed" as const,
      input: {},
      output: input.output,
      title: input.tool,
      metadata: {} as Record<string, unknown>,
      time: { start: Date.now(), end: Date.now() },
    },
  }
}

const addToolPart = Effect.fn("Test.addToolPart")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  tool: string
  output: string
}) {
  const session = yield* SessionNs.Service
  const id = PartID.ascending()
  yield* session.updatePart(toolPartBase({ id, ...input }) as unknown as SessionV1.Part)
  return id
})

// A masked tool part: `state.output` holds the compaction synthesis, while
// `state.metadata.masked.raw` retains the original body — the shape
// compaction.ts's masking pass leaves behind for compaction_refetch to read.
const addMaskedToolPart = Effect.fn("Test.addMaskedToolPart")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  tool: string
  raw: string
}) {
  const session = yield* SessionNs.Service
  const id = PartID.ascending()
  const part = toolPartBase({
    id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    tool: input.tool,
    output: `${input.tool} (masked synthesis)`,
  })
  part.state.metadata = {
    masked: {
      at: Date.now(),
      rawChars: input.raw.length,
      pointer: { sessionID: input.sessionID, messageID: input.messageID, partID: id },
      raw: input.raw,
    },
  }
  yield* session.updatePart(part as unknown as SessionV1.Part)
  return id
})

function makeCtx(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

const runRefetch = Effect.fn("Test.runRefetch")(function* (
  sessionID: SessionID,
  params: { messageID?: string; partID?: string; startLine?: number; endLine?: number },
) {
  const info = yield* CompactionRefetchTool
  const def = yield* info.init()
  return yield* def.execute(params, makeCtx(sessionID))
})

describe("compaction_refetch", () => {
  it.instance("explicit pointer path is unchanged", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const msgID = yield* addAssistant(sessionID)
        const partID = yield* addToolPart({
          sessionID,
          messageID: msgID,
          tool: "read",
          output: "line1\nline2\nline3",
        })

        const result = yield* runRefetch(sessionID, { messageID: msgID, partID })

        expect(result.output).toBe("line1\nline2\nline3")
        expect(result.metadata).toMatchObject({ chars: 17, lines: 3, sliced: false })
      }),
    ),
  )

  it.instance("argless call resolves the most recently masked part", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const msg1 = yield* addAssistant(sessionID)
        yield* addMaskedToolPart({ sessionID, messageID: msg1, tool: "grep", raw: "OLDER MASKED OUTPUT" })

        const msg2 = yield* addAssistant(sessionID)
        yield* addMaskedToolPart({ sessionID, messageID: msg2, tool: "grep", raw: "FIRST MASKED PART IN MSG2" })
        const lastPartID = yield* addMaskedToolPart({
          sessionID,
          messageID: msg2,
          tool: "read",
          raw: "LAST MASKED PART IN MSG2\nsecond line",
        })

        const result = yield* runRefetch(sessionID, {})

        expect(result.output).toContain(
          `[econ-ctx] no pointer given — resolved to most recent masked output: ${msg2}/${lastPartID} (read)`,
        )
        expect(result.output.endsWith("LAST MASKED PART IN MSG2\nsecond line")).toBe(true)
      }),
    ),
  )

  it.instance("argless call with nothing masked returns a usage message, not an error", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const msgID = yield* addAssistant(sessionID)
        yield* addToolPart({ sessionID, messageID: msgID, tool: "read", output: "not masked, not retained" })

        const result = yield* runRefetch(sessionID, {})

        expect(result.output).toContain("messageID")
        expect(result.output).toContain("partID")
        expect(result.output.toLowerCase()).toContain("nothing is masked")
        expect(result.metadata).toMatchObject({ chars: 0, lines: 0, sliced: false })
      }),
    ),
  )

  it.instance("slicing works in argless mode too", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const msgID = yield* addAssistant(sessionID)
        yield* addMaskedToolPart({
          sessionID,
          messageID: msgID,
          tool: "grep",
          raw: "line1\nline2\nline3\nline4",
        })

        const result = yield* runRefetch(sessionID, { startLine: 2, endLine: 3 })

        expect(result.output.endsWith("line2\nline3")).toBe(true)
        expect(result.metadata).toMatchObject({ sliced: true, lines: 4 })
      }),
    ),
  )
})
