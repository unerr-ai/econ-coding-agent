# Reference approaches — how a strong agent solves each benchmark case

**Purpose.** For each benchmark case we study, this doc records the *reference approach*:
the gold-patch direction plus how a strong agent (`claude -p`, read-only **plan mode**)
independently decomposes and verifies the same bug. We use these to **audit the
orchestration *expectation*** — whether the path ORCHESTRATION_MECHANISM.md prescribes
heads in the same direction a strong agent would — separately from auditing econ's actual
*outcome*. This is the "what good looks like" reference; it is **not** a cost/receipt
comparison (those live in `../unerr-benchmarks`, per the receipt-is-observability rule).

**Method.** `claude -p --permission-mode plan "<raw SWE-bench issue> + a plan-only prompt"`
run inside the arena checked out at the base commit (no edits, read-only). The plan is
captured verbatim, then compared to (a) the gold patch and (b) the doc's stage-by-stage
expectation. The three-way audit is: **reference (gold + claude) ↔ doc expectation ↔ econ
outcome.**

---

## django__django-11885 — "Combine fast delete queries" (#30856)

**Base** `44522d1036604e13a5adf4e084e1c8f7b56c82c0` · **Fix** `26c66f45193fa65125ca06328817927d6bbc2b22` · Django 3.1-dev · Python 3.9.

**The bug.** When cascading deletes take the "fast delete" path
(`DELETE FROM t WHERE fk IN (...)`), a model referenced by another model through *multiple*
CASCADE FKs emits **one query per FK**. They should combine into **one `DELETE` per table**
(OR-union the per-FK `IN` predicates).

**Gold direction (2 files).**
- `django/db/models/deletion.py` (~72 lines, the real work): `collect()` buckets
  fast-deletable referencing models into a `defaultdict(list)` keyed by related model and
  emits one combined query per model; `related_objects()` takes multiple fields and builds
  `reduce(operator.or_, Q(...))`; `can_fast_delete`/`get_del_batches` adjusted.
- `django/contrib/admin/utils.py` (~6 lines, mechanical): update the single external
  `related_objects` override (`NestedObjects`) to the new signature.

**FAIL_TO_PASS:** `delete.tests.FastDeleteTests.test_fast_delete_combined_relationships`
(base emits 3 queries, expects 2). **PASS_TO_PASS regression to watch:**
`delete.tests.DeletionTests.test_large_delete`.

**`claude -p` reference plan (verbatim key points).**
- **Files/functions:** `deletion.py` — `collect()` (bucket referencing models into
  `defaultdict(list)`, emit one combined query per model), `related_objects()` (OR-union via
  `reduce(operator.or_, Q(...))`), `get_del_batches()`, imports (`reduce`, `operator.or_`, `Q`).
- **Core insight:** "All CASCADE FKs from one referencing model to the deleted model can be
  satisfied by a single `DELETE` whose WHERE is the OR-union of the per-FK `IN` lookups;
  group candidate relations by referencing model instead of emitting a queryset per relation."
- **Hard vs mechanical:** HARD = restructuring `collect()` (per-model eligibility, leave the
  slow path untouched, `to_field` FKs combine, batching survives multi-field grouping).
  MECHANICAL = new signatures at call-sites + imports.
- **Cheap+strong split:** STRONG = `collect()` grouping + OR-predicate + correctness
  reasoning; CHEAP = propagate the two signatures to their single call sites + imports.
- **Verify without a grader:** run the `delete` suite + the behavior test → 2 queries; wrap a
  delete in `CaptureQueriesContext` to confirm one OR-combined `DELETE` per table **and** that
  the returned `(count, {label: n})` is unchanged; exercise batching (many rows) and the
  `to_field` FK path.
- Note: claude's file list named `deletion.py` "only" and folded the `admin/utils.py`
  override into "propagate to call sites" — i.e. even a strong agent under-counts the
  mechanical caller, which is exactly why the propagation must be an explicit tracked slice.

**Audit finding (reference ↔ doc).** claude -p independently prescribes **STRONG = the
insight / CHEAP = the propagation** and **verify-on-new-behavior** — confirming three design
bugs in ORCHESTRATION_MECHANISM.md for this bug class:
- **#1 — §7.2 Allocate** routes high-coupling+testable → executor; the *insight* should route
  to the **reasoner**. (coupling ≠ difficulty.)
- **#2 — §1.2 Decompose** builds a goal tree; this is **one atomic insight + one mechanical
  follow-on**, i.e. *route-to-reasoning-that-owns*, not slice-into-goals.
- **#3 — §1.5 Verify** ("run tests, probe rung") is insufficient; the new combined-query
  behavior is the gate (query count + regression + `to_field`/batching edges), and tests must
  be immutable so green can't be faked.

**Reframe:** *atomic-insight bugs are routed **whole** to a reasoning tier that **owns**
edit → run → verify-against-the-real-behavior; decomposition's only job here is peeling off
the mechanical signature propagation so it isn't dropped.*
