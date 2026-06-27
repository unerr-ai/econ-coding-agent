/**
 * Integration tests: locationLayerWith + S3.2 risk-escalation router.
 *
 * Verifies that locationLayer routes a high-risk turn to the oracle model and a
 * low-risk turn to the conductor model when a stub risk provider is injected.
 * No live model calls are made.
 */

import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
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

// ---------------------------------------------------------------------------
// Fixture models
// ---------------------------------------------------------------------------

const makeModel = (id: string, providerID: string) =>
  new ModelV2.Info({
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(providerID),
    name: `Test ${id}`,
    api: {
      type: "aisdk",
      package: "@ai-sdk/openai-compatible",
      url: "https://openrouter.ai/api/v1",
      id: ModelV2.ID.make(id),
      settings: { apiKey: "test-key" },
    },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { apiKey: "test-key" }, generation: {}, options: {} },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 131072, output: 8192 },
  })

const conductorModelInfo = makeModel("qwen/qwen3-coder", "openrouter")
const oracleModelInfo = makeModel("deepseek/deepseek-r1", "openrouter")

// ---------------------------------------------------------------------------
// Stub service layers (mirror the S1.1 test setup)
// ---------------------------------------------------------------------------

/** Catalog serving both conductor and oracle models. */
const bothModelsLayer = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("catalog.transform: not used"),
    reload: () => Effect.die("catalog.reload: not used"),
    provider: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([conductorModelInfo, oracleModelInfo]),
      available: () => Effect.succeed([conductorModelInfo, oracleModelInfo]),
      default: () => Effect.succeed(undefined),
      small: () => Effect.succeed(undefined),
    },
  } as unknown as Catalog.Interface),
)

const integrationLayer = Layer.succeed(
  Integration.Service,
  Integration.Service.of({
    transform: () => Effect.die("not used"),
    reload: () => Effect.die("not used"),
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    connection: {
      forIntegration: () => Effect.succeed(undefined),
      key: () => Effect.die("not used"),
      oauth: () => Effect.die("not used"),
      update: () => Effect.die("not used"),
      remove: () => Effect.die("not used"),
    },
    attempt: {
      status: () => Effect.die("not used"),
      complete: () => Effect.die("not used"),
      cancel: () => Effect.die("not used"),
    },
  } as unknown as Integration.Interface),
)

const credentialLayer = Layer.succeed(
  Credential.Service,
  Credential.Service.of({
    all: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined),
    create: () => Effect.die("not used"),
    update: () => Effect.die("not used"),
    remove: () => Effect.die("not used"),
  }),
)

/** Blank session used by all routing tests. */
const makeSession = (id: string) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make(id),
    projectID: ProjectV2.ID.global,
    title: "router test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/project") },
  })

// ---------------------------------------------------------------------------
// Helper: build a testLayer for a given constant risk score
// ---------------------------------------------------------------------------

const makeTestLayer = (risk: number) => {
  const stubRiskProvider: SessionRunnerModel.RiskProvider = () => Effect.succeed(risk)
  const depsLayer = Layer.mergeAll(AgentV2.layer, bothModelsLayer, integrationLayer, credentialLayer)
  return SessionRunnerModel.locationLayerWith({ riskProvider: stubRiskProvider }).pipe(
    Layer.provideMerge(depsLayer),
  )
}

// ---------------------------------------------------------------------------
// Helpers: wire both conductor and oracle agents inside a test
// ---------------------------------------------------------------------------

function* wireAgents(agents: AgentV2.Interface) {
  yield* agents.transform((editor) => {
    editor.update(AgentV2.ID.make("conductor"), (a) => {
      a.model = { id: ModelV2.ID.make("qwen/qwen3-coder"), providerID: ProviderV2.ID.make("openrouter") }
      a.mode = "primary"
    })
    editor.update(AgentV2.ID.make("oracle"), (a) => {
      a.model = { id: ModelV2.ID.make("deepseek/deepseek-r1"), providerID: ProviderV2.ID.make("openrouter") }
      a.mode = "primary"
    })
    editor.default(AgentV2.ID.make("conductor"))
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionRunnerModel.locationLayerWith — S3.2 risk router", () => {
  it.effect("routes a low-risk turn (risk=10) to the conductor model", () => {
    const testLayer = makeTestLayer(10)

    return Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* wireAgents(agents)

      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(makeSession("ses_low_risk"))

      // Risk=10 < deescalateBelow=40 → conductor
      expect(resolved).toMatchObject({ id: "qwen/qwen3-coder", provider: "openrouter" })
    }).pipe(Effect.provide(testLayer))
  })

  it.effect("routes a high-risk turn (risk=85) to the oracle model", () => {
    const testLayer = makeTestLayer(85)

    return Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* wireAgents(agents)

      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(makeSession("ses_high_risk"))

      // Risk=85 > escalateAbove=70 → oracle
      expect(resolved).toMatchObject({ id: "deepseek/deepseek-r1", provider: "openrouter" })
    }).pipe(Effect.provide(testLayer))
  })

  it.effect("degrade-open: no risk provider → conductor (risk=0)", () => {
    // locationLayerWith({}) = default degrade-open layer
    const depsLayer = Layer.mergeAll(AgentV2.layer, bothModelsLayer, integrationLayer, credentialLayer)
    const testLayer = SessionRunnerModel.locationLayerWith({}).pipe(Layer.provideMerge(depsLayer))

    return Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* wireAgents(agents)

      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(makeSession("ses_degrade_open"))

      // Default risk=0 → conductor
      expect(resolved).toMatchObject({ id: "qwen/qwen3-coder", provider: "openrouter" })
    }).pipe(Effect.provide(testLayer))
  })

  it.effect("explicit session.model overrides the router entirely", () => {
    // High risk, but session.model forces conductor — router must not interfere.
    const testLayer = makeTestLayer(95)

    return Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* wireAgents(agents)

      const sessionWithModel = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_explicit_model"),
        projectID: ProjectV2.ID.global,
        title: "explicit model override",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
        model: { id: ModelV2.ID.make("qwen/qwen3-coder"), providerID: ProviderV2.ID.make("openrouter") },
      })

      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(sessionWithModel)

      // session.model always wins regardless of risk
      expect(resolved).toMatchObject({ id: "qwen/qwen3-coder", provider: "openrouter" })
    }).pipe(Effect.provide(testLayer))
  })

  it.effect("unconfigured oracle agent falls back to conductor (S1.1 chain)", () => {
    // Risk=85 (should route oracle), but oracle agent has NO model configured.
    // Must fall back to S1.1 chain → conductor's default agent model.
    const stubRiskProvider: SessionRunnerModel.RiskProvider = () => Effect.succeed(85)
    const depsLayer = Layer.mergeAll(AgentV2.layer, bothModelsLayer, integrationLayer, credentialLayer)
    const testLayer = SessionRunnerModel.locationLayerWith({ riskProvider: stubRiskProvider }).pipe(
      Layer.provideMerge(depsLayer),
    )

    return Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      // Wire conductor only; oracle agent exists but has NO model.
      yield* agents.transform((editor) => {
        editor.update(AgentV2.ID.make("conductor"), (a) => {
          a.model = { id: ModelV2.ID.make("qwen/qwen3-coder"), providerID: ProviderV2.ID.make("openrouter") }
          a.mode = "primary"
        })
        editor.default(AgentV2.ID.make("conductor"))
        // oracle agent is NOT updated — no model set
      })

      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(makeSession("ses_no_oracle"))

      // Oracle agent has no model → falls back to session.agent (undefined) →
      // agents.resolve(undefined) → default agent (conductor) → conductor model
      expect(resolved).toMatchObject({ id: "qwen/qwen3-coder", provider: "openrouter" })
    }).pipe(Effect.provide(testLayer))
  })
})
