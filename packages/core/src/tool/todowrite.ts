export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { SessionTodo } from "../session/todo"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => {
  const completed = output.todos.filter((todo) => todo.status === "completed").length
  const pending = output.todos.filter((todo) => todo.status === "pending").length
  const inProgress = output.todos.find((todo) => todo.status === "in_progress")
  return `ok: ${output.todos.length} todos — ${completed} completed, ${pending} pending, in_progress: ${
    inProgress ? `"${inProgress.content}"` : "none"
  }`
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* todos.update({ sessionID: context.sessionID, todos: input.todos })
              return { todos: input.todos }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update todos" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
