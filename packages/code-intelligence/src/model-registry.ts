/**
 * econ's model abstraction: the single source of truth binding each abstract
 * tier (conductor / executor / reasoner / oracle) to a concrete model, plus the
 * tracked capabilities that let us swap models by config instead of code —
 * context window, max output, reasoning support, BYOK cost, and the two
 * litellm-gateway routing/accounting behaviors probed per-model (cache
 * accounting, session affinity). Add a model to ECON_MODELS to make it
 * available; repoint a tier by editing ECON_TIER_BINDING. Nothing downstream
 * hard-codes a model id: the router, receipt, and loop query this registry, so
 * a model swap (e.g. gpt-oss-120b → Nemotron 3) is a one-line binding change,
 * and a capability question ("can this tier's model take a reasoning-effort
 * bump?") is a lookup, not a guess.
 *
 * @sem domain=routing role=registry
 */

import { ECON_COST_MATRIX, type EconModelRate } from "./econ-cost"
import type { EconTier } from "./region"

/**
 * Tracked capabilities for one model econ can serve. Capability fields mirror
 * econ's opencode.json (the operative config the runtime loads) and are held
 * true by a drift test; `reasoning` means econ has a reasoning channel enabled
 * for the model (so a per-call effort is settable), not merely that the model
 * family is reasoning-capable — see per-entry notes for that nuance.
 *
 * @sem domain=routing role=type
 */
export interface EconModelProfile {
  /** Provider id the model is served through (e.g. "litellm"). */
  providerID: string
  /** Provider-local model id (e.g. "deepseek/deepseek-v4-flash"); the ECON_COST_MATRIX key. */
  modelID: string
  /** Human-readable label. */
  name: string
  /** Max input context window in tokens (opencode.json limit.context). */
  contextWindow: number
  /** Max output tokens (opencode.json limit.output). */
  maxOutput: number
  /** Reasoning channel enabled in econ's opencode.json (a per-call effort is settable). */
  reasoning: boolean
  /**
   * How the served deployment accounts prompt-cache hits (probed 2026-07-04,
   * re-verified 2026-07-06 — W8 fixed the client-side gap below): "stream" =
   * cached_tokens is read off the usage payload (prompt_tokens_details.cached_tokens
   * / cache_read_input_tokens), telemetry sees real hit ratios, on BOTH the
   * streamed and non-streamed usage path — session/llm/ai-sdk.ts's usage() maps it
   * regardless of transport, so this no longer depends on which path a turn took;
   * "nonstream-only" is now reserved for a hypothetical future model whose
   * provider's own wire protocol omits the field on a streaming response
   * (a gateway/provider limitation, not a client gap — none of today's four
   * models hit this); "none" = provider does not cache this model at all
   * (identical-repeat probe returned 0 cached).
   */
  cacheAccounting: "stream" | "nonstream-only" | "none"
  /**
   * Whether econ's litellm gateway should receive the `x-session-affinity`
   * header (OL-9.2b) for this model — pins a session's successive calls to one
   * backend replica for prefix-cache locality. Probed 2026-07-06: helps some
   * models, actively breaks prompt-cache + latency on others (see per-entry
   * notes) — this is why the header must be looked up per model, never sent
   * unconditionally for the provider.
   */
  sessionAffinity: boolean
  /** BYOK rates in $/1M tokens, sourced from ECON_COST_MATRIX (its single home). */
  cost: EconModelRate
  /** Serving / provenance / capability nuance not captured by the fields above. */
  notes?: string
}

/**
 * The models econ ships, keyed by provider-local model id. This is the manifest:
 * to make a new model available (e.g. Nemotron 3) add an entry here, then point a
 * tier at it in ECON_TIER_BINDING. Capability values are held consistent with
 * opencode.json by model-registry.test.ts.
 *
 * @sem domain=routing role=config
 */
export const ECON_MODELS: Record<string, EconModelProfile> = {
  "deepseek/deepseek-v4-flash": {
    providerID: "litellm",
    modelID: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    maxOutput: 8192,
    reasoning: false,
    cacheAccounting: "stream",
    sessionAffinity: true,
    cost: ECON_COST_MATRIX["deepseek/deepseek-v4-flash"]!,
    notes: "econ conductor. Served via the econ LiteLLM gateway. No reasoning channel enabled in opencode.json (treated as a fast non-reasoning model — see OL-3.8 won't-build). Cache accounting verified live 2026-07-04: 84% hit ratio reported on stream. Thinking is explicitly disabled on the wire via opencode.json options.reasoningEffort:\"none\" (the AI-SDK camelCase config key that lowers to the wire param reasoning_effort), because this hybrid model's server-side default is thinking ON. Since 2026-07-05 the request layer un-mutes thinking adaptively — packages/opencode/src/session/llm/reasoning-gate.ts drops the key (server default ON) on plan steps and failure-recovery steps only; reasoning:false stays correct because the config-level channel remains off. Session affinity ON (OL-9.2b): a 2026-07-06 probe proved the header keeps a ~98% hop2-3 cache hit ratio via per-replica locality (3.34s → 1.83s → 1.51s) — proven beneficial for this model.",
  },
  "z-ai/glm-5.2": {
    providerID: "litellm",
    modelID: "z-ai/glm-5.2",
    name: "GLM 5.2",
    contextWindow: 1_048_576,
    maxOutput: 32768,
    reasoning: true,
    cacheAccounting: "stream",
    sessionAffinity: true,
    cost: ECON_COST_MATRIX["z-ai/glm-5.2"]!,
    notes: "econ oracle (OL-8.B4+: no longer shared with reasoner — deliberate verifier de-correlation, reasoner is now a distinct model family). Reasoning ENABLED in opencode.json (options.reasoningEffort:high, the AI-SDK camelCase config key that lowers to the wire param reasoning_effort; Fireworks returns the trace as a separate reasoning_content field, never customer-facing content); this is the think-hard tier used sparingly on the hard tail. Reasoning tokens bill at the output rate. Cached read ($0.14) is ~1/10th the input rate: keep oracle hops prefix-shared (OL-3.7). (2026-07-06): the client-side cached_tokens mapping gap is fixed (session/llm/ai-sdk.ts), so cache is now measurable — upgraded from nonstream-only. Session affinity kept ON but UNVERIFIED for this tier: the probe showed a cache hit alongside a +166% hop3 latency anomaly (1.80s → 4.79s) — provisional default, revisit after further probing.",
  },
  "deepseek/deepseek-v4-pro": {
    providerID: "litellm",
    modelID: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextWindow: 1_048_576,
    maxOutput: 32768,
    reasoning: true,
    cacheAccounting: "stream",
    sessionAffinity: false,
    cost: ECON_COST_MATRIX["deepseek/deepseek-v4-pro"]!,
    notes: "econ reasoner (OL-8.B4+, was shared glm-5.2). A distinct model family from both the conductor (DeepSeek V4 Flash) and the oracle (GLM 5.2) — deliberate verifier de-correlation. Reasoning ENABLED in opencode.json (options.reasoningEffort:high, the AI-SDK camelCase config key that lowers to the wire param reasoning_effort); hybrid reasoning family, served via the econ LiteLLM gateway. V4 Pro caches on Fireworks ($0.15/M cached vs $1.74/M uncached, ≈11.6× discount). (2026-07-06): the client-side cached_tokens mapping gap is fixed, so cache is now measurable — upgraded from nonstream-only. Session affinity OFF (OL-9.2b): that probe proved the header actively breaks this model — WITH affinity, hop2 misses cache entirely and hop3 spikes to 18.86s (678% slower); WITHOUT it, the model gets a 100% cache hit immediately on hop1 and stays consistent across hops. Opposite of flash — do not re-enable without new probe evidence. Persistent reasoner sessions remain gated on this finding (docs/architecture/ORCHESTRATION_MECHANISM.md §7.3); stateless compiled briefs (brief.ts) remain the default meanwhile.",
  },
  "openai/gpt-oss-120b": {
    providerID: "litellm",
    modelID: "openai/gpt-oss-120b",
    name: "gpt-oss-120b",
    contextWindow: 131_072,
    maxOutput: 8192,
    reasoning: true,
    cacheAccounting: "stream",
    sessionAffinity: true,
    cost: ECON_COST_MATRIX["openai/gpt-oss-120b"]!,
    notes: "econ executor (OL-8.B4+, was gpt-oss-20b — 20b carries no function-calling tag on Fireworks serverless, disqualifying it for the tool-executing tier). reasoning:true, options.reasoningEffort:low (the AI-SDK camelCase config key that lowers to the wire param reasoning_effort) — the gpt-oss family 400s with reasoning off, and it also 400s on the OpenRouter-era `reasoning` object shape (strict body validation at Fireworks). Real Fireworks serverless rate, no longer a $0 self-hosted row. Post-POC swap target: NVIDIA Nemotron 3 (OL-M.1) — add its entry and repoint the executor binding. (2026-07-06): the client-side cached_tokens mapping gap is fixed, so cache is now measurable — upgraded from nonstream-only (the executor itself wasn't in that probe's model set, but the fix is a generic client mapping, not per-model). Session affinity kept ON but UNVERIFIED — not covered by that probe (flash/glm/deepseek-pro only); provisional default, revisit after further probing.",
  },
  "minimax/minimax-m3": {
    providerID: "litellm",
    modelID: "minimax/minimax-m3",
    name: "MiniMax M3",
    contextWindow: 524_288,
    maxOutput: 64_000,
    reasoning: false,
    cacheAccounting: "stream",
    sessionAffinity: true,
    cost: ECON_COST_MATRIX["minimax/minimax-m3"]!,
    notes:
      "CONDUCTOR TIER — bound 2026-07-09 (provisional experiment; catalog-added 2026-07-08). MiniMax M3, 428B MoE (MiniMax Sparse Attention), served via the econ LiteLLM gateway on Fireworks (accounts/fireworks/models/minimax-m3) at the priority service tier. Context: the API serves up to 1M with a 512K guaranteed minimum — we pin the safe floor here (524_288); raise toward 1M when a tier binds it and the deployment confirms it. maxOutput 64_000 is the provider-payload capability, not a tuned tier cap. Thinking is ON and BOUNDED via options.reasoningEffort:\"high\" (E0, 2026-07-12): \"none\" measurably suppressed the judgment tier (a 4-6x variance driver), and OMITTING the param means unbounded server-side thinking — one step ran 2,453s before completing. Always pin an explicit effort. The registry reasoning flag stays false deliberately: no wire path keys on it for this provider (options own the wire). cacheAccounting:\"stream\" and sessionAffinity:true are defaults, UNPROBED for this model. Costs $0.30/$1.20 per M in/out, $0.06/M cached (ECON_COST_MATRIX).",
  },
  "moonshotai/kimi-k2p7-code": {
    providerID: "litellm",
    modelID: "moonshotai/kimi-k2p7-code",
    name: "Kimi K2.7 Code",
    contextWindow: 262_144,
    maxOutput: 32_768,
    reasoning: false,
    cacheAccounting: "stream",
    sessionAffinity: true,
    cost: ECON_COST_MATRIX["moonshotai/kimi-k2p7-code"]!,
    notes:
      "CATALOG — available in the gateway/registry, NOT bound to any tier (added 2026-07-08). Kimi K2.7 Code (Moonshot AI), ~1T-param MoE agentic coding model with function calling, 256K context (262_144); served via the econ LiteLLM gateway on Fireworks (accounts/fireworks/models/kimi-k2p7-code) at the priority service tier. maxOutput 32_768 from the provider payload. reasoning:false = the reasoning channel is OFF at the config level (K2.7 Code emits reasoning tokens natively — ~30% fewer than K2.6); enable it via options.reasoningEffort if/when a tier binds this model. cacheAccounting:\"stream\" and sessionAffinity:true are defaults, UNPROBED for this model. Costs $0.95/$4.00 per M in/out, $0.19/M cached (ECON_COST_MATRIX).",
  },
  "claude-opus-4-8": {
    providerID: "anthropic",
    modelID: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    contextWindow: 200_000,
    maxOutput: 32_000,
    reasoning: false,
    cacheAccounting: "stream",
    sessionAffinity: false,
    cost: ECON_COST_MATRIX["claude-opus-4-8"]!,
    notes:
      "CATALOG — gap-closure-plan §4.4 frontier-patch oracle profile (added 2026-07-19), NOT the live oracle default (ECON_TIER_BINDING.oracle stays z-ai/glm-5.2; this entry is only reachable via ECON_ORACLE_PROFILES[\"frontier-patch\"], gated behind the swap A/B). providerID is \"anthropic\" (NOT \"litellm\") deliberately: OpenCode's applyCaching gate (packages/opencode/src/provider/transform.ts:433-445) skips any model whose api.npm is \"@ai-sdk/gateway\", and every litellm tier hits that skip — the direct pathway is the chosen fix (cache_control resolution, gap-closure-plan §4.4), so this model bypasses the litellm gateway entirely and never appears in infra/litellm/config.yaml. cacheAccounting:\"stream\" because the AI SDK's anthropic package normalizes cache-read usage into inputTokenDetails.cacheReadTokens on both the streamed and non-streamed path (session/llm/ai-sdk.ts usage()), same as every other tier post-W8. sessionAffinity:false — the x-session-affinity header is litellm-gateway-specific (request.ts only sends it when providerID===\"litellm\"), so the field is inert here; false documents that rather than implying an untested default. reasoning:false — no options.reasoningEffort/thinking budget is wired yet (deferred to the live A/B, not part of this mechanism ship). Requires ANTHROPIC_API_KEY (opencode.json provider.anthropic.env). Costs $5/$25 per M in/out, cache read 0.1x ($0.5), cache write 1.25x ($6.25) — ECON_COST_MATRIX.",
  },
}

/**
 * Which model backs each abstract tier. This is the swap point: repointing a
 * tier at a different model — for a config experiment or the Nemotron swap — is
 * a one-line change here, and every consumer (router, receipt, loop) follows
 * because they resolve through tierProfile, never a literal model id.
 *
 * @sem domain=routing role=config
 */
export const ECON_TIER_BINDING: Record<EconTier, string> = {
  conductor: "minimax/minimax-m3",
  executor: "openai/gpt-oss-120b",
  reasoner: "deepseek/deepseek-v4-pro",
  oracle: "z-ai/glm-5.2",
}

/**
 * The executor tier's persona agents (OL-9.1): stateless intern shapes with a
 * job-specific system prompt and a reduced toolset, all backed by the executor
 * model. One source of truth for every consumer — agent declarations, dispatch
 * persona selection, and telemetry tier attribution all resolve through this
 * list, so adding a persona is a one-line change here plus its prompt delta.
 *
 * @sem domain=routing role=config
 */
export const ECON_PERSONAS = ["explorer", "runner", "applier", "author", "researcher", "procedure"] as const
export type EconPersona = (typeof ECON_PERSONAS)[number]

/** A model profile resolved for a specific tier. */
export interface TierProfile extends EconModelProfile {
  tier: EconTier
}

/**
 * The capability profile for one model by key, or undefined if it isn't in the
 * manifest.
 *
 * @sem domain=routing role=query
 */
export function modelProfile(key: string): EconModelProfile | undefined {
  return ECON_MODELS[key]
}

/**
 * Whether the litellm gateway's `x-session-affinity` header (OL-9.2b) should be
 * sent for the given model id. Registry-driven per the 2026-07-06 probe:
 * request.ts must never hard-code a model id, so it resolves the current turn's
 * model against this lookup instead. A model absent from ECON_MODELS (unpinned
 * / non-econ) defaults to `true` — the header's historical always-on-for-litellm
 * behavior — so an unlisted litellm model doesn't silently lose affinity.
 *
 * @sem domain=routing role=query
 */
export function sessionAffinityFor(key: string): boolean {
  return modelProfile(key)?.sessionAffinity ?? true
}

/**
 * Resolve a tier to its bound model's full capability profile. The oracle tier
 * alone resolves through the §4.4 profile surface (ECON_ORACLE_PROFILE; unset ⇒
 * "default" ⇒ byte-identical to ECON_TIER_BINDING.oracle) so a benchmark
 * campaign can rebind the oracle without touching code. Throws if the resolved
 * key is missing from the manifest — a misconfiguration that must fail loud,
 * not route to a phantom model.
 *
 * @sem domain=routing role=query
 */
export function tierProfile(tier: EconTier): TierProfile {
  const key =
    tier === "oracle" ? resolveOracleProfile(process.env["ECON_ORACLE_PROFILE"]).modelKey : ECON_TIER_BINDING[tier]
  const model = ECON_MODELS[key]
  if (!model) {
    throw new Error(`econ tier "${tier}" is bound to unknown model "${key}" — add it to ECON_MODELS`)
  }
  return { tier, ...model }
}

/**
 * The full model reference ("providerID/modelID") a tier resolves to — the form
 * opencode.json agents and the model-resolution chain expect.
 *
 * @sem domain=routing role=query
 */
export function tierModelRef(tier: EconTier): string {
  const p = tierProfile(tier)
  return `${p.providerID}/${p.modelID}`
}

/**
 * Whether a tier's bound model has a reasoning channel enabled in econ config
 * (so a per-call effort can be set). This answers the OL-3.8 question directly:
 * supportsReasoning("conductor") === false is why the budget-rung is a no-op.
 *
 * @sem domain=routing role=query
 */
export function supportsReasoning(tier: EconTier): boolean {
  return tierProfile(tier).reasoning
}

/**
 * A tier's bound model's max input context window — the ceiling the loop must
 * respect before routing a large context to this tier.
 *
 * @sem domain=routing role=query
 */
export function contextWindow(tier: EconTier): number {
  return tierProfile(tier).contextWindow
}

/**
 * The tiers a given model backs (reverse of ECON_TIER_BINDING). Lets a
 * model-keyed signal (a usage event's modelID) be mapped back to its tier(s)
 * without hard-coded string matching. As of OL-8.B4+ every tier binds a
 * distinct model (oracle/reasoner de-correlated), but the reverse lookup stays
 * multi-tier-safe should two tiers ever share a model again.
 *
 * @sem domain=routing role=query
 */
export function tiersForModel(key: string): EconTier[] {
  return (Object.keys(ECON_TIER_BINDING) as EconTier[]).filter((t) => ECON_TIER_BINDING[t] === key)
}

// ---------------------------------------------------------------------------
// OL-7.8a — optional execution-free reward-model verifier tier
// ---------------------------------------------------------------------------

/**
 * Resolved state of the OL-7.8a execution-free reward-model verifier tier.
 * Deliberately not an `EconTier` / `ECON_TIER_BINDING` member — it never
 * routes turn traffic, only scores finished work — so adding it can never
 * change the shape the tier drift tests guard.
 *
 * @sem domain=routing role=type
 */
export interface VerifierTierConfig {
  enabled: boolean
  /** The hosted RM endpoint URL. Present only when `enabled`. */
  endpoint?: string
}

/**
 * Resolve the verifier tier from `ECON_VERIFIER_RM` ("off"/unset ⇒ disabled;
 * any other value is the hosted RM endpoint URL). Off by default so every
 * existing verifier-ladder path stays byte-identical when the flag is unset —
 * consumers must check `.enabled` before reading `.endpoint`.
 *
 * @sem domain=routing role=config
 */
export function resolveVerifierTier(envValue: string | undefined): VerifierTierConfig {
  if (!envValue || envValue === "off") return { enabled: false }
  return { enabled: true, endpoint: envValue }
}

// ---------------------------------------------------------------------------
// OL-7.8 — cross-model judge rung tier
// ---------------------------------------------------------------------------

/**
 * Resolved state of the OL-7.8 cross-model judge rung: whether the judge runs
 * and which tier samples the verdict. Like `VerifierTierConfig`, deliberately
 * not an `ECON_TIER_BINDING` member — the judge scores finished work for an
 * untestable slice, it never routes turn traffic.
 *
 * @sem domain=routing role=type
 */
export interface JudgeTierConfig {
  enabled: boolean
  /** The tier whose bound model samples the verdict. Meaningful only when `enabled`. */
  tier: EconTier
}

/**
 * Resolve the judge tier from `ECON_VERIFIER_JUDGE`. ON by default — unlike the
 * OL-7.8a RM (an external endpoint that can't exist unconfigured), the judge is
 * the verification safety net for untestable slices and runs entirely on econ's
 * own tiers, so absence of config must not silently drop the rung. The default
 * tier is the reasoner: every `allocateSlice` cell that yields
 * `verification === "judge"` generates on the oracle (the high-coupling ·
 * untestable residual, and the risk-broken borderline which the same risk
 * condition raises to oracle — see allocation.ts), so the reasoner is
 * cross-family in all standard cells (§4.3 — a model self-judging its own work
 * is unreliable). `ECON_VERIFIER_JUDGE=off` disables; a valid tier name
 * overrides the tier; an unrecognized value falls back to the default rather
 * than silently disabling the safety net.
 *
 * @sem domain=routing role=config
 */
export function resolveJudgeTier(envValue: string | undefined): JudgeTierConfig {
  if (envValue === "off") return { enabled: false, tier: "reasoner" }
  if (envValue && envValue in ECON_TIER_BINDING) return { enabled: true, tier: envValue as EconTier }
  return { enabled: true, tier: "reasoner" }
}

// ---------------------------------------------------------------------------
// Gap-closure §4.3 — per-tier disable switches (the ECON_VERIFIER_JUDGE
// config-surface pattern, extended to the oracle and the judge tier)
// ---------------------------------------------------------------------------

/**
 * Resolved state of the oracle switch. Unlike `VerifierTierConfig`/
 * `FrontierHatchConfig` this DOES gate a live `ECON_TIER_BINDING` member —
 * when disabled, the oracle registry slot stays bound (re-binding stays a
 * one-line change, no re-plumbing — the models.md reversibility principle)
 * but no slice may dispatch to it: the solve ladder's ceiling caps at the
 * conductor and an unresolved slice settles loudly via the existing
 * `unverified`/`onProvenance` path, never a silent drop.
 *
 * @sem domain=routing role=type
 */
export interface OracleTierConfig {
  enabled: boolean
}

/**
 * Resolve the oracle switch from `ECON_ORACLE`. ON by default, mirroring
 * `resolveJudgeTier`'s off-by-exception shape. `ECON_ORACLE=off` disables
 * the oracle as a solve tier (degrade: conductor-only, unresolved work
 * surfaced loudly); any other value — including unset — leaves it available.
 *
 * @sem domain=routing role=config
 */
export function resolveOracleTier(envValue: string | undefined): OracleTierConfig {
  return { enabled: envValue !== "off" }
}

/**
 * Resolved state of the judge-tier switch: a master kill switch across every
 * reasoner judge duty (the cross-model verifier `ECON_VERIFIER_JUDGE` already
 * gates, plus hub-design and repro-fidelity) — narrower than disabling those
 * individually, this is the "everything judge-side is off" degrade named in
 * gap-closure §4.3. When disabled the ladder falls through to its existing
 * deterministic-only path (`runVerifierLadder`'s sound → qe → accept-
 * unverified chain, unchanged) — no new fallback logic, just the absence of
 * the judge rung.
 *
 * @sem domain=routing role=type
 */
export interface JudgeTierSwitch {
  enabled: boolean
}

/**
 * Resolve the judge-tier master switch from `ECON_JUDGE_TIER`. ON by
 * default. `ECON_JUDGE_TIER=off` disables every judge-tier duty at once
 * (degrade: deterministic gates only); any other value — including unset —
 * leaves judging available. Distinct from `resolveJudgeTier`
 * (`ECON_VERIFIER_JUDGE`), which only ever gated the cross-model verifier
 * rung inside the slice-verification ladder — this is the wider switch the
 * plan asks for, covering hub-design and repro-fidelity too. Consumers that
 * live in `session/prompt.ts` read this directly; nothing here re-plumbs
 * their call sites.
 *
 * @sem domain=routing role=config
 */
export function resolveJudgeTierSwitch(envValue: string | undefined): JudgeTierSwitch {
  return { enabled: envValue !== "off" }
}

// ---------------------------------------------------------------------------
// OL-7.10 — frontier escape-hatch for the residual
// ---------------------------------------------------------------------------

/** The OL-7.10 frontier escape-hatch modes — `off` is the default, no-op state. */
export type FrontierHatchMode = "off" | "api" | "human"

/**
 * Resolved state of the OL-7.10 frontier escape-hatch. Not an `EconTier` /
 * `ECON_TIER_BINDING` member for the same reason as `VerifierTierConfig` — it
 * is a config-gated override at resolution time, not a routed tier.
 *
 * @sem domain=routing role=type
 */
export interface FrontierHatchConfig {
  mode: FrontierHatchMode
}

/**
 * Resolve the frontier escape-hatch from `ECON_FRONTIER_HATCH` ("off"/unset,
 * "api", or "human"). Off by default; an unrecognized value fails safe to
 * "off" rather than silently routing to a frontier price.
 *
 * @sem domain=routing role=config
 */
export function resolveFrontierHatch(envValue: string | undefined): FrontierHatchConfig {
  if (envValue === "api" || envValue === "human") return { mode: envValue }
  return { mode: "off" }
}

/**
 * Resolve a tier's model reference honoring the OL-7.10 hatch: "off" (the
 * default) is byte-identical to `tierModelRef`; "api" overrides the
 * reference with an explicit frontier model id (no default — unpinned until
 * an eval selects one, injected by the caller rather than hard-coded here,
 * same as the OL-7.8a RM endpoint); "human" returns undefined (no model call
 * — the slice hands off to a human reviewer instead).
 *
 * @sem domain=routing role=query
 */
export function resolveTierModelRef(
  tier: EconTier,
  hatch: FrontierHatchConfig,
  frontierModelId?: string,
): string | undefined {
  if (hatch.mode === "human") return undefined
  if (hatch.mode === "api") return frontierModelId
  return tierModelRef(tier)
}

// ---------------------------------------------------------------------------
// gap-closure-plan §4.4 — per-surface oracle binding profiles
// ---------------------------------------------------------------------------

/**
 * Named oracle-binding profiles (gap-closure-plan §4.4): which ECON_MODELS key
 * backs the oracle tier for a given run surface. "default" and "sovereign" (the
 * all-open-weight in-region lane) both resolve to today's live oracle;
 * "frontier-patch" is the externally-graded evaluation arm, bound to the
 * direct-to-Anthropic Opus entry. This is the manifest ECON_ORACLE_PROFILE
 * selects over — like ECON_TIER_BINDING, a swap is a one-line change here, not
 * a code change at any call site.
 *
 * @sem domain=routing role=config
 */
export const ECON_ORACLE_PROFILES: Record<string, string> = {
  // "default" follows the live binding referentially (one home per fact);
  // "sovereign" stays a literal pin — it must remain the open-weight model
  // even after a future default swap to a frontier oracle.
  default: ECON_TIER_BINDING.oracle,
  "frontier-patch": "claude-opus-4-8",
  sovereign: "z-ai/glm-5.2",
}

/**
 * Resolved state of the gap-closure-plan §4.4 oracle-profile selection: the
 * profile name that resolved (falling back to "default" on an unrecognized
 * value) and the ECON_MODELS key it points at.
 *
 * @sem domain=routing role=type
 */
export interface OracleProfileConfig {
  profile: string
  modelKey: string
}

/**
 * Resolve the oracle-binding profile from `ECON_ORACLE_PROFILE` — the ONE
 * sanctioned selection surface for the gap-closure-plan §4.4 oracle swap (no
 * ad-hoc env reads elsewhere). Mirrors resolveJudgeTier's shape: unset or an
 * unrecognized value falls back to "default" (today's live binding,
 * byte-identical — ECON_TIER_BINDING.oracle is untouched by this mechanism)
 * rather than silently routing to a phantom profile. `tierProfile("oracle")` is
 * the one live consumer — setting ECON_ORACLE_PROFILE rebinds the oracle for a
 * run; the default-binding swap itself waits on the A/B.
 *
 * @sem domain=routing role=config
 */
export function resolveOracleProfile(envValue: string | undefined): OracleProfileConfig {
  const profile = envValue && envValue in ECON_ORACLE_PROFILES ? envValue : "default"
  return { profile, modelKey: ECON_ORACLE_PROFILES[profile]! }
}
