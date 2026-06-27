/**
 * Mock/dry-run model provider — returns canned fixture responses with
 * simulated token counts and latency so the harness runs with no API key.
 * @sem domain=eval role=provider
 */

import type { Fixture, ModelEndpoint, RunResult } from "../types.js"

/** Simulated base latency for the mock provider (ms). */
const MOCK_LATENCY_MS = 42
/** Rough mock token rate: 4 chars ≈ 1 token. */
const CHARS_PER_TOKEN = 4

/**
 * Runs a single fixture against the mock provider.
 * Returns a deterministic RunResult using the fixture's `mockResponse`.
 */
export async function runMock(fixture: Fixture, endpoint: ModelEndpoint): Promise<RunResult> {
  const start = Date.now()

  // Simulate a small async delay so harness timing is non-zero.
  await new Promise((r) => setTimeout(r, MOCK_LATENCY_MS))

  const output = fixture.mockResponse
  const latencyMs = Date.now() - start

  // Estimate token counts from character length.
  const inputTokens = Math.ceil((fixture.prompt.length + (fixture.system?.length ?? 0)) / CHARS_PER_TOKEN)
  const outputTokens = Math.ceil(output.length / CHARS_PER_TOKEN)

  const costUsd =
    (inputTokens / 1_000_000) * endpoint.pricing.inputPer1M +
    (outputTokens / 1_000_000) * endpoint.pricing.outputPer1M

  return {
    fixtureId: fixture.id,
    tier: fixture.tier,
    modelName: endpoint.name,
    pass: fixture.check(output),
    output,
    latencyMs,
    inputTokens,
    outputTokens,
    costUsd,
  }
}
