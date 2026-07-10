/**
 * P11b — the `delegate` tool boundary. Policy lives entirely in
 * session/slice-delegation.ts (covered by test/session/slice-delegation.test.ts);
 * these rows pin the tool's own contract: a session WITHOUT a registered
 * delegation seat is refused with the reason (no ctx.ask — a delegate decision
 * must never park a headless child on a permission Deferred), and a session
 * WITH one routes through delegateFromSeat and reports the code-resolved tier.
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { DelegateTool } from "../../src/tool/delegate"
import {
  registerDelegationSeat,
  releaseDelegationSeat,
  type DelegationPorts,
} from "../../src/session/slice-delegation"
import type { SliceProbes } from "../../src/session/slice-orchestrator"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

function makeCtx(sessionID: string): Tool.Context & { askedCount: () => number } {
  let asked = 0
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => {
      asked++
      return Effect.void
    },
    askedCount: () => asked,
  }
}

const PROBES: SliceProbes = {
  probeCoupling: async () => ({ coupling: "low" }),
  probeTestStrength: async () => ({ testStrength: "testable" }),
}

describe("tool.delegate (P11b)", () => {
  it.instance("refuses a session with no registered delegation seat, without asking permission", () =>
    Effect.gen(function* () {
      const info = yield* DelegateTool
      const def = yield* info.init()
      const ctx = makeCtx("ses_delegate-no-seat")
      const execute = def.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof def.execute>

      const result = yield* execute({ content: "Apply the decided edit in src/x.ts" }, ctx)

      expect(result.metadata).toMatchObject({ refused: true })
      expect(result.output).toContain("DELEGATE REFUSED")
      expect(result.output).toContain("not a delegating seat")
      expect(ctx.askedCount()).toBe(0)
    }),
  )

  it.instance("routes a registered seat through delegateFromSeat and reports the code-resolved tier", () =>
    Effect.gen(function* () {
      const sessionID = "ses_delegate-seated"
      const ports: DelegationPorts = {
        dispatch: async () => ({ text: "done", parts: [] }),
        probes: PROBES,
        options: { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
        getTodos: async () => [{ content: "parent slice", status: "in_progress", sliceType: "design" }],
        appendTodo: async () => 1,
        setTodoStatus: async () => {},
      }
      registerDelegationSeat(sessionID, {
        parentSliceId: "parent slice",
        callerTier: "reasoner",
        parentScope: new Set(),
        ports,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseDelegationSeat(sessionID)))

      const info = yield* DelegateTool
      const def = yield* info.init()
      const execute = def.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof def.execute>

      const result = yield* execute(
        { content: "Apply the decided edit in src/x.ts", slice_type: "mechanical" },
        makeCtx(sessionID),
      )

      expect(result.metadata).toMatchObject({ refused: false, tier: "executor" })
      expect(result.title).toBe("delegated → executor")
      expect(result.output).toStartWith("DELEGATED → executor")
    }),
  )
})
