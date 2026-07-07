/**
 * OL-7.3c — the todowrite tool now advertises the LLM-fillable subset of the
 * typed decomposition fields (sliceType/need/deps), so a conductor's typed DAG
 * survives the tool boundary and persists via slice_meta. Before this fix the
 * tool schema omitted those fields and Effect's decode silently stripped them,
 * so hasPendingTypedSlices never fired and the OL-7.3b hook stayed inert.
 *
 * Covers: (a) the tool Parameters schema accepts + preserves sliceType/need/deps,
 * (b) untyped items still round-trip unchanged, (c) coupling/testStrength are NOT
 * accepted from the model (probe-only), and (d) end-to-end — decoded typed todos
 * flow through the real SessionTodo service and engage hasPendingTypedSlices.
 * The slice_meta DB round-trip itself is covered in core/test/session-todo.test.ts.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { Parameters } from "../../src/tool/todo"
import { hasPendingTypedSlices } from "../../src/session/slice-orchestrator"

const decode = Schema.decodeUnknownSync(Parameters)

describe("todowrite Parameters — OL-7.3c typed decomposition fields", () => {
  test("accepts and preserves sliceType/need/deps on a typed slice", () => {
    const out = decode({
      todos: [
        {
          content: "apply the rename across sites",
          status: "pending",
          priority: "high",
          sliceType: "mechanical",
          need: "executor",
          deps: ["design the interface"],
        },
      ],
    })
    expect(out.todos[0]).toEqual({
      content: "apply the rename across sites",
      status: "pending",
      priority: "high",
      sliceType: "mechanical",
      need: "executor",
      deps: ["design the interface"],
    })
  })

  test("untyped item round-trips unchanged (backward compatible)", () => {
    const untyped = { content: "just do it", status: "pending", priority: "high" }
    expect(decode({ todos: [untyped] }).todos[0]).toEqual(untyped)
  })

  test("does not accept coupling/testStrength from the model (probe-only fields)", () => {
    const out = decode({
      todos: [
        {
          content: "typed",
          status: "pending",
          priority: "high",
          sliceType: "mechanical",
          coupling: "high",
          testStrength: "testable",
        },
      ],
    })
    expect(out.todos[0]).not.toHaveProperty("coupling")
    expect(out.todos[0]).not.toHaveProperty("testStrength")
  })
})

const layer = Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionTodo.defaultLayer)
const sessionID = SessionV2.ID.make("ses_todowrite_ol73c")

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
      slug: "todowrite",
      directory: "/project",
      title: "todowrite",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("todowrite → SessionTodo service → hasPendingTypedSlices", () => {
  test("a decoded typed DAG is stored by the service and engages the hook predicate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const todos = yield* SessionTodo.Service

        // Exactly the payload shape a conductor's todowrite call produces, run
        // through the tool's own schema before the service persists it.
        const decoded = decode({
          todos: [
            { content: "design the api", status: "pending", priority: "high", sliceType: "design", need: "oracle" },
            {
              content: "apply it across callers",
              status: "pending",
              priority: "medium",
              sliceType: "mechanical",
              deps: ["design the api"],
            },
          ],
        })

        yield* todos.update({ sessionID, todos: decoded.todos })
        const got = yield* todos.get(sessionID)

        expect(hasPendingTypedSlices(got)).toBe(true)
        expect(got.find((t) => t.content === "design the api")?.sliceType).toBe("design")
        expect(got.find((t) => t.content === "apply it across callers")?.deps).toEqual(["design the api"])
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })
})
