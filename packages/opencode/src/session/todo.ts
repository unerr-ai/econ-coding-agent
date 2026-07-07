import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"

/**
 * @deprecated This is the opencode-package-local SessionTodo, wired into the
 * opencode server's LayerNode graph (app-runtime.ts, tool/registry.ts,
 * server.ts) under the `@opencode/SessionTodo` tag and bridged onto the
 * local EventV2Bridge event bus. `@opencode-ai/core/session/todo`
 * (`@opencode/v2/SessionTodo`) is the actively-developed successor (OL-7.1
 * typed decomposition fields), but it composes via `location-layer.ts`
 * (LayerMap/`locationLayer`), not LayerNode, and publishes through core's
 * own EventV2 rather than the bridge — redirecting this module's 6 runtime
 * importers would mean re-deriving a LayerNode `node` for the core service
 * and re-pointing the event bridge, which is DI-graph/architecture work,
 * not a mechanical import swap. Kept in place until that unification lands;
 * do not add new call sites — extend `@opencode-ai/core/session/todo` instead.
 */
export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
}).annotate({ identifier: "Todo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: EventV2.define({
    type: "todo.updated",
    schema: {
      sessionID: SessionID,
      todos: Schema.Array(Info),
    },
  }),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
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
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
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
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node, Database.node])

export * as Todo from "./todo"
