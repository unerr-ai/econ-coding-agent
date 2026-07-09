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
  "You OWN this bug end to end in ONE session — localize, fix, and PROVE it, all here. (1) LOCALIZE: name the exact file(s) and function(s) that must change and the defect mechanism (why the current behavior is wrong), tracing the failure path from symptom to CAUSE with the graph tools (graph search, callers) and targeted file reads — find the cause, not just where the symptom surfaces. (2) FIX: apply the minimal edit at that cause. (3) VERIFY: RUN the failing/pinned test (plus a focused typecheck of what you touched) and iterate edit→run until it passes GREEN — do not stop at a described fix; the test must actually pass. Never weaken, delete, skip, or edit the failing test to make it pass — fix the cause. If you GENUINELY cannot localize within budget, stop editing and instead report the ranked candidate sites — each with the evidence for its rank and one discriminating probe as a single runnable shell command on its own backticked line — so the next pass can rule the others out. Budget discipline: your tool-call budget is HARD — a watchdog ends the session at the cap and keeps only what you have already written and applied; make the edit and run the test EARLY, then refine — a verified minimal fix beats a perfect unwritten analysis."

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
