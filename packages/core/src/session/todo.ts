export * as SessionTodo from "./todo"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { TodoTable, type TodoSliceMeta } from "./sql"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
  // OL-7.1 typed decomposition — all optional, backward compatible with untyped todo items.
  sliceType: Schema.optional(
    Schema.String.annotate({
      description:
        "Decomposition slice type (OL-7.1): design, mechanical, recon, or verify. Omitted on the trivial/single-slice path.",
    }),
  ),
  need: Schema.optional(
    Schema.String.annotate({
      description:
        "Minimum capability tier this slice needs (e.g. executor, oracle, reasoner, conductor) — resolved by the per-slice allocator (OL-7.2).",
    }),
  ),
  deps: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Ids of the slices (other todo items) this one depends on — builds the decomposition DAG.",
    }),
  ),
  // Reserved for the OL-7.9 coupling/test-strength probe (a separate parallel effort) — not populated here.
  coupling: Schema.optional(
    Schema.String.annotate({ description: "Cross-slice coupling for this slice: low or high (OL-7.9)." }),
  ),
  testStrength: Schema.optional(
    Schema.String.annotate({
      description: "Whether a sound check exists for this slice: testable or untestable (OL-7.9).",
    }),
  ),
  persona: Schema.optional(
    Schema.String.annotate({
      description:
        "Intern persona this slice runs as (OL-9.1b): explorer, runner, applier, author, researcher, or procedure. Omitted → derived from sliceType at dispatch.",
    }),
  ),
  // U2a — the goal tree (docs/architecture/ORCHESTRATION_MECHANISM.md §1.2, §4.5).
  parentID: Schema.optional(
    Schema.Number.annotate({
      description:
        "Position (array index) of the parent todo within the same update() call — goal -> task -> sub-item nesting, depth <=3, <=5 children per parent. Omitted for a root (goal-level) item.",
    }),
  ),
}).annotate({ identifier: "SessionTodo.Info" })
export type Info = typeof Info.Type

export const Event = {
  Updated: EventV2.define({
    type: "todo.updated",
    schema: {
      sessionID: SessionSchema.ID,
      todos: Schema.Array(Info),
    },
  }),
}

export interface Interface {
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionTodo") {}

// OL-7.1b — pack the optional typed-decomposition fields into the todo table's
// single `slice_meta` JSON column; null when none are set (legacy/untyped item).
function encodeSliceMeta(todo: Info): TodoSliceMeta | null {
  const meta: TodoSliceMeta = {}
  if (todo.sliceType !== undefined) meta.sliceType = todo.sliceType
  if (todo.need !== undefined) meta.need = todo.need
  if (todo.deps !== undefined) meta.deps = todo.deps
  if (todo.coupling !== undefined) meta.coupling = todo.coupling
  if (todo.testStrength !== undefined) meta.testStrength = todo.testStrength
  if (todo.persona !== undefined) meta.persona = todo.persona
  return Object.keys(meta).length > 0 ? meta : null
}

function decodeSliceMeta(meta: TodoSliceMeta | null | undefined): Partial<Info> {
  if (!meta) return {}
  return {
    ...(meta.sliceType !== undefined ? { sliceType: meta.sliceType } : {}),
    ...(meta.need !== undefined ? { need: meta.need } : {}),
    ...(meta.deps !== undefined ? { deps: meta.deps } : {}),
    ...(meta.coupling !== undefined ? { coupling: meta.coupling } : {}),
    ...(meta.testStrength !== undefined ? { testStrength: meta.testStrength } : {}),
    ...(meta.persona !== undefined ? { persona: meta.persona } : {}),
  }
}

// U2a — the goal tree (docs/architecture/ORCHESTRATION_MECHANISM.md §1.2, §4.5):
// data depth <=3 (goal -> task -> sub-item), <=5 children per node. Build mode:
// a violation is a hard error, never clamped and never behind a compat flag.
const MAX_TODO_TREE_DEPTH = 3
const MAX_TODO_TREE_CHILDREN = 5

// U2a — validates the whole batch passed to update() before anything is written:
// every parentID must reference another item in the same batch (by position/array
// index — parentID's only meaning), no node may exceed the depth cap, and no
// parent may exceed the children cap. Returns the violation message, or undefined
// when the batch is valid.
function validateTodoTree(todos: ReadonlyArray<Info>): string | undefined {
  const childCounts = new Map<number, number>()
  for (const [index, todo] of todos.entries()) {
    if (todo.parentID === undefined) continue
    if (todo.parentID < 0 || todo.parentID >= todos.length || todo.parentID === index) {
      return `todo at position ${index} has parentID ${todo.parentID}, which does not reference an existing todo in this batch`
    }
    childCounts.set(todo.parentID, (childCounts.get(todo.parentID) ?? 0) + 1)
  }
  for (const [parentID, count] of childCounts) {
    if (count > MAX_TODO_TREE_CHILDREN) {
      return `todo at position ${parentID} would have ${count} children, exceeding the max of ${MAX_TODO_TREE_CHILDREN} children per node`
    }
  }
  for (const [index, todo] of todos.entries()) {
    let depth = 1
    let cursor = todo
    const visited = new Set<number>([index])
    while (cursor.parentID !== undefined) {
      depth++
      if (depth > MAX_TODO_TREE_DEPTH) {
        return `todo at position ${index} would nest ${depth} levels deep, exceeding the max data depth of ${MAX_TODO_TREE_DEPTH} (goal -> task -> sub-item)`
      }
      if (visited.has(cursor.parentID)) {
        return `todo at position ${index} has a cyclic parentID chain`
      }
      visited.add(cursor.parentID)
      cursor = todos[cursor.parentID]!
    }
  }
  return undefined
}

// U2a — read-side helper: orders a flat todo list parent-before-children, with
// siblings kept in stable position order, for tree rendering and slice-orchestrator
// fold-back. `todos` must be in position order (as returned by get()), since
// parentID references the position/array index of the parent.
export function flattenTodoTree(todos: ReadonlyArray<Info>): ReadonlyArray<Info> {
  const childrenByParent = new Map<number, number[]>()
  const roots: number[] = []
  todos.forEach((todo, position) => {
    if (todo.parentID === undefined) {
      roots.push(position)
      return
    }
    const siblings = childrenByParent.get(todo.parentID) ?? []
    siblings.push(position)
    childrenByParent.set(todo.parentID, siblings)
  })
  const ordered: Info[] = []
  function visit(position: number) {
    const todo = todos[position]
    if (!todo) return
    ordered.push(todo)
    for (const child of childrenByParent.get(position) ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  return ordered
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const update = Effect.fn("SessionTodo.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly todos: ReadonlyArray<Info>
    }) {
      const violation = validateTodoTree(input.todos)
      if (violation !== undefined) return yield* Effect.die(new Error(violation))
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            yield* tx
              .insert(TodoTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                  parent_id: todo.parentID ?? null,
                  slice_meta: encodeSliceMeta(todo),
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("SessionTodo.get")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
        ...(row.parent_id !== null && row.parent_id !== undefined ? { parentID: row.parent_id } : {}),
        ...decodeSliceMeta(row.slice_meta),
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [EventV2.node, Database.node])
