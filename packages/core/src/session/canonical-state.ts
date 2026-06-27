/**
 * Persists the agent's canonical state (tool-call ledger, scratchpad key/values,
 * attempt history) outside the model context window so it survives compaction.
 * Provides a rebuild path to re-inject state after a compaction/restart.
 * @sem domain=session role=store
 */
export * as SessionCanonicalState from "./canonical-state"

import { asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { Identifier } from "../util/identifier"
import { SessionSchema } from "./schema"
import { SessionCanonicalStateTable } from "./sql"

// ---------------------------------------------------------------------------
// Public payload types
// ---------------------------------------------------------------------------

/** A single tool-call or decision entry written to the immutable ledger. */
export type LedgerPayload = {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly result?: string
  readonly decision?: string
}

/** An attempt-history entry (task retries, sub-agent outcomes, etc.). */
export type AttemptPayload = {
  readonly task: string
  readonly status: "success" | "failure" | "in-progress"
  readonly error?: string
}

/** A hydrated row from the store. */
export type CanonicalStateRow = {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly kind: "ledger" | "scratchpad" | "attempt"
  readonly key: string
  readonly seq: number
  readonly payload: Record<string, unknown>
  readonly timeCreated: number
}

/** Full canonical state for a session, partitioned by kind. */
export type CanonicalState = {
  readonly ledger: readonly CanonicalStateRow[]
  readonly scratchpad: Readonly<Record<string, unknown>>
  readonly attempts: readonly CanonicalStateRow[]
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface Interface {
  /** Append a tool-call / decision to the immutable ledger. */
  readonly appendLedger: (sessionID: SessionSchema.ID, entry: LedgerPayload) => Effect.Effect<void>
  /** Upsert a scratchpad key (last-write-wins per key per session). */
  readonly setScratchpad: (sessionID: SessionSchema.ID, key: string, value: unknown) => Effect.Effect<void>
  /** Append an attempt record (retries, sub-agent outcomes). */
  readonly appendAttempt: (sessionID: SessionSchema.ID, entry: AttemptPayload) => Effect.Effect<void>
  /** Load the full canonical state for a session. */
  readonly load: (sessionID: SessionSchema.ID) => Effect.Effect<CanonicalState>
  /**
   * Render the canonical state as a Markdown string suitable for injection
   * as a synthetic context message after compaction/restart.
   */
  readonly rebuildContext: (sessionID: SessionSchema.ID) => Effect.Effect<string>
  /**
   * Persist the serialized task tree for this session via the reserved scratchpad
   * key "__task_tree__" so it survives compaction/restart.
   */
  readonly setTaskTree: (sessionID: SessionSchema.ID, treeJson: string) => Effect.Effect<void>
  /**
   * Reload the serialized task tree for this session from the reserved scratchpad
   * key "__task_tree__"; returns undefined when no tree has been persisted yet.
   */
  readonly loadTaskTree: (sessionID: SessionSchema.ID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionCanonicalState") {}

// ---------------------------------------------------------------------------
// Layer implementation
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Returns the next monotonic seq for a session (MAX(seq)+1, or 1 if empty).
    const nextSeq = (sessionID: SessionSchema.ID) =>
      db
        .select({ maxSeq: sql<number>`COALESCE(MAX(${SessionCanonicalStateTable.seq}), 0)` })
        .from(SessionCanonicalStateTable)
        .where(eq(SessionCanonicalStateTable.session_id, sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => (row?.maxSeq ?? 0) + 1),
        )

    return Service.of({
      appendLedger: Effect.fn("SessionCanonicalState.appendLedger")(function* (sessionID, entry) {
        const seq = yield* nextSeq(sessionID)
        yield* db
          .insert(SessionCanonicalStateTable)
          .values({
            id: `${sessionID}:ledger:${Identifier.ascending()}`,
            session_id: sessionID,
            kind: "ledger",
            key: entry.tool,
            seq,
            payload: entry as Record<string, unknown>,
          })
          .run()
          .pipe(Effect.orDie)
      }),

      setScratchpad: Effect.fn("SessionCanonicalState.setScratchpad")(function* (sessionID, key, value) {
        const seq = yield* nextSeq(sessionID)
        // Deterministic ID → onConflictDoUpdate gives upsert semantics on PK.
        yield* db
          .insert(SessionCanonicalStateTable)
          .values({
            id: `${sessionID}:scratchpad:${key}`,
            session_id: sessionID,
            kind: "scratchpad",
            key,
            seq,
            payload: { value } as Record<string, unknown>,
            time_created: Date.now(),
          })
          .onConflictDoUpdate({
            target: SessionCanonicalStateTable.id,
            set: {
              seq,
              payload: { value } as Record<string, unknown>,
              time_created: Date.now(),
            },
          })
          .run()
          .pipe(Effect.orDie)
      }),

      appendAttempt: Effect.fn("SessionCanonicalState.appendAttempt")(function* (sessionID, entry) {
        const seq = yield* nextSeq(sessionID)
        yield* db
          .insert(SessionCanonicalStateTable)
          .values({
            id: `${sessionID}:attempt:${Identifier.ascending()}`,
            session_id: sessionID,
            kind: "attempt",
            key: entry.task,
            seq,
            payload: entry as Record<string, unknown>,
          })
          .run()
          .pipe(Effect.orDie)
      }),

      load: Effect.fn("SessionCanonicalState.load")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(SessionCanonicalStateTable)
          .where(eq(SessionCanonicalStateTable.session_id, sessionID))
          .orderBy(asc(SessionCanonicalStateTable.seq))
          .all()
          .pipe(Effect.orDie)

        const ledger: CanonicalStateRow[] = []
        const scratchpad: Record<string, unknown> = {}
        const attempts: CanonicalStateRow[] = []

        for (const row of rows) {
          const entry: CanonicalStateRow = {
            id: row.id,
            sessionID: SessionSchema.ID.make(row.session_id),
            kind: row.kind,
            key: row.key,
            seq: row.seq,
            payload: row.payload,
            timeCreated: row.time_created,
          }
          if (row.kind === "ledger") ledger.push(entry)
          else if (row.kind === "scratchpad") scratchpad[row.key] = (row.payload as { value: unknown }).value
          else if (row.kind === "attempt") attempts.push(entry)
        }

        return { ledger, scratchpad, attempts }
      }),

      rebuildContext: Effect.fn("SessionCanonicalState.rebuildContext")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(SessionCanonicalStateTable)
          .where(eq(SessionCanonicalStateTable.session_id, sessionID))
          .orderBy(asc(SessionCanonicalStateTable.seq))
          .all()
          .pipe(Effect.orDie)

        const ledger: CanonicalStateRow[] = []
        const scratchpad: Record<string, unknown> = {}
        const attempts: CanonicalStateRow[] = []

        for (const row of rows) {
          const entry: CanonicalStateRow = {
            id: row.id,
            sessionID: SessionSchema.ID.make(row.session_id),
            kind: row.kind,
            key: row.key,
            seq: row.seq,
            payload: row.payload,
            timeCreated: row.time_created,
          }
          if (row.kind === "ledger") ledger.push(entry)
          else if (row.kind === "scratchpad") scratchpad[row.key] = (row.payload as { value: unknown }).value
          else if (row.kind === "attempt") attempts.push(entry)
        }

        const parts: string[] = ["## Canonical State (restored after compaction)\n"]

        const scratchpadKeys = Object.keys(scratchpad)
        if (scratchpadKeys.length > 0) {
          parts.push("### Scratchpad")
          for (const k of scratchpadKeys) {
            parts.push(`- **${k}**: ${JSON.stringify(scratchpad[k])}`)
          }
        }

        if (ledger.length > 0) {
          parts.push("\n### Tool Call Ledger (last 20)")
          for (const entry of ledger.slice(-20)) {
            const p = entry.payload as LedgerPayload
            const result = p.result ? `: ${p.result}` : ""
            const decision = p.decision ? ` [decision: ${p.decision}]` : ""
            parts.push(`- [seq=${entry.seq}] \`${p.tool}\`${result}${decision}`)
          }
        }

        if (attempts.length > 0) {
          parts.push("\n### Attempt History")
          for (const entry of attempts) {
            const p = entry.payload as AttemptPayload
            const err = p.error ? ` — ${p.error}` : ""
            parts.push(`- [seq=${entry.seq}] **${p.task}**: ${p.status}${err}`)
          }
        }

        return parts.join("\n")
      }),

      // Persist the serialized task tree under the reserved scratchpad key so it
      // survives compaction/restart — delegates to the same upsert path as setScratchpad.
      setTaskTree: Effect.fn("SessionCanonicalState.setTaskTree")(function* (sessionID, treeJson) {
        const seq = yield* nextSeq(sessionID)
        yield* db
          .insert(SessionCanonicalStateTable)
          .values({
            id: `${sessionID}:scratchpad:__task_tree__`,
            session_id: sessionID,
            kind: "scratchpad",
            key: "__task_tree__",
            seq,
            payload: { value: treeJson } as Record<string, unknown>,
            time_created: Date.now(),
          })
          .onConflictDoUpdate({
            target: SessionCanonicalStateTable.id,
            set: {
              seq,
              payload: { value: treeJson } as Record<string, unknown>,
              time_created: Date.now(),
            },
          })
          .run()
          .pipe(Effect.orDie)
      }),

      // Reload the serialized task tree from the reserved scratchpad key; returns
      // undefined when no tree has been persisted yet for this session.
      loadTaskTree: Effect.fn("SessionCanonicalState.loadTaskTree")(function* (sessionID) {
        const row = yield* db
          .select()
          .from(SessionCanonicalStateTable)
          .where(eq(SessionCanonicalStateTable.id, `${sessionID}:scratchpad:__task_tree__`))
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        return (row.payload as { value: string }).value
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
