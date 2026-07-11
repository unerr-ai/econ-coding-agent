/**
 * SessionHistory decode-failure resilience.
 *
 * A corrupt session_message row must never brick a history read: the row is
 * logged and dropped, and an assistant row with one bad content part is
 * salvaged by dropping just that part instead of the whole message.
 */
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectSchema } from "@opencode-ai/core/project/schema"
import { testEffect } from "./lib/effect"

// Isolated in-memory DB — no other service layer is needed since
// SessionHistory.load takes a `db` handle directly.
const memoryLayer = Database.layerFromPath(":memory:")
const it = testEffect(memoryLayer)

const PROJECT_ID = ProjectSchema.ID.make("global")

const seedProject = (db: Database.Interface["db"]) =>
  db
    .insert(ProjectTable)
    .values({ id: PROJECT_ID, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

const seedSession = (db: Database.Interface["db"], sessionID: SessionSchema.ID, slug: string) =>
  db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: PROJECT_ID, slug, directory: "/project", title: slug, version: "test" })
    .run()
    .pipe(Effect.orDie)

const insertRow = (
  db: Database.Interface["db"],
  opts: {
    id: string
    sessionID: SessionSchema.ID
    seq: number
    type: SessionMessage.Type
    data: Record<string, unknown>
  },
) =>
  db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(opts.id),
      session_id: opts.sessionID,
      type: opts.type,
      seq: opts.seq,
      time_created: Date.now(),
      data: opts.data as never,
    })
    .run()
    .pipe(Effect.orDie)

describe("SessionHistory decode resilience", () => {
  it.effect("skips a corrupt row and returns the valid ones", () =>
    Effect.gen(function* () {
      const SESSION_ID = SessionSchema.ID.make("ses_history_skip_001")
      const { db } = yield* Database.Service
      yield* seedProject(db)
      yield* seedSession(db, SESSION_ID, "history-skip-test")

      yield* insertRow(db, {
        id: "msg_valid_001",
        sessionID: SESSION_ID,
        seq: 1,
        type: "system",
        data: { text: "hello", time: { created: Date.now() } },
      })
      // Corrupt: missing the required `text` field.
      yield* insertRow(db, {
        id: "msg_corrupt_001",
        sessionID: SESSION_ID,
        seq: 2,
        type: "system",
        data: {},
      })

      const history = yield* SessionHistory.load(db, SESSION_ID)
      expect(history).toHaveLength(1)
      expect(history[0]!.id).toBe(SessionMessage.ID.make("msg_valid_001"))
    }),
  )

  it.effect("salvages an assistant row by dropping an undecodable content part", () =>
    Effect.gen(function* () {
      const SESSION_ID = SessionSchema.ID.make("ses_history_salvage_001")
      const { db } = yield* Database.Service
      yield* seedProject(db)
      yield* seedSession(db, SESSION_ID, "history-salvage-test")

      yield* insertRow(db, {
        id: "msg_assistant_001",
        sessionID: SESSION_ID,
        seq: 1,
        type: "assistant",
        data: {
          time: { created: Date.now() },
          agent: "build",
          model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
          content: [
            { type: "text", id: "part_ok", text: "hello" },
            // Corrupt: text parts require a `text` field.
            { type: "text", id: "part_bad" },
          ],
        },
      })

      const history = yield* SessionHistory.load(db, SESSION_ID)
      expect(history).toHaveLength(1)
      const message = history[0]!
      expect(message.type).toBe("assistant")
      if (message.type !== "assistant") throw new Error("expected assistant message")
      expect(message.content).toHaveLength(1)
      expect(message.content[0]).toMatchObject({ type: "text", id: "part_ok" })
    }),
  )
})
