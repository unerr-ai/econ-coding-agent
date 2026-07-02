import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  // Fullness = how much of the context WINDOW this next request will occupy, i.e.
  // input + output + reasoning tokens of the current/latest message only.
  // cache.read/write are cumulative BILLING signals (total tokens ever read from or
  // written to the prompt cache across the session) — they are NOT part of the live
  // context and must not be added here, or a long session with heavy cache reuse
  // "overflows" every turn even though the actual context in play is small.
  // `tokens.total`, when a provider populates it, may itself already fold cache
  // tokens back into input (AI-SDK v6), so it isn't trustworthy as the primary
  // signal either — it's kept only as a defensive fallback for providers that omit
  // input/output/reasoning entirely.
  const currentContext = input.tokens.input + input.tokens.output + input.tokens.reasoning
  const count = currentContext || input.tokens.total || 0

  // AC-1.8: percentage-override trigger. When cfg.compaction.threshold_pct is
  // set, fire compaction once fullness crosses that fraction of the model's
  // total context window, instead of the absolute-headroom trigger below.
  // threshold_pct is a fraction of `model.limit.context` (0..1); a value
  // outside that range is nonsensical (0 always overflows, >1 is unreachable)
  // so it's ignored and we fall back to the headroom trigger.
  const thresholdPct = input.cfg.compaction?.threshold_pct
  if (thresholdPct != null && thresholdPct > 0 && thresholdPct <= 1) {
    return count >= thresholdPct * input.model.limit.context
  }

  return count >= usable(input)
}
