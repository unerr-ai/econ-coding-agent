# S8.1 — In-region inference + data residency

**Status: SCAFFOLDED (config + module + policy shipped). Real India infra is GATED on
provisioned endpoints + credentials.**

## What we are solving

econ targets the Indian market with in-region hosting and data residency. Inference must
be routable, per tier, to India-hosted OSS endpoints, and we must be able to state and
enforce *where each class of data is allowed to travel*. Today every tier runs on global
OpenRouter (`opencode.json`); this sprint makes that **configurable** without touching the
router.

## The mechanism (three layers)

1. **Provider config** (`opencode.json`) — an in-region tier is just another OpenCode
   provider pointing at the India gateway (OpenAI-compatible), with the tier's agent
   `model` repointed at it. The template lives in the `// econ in-region inference + data
   residency (S8.1) — GATED` block in `opencode.json`. Adding it is the **only** runtime
   wiring needed once a real endpoint exists.

2. **Region module** — `packages/code-intelligence/src/region.ts` (NEW). Pure data + pure
   functions, no I/O, no deps. It holds the residency policy and the per-tier endpoint
   **fallback chain**, and resolves which endpoint a call should use given a data class.
   Exports:
   - Types: `Region` (`"in" | "global"`), `EconTier`, `DataClass`
     (`code | prompt | completion | telemetry | secret`), `ResidencyMode`
     (`strict | preferred | off`), `RegionEndpoint`, `ResidencyPolicy`, `RegionConfig`,
     `ResidencyCheck`.
   - Constants: `DEFAULT_RESIDENCY_POLICY`, `DEFAULT_REGION_CONFIG`.
   - Functions: `parseRegionConfig`, `resolveTierChain`, `checkResidency`, `selectEndpoint`.

3. **Data-residency policy** — `DEFAULT_RESIDENCY_POLICY` (mode `preferred`):

   | Data class | Allowed regions | Intent |
   |---|---|---|
   | `code` | `in` | source never leaves region |
   | `prompt` | `in` | user/agent prompts stay in region |
   | `completion` | `in` | model output stays in region |
   | `secret` | `in` | credentials never leave region |
   | `telemetry` | `in`, `global` | savings/usage metrics may aggregate globally |

   Modes: **`strict`** skips every non-compliant endpoint (returns `undefined` if none
   comply — fail closed); **`preferred`** prefers a compliant endpoint but falls back to the
   first available one (availability over residency — the right default *while in-region
   infra is gated*, so econ still runs on global today); **`off`** disables filtering.

## How fallback works

`resolveTierChain(config, tier)` orders a tier's endpoints **in-region first, then global**
(stable), unless mode is `off`. `selectEndpoint(config, tier, dataClass)` walks that ordered
chain and returns the endpoint to use — giving "prefer India, fall back to global OpenRouter"
for free, config-first, with **zero changes to `router.ts`/`model.ts`**. Today every tier's
default chain is a single global OpenRouter endpoint; provisioning India is "prepend an `in`
endpoint to the chain" (via `parseRegionConfig` over the `opencode.json` region block).

## What is GATED (and the runbook to ungate)

- A real India OSS inference endpoint (gateway URL + `ECON_IN_API_KEY`). None exists yet.
- Wiring `region.ts` into the live provider-resolution path (currently the module is a
  standalone, tested contract; the call site that asks it `selectEndpoint(...)` before each
  turn is a small main-thread integration, intentionally deferred until an endpoint exists).
- Enforcement teeth for `strict` mode at the network boundary (egress allow-list) — pairs
  with `permission.external_directory: "deny"` and `webfetch: "ask"` from S8.3.

To ungate: stand up the India gateway → add the `econ-in` provider in `opencode.json` →
point tier agents at `econ-in/<model>` → set `ECON_IN_API_KEY` → flip residency to `strict`
→ wire `selectEndpoint` into provider resolution → re-run the dogfood runbook.

## Export wiring (lead action)

`region.ts` is not yet re-exported from `packages/code-intelligence/src/index.ts` (ownership
boundary). Add the export block listed in the sprint digest.
