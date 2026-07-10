/**
 * P11b — the `delegate` tool: the one downward door a reasoner/oracle slice
 * seat holds. The model NAMES the work (content + optional sliceType/files
 * hints); ALL policy lives in code (session/slice-delegation.ts): tier
 * resolution via the per-slice allocator + evaluator, the down-only rule,
 * the ≤4-per-slice bound, scope containment inside the parent slice's own
 * files, depth-1 (a delegate child never gets this tool), child-todo
 * recording with `parentID` threaded, and dispatch through the SAME slice
 * pipeline a conductor-planned slice rides. No `ctx.ask` here — a delegate
 * decision must never park a headless child on a permission Deferred; the
 * seat registry is the gate, and a session without a registered seat is
 * refused with the reason. Permission-layer hygiene (childSlicePermission's
 * `delegate` rule) additionally drops the tool from every non-delegating
 * session's advertised toolset.
 *
 * @sem domain=routing role=tools
 */
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./delegate.txt"
import { delegateFromSeat, getDelegationSeat } from "../session/slice-delegation"

const Parameters = Schema.Struct({
  content: Schema.String.annotate({
    description:
      "The delegate's whole brief: the exact paths, the exact change/commands/question, and the report format expected back. The child starts with zero context.",
  }),
  slice_type: Schema.optional(Schema.String).annotate({
    description: "Optional slice shape: design, mechanical, recon, or verify. Inferred from the content when omitted.",
  }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional explicit file scope for the delegate. Must stay inside your own slice's file scope.",
  }),
})

export const DelegateTool = Tool.define(
  "delegate",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const seat = getDelegationSeat(ctx.sessionID)
        if (!seat) {
          // Not a delegating seat (executor/conductor seats, delegate
          // children, raw task children, or the lead session itself). Policy
          // in code: refuse with the path that IS available to this caller.
          return {
            title: "delegate refused",
            metadata: { refused: true },
            output:
              "DELEGATE REFUSED — this session is not a delegating seat. Only a dispatched reasoner/oracle slice seat may delegate (down-only, depth 1). " +
              "If you are the lead: type the work as todowrite slices instead. Otherwise finish your slice and declare the discovery in your report.",
          }
        }
        const result = yield* Effect.promise(() =>
          delegateFromSeat(seat, {
            content: params.content,
            ...(params.slice_type !== undefined ? { sliceType: params.slice_type } : {}),
            ...(params.files !== undefined ? { files: params.files } : {}),
          }),
        )
        return {
          title: result.refused ? "delegate refused" : `delegated → ${result.tier}`,
          metadata: { refused: result.refused, ...(result.tier ? { tier: result.tier } : {}) },
          output: result.output,
        }
      }),
  }),
)
