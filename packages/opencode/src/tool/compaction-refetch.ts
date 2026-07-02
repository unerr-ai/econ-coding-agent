import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import DESCRIPTION from "./compaction-refetch.txt"

// AC-6.2: line-range slicing shares read.ts's 1-indexed, inclusive convention
// (`offset`/`limit` there) so a caller already used to that tool doesn't have
// to learn a second convention here.
export const Parameters = Schema.Struct({
  messageID: Schema.String.annotate({
    description: "The messageID from a `[pointer: session/message/part]` hint in a masked or compacted tool result.",
  }),
  partID: Schema.String.annotate({
    description: "The partID from the same pointer.",
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

// AC-6.2 — recoverable transcript: the model-facing counterpart to the
// {sessionID, messageID, partID} pointers maskObservations()/prune() leave
// behind. The raw text is never deleted, only hidden from context, so this
// tool is the surgical, read-only path back to it.
export const CompactionRefetchTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "compaction_refetch",
  Effect.gen(function* () {
    const session = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const part = yield* session.getPart({
            sessionID: ctx.sessionID,
            messageID: MessageID.make(params.messageID),
            partID: PartID.make(params.partID),
          })

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
            output: body,
            metadata: { chars: body.length, lines: lines.length, sliced },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
