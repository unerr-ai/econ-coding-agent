import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionTodo.defaultLayer))
const sessionID = SessionV2.ID.make("ses_todo_tree_test")

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
      slug: "todo-tree",
      directory: "/project",
      title: "todo tree",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

// Runs an effect expected to die/fail and returns the squashed underlying error
// (or undefined if it actually succeeded) — validateTodoTree rejections surface
// as defects (Effect.die), same channel as the existing DB-error path.
function rejection<A>(effect: Effect.Effect<A>) {
  return effect.pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
  )
}

describe("SessionTodo — U2a goal tree (docs/architecture/ORCHESTRATION_MECHANISM.md §1.2, §4.5)", () => {
  it.effect("accepts nesting to depth 3 (goal -> task -> sub-item) and round-trips parentID", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service

      const goal = { content: "goal", status: "pending", priority: "high" }
      const task = { content: "task", status: "pending", priority: "high", parentID: 0 }
      const subItem = { content: "sub-item", status: "pending", priority: "high", parentID: 1 }

      yield* todos.update({ sessionID, todos: [goal, task, subItem] })
      expect(yield* todos.get(sessionID)).toEqual([goal, task, subItem])
    }),
  )

  it.effect("rejects nesting past depth 3 (goal -> task -> sub-item -> one level too many)", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service

      const goal = { content: "goal", status: "pending", priority: "high" }
      const task = { content: "task", status: "pending", priority: "high", parentID: 0 }
      const subItem = { content: "sub-item", status: "pending", priority: "high", parentID: 1 }
      const tooDeep = { content: "too deep", status: "pending", priority: "high", parentID: 2 }

      const error = yield* rejection(todos.update({ sessionID, todos: [goal, task, subItem, tooDeep] }))
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("max data depth of 3")
    }),
  )

  it.effect("accepts 5 children of the same parent, rejects a 6th", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service

      const goal = { content: "goal", status: "pending", priority: "high" }
      const children = Array.from({ length: 5 }, (_, i) => ({
        content: `child ${i}`,
        status: "pending",
        priority: "high",
        parentID: 0,
      }))
      yield* todos.update({ sessionID, todos: [goal, ...children] })
      expect(yield* todos.get(sessionID)).toHaveLength(6)

      const sixthChild = { content: "child 5", status: "pending", priority: "high", parentID: 0 }
      const error = yield* rejection(todos.update({ sessionID, todos: [goal, ...children, sixthChild] }))
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("max of 5 children")
    }),
  )

  it.effect("rejects a parentID that does not reference an existing todo (orphan)", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service

      const orphan = { content: "orphan", status: "pending", priority: "high", parentID: 4 }
      const error = yield* rejection(todos.update({ sessionID, todos: [orphan] }))
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("does not reference an existing todo")
    }),
  )

  it.effect("flattenTodoTree orders parent-before-children with stable sibling order", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service

      // Written out of tree order on purpose — position is assignment order, not tree order.
      const goalA = { content: "goal A", status: "pending", priority: "high" }
      const goalB = { content: "goal B", status: "pending", priority: "high" }
      const aTask2 = { content: "A task 2", status: "pending", priority: "high", parentID: 0 }
      const aTask1 = { content: "A task 1", status: "pending", priority: "high", parentID: 0 }
      const bTask1 = { content: "B task 1", status: "pending", priority: "high", parentID: 1 }

      yield* todos.update({ sessionID, todos: [goalA, goalB, aTask2, aTask1, bTask1] })
      const read = yield* todos.get(sessionID)
      const flattened = SessionTodo.flattenTodoTree(read)
      expect(flattened.map((todo) => todo.content)).toEqual(["goal A", "A task 2", "A task 1", "goal B", "B task 1"])
    }),
  )

  it.effect("parentID survives write -> read -> status update", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service

      const goal = { content: "goal", status: "pending", priority: "high" }
      const task = { content: "task", status: "pending", priority: "high", parentID: 0 }
      yield* todos.update({ sessionID, todos: [goal, task] })

      const read = yield* todos.get(sessionID)
      expect(read[1]?.parentID).toBe(0)

      const updated = read.map((todo, index) => (index === 1 ? { ...todo, status: "completed" } : todo))
      yield* todos.update({ sessionID, todos: updated })

      const reread = yield* todos.get(sessionID)
      expect(reread[1]).toEqual({ ...task, status: "completed" })
    }),
  )
})
