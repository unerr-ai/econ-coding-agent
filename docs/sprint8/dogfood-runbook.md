# S8.4 — Dogfood runbook

**Status: GATED on live models + a customer repo. This is the procedure to run once those
exist.** Dogfooding = run econ on a real repo with live OSS models and measure that it
matches Claude Code / Cursor capability at a fraction of the cost.

## Preconditions (must be true before a dogfood session)

- [ ] `OPENROUTER_API_KEY` (or `ECON_IN_API_KEY` once in-region is live) is set and has quota.
- [ ] A real target repo (ideally an existing customer's) checked out locally.
- [ ] A single-platform backend binary built and smoke-tested (`docs/sprint8/packaging.md`),
      or a `bun dev` backend.
- [ ] unerr-brain sidecar (`unerrd` + per-repo proxy) running and reachable over UDS.
- [ ] Hardened `opencode.json` in place (S8.3 permissions; `edit: ask`, `bash: *→ask`).
- [ ] Cache-accounting sanity re-confirmed on the provider path (see GA checklist — the
      known OpenRouter cache bug is a day-0 gate).

## Session procedure

1. **Baseline capture.** Pick 5–10 representative tasks (a bug fix, a small feature, a
   refactor, a test addition, a "trace X" question). For each, note expected difficulty and,
   if available, a frontier-model cost/time baseline for the same task.
2. **Run on econ.** Execute each task through the conductor tier, letting the risk-escalation
   router escalate the hard tail to reasoner/oracle as designed. Do **not** hand-pick tiers.
3. **Observe routing.** For each task record: which tier(s) ran, whether escalation fired and
   on what risk signal (blast-radius/fan-in/centrality), any abstention/triage/double-pay
   events, and whether the governance gate blocked or warned at an edit.
4. **Capture the proof surface.** After each task pull the savings receipt
   (`buildReceipt`/`formatReceipt`) + usage telemetry (`emitUsageEvent`/`TelemetryStore`):
   tokens (incl. `cache.read`/`cache.write`), cost, tier split, and the savings vs. the
   frontier baseline. **Verify the cache numbers are real, not the OpenRouter-reported bug.**
5. **Quality judgement.** For each task mark pass/fail on correctness (did it compile / tests
   pass / do the right thing) and whether a human had to intervene. Capture diffs.
6. **Friction log.** Record every permission prompt, wrong-tier choice, context-slice miss
   (model lacked a needed file), tool error, or hallucinated command.

## Per-session scorecard (record these)

| Metric | Target signal |
|---|---|
| Task pass rate (no human fix) | ≥ comparable to frontier on the boring share |
| Cost vs. frontier baseline | matches the `reduction ≈ f·(1 − 1/r)` model |
| Escalation precision | hard tasks escalated, easy tasks stayed cheap (low false-escalation) |
| Cache hit rate | non-zero, monotonic, and **verified real** |
| Governance gate | caught the intended breaking edits; low false-positive rate |
| Friction count | trending down session over session |

## After the session

- File friction items as issues; tag router mis-routes vs. context-slice misses vs. model
  capability gaps (they have different fixes: router tuning vs. context engineering vs. model
  swap).
- If a tier consistently under/over-performs, re-pin that tier's model (eval-gated — see GA
  checklist) rather than ad-hoc swapping mid-session.
- Re-run the savings receipt aggregate for the whole session; confirm the headline savings
  number is defensible (measured, not promised).

## What blocks a real dogfood today

- No live in-region endpoint (global OpenRouter works for a first dogfood; in-region is the
  GA target — `docs/sprint8/in-region.md`).
- No pinned/eval-gated tier models yet (current models are placeholders).
- Savings-receipt + cache honesty must be re-confirmed on the live path first.
