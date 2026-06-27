# S8.4 — GA readiness checklist

What must be true to ship econ to existing customers. Grouped by gate. A box is checked only
when there is *evidence* (a passing test, a captured receipt, a doc), not intent.

## Gate A — Cost honesty (the product is a savings claim; it must be true)

- [ ] **Cache accounting verified on the live provider path.** Re-confirm `tokens.cache.read`
      / `tokens.cache.write` are real on our OpenRouter (and in-region) path — the known
      OpenRouter cache-reporting bug must be ruled out per `docs/sprint0/S0.3-cache-accounting.md`.
      This is the day-0 gate; nothing else ships without it.
- [ ] **Savings receipt verified end-to-end.** `buildReceipt`/`formatReceipt` produce a
      defensible, measured savings number on real sessions (not a projection); tier split and
      frontier baseline reconcile with provider invoices.
- [ ] **Telemetry sink wired and emitting** (`emitUsageEvent`/`installUsageSink` →
      `TelemetryStore`) on the live backend; status line + receipt render from real usage.

## Gate B — Models (capability + reproducibility)

- [ ] **Tier models eval-pinned**, not placeholders. Each tier (conductor/reasoner/oracle/
      executor) pinned to a specific OSS model that passed an eval on representative tasks;
      `opencode.json` models reflect the pinned set.
- [ ] **Model fallback proven.** Config-first chain (`region.ts` `selectEndpoint`) plus
      `small_model` pin verified; decide whether the GATED runtime auto-failover shim
      (`docs/sprint8/harden.md` §2) is required for GA or deferred.
- [ ] **Router behavior validated** on the dogfood scorecard: hard tail escalates, easy tasks
      stay cheap, hysteresis/abstention/triage/double-pay behave (no oscillation, no runaway
      oracle spend).

## Gate C — In-region + residency (the India promise)

- [ ] **In-region endpoint live** (gateway + `ECON_IN_API_KEY`), at least for the conductor
      tier; `region.ts` wired into provider resolution (`docs/sprint8/in-region.md`).
- [ ] **Residency flipped to `strict`** for `code`/`prompt`/`completion`/`secret`, with the
      egress allow-list / `external_directory: deny` enforcing it; `telemetry` aggregation
      path reviewed for compliance.
- [ ] **Data-residency policy documented for customers** (where each data class travels).

## Gate D — Hardening + safety

- [ ] **Safe permission defaults shipped** (S8.3) and validated in a real session — friction
      acceptable, no unsafe auto-actions (`edit: ask`, `bash: *→ask`, `external_directory:
      deny`, network `ask`).
- [ ] **Governance gate validated** on the dogfood set: catches intended breaking edits, low
      false-positive rate.
- [ ] **Secrets handling reviewed** — no keys logged in telemetry/receipts; env-only.

## Gate E — Packaging + ops

- [ ] **One-process backend binary** builds + smoke-tests for each target platform
      (`docs/sprint8/packaging.md`); release pipeline produces signed artifacts.
- [ ] **tree-sitter wasm decision recorded** — ship on regex fallback for GA (current), or
      complete the wasm-embedding upgrade if AST fidelity is required (verdict in
      `packaging.md`). Either way it is a *decision*, not an accident.
- [ ] **unerr-brain sidecar deployment documented** (UDS wiring, native-addon platform
      coverage, failure/restart behavior).
- [ ] **Upgrade/rollback path** for the binary documented.

## Gate F — Fork hygiene + process

- [ ] **Upstream divergence current** — `git fetch upstream`, security/provider/TUI fixes
      triaged and cherry-picked, base SHA re-pinned (`docs/sprint8/harden.md` §3).
- [ ] **Dogfood runbook executed** for ≥ N sessions with the scorecard trending green
      (`docs/sprint8/dogfood-runbook.md`).
- [ ] **CLAUDE.md / README updated** to reflect shipped reality (not aspiration).

---

### GA go/no-go summary

**GO requires:** Gate A fully green (cost honesty is the product), Gate B models pinned +
router validated, Gate D safe defaults proven, Gate E one-process packaging shipped. **Gate
C (in-region `strict`) is required for the India data-residency promise** but a first GA
*could* ship on global OpenRouter with residency in `preferred` mode **if** that is disclosed
to customers. Everything currently buildable (config, packaging path, region/residency
scaffold, safe defaults, fallback chain) is **done**; the remaining boxes are gated on live
infra, credentials, eval-pinned models, and a customer repo.
