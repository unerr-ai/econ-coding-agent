export * as SessionRunnerModel from "./model"

import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
// econ S3.2: risk-escalation router — pure function imported from code-intelligence
// econ AC-3.1/AC-3.2: cheap-first triage bias for a session's first turn
import {
  routeTurn,
  defaultRouterConfig,
  defaultRouterState,
  decideTriageTurn,
  type RouterConfig,
  type RouterState,
} from "@opencode-ai/code-intelligence"
import { AgentV2 } from "../../agent"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { IntegrationConnection } from "../../integration/connection"
import { ModelV2 } from "../../model"
import { ModelRequest } from "../../model-request"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {}

export type Error = ModelNotSelectedError | ModelUnavailableError | VariantUnavailableError | UnsupportedApiError

// ---------------------------------------------------------------------------
// econ S3.2 — Risk-escalation router types
// ---------------------------------------------------------------------------

/**
 * Supplies the code-structural risk score (0–100) for the current turn.
 * Default implementation returns 0 (conductor tier, degrade-open).
 *
 * @sem domain=routing role=interface
 */
export type RiskProvider = (session: SessionSchema.Info) => Effect.Effect<number, never>

/**
 * Supplies the first user prompt's text for AC-3.2 heavy-prompt detection.
 * Default: no producer wired → prompt is treated as absent, so isHeavyPrompt
 * never fires and triage stays applied on the first turn (degrade-open).
 *
 * @sem domain=routing role=interface
 */
export type TriagePromptProvider = (session: SessionSchema.Info) => Effect.Effect<string | undefined, never>

/**
 * Configuration for the AC-3.1/AC-3.2 cheap-first triage bias. Omit entirely
 * to keep the pre-triage S3.2 risk-route behaviour unchanged (degrade-open).
 *
 * @sem domain=routing role=interface
 */
export interface TriageLayerConfig {
  /** cfg.triage.enabled — default true once this config object is supplied. */
  enabled?: boolean
  /** Resolved triage-tier model reference: cfg.triage.model ?? cfg.small_model, parsed by the caller. */
  model?: ModelV2.Ref
  /** cfg.triage.escalate_on override; defaults to code-intelligence's DEFAULT_ESCALATE_ON. */
  escalateOn?: readonly string[]
  /** Supplies the first prompt's text for isHeavyPrompt. Omit → never heavy. */
  promptProvider?: TriagePromptProvider
}

/**
 * Configuration for locationLayerWith (S3.2 risk-escalation router +
 * AC-3.1/AC-3.2 triage bias). All fields optional — omit for degrade-open defaults.
 *
 * @sem domain=routing role=interface
 */
export interface RouterLayerConfig {
  /**
   * Supplies the code-structural risk score 0–100 for each turn.
   * Default: always returns 0 → conductor tier when no signal available.
   */
  riskProvider?: RiskProvider
  /** Hysteresis band overrides. Default: { escalateAbove: 70, deescalateBelow: 40 }. */
  routerConfig?: RouterConfig
  /** AC-3.1/AC-3.2 cheap-first triage bias for the session's first turn. Omit → disabled (degrade-open). */
  triageConfig?: TriageLayerConfig
}

/**
 * AC-3.3: injection point for a RouterLayerConfig, supplied by the opencode
 * layer where config reading (cfg.triage/cfg.small_model, which only exist on
 * the opencode-side Config, not core's) and model-string parsing
 * (Provider.parseModel) happen — core only ever consumes the resolved shape
 * here, never reads triage config or parses model strings itself (layering
 * rule). Absent from context → the caller falls back to `{}` (degrade-open,
 * identical to pre-AC-3.3 dormant behaviour).
 *
 * The value is a resolver FUNCTION of the location's directory, not a
 * resolved object and not a bare Effect: location layers are built in
 * whatever fiber first touches the location, and v2 /api request fibers
 * carry no instance context (OL-9.6g — a bare Effect that read
 * instance-scoped Config died with "InstanceRef not provided" on every
 * TUI/v2 request). The producer must bind its own instance scope from the
 * directory argument; the consumer (location-layer.ts) passes ref.directory.
 *
 * @sem domain=routing role=interface
 */
export const RouterLayerConfigTag = Context.Reference<(directory: string) => Effect.Effect<RouterLayerConfig>>(
  "@opencode/v2/SessionRunnerModel.RouterLayerConfig",
  { defaultValue: () => () => Effect.succeed({}) },
)

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: ModelV2.Info, connection?: IntegrationConnection.Info, credential?: Credential.Info) => {
  if (credential?.value.type === "key") return Auth.value(credential.value.key)
  if (credential?.value.type === "oauth") return Auth.value(credential.value.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
  return connection?.type === "env" ? Auth.config(connection.name) : undefined
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const options = model.request.options ?? {}
  const namespace = model.api.type === "aisdk" ? ModelRequest.namespace(model.api.package) : undefined
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    generation: model.request.generation,
    providerOptions: namespace && Object.keys(options).length > 0 ? { [namespace]: options } : undefined,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          ModelRequest.assign(draft.request, variant)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  connection?: IntegrationConnection.Info,
  credential?: Credential.Info,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.value.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.value.metadata)
        })
  const key = apiKey(resolved, connection, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  connection?: IntegrationConnection.Info,
  credential?: Credential.Info,
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) => fromCatalogModel(model, connection, credential)),
  )

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/**
 * Builds the model-resolution layer with an injected risk provider, optional
 * hysteresis config, and an optional AC-3.1/AC-3.2 triage bias. The risk
 * provider and triage config are the only injectables needed for tests — all
 * router/triage logic is internal.
 *
 * Priority order for model resolution:
 *   1. session.model — explicit per-session override (always wins, skips router)
 *   2. Triage-tier model (AC-3.1/AC-3.2, session's first turn only):
 *      triageConfig.model set, enabled, first turn, prompt not heavy → triageConfig.model
 *      (cfg.triage.model ?? cfg.small_model, resolved by the caller)
 *   3. Risk-routed tier agent model (S3.2):
 *      risk > 70  → oracle agent model
 *      risk < 40  → conductor agent model
 *      40–70      → hysteresis holds current tier (no flap)
 *   4. session's active agent model (S1.1 fallback when tier agent unconfigured)
 *   5. catalog.model.default()
 *   6. first supported available model
 *
 * Degrade-open: if riskProvider is omitted or returns 0, conductor is always
 * selected. If triageConfig (or its .model) is omitted, disabled, not the
 * first turn, or the first prompt matches an escalate_on signal, triage never
 * applies and behaviour is identical to the pre-triage S3.2 behavior.
 *
 * Hysteresis state is kept in an in-memory Map (per layer instance, keyed by
 * sessionID). Resets on process restart → safe degrade-open to conductor.
 * "First turn" for triage purposes is derived from this same map (no entry
 * yet for the session) — also resets on restart, which lands back on triage
 * rather than a stale mid-session tier (cost-safe).
 * Rationale for in-memory vs S1.3 SQLite: router state is transient; a restart
 * losing the tier is acceptable (lands on conductor, not oracle — cost-safe).
 * Migrate to canonical-state (S1.3) in S5 if cross-restart persistence matters.
 *
 * Extension hooks:
 *   triageConfig (AC-3.1/AC-3.2) — wired above; the .promptProvider producer
 *     that supplies live prompt text is left for a later caller to inject.
 *   abstain  (S3.3) — hold tier without recording a transition; unused here
 *   forceTier (S3.5, routeTurn's raw bypass) — unused here; triage instead
 *     short-circuits before routeTurn is called
 *
 * @sem domain=routing role=resolver
 */
export const locationLayerWith = (config: RouterLayerConfig = {}) => {
  const riskProvider: RiskProvider = config.riskProvider ?? (() => Effect.succeed(0))
  const routerCfg: RouterConfig = config.routerConfig ?? defaultRouterConfig
  const triageCfg = config.triageConfig

  // Per-session hysteresis state lives in the layer closure (in-memory).
  const routerStateMap = new Map<string, RouterState>()

  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      const agents = yield* AgentV2.Service
      return Service.of({
        resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
          // econ S3.2: risk-escalation router fork.
          // Only engages when no explicit session.model override is present.
          // DEGRADE-OPEN: riskProvider defaults to 0 → conductor when no signal.
          let routedAgentModel: typeof session.model | undefined = undefined
          if (!session.model) {
            // econ AC-3.1/AC-3.2: triage bias — only on the session's first turn
            // seen by this layer instance (no hysteresis state recorded yet),
            // and only when a triage config + resolved model were supplied.
            // DEGRADE-OPEN: missing triageConfig/.model, disabled, a later
            // turn, or a heavy first prompt all fall straight through to the
            // S3.2 risk-route below — never crashes the turn.
            const isFirstTurn = !routerStateMap.has(session.id)
            let triageApplied = false
            if (triageCfg?.model && isFirstTurn) {
              const prompt = triageCfg.promptProvider ? yield* triageCfg.promptProvider(session) : undefined
              const decision = decideTriageTurn({
                isFirstTurn,
                enabled: triageCfg.enabled ?? true,
                prompt,
                escalateOn: triageCfg.escalateOn,
              })
              if (decision.applyTriage) {
                routedAgentModel = triageCfg.model
                routerStateMap.set(session.id, defaultRouterState)
                triageApplied = true
              }
            }

            if (!triageApplied) {
              const risk = yield* riskProvider(session)
              const prevState = routerStateMap.get(session.id) ?? defaultRouterState
              const { tier, state: nextState } = routeTurn({ risk, state: prevState }, routerCfg)
              routerStateMap.set(session.id, nextState)
              // Map tier → agent. Yields undefined if the tier agent is not configured
              // in opencode.json — falls through to the S1.1 agent-model chain below.
              routedAgentModel = (yield* agents.resolve(AgentV2.ID.make(tier)))?.model
            }
          }

          // S1.1 resolution chain (kept intact as fallback):
          //   session.model > routed tier agent model (S3.2) > session agent model > undefined
          const agentModel = session.model
            ? undefined
            : routedAgentModel ?? (yield* agents.resolve(session.agent))?.model
          const effectiveModel = session.model ?? agentModel

          // Location plugins populate and filter the catalog asynchronously during layer startup.
          const defaultModel = effectiveModel ? undefined : yield* catalog.model.default()
          const selected = effectiveModel
            ? (yield* catalog.model.available()).find(
                (m) => m.providerID === effectiveModel.providerID && m.id === effectiveModel.id,
              )
            : defaultModel && supported(defaultModel)
              ? defaultModel
              : (yield* catalog.model.available()).find(supported)
          if (!selected && effectiveModel)
            return yield* new ModelUnavailableError({
              providerID: effectiveModel.providerID,
              modelID: effectiveModel.id,
            })
          if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
          const connection = yield* integrations.connection.forIntegration(Integration.ID.make(selected.providerID))
          return yield* resolve(
            session,
            selected,
            connection,
            connection?.type === "credential" ? yield* credentials.get(connection.id) : undefined,
          )
        }),
      })
    }),
  )
}

/**
 * Default location layer: resolves models from the catalog with the S3.2
 * risk-escalation router active (degrade-open — no risk provider → conductor
 * tier; oracle tier requires the `oracle` agent in opencode.json).
 *
 * Replaces the pre-S3.2 locationLayer while preserving all S1.1 behaviours.
 *
 * @sem domain=routing role=resolver
 */
export const locationLayer = locationLayerWith({})
