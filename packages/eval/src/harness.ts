/**
 * Eval harness — runs each fixture against its tier's configured model
 * endpoint, collects RunResults, and returns a scored shortlist.
 * @sem domain=eval role=harness
 */

import type { Fixture, ModelEndpoint, RunResult, ScoredShortlist, Tier } from "./types.js"
import { runFixture } from "./providers/index.js"
import { score } from "./scorer.js"

/** One candidate model per tier. Add more entries to evaluate multiple candidates simultaneously. */
export interface TierConfig {
  conductor: ModelEndpoint[]
  executor: ModelEndpoint[]
  oracle: ModelEndpoint[]
}

/**
 * Builds a TierConfig where every tier uses the mock provider — useful
 * as a base config for dry-run mode.
 */
export function mockTierConfig(overrides?: Partial<TierConfig>): TierConfig {
  const mockEndpoint = (tier: Tier, modelName: string): ModelEndpoint => ({
    name: modelName,
    baseURL: "http://localhost:11434/v1",
    model: modelName,
    provider: "mock",
    pricing: { inputPer1M: 0.9, outputPer1M: 0.9 },
  })

  return {
    conductor: [mockEndpoint("conductor", "qwen3-32b [mock]")],
    executor: [mockEndpoint("executor", "qwen-coder-32b [mock]")],
    oracle: [mockEndpoint("oracle", "qwen3-8b [mock]")],
    ...overrides,
  }
}

/**
 * Runs all fixtures against the matching-tier endpoints in config.
 * Fixtures whose tier has no configured endpoint are skipped.
 * Each fixture is run against every endpoint in the tier (to compare candidates).
 */
export async function runHarness(fixtures: Fixture[], config: TierConfig): Promise<ScoredShortlist> {
  const allResults: RunResult[] = []

  const tierFixtures = (tier: Tier) => fixtures.filter((f) => f.tier === tier)

  const runs: Promise<RunResult>[] = []

  for (const tier of ["conductor", "executor", "oracle"] as Tier[]) {
    const endpoints = config[tier]
    const tierTasks = tierFixtures(tier)
    for (const endpoint of endpoints) {
      for (const fixture of tierTasks) {
        runs.push(runFixture(fixture, endpoint))
      }
    }
  }

  const results = await Promise.all(runs)
  allResults.push(...results)

  return score(allResults)
}
