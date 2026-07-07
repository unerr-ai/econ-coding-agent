import { describe, expect } from "bun:test"
import { asc } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionTodo.defaultLayer))
const sessionID = SessionV2.ID.make("ses_todo_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "todo",
      directory: "/project",
      title: "todo",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionTodo", () => {
  it.effect("replaces persisted todos in order and publishes updates", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const todos = yield* SessionTodo.Service
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low" },
        { content: "first", status: "in_progress", priority: "high" },
      ])
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map((row) => ({
          content: row.content,
          position: row.position,
        })),
      ).toEqual([
        { content: "second", position: 0 },
        { content: "first", position: 1 },
      ])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([{ content: "replacement", status: "completed", priority: "medium" }])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(published.map((event) => event.data)).toEqual([
        {
          sessionID,
          todos: [
            { content: "second", status: "pending", priority: "low" },
            { content: "first", status: "in_progress", priority: "high" },
          ],
        },
        { sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] },
        { sessionID, todos: [] },
      ])
    }),
  )

  it.effect("round-trips OL-7.1 typed decomposition fields through slice_meta and leaves legacy rows unaffected", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service

      const typed = {
        content: "typed slice",
        status: "pending",
        priority: "high",
        sliceType: "mechanical",
        need: "executor",
        deps: ["design-the-interface"],
        coupling: "high",
        testStrength: "testable",
        // OL-9.1b regression: persona was the one typed field slice_meta did NOT
        // persist, so every persona hint silently reverted to the sliceType
        // default at dispatch (personaForSlice never saw it).
        persona: "researcher",
      }
      const legacy = { content: "legacy slice", status: "pending", priority: "low" }

      yield* todos.update({ sessionID, todos: [typed, legacy] })
      expect(yield* todos.get(sessionID)).toEqual([typed, legacy])

      const rows = yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)
      expect(rows[0]?.slice_meta).toEqual({
        sliceType: "mechanical",
        need: "executor",
        deps: ["design-the-interface"],
        coupling: "high",
        testStrength: "testable",
        persona: "researcher",
      })
      expect(rows[1]?.slice_meta).toBeNull()
    }),
  )
})
