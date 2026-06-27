# S8.3 — Hardening: safe defaults, model fallback, fork hygiene

**Status: BUILT (safe permission defaults + small_model + config-first fallback shipped).
Runtime auto-failover code hook + upstream cherry-pick triage documented as GATED.**

## 1. Safe permission / sandbox defaults

OpenCode's permission model lives in `packages/core/src/v1/config/permission.ts`. Keys:
`read, edit, glob, grep, list, bash, task, external_directory, todowrite, question,
webfetch, websearch, lsp, doom_loop, skill`. Actions: `ask | allow | deny`. A key may also
be an **object** of `pattern → action` (used for `bash`). Precedence is **last-match-wins**
(`findLast` in `packages/opencode/src/permission/index.ts`), so a wildcard must come *first*
and the specific overrides *after* it.

We added a hardened `permission` block to `opencode.json`:

- **Read-only tools allowed** (low risk, high friction if gated): `read, list, glob, grep,
  lsp, todowrite, question`.
- **`task: allow`** — sub-agent delegation is core to econ's multi-tier routing.
- **Mutation gated**: `edit: "ask"` — every file write asks. (The in-loop governance gate
  is advisory; `ask` is the belt-and-suspenders safe default.)
- **Network gated**: `webfetch: "ask"`, `websearch: "ask"` — egress is opt-in.
- **Out-of-project denied**: `external_directory: "deny"` — directly serves S8.1 data
  residency (the agent cannot read/write outside the project tree). `doom_loop: "ask"`,
  `skill: "ask"`.
- **`bash`** as a pattern object: `"*": "ask"` (every command asks by default), with
  read-only conveniences allowed after (`ls *`, `cat *`, `pwd`, `git status/diff/log`) and
  destructive patterns denied after (`sudo *`, `rm -rf *`, `rm -fr *`); `git push*`,
  `curl *`, `wget *` explicitly `ask`. Ordering relies on the last-match-wins rule above.

These are deliberately **strict GA defaults** — loosen per project as trust builds (e.g.
move common safe commands to `allow`). The `fewer-permission-prompts` flow can refine the
bash allow-list from real transcripts later.

> Note: OpenCode has no separate "sandbox" engine to configure; the permission layer *is*
> the sandbox surface (plus `external_directory` for filesystem scoping). There is an
> experimental sandbox stub under `server/routes/.../experimental.ts` — not a stable config
> knob, intentionally left untouched.

## 2. Model fallback

**Approach: config-first, no router/model code changes.** OpenCode has **no native
per-model failover field** (verified: `provider.ts`/config schema expose `model`,
`small_model`, `provider` overrides, `disabled/enabled_providers` — no `fallback`).

What we shipped:
- **`small_model: "openrouter/qwen/qwen3-8b"`** in `opencode.json` — pins incidental work
  (title generation, summaries) to the cheapest tier so housekeeping never pays
  conductor/oracle rates and degrades gracefully.
- **Per-tier fallback chain in `region.ts`** (S8.1): each tier has an ordered endpoint chain
  (in-region preferred → global OpenRouter fallback). `selectEndpoint` resolves it. This is
  the config-level "fallback chain" — data, not code.
- The always-available baseline today is the `openrouter` provider; every tier resolves to
  it, so there is no single-model single-point-of-failure beyond OpenRouter itself.

**GATED (did NOT build — would touch protected files):** *runtime* auto-failover (catch a
5xx/timeout from the primary model and transparently retry the next endpoint in the chain).
That needs a minimal wrapper at the provider call site; per the sprint guardrails we did
**not** modify `model.ts`/`router.ts`/`registry.ts`. Recommended minimal design when we do
it: a thin retry shim that, on a retryable provider error, calls `selectEndpoint` for the
next chain entry — isolated in its own module, wrapping the provider, not edited into the
router. Flagged for the lead.

## 3. Fork hygiene (continues S0.6)

- **Remotes:** `origin → github.com/unerr-ai/econ-coding-agent`,
  `upstream → github.com/anomalyco/opencode`.
- **Base lineage:** `packages/opencode` is at version **1.17.9**; econ work sits on top of
  the OpenCode tree (HEAD `0fddf4552`, "feat(wave3): S4 executors+specialists, S6 governance
  gate+memory, S7 proof surface").
- **Divergence (econ-specific surface, all additive):** `packages/code-intelligence/*`
  (the transplanted engine — risk/router/governance/telemetry/region), `opencode.json`
  (tiers, providers, permissions), `docs/sprint*`, `script/build-econ-binary.ts`. We have
  **not** forked `model.ts`/`router.ts`/`registry.ts` upstream files for econ behavior —
  the engine lives in its own package, which keeps merge surface minimal.
- **Cherry-pick triage (GATED on a fetch — network):** `upstream/main` is configured but not
  fetched into this checkout, so the exact ahead/behind counts can't be computed offline.
  Runbook:
  ```
  git fetch upstream
  git log --oneline HEAD..upstream/main          # upstream commits we lack
  git log --oneline --since="<fork date>" upstream/main -- packages/opencode/src/provider \
        packages/opencode/src/session                # security/provider fixes worth pulling
  ```
  Pull **security fixes, provider/auth fixes, and TUI fixes** by cherry-pick; **avoid**
  pulling refactors that touch files we extend, to keep our additive surface clean. Pin the
  base (record the merged upstream SHA) after each sync.
