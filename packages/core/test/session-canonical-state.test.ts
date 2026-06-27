/**
 * S1.3 — Canonical State: survives-compaction test.
 *
 * Verifies that the ledger / scratchpad / attempt-history persisted in
 * `session_canonical_state` is fully recoverable after a simulated
 * compaction/restart that drops in-window history.
 */
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionCanonicalState } from "@opencode-ai/core/session/canonical-state"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionCanonicalStateTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectSchema } from "@opencode-ai/core/project/schema"
import { testEffect } from "./lib/effect"

// Isolated in-memory DB.  Provide it to SessionCanonicalState.layer so the
// combined test layer has no remaining requirements (R = never).
const memoryLayer = Database.layerFromPath(":memory:")
const canonicalStateLayer = SessionCanonicalState.layer.pipe(Layer.provide(memoryLayer))

const it = testEffect(Layer.merge(memoryLayer, canonicalStateLayer))

const PROJECT_ID = ProjectSchema.ID.make("global")

// ---------------------------------------------------------------------------
// Helper: seed the project row (idempotent) then the session row
// ---------------------------------------------------------------------------
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
    .values({
      id: sessionID,
      project_id: PROJECT_ID,
      slug,
      directory: "/project",
      title: slug,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)

// ---------------------------------------------------------------------------
// Helper: insert a raw session_message row (simulates projector output)
// ---------------------------------------------------------------------------
const insertMsg = (
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

// ---------------------------------------------------------------------------
describe("SessionCanonicalState", () => {
  it.effect("ledger / scratchpad / attempts survive compaction and are fully recoverable", () =>
    Effect.gen(function* () {
      const SESSION_ID = SessionSchema.ID.make("ses_canonical_s13_001")
      const { db } = yield* Database.Service
      yield* seedProject(db)
      yield* seedSession(db, SESSION_ID, "canonical-state-test")

      const store = yield* SessionCanonicalState.Service

      // 1. Insert a pre-compaction in-window user message at seq=1
      yield* insertMsg(db, {
        id: "msg_pre_compaction_001",
        sessionID: SESSION_ID,
        seq: 1,
        type: "user",
        data: { text: "Hello before compaction", time: { created: Date.now() } },
      })

      // 2. Write canonical state
      yield* store.appendLedger(SESSION_ID, {
        tool: "file_read",
        input: { path: "src/session/compaction.ts" },
        result: "ok",
        decision: "read compaction logic",
      })
      yield* store.setScratchpad(SESSION_ID, "goal", "implement canonical state for S1.3")
      yield* store.setScratchpad(SESSION_ID, "currentFile", "canonical-state.ts")
      // Upsert: overwrite currentFile with the new value
      yield* store.setScratchpad(SESSION_ID, "currentFile", "canonical-state.test.ts")
      yield* store.appendAttempt(SESSION_ID, {
        task: "write_canonical_state_ts",
        status: "success",
      })
      yield* store.appendAttempt(SESSION_ID, {
        task: "write_migration",
        status: "success",
      })

      // 3. Simulate compaction: insert a compaction message at seq=2
      //    SessionHistory.load uses latestCompaction(seq=2) to exclude seq<2 rows.
      yield* insertMsg(db, {
        id: "msg_compaction_001",
        sessionID: SESSION_ID,
        seq: 2,
        type: "compaction",
        data: {
          reason: "auto",
          summary: "## Goal\n- implement canonical state",
          recent: "user: Hello before compaction",
          time: { created: Date.now() },
        },
      })

      // 4. Verify SessionHistory.load drops the pre-compaction user message
      const history = yield* SessionHistory.load(db, SESSION_ID)
      const historyTypes = history.map((m) => m.type)
      expect(historyTypes).not.toContain("user")
      expect(historyTypes).toContain("compaction")

      // 5. Load canonical state — must be FULLY intact despite the compaction
      const state = yield* store.load(SESSION_ID)

      expect(state.ledger).toHaveLength(1)
      expect((state.ledger[0]!.payload as LedgerPayload).tool).toBe("file_read")
      expect((state.ledger[0]!.payload as LedgerPayload).decision).toBe("read compaction logic")

      // Scratchpad: upsert applied — currentFile holds the overwritten value
      expect(state.scratchpad["goal"]).toBe("implement canonical state for S1.3")
      expect(state.scratchpad["currentFile"]).toBe("canonical-state.test.ts")
      expect(Object.keys(state.scratchpad)).toHaveLength(2)

      expect(state.attempts).toHaveLength(2)
      expect((state.attempts[0]!.payload as AttemptPayload).task).toBe("write_canonical_state_ts")
      expect((state.attempts[0]!.payload as AttemptPayload).status).toBe("success")

      // 6. rebuildContext must produce a Markdown summary with all three sections
      const rebuilt = yield* store.rebuildContext(SESSION_ID)
      expect(rebuilt).toContain("## Canonical State (restored after compaction)")
      expect(rebuilt).toContain("### Scratchpad")
      expect(rebuilt).toContain("goal")
      expect(rebuilt).toContain("implement canonical state for S1.3")
      expect(rebuilt).toContain("### Tool Call Ledger")
      expect(rebuilt).toContain("`file_read`")
      expect(rebuilt).toContain("### Attempt History")
      expect(rebuilt).toContain("write_canonical_state_ts")
      expect(rebuilt).toContain("success")
    }),
  )

  it.effect("scratchpad upsert is last-write-wins — only one row per key stored", () =>
    Effect.gen(function* () {
      const SESSION_ID = SessionSchema.ID.make("ses_canonical_s13_002")
      const { db } = yield* Database.Service
      yield* seedProject(db)
      yield* seedSession(db, SESSION_ID, "scratchpad-upsert-test")

      const store = yield* SessionCanonicalState.Service

      yield* store.setScratchpad(SESSION_ID, "status", "pending")
      yield* store.setScratchpad(SESSION_ID, "status", "done")
      yield* store.setScratchpad(SESSION_ID, "status", "verified")

      const state = yield* store.load(SESSION_ID)
      expect(state.scratchpad["status"]).toBe("verified")

      // Exactly one DB row for this session + kind=scratchpad + key=status
      const rows = yield* db
        .select()
        .from(SessionCanonicalStateTable)
        .where(eq(SessionCanonicalStateTable.session_id, SESSION_ID))
        .all()
        .pipe(Effect.orDie)
      const scratchpadRows = rows.filter((r) => r.kind === "scratchpad" && r.key === "status")
      expect(scratchpadRows).toHaveLength(1)
      expect((scratchpadRows[0]!.payload as { value: unknown }).value).toBe("verified")
    }),
  )
})

// ---------------------------------------------------------------------------
// Local payload type aliases (mirrors canonical-state.ts, avoids re-export)
// ---------------------------------------------------------------------------
type LedgerPayload = { tool: string; input: Record<string, unknown>; result?: string; decision?: string }
type AttemptPayload = { task: string; status: string; error?: string }
