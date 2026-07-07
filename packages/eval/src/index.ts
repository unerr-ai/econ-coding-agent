/**
 * CLI entrypoint for the econ eval harness.
 *
 * Usage:
 *   bun run packages/eval/src/index.ts --dry-run          # mock provider, no key needed
 *   bun run packages/eval/src/index.ts                    # reads LITELLM_API_KEY env var
 *
 * Exit code 0 = at least one model passed every fixture in every tier.
 * Exit code 1 = one or more tiers have no passing model (or a flag error).
 * @sem domain=eval role=entrypoint
 */

import { FIXTURES } from "./fixtures.js"
import { mockTierConfig, runHarness, type TierConfig } from "./harness.js"
import { renderReport } from "./scorer.js"
import type { Tier } from "./types.js"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")

/**
 * Builds a live TierConfig from environment variables.
 * Each tier reads ECON_<TIER>_BASE_URL, ECON_<TIER>_MODEL, and LITELLM_API_KEY.
 * Falls back to mock if no key is set.
 */
function buildLiveConfig(): TierConfig {
  const apiKey = process.env["LITELLM_API_KEY"] ?? process.env["OPENAI_API_KEY"]

  function endpointForTier(tier: Tier, defaultModel: string, defaultPrice: { inputPer1M: number; outputPer1M: number }) {
    const tierUpper = tier.toUpperCase()
    const baseURL =
      process.env[`ECON_${tierUpper}_BASE_URL`] ??
      process.env["ECON_BASE_URL"] ??
      "https://econ-litellm.fly.dev/v1"
    const model =
      process.env[`ECON_${tierUpper}_MODEL`] ?? defaultModel

    return {
      name: model,
      baseURL,
      model,
      apiKey,
      provider: (apiKey ? "openai-compat" : "mock") as "openai-compat" | "mock",
      pricing: defaultPrice,
    }
  }

  return {
    conductor: [
      endpointForTier("conductor", "qwen/qwen3-32b", { inputPer1M: 0.9, outputPer1M: 0.9 }),
    ],
    executor: [
      endpointForTier("executor", "qwen/qwen2.5-coder-32b-instruct", { inputPer1M: 0.2, outputPer1M: 0.2 }),
    ],
    oracle: [
      endpointForTier("oracle", "qwen/qwen3-8b", { inputPer1M: 0.1, outputPer1M: 0.1 }),
    ],
  }
}

async function main() {
  const config: TierConfig = dryRun ? mockTierConfig() : buildLiveConfig()

  if (dryRun) {
    console.log("Running in DRY-RUN mode — using mock provider (no API key required).\n")
  } else {
    const hasKey = !!(process.env["LITELLM_API_KEY"] ?? process.env["OPENAI_API_KEY"])
    if (!hasKey) {
      console.warn(
        "WARNING: No API key found (LITELLM_API_KEY / OPENAI_API_KEY). " +
          "Falling back to mock provider. Use --dry-run to suppress this warning.\n",
      )
    }
  }

  const shortlist = await runHarness(FIXTURES, config)
  const report = renderReport(shortlist, dryRun)
  console.log(report)

  // Exit 1 if any tier has zero models with 100% pass rate.
  const tiers = ["conductor", "executor", "oracle"] as Tier[]
  const anyTierFailing = tiers.some((tier) => {
    const scores = shortlist[tier]
    return scores.length > 0 && !scores.some((s) => s.passRate === 1)
  })

  process.exit(anyTierFailing ? 1 : 0)
}

main().catch((err) => {
  console.error("eval harness fatal error:", err)
  process.exit(2)
})
