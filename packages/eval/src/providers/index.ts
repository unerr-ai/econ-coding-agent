/**
 * Provider factory — dispatches a fixture run to the mock or real
 * OpenAI-compatible provider based on `endpoint.provider`.
 * @sem domain=eval role=provider
 */

import type { Fixture, ModelEndpoint, RunResult } from "../types.js"
import { runMock } from "./mock.js"
import { runOpenAICompat } from "./openai-compat.js"

/**
 * Runs one fixture against the given endpoint. Routes to mock or live
 * provider; catches errors and returns them as a failed RunResult so the
 * harness never aborts mid-run.
 */
export async function runFixture(fixture: Fixture, endpoint: ModelEndpoint): Promise<RunResult> {
  try {
    if (endpoint.provider === "mock") {
      return await runMock(fixture, endpoint)
    }
    return await runOpenAICompat(fixture, endpoint)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      fixtureId: fixture.id,
      tier: fixture.tier,
      modelName: endpoint.name,
      pass: false,
      output: "",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: message,
    }
  }
}
