import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema, generateText } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { planRaiseForTurn, isEconTierAgent } from "./tier-router"
import { probeTurnRisk, probeSliceCoupling, probeSliceTestStrength, probeSliceVerifyCommands, ensureGraphReady } from "../tool/graph-tools"
import { setTestEditGate, testEditGateArmed } from "../tool/edit-governance"
import { createStuckSupervisor } from "../../../code-intelligence/src/orchestration-fsm"
import { observeStep } from "./turn-supervisor"
import { stuckNudgeText, LENGTH_CONTINUATION_NUDGE } from "./prompts/nudges"
import { triagePreamble } from "./prompts/preambles"
import { LOCALIZATION_SLICE_CONTENT, PLAN_SLICE_CONTENT } from "./prompts/seeds"
import {
  STRUCTURED_OUTPUT_DESCRIPTION,
  STRUCTURED_OUTPUT_SYSTEM_PROMPT,
  TITLE_GENERATION_PROMPT_MARKER,
} from "./prompts/protocol"
import {
  createRmVerifierRung,
  resolveVerifierTier,
  resolveJudgeTier,
  isReadOnlySlice,
  type RmClient,
} from "@opencode-ai/code-intelligence"
import {
  runConductorOrchestration,
  resolveSliceModel,
  hasPendingTypedSlices,
  isFixShapedPrompt,
  promptAuthorizesTestEdits,
  buildTriageTodoSkeleton,
  childSlicePermission,
  isDeciderSeat,
  personaForSlice,
  sliceStepBudget,
  countToolCalls,
  budgetExhaustedMarker,
  buildRepoPrimer,
  renderSliceDigestLedger,
  deriveTurnProbe,
  runTurnProbeGate,
  makeShellCommandRunner,
  type ConductorSliceDispatch,
  type OrchestrationTodo,
  type SliceDigestEntry,
} from "./slice-orchestrator"
import { runTurnRead, triageTelemetry, type TriageComplete, type TriageVerdict } from "./turn-triage"
import { decideArming, type ArmingVerdict } from "./arming-judge"
import { setArmingDecision, getArmingDecision } from "./arming-store"
import { resetResolveAttempts } from "./resolution-store"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { Question } from "@/question"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { Snapshot } from "@/snapshot"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, buildChildPrompt, type TaskPromptOps } from "@/tool/task"
import { EffectBridge } from "@/effect/bridge"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AgentAttachment, FileAttachment, Prompt, Source } from "@opencode-ai/core/session/prompt"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { LLMEvent } from "@opencode-ai/llm"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

/**
 * Whether a localization/plan slice's output shows a discriminating probe was
 * actually run (a runnable backticked command, an explicit rule-out/
 * elimination claim, or an honest OPEN/MISSING gap) rather than only
 * asserting a cause from narrative alone — the frame-slice fold-back uses
 * this to decide whether the relayed frame needs a narrative-only warning.
 *
 * @sem domain=routing role=guard
 */
export function isProbeGrounded(text: string): boolean {
  const lower = text.toLowerCase()
  const hasProbeCommand =
    /`(?:bun|npm|pnpm|yarn|node|tsc|tsgo|jest|vitest|pytest|go|cargo|make|grep|rg|git)\b[^`]*`/i.test(text)
  const hasProbePhrase = [
    "ruled out",
    "rules out",
    "eliminated",
    "discriminating probe",
    "probe result",
    "probe:",
    "open:",
    "missing:",
  ].some((phrase) => lower.includes(phrase))
  if (hasProbeCommand || hasProbePhrase) return true
  const assertsCause = ["root cause", "the cause is", "the bug is", "caused by", "the culprit"].some((phrase) =>
    lower.includes(phrase),
  )
  return !assertsCause
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

/**
 * Test-harness seam for the turn-open LLM calls (the merged turn-read +
 * title). Production never provides this service — absent means both calls
 * run (always-on, no feature flag). Mock-provider test harnesses provide
 * `{ triage: false, titles: false }` so the extra turn-open requests don't
 * consume their scripted responses; the `triage` key gates the turn-read.
 *
 * @sem domain=routing role=config
 */
export class TurnOpenCalls extends Context.Service<
  TurnOpenCalls,
  { readonly triage: boolean; readonly titles: boolean }
>()("@opencode/SessionPrompt/TurnOpenCalls") {}

// P5 null-rate counters — per-process, counted at the turn-open turn-read.
// The neutral-degrade rate is P5's acceptance metric (<2% of turns after the
// cross-tier re-ask); each degrade logs `turn_read_degraded` with the
// running counts so the number exists before the benchmark phase reads it.
let turnReads = 0
let turnReadNulls = 0

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const snapshot = yield* Snapshot.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const { db } = database
    // OL-7.3b — the conductor slice-loop hook reads the just-written typed DAG and
    // mirrors slice status back onto the todo tracker through this service.
    const todoStore = yield* SessionTodo.Service
    // #53/#54 resolution gate's "ask-user" mode (sliceHook, below) — resolved
    // here, not inside sliceHook's own Effect.gen, so that block's explicit
    // `Effect.Effect<void>` (R=never) annotation still holds: `question`'s
    // methods return already-concrete effects once the service itself is
    // resolved, same as `todoStore` above.
    const question = yield* Question.Service
    // Turn-open LLM calls (triage + title) are always-on in production; only
    // mock-provider test harnesses provide TurnOpenCalls to switch them off.
    const turnOpen = Option.getOrElse(yield* Effect.serviceOption(TurnOpenCalls), () => ({
      triage: true,
      titles: true,
    }))
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: `${TITLE_GENERATION_PROMPT_MARKER}:\n` }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    /**
     * §1.1/§4.1 — the ONE turn-open LLM read (P1-alt): a tool-free,
     * temperature-0, forced-JSON completion whose verdict carries goals,
     * constraints, AND the per-diagnosis-goal arming evidence — replacing the
     * two sequential triage + arming dispatches. `tier:"conductor"` reuses
     * the turn's own bound model — the spine never moves (§1.7);
     * `tier:"reasoner"` resolves via the same tier->model path child slices
     * use (`resolveSliceModel`) for the low-confidence/null re-ask (§4.1/P5).
     * P2a — temperature is threaded the same way as the other temp-0
     * dispatches (the verifier judge and the confidence probe below):
     * `generateText` hands it straight to the provider request, bypassing the
     * llm.stream capability gate that silently drops `temperature` for models
     * whose registry entry doesn't declare it. No reasoning-effort override —
     * the conductor reasons through the evidence fields at its provider
     * default (muted, it mis-shapes extraction and over-fires STRONG-grounded
     * diagnoses; PROMPT_SLICING_CORPUS.md R2). Returns `null` on any failure —
     * the caller owns the P5 cross-tier re-ask and neutral degrade.
     *
     * @sem domain=routing role=extractor
     */
    const turnReadDispatch = Effect.fn("SessionPrompt.turnReadDispatch")(function* (input: {
      sessionID: SessionID
      lastUser: SessionV1.User
      tier: "conductor" | "reasoner"
      userPrompt: string
    }) {
      const { sessionID, lastUser, tier, userPrompt } = input
      const { providerID, modelID } =
        tier === "conductor"
          ? { providerID: lastUser.model.providerID, modelID: lastUser.model.modelID }
          : ((): { providerID: ProviderV2.ID; modelID: ModelV2.ID } => {
              const m = resolveSliceModel(tier)
              return { providerID: ProviderV2.ID.make(m.providerID), modelID: ModelV2.ID.make(m.modelID) }
            })()
      // An unresolvable model or language degrades to null — the caller's P5
      // path owns the re-ask/neutral-degrade; a housekeeping read never kills
      // the turn (the reasoner binding may be absent on this provider path).
      const mdl = Option.getOrUndefined(yield* provider.getModel(providerID, modelID).pipe(Effect.option))
      if (!mdl) {
        yield* Effect.logInfo("turn_read_model_unavailable", { "session.id": sessionID, tier })
        return null
      }
      const language = Option.getOrUndefined(yield* provider.getLanguage(mdl).pipe(Effect.option))
      if (!language) return null
      const complete: TriageComplete = async ({ system, user, timeoutMs }) => {
        const out = await generateText({
          model: language,
          system,
          prompt: user,
          maxOutputTokens: 4096,
          temperature: 0,
          abortSignal: AbortSignal.timeout(timeoutMs),
        })
        // A reasoning conductor can length-starve content and land the JSON
        // answer in the reasoning channel — prefer content, fall back to it.
        return out.text.trim() || (out.reasoningText ?? "")
      }
      let parseRetried = false
      const verdict = yield* Effect.promise(() =>
        runTurnRead({ userPrompt, complete, onParseRetry: () => (parseRetried = true) }),
      )
      // The retry itself lives in runTurnRead; this line only makes a
      // formerly-silent extraction flake decodable from the run log.
      if (parseRetried) yield* Effect.logInfo("turn_read_retry", { reason: "parse", tier })
      return verdict
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Shell.Started, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: DateTime.makeUnsafe(started),
                callID: part.callID,
                command: input.command,
              })
            }
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Shell.Ended, {
                  sessionID: input.sessionID,
                  timestamp: DateTime.makeUnsafe(completed),
                  callID: part.callID,
                  output,
                })
              }
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      let ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      // Turn-level tier routing demoted 2026-07-06 (run-19 live-fire): the lead agent is never
      // swapped at turn-open. Escalation is slice-level only — allocateSlice (coupling ×
      // test-strength + the conductor's `need` hint) routes each decomposed slice and the
      // escalation ladder retries a failed slice upward. A prior-turn abstention is visible to
      // the conductor in its own transcript and rides the ladder; it no longer forces a
      // whole-turn oracle lead. What survives here is OL-7.5: raise the conductor's plan-time
      // reasoning for this turn's decomposition step when the turn-open signals (prompt
      // heaviness, structural risk of the prompt's entities) call for it; a trivial turn stays
      // at the conductor's configured baseline (reasoningEffort:"none"), spending zero reasoning
      // tokens on planning. reasoningEffort is the AI-SDK camelCase option key that
      // @ai-sdk/openai-compatible actually validates and lowers to the wire param
      // reasoning_effort for the LiteLLM→Fireworks path — a snake_case key here would be
      // silently dropped instead (OL-9.6e). The OpenRouter-era `reasoning` object still 400s
      // at Fireworks: "Extra inputs are not permitted".
      if (!input.agent && !input.model && isEconTierAgent(ag.name)) {
        const promptText = input.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n")
        // OL-3.3 signal, reused: bounded, best-effort structural risk — probeTurnRisk swallows a
        // cold graph, an index-latency timeout, or any error into 0.
        const risk = yield* Effect.promise(() => probeTurnRisk(promptText))
        if (ag.name === "conductor" && planRaiseForTurn({ prompt: promptText, risk })) {
          ag = { ...ag, options: { ...ag.options, reasoningEffort: "high" } }
        }
      }

      const current = yield* db
        .select({ agent: SessionTable.agent, model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      if (current?.agent !== info.agent) {
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: info.agent,
          source: "system",
        })
      }
      if (
        current?.model?.providerID !== info.model.providerID ||
        current.model.id !== info.model.modelID ||
        (current.model.variant === "default" ? undefined : current.model.variant) !== info.model.variant
      ) {
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          model: {
            id: ModelV2.ID.make(info.model.modelID),
            providerID: ProviderV2.ID.make(info.model.providerID),
            variant: ModelV2.VariantID.make(info.model.variant ?? "default"),
          },
          source: "system",
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)
      const nextPrompt = parts.reduce(
        (result, part) => {
          if (part.type === "text") {
            if (part.synthetic) result.synthetic.push(part.text)
            else result.text.push(part.text)
          }
          if (part.type === "file") {
            result.files.push(
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                name: part.filename,
                source: part.source
                  ? new Source({
                      start: part.source.text.start,
                      end: part.source.text.end,
                      text: part.source.text.value,
                    })
                  : undefined,
              }),
            )
          }
          if (part.type === "agent") {
            result.agents.push(
              new AgentAttachment({
                name: part.name,
                source: part.source
                  ? new Source({
                      start: part.source.start,
                      end: part.source.end,
                      text: part.source.value,
                    })
                  : undefined,
              }),
            )
          }
          return result
        },
        {
          text: [] as string[],
          files: [] as FileAttachment[],
          agents: [] as AgentAttachment[],
          synthetic: [] as string[],
        },
      )
      // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(info.time.created),
          delivery: "steer",
          prompt: new Prompt({
            text: nextPrompt.text.join("\n"),
            files: nextPrompt.files,
            agents: nextPrompt.agents,
          }),
        })
      }
      for (const text of nextPrompt.synthetic) {
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID: input.sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(info.time.created),
            text,
          })
        }
      }

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        // OL-9.5: edge-triggered orchestration — remember the todo-list shape the
        // slice hook last engaged on, so later steps of the same turn cannot
        // re-dispatch the same batch (run 8: status mirrors raced, todos stayed
        // pending, and every subsequent step re-ran the whole DAG).
        let engagedTodoFingerprint: string | undefined
        // The turn-open block (turn-read + arming + skeleton) runs at most once per run.
        let prepassSeeded = false
        // The root turn's triage preamble, set once at turn open. Appended to
        // every step's system array this turn: the shared prefix stays
        // byte-stable (the AC-7.2 golden hash never sees it) and the turn
        // framing rides the tail, varying per turn without a prompt swap.
        // Undefined on a null-verdict turn — P5 neutral degrade rides nothing.
        let turnPreamble: string | undefined
        // U1/U2 — the root turn's triage goal count, set once at turn open
        // alongside turnPreamble; fed into shouldOrchestrate's width check at
        // the orchestration hook further down this same turn. Undefined on a
        // null-verdict (P5 neutral-degrade) turn.
        let turnGoalCount: number | undefined
        // OL-9.6b: finish="length" is an output-cap truncation, not a completed
        // turn (run 9: a 7.9k-token think hit the 8192 cap on the root-cause
        // step, returned zero parts, and the run exited 0 as if finished).
        // Nudge the model to continue, bounded so a pathological truncation
        // loop still terminates — but never as a silent success.
        const MAX_LENGTH_CONTINUATIONS = 2
        let lengthContinuations = 0
        // M4 — turn-level prove-it gate state: the reproduction the prompt
        // pinned at turn open (undefined ⇒ the gate no-ops) and its bounded
        // retry count. The gate re-runs the repro at turn END so an INLINE fix
        // that left it red cannot conclude — the slice-level probe rung only
        // guards dispatched slices, which an inline fix never creates.
        let turnPinnedProbe: Awaited<ReturnType<typeof deriveTurnProbe>>
        let probeGateRetries = 0
        const MAX_PROBE_GATE_RETRIES = 3
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        // SM4 — root-loop stuck supervisor. The inline path (this loop) had no
        // per-step supervisor: django-11885 thrashed 12x on the same red test
        // and then fake-green-edited it, all before the M4 exit gate below ever
        // ran (every thrash step carried tool calls, so the turn never took the
        // exit path). The supervisor distils each completed step and, on a stuck
        // signal, climbs a capped two-rung ladder: rung 1 injects a rethink
        // nudge (a USER message, which the adaptive reasoning gate reads as a
        // plan step and un-mutes the conductor's thinking); rung 2 also bumps
        // the driving model to the reasoner as edit-and-run owner. Root sessions
        // only — child slices already run the slice-loop FSM.
        const stuckSupervisor = session.parentID ? undefined : createStuckSupervisor()
        let escalatedModelRef: { providerID: string; modelID: string } | undefined
        let stuckEscalations = 0
        const MAX_STUCK_ESCALATIONS = 2
        let lastObservedAssistantID: string | undefined

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          // SM4 — observe the step that just completed. Pin a reproduction from
          // the most-specific test the model ran RED (probe-from-red, so a
          // narrative prompt that named no repro still arms the turn-end gate),
          // then, if the supervisor flags a stuck loop, climb the escalation
          // ladder before the next model call is issued.
          if (stuckSupervisor && hasToolCalls && lastAssistant && lastAssistant.id !== lastObservedAssistantID) {
            lastObservedAssistantID = lastAssistant.id
            const stepObs = observeStep(lastAssistantMsg?.parts ?? [], {
              isTestSlice: !testEditGateArmed(sessionID),
            })
            // probe-from-red: pin while the test is still red — re-running it at
            // turn end (deriveTurnProbe's runner) confirms redness and picks the
            // most-specific case; a fake-green test edit is caught separately by
            // the edit-time deny and the turn-end test-tree guard.
            if (!turnPinnedProbe && !session.parentID && stepObs.failedCommands.length > 0) {
              const candidateTests = [...new Set(stepObs.failedCommands)].map((command) => ({
                kind: "test" as const,
                command,
              }))
              turnPinnedProbe = yield* Effect.promise(() =>
                deriveTurnProbe({
                  promptText: "",
                  candidateTests,
                  runner: makeShellCommandRunner({ cwd: ctx.directory }),
                }),
              )
              if (turnPinnedProbe)
                yield* Effect.logInfo("turn_probe_pinned_from_red", {
                  "session.id": sessionID,
                  probe: turnPinnedProbe.command,
                })
            }
            const stuckSignal = stuckSupervisor.observe(stepObs.observation)
            if (stuckSignal && stuckEscalations < MAX_STUCK_ESCALATIONS) {
              stuckEscalations++
              // A test-edit tell jumps straight to the reasoner (code-wrong vs
              // test-stale is a reasoning call); otherwise rung 1 rethinks on the
              // conductor, rung 2 bumps to the reasoner as edit-and-run owner.
              const toReasoner = stuckSignal.reason === "test-edit" || stuckEscalations >= 2
              if (toReasoner) {
                escalatedModelRef = resolveSliceModel("reasoner")
                yield* Effect.logWarning("stuck_escalate", {
                  "session.id": sessionID,
                  mechanism: "sm-backstop",
                  reason: stuckSignal.reason,
                  count: stuckSignal.count,
                  tier: "reasoner",
                })
              } else {
                yield* Effect.logInfo("stuck_rethink", {
                  "session.id": sessionID,
                  mechanism: "sm-backstop",
                  reason: stuckSignal.reason,
                  count: stuckSignal.count,
                })
              }
              const rethink: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              }
              yield* sessions.updateMessage(rethink)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: rethink.id,
                sessionID,
                type: "text",
                text: stuckNudgeText(stuckSignal, stuckEscalations),
                synthetic: true,
              } satisfies SessionV1.TextPart)
              continue
            }
          }

          // OL-9.6b: an output-cap truncation with no surviving tool calls means
          // the step produced nothing actionable — continue the turn instead of
          // exiting as if it finished. Bounded: after MAX_LENGTH_CONTINUATIONS
          // the loop exits through the generic break below, with an error log
          // so the exit is attributable, and the run CLI surfaces the truncated
          // finish to stderr.
          if (lastAssistant?.finish === "length" && !hasToolCalls && lastUser.id < lastAssistant.id) {
            if (lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
              lengthContinuations++
              yield* Effect.logWarning("length_continuation", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                attempt: lengthContinuations,
              })
              const nudge: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              }
              yield* sessions.updateMessage(nudge)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: nudge.id,
                sessionID,
                type: "text",
                text: LENGTH_CONTINUATION_NUDGE,
                synthetic: true,
              } satisfies SessionV1.TextPart)
              continue
            }
            yield* Effect.logError("loop exit on repeated output-cap truncation", {
              "session.id": sessionID,
              messageID: lastAssistant.id,
              continuations: lengthContinuations,
            })
          }

          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            // M4 — turn-level prove-it gate: a fix-shaped root turn that pinned
            // a reproduction may not conclude while that repro is red (or a
            // tracked test was edited on a no-test-edit turn). Catches INLINE
            // fixes the slice-level probe rung never saw. Reuses the length-
            // continuation re-entry primitive; bounded by MAX_PROBE_GATE_RETRIES,
            // after which it exits LOUDLY (turn_probe_unresolved), never as a
            // silent success.
            if (turnPinnedProbe && !session.parentID) {
              const gate = yield* Effect.promise(() =>
                runTurnProbeGate({
                  probe: turnPinnedProbe!,
                  noTestEdit: testEditGateArmed(sessionID),
                }),
              )
              if (gate.reject) {
                if (probeGateRetries < MAX_PROBE_GATE_RETRIES) {
                  probeGateRetries++
                  yield* Effect.logInfo("turn_probe_gate", {
                    "session.id": sessionID,
                    rung: gate.rung ?? null,
                    exit: gate.exitCode ?? null,
                    retry: probeGateRetries,
                  })
                  const nudge: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(nudge)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: nudge.id,
                    sessionID,
                    type: "text",
                    text: gate.reason!,
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                  continue
                }
                yield* Effect.logWarning("turn_probe_unresolved", {
                  "session.id": sessionID,
                  probe: turnPinnedProbe.command,
                  retries: probeGateRetries,
                })
              }
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            break
          }

          // The turn-open block, root sessions only, once per run: ONE
          // temperature-0 turn-read call (P1-alt) extracts goals +
          // constraints + per-diagnosis-goal evidence, and `decideArming`
          // (pure code, arming-judge.ts) converts the evidence into the
          // localization-arming decision. The verdict then drives the turn
          // preamble, the todo skeleton (frame seeds included), the
          // no-test-edit constraint, and the M4 probe pin. Failure path (P5):
          // null after the call's one same-tier retry → ONE reasoner re-ask
          // (a different provider family — a real redundancy domain) →
          // NEUTRAL DEGRADE: no preamble, no skeleton, arming stands down,
          // the turn proceeds unguided. No regex shape-guessing.
          //
          // B3 — the same turn-open point arms the no-test-edit gate: on a
          // fix-shaped turn with no explicit test-work ask, modifying an
          // existing test file is denied at the edit/write boundary
          // (governance regexes, independent of the turn-read). Child slice
          // sessions inherit the parent's gate unless their own task is
          // test-work-shaped (the repro/test-authoring slice stays free).
          if (step === 0 && !prepassSeeded) {
            prepassSeeded = true
            const userText = (msgs.find((m) => m.info.id === lastUser.id)?.parts ?? [])
              .map((p) => (p.type === "text" ? p.text : ""))
              .filter(Boolean)
              .join("\n")
            if (session.parentID) {
              setTestEditGate(sessionID, testEditGateArmed(session.parentID) && !promptAuthorizesTestEdits(userText))
            } else {
              // P10 — the resolution budget is per TURN, not per session: a new
              // user turn is a new task, so the resolve-attempts counter resets
              // here with the other turn-open stores. A later turn-open rewrite
              // must preserve this reset or one ambiguous turn disables the
              // resolution gate for the rest of the session.
              resetResolveAttempts(sessionID)
              const regexDenyTestEdits = isFixShapedPrompt(userText) && !promptAuthorizesTestEdits(userText)

              // The turn-read runs on every root turn open (always-on, no
              // feature flag); TurnOpenCalls is the test-only off switch so
              // mock harnesses keep their scripted choreography.
              let verdict: TriageVerdict | null = null
              let arming: ArmingVerdict | undefined
              if (turnOpen.triage) {
                turnReads++
                verdict = yield* turnReadDispatch({ sessionID, lastUser, tier: "conductor", userPrompt: userText })
                if (!verdict) {
                  // P5 — the cross-tier re-ask: the same reasoner re-run the
                  // low-confidence path uses, now also covering a null merged
                  // verdict (extraction flake / timeout / transient error).
                  verdict = yield* turnReadDispatch({ sessionID, lastUser, tier: "reasoner", userPrompt: userText })
                } else if (verdict.confidence === "low") {
                  const reasonerVerdict = yield* turnReadDispatch({
                    sessionID,
                    lastUser,
                    tier: "reasoner",
                    userPrompt: userText,
                  })
                  if (reasonerVerdict && reasonerVerdict.goals.length >= verdict.goals.length) verdict = reasonerVerdict
                }

                // P1-alt — arming is decided in CODE over the extracted
                // evidence, never by the model. Stored every turn — the null
                // verdict's stand-down included — so the todowrite door
                // (autoTypeTodos) and the per-slice difficulty floor never
                // read a stale decision from an earlier turn.
                arming = decideArming(verdict)
                setArmingDecision(sessionID, arming)
                yield* Effect.logInfo("arming_decided", {
                  "session.id": sessionID,
                  armLocalization: arming.armLocalization,
                  hardness: arming.hardness,
                  ambiguity: arming.ambiguity,
                  evidence: arming.evidence,
                })
              }

              if (verdict && arming) {
                // U1/U2 — a non-null verdict is the decider for this turn's
                // preamble, gates, and skeleton.
                turnPreamble = triagePreamble(verdict, arming)
                turnGoalCount = verdict.goals.length
                yield* Effect.logInfo("turn_triage", { "session.id": sessionID, ...triageTelemetry(verdict) })

                // B3 — triage's constraint is the primary armer; OR in the
                // governance-regex signal so a turn-read MISS can never disarm
                // a gate the regex would have armed on its own.
                const triageDenyTestEdits = verdict.constraints.some((c) => c.kind === "no-test-edit")
                const denyTestEdits = regexDenyTestEdits || triageDenyTestEdits
                setTestEditGate(sessionID, denyTestEdits)
                if (denyTestEdits) yield* Effect.logInfo("test_edit_gate_armed", { "session.id": sessionID })

                // M4 — the probe pin keys on the VERDICT: a diagnosis-shaped
                // goal arms the turn-end prove-it gate with the most-specific
                // reproduction the prompt names, so an INLINE fix cannot
                // conclude red (no dispatched slice → no probe rung). Turn-read
                // failed ⇒ no turn-open pin this turn — the probe-from-red pin
                // and the slice verify rungs still run.
                if (verdict.goals.some((g) => g.shape === "diagnosis-vague" || g.shape === "diagnosis-grounded")) {
                  turnPinnedProbe = yield* Effect.promise(() => deriveTurnProbe({ promptText: userText }))
                  if (turnPinnedProbe)
                    yield* Effect.logInfo("turn_probe_pinned", {
                      "session.id": sessionID,
                      probe: turnPinnedProbe.command,
                    })
                }

                const existingTodos = yield* todoStore.get(sessionID).pipe(Effect.orElseSucceed(() => []))
                if (existingTodos.length === 0) {
                  const skeleton = buildTriageTodoSkeleton(verdict, arming)
                  // Owner-decision trace: which goals seeded a reasoner pre-pass
                  // (the diagnosis writer) and the shapes that drove it — the
                  // stage-1 routing decision, logged with mechanism:"orchestrator"
                  // so a trace separates a reasoner cast UP FRONT here from one
                  // cast as RECOVERY by the SM backstop (stuck_escalate below).
                  const seeds = skeleton
                    .map((t) =>
                      t.content === LOCALIZATION_SLICE_CONTENT
                        ? "localization"
                        : t.content === PLAN_SLICE_CONTENT
                          ? "plan"
                          : undefined,
                    )
                    .filter((s) => s !== undefined)
                  yield* Effect.logInfo("frame_seed_planted", {
                    "session.id": sessionID,
                    mechanism: "orchestrator",
                    seeds,
                    shapes: verdict.goals.map((g) => g.shape),
                  })
                  yield* todoStore.update({ sessionID, todos: skeleton }).pipe(Effect.ignore)
                }
              } else {
                // P5 NEUTRAL DEGRADE — a null turn plants NOTHING: no
                // preamble, no skeleton, no probe pin. A wrong guess steers
                // the conductor worse than no guess. Only the governance
                // regexes still arm the no-test-edit gate.
                setTestEditGate(sessionID, regexDenyTestEdits)
                if (regexDenyTestEdits) yield* Effect.logInfo("test_edit_gate_armed", { "session.id": sessionID })
                if (turnOpen.triage) {
                  turnReadNulls++
                  yield* Effect.logInfo("turn_read_degraded", {
                    "session.id": sessionID,
                    turnReads,
                    turnReadNulls,
                  })
                }
              }
            }
          }

          step++
          // Session-title generation: one forked/non-blocking small-model call,
          // already gated to the first user turn of a top-level session inside
          // `title` (ensureTitle). Always-on; TurnOpenCalls is the test-only off
          // switch.
          if (step === 1 && turnOpen.titles)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          // SM4 — once the supervisor has escalated, the reasoner drives the
          // remaining steps of this turn (edit-and-run owner); otherwise the
          // turn's own bound model.
          const model = escalatedModelRef
            ? yield* getModel(
                ProviderV2.ID.make(escalatedModelRef.providerID),
                ModelV2.ID.make(escalatedModelRef.modelID),
                sessionID,
              )
            : yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            // AC-1.1: route through the prune-first ladder instead of jumping
            // straight to the LLM summarize step.
            const result = yield* compaction.compact({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            // AC-1.5: never compact mid-step — a "tool-calls" finish reason means
            // this agentic turn still has more steps queued. Defer to the next
            // clean task boundary instead of preempting it.
            const cfgNow = yield* config.get()
            const boundaryOnly = cfgNow.compaction?.task_boundary_only !== false
            if (boundaryOnly && lastFinished.finish === "tool-calls") {
              yield* Effect.logWarning("approaching context limit — will compact at next safe point", {
                "session.id": sessionID,
              })
            } else {
              yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
              continue
            }
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          // OL-0.1: turn-phase telemetry — structured-log twin of the turn_phase
          // NDJSON events run.ts derives from message/tool events on this same
          // step boundary, so the phase is visible from the log sink too.
          yield* Effect.logInfo("turn_phase", {
            "session.id": sessionID,
            phase: step === 1 ? "plan" : "execute",
            step,
            agent: agent.name,
            model: model.id,
          })
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()

            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
            )

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            // AC-7.2/AC-8.3 — sort tool keys by id right before the tools object is
            // handed to the model, so the same enabled-tool set always serializes to
            // the same byte-stable prefix regardless of source resolution order this
            // turn. See SessionTools.orderToolsForCache for why this is needed.
            const orderedTools = SessionTools.orderToolsForCache(tools)

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const [skills, env, instructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const system = [...env, ...instructions, ...(skills ? [skills] : [])]
            // §8 rule 4 — the turn's casting preamble rides the TAIL of the
            // system array, never a prefix swap: byte-stable across this
            // turn's steps (they cache against each other), and the shared
            // prefix above it never varies.
            if (turnPreamble) system.push(turnPreamble)
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [
                ...modelMsgs,
                ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
              ],
              tools: orderedTools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break

          // OL-7.3b — the conductor slice-loop hook. Decomposition orchestration is
          // unconditional; engagement is driven solely by the `hasPendingTypedSlices`
          // precondition below, which is FIRST and total: with no typed todos nothing
          // past it is constructed or run, so a plain turn pays zero extra work (no
          // bridge, no promptOps). When the step just wrote a typed DAG with pending
          // slices, the loop executes that DAG as child sessions and mirrors each
          // slice's status onto the tracker. Every failure — a bad DAG, a probe,
          // dispatch, or ladder throw — is caught here and metered, and the turn falls
          // back to the legacy path: a broken orchestrator must never kill a user turn.
          {
            const sliceHook: Effect.Effect<void> = Effect.gen(function* () {
              // OL-9.5: children never orchestrate — run 8's "write summary"
              // procedure child wrote its own todo list and self-orchestrated 43
              // grandchild sessions. Decomposition is the root session's privilege.
              if (session.parentID) return
              const pendingTodos = yield* todoStore.get(sessionID)
              if (!hasPendingTypedSlices(pendingTodos)) return
              // OL-9.5: level→edge trigger — one engagement per distinct todo list.
              const fingerprint = JSON.stringify(
                pendingTodos.map((t) => [t.content, t.status, (t as { sliceType?: string }).sliceType ?? ""]),
              )
              if (fingerprint === engagedTodoFingerprint) return
              engagedTodoFingerprint = fingerprint

              const bridge = yield* EffectBridge.make()
              const promptOps = yield* ops()

              const rmClient: RmClient = async (endpoint, input) => {
                const res = await fetch(endpoint, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(input),
                })
                const json = (await res.json()) as { score: number; detail?: string }
                return { score: json.score, detail: json.detail }
              }
              const rmRung = createRmVerifierRung(resolveVerifierTier(process.env["ECON_VERIFIER_RM"]), rmClient)

              // OL-7.8 cross-model judge sampler: a one-shot, tool-free completion
              // on the judge tier's model through the normal provider path — no
              // child session, no tools, no streaming. The tier resolves via the
              // registry (default reasoner: cross-family vs every judge-cell
              // generator; ECON_VERIFIER_JUDGE=off / =<tier> overrides). A thrown
              // sampler is fine — runCrossModelJudge awaits and degrades to the
              // next rung — so failures reject here rather than being swallowed.
              const judgeTier = resolveJudgeTier(process.env["ECON_VERIFIER_JUDGE"])
              const judgeGenerate = judgeTier.enabled
                ? (judgePrompt: string): Promise<string> =>
                    bridge.promise(
                      Effect.gen(function* () {
                        const m = resolveSliceModel(judgeTier.tier)
                        const resolved = yield* provider.getModel(
                          ProviderV2.ID.make(m.providerID),
                          ModelV2.ID.make(m.modelID),
                        )
                        const language = yield* provider.getLanguage(resolved)
                        const startedAt = Date.now()
                        // OL-7.8b: live-fire proved two silent degrades — a reasoning
                        // judge model burns the output budget on thinking before the
                        // verdict token (400 truncated every time; 1024 gives headroom),
                        // and a transient gateway throw looked identical to an abstain.
                        // One retry absorbs the blip; a still-failing final attempt logs
                        // before rethrowing so the caller's degrade stays traceable.
                        const runOnce = () =>
                          Effect.tryPromise({
                            try: () =>
                              generateText({ model: language, prompt: judgePrompt, maxOutputTokens: 1024, temperature: 0 }),
                            catch: (err) => err,
                          })
                        let retried = false
                        const out = yield* runOnce().pipe(
                          Effect.matchEffect({
                            onFailure: () => {
                              retried = true
                              return runOnce()
                            },
                            onSuccess: (value) => Effect.succeed(value),
                          }),
                          Effect.tapError((err) =>
                            Effect.logInfo("judge_failed", {
                              "session.id": sessionID,
                              tier: judgeTier.tier,
                              modelID: m.modelID,
                              error: String(err).slice(0, 200),
                              retried,
                            }),
                          ),
                        )
                        // OL-7.8 observability: a fired judge sample was otherwise
                        // indistinguishable from a skipped one in the decode — one
                        // line per sample closes that gap.
                        yield* Effect.logInfo("judge_sampled", {
                          "session.id": sessionID,
                          tier: judgeTier.tier,
                          modelID: m.modelID,
                          elapsedMs: Date.now() - startedAt,
                          inputTokens: out.usage?.inputTokens ?? 0,
                          outputTokens: out.usage?.outputTokens ?? 0,
                          retried,
                        })
                        return out.text
                      }),
                    )
                : undefined

              // OL-9.4b: built once per orchestration run and reused across every
              // dispatched slice — live-run evidence showed parallel wave-1 slices
              // each independently re-reading package.json and re-listing
              // directories before their real work. completedSliceDigests
              // accumulates as slices actually finish (never before), so it is
              // naturally empty for every wave-1 dispatch and only ever holds
              // slices from earlier, already-settled waves.
              const repoPrimer = buildRepoPrimer({ cwd: ctx.directory })
              const completedSliceDigests: SliceDigestEntry[] = []

              // A slice child sees only its one-line todo text by default, so carry the
              // parent task verbatim: concrete details (file paths, commands, acceptance
              // criteria) must survive decomposition. Shared prefix across slices also
              // keeps the provider prefix-cache warm.
              const parentTask = (msgs.find((m) => m.info.id === lastUser.id)?.parts ?? [])
                .map((p) => (p.type === "text" ? p.text : ""))
                .filter(Boolean)
                .join("\n")

              // One slice → one child session on the slice's tier model, carrying slice
              // metadata so OL-7.7 wiring briefs attach; returns text + parts for the
              // trajectory monitor. This is the Effect→Promise bridge the pure loop needs.
              // The child is HEADLESS: an executor that stops to ask "which files?" is a
              // real observed failure (no one can answer a child session), so the framing
              // forbids clarifying questions outright.
              // Lane enforcement: a recon/verify slice observes and reports — it must
              // never mutate the working tree (a live recon slice editing source raced
              // the implement slice). The deny rule is mechanical: edit/write/patch all
              // ask the "edit" permission, deny rules survive --dangerously-skip-permissions,
              // and the rule rides escalation rescues too (sliceType travels in the request).
              // Ask-coercion: childSlicePermission also flattens every askable surface to
              // allow/deny — an "ask" in a headless child parks the run on a Deferred no
              // one resolves (runs 4 and 5 froze exactly there, on bash asks).
              const dispatch: ConductorSliceDispatch = (req) =>
                bridge.promise(
                  Effect.gen(function* () {
                    const readOnly = isReadOnlySlice(req.sliceType)
                    // OL-9.1b: resolve the intern persona this slice runs as (this is the
                    // run-6 root-bug fix — the child used to inherit the conductor's own
                    // agent identity). An explicit `persona` on the originating todo wins
                    // when present (read defensively — the field may not exist on every
                    // todo yet); otherwise it derives from sliceType. Drives both the
                    // child's agent identity and its permission overlay.
                    const sourceTodo = pendingTodos.find((t) => t.content === req.sliceId) as
                      | OrchestrationTodo
                      | undefined
                    const persona = personaForSlice({ sliceType: req.sliceType, persona: sourceTodo?.persona })
                    // OL-9.5: an escalation must actually change the brain — run 8's
                    // ladder re-dispatched the same executor persona for every hop
                    // (req.tier was ignored; zero reasoner/oracle children existed in
                    // the DB). A non-executor tier runs as its tier agent; the persona
                    // still shapes the permission overlay and step budget.
                    const childAgent = req.tier === "executor" ? persona : req.tier
                    // F6 seat-scoping: design/verify at reasoner/oracle is a decider
                    // seat — grind surfaces (bash/edit) come off by construction, so
                    // downward delegation stops being advisory. Escalated mechanical
                    // rescues keep their tools (worker seat at any tier).
                    const deciderSeat = isDeciderSeat(req.tier, req.sliceType)
                    const child = yield* sessions.create({
                      parentID: sessionID,
                      title: `slice: ${req.sliceId}`.slice(0, 100),
                      agent: childAgent,
                      permission: childSlicePermission(session.permission, readOnly, persona, deciderSeat),
                    })
                    const sliceFiles = [...req.prompt.matchAll(/[\w./-]+\/[\w.-]+\.[a-z]{1,5}\b/gi)].map((m) => m[0])
                    const framed = [
                      "You are a headless slice executor: you run ONE slice of a decomposed parent task, unattended.",
                      "Never ask the user questions — no one can answer a child session. If a detail seems ambiguous, take the most reasonable interpretation from the parent task below and proceed to a concrete result.",
                      deciderSeat
                        ? "SEAT: decider. Shell and file-mutation tools are disabled for this session — judge from evidence gathered with the read/search/graph tools and deliver your verdict or plan as text. Command evidence (suite runs, typechecks) is produced by the verification rungs and runner slices, not by you."
                        : readOnly
                          ? "LANE: this slice is READ-ONLY (reconnaissance/verification). Do NOT create, edit, or write any file — file-mutation tools are disabled for this session. Run commands and read code as needed, and deliver your findings as text."
                          : "",
                      // Case-2 tierfire3 attempt B: a budget-capped judgment slice
                      // died with its analysis unwritten and the dimension came back
                      // empty. The watchdog reads back whatever text exists — so the
                      // brief demands incremental delivery, mirroring the frame
                      // slices' budget-discipline line.
                      "Budget discipline: your tool-call budget is HARD — a watchdog ends the session at the cap and keeps only the text you have already written. Write your deliverable INCREMENTALLY as evidence lands (partial findings first, refine as you go); reserve your final steps to complete it. A partial deliverable written beats a perfect one unwritten.",
                      repoPrimer,
                      renderSliceDigestLedger(completedSliceDigests),
                      parentTask ? `## Parent task (context only — do ONLY your slice)\n${parentTask}` : "",
                      `## Your slice\n${req.prompt}`,
                    ]
                      .filter(Boolean)
                      .join("\n\n")
                    const childPrompt = yield* Effect.promise(() =>
                      buildChildPrompt(framed, sliceFiles.length > 0 ? { files: sliceFiles } : undefined),
                    )
                    const parts = yield* promptOps.resolvePromptParts(childPrompt)
                    const model = (() => {
                      const m = resolveSliceModel(req.tier)
                      return { providerID: ProviderV2.ID.make(m.providerID), modelID: ModelV2.ID.make(m.modelID) }
                    })()
                    // OL-9.3a per-persona step budget: no native per-child max-steps knob
                    // exists on promptOps.prompt (the core runner's own MAX_STEPS_PROMPT
                    // gate is per-turn, not persona-aware), so this races the child's
                    // prompt call against a watchdog that polls the child's own message
                    // history for completed tool calls. If the persona's budget is
                    // exhausted first, the watchdog wins the race — Effect interrupts the
                    // losing prompt fiber, so the child ends GRACEFULLY instead of running
                    // away — and whatever it already wrote is read back from the session
                    // and becomes the digest, fail-loud-marked for the verifier rather
                    // than silently truncated.
                    let budgetExhausted = false
                    // P8 — the hard tail (design slices, judge-rated-hard turns,
                    // escalated rescues) gets ×1.5 steps so exhaustion doesn't
                    // double-pay a rescue; all three signals already live at
                    // this seam (req + the arming store).
                    const budget = sliceStepBudget(persona, req.sliceId, {
                      sliceType: req.sliceType,
                      hard: getArmingDecision(sessionID)?.hardness === "hard",
                      escalated: req.escalated,
                    })
                    const watchdog: Effect.Effect<void> = Effect.gen(function* () {
                      while (true) {
                        yield* Effect.sleep("2 seconds")
                        const msgs = yield* sessions
                          .messages({ sessionID: child.id })
                          .pipe(Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))
                        const steps = msgs.reduce((sum, m) => sum + countToolCalls(m.parts), 0)
                        if (steps < budget) continue
                        budgetExhausted = true
                        yield* promptOps.cancel(child.id).pipe(Effect.ignore)
                        return
                      }
                    })
                    const raced = yield* Effect.race(
                      promptOps.prompt({
                        messageID: MessageID.ascending(),
                        sessionID: child.id,
                        model,
                        agent: childAgent,
                        parts,
                      }),
                      watchdog,
                    )
                    let dispatchResult: { text: string; parts: readonly unknown[] }
                    if (budgetExhausted) {
                      const msgs = yield* sessions
                        .messages({ sessionID: child.id })
                        .pipe(Effect.orElseSucceed(() => [] as SessionV1.WithParts[]))
                      const finalParts = msgs.at(-1)?.parts ?? []
                      const priorText = finalParts.findLast((p) => p.type === "text")?.text ?? ""
                      dispatchResult = { text: `${budgetExhaustedMarker(persona, budget)}\n\n${priorText}`, parts: finalParts }
                    } else {
                      const result = raced as SessionV1.WithParts
                      dispatchResult = {
                        text: result.parts.findLast((p) => p.type === "text")?.text ?? "",
                        parts: result.parts,
                      }
                    }
                    // OL-9.4b: record this slice's output for later-wave dispatches'
                    // digest ledger — pushed only once the slice has actually
                    // completed, so an earlier-wave slice can never appear in its own
                    // or a same-wave sibling's ledger.
                    completedSliceDigests.push({ id: req.sliceId, text: dispatchResult.text })
                    return dispatchResult
                  }),
                )

              // #59 verbalized-confidence fallback for the posterior-uncertainty
              // gate (task #48): when a prior-flagged slice's dispatch produced
              // no logprob perplexity (the primary signal), the gate asks the
              // slice's own output to self-rate 0-1 how confident it solved the
              // INTENDED problem (not merely that it runs). A one-shot, tool-free
              // completion on the conductor tier (the neutral decider, not the
              // slice's own generator) reading the slice's completed digest. An
              // empty output or parse failure returns 1.0 (fully confident ⇒ no
              // escalation) so a flaky rater never eats the cost thesis, and logs
              // so the degrade stays traceable.
              const parseVerbalizedConfidence = (text: string): number => {
                const jsonMatch = /"confidence"\s*:\s*(-?\d+(?:\.\d+)?)/i.exec(text)
                const raw = jsonMatch?.[1] ?? /-?\d+(?:\.\d+)?/.exec(text)?.[0]
                if (raw === undefined) return 1
                let n = Number(raw)
                if (!Number.isFinite(n)) return 1
                if (n > 1 && n <= 100) n = n / 100 // tolerate a 0-100 percentage
                return Math.min(1, Math.max(0, n))
              }
              const confidenceGenerate = (sliceId: string): Promise<number> =>
                bridge.promise(
                  Effect.gen(function* () {
                    const output = completedSliceDigests.find((d) => d.id === sliceId)?.text ?? ""
                    if (output.trim().length === 0) return 1
                    const m = resolveSliceModel("conductor")
                    const resolved = yield* provider.getModel(
                      ProviderV2.ID.make(m.providerID),
                      ModelV2.ID.make(m.modelID),
                    )
                    const language = yield* provider.getLanguage(resolved)
                    const probe =
                      'You reviewed one slice of a larger coding task. On a 0.0-1.0 scale, how confident are you that the work below solved the INTENDED problem correctly (not merely that it runs)? Reply with ONLY a JSON object: {"confidence": <number between 0 and 1>}.\n\n## Slice output\n' +
                      output.slice(0, 4000)
                    const out = yield* Effect.tryPromise({
                      try: () =>
                        generateText({ model: language, prompt: probe, maxOutputTokens: 64, temperature: 0 }),
                      catch: (err) => err,
                    }).pipe(
                      Effect.tapError((err) =>
                        Effect.logInfo("confidence_probe_failed", {
                          "session.id": sessionID,
                          sliceId,
                          error: String(err).slice(0, 200),
                        }),
                      ),
                      Effect.orElseSucceed(() => ({ text: "" }) as { text: string }),
                    )
                    return parseVerbalizedConfidence(out.text)
                  }),
                )

              const orch = yield* Effect.promise(() =>
                runConductorOrchestration({
                  getTodos: () => bridge.promise(todoStore.get(sessionID)),
                  probes: {
                    probeCoupling: async (text, files) => probeSliceCoupling(text, files, await ensureGraphReady()),
                    probeTestStrength: (files) => probeSliceTestStrength(files),
                    probeVerifyCommands: (files) => probeSliceVerifyCommands(files),
                  },
                  dispatch,
                  setTodoStatus: (index, status) =>
                    bridge.promise(
                      Effect.gen(function* () {
                        const current = yield* todoStore.get(sessionID)
                        const next = current.map((t, i) => (i === index ? { ...t, status } : t))
                        yield* todoStore.update({ sessionID, todos: next })
                      }),
                    ),
                  goalCount: turnGoalCount,
                  // §1.1b two-axis allocator floor: the turn-open arming
                  // decision (`arming`/`verdict` above are step-0-scoped and
                  // out of reach here — the store is the bridge) threaded onto
                  // every slice todosToLoopSlices builds, so a hard/ambiguous
                  // slice floors its generator tier at the reasoner.
                  arming: getArmingDecision(sessionID),
                  // #53/#54 resolution gate — the resolution-store key.
                  sessionID,
                  // #53/#54 "resolve-first" re-seed: append (dedup by
                  // content, re-reads the live list so a concurrent write
                  // is never clobbered) the diagnosis writer pre-pass todo when
                  // the turn-open skeleton did not already plant one.
                  appendTodos: (seed) =>
                    bridge.promise(
                      Effect.gen(function* () {
                        const current = yield* todoStore.get(sessionID)
                        if (current.some((t) => t.content === seed.content)) return
                        yield* todoStore.update({ sessionID, todos: [...current, seed] })
                      }),
                    ),
                  // #53/#54 "ask-user": fire the question and don't wait —
                  // Question.ask() parks its own fiber on a Deferred until
                  // the user replies over the HTTP/TUI question API, so
                  // forking (not awaiting) is what lets THIS turn return
                  // without slicing instead of hanging on the answer.
                  // RejectedError (the user dismisses it) is expected and
                  // swallowed, not a failure worth surfacing here.
                  askUser: (q) => {
                    bridge.fork(
                      question
                        .ask({
                          sessionID,
                          questions: [{ question: q, header: "Clarify approach", options: [], custom: true }],
                        })
                        .pipe(Effect.ignore),
                    )
                  },
                  onResolutionGate: (info) => {
                    bridge.fork(
                      Effect.logInfo("resolution_gate", {
                        "session.id": sessionID,
                        flagged: info.flagged,
                        mode: info.mode,
                        candidatePlanValid: info.candidatePlanValid,
                        resolveAttempts: info.resolveAttempts,
                      }),
                    )
                  },
                  options: {
                    cwd: ctx.directory,
                    rmRung,
                    judgeGenerate,
                    confidenceGenerate,
                    // U3 — the opencode-side snapshot adapter (opencode's
                    // git-based snapshot subsystem) bracketing each attempt;
                    // absent snapshot ⇒ today's dirty-tree behavior.
                    snapshot: {
                      track: () => bridge.promise(snapshot.track()),
                      restore: (hash: string) => bridge.promise(snapshot.restore(hash)),
                      diff: (hash: string) => bridge.promise(snapshot.diff(hash)),
                    },
                    onProvenance: (e) => {
                      bridge.fork(Effect.logInfo("escalation_provenance", { "session.id": sessionID, ...e }))
                    },
                  },
                }),
              )

              if (orch.fellBack)
                yield* Effect.logWarning("orchestration_fallback", { "session.id": sessionID })
              else if (orch.engaged)
                yield* Effect.logInfo("orchestration_engaged", {
                  "session.id": sessionID,
                  slices: orch.result?.outcomes.length ?? 0,
                })

              // Synthesis-as-a-hop: the final user-facing answer is a crucial output,
              // so it is authored by a tier allocated to the SYNTHESIS job (P9) — the
              // reasoner for any decomposed turn, the oracle only when mixed outcomes
              // (an unverified failure among the done slices) need arbitration — from
              // compiled slice digests, never the raw transcript. The conductor then
              // RELAYS it: the cheap tier keeps the session, the capable tier writes
              // the artifact.
              const outcomes = orch.engaged ? (orch.result?.outcomes ?? []) : []
              // OL-7.8 observability: one line per settled slice — the verifier
              // rung that decided it is otherwise only visible by replaying the
              // ladder, not from the run log.
              for (const outcome of outcomes) {
                yield* Effect.logInfo("slice_settled", {
                  "session.id": sessionID,
                  sliceId: outcome.id,
                  state: outcome.state,
                  tier: outcome.tier,
                  verification: outcome.verification,
                  rung: outcome.verdict.rung,
                  attempts: outcome.attempts,
                })
              }
              // F1/§8 — a pre-pass-only engagement (the seeded diagnosis writer
              // slice and nothing else) already DID the work: the reasoner
              // writer localized, applied the fix, and re-ran the failing test
              // in one session. Relay its RESULT, not a re-edit instruction —
              // when the fix was applied AND verified (state accepted/escalated,
              // edits kept in the tree by containment), tell the conductor to
              // confirm and FINISH; only the fallback (no verified fix landed —
              // unverified, or the edits were rolled back, so the writer handed
              // back ranked candidates) relays the analysis for the conductor to
              // execute against.
              const prepassOnly = outcomes.length > 0 && outcomes.every((o) => o.id === LOCALIZATION_SLICE_CONTENT)
              if (prepassOnly) {
                const frame = outcomes[0]!
                // "accepted"/"escalated" ⇒ the verifier ladder passed the
                // writer's edits (the failing/pinned test ran green) and
                // containment kept them in the working tree. "unverified" or a
                // present revertedDiff ⇒ no verified fix landed → fall back to
                // relaying the analysis for the conductor to execute.
                const verifiedFix =
                  (frame.state === "accepted" || frame.state === "escalated") && frame.revertedDiff === undefined
                const truncatedOutput =
                  frame.output.length > 4000 ? `${frame.output.slice(0, 4000)}\n…[truncated]` : frame.output
                const body =
                  verifiedFix || isProbeGrounded(frame.output)
                    ? truncatedOutput
                    : `⚠ No verified fix landed and the analysis is narrative-only — no discriminating probe result rules out the alternatives. Before you edit, run the probe yourself and confirm this site is the CAUSE, not just where the symptom surfaces.\n\n${truncatedOutput}`
                const frameMsg: SessionV1.User = {
                  id: MessageID.ascending(),
                  sessionID,
                  role: "user",
                  time: { created: Date.now() },
                  agent: lastUser.agent,
                  model: lastUser.model,
                }
                yield* sessions.updateMessage(frameMsg)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: frameMsg.id,
                  sessionID,
                  type: "text",
                  text: [
                    verifiedFix
                      ? "Diagnosis pre-pass (completed before your work): a higher-tier writer slice localized the reported defect, applied the fix, and re-ran the failing test to GREEN — all in one session. Its report:"
                      : "Diagnosis pre-pass (completed before your work): a higher-tier writer slice investigated the reported defect but did NOT land a verified fix (it produced ranked candidates / its change could not be confirmed). Its report:",
                    "---",
                    body,
                    "---",
                    verifiedFix
                      ? "The fix is ALREADY APPLIED to the working tree and VERIFIED (the failing test now passes). Do NOT re-edit, re-derive, or redo the sliced work — confirm the change is present and complete, then FINISH by summarizing for the user what was fixed and how it was verified. Only if the working tree does not actually contain this change should you re-apply it."
                      : "No verified fix landed yet — treat this as the frame for the turn: (1) run each discriminating probe/check it names and confirm the target BEFORE any edit; (2) apply the minimal fix at the confirmed cause and re-run the failing test to green; (3) if evidence contradicts the analysis, stop and enumerate at least two candidate layers — with a cheap probe for each — before choosing.",
                  ].join("\n"),
                  synthetic: true,
                } satisfies SessionV1.TextPart)
              } else if (outcomes.length > 0) {
                // P9 — synthesis is faithful assembly (a writing job), so it
                // runs on the reasoner regardless of which tiers the slices
                // touched; only MIXED outcomes — an "unverified" terminal
                // failure or a "blocked" never-dispatched dependent among the
                // settled slices (accepted/escalated both mean verified work) —
                // are judgment work worth the oracle's arbitration.
                const mixedOutcomes = outcomes.some((o) => o.state === "unverified" || o.state === "blocked")
                const synthesisTier = mixedOutcomes ? ("oracle" as const) : ("reasoner" as const)
                yield* Effect.logInfo("synthesis_dispatched", {
                  "session.id": sessionID,
                  synthesisTier,
                  mixedOutcomes,
                })
                const digests = outcomes
                  .map((o) => {
                    const body = o.output.length > 1500 ? `${o.output.slice(0, 1500)}\n…[truncated]` : o.output
                    return `### ${o.id} [tier=${o.escalation?.tier ?? o.tier}, state=${o.state}]\n${body}`
                  })
                  .join("\n\n")
                const synthesis = yield* Effect.tryPromise(() =>
                  dispatch({
                    sliceId: "synthesize final answer",
                    tier: synthesisTier,
                    prompt: [
                      "Write the FINAL user-facing answer for the parent task by synthesizing the completed slice results below.",
                      "Be faithful to what actually happened — cite the concrete evidence (files changed, commands run, test results, root cause) from the slices and invent nothing beyond them.",
                      "Lead with the outcome, then the substance (root cause / changes / evidence) in clean prose.",
                      `\n## Completed slice results\n${digests}`,
                    ].join("\n"),
                    escalated: false,
                  }),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("synthesis_fallback", { "session.id": sessionID, cause: Cause.squash(cause) }).pipe(
                      Effect.map(() => undefined),
                    ),
                  ),
                )
                if (synthesis?.text) {
                  const relayMsg: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(relayMsg)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: relayMsg.id,
                    sessionID,
                    type: "text",
                    text: `A higher-tier synthesis of the completed slices follows. Deliver it to the user as your final answer — relay it faithfully (verbatim where possible) and add nothing beyond it:\n\n---\n${synthesis.text}`,
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                }
              }
            })
            // Last-ditch boundary: even a defect in the hook's own setup falls back
            // to the legacy path rather than aborting the turn.
            yield* sliceHook.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration_fallback", { "session.id": sessionID, cause: Cause.squash(cause) }),
              ),
            )
          }
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Agent.defaultLayer,
        Database.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
        RuntimeFlags.defaultLayer,
        EventV2Bridge.defaultLayer,
        SessionTodo.defaultLayer,
        Snapshot.defaultLayer,
        Question.defaultLayer,
      ),
    ),
  ),
)
const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make(layer, [
  SessionStatus.node,
  Session.node,
  Agent.node,
  Provider.node,
  SessionProcessor.node,
  SessionCompaction.node,
  Plugin.node,
  Command.node,
  Config.node,
  Permission.node,
  FSUtil.node,
  MCP.node,
  LSP.node,
  ToolRegistry.node,
  Truncate.node,
  Image.node,
  CrossSpawnSpawner.node,
  Instruction.node,
  SessionRunState.node,
  SessionRevert.node,
  SessionSummary.node,
  Snapshot.node,
  SessionTodo.node,
  Question.node,
  SystemPrompt.node,
  LLM.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  Database.node,
])

export * as SessionPrompt from "./prompt"
