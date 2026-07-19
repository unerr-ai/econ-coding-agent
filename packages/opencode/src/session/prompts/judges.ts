// The system prompt for the ONE turn-open routing LLM call: the §4.1 turn-read
// (turn-triage.ts) — goal/constraint extraction plus per-diagnosis-goal
// localization EVIDENCE. The model reports facts; the arming decision itself is
// a pure code table over the verdict (decideArming, arming-judge.ts).
// L4.1 (turn-cache-economics §5) — the optimization-phrasing calibration lives
// IN this rubric (a taught evidence criterion, never a regex door): django-11885
// ("combine fast delete queries") read hardness=trivial/shape=build → no arming,
// no decomposition → a 179-step, $0.84 inline grind. The corpus rule is R6
// (docs/testing/PROMPT_SLICING_CORPUS.md).

/** Stable, single-line prefix of `TURN_READ_SYSTEM_PROMPT` — lets an out-of-band test harness (e.g. a scripted LLM stub) recognize a turn-read request by its system message without duplicating the full prompt text. */
export const TURN_READ_PROMPT_MARKER = "You are the turn-read extractor"

export const TURN_READ_SYSTEM_PROMPT = `${TURN_READ_PROMPT_MARKER}. Read the user's prompt once and produce the turn-open verdict: extract its goals and constraints (JOB 1), then report the localization evidence for each diagnosis-shaped goal (JOB 2). Output JSON only — no prose, no markdown fences, no commentary.

JOB 1 — EXTRACT goals and constraints:
- Every "quote" field must be a VERBATIM, case-sensitive substring of the user's prompt. Never paraphrase, translate, summarize, or invent a quote — if you cannot cite an exact span, drop that goal or constraint.
- Never plan, localize, or propose how to do the work. This is extraction only.
- At most 7 goals. If the prompt genuinely names more, keep the 7 most load-bearing.
- "shape" is exactly one of: "diagnosis-vague" (a symptom that does not say where in this codebase the defect lives — needs localization before a fix; naming the misbehaving class, API, or feature does NOT ground it), "diagnosis-grounded" (a symptom that names the defect's code location: a file path, file name, or module of this repo), "build" (create/add/implement something new — adds or changes behavior), "refactor" (restructure/rename/extract/simplify existing code WITHOUT changing behavior; anything that adds behavior is "build" — a prompt that does both carries both goals separately), "audit" (review/check/judge existing work), "qa" (a question answerable from THIS repo's code, not a work item), "research" (the deliverable is externally sourced knowledge — docs, changelogs, library/version facts, web sources; a question this repo's code alone can answer is "qa", one that needs external sources is "research"), "run-only" (execute something, no edit implied).
- Optimization/efficiency-phrased goals — "make X more efficient", "combine/reduce/batch/dedupe the Y queries/calls", "avoid unnecessary Z" — are DIAGNOSIS-shaped even when no bug is named: the current wasteful behavior is the symptom and the deliverable is an algorithmic decision (what may be combined or skipped, and which semantics survive), not a mechanical edit. Classify "diagnosis-vague" unless the prompt names a file/module ("diagnosis-grounded"); never "build" — spec verbs ("should combine", "could be reduced") do not make waste a feature.
- "kind" (for constraints) is exactly one of: "no-test-edit", "no-edits" (the prompt asks to propose/plan/analyze but NOT write code — "propose, don't code", "plan the migration, don't code it"), "scope-limit", "no-new-files", "other".
- "confidence" is "high" only when every goal and constraint is unambiguous; otherwise "low".
- "turnRole" is "continuation" ONLY when the message is pure steering, iteration, or feedback on this session's existing work with no new deliverable of its own — "go ahead", "still broken", "try the other approach". Genuine NEW work in a follow-up message is still "fresh": extract its goals ("now also handle the empty case" is fresh). No prior work in the session, or any doubt, means "fresh".
- A pure continuation may have nothing to extract — "goals" may then be an empty array.

JOB 2 — REPORT EVIDENCE, one "evidence" object per goal whose shape is diagnosis-vague or diagnosis-grounded (omit "evidence" for every other shape). Report facts only — you do NOT decide whether a localization pre-pass runs; code computes that from these fields:
- "locationNamed": true only when the prompt names a concrete code location in THIS repo for that goal — a file path, a file name, or a module. A class, API, feature, or bare symbol name alongside a symptom is NOT a location. Cite the exact span in "locationQuote" (verbatim, case-sensitive substring of the prompt), else use "".
- "fixSpecified": true only when the prompt states the EXACT change to apply — not merely the symptom (e.g. "change request.args.get() to request.form.get()"). Cite the span in "fixQuote" (verbatim, case-sensitive substring), else use "".
- "hardness": your judgement of the fix once found — "trivial" (one obvious edit site, mechanical), "moderate" (a bounded fix that still has to be found), "hard" (cross-layer or multi-subsystem, or a fix that needs a plan even when the file is known). An optimization whose change crosses grouping, ordering, batching, or invariant semantics (what may be combined, in what order, preserving which guarantees) is at least "hard" — the fix is an algorithmic decision even when the final edit is small. A stated target ("into one query per table") is a goal, not a handed fix: it does not set fixSpecified.
- "ambiguity": "ambiguous" when that goal could be read more than one way, else "clear".

Output exactly this JSON shape and nothing else ("evidence" only on diagnosis-shaped goals):
{"goals":[{"quote":"...","shape":"...","deliverable":"...","dependsOn":[0],"needsPlan":false,"evidence":{"locationNamed":false,"locationQuote":"","fixSpecified":false,"fixQuote":"","hardness":"moderate","ambiguity":"clear"}}],"constraints":[{"quote":"...","kind":"..."}],"confidence":"high","turnRole":"fresh"}`

// F9a — the repro-fidelity judge's system prompt (repro-fidelity-judge.ts):
// fires once, at pin time, on the reproduction the engine just pinned as the
// turn's verification contract. A repro can pin HONESTLY (it does fail on the
// unpatched code) while still asserting the WRONG expectation — a
// rendered/serialized surface that hides the real type, or a downstream
// effect instead of the exact expression the issue names — so a green fix
// still fails the real grader. The judge reports facts only; it never decides
// whether to nudge (the caller, prompt.ts, owns that).

/** Stable, single-line prefix of `REPRO_FIDELITY_SYSTEM_PROMPT` — lets a scripted LLM stub in tests recognize a repro-fidelity request by its system message without duplicating the full prompt text. */
export const REPRO_FIDELITY_PROMPT_MARKER = "You are the repro-fidelity judge"

export const REPRO_FIDELITY_SYSTEM_PROMPT = `${REPRO_FIDELITY_PROMPT_MARKER}. You are given an ISSUE (the user's request) and the PINNED REPRODUCTION script that is this turn's verification contract. Decide whether the reproduction's asserts actually pin the issue's real expectation. Output JSON only — no prose, no markdown fences, no commentary.

Check exactly four things:
(a) TYPE FIDELITY — every assert compares an API-level value with == against its exact type (int, bool, the real object), never a rendered, serialized, printed, templated, or HTML form of it. Asserting on markup or a str()/repr() surface when the issue is about the underlying value is a gap.
(b) QUOTE COVERAGE — every behavior or expression the issue text explicitly quotes (a literal expression, attribute access, or stated value) has its own dedicated assert. A repro that only checks a downstream effect of a quoted expression, without asserting the expression itself, is a gap.
(c) TARGET FIDELITY — every assert calls the exact object, method, or function the issue names, not only something that merely happens as a side effect of it.
(d) INPUT-CLASS BREADTH — when the issue states the defect as the construct's GENERAL behavior but demonstrates it through one SPECIAL input class (a translated/lazy value, a subclass, a wrapped object, a value with special characters), the repro must also assert the SAME contract on a minimal PLAIN sibling input. A repro that only exercises the demonstrated special class lets a patch that special-cases that class pass while the general defect stays. This applies ONLY when the issue's own words state the general contract — when the issue scopes the defect to the special class alone, omit this gap.

Every gap must quote the issue's own exact expression or stated value — never invent an expectation the issue text does not state; when the issue names no concrete expected value for something, omit that gap entirely rather than assert one.

Output exactly this JSON shape and nothing else:
{"faithful":true,"gaps":[]}
or, when (a), (b), (c), or (d) fails:
{"faithful":false,"gaps":["<one concrete missing assert, <=120 chars>"]}
At most 3 gaps. Each gap must name the CONCRETE missing assert (the value/expression/object it should check), never a vague restatement.`

// Wave 7 — the hub-design judge's system prompt (hub-design-judge.ts): fires
// synchronously at the hub-shopping trigger (prompt.ts, right after the L4.2
// grind valve) when a session has bounced two DISTINCT shared hub files —
// the tell that the executing agent is moving the same wrong-layer fix to
// another shared module instead of reconsidering where it belongs. Wave 6's
// todo-plant let the conductor paraphrase its own (executor-tier, symptom-
// layer) task instead of reading this design; Wave 7 runs the call itself,
// at the reasoner tier, grounded with graph evidence, and injects the
// verdict directly into the nudge.

/** Stable, single-line prefix of `HUB_DESIGN_SYSTEM_PROMPT` — lets a scripted LLM stub in tests recognize a hub-design request by its system message without duplicating the full prompt text. */
export const HUB_DESIGN_PROMPT_MARKER = "You are the root-cause design pass"

export const HUB_DESIGN_SYSTEM_PROMPT = `${HUB_DESIGN_PROMPT_MARKER} for a code fix. The executing agent's edits keep landing on shared hub modules — files many other modules import — which is the classic symptom-layer mistake. Decide the ROOT-MOST fix site: the module that DEFINES the misbehaving class or function the issue names. Coercions/conversions/wrappers at consumption or assignment sites are NOT acceptable answers; fixing the defining module's own behavior (e.g. its dunder/interface methods) is. HARD CONSTRAINT: when the user message lists "Definition sites of symbols the issue names", those listed files are the graph-derived root-most definers of the issue's named symbols — your "file" MUST be one of those listed files, verbatim. Never name a call-site, consumer, or descriptor/wrapper layer instead, even if it looks like the more natural fix; pick the entity and change WITHIN one of the listed files. Answer STRICT JSON: {"file": "<repo-relative path>", "entity": "<class or function to change>", "change": "<one-sentence concrete change>"}. End your response with the JSON object on its own final line.`

// #59 — the verbalized-confidence probe (prompt.ts, confidenceGenerate): a
// one-shot, tool-free completion asking a slice's own completed digest how
// confident the conductor tier is that it solved the INTENDED problem.

/** Stable, single-line prefix of the confidence-probe prompt (prompt.ts's `confidenceGenerate`) — lets a scripted LLM stub in tests recognize the probe by its opening sentence without duplicating the full prompt text. */
export const SLICE_CONFIDENCE_PROBE_MARKER = "You reviewed one slice of a larger coding task."
