// Content strings of the engine-planted seed slices (the todo objects that
// carry them stay in slice-orchestrator.ts).

/**
 * Content of the diagnosis pre-pass — a single WRITER slice that
 * localizes the root cause, applies the minimal fix, and re-runs the failing
 * test to green in ONE session (no read-only hand-off; it does not stop at an
 * analysis and defer the edit). Exported so the boundary test asserts the
 * injected item verbatim and the fold-back relay recognizes the frame slice by
 * id.
 */
export const LOCALIZATION_SLICE_CONTENT =
  "You OWN this bug end to end in ONE session — localize, fix, and PROVE it, all here. (1) LOCALIZE: name the exact file(s) and function(s) that must change and the defect mechanism (why the current behavior is wrong), tracing the failure path from symptom to CAUSE with the graph tools (graph search, callers) and targeted file reads — find the cause, not just where the symptom surfaces. Issue your orientation probes (entry-point read, symbol search, test-file glob) as ONE message with multiple tool calls. (2) FIX: apply the minimal edit at that cause. (3) VERIFY: RUN the failing/pinned test (plus a focused typecheck of what you touched) and iterate edit→run until it passes GREEN — a described change is not done; done means the pinned suite actually passes. Never weaken, delete, skip, or edit the failing test to make it pass — fix the cause. If you GENUINELY cannot localize within budget, stop editing and instead report the ranked candidate sites — each with the evidence for its rank and one discriminating probe as a single runnable shell command on its own backticked line — so the next pass can rule the others out. Budget discipline: your tool-call budget is HARD — a watchdog ends the session at the cap and keeps only what you have already written and applied; make the edit and run the test EARLY, then refine — a verified minimal fix beats a perfect unwritten analysis."

/**
 * #55 — content of the re-plan seed the mid-flight re-decomposition trigger
 * (`new-items`, §4.2) plants after a run leaves unverifiable coverage gaps.
 * DELIBERATELY distinct from LOCALIZATION_SLICE_CONTENT so appendTodos'
 * dedup-by-content never collides with a diagnosis pre-pass seed already on the
 * list — this must be able to land even when a pre-pass ran this session.
 */
export const REDECOMPOSITION_SLICE_CONTENT =
  "Re-plan the unfinished work from the previous pass. Some slices were accepted but could NOT be verified — coverage gaps, surfaced here rather than lost silently. Produce a bounded re-decomposition, not code: (1) list the unverified/uncovered items and why each stayed unconfirmed; (2) break each into smaller, INDEPENDENTLY CHECKABLE slices, each with a concrete success check; (3) an execution DAG of typed slices (content, sliceType, need, deps) for the conductor to dispatch. Writing code or diffs is forbidden here — the re-plan and DAG only."

/**
 * P12 — content of the plan pre-pass a hard BUILD goal (`needsPlan`, non-diagnosis)
 * plants at turn open. Forward-looking and edit-free: fresh work with no bug and no
 * failing test must not receive the diagnosis writer's bug-hunt brief (the
 * build-dark-mode corpus hole — it burned budget "localizing" a defect that does not
 * exist). Same deliverable shape as the re-plan seed (a DAG of typed slices) but for
 * a DECIDED build, not unverified residue. DELIBERATELY distinct from BOTH seeds
 * above so appendTodos'/the skeleton's dedup-by-content keeps each kind plantable
 * alongside the others.
 */
export const PLAN_SLICE_CONTENT =
  "Plan this build before any code is written. The work is decided but too large to execute blind — your job is decomposition, not implementation: (1) read just enough of the codebase (graph search, callers, targeted file reads) to anchor the plan in the REAL structure — name the files/modules each change touches and the seams it must respect; (2) break the work into small, INDEPENDENTLY CHECKABLE slices, each with a concrete success check; (3) deliver the implementation plan as an execution DAG of typed slices (content, sliceType, need, deps) for the conductor to dispatch. Writing code or diffs is forbidden here — the plan and DAG only."

/**
 * S2 — content of the repro-authoring pre-pass: manufacture executed-red
 * evidence BEFORE any fix pre-pass runs (repro-first sequencing — a repro
 * authored after the fix can only ever run green). Untyped/inline by design
 * (see REPRO_PREPASS_TODO in slice-orchestrator.ts) so the ROOT conductor
 * observes the red run itself via the existing probe-from-red pin — a
 * dispatched child's red would be invisible to the root. DELIBERATELY
 * distinct from the seeds above so dedup-by-content keeps each kind
 * plantable alongside the others.
 */
export const REPRO_SLICE_CONTENT =
  "Manufacture the evidence BEFORE any fix: this turn diagnoses a bug, and a described fix with no red repro proves nothing. (1) Prefer a targeted EXISTING test the issue names — run it as-is. If none is named, author a minimal repro script at the repo root (e.g. `repro_issue.py`, or the language-appropriate equivalent) from the issue text, asserting the EXPECTED behavior so it exits non-zero on the current (unpatched) code and 0 once fixed. (2) RUN it and confirm it fails FOR THE ISSUE'S REASON — not an import error, a missing fixture, or an unrelated setup failure; a repro that is green on unpatched code proves nothing (fix the repro, not the code, until it genuinely reproduces). (3) Never `git add` the repro script — it is scratch evidence, not part of the patch. If, after at most 2 distinct approaches, you genuinely cannot get a repro to fail for the right reason, STOP: mark this item cancelled with a one-line reason and proceed to the fix with explicit caution — do not keep burning budget on the repro alone."

/**
 * L4.2 — content of the design pre-pass the GRIND VALVE (turn-supervisor.ts
 * `createGrindValve`, wired in prompt.ts's SM4 block) plants mid-turn when an
 * inline conductor turn crosses its soft step budget with no green verify in
 * the stall window (django-11885: 179 inline edit-test-edit steps, $0.8447,
 * that a ~$0.23 reasoner design slice would likely have collapsed). A RESCUE
 * brief, not a fresh-build plan: the failure evidence exists and the design
 * must explain WHY the grinding attempts keep failing before deciding the
 * approach. DELIBERATELY distinct from the three seeds above so
 * dedup-by-content keeps each kind plantable alongside the others.
 */
export const GRIND_DESIGN_SLICE_CONTENT =
  "The inline attempt on this task has ground past its step budget without a passing verification — stop the edit-test churn and DESIGN the fix. Your deliverable is the algorithmic decision, not code: (1) restate the required end state and the invariants the change must preserve (grouping, ordering, batching, error behavior — whatever the touched code guarantees); (2) read just enough (graph search, callers, targeted file reads, the failing test) to name the exact file(s)/function(s) that must change and WHY the approaches tried so far keep failing — the constraint they violate; (3) deliver a concrete minimal design the conductor can execute mechanically: the edit plan per file (what changes, to what), the invariant each edit must respect, and the exact verify command(s) that prove it. Writing code or diffs is forbidden here — the design only."
