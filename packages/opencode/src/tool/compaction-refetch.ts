import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import DESCRIPTION from "./compaction-refetch.txt"

// AC-6.2: line-range slicing shares read.ts's 1-indexed, inclusive convention
// (`offset`/`limit` there) so a caller already used to that tool doesn't have
// to learn a second convention here.
export const Parameters = Schema.Struct({
  messageID: Schema.optional(Schema.String).annotate({
    description:
      "The messageID from a `[pointer: session/message/part]` hint in a masked or compacted tool result. Omit together with partID to fall back to the most recently masked tool output in this session.",
  }),
  partID: Schema.optional(Schema.String).annotate({
    description:
      "The partID from the same pointer. Omit together with messageID to fall back to the most recently masked tool output in this session.",
  }),
  startLine: Schema.optional(NonNegativeInt).annotate({
    description: "Optional 1-indexed start line (inclusive) to slice the retained body instead of returning it whole.",
  }),
  endLine: Schema.optional(NonNegativeInt).annotate({
    description: "Optional 1-indexed end line (inclusive) to slice the retained body instead of returning it whole.",
  }),
})

type Metadata = {
  chars: number
  lines: number
  sliced: boolean
}

const NO_MASKED_OUTPUT_MESSAGE =
  "No pointer given, and nothing is masked in this session yet. Pass the {messageID, partID} pair from a `[pointer: session/message/part]` hint in a masked or compacted tool result, or call again once a tool result has been masked."

// A masked tool part is one still `completed` whose output a compaction pass
// replaced with a synthesis, retaining the raw body under `state.metadata.masked`.
function isMaskedToolPart(part: SessionV1.Part): part is SessionV1.ToolPart {
  return part.type === "tool" && part.state.status === "completed" && !!part.state.metadata?.masked
}

// AC-6.2 — recoverable transcript: the model-facing counterpart to the
// {sessionID, messageID, partID} pointers maskObservations()/prune() leave
// behind. The raw text is never deleted, only hidden from context, so this
// tool is the surgical, read-only path back to it. A call with no pointer
// degrades gracefully to the most recently masked output instead of erroring,
// so a caller that fails to parse the pointer format still recovers context
// instead of falling back to an expensive re-run.
export const CompactionRefetchTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "compaction_refetch",
  Effect.gen(function* () {
    const session = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          let part: SessionV1.Part | undefined
          let prefix = ""

          if (params.messageID !== undefined && params.partID !== undefined) {
            part = yield* session.getPart({
              sessionID: ctx.sessionID,
              messageID: MessageID.make(params.messageID),
              partID: PartID.make(params.partID),
            })
          } else {
            const found = yield* session.findMessage(ctx.sessionID, (msg) => msg.parts.some(isMaskedToolPart))
            if (Option.isNone(found)) {
              return {
                title: "no masked output yet",
                output: NO_MASKED_OUTPUT_MESSAGE,
                metadata: { chars: 0, lines: 0, sliced: false },
              }
            }
            const masked = found.value.parts.filter(isMaskedToolPart)
            part = masked.at(-1)
            if (part) {
              prefix = `[econ-ctx] no pointer given — resolved to most recent masked output: ${part.messageID}/${part.id} (${part.tool})\n`
            }
          }

          if (!part || part.type !== "tool" || part.state.status !== "completed") {
            return {
              title: "no retained body",
              output:
                "No retained raw output for that pointer — the part may not exist in this session, may still be pending, or the pointer is wrong.",
              metadata: { chars: 0, lines: 0, sliced: false },
            }
          }

          const raw = (part.state.metadata?.masked as { raw?: string } | undefined)?.raw ?? part.state.output
          const lines = raw.split("\n")
          const sliced = params.startLine !== undefined || params.endLine !== undefined
          const body = sliced
            ? lines.slice(params.startLine ? params.startLine - 1 : 0, params.endLine ?? lines.length).join("\n")
            : raw

          return {
            title: `${part.tool} (retained, ${body.length} chars)`,
            output: prefix + body,
            metadata: { chars: body.length, lines: lines.length, sliced },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
