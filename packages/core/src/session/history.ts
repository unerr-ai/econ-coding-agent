import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
const decodeAssistantContentPart = Schema.decodeUnknownEffect(SessionMessage.AssistantContent)

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

// Assistant rows can partially decode when only some content parts are bad;
// dropping just the bad ones (mirrors projector.ts's write-side salvage) saves
// the message instead of the whole row. Any other row type — or an assistant
// row that still fails once pruned — is unsalvageable and the row is skipped.
function salvageMessageRow(row: typeof SessionMessageTable.$inferSelect, reason: string) {
  return Effect.gen(function* () {
    const rawContent = row.type === "assistant" ? (row.data as { content?: unknown } | null)?.content : undefined
    if (!Array.isArray(rawContent) || rawContent.length === 0) {
      yield* Effect.logWarning("session message row unsalvageable, skipping row").pipe(
        Effect.annotateLogs({ sessionID: row.session_id, messageID: row.id, type: row.type, reason }),
      )
      return undefined
    }
    const kept: unknown[] = []
    for (const part of rawContent) {
      const ok = yield* decodeAssistantContentPart(part).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (ok) kept.push(part)
    }
    if (kept.length === rawContent.length) {
      yield* Effect.logWarning("session message row unsalvageable, skipping row").pipe(
        Effect.annotateLogs({ sessionID: row.session_id, messageID: row.id, type: row.type, reason }),
      )
      return undefined
    }
    return yield* decode({ ...row.data, content: kept, id: row.id, type: row.type }).pipe(
      Effect.tap(() =>
        Effect.logWarning("session message row salvaged by dropping undecodable content parts").pipe(
          Effect.annotateLogs({
            sessionID: row.session_id,
            messageID: row.id,
            type: row.type,
            dropped: rawContent.length - kept.length,
          }),
        ),
      ),
      Effect.catch((salvageIssue: { message: string }) =>
        Effect.logWarning(
          "session message row unsalvageable even with undecodable content parts dropped, skipping row",
        ).pipe(
          Effect.annotateLogs({
            sessionID: row.session_id,
            messageID: row.id,
            type: row.type,
            reason: salvageIssue.message,
          }),
          Effect.as(undefined),
        ),
      ),
    )
  })
}

// Effect Schema's decoder fails with a ParseError for any row shape a prior
// app version or a partial write left behind. A decode failure here must
// never fail the read: it's logged and the row is dropped (or, for an
// assistant row, salvaged — see salvageMessageRow), so one corrupt row can
// never brick the rest of a session's history.
export const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.catch((issue) =>
      Effect.logWarning("session message row failed to decode, attempting salvage").pipe(
        Effect.annotateLogs({ sessionID: row.session_id, messageID: row.id, type: row.type, reason: issue.message }),
        Effect.andThen(() => salvageMessageRow(row, issue.message)),
      ),
    ),
  )

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  const rows = yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq)
  const decoded = yield* Effect.forEach(rows, decodeMessageRow)
  return decoded.filter((message): message is SessionMessage.Message => message !== undefined)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
  const entries = yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => (message ? { seq: row.seq, message } : undefined))),
  )
  return entries.filter((entry): entry is { seq: number; message: SessionMessage.Message } => entry !== undefined)
})

export * as SessionHistory from "./history"
