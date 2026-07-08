import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { select, toolUsage } from "../prompts"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"
import { applyAdaptiveReasoning } from "./reasoning-gate"
import { sessionAffinityFor } from "@opencode-ai/code-intelligence"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  /** Explicit un-mute for a small call whose conductor still needs to reason (the arming judge). */
  readonly unmuteReasoning?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  // Resolve the final tool set the model will receive (post-HIDDEN, post-permission) once, so the
  // generated tool-usage block (Sprint 5b §10.1) lists exactly those ids; reused as `tools` below.
  const resolvedTools = resolveTools(input)
  const toolBlock = toolUsage(Object.keys(resolvedTools))
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : select(input.model, input.agent)),
      ...(toolBlock ? [toolBlock] : []),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  // Z3-econ S2.0: context.assemble.before — push-based injection seam.
  // Fires after system is assembled but before messages are built, so plugins
  // (S2.1 memory, S2.4 recon) can prepend context without touching the DB.
  const contextInject = yield* input.plugin.trigger(
    "context.assemble.before",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      system,
      messages: [] as Array<{ role: "system" | "user" | "assistant"; content: string }>,
    },
  )

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  // Adaptive conductor reasoning gate: default stays non-thinking; this un-mutes
  // thinking only for the turn's plan step, the step right after a failed command,
  // and the step right after a tool result contradicted the model's premise (F4).
  // Small (housekeeping) calls skip the gate entirely: a stateless one-shot like
  // turn triage ends in a user message and would always read as a "plan" step —
  // un-muted thinking then starves/slows its JSON output (live-fire: triage null
  // on every real turn until this guard).
  // Small (housekeeping) calls skip the adaptive gate — EXCEPT an explicit
  // unmuteReasoning request: the arming judge is a small one-shot that STILL needs
  // the conductor to reason through grounding strength (muted, minimax over-fires
  // STRONG-grounded diagnoses — see arming-judge.ts / PROMPT_SLICING_CORPUS.md R2).
  if (input.unmuteReasoning && options.reasoningEffort === "none") {
    delete options.reasoningEffort
    yield* Effect.logInfo("reasoning un-muted (explicit)", { sessionID: input.sessionID, reason: "unmuteReasoning" })
  }
  const reasoningGate = input.small ? undefined : applyAdaptiveReasoning(input.messages, options)
  if (reasoningGate) yield* Effect.logInfo("adaptive reasoning un-muted", { sessionID: input.sessionID, reason: reasoningGate })

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          // Injections from context.assemble.before (e.g. memory, recon context)
          ...(contextInject.messages as ModelMessage[]),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolvedTools
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "X-Session-Id": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      // OL-9.2b: the litellm gateway's upstream honors x-session-affinity for prompt-cache
      // routing, pinning a session's successive calls to one backend replica. W8 (2026-07-06):
      // a live probe proved this helps some models and actively breaks cache + latency on
      // others, so the header is registry-driven per model (sessionAffinityFor), never sent
      // unconditionally. Scoped to litellm only — other providers don't route on this header,
      // and openai's ws-pool (plugin/openai/ws-pool.ts) keys off the same header name for an
      // unrelated purpose.
      ...(input.model.providerID === "litellm" && sessionAffinityFor(input.model.id)
        ? { "x-session-affinity": input.sessionID }
        : {}),
      ...input.model.headers,
      ...headers,
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
