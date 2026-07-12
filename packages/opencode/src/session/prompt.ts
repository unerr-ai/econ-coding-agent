import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { existsSync, readFileSync } from "node:fs"
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
import {
  setTestEditGate,
  testEditGateArmed,
  setNoEditsGate,
  noEditsGateArmed,
  isTestFilePath,
} from "../tool/edit-governance"
import { createStuckSupervisor } from "../../../code-intelligence/src/orchestration-fsm"
import { observeStep, createGrindValve, createBatchMomentumWatcher } from "./turn-supervisor"
import {
  stuckNudgeText,
  grindValveNudgeText,
  batchMomentumNudgeText,
  LENGTH_CONTINUATION_NUDGE,
  ENVIRONMENT_SLOW_NUDGE,
  reproDriftNudgeText,
  REPRO_DRIFT_ESCALATION_NUDGE,
  convergeNowNudgeText,
  pinGreenFinishNudgeText,
  reproFidelityNudgeText,
} from "./prompts/nudges"
import { classifyReproDrift, extractScriptFilename, type ReproDriftKind } from "./repro-drift"
import {
  runReproFidelityJudge,
  DEGRADED_REPRO_FIDELITY,
  type ReproFidelityComplete,
} from "./repro-fidelity-judge"
import { triagePreamble } from "./prompts/preambles"
import {
  GRIND_DESIGN_SLICE_CONTENT,
  LOCALIZATION_SLICE_CONTENT,
  PLAN_SLICE_CONTENT,
  REPRO_SLICE_CONTENT,
} from "./prompts/seeds"
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
  GRIND_DESIGN_PREPASS_TODO,
  LOCALIZATION_PREPASS_TODO,
  extractTrajectory,
  isFixShapedPrompt,
  promptAuthorizesTestEdits,
  diagnosisDeniesTestEdits,
  buildTriageTodoSkeleton,
  childSlicePermission,
  isDeciderSeat,
  isDelegatingSeat,
  extractSliceFiles,
  resolveDottedPyModules,
  personaForSlice,
  sliceStepBudget,
  countToolCalls,
  budgetExhaustedMarker,
  buildRepoPrimer,
  renderSliceDigestLedger,
  deriveTurnProbe,
  runTurnProbeGate,
  makeShellCommandRunner,
  reproSpecificity,
  isReproScratchPath,
  type ConductorLoopOptions,
  type ConductorSliceDispatch,
  type OrchestrationTodo,
  type SliceDigestEntry,
  type SliceProbes,
} from "./slice-orchestrator"
import { registerDelegationSeat, releaseDelegationSeat, type DelegationPorts } from "./slice-delegation"
import {
  runTurnRead,
  triageTelemetry,
  isContinuationShortCircuit,
  type TriageComplete,
  type TriageVerdict,
} from "./turn-triage"
import { decideArming, type ArmingVerdict } from "./arming-judge"
import { setArmingDecision, getArmingDecision } from "./arming-store"
import {
  setTurnVerdict,
  getTurnVerdict,
  setPinnedProbe,
  getPinnedProbe,
  researchShapedTurn,
  setTurnFiles,
  getTurnFiles,
  recordGateBlock,
  clearGateBlock,
  getGateBlocks,
  clearGateBlocks,
} from "./turn-read-store"
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
import { enforceStepBudget } from "./step-budget"
import { recordToolCall } from "@/tool/_shared/meter"
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

const GATE_BLOCK_TOOLS = new Set(["edit", "write", "apply_patch"])
// The reason guardrail.ts throws on a block starts "[econ-gate] BLOCKED: ... in <file>. " on
// its own first line (see packages/code-intelligence/src/guardrail.ts) — captures the file.
const GATE_BLOCK_RE = /\[econ-gate\]\s*BLOCKED:[^\n]*?\bin\s+(\S+?)\.\s/i

/**
 * S4 — scan a completed step's parts for an econ-gate governance BLOCK on an
 * edit/write tool (an errored tool part whose output carries the
 * `[econ-gate] BLOCKED` reason) so the turn-store ledger can track it and the
 * S3 done-time nudge can flag an abandoned block (django-12039: blocked
 * twice, never re-landed, shipped an empty patch).
 */
// S2 — how many SM4-observed steps (assistant steps with tool calls) the
// repro pre-pass gets before abstaining — plant localization anyway and
// nudge once, never blocking the turn on an unpinnable repro forever.
// Tuned from fly traces (see the plan doc).
export const REPRO_PIN_DEADLINE_STEPS = 12

// S8 — how many SM4-observed steps a bug-shaped turn may spend verifying
// AFTER a source edit has landed with still no reproduction pinned before
// the converge-now nudge pre-arms the S3 exit ramp (django-11790 strict run
// #3: a step-21 finish rejection was followed by 38 more minutes of tool
// calls and no second finish attempt — every done-time bar lives in the
// !hasToolCalls exit path, which a tool-calling agent can evade forever).
export const POST_FIX_CONVERGE_STEPS = 8

// S9 — how many SM4-observed steps a turn may keep "verifying" broadly AFTER
// its pinned reproduction has already run GREEN before the finish nudge
// fires (django-11790 strict run #4: the pin went green at step 18, then 9
// more steps of re-running suites, a step-24 `rm` of the pinned file, and
// the 3600s wall killed it at step 25 — nothing told the model the
// done-gate is now the terminator). Shorter than POST_FIX_CONVERGE_STEPS
// because a green pin is stronger done-evidence than a landed source edit
// alone.
export const PIN_GREEN_FINISH_STEPS = 3

// S9 — tool names whose input carries a `command` field worth checking for a
// green run of the pinned probe's script (mirrors turn-supervisor.ts's own
// COMMAND_TOOLS set for the same two tool ids).
const PIN_PROBE_COMMAND_TOOLS = new Set(["shell", "bash"])

/**
 * S9 — whether this step ran the pinned probe's script and it exited GREEN.
 * Cheapest reliable signal: the bash tool's own `state.metadata.exit` (the
 * exit code every completed bash/shell part carries — the same field
 * `greenMemoAfter` in tools.ts keys on), checked ahead of any output-text
 * heuristic since it is the tool's own authoritative result, not a scan of
 * its text.
 */
function stepRanPinnedProbeGreen(parts: readonly unknown[], scriptFilename: string): boolean {
  for (const raw of parts) {
    const part = raw as {
      type?: string
      tool?: string
      state?: { status?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }
    }
    if (part?.type !== "tool" || !part.tool || !PIN_PROBE_COMMAND_TOOLS.has(part.tool)) continue
    if (part.state?.status !== "completed") continue
    const command = typeof part.state?.input?.["command"] === "string" ? (part.state.input["command"] as string) : ""
    if (!command || !command.includes(scriptFilename)) continue
    if (part.state?.metadata?.["exit"] === 0) return true
  }
  return false
}

function scanGateBlocks(parts: readonly unknown[]): { file: string; reason: string }[] {
  const found: { file: string; reason: string }[] = []
  for (const raw of parts) {
    const part = raw as { type?: string; tool?: string; state?: { status?: string; output?: string; error?: string } }
    if (part?.type !== "tool" || !part.tool || !GATE_BLOCK_TOOLS.has(part.tool)) continue
    if (part.state?.status !== "error") continue
    // An errored tool part carries the reason in `state.error` (verified on
    // django-12039's live transcript: the [econ-gate] BLOCKED text is the
    // error field, and there is no output field on the error state).
    const output = part.state?.error ?? part.state?.output ?? ""
    const m = GATE_BLOCK_RE.exec(output)
    if (!m) continue
    const nl = output.indexOf("\n")
    found.push({ file: m[1]!, reason: (nl === -1 ? output : output.slice(0, nl)).trim() })
  }
  return found
}

/** F9a — cap on the pinned repro file read for the fidelity judge: a runaway/huge scratch file must never blow the judge's prompt budget. */
const REPRO_FIDELITY_MAX_FILE_BYTES = 8 * 1024

/**
 * F9a — read the pinned repro script off disk for the fidelity judge,
 * capped at `REPRO_FIDELITY_MAX_FILE_BYTES`. A missing file (deleted, never
 * written, or a read error) returns `undefined` — the caller skips the
 * judge silently, never blocking the pin.
 */
function readPinnedReproFile(cwd: string, filename: string): string | undefined {
  const target = path.join(cwd, filename)
  if (!existsSync(target)) return undefined
  try {
    const raw = readFileSync(target, "utf8")
    return raw.length > REPRO_FIDELITY_MAX_FILE_BYTES ? raw.slice(0, REPRO_FIDELITY_MAX_FILE_BYTES) : raw
  } catch {
    return undefined
  }
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
// P4 rides the same denominator: `turnReads` counts every root turn open
// (short-circuited continuations included), and each continuation logs
// `turn_continuation` with the running continuations/turnReads pair — the
// literature says 33-40% of multi-turn prompts are follow-ups; this counter
// checks that number on econ's own traffic.
let turnReads = 0
let turnReadNulls = 0
let turnContinuations = 0

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

    /**
     * F9a — the repro-fidelity judge's ONE dispatch: a tool-free,
     * temperature-0, forced-JSON completion on the executor tier (cheapest —
     * this is a narrow, single-question check, not turn-open extraction).
     * The caller (the SM4 pin-from-red site) fires this at most once per
     * turn. An unresolvable model/language degrades to
     * `DEGRADED_REPRO_FIDELITY` the same as a thrown completion — a
     * housekeeping read never blocks the pin.
     *
     * @sem domain=routing role=repro-judge
     */
    const reproFidelityDispatch = Effect.fn("SessionPrompt.reproFidelityDispatch")(function* (input: {
      issueText: string
      reproContent: string
    }) {
      const { issueText, reproContent } = input
      const m = resolveSliceModel("executor")
      const mdl = Option.getOrUndefined(
        yield* provider.getModel(ProviderV2.ID.make(m.providerID), ModelV2.ID.make(m.modelID)).pipe(Effect.option),
      )
      if (!mdl) return DEGRADED_REPRO_FIDELITY
      const language = Option.getOrUndefined(yield* provider.getLanguage(mdl).pipe(Effect.option))
      if (!language) return DEGRADED_REPRO_FIDELITY
      const complete: ReproFidelityComplete = async ({ system, user }) => {
        const out = await generateText({ model: language, system, prompt: user, maxOutputTokens: 512, temperature: 0 })
        return out.text.trim() || (out.reasoningText ?? "")
      }
      return yield* Effect.promise(() => runReproFidelityJudge({ issueText, reproContent, complete }))
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
        // P4 §4b — this turn is a continuation (pre-LLM short-circuit or the
        // turn-read's own turnRole). Threaded into the orchestration hook so
        // the resolution gate stands down for the rest of the turn.
        let turnContinuation = false
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
        // S3 — the done-time fallback bar's own bounded retry: exactly ONE
        // reject-with-nudge cycle for a bug-shaped turn finishing with no
        // verified reproduction/source edit, then a loud break (never a loop).
        let unverifiedFinishNudged = false
        // The turn's OPENING user message id, captured once at step 0 before
        // any synthetic nudge (stuck/grind/batch/probe-gate/S2/S3) can shift
        // `lastUser` forward — the stable anchor S3 scans "this turn's"
        // assistant messages from (`m.info.id > turnOpenUserID`).
        let turnOpenUserID: string | undefined
        // S2 — repro-first mid-turn hand-off/abstention state: whether the
        // turn-open skeleton seeded the repro pre-pass, whether the hand-off
        // (pin landed) or the abstention (deadline/cancel, no pin) already
        // fired — bounded to ONE of either, never a loop — and how many
        // observed steps have passed with the repro still unresolved.
        let reproSeededThisTurn = false
        let reproHandoffDone = false
        let reproObservedSteps = 0
        // Repro drift nudge (NUDGE_V2 port) — targeted, event-triggered,
        // once-per-kind steer while the repro pre-pass is still unresolved:
        // which kinds have already nudged this turn, the running total of
        // drift events across all kinds (Tier-2 escalates once this crosses
        // the threshold), and whether that escalation already fired.
        const reproDriftKindsNudged = new Set<ReproDriftKind>()
        let reproDriftEvents = 0
        const REPRO_DRIFT_ESCALATION_THRESHOLD = 3
        let reproDriftTier2Fired = false
        // S8 — converge-now deadline state: how many SM4-observed steps have
        // passed with a source (non-test) edit already on the board but no
        // repro pin, whether that source edit has landed at all this turn
        // (a cheap running flag, updated from the SAME extractTrajectory pass
        // the S4 gate-block ledger already does — never a second full-turn
        // trajectory scan), and whether the nudge already fired (at most
        // once per turn).
        let postFixNoPinSteps = 0
        let landedSourceEditThisTurn = false
        let convergeNudgeFired = false
        // S9 — pin-green finish-nudge state: mirrors the S8 locals above but
        // for the OTHER half of the trace (django-11790 strict run #4) —
        // once the pinned probe has been OBSERVED to run green this turn,
        // count subsequent observed steps with a source fix on the board and
        // nudge once at the deadline instead of letting the turn re-verify
        // forever.
        let pinObservedGreen = false
        let pinGreenSteps = 0
        let pinGreenNudgeFired = false
        // F9a — repro-fidelity judge fires at most once per turn, right at
        // the pin-from-red site below.
        let reproFidelityJudgedThisTurn = false
        // S3 — whether this turn's pin came from the P4 continuation store
        // (restored at turn open) rather than being authored/observed this
        // turn. An inherited pin + no new source edits is a legitimate
        // confirm/report continuation, NOT an unverified finish.
        let pinInheritedFromStore = false
        // S5b — sticky-escalation decay: consecutive productive, signal-free
        // steps while escalated; at ESCALATION_DECAY_STEPS the turn is handed
        // back to its own bound model (the stuck window is over — the 2/turn
        // escalation cap is NOT refunded, so no oscillation). Plus the
        // once-per-turn environment-slow nudge guard.
        const ESCALATION_DECAY_STEPS = 4
        let productiveSinceEscalation = 0
        let envSlowNudged = false
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
        // L4.2 — the grind valve rides the SAME observation stream as SM4's
        // stuck supervisor (one observeStep call feeds both). The stuck ladder
        // catches repetition pathology; the valve catches VOLUME without
        // convergence — django-11885's 179 diverse inline edit-test-edit steps
        // ($0.8447) that never tripped a repeat signal. Root sessions only,
        // fires at most once per turn.
        const grindValve = session.parentID ? undefined : createGrindValve()
        // L1.2c — root-session-only, same round-trip economy as the valve
        // above: child slices already run the slice-loop FSM.
        const batchWatcher = session.parentID ? undefined : createBatchMomentumWatcher()
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
              if (turnPinnedProbe) {
                // P4 — a mid-turn pin is part of the contract a continuation
                // turn inherits too.
                setPinnedProbe(sessionID, turnPinnedProbe)
                yield* Effect.logInfo("turn_probe_pinned_from_red", {
                  "session.id": sessionID,
                  probe: turnPinnedProbe.probe.command,
                  redExit: turnPinnedProbe.redEvidence?.exitCode ?? null,
                  redTail: turnPinnedProbe.redEvidence?.outputTail ?? null,
                })
                // F9a — repro-fidelity judge: fires at most once per turn,
                // right here at pin time, and only when the pin names a
                // script file (an inline/whole-suite probe has no file to
                // check). A missing file skips the judge silently; a
                // `faithful:false` verdict logs the gaps and injects ONE
                // nudge — this never blocks the pin, never re-fires.
                if (!reproFidelityJudgedThisTurn) {
                  const fidelityScriptFilename = extractScriptFilename(turnPinnedProbe.probe.command)
                  if (fidelityScriptFilename) {
                    reproFidelityJudgedThisTurn = true
                    const reproContent = readPinnedReproFile(ctx.directory, fidelityScriptFilename)
                    if (reproContent !== undefined) {
                      const issueText = (msgs.find((m) => m.info.id === lastUser.id)?.parts ?? [])
                        .map((p) => (p.type === "text" ? p.text : ""))
                        .filter(Boolean)
                        .join("\n")
                      const fidelityVerdict = yield* reproFidelityDispatch({ issueText, reproContent })
                      if (!fidelityVerdict.faithful) {
                        yield* Effect.logInfo("repro_fidelity_gap", {
                          "session.id": sessionID,
                          gaps: fidelityVerdict.gaps,
                        })
                        const fidelityNudge: SessionV1.User = {
                          id: MessageID.ascending(),
                          sessionID,
                          role: "user",
                          time: { created: Date.now() },
                          agent: lastUser.agent,
                          model: lastUser.model,
                        }
                        yield* sessions.updateMessage(fidelityNudge)
                        yield* sessions.updatePart({
                          id: PartID.ascending(),
                          messageID: fidelityNudge.id,
                          sessionID,
                          type: "text",
                          text: reproFidelityNudgeText([...fidelityVerdict.gaps]),
                          synthetic: true,
                        } satisfies SessionV1.TextPart)
                        continue
                      }
                    }
                  }
                }
              } else {
                // S8 — pin-miss observability: django-11790 strict run #3 hit
                // a red run of a named repro file that did NOT pin, and the
                // pin path had no logging to say why (all candidates scored
                // 0, or deriveTurnProbe's own re-run disagreed). Cheap: only
                // reached when a pin was attempted and missed, no throttling.
                yield* Effect.logInfo("turn_probe_pin_miss", {
                  "session.id": sessionID,
                  candidates: candidateTests.map((c) => ({
                    command: c.command.slice(0, 160),
                    specificity: reproSpecificity(c),
                  })),
                })
              }
            }

            // S4 — governance-gate BLOCK ledger: record any new block this
            // step surfaced, and clear any previously-blocked file a completed
            // edit/write just re-landed. Root sessions only (this whole
            // observation gate already implies !session.parentID).
            const stepParts = lastAssistantMsg?.parts ?? []
            // S9 — the pinned probe's script filename, extracted once per
            // step and shared by the pin-green finish nudge below, the
            // deletion-guard drift kind, and the observability log right
            // here — one extraction, several consumers.
            const pinnedScriptFilename = turnPinnedProbe ? extractScriptFilename(turnPinnedProbe.probe.command) : undefined
            for (const block of scanGateBlocks(stepParts)) recordGateBlock(sessionID, block.file, block.reason)
            for (const event of extractTrajectory(stepParts).events) {
              if (event.kind === "file-edit") clearGateBlock(sessionID, event.filePath)
              // S8 — cheap running flag for the converge-now check below:
              // has a source (non-test, non-scratch-repro) edit landed yet
              // this turn? Reuses this SAME extractTrajectory pass rather
              // than a second scan. A repro_issue.py write is evidence, not
              // a fix — counting it would let the converge nudge push a
              // fixless finish (the empty-patch shape).
              if (event.kind === "file-edit" && !isTestFilePath(event.filePath) && !isReproScratchPath(event.filePath))
                landedSourceEditThisTurn = true
              // S9 — observability only, no throttle: a file-edit touching
              // the pinned script AFTER it was pinned is tamper-shaped
              // (django-11790 strict run #4's `rm repro_issue.py`) — lets
              // trace analysis see every post-pin repro edit, not just the
              // deletion the guard below reacts to.
              if (turnPinnedProbe && pinnedScriptFilename && event.kind === "file-edit" && path.basename(event.filePath) === pinnedScriptFilename)
                yield* Effect.logInfo("pinned_probe_edited", { "session.id": sessionID, file: event.filePath })
            }

            // S2 — repro-first mid-turn hand-off/abstention. Only while the
            // turn-open skeleton actually seeded the repro pre-pass and
            // neither branch has fired yet this turn.
            if (reproSeededThisTurn && !reproHandoffDone) {
              reproObservedSteps++
              if (turnPinnedProbe) {
                // (a) hand-off: the repro pinned red — plant localization
                // (if armed), dedup-by-content (the grind-valve plant
                // pattern above). No nudge: the planted todo is enough for
                // the existing typed-slice dispatch to pick it up.
                reproHandoffDone = true
                const armed = getArmingDecision(sessionID)
                if (armed?.armLocalization) {
                  const currentTodos = yield* todoStore.get(sessionID).pipe(Effect.orElseSucceed(() => []))
                  if (!currentTodos.some((t) => t.content === LOCALIZATION_SLICE_CONTENT)) {
                    yield* todoStore
                      .update({ sessionID, todos: [...currentTodos, LOCALIZATION_PREPASS_TODO] })
                      .pipe(Effect.ignore)
                  }
                }
                yield* Effect.logInfo("repro_handoff", {
                  "session.id": sessionID,
                  probe: turnPinnedProbe.probe.command,
                  reproObservedSteps,
                })
              } else {
                // (b) abstention: the repro was abandoned/cancelled, or the
                // deadline passed, with no pin — plant localization anyway
                // (degrade to today's behavior) and nudge ONCE. The drift
                // nudge that used to live in this branch moved OUT to right
                // after this whole S2 if/else (see below): django-11790
                // strict run #3 showed every actual drift signal (inline
                // python -c probes, a denied suite edit, a broken repro
                // file) landing AFTER this abstention had already fired, so
                // gating the nudge on !reproHandoffDone meant it never ran.
                const currentTodos = yield* todoStore.get(sessionID).pipe(Effect.orElseSucceed(() => []))
                const reproTodo = currentTodos.find((t) => t.content === REPRO_SLICE_CONTENT)
                const reproSettled =
                  reproTodo !== undefined && reproTodo.status !== "pending" && reproTodo.status !== "in_progress"
                // A conductor todowrite rewrite can DROP the (untyped, so
                // unprotected by the frame-seed re-append) repro item
                // entirely — after the first observed step, absence means
                // dropped, and waiting out the deadline just burns steps.
                const reproDropped = reproTodo === undefined && reproObservedSteps > 1 && currentTodos.length > 0
                if (reproSettled || reproDropped || reproObservedSteps >= REPRO_PIN_DEADLINE_STEPS) {
                  reproHandoffDone = true
                  const armed = getArmingDecision(sessionID)
                  if (armed?.armLocalization && !currentTodos.some((t) => t.content === LOCALIZATION_SLICE_CONTENT)) {
                    yield* todoStore
                      .update({ sessionID, todos: [...currentTodos, LOCALIZATION_PREPASS_TODO] })
                      .pipe(Effect.ignore)
                  }
                  yield* Effect.logWarning("repro_unresolved", {
                    "session.id": sessionID,
                    reproObservedSteps,
                    reproSettled,
                  })
                  const reproNudge: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(reproNudge)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: reproNudge.id,
                    sessionID,
                    type: "text",
                    text: "No reproduction could be pinned — state what you verified and double-check the fix against the issue's exact expected values.",
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                  continue
                }
              }
            }

            // Repro drift nudge (NUDGE_V2 port) — targeted, event-triggered,
            // once-per-kind steer. Deliberately OUTSIDE the reproHandoffDone
            // gate above, re-armed on !turnPinnedProbe instead: django-11790
            // strict run #3 showed every actual drift signal (inline
            // python -c probes, a denied suite edit, a broken repro file)
            // landing AFTER the step-12 deadline abstention had already set
            // reproHandoffDone — gating the nudge on that flag meant it never
            // fired. It now survives abstention deliberately and stays live
            // until a pin lands or the turn ends. Tier-2 takes precedence
            // once the running drift count crosses the threshold (one
            // stronger combined reminder beats another per-kind nudge); each
            // kind nudges at most once per turn, silent otherwise.
            if (reproSeededThisTurn && !turnPinnedProbe) {
              const driftKinds = classifyReproDrift({ failedCommands: stepObs.failedCommands, parts: stepParts })
              if (driftKinds.length > 0) {
                reproDriftEvents += driftKinds.length
                const freshKind = driftKinds.find((k) => !reproDriftKindsNudged.has(k))
                if (!reproDriftTier2Fired && reproDriftEvents >= REPRO_DRIFT_ESCALATION_THRESHOLD) {
                  reproDriftTier2Fired = true
                  yield* Effect.logWarning("repro_drift_escalation", {
                    "session.id": sessionID,
                    reproDriftEvents,
                    kinds: driftKinds,
                  })
                  const escalationNudge: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(escalationNudge)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: escalationNudge.id,
                    sessionID,
                    type: "text",
                    text: REPRO_DRIFT_ESCALATION_NUDGE,
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                  continue
                } else if (freshKind) {
                  reproDriftKindsNudged.add(freshKind)
                  yield* Effect.logInfo("repro_drift", { "session.id": sessionID, kind: freshKind })
                  const driftNudge: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(driftNudge)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: driftNudge.id,
                    sessionID,
                    type: "text",
                    text: reproDriftNudgeText(freshKind),
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                  continue
                }
              }
            }

            // S9 — pinned-repro deletion guard: unlike the drift kinds above
            // (armed on !turnPinnedProbe, before a pin lands), this one only
            // makes sense WITH a pin already landed — the pinned file IS the
            // turn's verification contract, and deleting it post-pin
            // (django-11790 strict run #4: `rm repro_issue.py` at step 24,
            // then the 3600s wall killed the turn one step later with no
            // recovery) must be caught even though the repro pre-pass itself
            // already resolved. Same once-per-kind Set as the drift block
            // above, same synthetic-nudge pattern.
            if (
              reproSeededThisTurn &&
              turnPinnedProbe &&
              pinnedScriptFilename &&
              !reproDriftKindsNudged.has("pinned-repro-deleted")
            ) {
              const deletionKinds = classifyReproDrift({
                failedCommands: stepObs.failedCommands,
                parts: stepParts,
                pinnedScript: pinnedScriptFilename,
              })
              if (deletionKinds.includes("pinned-repro-deleted")) {
                reproDriftKindsNudged.add("pinned-repro-deleted")
                yield* Effect.logInfo("repro_drift", { "session.id": sessionID, kind: "pinned-repro-deleted" })
                const deletionNudge: SessionV1.User = {
                  id: MessageID.ascending(),
                  sessionID,
                  role: "user",
                  time: { created: Date.now() },
                  agent: lastUser.agent,
                  model: lastUser.model,
                }
                yield* sessions.updateMessage(deletionNudge)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: deletionNudge.id,
                  sessionID,
                  type: "text",
                  text: reproDriftNudgeText("pinned-repro-deleted", {
                    file: pinnedScriptFilename,
                    probeCommand: turnPinnedProbe.probe.command,
                  }),
                  synthetic: true,
                } satisfies SessionV1.TextPart)
                continue
              }
            }

            // S8 — converge-now deadline: a bug-shaped turn whose fix has
            // already landed (a source edit is on the board) but never gets
            // pinned keeps "verifying" broadly forever — run #3's step-21
            // finish rejection was followed by 38 more minutes of tool calls
            // and no second finish attempt, because every done-time bar (S3
            // below) lives in the !hasToolCalls exit path a tool-calling
            // agent never enters. Count observed post-fix, no-pin steps; at
            // the deadline, pre-arm unverifiedFinishNudged so the S3 bar
            // treats the NEXT finish attempt as its one-nudge-then-loud-pass
            // exit ramp instead of rejecting forever.
            if (
              !convergeNudgeFired &&
              !turnPinnedProbe &&
              landedSourceEditThisTurn &&
              ((getTurnVerdict(sessionID)?.goals.some((g) => g.shape.startsWith("diagnosis")) ?? false) ||
                testEditGateArmed(sessionID))
            ) {
              postFixNoPinSteps++
              if (postFixNoPinSteps >= POST_FIX_CONVERGE_STEPS) {
                convergeNudgeFired = true
                unverifiedFinishNudged = true
                yield* Effect.logWarning("turn_converge_nudge", { "session.id": sessionID, postFixNoPinSteps })
                const convergeNudge: SessionV1.User = {
                  id: MessageID.ascending(),
                  sessionID,
                  role: "user",
                  time: { created: Date.now() },
                  agent: lastUser.agent,
                  model: lastUser.model,
                }
                yield* sessions.updateMessage(convergeNudge)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: convergeNudge.id,
                  sessionID,
                  type: "text",
                  text: convergeNowNudgeText(postFixNoPinSteps),
                  synthetic: true,
                } satisfies SessionV1.TextPart)
                continue
              }
            }

            // S9 — pin-green finish nudge: symmetric to the converge-now
            // nudge above, for the case that block deliberately excludes
            // (turnPinnedProbe set). django-11790 strict run #4: the pin ran
            // GREEN at step 18 and the model kept re-running suites for 9
            // more steps (~2.4 min/step) before a step-24 cleanup deleted
            // the pinned file and the 3600s wall killed it at step 25 —
            // nothing told it the done-gate is now the terminator once a pin
            // is green. Detect a green run of the pinned probe THIS step
            // (stepRanPinnedProbeGreen — the bash tool's own
            // `metadata.exit === 0`, not an output-text heuristic), then
            // count observed steps with a source fix already landed; at the
            // deadline inject ONE nudge to stop and finish.
            if (turnPinnedProbe) {
              if (!pinObservedGreen) {
                if (pinnedScriptFilename && stepRanPinnedProbeGreen(stepParts, pinnedScriptFilename))
                  pinObservedGreen = true
              } else if (landedSourceEditThisTurn && !pinGreenNudgeFired) {
                pinGreenSteps++
                if (pinGreenSteps >= PIN_GREEN_FINISH_STEPS) {
                  pinGreenNudgeFired = true
                  yield* Effect.logInfo("turn_pin_green_nudge", {
                    "session.id": sessionID,
                    pinGreenSteps,
                    probe: turnPinnedProbe.probe.command,
                  })
                  const pinGreenNudge: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(pinGreenNudge)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: pinGreenNudge.id,
                    sessionID,
                    type: "text",
                    text: pinGreenFinishNudgeText(turnPinnedProbe.probe.command),
                    synthetic: true,
                  } satisfies SessionV1.TextPart)
                  continue
                }
              }
            }

            const stuckSignal = stuckSupervisor.observe(stepObs.observation)
            // S5b — escalation decay: once escalated, N consecutive productive
            // signal-free steps hand the turn back to its own bound model. The
            // stuck window is over; paying reasoner rates for the REST of the
            // turn was the shared-CPU A/B's 75%-of-cost failure. The 2/turn
            // escalation cap is never refunded, so decay cannot oscillate.
            if (escalatedModelRef) {
              if (stuckSignal) {
                productiveSinceEscalation = 0
              } else if (stepObs.observation.progressed) {
                productiveSinceEscalation++
                if (productiveSinceEscalation >= ESCALATION_DECAY_STEPS) {
                  escalatedModelRef = undefined
                  productiveSinceEscalation = 0
                  yield* Effect.logInfo("stuck_deescalate", {
                    "session.id": sessionID,
                    mechanism: "sm-backstop",
                    afterProductiveSteps: ESCALATION_DECAY_STEPS,
                  })
                }
              }
            }
            // S5b — environment slowness is not model stuckness: never sets
            // escalatedModelRef, never consumes a stuckEscalations rung. One
            // steering nudge per turn (narrowest target, higher timeout),
            // then the signal is inert.
            if (stuckSignal?.reason === "environment-slow") {
              if (!envSlowNudged) {
                envSlowNudged = true
                yield* Effect.logWarning("stuck_environment", {
                  "session.id": sessionID,
                  mechanism: "sm-backstop",
                  count: stuckSignal.count,
                })
                const envNudge: SessionV1.User = {
                  id: MessageID.ascending(),
                  sessionID,
                  role: "user",
                  time: { created: Date.now() },
                  agent: lastUser.agent,
                  model: lastUser.model,
                }
                yield* sessions.updateMessage(envNudge)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: envNudge.id,
                  sessionID,
                  type: "text",
                  text: ENVIRONMENT_SLOW_NUDGE,
                  synthetic: true,
                } satisfies SessionV1.TextPart)
                continue
              }
            }
            // L4.2 grind valve — both watchers see every step (tallies stay
            // honest); the valve's one firing step takes precedence over the
            // stuck ladder (planting the design pre-pass supersedes a rethink
            // nudge). On open: plant ONE reasoner design seed (dedup by
            // content — the OL-7.3b slice hook below dispatches it through the
            // existing delegation machinery and folds its design back), log
            // the evidence, and nudge the conductor to hold edits until the
            // design returns. This is the inline→orchestrated mid-turn
            // transition; nothing about allocation, verifier routing, or
            // escalation pricing changes — the valve only PROPOSES the slice.
            const grindSignal = grindValve?.observe(stepObs)
            if (grindSignal) {
              const currentTodos = yield* todoStore.get(sessionID).pipe(Effect.orElseSucceed(() => []))
              if (!currentTodos.some((t) => t.content === GRIND_DESIGN_SLICE_CONTENT)) {
                yield* todoStore
                  .update({ sessionID, todos: [...currentTodos, GRIND_DESIGN_PREPASS_TODO] })
                  .pipe(Effect.ignore)
              }
              yield* Effect.logWarning("grind_valve", {
                "session.id": sessionID,
                mechanism: "sm-backstop",
                step: grindSignal.step,
                stepsSinceGreen: grindSignal.stepsSinceGreen,
              })
              const valveNudge: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              }
              yield* sessions.updateMessage(valveNudge)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: valveNudge.id,
                sessionID,
                type: "text",
                text: grindValveNudgeText(grindSignal),
                synthetic: true,
              } satisfies SessionV1.TextPart)
              continue
            }
            if (stuckSignal && stuckSignal.reason !== "environment-slow" && stuckEscalations < MAX_STUCK_ESCALATIONS) {
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
            // L1.2c — batch-momentum watcher: lowest precedence of the three.
            // The grind valve and stuck ladder above both change strategy and
            // `continue` before this runs on their firing steps (missing one
            // observation here is immaterial at the watcher's re-arm cadence)
            // — this rung only compresses round trips, it changes nothing else.
            const toolCallCount =
              lastAssistantMsg?.parts.filter(
                (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
              ).length ?? 0
            const batchSignal = batchWatcher?.observe(toolCallCount)
            if (batchSignal) {
              yield* Effect.logInfo("batch_nudge", {
                "session.id": sessionID,
                step: batchSignal.step,
                consecutiveSingleCalls: batchSignal.consecutiveSingleCalls,
              })
              const batchNudge: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              }
              yield* sessions.updateMessage(batchNudge)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: batchNudge.id,
                sessionID,
                type: "text",
                text: batchMomentumNudgeText(batchSignal),
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
                  probe: turnPinnedProbe!.probe,
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
                  probe: turnPinnedProbe.probe.command,
                  retries: probeGateRetries,
                })
              } else {
                // S1 — the accept fall-through: the pin's red evidence (logged
                // at pin time) and this green run's output tail form the
                // done-time evidence pair.
                yield* Effect.logInfo("turn_probe_green", {
                  "session.id": sessionID,
                  probe: turnPinnedProbe.probe.command,
                  outputTail: gate.outputTail ?? null,
                })
              }
            }

            // S3 — done-time fallback bar: a bug-shaped turn (a diagnosis-*
            // goal in the turn-read verdict, or the no-test-edit gate armed)
            // reaching done with NO verified reproduction OR ZERO landed
            // source (non-test) edits gets ONE reject-with-nudge cycle before
            // a loud, never-deadlocked break. Catches the shapes the M4 pin
            // never sees: 11964 (test-only false-green — a pin existed and
            // went green, but nothing source-side landed) and 12039 (empty
            // patch — nothing pinnable was ever authored/run).
            if (!session.parentID) {
              const storedVerdict = getTurnVerdict(sessionID)
              const bugShaped =
                (storedVerdict?.goals.some((g) => g.shape.startsWith("diagnosis")) ?? false) ||
                testEditGateArmed(sessionID)
              if (bugShaped) {
                const turnStartID = turnOpenUserID ?? lastUser.id
                const turnAssistantParts = msgs
                  .filter((m) => m.info.role === "assistant" && m.info.id > turnStartID)
                  .flatMap((m) => m.parts)
                const landedSourceEdits = extractTrajectory(turnAssistantParts).events.some(
                  // Scratch repro scripts are evidence, not fixes — counting
                  // one here would blind both the zero-source-edit arm and
                  // the repro-tamper arm to a repro-only turn.
                  (e) => e.kind === "file-edit" && !isTestFilePath(e.filePath) && !isReproScratchPath(e.filePath),
                )
                // Fire when there is no pin at all, OR when the pin was
                // authored THIS turn yet no source edit landed (a red repro
                // cannot legitimately flip green with zero source changes —
                // that is repro/environment tampering, the 11964 shape). An
                // INHERITED pin with no new edits is a confirm/report
                // continuation turn and passes (the M4 gate above already
                // re-ran it green).
                if (!turnPinnedProbe || (!landedSourceEdits && !pinInheritedFromStore)) {
                  if (!unverifiedFinishNudged) {
                    unverifiedFinishNudged = true
                    // S4 — fold any still-unresolved governance-gate block
                    // into the same nudge (django-12039: blocked twice,
                    // never re-landed).
                    const unresolvedBlocks = [...getGateBlocks(sessionID)]
                    const blockLines = unresolvedBlocks
                      .map(
                        ([file, reason]) =>
                          `Your edit to \`${file}\` was blocked (${reason}) and never re-landed — re-apply it, updating the listed callers in the same change.`,
                      )
                      .join("\n")
                    yield* Effect.logWarning("turn_completed_unverified_nudge", {
                      "session.id": sessionID,
                      hadPin: turnPinnedProbe !== undefined,
                      landedSourceEdits,
                      unresolvedBlocks: unresolvedBlocks.length,
                    })
                    const finishNudge: SessionV1.User = {
                      id: MessageID.ascending(),
                      sessionID,
                      role: "user",
                      time: { created: Date.now() },
                      agent: lastUser.agent,
                      model: lastUser.model,
                    }
                    yield* sessions.updateMessage(finishNudge)
                    yield* sessions.updatePart({
                      id: PartID.ascending(),
                      messageID: finishNudge.id,
                      sessionID,
                      type: "text",
                      text:
                        "You are finishing a bug-fix task with NO verified reproduction / NO source change. Author a minimal repro script asserting the issue's EXPECTED behavior, RUN it, and report the result. If it fails, your fix is incomplete." +
                        (blockLines ? `\n${blockLines}` : ""),
                      synthetic: true,
                    } satisfies SessionV1.TextPart)
                    continue
                  }
                  // Second finish attempt still unresolved — loud, never a
                  // second nudge and never a deadlock; the break below fires.
                  yield* Effect.logWarning("turn_completed_unverified", {
                    "session.id": sessionID,
                    hadPin: turnPinnedProbe !== undefined,
                    landedSourceEdits,
                  })
                }
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
            turnOpenUserID = lastUser.id
            const userText = (msgs.find((m) => m.info.id === lastUser.id)?.parts ?? [])
              .map((p) => (p.type === "text" ? p.text : ""))
              .filter(Boolean)
              .join("\n")
            if (session.parentID) {
              setTestEditGate(sessionID, testEditGateArmed(session.parentID) && !promptAuthorizesTestEdits(userText))
              // P3 — a plan-only parent's dispatched slices must not edit
              // either; children inherit the no-edits gate unconditionally.
              setNoEditsGate(sessionID, noEditsGateArmed(session.parentID))
            } else {
              const regexDenyTestEdits = isFixShapedPrompt(userText) && !promptAuthorizesTestEdits(userText)

              // The turn-read runs on every root turn open (always-on, no
              // feature flag); TurnOpenCalls is the test-only off switch so
              // mock harnesses keep their scripted choreography.
              let verdict: TriageVerdict | null = null
              let arming: ArmingVerdict | undefined
              if (turnOpen.triage) {
                turnReads++
                // P4 §4b — the pre-LLM continuation short-circuit: a short,
                // code-free ack/anaphora follow-up ("go ahead", "still
                // broken") on a session with prior turns skips the turn-read
                // call entirely. Deliberately tiny and conservative — false
                // continuation on real work is the failure to avoid; anything
                // else pays the call and the model's turnRole decides.
                const hasPriorTurns = msgs.some((m) => m.info.role === "assistant")
                let continuationSource: "short-circuit" | "turn-read" | undefined
                if (hasPriorTurns && isContinuationShortCircuit(userText)) {
                  continuationSource = "short-circuit"
                } else {
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
                    if (reasonerVerdict && reasonerVerdict.goals.length >= verdict.goals.length)
                      verdict = reasonerVerdict
                  }
                  if (hasPriorTurns && verdict?.turnRole === "continuation") continuationSource = "turn-read"
                }

                if (continuationSource) {
                  // P4 continuation — the turn continues the last fresh
                  // turn's goal tree. Inherit, never recompute: the stored
                  // arming decision stays (no fresh decideArming stand-down
                  // overwrites it), the preamble is rebuilt from the stored
                  // verdict (Q-H: unchanged), the M4 probe pin is restored
                  // (the repro is still the contract), the skeleton never
                  // reseeds, the resolution gate stands down
                  // (turnContinuation, threaded to the orchestration hook),
                  // and the P10 resolve-attempts counter is NOT reset — the
                  // same task is still running. The no-edits gate is strictly
                  // turn-scoped and disarms ("go ahead" after a plan-only
                  // turn IS the user lifting the prohibition); the test-edit
                  // gate keeps its prior per-session state untouched. With
                  // the store inherited and the skeleton skipped, a
                  // continuation re-firing diagnosis language cannot re-arm a
                  // settled localization pre-pass — it routes to re-verify
                  // via the restored pin and the existing verify rungs.
                  turnContinuation = true
                  turnContinuations++
                  const stored = getTurnVerdict(sessionID)
                  const storedArming = getArmingDecision(sessionID)
                  if (stored && storedArming) {
                    turnPreamble = triagePreamble(stored, storedArming)
                    turnGoalCount = stored.goals.length
                  }
                  turnPinnedProbe = getPinnedProbe(sessionID)
                  // S3 — an inherited pin marks this as a mid-task
                  // continuation: the done-time bar must not demand fresh
                  // source edits from a confirm/report turn whose contract
                  // was already proven (the M4 gate still re-runs the pin).
                  pinInheritedFromStore = turnPinnedProbe !== undefined
                  setNoEditsGate(sessionID, false)
                  yield* Effect.logInfo("turn_continuation", {
                    "session.id": sessionID,
                    source: continuationSource,
                    turnReads,
                    turnContinuations,
                  })
                }
              }

              if (!turnContinuation) {
                // P10 — the resolution budget is per TASK: a FRESH user turn
                // is a new task, so the resolve-attempts counter resets here
                // with the other turn-open stores; a continuation turn skips
                // this (same task, same bounded budget). A later turn-open
                // rewrite must preserve this reset or one ambiguous turn
                // disables the resolution gate for the rest of the session.
                resetResolveAttempts(sessionID)
                // Fresh turn: the M4 pin store starts empty — a stale pin
                // from an earlier task must not leak into this one.
                setPinnedProbe(sessionID, undefined)
                // S4 — likewise the governance-gate block ledger: a new task
                // starts with a clean slate, not a prior task's abandonment.
                clearGateBlocks(sessionID)
              }

              if (turnOpen.triage && !turnContinuation) {
                // P1-alt — arming is decided in CODE over the extracted
                // evidence, never by the model. Stored every FRESH turn — the
                // null verdict's stand-down included — so the todowrite door
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

              if (turnContinuation) {
                // Continuation: everything below (gates, pin, skeleton) is
                // inherited state — nothing re-derives.
              } else if (verdict && arming) {
                // U1/U2 — a non-null verdict is the decider for this turn's
                // preamble, gates, and skeleton.
                turnPreamble = triagePreamble(verdict, arming)
                turnGoalCount = verdict.goals.length
                yield* Effect.logInfo("turn_triage", { "session.id": sessionID, ...triageTelemetry(verdict) })

                // B3 — triage's constraint is the primary armer; OR in the
                // governance-regex signal so a turn-read MISS can never disarm
                // a gate the regex would have armed on its own. F4c ORs in the
                // verdict's goal shapes: constraints are quote-grounded, so a
                // ticket that never mentions tests can't arm via triage, and
                // optimization phrasing evades the fix-shape regex — 11885
                // fire-3 walked through both gaps and edited the grading tests.
                const triageDenyTestEdits = verdict.constraints.some((c) => c.kind === "no-test-edit")
                const shapeDenyTestEdits = diagnosisDeniesTestEdits(
                  verdict.goals.map((g) => g.shape),
                  userText,
                )
                const denyTestEdits = regexDenyTestEdits || triageDenyTestEdits || shapeDenyTestEdits
                setTestEditGate(sessionID, denyTestEdits)
                if (denyTestEdits) yield* Effect.logInfo("test_edit_gate_armed", { "session.id": sessionID })

                // P3 — the no-edits constraint ("propose/plan, don't code")
                // arms a hard deny for every edit/write this turn, mirroring
                // the no-test-edit seam above. needsPlan composes: the P12
                // plan seed still plants — it is edit-free by design.
                const denyEdits = verdict.constraints.some((c) => c.kind === "no-edits")
                setNoEditsGate(sessionID, denyEdits)
                if (denyEdits) yield* Effect.logInfo("no_edits_gate_armed", { "session.id": sessionID })

                // P4 — the store a later continuation turn inherits the
                // preamble/goal tree from.
                setTurnVerdict(sessionID, verdict)
                // M2 — the turn's file evidence (prompt-named paths +
                // tree-resolved dotted modules): the probe fallback for
                // slices whose own text names no file. Continuation turns
                // inherit it with the verdict.
                setTurnFiles(sessionID, [
                  ...new Set([...extractSliceFiles(userText), ...resolveDottedPyModules(userText, ctx.directory)]),
                ])

                // M4 — the probe pin keys on the VERDICT: a diagnosis-shaped
                // goal arms the turn-end prove-it gate with the most-specific
                // reproduction the prompt names, so an INLINE fix cannot
                // conclude red (no dispatched slice → no probe rung). Turn-read
                // failed ⇒ no turn-open pin this turn — the probe-from-red pin
                // and the slice verify rungs still run.
                if (verdict.goals.some((g) => g.shape === "diagnosis-vague" || g.shape === "diagnosis-grounded")) {
                  turnPinnedProbe = yield* Effect.promise(() => deriveTurnProbe({ promptText: userText }))
                  if (turnPinnedProbe) {
                    setPinnedProbe(sessionID, turnPinnedProbe)
                    yield* Effect.logInfo("turn_probe_pinned", {
                      "session.id": sessionID,
                      probe: turnPinnedProbe.probe.command,
                      redExit: turnPinnedProbe.redEvidence?.exitCode ?? null,
                      redTail: turnPinnedProbe.redEvidence?.outputTail ?? null,
                    })
                  }
                }

                const existingTodos = yield* todoStore.get(sessionID).pipe(Effect.orElseSucceed(() => []))
                if (existingTodos.length === 0) {
                  const skeleton = buildTriageTodoSkeleton(verdict, arming, {
                    hasPinnedProbe: turnPinnedProbe !== undefined,
                  })
                  // S2 — did the skeleton seed the repro pre-pass? Gates the
                  // mid-turn hand-off/abstention logic in the SM4 block above.
                  reproSeededThisTurn = skeleton.some((t) => t.content === REPRO_SLICE_CONTENT)
                  // Owner-decision trace: which goals seeded a reasoner pre-pass
                  // (the diagnosis writer) and the shapes that drove it — the
                  // stage-1 routing decision, logged with mechanism:"orchestrator"
                  // so a trace separates a reasoner cast UP FRONT here from one
                  // cast as RECOVERY by the SM backstop (stuck_escalate below).
                  const seeds = skeleton
                    .map((t) =>
                      t.content === REPRO_SLICE_CONTENT
                        ? "repro"
                        : t.content === LOCALIZATION_SLICE_CONTENT
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
                // preamble, no skeleton, no probe pin, no no-edits gate, and
                // the continuation store CLEARS (a degraded turn has no goal
                // tree to continue). A wrong guess steers the conductor worse
                // than no guess. Only the governance regexes still arm the
                // no-test-edit gate.
                setTestEditGate(sessionID, regexDenyTestEdits)
                if (regexDenyTestEdits) yield* Effect.logInfo("test_edit_gate_armed", { "session.id": sessionID })
                setNoEditsGate(sessionID, false)
                setTurnVerdict(sessionID, null)
                setTurnFiles(sessionID, [])
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

          // L2.1/L2.2 — in-loop $0 context economy at this clean step boundary
          // (the previous stream has finished, the next request is not yet
          // built). Run sessions have exactly one user turn and end it when
          // the task is done, so without this neither the turn-end prune nor
          // the overflow ladder ever shrinks mid-run context. Two arms:
          //  · every STEP_COMPACT_INTERVAL steps — the deterministic,
          //    model-invisible passes only (window-exact stale-read drop +
          //    token-tail prune, both floor-guarded);
          //  · past STEP_CTX_ECONOMIC_CEILING — additionally maskObservations.
          //    Masking rewrites results the model may still be steering by
          //    into one-line syntheses; on the lean 11999 L2 probe a %10 mask
          //    cadence drove repeat searches (+4× turns), so it is reserved
          //    for runs whose context has actually grown past the economic
          //    ceiling (the grind case it was designed for).
          // These passes are $0 and non-destructive (`time.compacted` tags /
          // masked syntheses; raw outputs stay in the DB), so no compaction
          // task is created and AC-1.5's boundary-only deferral below is
          // untouched. Synchronous on purpose: the request build reads
          // `msgs`, so re-fetch it the same way the loop top does — the
          // passes write through updatePart → PartUpdated projection, which
          // commits to the DB atomically with the publish.
          {
            // Live-context estimate mirrors isOverflow's read of the latest
            // finished assistant's tokens; cache.read carries the cached
            // prompt bulk on our implicit-caching path.
            const liveCtx = lastFinished
              ? lastFinished.tokens.input + lastFinished.tokens.cache.read + lastFinished.tokens.output
              : 0
            const overCeiling = liveCtx > SessionCompaction.STEP_CTX_ECONOMIC_CEILING
            if (step % SessionCompaction.STEP_COMPACT_INTERVAL === 0 || overCeiling) {
              if (overCeiling) yield* compaction.maskObservations({ sessionID })
              yield* compaction.pruneStaleReads({ sessionID })
              yield* compaction.prune({ sessionID })
              msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
                Effect.provideService(Database.Service, database),
              )
            }
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

            // L1.3 — aggregate per-step tool-result budget. Before the previous
            // step's tool results enter the model transcript (toModelMessagesEffect
            // below), cap their COMBINED tokens, trimming the largest first with a
            // visible recovery marker, so a batched/fan-out step can't stuff the
            // context it was meant to save. Governance + step observation earlier
            // this iteration already read the full outputs; the trim is persisted so
            // every later step keeps the cap. Per-tool caps (tool/truncate.ts) are
            // orthogonal and stay as-is.
            const priorAssistant = lastAssistant ? msgs.findLast((m) => m.info.id === lastAssistant.id) : undefined
            if (priorAssistant) {
              const stepResults = priorAssistant.parts.flatMap((p) =>
                p.type === "tool" &&
                p.state.status === "completed" &&
                !p.state.time.compacted &&
                typeof p.state.output === "string"
                  ? [{ id: p.id, output: p.state.output }]
                  : [],
              )
              const budgetOutcome = enforceStepBudget(stepResults)
              if (budgetOutcome.reclaimed > 0) {
                const trims = new Map(
                  budgetOutcome.results.filter((r) => r.trimmed).map((r) => [r.id, r.output] as const),
                )
                for (const part of priorAssistant.parts) {
                  if (part.type !== "tool" || part.state.status !== "completed") continue
                  const next = trims.get(part.id)
                  if (next === undefined) continue
                  part.state.output = next // mutate the in-memory snapshot for this step's transcript
                  yield* sessions.updatePart(part) // persist so later steps keep the cap
                }
                // [econ:meter] receipt attribution — record the reclaim at the same
                // seam per-tool compression records its own token accounting.
                recordToolCall({
                  tool: "step-budget",
                  raw_tokens: budgetOutcome.before,
                  returned_tokens: budgetOutcome.after,
                  ratio: budgetOutcome.before > 0 ? budgetOutcome.after / budgetOutcome.before : 1,
                })
              }
            }

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
                    // P3/Q-D — on a research-shaped turn (stored verdict; the
                    // store also covers continuation turns) recon slices
                    // auto-cast the web-enabled researcher.
                    const persona = personaForSlice(
                      { sliceType: req.sliceType, persona: sourceTodo?.persona },
                      { researchShaped: researchShapedTurn(sessionID) },
                    )
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
                    // P11b: a reasoner/oracle slice seat (never a delegate child —
                    // req.delegated rides every mini-loop request) is a depth-1
                    // sub-planner: it gets the `delegate` tool and a registered
                    // delegation seat below.
                    const delegating = isDelegatingSeat(req.tier, req.delegated)
                    const child = yield* sessions.create({
                      parentID: sessionID,
                      title: `slice: ${req.sliceId}`.slice(0, 100),
                      agent: childAgent,
                      permission: childSlicePermission(session.permission, readOnly, persona, deciderSeat, delegating),
                    })
                    const sliceFiles = extractSliceFiles(req.prompt)
                    if (delegating) {
                      registerDelegationSeat(child.id, {
                        parentSliceId: req.sliceId,
                        callerTier: req.tier,
                        // The parent slice's own predicted scope (the same P6b
                        // extraction) — the delegate containment boundary.
                        parentScope: new Set(sliceFiles),
                        ports: delegationPorts,
                      })
                    }
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
                    ).pipe(
                      // P11b: the delegation seat lives exactly as long as the
                      // child's own run — released on every exit path so a
                      // settled/cancelled seat can never delegate again.
                      Effect.ensuring(Effect.sync(() => releaseDelegationSeat(child.id))),
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

              // Shared by the conductor's own orchestration run AND every P11b
              // delegation seat: one probe surface, one loop-option set — a
              // delegate's mini-loop rides the SAME pipeline (persona, budget,
              // verify ladder, snapshot bracket, ledger), never a clone.
              const orchestrationProbes: SliceProbes = {
                probeCoupling: async (text, files) => probeSliceCoupling(text, files, await ensureGraphReady()),
                probeTestStrength: (files) => probeSliceTestStrength(files),
                probeVerifyCommands: (files) => probeSliceVerifyCommands(files),
              }
              const loopOptions: ConductorLoopOptions = {
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
              }
              // P11b — the live seams a delegating (reasoner/oracle) slice seat
              // needs to hand a sub-item down: the same dispatch closure and
              // safety stack as above, plus the todo-recording ports (the TOOL
              // HANDLER writes the child todo, never the model) and the
              // telemetry sink. Registered per child session in `dispatch`.
              const delegationPorts: DelegationPorts = {
                dispatch,
                probes: orchestrationProbes,
                options: loopOptions,
                getTodos: () => bridge.promise(todoStore.get(sessionID)),
                appendTodo: (todo) =>
                  bridge.promise(
                    Effect.gen(function* () {
                      const current = yield* todoStore.get(sessionID)
                      yield* todoStore.update({ sessionID, todos: [...current, todo] })
                      return current.length
                    }),
                  ),
                setTodoStatus: (index, status) =>
                  bridge.promise(
                    Effect.gen(function* () {
                      const current = yield* todoStore.get(sessionID)
                      const next = current.map((t, i) => (i === index ? { ...t, status } : t))
                      yield* todoStore.update({ sessionID, todos: next })
                    }),
                  ),
                onDelegate: (info) => {
                  bridge.fork(Effect.logInfo("delegate", { "session.id": sessionID, ...info }))
                },
              }

              const orch = yield* Effect.promise(() =>
                runConductorOrchestration({
                  getTodos: () => bridge.promise(todoStore.get(sessionID)),
                  probes: orchestrationProbes,
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
                  // P4 — a continuation turn stands the resolution gate down.
                  continuation: turnContinuation,
                  // P3/Q-D — research turns route slices to the researcher
                  // persona + citation verifier inside todosToLoopSlices.
                  researchShaped: researchShapedTurn(sessionID),
                  // M2 — the turn's file evidence, the probe fallback for
                  // slices whose own text names no file.
                  turnFiles: getTurnFiles(sessionID),
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
                  // L4.2 — a degraded turn-read holds its conductor todos inline;
                  // log WHY the turn stayed inline (never a silent stand-down).
                  onDegradedStandDown: (info) => {
                    bridge.fork(
                      Effect.logInfo("orchestration_degraded_stand_down", {
                        "session.id": sessionID,
                        reason: "degraded-turn-read",
                        conductorTodos: info.conductorTodos,
                        grindEscapeHatch: info.grindEscapeHatch,
                      }),
                    )
                  },
                  options: loopOptions,
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
                    // P11b: the synthesis hop is a writing job over settled
                    // digests, not a slice seat — same suppression as a
                    // delegate child, so it never gets a delegation seat.
                    delegated: true,
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
