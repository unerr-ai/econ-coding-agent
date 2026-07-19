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
  "You OWN this bug end to end in ONE session — localize, fix, and PROVE it, all here. (1) LOCALIZE: name the exact file(s) and function(s) that must change and the defect mechanism (why the current behavior is wrong), tracing the failure path from symptom to CAUSE with the graph tools (graph search, callers) and targeted file reads — find the cause, not just where the symptom surfaces. Issue your orientation probes (entry-point read, symbol search, test-file glob) as ONE message with multiple tool calls. (2) FIX: apply the minimal edit at that cause, mirroring the surrounding code's idioms and types exactly — never add coercions, conversions, or guards the neighboring code does not use (a gratuitous str()/int() is a one-token grade failure). When the fix reads the environment (current time/date, timezone, locale, env vars), COPY the exact idiom the surrounding module already uses (e.g. if the module reads utcnow(), never introduce now()) — graders and tests mock the module's existing idiom. Make the MINIMAL representational change — never add an explicit type conversion (str()/int()/float()/bytes()) or reformatting the issue did not ask for; if the surrounding code stores or returns a value, pass it through in its existing type. When the fix mirrors a value into another structure (a widget/HTML attrs dict, headers, serialized params), assign the SOURCE value itself — never a stringified copy, and never via a rendering helper that stringifies internally: graders assert the mirrored entry with typed equality against the source (254, not '254'), and rendered output hides the difference. Precedence: typed-mirror OVERRIDES idiom-mirror — even when a neighboring helper stringifies, assign and assert the TYPED value (254, not '254'). When the fix changes how a construct renders or serializes, ENUMERATE every sibling class that renders the same construct and check each one as a checklist — never from memory. Use only the module's existing imports and idioms — never introduce a new import or dependency for functionality an already-imported module provides (tests commonly mock the module's existing imports; a new equivalent bypasses them). Keep the diff scope-minimal: never delete, rename, or restructure existing attributes, variables, or code paths the issue does not require changing — other code and tests may depend on them exactly as they are. Fix at the root-most layer: change the definition of the entity whose behavior the issue calls wrong (its class, method, or function) — never coerce or compensate at the sites where its values flow. A maintainer fixes the source, not the symptom. If an EXISTING test goes red under your change, treat that test as the spec — your design diverges from the maintainer's; change your design, never the test's expectations. EXCEPTION: if a visible test's expectation contradicts the issue's stated desired output, the ISSUE is the spec — do not contort the fix to keep the contradicting assertion green; state the conflict in your answer instead. (3) VERIFY: RUN the failing/pinned test (plus a focused typecheck of what you touched) and iterate edit→run until it passes GREEN — a described change is not done; done means the pinned suite actually passes. Never weaken, delete, skip, or edit the failing test to make it pass — fix the cause. If you GENUINELY cannot localize within budget, stop editing and instead report the ranked candidate sites — each with the evidence for its rank and one discriminating probe as a single runnable shell command on its own backticked line — so the next pass can rule the others out. Budget discipline: your tool-call budget is HARD — a watchdog ends the session at the cap and keeps only what you have already written and applied; make the edit and run the test EARLY, then refine — a verified minimal fix beats a perfect unwritten analysis."

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
  "Manufacture the evidence BEFORE any fix: this turn diagnoses a bug, and a described fix with no red repro proves nothing. (1) Prefer a targeted EXISTING test the issue names — run it as-is. If none is named, WRITE A FILE named `repro_issue.py` at the repo root (or the language-appropriate `repro_issue.*`) from the issue text, asserting the EXPECTED behavior so it exits non-zero on the current (unpatched) code and 0 once fixed — never an inline `python -c`/heredoc one-liner (an inline command cannot be pinned as the turn's verification contract; the file can), and run it as its OWN single command (`python repro_issue.py`), not buried inside a batched probe script. (2) Assert on the API-LEVEL values the issue names — the actual attribute/return/field values compared with `==` against the exact expected values derived from the code (e.g. the model field's real max_length), NOT on rendered/serialized output, which hides type differences like '255' vs 255 that graders check. Match the types the surrounding code uses. (3) RUN it and confirm it fails FOR THE ISSUE'S REASON — not an import error, a missing fixture, or an unrelated setup failure; a repro that is green on unpatched code proves nothing (fix the repro, not the code, until it genuinely reproduces). Keep it MINIMAL: the issue's own claim only, no extra edge-case inventions stricter than the issue. (4) Never `git add` the repro script — it is scratch evidence, not part of the patch — and never DELETE it either: leave it in place until the turn ends, since the done-gate re-runs it and it stays untracked, so it never enters the patch. (5) Run it BARE — exactly `python repro_issue.py`, never `| tail`, never `; echo \"exit=$?\"`, never wrapped in `git stash` — the harness reads the command's own exit code as the red/green contract. (6) If the issue names more than one wrong output/symptom — or the issue-derived expectation extractor surfaced more than one expected value — assert EVERY one of them in the SAME `repro_issue.py`, as ONE execution (never split witnesses across multiple scripts/runs): wrap each in its own try/except and print one line per witness, `witness[0]: PASS` or `witness[0]: FAIL: <reason>` (0-indexed), before re-raising the first failure — so the run's own output shows N/N passing, never a silently narrowed subset. If, after at most 2 distinct approaches, you genuinely cannot get a repro to fail for the right reason, STOP: mark this item cancelled with a one-line reason and proceed to the fix with explicit caution — do not keep burning budget on the repro alone. (7) When the issue text quotes an exact expression (e.g. `str(self.my_str_value)`), assert THAT EXACT expression called on the exact object it names, not a downstream/derived effect of it (e.g. re-reading a model field elsewhere) standing in as a proxy for it. (8) If the issue's behavior depends on the ambient environment (current date/time, timezone, locale, randomness, hostname), control that input inside the repro — mock or patch it through the module under test's own imports — so the assertion fails deterministically on the unpatched code today. When the RULE the issue states references the current time/date, patch the module-under-test's OWN clock import inside the repro — the way graders do (e.g. mock the module's `datetime`) — and assert the issue's stated boundary under that patched clock; a fix that reads the clock through any other import then stays red in-loop, exposing the bypass before finish. (9) Assert the most direct expression of the wrong behavior the issue names (the exact method, attribute, or return value), using typed equality against the value's natural source (e.g. == field.max_length, not == '254') — never presence, substring, or printed-output checks that a symptom-layer patch could satisfy. When the wrong behavior is a value mirrored into another structure (an attrs dict, headers, serialized params), assert THAT mirrored entry with the same typed equality (e.g. widget.attrs.get('maxlength') == field.max_length) — never the rendered output: string rendering erases exactly the int-vs-'254' difference the grader checks. Prefer %r/repr-shaped formatting expectations exactly as the issue states them — never normalize quote style in expected strings. (10) When the issue states a numeric threshold (\"more than X\", \"at least X\", \"up to X\"), assert AT the exact boundary and on BOTH sides of it — translate more-than vs at-least precisely, and control the clock/environment (e.g. mock the current time) when the boundary depends on it. (11) When the issue states the defect as the construct's GENERAL behavior but demonstrates it through one SPECIAL input class (a translated/lazy value, a subclass, a wrapped object, a value with special characters), assert the SAME contract on a minimal PLAIN sibling input too (one extra assert) — a patch that special-cases only the demonstrated class then stays red on the sibling, exposing the narrowing in-loop. Skip this when the issue's own words scope the defect to the special class alone. (12) When the fix touches one half of a read/write, parse/serialize, load/dump, escape/unescape, or format/parse pair whose OTHER half lives beside it in the same file/class, assert the ROUNDTRIP too (parse -> write -> parse == original) as an additional witness — a fix that only touches one half can look complete while silently breaking the other (astropy-14365 parse-only, 14598 inverted unescape, 14182 param-never-threaded). Template (adapt — keeps the red→green contract: assert the EXPECTED, post-fix behavior, so this exits non-zero via AssertionError on the current buggy code and 0 once fixed): a file `repro_issue.py` at the repo ROOT (never inside tests/), importing ONLY from the installed package (never from tests.* or a test module — define minimal stand-in classes inline instead) —\n```python\n# run with: python repro_issue.py\n# ...minimal setup reproducing the issue scenario...\nactual = <the API-level value the issue is about>\nexpected = <the exact expected value from the issue>\nassert actual == expected, f'BUG: {actual!r} != {expected!r}'\nprint('OK')\n```\nthen run `python repro_issue.py`."

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

/**
 * §3/§11 — stable prefix of the hard-tail deferral consumer's planted slice
 * (`buildDeferralSliceContent`), shaped like `GRIND_DESIGN_SLICE_CONTENT` so
 * the allocator's design rule floors the author at the reasoner and the
 * degraded-filter hatch in slice-orchestrator.ts recognizes the frame by this
 * prefix without re-parsing content.
 */
export const DEFERRAL_SLICE_PREFIX = "HARD-TAIL ESCALATION: "

/**
 * Compiled evidence for one deferral slice — the deterministic signal that
 * fired, its gate evidence verbatim, the pinned probe/red tail if present,
 * enumerated candidates, the issue-stated expectations, and the issue-stated
 * boundary-rule quotes (from `getIssueThresholds`) `buildDeferralSliceContent`
 * renders into the planted brief.
 */
export interface DeferralBrief {
  signal: string
  gateEvidence: string
  probeCommand?: string
  redTail?: string
  candidates: readonly string[]
  expectations: readonly string[]
  statedRules: readonly string[]
}

/**
 * §3/§11 — renders a `DeferralBrief` into the one-shot escalation pre-pass
 * slice the hard-tail signal consumer plants: which deterministic signal
 * fired and its evidence, the pinned probe (+ red tail) if present, an
 * enumerate-then-choose candidate list, the issue's binding expectations and
 * stated boundary rules, and the root-most-fix instruction with the
 * oracle-inversion escape. The brief is compiled from gathered evidence,
 * never freshly prompted.
 *
 * @sem domain=routing role=deferral-brief
 */
export function buildDeferralSliceContent(brief: DeferralBrief): string {
  const lines: string[] = [
    `${DEFERRAL_SLICE_PREFIX}a deterministic signal (${brief.signal}) exhausted its bounded retries — this is a design pre-pass, not another edit-test loop.`,
    `GATE EVIDENCE: ${brief.gateEvidence}`,
  ]
  if (brief.probeCommand) lines.push(`PINNED PROBE: \`${brief.probeCommand}\``)
  if (brief.redTail) lines.push(`RED TAIL: ${brief.redTail}`)
  lines.push(
    "CANDIDATES (choose by evidence, do not invent):",
    ...brief.candidates.map((c, i) => `  ${i + 1}. ${c}`),
  )
  lines.push(
    "EXPECTATIONS (issue-stated, binding — assert these, typed, not rendered):",
    ...brief.expectations.map((e) => `  - ${e}`),
  )
  if (brief.statedRules.length > 0) {
    lines.push(
      "STATED RULES (issue-stated boundary rules, binding — the repro must assert BOTH sides of each):",
      ...brief.statedRules.map((r) => `  - "${r}"`),
    )
  }
  lines.push(
    "Derive the ROOT-MOST fix among the candidates above, apply it, and PROVE it by re-running the pinned probe to green. If the evidence shows the pinned assertion itself contradicts the issue's stated behavior, do not force it green — state that as your verdict instead.",
  )
  return lines.join("\n")
}
