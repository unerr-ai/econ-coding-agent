import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { ECON_PERSONAS } from "../../../code-intelligence/src/model-registry"
import { autoTypeTodos, reconcileSettledSlices } from "../session/slice-orchestrator"

// Inline the field shape here rather than referencing SessionTodo.Info — the
// three core fields plus the OL-7.3c LLM-fillable subset of the typed
// decomposition fields. sliceType/need/deps are advertised so the conductor's
// typed DAG (system prompt bullet 2a) survives this tool boundary and persists
// via slice_meta, which is what the OL-7.3b hook's hasPendingTypedSlices reads.
// coupling/testStrength stay OUT of the LLM schema — the OL-7.9 probes fill
// those, the model must not self-assess them. Field semantics mirror
// SessionTodo.Info exactly (Schema.String, same shape) so decode never strips or
// disagrees. Untyped todo items (no sliceType) leave these fields absent, so
// hasPendingTypedSlices sees no pending typed slice and the hook stays inert.
const TodoItem = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
  // OL-7.3c typed decomposition — all optional, backward compatible with untyped todo items.
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
      description:
        "Ids of the slices (other todo items) this one depends on — builds the decomposition DAG. Each id is either the depended-on item's `content` string verbatim, or `todo_N` with N the 1-based position of that item in this list.",
    }),
  ),
  // OL-9.1d — names the stateless executor-persona intern that should run this slice, one of
  // ECON_PERSONAS. Optional: sliceType maps to a persona automatically (recon→explorer,
  // verify→runner, mechanical→applier, else procedure) — only set this to name `author` or
  // `researcher` explicitly, since those two are never chosen automatically.
  persona: Schema.optional(
    Schema.Literals(ECON_PERSONAS).annotate({
      description: `Executor persona intern for this slice: one of ${ECON_PERSONAS.join(", ")}. Omit to let sliceType route automatically (recon→explorer, verify→runner, mechanical→applier, else procedure) — set this explicitly only to name 'author' or 'researcher', which are never chosen automatically.`,
    }),
  ),
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoItem)).annotate({ description: "The updated todo list" }),
})

type Metadata = {
  todos: SessionTodo.Info[]
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, SessionTodo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* SessionTodo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          // Two structural nets at the tool boundary, in order. Reconcile
          // first (case-2 tierfire3 double-wave decode): a conductor rewrite
          // wholesale-replaces the stored list, so settled slice statuses and
          // engine-planted frame seeds must be re-stuck against the store
          // before anything else — otherwise a stale re-emission un-completes
          // paid-for slices and re-triggers a full dispatch wave. Then
          // judgment-slice typing (run-20 decode): on an untyped
          // audit/verify-shaped list, type the judgment + check-run items here
          // at the tool boundary so the OL-7.3b hook can dispatch them —
          // advisory typing rules alone never steer the conductor model.
          const existing = yield* todo.get(ctx.sessionID)
          const todos = autoTypeTodos(reconcileSettledSlices(params.todos, existing))

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos,
          })

          const completed = todos.filter((x) => x.status === "completed").length
          const pending = todos.filter((x) => x.status === "pending").length
          const inProgress = todos.find((x) => x.status === "in_progress")

          return {
            title: `${todos.filter((x) => x.status !== "completed").length} todos`,
            output: `ok: ${todos.length} todos — ${completed} completed, ${pending} pending, in_progress: ${
              inProgress ? `"${inProgress.content}"` : "none"
            }`,
            metadata: {
              todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
