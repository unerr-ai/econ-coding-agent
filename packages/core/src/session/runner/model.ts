export * as SessionRunnerModel from "./model"

import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
// econ S3.2: risk-escalation router — pure function imported from code-intelligence
import {
  routeTurn,
  defaultRouterConfig,
  defaultRouterState,
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
 * Configuration for locationLayerWith (S3.2 risk-escalation router).
 * All fields optional — omit for degrade-open defaults.
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
}

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
 * Builds the model-resolution layer with an injected risk provider and optional
 * hysteresis config. The risk provider is the only injectable needed for tests —
 * all router logic is internal.
 *
 * Priority order for model resolution:
 *   1. session.model — explicit per-session override (always wins, skips router)
 *   2. Risk-routed tier agent model (S3.2):
 *      risk > 70  → oracle agent model
 *      risk < 40  → conductor agent model
 *      40–70      → hysteresis holds current tier (no flap)
 *   3. session's active agent model (S1.1 fallback when tier agent unconfigured)
 *   4. catalog.model.default()
 *   5. first supported available model
 *
 * Degrade-open: if riskProvider is omitted or returns 0, conductor is always
 * selected — identical to the pre-S3.2 S1.1 behavior.
 *
 * Hysteresis state is kept in an in-memory Map (per layer instance, keyed by
 * sessionID). Resets on process restart → safe degrade-open to conductor.
 * Rationale for in-memory vs S1.3 SQLite: router state is transient; a restart
 * losing the tier is acceptable (lands on conductor, not oracle — cost-safe).
 * Migrate to canonical-state (S1.3) in S5 if cross-restart persistence matters.
 *
 * Extension hooks accepted but unused in this sprint:
 *   abstain  (S3.3) — hold tier without recording a transition
 *   forceTier (S3.5) — triage bypass
 * These are wired into routeTurn's input shape; callers inject them later.
 *
 * @sem domain=routing role=resolver
 */
export const locationLayerWith = (config: RouterLayerConfig = {}) => {
  const riskProvider: RiskProvider = config.riskProvider ?? (() => Effect.succeed(0))
  const routerCfg: RouterConfig = config.routerConfig ?? defaultRouterConfig

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
            const risk = yield* riskProvider(session)
            const prevState = routerStateMap.get(session.id) ?? defaultRouterState
            const { tier, state: nextState } = routeTurn({ risk, state: prevState }, routerCfg)
            routerStateMap.set(session.id, nextState)
            // Map tier → agent. Yields undefined if the tier agent is not configured
            // in opencode.json — falls through to the S1.1 agent-model chain below.
            routedAgentModel = (yield* agents.resolve(AgentV2.ID.make(tier)))?.model
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
