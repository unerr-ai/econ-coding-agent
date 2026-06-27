import { describe, expect } from "bun:test"
import { LLM } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { ConfigProvider, DateTime, Effect, Layer } from "effect"
import { Headers } from "effect/unstable/http"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { it } from "./lib/effect"

type Api =
  | {
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: Record<string, unknown>
    }
  | { readonly type: "native"; readonly url?: string; readonly settings: Record<string, unknown> }

const model = (api: Api, variants: ModelV2.Info["variants"] = []) =>
  new ModelV2.Info({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    name: "Test model",
    api: { id: ModelV2.ID.make("api-test-model"), ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-test": "header" },
      body: { apiKey: "secret", custom_extension: { enabled: true } },
      generation: { temperature: 0.7 },
      options: { store: false, serviceTier: "priority" },
    },
    variants,
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

describe("SessionRunnerModel", () => {
  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 100, output: 20 },
          generation: { temperature: 0.7 },
          providerOptions: { openai: { store: false, serviceTier: "priority" } },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        new ModelV2.Info({
          ...model({
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://compatible.example/v1",
            settings: { apiKey: "settings-secret", compatibility: "strict" },
          }),
          request: { headers: {}, body: {}, generation: {}, options: {} },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("lowers selected OpenAI Session variants into Responses options", () =>
    Effect.gen(function* () {
      const base = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: { "x-variant": "high" },
          body: {},
          generation: { temperature: 0.2 },
          options: { reasoningEffort: "high" },
        },
      ])
      const catalog = new ModelV2.Info({
        ...base,
        request: { ...base.request, options: { ...base.request.options, reasoningEffort: "medium" } },
      })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(prepared.body).toMatchObject({
        store: false,
        service_tier: "priority",
        temperature: 0.2,
        reasoning: { effort: "high" },
      })
      expect(prepared.body).not.toHaveProperty("reasoningEffort")
    }),
  )

  it.effect("lowers selected OpenAI-compatible Session variants into Chat options", () =>
    Effect.gen(function* () {
      const catalog = model(
        { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compatible.example/v1" },
        [
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            body: {},
            generation: {},
            options: { reasoningEffort: "high" },
          },
        ],
      )
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_compatible_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(prepared.body).toMatchObject({
        store: false,
        reasoning_effort: "high",
      })
      expect(prepared.body).not.toHaveProperty("reasoningEffort")
    }),
  )

  it.effect("rejects an explicit unavailable Session variant during model resolution", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant_unavailable"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("unknown"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const failure = yield* SessionRunnerModel.resolve(session, catalog).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.VariantUnavailableError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "unknown",
      })
    }),
  )

  it.effect("lowers selected Anthropic Session variants into Messages options", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: {},
          generation: {},
          options: { thinking: { type: "enabled", budgetTokens: 12000 } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(prepared.body).toMatchObject({
        thinking: { type: "enabled", budget_tokens: 12000 },
      })
      expect(JSON.stringify(prepared.body)).not.toContain("budgetTokens")
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("preserves environment-backed bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        new ModelV2.Info({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {}, generation: {}, options: {} },
        }),
        { type: "env", name: "TEST_PROVIDER_API_KEY" },
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth
        .apply({
          request,
          method: "POST",
          url: "https://openai.example/v1/responses",
          body: "{}",
          headers: Headers.empty,
        })
        .pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TEST_PROVIDER_API_KEY: "secret" } }))),
        )

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = new Credential.Info({
        id: Credential.ID.create(),
        integrationID: Integration.ID.make("test-provider"),
        label: "Work",
        value: new Credential.Key({ type: "key", key: "stored-secret", metadata: { tenant: "work" } }),
      })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        new ModelV2.Info({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: { apiKey: "configured-secret" }, generation: {}, options: {} },
        }),
        { type: "credential", id: credential.id, label: credential.label },
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
      expect(resolved.route.defaults.http?.body).toEqual({ tenant: "work" })
    }),
  )

  it.effect("rejects catalog APIs without a native route", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedApiError",
        providerID: "test-provider",
        modelID: "test-model",
        api: "aisdk:@ai-sdk/google",
      })
    }),
  )

  it.effect("reports whether a catalog model has a supported native route", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        ),
      ).toBe(true)
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
        ),
      ).toBe(false)
      expect(SessionRunnerModel.supported(model({ type: "native", settings: {} }))).toBe(false)
    }),
  )
})

// ---------------------------------------------------------------------------
// locationLayer — conductor-default wiring (S1.1)
// ---------------------------------------------------------------------------

// Minimal conductor model: @ai-sdk/openai-compatible so supported() returns true.
const conductorModelInfo = new ModelV2.Info({
  id: ModelV2.ID.make("qwen/qwen3-coder"),
  providerID: ProviderV2.ID.make("openrouter"),
  name: "Qwen3 Coder",
  api: {
    type: "aisdk",
    package: "@ai-sdk/openai-compatible",
    url: "https://openrouter.ai/api/v1",
    id: ModelV2.ID.make("qwen/qwen3-coder"),
    settings: { apiKey: "placeholder-key" },
  },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: { apiKey: "placeholder-key" }, generation: {}, options: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 131072, output: 8192 },
})

// Minimal mock services for locationLayer — only the paths exercised by the
// conductor-default resolution are populated; unexpected calls die loudly.
const catalogLayer = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("catalog.transform: not used in this test"),
    reload: () => Effect.die("catalog.reload: not used in this test"),
    provider: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([conductorModelInfo]),
      // Only conductor model available; no site-wide catalog default.
      available: () => Effect.succeed([conductorModelInfo]),
      default: () => Effect.succeed(undefined),
      small: () => Effect.succeed(undefined),
    },
  } as unknown as Catalog.Interface),
)

const integrationLayer = Layer.succeed(
  Integration.Service,
  Integration.Service.of({
    transform: () => Effect.die("integration.transform: not used in this test"),
    reload: () => Effect.die("integration.reload: not used in this test"),
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    connection: {
      forIntegration: () => Effect.succeed(undefined),
      key: () => Effect.die("integration.connection.key: not used in this test"),
      oauth: () => Effect.die("integration.connection.oauth: not used in this test"),
      update: () => Effect.die("integration.connection.update: not used in this test"),
      remove: () => Effect.die("integration.connection.remove: not used in this test"),
    },
    attempt: {
      status: () => Effect.die("integration.attempt.status: not used in this test"),
      complete: () => Effect.die("integration.attempt.complete: not used in this test"),
      cancel: () => Effect.die("integration.attempt.cancel: not used in this test"),
    },
  } as unknown as Integration.Interface),
)

const credentialLayer = Layer.succeed(
  Credential.Service,
  Credential.Service.of({
    all: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined),
    create: () => Effect.die("credential.create: not used in this test"),
    update: () => Effect.die("credential.update: not used in this test"),
    remove: () => Effect.die("credential.remove: not used in this test"),
  }),
)

describe("SessionRunnerModel.locationLayer", () => {
  it.effect("picks the conductor agent model when no session.model is set (S1.1 default-conductor)", () => {
    // Wire deps into locationLayer AND keep them in scope so the test body can
    // yield AgentV2.Service directly to set up the conductor default.
    const depsLayer = Layer.mergeAll(AgentV2.layer, catalogLayer, integrationLayer, credentialLayer)
    const testLayer = SessionRunnerModel.locationLayer.pipe(Layer.provideMerge(depsLayer))

    return Effect.gen(function* () {
      // Wire "conductor" as the default agent with openrouter/qwen/qwen3-coder.
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.update(AgentV2.ID.make("conductor"), (agent) => {
          agent.model = {
            id: ModelV2.ID.make("qwen/qwen3-coder"),
            providerID: ProviderV2.ID.make("openrouter"),
          }
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("conductor"))
      })

      // Session with no explicit model and no explicit agent — should resolve via
      // the default agent's model ref, not the catalog default (which is undefined).
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_conductor_default"),
        projectID: ProjectV2.ID.global,
        title: "conductor default test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(session)

      // Resolved model must carry the conductor's provider and model id.
      expect(resolved).toMatchObject({ id: "qwen/qwen3-coder", provider: "openrouter" })
    }).pipe(Effect.provide(testLayer))
  })
})
