# Graph-Navigation Audit — signals completeness before, during, and after edit

**Status:** Audit complete 2026-07-18. Does the model/harness have every graph-derivable signal
it needs at every moment of a coding task (recon, edit, finish)? Full consumer inventory (all 15
BunSqliteGraph methods × every call site), docs intent sweep, and synthesis vs external SOTA
(Aider, Agentless, LocAgent, RepoGraph ICLR'25, oasdiff) + unerr-cli reference catalog.

> **See also:** [variance report Part IX (F20/F21)](../testing/HARNESS_AND_VARIANCE_REPORT.md) (F20
> graph-derived regression neighbors; F21 turn-harvested interpreter, landed 2026-07-18,
> 68c41aca3), [gap-closure-plan.md H2](./gap-closure-plan.md) (2026-07-19: regression reach
> round 3 — import-time side-effect edits defeat F20's entity-graph walk; live specimen
> astropy-13236, 644 P2P broken with zero `turn_regression` signals),
> [path-to-85.md §4](./path-to-85.md) (adapter layer + graph doctrine), [models.md](./models.md)
> (tier capabilities), [ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md) (the context
> engine and edit-time gate).

> **One-line thesis.** The model sees ranked callers only at escalation gates (4+ places); the
> direct-caller tool is not registered although unerr expects it as #1 pre-edit query; text-occurrence
> rename sweep has no call site; and the entity-ranked output compressor (`compress()`) exists
> entirely unwired — implementation recon (2026-07-18) showed its intended seam (S2.2 plugin trim)
> is retired architecture, so it stays unwired **by decision** (§3). Gaps cluster at the
> *before-edit* and *during-edit* boundaries. Each drives measurable breakage (`shapely-2226` and
> others) or silent token waste.

---

## 1. The audit — every moment of a coding turn

| Moment | Signal layer | Status | Evidence | Gap ID |
|---|---|---|---|---|
| **BEFORE EDIT** | Recon bundle (call graph injected) | ✓ Live | context.assemble + searchCode | — |
| | Symbol rank / fan-in / semantic fields | ✓ Live (partial) | FTS-indexed, columns exist | G1 |
| | File structure catalog | ✓ Live | fileOutline (compact) | — |
| | Turn-open risk probe → tier routing | ✓ Live | 3s budget @ context-build time | — |
| | Direct caller list (tool for model) | ✗ GAP | De-registered phase-1; unerr catalog has it as #1 pre-edit | **G1** |
| | Definition sites for hub judge | ✓ Live (partial) | 3s budget + 50ms variants uncached | G4 |
| **DURING EDIT** | Cascade warning: callers-at-risk | ✓ Live | file_edit responses, inline | — |
| | Rename: text-occurrence sweep | ✗ GAP | Never called; unerr precedent = include_text_occurrences | **G3** |
| | Output compression (entity-ranked) | ✗ Declined 2026-07-18 | compress() orphaned; its target seam (S2.2 plugin trim) retired — live trim is enforceStepBudget, order-preserving; see §3 | G2 |
| **AFTER EDIT / FINISH** | Regression neighbors (graph-derived) | ✓ Live | F20, 2026-07-18 | — |
| | Turn-harvested interpreter | ✓ Live | F21, 2026-07-18 | — |
| | Breaking-change scan (removed/sig-changed) | ✗ GAP | Graph-diff deterministic; external refs (oasdiff, Bazel reverse-deps) | **G3** |
| | Dead-code scan | ⚠ Deferred | Anecdote-grade evidence only | — |
| **ROUTING / HYGIENE** | Risk/coupling/test-strength probes | ✓ Live | Convert to tier + verifier rung | — |
| | Readiness budgets (recon) | ⚠ Inconsistent | 3s vs 15s vs 5s | G4 |
| | Note staleness flagging | ⚠ Partial | Logged, never surfaced; violates no-advisory-signals | G4 |
| | Definition-sites caching | ⚠ Partial | 50ms uncached variants, never shared | G4 |

---

## 2. Ranked Wave G — implementation priority

Each item traces to observed failure (`shapely-2226` and others) or measured silent token waste.
Validation bar per [path-to-85.md §6](./path-to-85.md): each ships **fail-closed** + **unit-proven**;
live claims wait for mini-10 + real-repo re-fire; cost claims need ≥3-run band.

### G1: Make get_references visible to the model (callers + callees + domain/role + chokepoint marker)

**Evidence:** Consumer asymmetry (model sees bounded-depth recon, never the full caller graph);
unerr catalog treats direct callers as #1 pre-edit query; `shapely-2226` = edit to high-fan-in ctor
whose callers the model never observed.

**Signal:** model tool `get_references()` with capped depth-2, fan_in count, domain/role semantic
fields, and a chokepoint marker at the existing governance threshold (`RSK_CALLER_THRESHOLD`,
graph-tools-enrich.ts) — same constant the edit-time cascade warning uses, one definition.

**Cost shape:** ~$0 (catalog-compacted, synthesized from existing graph).

### G2: Wire compress() behind the fidelity gate — INVESTIGATED, DECLINED (2026-07-18)

**Finding (implementation recon):** the seam this item targeted no longer exists. The S2.2
plugin-trim design (`econ-output-trim.js` + `smartTruncate` + `gateCompression`/`assessFidelity`)
was retired 2026-07-13; `gateCompression`, `pruneWindow`, and `smartTruncate` have **0 production
callers** (test fixtures only — `smartTruncate`'s sole live caller is `compileBrief`, an unrelated
feature). The live trim seams are (a) `enforceStepBudget` (`session/step-budget.ts`, one call site
in prompt.ts) — an order-preserving per-step tool-result budget cap — and (b) the shell-compress
pipeline (`tool/shell-compress/`), which has its own quality-monitor feedback loop.

**Why declined rather than re-scoped:** `compress()` sorts kept blocks by fan-in score (it
*reorders* source), while the live seam is prefix-preserving; no non-tautological fidelity answer
key exists at that seam (no task-phrase context is threaded there, unlike webfetch's BM25 prompt);
and wiring it in forces a pure sync module async. Quality risk with no demonstrated cost win —
declined per the §6 validation bar. Revisit only if a seam appears that already carries
task-phrase context (e.g. recon-shaped summaries) where reordering is acceptable by construction.

### G3: Post-edit breaking-change scan + rename text-occurrence sweep

**Evidence:** Shapely-class breakage (rename leaves stale config keys, removing an export breaks
call sites the model never saw); unerr precedent (`include_text_occurrences`); external detectors
(oasdiff, Bazel/Meta reverse-dependency selection is industrial standard).

**Signals:**

1. **Text-occurrence sweep on rename:** when an exported name disappears from an edited file, the
   edit-governance scan also reports word-boundary literal matches the call graph cannot see (test
   fixtures, config keys, routes, comments), capped. Inline warning in the edit result
   (convert-shaped, never a deny). ~$0. (unerr's `include_text_occurrences` is the reference shape.)

2. **Post-edit breaking-change scan:** Deterministic graph-diff (before/after AST): removed exported
   entity or signature-changed export with >0 live callers → inline warning in finish phase. ~$0.

### G4 (Follow-up, blocked by G1/G3 file overlap)

- Staleness enforcement in recon injection (no advisory logs, surface or gate).
- Shared def-sites cache (eliminate 50ms+ uncached variants).
- Uniform readiness budgets across all recon layers (single knob, 5s or 15s).

---

## 3. Explicitly declined (path-to-85 Tier-3 style)

These were evaluated and rejected on evidence grounds (not just taste):

| Mechanism | Why declined | Evidence |
|---|---|---|
| **Graph-RAG rerankers / PageRank repo-map injection** | Localization-shaped mechanism; doctrine forbids graph→localization path. AutoCodeRover overfit caution (45% → 19% on GHSL). Recon bundle already serves the before-edit slice. | AutoCodeRover ICLR'25; doctrine: path-to-85 §4 |
| **ML predictive test selection** | Requires training pipeline (out of phase). F20 (regression neighbors) is deterministic lane; revisit post-85. | F20 landed 2026-07-18; F1–F8 research archived |
| **LSP substrate + schema/config impact** | Ecosystem-adapter layer (path-to-85 §4). Defered to phase-2. | Architecture: path-to-85 §4 |
| **Community-detection boundaries + dead-code scan** | Anecdote-grade evidence; no measured delta on real tasks. Mini-SWE-agent datum (74%+ Verified via bash-only agents) shows structured nav must pay for itself in cost or score. | Validation bar: path-to-85 §6 |
| **compress() behind a fidelity gate (was wave-G item G2)** | Target seam (S2.2 plugin trim) is retired architecture; the live trim seam (`enforceStepBudget`) is order-preserving with no fidelity-key source, and `compress()` reorders blocks by fan-in score. | Implementation recon 2026-07-18: 0 production callers for gateCompression/pruneWindow/smartTruncate |

---

## 4. Implementation roadmap

1. **Land G1 + G3 (model-visible calls + breaking-change scan).** ~$0, high-fit, closes shaped failures. Target: next week (unblocks `shapely` re-fire).

2. **G2 declined** (2026-07-18) — target seam retired; see the G2 section above and §3.

3. **G4 follow-up.** After G1/G3 land and code is stable, unify caching + budgets in one pass (tight, mechanical).

4. **Validation.** Per path-to-85 §6: mini-10 + `shapely`/`linkding` suite re-fire; live-repo validation (production runs); cost band ≥3 runs for any spend claims.
