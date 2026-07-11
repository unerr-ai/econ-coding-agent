export * as SessionProjector from "./projector"

import { and, desc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { LayerNode } from "../effect/layer-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { SessionContextEpoch } from "./context-epoch"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./sql"
import type { DeepMutable } from "../schema"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const encodeAssistantContent = Schema.encodeSync(SessionMessage.AssistantContent)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ?? null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

// Effect Schema's throwing Sync codecs raise a bare SchemaError for any shape a
// model/gateway emits that this message schema rejects. A defect here would kill
// the whole projection run, so every codec call site below treats encode/decode
// failure as data to log and route around, never as a crash.
function formatSchemaFailure(cause: unknown): string {
  if (
    cause &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof (cause as { message: unknown }).message === "string"
  )
    return (cause as { message: string }).message
  return String(cause)
}

function salvageMessage(event: SessionEvent.Event, message: SessionMessage.Message) {
  if (message.type === "assistant" && message.content.length > 0) {
    const originalLength = message.content.length
    const kept = message.content.filter((part) => {
      try {
        encodeAssistantContent(part)
        return true
      } catch {
        return false
      }
    })
    if (kept.length < originalLength) {
      // Reassign in place rather than `{ ...message, content: kept }`: the encoder
      // dispatches on class identity, and spreading a Schema.Class instance into a
      // plain object loses the `instanceof` it needs, failing encode all over again.
      ;(message as unknown as { content: typeof kept }).content = kept
      try {
        const encoded = encodeMessage(message)
        return Effect.logError("session message salvaged by dropping unencodable content parts").pipe(
          Effect.annotateLogs({
            sessionID: event.data.sessionID,
            messageID: message.id,
            type: message.type,
            dropped: originalLength - kept.length,
          }),
          Effect.as(encoded),
        )
      } catch (cause) {
        return Effect.logError(
          "session message unsalvageable even with unencodable content parts dropped, skipping persist",
        ).pipe(
          Effect.annotateLogs({
            sessionID: event.data.sessionID,
            messageID: message.id,
            type: message.type,
            reason: formatSchemaFailure(cause),
          }),
          Effect.as(undefined),
        )
      }
    }
  }
  return Effect.logError("session message unsalvageable, skipping persist").pipe(
    Effect.annotateLogs({ sessionID: event.data.sessionID, messageID: message.id, type: message.type }),
    Effect.as(undefined),
  )
}

function encodeMessageSafe(event: SessionEvent.Event, message: SessionMessage.Message) {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(encodeMessage(message))
    } catch (cause) {
      return Effect.logError("session message failed to encode, attempting salvage").pipe(
        Effect.annotateLogs({
          sessionID: event.data.sessionID,
          messageID: message.id,
          type: message.type,
          reason: formatSchemaFailure(cause),
        }),
        Effect.andThen(() => salvageMessage(event, message)),
      )
    }
  })
}

function decodeRowSafe(event: SessionEvent.Event, row: typeof SessionMessageTable.$inferSelect) {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(decodeMessage({ ...row.data, id: row.id, type: row.type }))
    } catch (cause) {
      return Effect.logError("session message row failed to decode, skipping row").pipe(
        Effect.annotateLogs({
          sessionID: event.data.sessionID,
          messageID: row.id,
          type: row.type,
          reason: formatSchemaFailure(cause),
        }),
        Effect.as(undefined),
      )
    }
  })
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const updateMessage = (message: SessionMessage.Message) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        const encoded = yield* encodeMessageSafe(event, message)
        if (!encoded) return
        const { id, type, ...data } = encoded
        yield* db
          .update(SessionMessageTable)
          .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
          .where(
            and(
              eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
              eq(SessionMessageTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      })
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = yield* decodeRowSafe(event, row)
          return message?.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = yield* decodeRowSafe(event, row)
          return message?.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          const messages = yield* Effect.forEach(rows, (row) => decodeRowSafe(event, row))
          return messages.find(
            (message): message is SessionMessage.Shell => message?.type === "shell" && message.callID === callID,
          )
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

export function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  return Effect.gen(function* () {
    if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
    const encoded = yield* encodeMessageSafe(event, message)
    if (!encoded) return
    const { id, type, ...data } = encoded
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: event.data.sessionID,
        type,
        seq: event.durable.seq,
        time_created: DateTime.toEpochMillis(message.time.created),
        data,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = LayerNode.make(layer, [EventV2.node, Database.node])
