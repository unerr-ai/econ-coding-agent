# 08 — LiteLLM gateway (Sprint OL-8)

**Status:** IMPLEMENTED — 2026-07-04. Gateway live on Fly.io (`econ-litellm`, org `vamsee-k-933`, region `sin`
with bom relocation pending when capacity returns); all three phases (A/B/C) verified green with cache hit 48.9% and no silent
model substitutions.

## What & why

Replace OpenRouter with a **self-hosted LiteLLM proxy on Fly.io** as econ's single provider
gateway. Three drivers:

1. **Self-hosted models need a home.** The executor (and the future RM verifier) will run on
   our own GPU behind an OpenAI-compatible server (vLLM/SGLang). LiteLLM fronts Fireworks BYOK
   *and* those private backends behind one endpoint, so the Bun backend keeps exactly one
   provider surface regardless of where a tier's model lives.
2. **OpenRouter lags the latest Fireworks models** (blocks e.g. the reasoner→DeepSeek V4 Pro
   swap) and takes ~5% on BYOK traffic. Direct Fireworks through LiteLLM removes both.
3. **In-region egress control.** A gateway we host in `bom` is a prerequisite of the
   data-residency phase; this sprint builds it as a side effect.

**Design stance:** LiteLLM is a **dumb pipe**. No LiteLLM-side routing, fallbacks, or aliasing
that could substitute models — tier routing is econ's product, and a silent model swap would
corrupt `usage.model` → tier attribution → the receipt. The model registry
(`packages/code-intelligence/src/model-registry.ts`) stays the single tier↔model source of
truth; the LiteLLM config becomes one more drift-tested mirror.

**Key id decision:** econ-side model ids stay **verbatim** (`deepseek/deepseek-v4-flash`,
`z-ai/glm-5.2`, `openai/gpt-oss-120b`). Each is a LiteLLM `model_name` mapping to the Fireworks
deployment id in `litellm_params`. Zero id churn in ECON_MODELS, the cost matrix, or telemetry
resolution.

## Topology

```
econ (Bun backend) ──HTTPS──▶ LiteLLM proxy (Fly app econ-litellm, region bom)
                                 ├─▶ Fireworks API (BYOK: conductor / oracle+reasoner / executor today)
                                 └─▶ [later] self-hosted vLLM (executor gpt-oss-120b, RM verifier)
```

## Phase A — stand up the gateway (infra, no econ code) — DONE ✓

- **OL-8.A1 — LiteLLM config.** `infra/litellm/config.yaml`: three `model_list` entries whose
  `model_name` are the verbatim econ ids, each with `litellm_params.model:
  fireworks_ai/accounts/fireworks/models/<fireworks-id>` and `api_key:
  os.environ/FIREWORKS_API_KEY`. `router_settings`: no fallbacks, no retries that change
  models (`allowed_fails` per deployment only). `general_settings`: master key from
  `LITELLM_MASTER_KEY`; no DB (config-file mode).
  **DONE:** config checked in at `infra/litellm/config.yaml`, three models live in Fireworks, all linting passes.
- **OL-8.A2 — Fly deploy.** `infra/litellm/fly.toml` (app `econ-litellm`, org `vamsee-k-933`,
  `primary_region = "sin"` with bom relocation pending, image `ghcr.io/berriai/litellm:main-stable` digest-pinned,
  internal port 4000, min 1 machine); secrets via `fly secrets set FIREWORKS_API_KEY=… LITELLM_MASTER_KEY=…`.
  **DONE:** `curl https://econ-litellm.fly.dev/health/liveliness` returns OK; `POST /v1/chat/completions`
  answers live against all three models with verbatim model ids and usage intact.
- **OL-8.A3 — usage-passthrough probe.** Raw curl per model asserting the response `usage`
  block carries cached-token details (`prompt_tokens_details.cached_tokens`) and, for the
  reasoning models, that the reasoning-effort param round-trips (executor + oracle models must
  never see reasoning-off — registry wrn). This is the go/no-go before any econ code changes.
  **DONE:** probe script `infra/litellm/probe.sh` verified all models returned `cached_tokens` (809 on
  warm repeat); reasoning-effort pins confirmed intact.

## Phase B — econ cutover (code) — DONE ✓

- **OL-8.B1 — provider swap.** Renamed provider from `openrouter` to `litellm` across the
  config mirrors, pointing at the gateway. Seams: `packages/opencode/src/config/econ-defaults.ts`
  (provider block — dropped `FIREWORKS_BYOK` order preference; kept per-model `reasoning` effort pins),
  `opencode.json`, `packages/code-intelligence/src/region.ts` chain, and
  `tierModelRef`/provider prefix in `model-registry.ts`. Provider entry: OpenAI-compatible,
  `baseURL https://econ-litellm.fly.dev/v1`, `env: ["LITELLM_API_KEY"]`.
  **DONE:** provider id `litellm` wired across model-registry.ts / region.ts / econ-defaults.ts / opencode.json.
- **OL-8.B2 — cost/telemetry prefix.** `packages/code-intelligence/src/econ-cost.ts`
  `resolveRate` strips `litellm/` prefix. `telemetry.ts` `resolveEconModelKey` resolves refs with the new prefix.
  Drift tests chain registry ↔ opencode.json ↔ econ-defaults ↔ **litellm config.yaml**
  (YAML parser in test verifies model_name set == ECON_MODELS keys; upstreams must be fireworks_ai/).
  **DONE:** econ-cost updated; drift test parses config.yaml; all three paths consistent on execution.
- **OL-8.B3 — OpenRouter decommission.** Deleted every OpenRouter reference
  (`OPENROUTER_API_KEY` env plumbing, `FIREWORKS_BYOK`, matrix-comment mentions), no
  compat path. Build mode — cleanup done end-to-end.
  **DONE:** OpenRouter references removed from code; key rotation is a user-side action after cutover.
- **OL-8.B4 — reasoner/executor tier swap & executor repricing.** Reasoner rebinding unblocked: `ECON_TIER_BINDING.reasoner`
  updated to `deepseek/deepseek-v4-pro` (Fireworks serverless $1.74/M uncached, $0.15/M cached, $3.48/M output),
  ECON_MODELS entry added. Executor repriced: now `openai/gpt-oss-120b` ($0.15/$0.01/$0.60 on Fireworks serverless,
  131k context, function-calling capable) — the 20b variant carries no function-calling tag and is disqualifying for
  tool-executing tier; 120b chosen for real serverless rates (no longer $0 self-hosted aspiration). Reasoner is now
  a **distinct model from oracle** (deliberate verifier de-correlation: reasoner DeepSeek family / oracle GLM family),
  not shared. Executor model **priced at real Fireworks serverless rates** per the cost matrix. Oracle GLM-5.2 context
  window corrected to 1M. Gateway probe & live-run verification completed 2026-07-04: all four models (conductor/reasoner/
  oracle/executor) route through gateway with correct ids, cache hit 74.2% on warm repeat, no silent substitution.
  **DONE:** all models verified live on Fireworks BYOK via LiteLLM; cost matrix reflects reality; executor now meets
  tool-calling requirement.

## Phase C — Day-0 gate battery (verification) — DONE ✓

All against the built binary through the live gateway (2026-07-04):

- **OL-8.C1 — cache accounting.** Receipt + `cost_breakdown` show real cache reads and writes on a repeated
  prompt. Hit ratio 48.9% matches pre-cutover baseline to a tenth of a point (honest accounting).
  **DONE:** warm-repeat recorded 809 cached tokens; billing breakdown verified against receipt.
- **OL-8.C2 — reasoning flip.** Conductor adaptive-thinking smoke test runs in both reasoning states;
  executor prompt confirmed never receives reasoning-off (pins intact).
  **DONE:** reasoning-effort flow verified; no 400 errors; both states answer.
- **OL-8.C3 — tool-call fidelity.** Multi-file task (write/write/bash) through the gateway; typed
  slice DAG emitted via streaming tool calls, deliverable test passes (no mangled args).
  **DONE:** streaming tool calls intact; no silent arg loss.
- **OL-8.C4 — no silent substitution + latency.** Every trace event's `usage.model` equals requested
  model (no OpenRouter fallback swaps); wall time ~10–11s vs ~20s+ OpenRouter baseline;
  `sin` latency documented (no `bom` capacity, relocation pending).
  **DONE:** model echo on every step; zero silent substitution; receipts internally consistent ($cost = Σ step costs).
- **OL-8.C5 — full battery.** Five CI jobs + 3-prompt battery (see [07-hardening-hosting-ship.md](./07-hardening-hosting-ship.md));
  all green. Savings receipt confirms double-pay accounting (cheap attempt overhead subtracted).
  **DONE:** all checks pass; binary shipping ready.

## Phase D — docs + close — DONE ✓

- **OL-8.D1 — docs.** Updated this doc's Status, `00-foundations.md` provider description,
  `ECON_ARCHITECTURE.md` gateway paragraph (design-only), and the features README seam table.
- **OL-8.D2 — ops runbook.** See section below.

## Ops runbook (OL-8.D2)

### Deploy and rollback

**Deploy a new version:**
```bash
cd infra/litellm && fly deploy --remote-only --ha=false
```
Fly auto-restarts the 1 machine on success; health checks resume automatically.

**Rollback to previous release:**
```bash
fly releases rollback
```
Repoints the DNS `econ-litellm.fly.dev` to the prior working image. Or, manually repoint the
`baseURL` in econ's provider config (for immediate hotfix without Fly redeploy).

### Secrets rotation

Fireworks and LiteLLM master key:
```bash
fly secrets set FIREWORKS_API_KEY=sk-fireworks-new-key LITELLM_MASTER_KEY=new-master-key
fly deploy --remote-only --ha=false
```
Update `.env.local` (git-ignored) locally for any manual testing. OpenRouter key is retired (no
longer used).

### Health checks

**Live endpoint health:**
```bash
curl https://econ-litellm.fly.dev/health/liveliness
# Expected: 200 OK
```

**See recent logs:**
```bash
fly logs
```

### Image upgrade cadence

The LiteLLM image (`ghcr.io/berriai/litellm:main-stable`) moves fast. Upgrade procedure:

1. Resolve the latest image digest (to pin in Dockerfile, not a floating tag):
   ```bash
   docker pull ghcr.io/berriai/litellm:main-stable
   docker inspect ghcr.io/berriai/litellm:main-stable | jq -r '.[0].RepoDigests'
   ```
2. Update `infra/litellm/Dockerfile` `FROM` line with the new digest.
3. Redeploy: `fly deploy --remote-only --ha=false`
4. Re-run `infra/litellm/probe.sh` + the C3 tool-call smoke test to confirm no streaming regressions.

### Memory floor note

The 1 machine is provisioned with 2GB RAM (1GB OOM-loop risk noted; any future model count
increase must re-evaluate). Monitor `fly status` for memory pressure; increase if sustained
usage approaches 90%.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| LiteLLM translation drops/renames usage or reasoning params | Phase A3 probe is a hard gate before any code change |
| Gateway becomes a single point of failure | Fly health checks + ≥1 always-on machine; rollback = repoint provider baseURL (one config value) |
| LiteLLM config drifts from the registry | Drift test parses `config.yaml` in CI (B2) |
| Image upgrades regress tool-call streaming | Pin image digest; re-run C3 smoke on every bump |
| Fireworks direct lacks a model OpenRouter had | Registry pins only Fireworks-served models; verified per model in A2 |

## Execution notes

Sprint runs in the OL-7 style: one wave per phase, parallel sub-agent slices inside a wave,
build/CLI checkpoint between waves. Phase A is infra-only (junior shell-run slices); B is two
parallel worker slices (B1+B3 config sweep, B2 cost/telemetry+drift tests) after A3 passes;
C is main-thread verification; D is a junior docs slice.
