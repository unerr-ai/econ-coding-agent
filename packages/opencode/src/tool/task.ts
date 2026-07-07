import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import {
  assembleSliceWiring,
  DEFAULT_WIRING_TOKEN_BUDGET,
  type SliceWiringGraph,
  type SliceWiringInput,
} from "@opencode-ai/code-intelligence"
import { getGraph } from "./graph-tools"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

/**
 * Minimal structural shape for slice metadata that may ride along on a task
 * spawn's `ctx.extra.sliceMetadata` (sliceType, target files/entities,
 * external unknowns). Deliberately NOT imported from the todo tool's own
 * schema — that schema is owned by a parallel workstream — so any
 * shape-compatible object works here without a build-time coupling.
 */
export interface TaskSliceMetadata {
  readonly sliceType?: string
  readonly files?: readonly string[]
  readonly entities?: readonly string[]
  readonly externalUnknowns?: readonly string[]
}

const id = "task"

/**
 * Hard cap on graph access inside buildChildPrompt. A cold/slow graph must
 * never delay a child spawn — the race in buildChildPrompt falls back to the
 * unwired prompt once this elapses, regardless of what the graph is doing.
 */
const SLICE_WIRING_GRAPH_BUDGET_MS = 500

/**
 * OL-7.7: append a compact deterministic-wiring section (callers/blast
 * radius, signatures) to the child prompt when the spawn carries slice
 * metadata, so the child doesn't have to re-guess the coupling. Graph access
 * is capped at SLICE_WIRING_GRAPH_BUDGET_MS so a cold/slow graph never delays the spawn
 * past that bound, and degrades silently to the prompt unchanged on any
 * timeout, error, missing metadata, or empty wiring.
 *
 * @sem domain=infrastructure role=digest
 */
export async function buildChildPrompt(
  prompt: string,
  slice: TaskSliceMetadata | undefined,
  graph: SliceWiringGraph = getGraph(),
): Promise<string> {
  if (!slice) return prompt
  try {
    const input: SliceWiringInput = {
      text: prompt,
      files: slice.files,
      entities: slice.entities,
      externalUnknowns: slice.externalUnknowns,
      tokenBudget: DEFAULT_WIRING_TOKEN_BUDGET,
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SLICE_WIRING_GRAPH_BUDGET_MS)
    })
    try {
      const raced = await Promise.race([assembleSliceWiring(input, graph), budget])
      if (raced === "timeout" || !raced.text) return prompt
      return [prompt, raced.text].join("\n\n")
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return prompt
  }
}
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

const DIGEST_OUTCOME_MAX_CHARS = 480
const DIGEST_ANCHOR_MAX_COUNT = 8
const DIGEST_ANCHOR_MAX_CHARS = 160
const DIGEST_FOLLOWUP_MAX_COUNT = 5
const DIGEST_FOLLOWUP_MAX_CHARS = 160

function truncateText(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
}

// Matches either a backtick-quoted span or a bare path token (>=1 path
// separator, file extension, optional :line or :line-line suffix).
const ANCHOR_RE =
  /`([^`\n]{1,160})`|((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,10}(?::\d+(?:-\d+)?)?)/g

function extractAnchors(text: string): string[] {
  const anchors: string[] = []
  const seen = new Set<string>()
  ANCHOR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ANCHOR_RE.exec(text))) {
    const backticked = match[1]
    const candidate = (backticked ?? match[2] ?? "").trim()
    if (!candidate) continue
    // A backtick span only counts as an anchor if it looks like a path or a
    // dotted entity reference (e.g. `TaskTool.execute`), not arbitrary code.
    if (backticked && !/[./]/.test(candidate)) continue
    if (candidate.length > DIGEST_ANCHOR_MAX_CHARS) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    anchors.push(candidate)
    if (anchors.length >= DIGEST_ANCHOR_MAX_COUNT) break
  }
  return anchors
}

function extractFollowUps(text: string): string[] {
  const followUps: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const value = truncateText(raw, DIGEST_FOLLOWUP_MAX_CHARS)
    if (!value || seen.has(value)) return
    seen.add(value)
    followUps.push(value)
  }
  let inSection = false
  for (const raw of text.split(/\r?\n/)) {
    if (followUps.length >= DIGEST_FOLLOWUP_MAX_COUNT) break
    const line = raw.trim()
    if (!line) {
      inSection = false
      continue
    }
    // A bare "Follow-ups:" / "TODO:" / "Next steps:" heading opens a section
    // whose subsequent bullet lines are collected until a blank line.
    if (/^(?:follow[- ]?ups?|todo|next steps?)\s*[:-]?\s*$/i.test(line)) {
      inSection = true
      continue
    }
    const inline = /\b(?:follow[- ]?ups?|todo|next steps?)\b\s*[:-]\s*(.+)/i.exec(line)
    if (inline) {
      push(inline[1] ?? "")
      inSection = false
      continue
    }
    const bullet = /^(?:[-*]|\d+[.)])\s+(.+)/.exec(line)
    if (inSection && bullet) {
      push(bullet[1] ?? "")
      continue
    }
    if (!bullet) inSection = false
  }
  return followUps
}

// Marks the start of a follow-up section (heading or inline "Follow-up: ...")
// so extractOutcome can stop before it instead of folding it into the outcome.
const FOLLOWUP_START_RE = /^(?:follow[- ]?ups?|todo|next steps?)\s*[:-]?\s*(?:.+)?$/i

function extractOutcome(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const cutoff = lines.findIndex((line) => FOLLOWUP_START_RE.test(line))
  const body = cutoff === -1 ? lines : lines.slice(0, cutoff)
  const source = body.length > 0 ? body : lines
  return truncateText(source.slice(0, 3).join(" "), DIGEST_OUTCOME_MAX_CHARS)
}

/**
 * Compresses a child sub-agent's final message into a bounded OUTCOME /
 * ANCHORS / FOLLOW-UPS digest (briefs, not transcripts) so a large child
 * transcript can't blow up the parent conductor's context; never throws.
 *
 * @sem domain=infrastructure role=digest
 */
function digestChildText(text: string): string {
  try {
    const outcome = extractOutcome(text) || "(no output)"
    const anchors = extractAnchors(text)
    const followUps = extractFollowUps(text)
    const lines = [`OUTCOME: ${outcome}`]
    if (anchors.length > 0) lines.push(`ANCHORS: ${anchors.join(", ")}`)
    if (followUps.length > 0) {
      lines.push("FOLLOW-UPS:")
      for (const item of followUps) lines.push(`- ${item}`)
    }
    return lines.join("\n")
  } catch {
    return `OUTCOME: ${truncateText(text, DIGEST_OUTCOME_MAX_CHARS) || "(no output)"}`
  }
}

/**
 * Wraps a child task's state into the `<task>` envelope the parent
 * conductor sees, compressing the child's final text into a bounded digest
 * (see `digestChildText`) so a big sub-agent transcript stays cheap to
 * integrate; canned "running" status text passes through unchanged.
 *
 * @sem domain=infrastructure role=digest
 */
function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  const text = input.state === "running" ? input.text : digestChildText(input.text)
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
        // OL-9.3d: exclude rules that only exist because the project's global
        // `permission` block turned them on for every agent — a persona/tier
        // agent that never configured task/todowrite itself stays denied.
        globalPermission: Permission.fromConfig(cfg.permission ?? {}),
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      // Children default to the cheap executor tier when their own agent
      // config has no model pinned — never to whatever model the parent/lead
      // happens to be running (a reasoner/oracle lead must not hand its
      // expensive model down to a read-only recon child). An explicit model
      // pin on the subagent's config always wins; only when "executor" isn't
      // configured either (non-econ setups) do we fall back to today's
      // parent-model inheritance.
      const executor = next.model ? undefined : yield* agent.get("executor")
      const inheritsParentModel = !next.model && !executor?.model
      const model = next.model ?? executor?.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const sliceMetadata = ctx.extra?.["sliceMetadata"] as TaskSliceMetadata | undefined
        const childPrompt = yield* Effect.promise(() => buildChildPrompt(params.prompt, sliceMetadata))
        const parts = yield* ops.resolvePromptParts(childPrompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: inheritsParentModel ? variant : undefined,
          agent: next.name,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
