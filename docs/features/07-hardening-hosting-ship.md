# Feature: Hardening, in-region hosting & ship

Sprint 8 hardens econ for a real customer session: safe permission/sandbox defaults and
a config-first model-fallback chain (no router code changes), plus a config-first
in-region inference module (`region.ts`) that resolves per-tier India-hosted endpoints
and enforces data residency by data class. It also ships a single self-contained Bun
binary as the "one deployment" packaging target, and closes with the procedure to
dogfood econ on a real repo with live OSS models and the GA-readiness checklist (gates
A–F) that decides go/no-go. Most of this is config- and module-level and buildable
today; the parts that need real India infra, live keys, or a customer repo are marked
GATED throughout.

---

## Shared mechanism: `region.ts` — residency policy + fallback chain

Both [Hardening §2 model fallback](#2-model-fallback) and
[In-region inference](#in-region-inference--data-residency-s81) depend on one module,
stated once here:

`packages/code-intelligence/src/region.ts` (NEW) — pure data + pure functions, no I/O,
no deps.

- **Types:** `Region` (`"in" | "global"`), `EconTier`, `DataClass`
  (`code | prompt | completion | telemetry | secret`), `ResidencyMode`
  (`strict | preferred | off`), `RegionEndpoint`, `ResidencyPolicy`, `RegionConfig`,
  `ResidencyCheck`.
- **Constants:** `DEFAULT_RESIDENCY_POLICY`, `DEFAULT_REGION_CONFIG`.
- **Functions:** `parseRegionConfig`, `resolveTierChain`, `checkResidency`,
  `selectEndpoint`.

**Fallback chain.** `resolveTierChain(config, tier)` orders a tier's endpoints
**in-region first, then global** (stable ordering), unless mode is `off`.
`selectEndpoint(config, tier, dataClass)` walks that ordered chain and returns the
endpoint to use — "prefer India, fall back to global OpenRouter" for free, config-first,
with **zero changes to `router.ts`/`model.ts`**. Today every tier's default chain is a
single global OpenRouter endpoint; provisioning India is "prepend an `in` endpoint to
the chain" via `parseRegionConfig` over the `opencode.json` region block.

**Residency policy.** `DEFAULT_RESIDENCY_POLICY` (mode `preferred`):

| Data class | Allowed regions | Intent |
|---|---|---|
| `code` | `in` | source never leaves region |
| `prompt` | `in` | user/agent prompts stay in region |
| `completion` | `in` | model output stays in region |
| `secret` | `in` | credentials never leave region |
| `telemetry` | `in`, `global` | savings/usage metrics may aggregate globally |

Modes: **`strict`** skips every non-compliant endpoint (returns `undefined` if none
comply — fail closed); **`preferred`** prefers a compliant endpoint but falls back to
the first available one (availability over residency — the right default *while
in-region infra is gated*, so econ still runs on global today); **`off`** disables
filtering.

**Enforcement pairing.** `strict` mode's network-boundary teeth pair with
`permission.external_directory: "deny"` and `permission.webfetch: "ask"` (see
[Hardening §1](#1-safe-permission--sandbox-defaults)) — the residency promise is
policy + module today, egress allow-list enforcement is GATED.

### Request routing (region.ts in the path)

```
per-tier call
     │
     ▼
opencode.json region block ──▶ parseRegionConfig ──▶ RegionConfig
     │
     ▼
resolveTierChain(config, tier)
     │   orders endpoints: in-region first, then global (unless mode=off)
     ▼
checkResidency(dataClass, endpoint.region, policy)
     │   strict  → fail closed if non-compliant
     │   preferred → prefer compliant, else first available
     │   off     → no filtering
     ▼
selectEndpoint(config, tier, dataClass) ──▶ RegionEndpoint
     │
     ▼
in-region endpoint (India)  ── or, until provisioned ──▶  global OpenRouter
```

---

## Hardening & safe defaults [S8.3]

**Status: BUILT** (safe permission defaults + `small_model` + config-first fallback
shipped). **Runtime auto-failover code hook + upstream cherry-pick triage documented as
GATED.**

### 1. Safe permission / sandbox defaults

OpenCode's permission model lives in `packages/core/src/v1/config/permission.ts`. Keys:
`read, edit, glob, grep, list, bash, task, external_directory, todowrite, question,
webfetch, websearch, lsp, doom_loop, skill`. Actions: `ask | allow | deny`. A key may
also be an **object** of `pattern → action` (used for `bash`). Precedence is
**last-match-wins** (`findLast` in `packages/opencode/src/permission/index.ts`), so a
wildcard must come *first* and specific overrides *after* it.

We added a hardened `permission` block to `opencode.json`:

- **Read-only tools allowed** (low risk, high friction if gated): `read, list, glob,
  grep, lsp, todowrite, question`.
- **`task: allow`** — sub-agent delegation is core to econ's multi-tier routing.
- **Mutation gated**: `edit: "ask"` — every file write asks. (The in-loop governance
  gate is advisory; `ask` is the belt-and-suspenders safe default.)
- **Network gated**: `webfetch: "ask"`, `websearch: "ask"` — egress is opt-in.
- **Out-of-project denied**: `external_directory: "deny"` — directly serves S8.1 data
  residency (the agent cannot read/write outside the project tree). `doom_loop: "ask"`,
  `skill: "ask"`.
- **`bash`** as a pattern object: `"*": "ask"` (every command asks by default), with
  read-only conveniences allowed after (`ls *`, `cat *`, `pwd`, `git status/diff/log`)
  and destructive patterns denied after (`sudo *`, `rm -rf *`, `rm -fr *`); `git push*`,
  `curl *`, `wget *` explicitly `ask`. Ordering relies on the last-match-wins rule above.

These are deliberately **strict GA defaults** — loosen per project as trust builds
(e.g. move common safe commands to `allow`). The `fewer-permission-prompts` flow can
refine the bash allow-list from real transcripts later.

> Note: OpenCode has no separate "sandbox" engine to configure; the permission layer
> *is* the sandbox surface (plus `external_directory` for filesystem scoping). There is
> an experimental sandbox stub under `server/routes/.../experimental.ts` — not a stable
> config knob, intentionally left untouched.

### 2. Model fallback

**Approach: config-first, no router/model code changes.** OpenCode has **no native
per-model failover field** (verified: `provider.ts`/config schema expose `model`,
`small_model`, `provider` overrides, `disabled/enabled_providers` — no `fallback`).

What we shipped:

- **`small_model: "openrouter/qwen/qwen3-8b"`** in `opencode.json` — pins incidental
  work (title generation, summaries) to the cheapest tier so housekeeping never pays
  conductor/oracle rates and degrades gracefully.
- **Per-tier fallback chain in `region.ts`** (see
  [Shared mechanism](#shared-mechanism-regionts--residency-policy--fallback-chain)
  above) — each tier has an ordered endpoint chain (in-region preferred → global
  OpenRouter fallback), resolved by `selectEndpoint`. This is the config-level
  "fallback chain" — data, not code.
- The always-available baseline today is the `openrouter` provider; every tier
  resolves to it, so there is no single-model single-point-of-failure beyond
  OpenRouter itself.

**GATED (did NOT build — would touch protected files):** *runtime* auto-failover
(catch a 5xx/timeout from the primary model and transparently retry the next endpoint
in the chain). That needs a minimal wrapper at the provider call site; per the sprint
guardrails we did **not** modify `model.ts`/`router.ts`/`registry.ts`. Recommended
minimal design when we do it: a thin retry shim that, on a retryable provider error,
calls `selectEndpoint` for the next chain entry — isolated in its own module, wrapping
the provider, not edited into the router. Flagged for the lead.

### 3. Fork hygiene (continues S0.6)

- **Remotes:** `origin → github.com/unerr-ai/econ-coding-agent`,
  `upstream → github.com/anomalyco/opencode`.
- **Base lineage:** `packages/opencode` is at version **1.17.9**; econ work sits on top
  of the OpenCode tree (HEAD `0fddf4552`, "feat(wave3): S4 executors+specialists, S6
  governance gate+memory, S7 proof surface").
- **Divergence (econ-specific surface, all additive):** `packages/code-intelligence/*`
  (the transplanted engine — risk/router/governance/telemetry/region), `opencode.json`
  (tiers, providers, permissions), `docs/sprint*`, `script/build-econ-binary.ts`. We
  have **not** forked `model.ts`/`router.ts`/`registry.ts` upstream files for econ
  behavior — the engine lives in its own package, which keeps merge surface minimal.
- **Cherry-pick triage (GATED on a fetch — network):** `upstream/main` is configured
  but not fetched into this checkout, so the exact ahead/behind counts can't be
  computed offline. Runbook:
  ```
  git fetch upstream
  git log --oneline HEAD..upstream/main          # upstream commits we lack
  git log --oneline --since="<fork date>" upstream/main -- packages/opencode/src/provider \
        packages/opencode/src/session                # security/provider fixes worth pulling
  ```
  Pull **security fixes, provider/auth fixes, and TUI fixes** by cherry-pick; **avoid**
  pulling refactors that touch files we extend, to keep our additive surface clean. Pin
  the base (record the merged upstream SHA) after each sync.

---

## In-region inference & data residency [S8.1]

**Status: SCAFFOLDED** (config + module + policy shipped). **Real India infra is GATED
on provisioned endpoints + credentials.**

### What we are solving

econ targets the Indian market with in-region hosting and data residency. Inference
must be routable, per tier, to India-hosted OSS endpoints, and we must be able to state
and enforce *where each class of data is allowed to travel*. Today every tier runs on
global OpenRouter (`opencode.json`); this sprint makes that **configurable** without
touching the router.

### The mechanism (three layers)

1. **Provider config** (`opencode.json`) — an in-region tier is just another OpenCode
   provider pointing at the India gateway (OpenAI-compatible), with the tier's agent
   `model` repointed at it. The template lives in the `// econ in-region inference +
   data residency (S8.1) — GATED` block in `opencode.json`. Adding it is the **only**
   runtime wiring needed once a real endpoint exists.
2. **Region module** — `region.ts`, its types/constants/functions, and the
   `DEFAULT_RESIDENCY_POLICY` table are described once in
   [Shared mechanism](#shared-mechanism-regionts--residency-policy--fallback-chain)
   above — see that section for the full policy table and fallback-chain mechanics.
3. **Data-residency policy** — see the table in
   [Shared mechanism](#shared-mechanism-regionts--residency-policy--fallback-chain).

### What is GATED (and the runbook to ungate)

- A real India OSS inference endpoint (gateway URL + `ECON_IN_API_KEY`). None exists
  yet.
- Wiring `region.ts` into the live provider-resolution path (currently the module is a
  standalone, tested contract; the call site that asks it `selectEndpoint(...)` before
  each turn is a small main-thread integration, intentionally deferred until an
  endpoint exists).
- Enforcement teeth for `strict` mode at the network boundary (egress allow-list) —
  pairs with `permission.external_directory: "deny"` and `webfetch: "ask"` from
  [Hardening §1](#1-safe-permission--sandbox-defaults).

To ungate: stand up the India gateway → add the `econ-in` provider in `opencode.json`
→ point tier agents at `econ-in/<model>` → set `ECON_IN_API_KEY` → flip residency to
`strict` → wire `selectEndpoint` into provider resolution → re-run the
[dogfood runbook](#dogfood-runbook-s84).

### Export wiring (lead action)

`region.ts` is not yet re-exported from `packages/code-intelligence/src/index.ts`
(ownership boundary). Add the export block listed in the sprint digest.

---

## Packaging — one deployment [S8.2]

**Status: BUILT + VERIFIED.** A single self-contained backend binary is producible
today.

### Goal

Ship the econ backend as **one process / one artifact** — no Node runtime, no
per-file source tree — using Bun's `bun build --compile`.

### What exists

`packages/opencode/script/build.ts` already compiles standalone binaries via
`Bun.build({ compile: {...} })` for every platform. Flags: `--single` (current
platform only), `--baseline`, `--skip-install`, `--sourcemaps`, `--skip-embed-web-ui`.
It runs a `--version` smoke test when building for the current platform. Output:
`packages/opencode/dist/<name>/bin/opencode`.

### New: `script/build-econ-binary.ts`

A thin econ wrapper (`script/build-econ-binary.ts`, NEW) that delegates to the
existing build with `--single --skip-install`, locates the produced binary, and
prints a one-process summary. `--skip-install` is mandatory in our workflow (we must
not run `bun install`); it relies on already-present platform deps. Passes through
`--baseline` / `--sourcemaps`.

```
bun run script/build-econ-binary.ts            # current platform, one binary
bun run script/build-econ-binary.ts --baseline # add baseline (non-AVX2) variant
```

### Verified build result (this sprint, darwin-arm64)

| Item | Result |
|---|---|
| Command | `bun run script/build.ts --single --skip-install` |
| Outcome | **SUCCESS** (~12s) |
| Binary | `packages/opencode/dist/opencode-darwin-arm64/bin/opencode` |
| Size | 124 MB, self-contained, executable |
| Smoke test (`--version`) | **PASSED** (`0.0.0-main-202606271731`) |
| `packages/sdk` dirtied | No |

The backend runs as **one self-contained process — no Node runtime required**. Note
the architecture's **unerr-brain stays a separate Node sidecar** (`unerrd` +
per-repo proxy, native addons over UDS); "one deployment" here means the *backend*
is one binary, not that the brain is folded into it. Folding the brain in is out of
scope (native addons can't `--compile` cleanly).

### tree-sitter `.wasm` bundling verdict (the day-0 question)

**Verdict: the tree-sitter `.wasm` grammars do NOT bundle into a `--compile` binary
today, and that is currently fine because the code runs on the regex fallback.**

Evidence and reasoning:

- **No `.wasm` embeds in the produced binary.** `find dist -name '*.wasm'` after a
  successful build returned **nothing**.
- **Current real state = regex fallback.**
  `packages/code-intelligence/src/tree-sitter-loader.ts` does a *dynamic*
  `import("web-tree-sitter")` and resolves grammars at **runtime** via
  `import.meta.resolve("tree-sitter-wasms/out/<grammar>.wasm")`, with a graceful
  fallback to the regex extractor. The grammar package **`tree-sitter-wasms` is NOT
  installed** (`web-tree-sitter` core *is* installed locally). So AST extraction
  already runs on the regex path — the compiled binary inherits that and works.
- **Why wasm would not bundle even if installed.** `bun build --compile` embeds
  *statically imported* assets into the `bunfs`. The loader resolves grammar paths as
  **runtime strings** (`import.meta.resolve(...)` → a `node_modules` filesystem path)
  and calls `Language.load(path)`. Inside a standalone binary that `node_modules`
  path does not exist, so the load fails and the code falls back to regex.
  `web-tree-sitter`'s own runtime `tree-sitter.wasm` (loaded by `TS.init()`) has the
  same problem.

**To make WASM work inside a `--compile` binary (GATED, future):**

1. `bun add web-tree-sitter tree-sitter-wasms` in `packages/code-intelligence`.
2. Change the loader from runtime `import.meta.resolve` path-strings to **static**
   `import grammarTs from "tree-sitter-wasms/out/tree-sitter-typescript.wasm"` style
   imports so Bun embeds each grammar into `bunfs` — then hand the embedded bytes to
   `Language.load`. Same treatment for `web-tree-sitter`'s runtime `tree-sitter.wasm`.
3. Re-build with `--single` and re-check `find dist -name '*.wasm'` (or, with
   embedding, confirm via a parse smoke test that `wasmAvailable === true`).

This is deferred: the regex extractor is sufficient for current routing/risk signals,
and the binary ships and runs without it. Tracked here as the upgrade path, not a
blocker.

---

## Dogfood runbook [S8.4]

**Status: GATED on live models + a customer repo.** This is the procedure to run
once those exist. Dogfooding = run econ on a real repo with live OSS models and
measure that it matches Claude Code / Cursor capability at a fraction of the cost.

### Preconditions (must be true before a dogfood session)

- [ ] `OPENROUTER_API_KEY` (or `ECON_IN_API_KEY` once in-region is live) is set and has
      quota.
- [ ] A real target repo (ideally an existing customer's) checked out locally.
- [ ] A single-platform backend binary built and smoke-tested (see
      [Packaging](#packaging--one-deployment-s82)), or a `bun dev` backend.
- [ ] unerr-brain sidecar (`unerrd` + per-repo proxy) running and reachable over UDS.
- [ ] Hardened `opencode.json` in place ([S8.3 permissions](#1-safe-permission--sandbox-defaults);
      `edit: ask`, `bash: *→ask`).
- [ ] Cache-accounting sanity re-confirmed on the provider path (see
      [GA checklist Gate A](#gate-a--cost-honesty-the-product-is-a-savings-claim-it-must-be-true) —
      the known OpenRouter cache bug is a day-0 gate).

### Session procedure

1. **Baseline capture.** Pick 5–10 representative tasks (a bug fix, a small feature, a
   refactor, a test addition, a "trace X" question). For each, note expected
   difficulty and, if available, a frontier-model cost/time baseline for the same
   task.
2. **Run on econ.** Execute each task through the conductor tier, letting the
   risk-escalation router escalate the hard tail to reasoner/oracle as designed. Do
   **not** hand-pick tiers.
3. **Observe routing.** For each task record: which tier(s) ran, whether escalation
   fired and on what risk signal (blast-radius/fan-in/centrality), any
   abstention/triage/double-pay events, and whether the governance gate blocked or
   warned at an edit.
4. **Capture the proof surface.** After each task pull the savings receipt
   (`buildReceipt`/`formatReceipt`) + usage telemetry
   (`emitUsageEvent`/`TelemetryStore`): tokens (incl. `cache.read`/`cache.write`),
   cost, tier split, and the savings vs. the frontier baseline. **Verify the cache
   numbers are real, not the OpenRouter-reported bug.**
5. **Quality judgement.** For each task mark pass/fail on correctness (did it compile
   / tests pass / do the right thing) and whether a human had to intervene. Capture
   diffs.
6. **Friction log.** Record every permission prompt, wrong-tier choice,
   context-slice miss (model lacked a needed file), tool error, or hallucinated
   command.

### Per-session scorecard (record these)

| Metric | Target signal |
|---|---|
| Task pass rate (no human fix) | ≥ comparable to frontier on the boring share |
| Cost vs. frontier baseline | matches the `reduction ≈ f·(1 − 1/r)` model |
| Escalation precision | hard tasks escalated, easy tasks stayed cheap (low false-escalation) |
| Cache hit rate | non-zero, monotonic, and **verified real** |
| Governance gate | caught the intended breaking edits; low false-positive rate |
| Friction count | trending down session over session |

### After the session

- File friction items as issues; tag router mis-routes vs. context-slice misses vs.
  model capability gaps (they have different fixes: router tuning vs. context
  engineering vs. model swap).
- If a tier consistently under/over-performs, re-pin that tier's model (eval-gated —
  see [GA checklist](#ga-readiness-checklist-s84)) rather than ad-hoc swapping
  mid-session.
- Re-run the savings receipt aggregate for the whole session; confirm the headline
  savings number is defensible (measured, not promised).

### What blocks a real dogfood today

- No live in-region endpoint (global OpenRouter works for a first dogfood; in-region
  is the GA target — [In-region inference](#in-region-inference--data-residency-s81)).
- No pinned/eval-gated tier models yet (current models are placeholders).
- Savings-receipt + cache honesty must be re-confirmed on the live path first.

---

## GA-readiness checklist [S8.4]

What must be true to ship econ to existing customers. Grouped by gate. A box is
checked only when there is *evidence* (a passing test, a captured receipt, a doc),
not intent.

### Gate A — Cost honesty (the product is a savings claim; it must be true)

- [ ] **Cache accounting verified on the live provider path.** Re-confirm
      `tokens.cache.read` / `tokens.cache.write` are real on our OpenRouter (and
      in-region) path — the known OpenRouter cache-reporting bug must be ruled out
      per [S0.3](./00-foundations.md). This is the day-0 gate; nothing
      else ships without it.
- [ ] **Savings receipt verified end-to-end.** `buildReceipt`/`formatReceipt`
      produce a defensible, measured savings number on real sessions (not a
      projection); tier split and frontier baseline reconcile with provider
      invoices.
- [ ] **Telemetry sink wired and emitting**
      (`emitUsageEvent`/`installUsageSink` → `TelemetryStore`) on the live backend;
      status line + receipt render from real usage.

### Gate B — Models (capability + reproducibility)

- [ ] **Tier models eval-pinned**, not placeholders. Each tier
      (conductor/reasoner/oracle/executor) pinned to a specific OSS model that
      passed an eval on representative tasks; `opencode.json` models reflect the
      pinned set.
- [ ] **Model fallback proven.** Config-first chain (`region.ts` `selectEndpoint`)
      plus `small_model` pin verified; decide whether the GATED runtime
      auto-failover shim (see [Hardening §2](#2-model-fallback)) is required for GA
      or deferred.
- [ ] **Router behavior validated** on the dogfood scorecard: hard tail escalates,
      easy tasks stay cheap, hysteresis/abstention/triage/double-pay behave (no
      oscillation, no runaway oracle spend).

### Gate C — In-region + residency (the India promise)

- [ ] **In-region endpoint live** (gateway + `ECON_IN_API_KEY`), at least for the
      conductor tier; `region.ts` wired into provider resolution (see
      [In-region inference](#in-region-inference--data-residency-s81)).
- [ ] **Residency flipped to `strict`** for `code`/`prompt`/`completion`/`secret`,
      with the egress allow-list / `external_directory: deny` enforcing it;
      `telemetry` aggregation path reviewed for compliance.
- [ ] **Data-residency policy documented for customers** (where each data class
      travels).

### Gate D — Hardening + safety

- [ ] **Safe permission defaults shipped** ([S8.3](#hardening--safe-defaults-s83))
      and validated in a real session — friction acceptable, no unsafe
      auto-actions (`edit: ask`, `bash: *→ask`, `external_directory: deny`,
      network `ask`).
- [ ] **Governance gate validated** on the dogfood set: catches intended breaking
      edits, low false-positive rate.
- [ ] **Secrets handling reviewed** — no keys logged in telemetry/receipts;
      env-only.

### Gate E — Packaging + ops

- [ ] **One-process backend binary** builds + smoke-tests for each target platform
      (see [Packaging](#packaging--one-deployment-s82)); release pipeline produces
      signed artifacts.
- [ ] **tree-sitter wasm decision recorded** — ship on regex fallback for GA
      (current), or complete the wasm-embedding upgrade if AST fidelity is
      required (verdict in [Packaging](#packaging--one-deployment-s82)). Either
      way it is a *decision*, not an accident.
- [ ] **unerr-brain sidecar deployment documented** (UDS wiring, native-addon
      platform coverage, failure/restart behavior).
- [ ] **Upgrade/rollback path** for the binary documented.

### Gate F — Fork hygiene + process

- [ ] **Upstream divergence current** — `git fetch upstream`,
      security/provider/TUI fixes triaged and cherry-picked, base SHA re-pinned
      (see [Hardening §3](#3-fork-hygiene-continues-s06)).
- [ ] **Dogfood runbook executed** for ≥ N sessions with the scorecard trending
      green (see [Dogfood runbook](#dogfood-runbook-s84)).
- [ ] **CLAUDE.md / README updated** to reflect shipped reality (not aspiration).

### GA gates → go/no-go

```
Gate A  Cost honesty        ──┐
Gate B  Models pinned         │
Gate D  Safe defaults        ─┼──▶  required for GO (all fully green)
Gate E  One-process packaging │
                              ─┘
Gate C  In-region strict     ──▶  required for the India promise;
                                   first GA MAY ship on global OpenRouter
                                   with residency `preferred` IF disclosed
Gate F  Fork hygiene + runbook ─▶  process hygiene, tracked alongside GO
```

### GA go/no-go summary

**GO requires:** Gate A fully green (cost honesty is the product), Gate B models
pinned + router validated, Gate D safe defaults proven, Gate E one-process packaging
shipped. **Gate C (in-region `strict`) is required for the India data-residency
promise** but a first GA *could* ship on global OpenRouter with residency in
`preferred` mode **if** that is disclosed to customers. Everything currently
buildable (config, packaging path, region/residency scaffold, safe defaults,
fallback chain) is **done**; the remaining boxes are gated on live infra,
credentials, eval-pinned models, and a customer repo.
