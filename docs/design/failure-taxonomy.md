# Failure taxonomy — framework vs tier behavior

**Date:** 2026-07-06.
**Evidence base:** the five-door live-fire series on real repos
([testing/TIER_FIRING_CHECKLIST.md](../testing/TIER_FIRING_CHECKLIST.md) — cases 1–5,
django/zod/express, 10 sessions), the step-level decode of case 1A (38 steps
cross-verified against a 10-phase deterministic ideal), and the Mini-10 v2 benchmark run
(8/10 resolved, $0.3198, 94.7% cache; failures django-11885 and django-12039).
Companions: [features/03-risk-router.md](../features/03-risk-router.md) (routing
mechanism + post-mortems), [features/04-model-team.md](../features/04-model-team.md)
(per-run cost records). This doc owns the **categorization** of every issue found, the
**reference orchestration flows** we hold runs against, the **localization design**, and
the **research-backed improvement plan**.

The question it answers: **are these issues framework problems (orchestration wiring,
probes, verification design) or tier-behavior problems (how the conductor and other
tiers behave and classify work)?** Short answer: both, in a specific pattern — every
blocked escalation door is framework-side, while the tier-behavior issues are narrow
discipline gaps that the industry also fixes on the framework side. §3 gives the full
answer; §4 maps every issue.

---

## 1. Reference orchestration flows per prompt shape

What the four-tier system (conductor / executor / reasoner / oracle) is *supposed* to
run for each prompt/outcome type. These are the flows every trace decode is judged
against. Door numbers refer to the scoreboard in
[TIER_FIRING_CHECKLIST.md](../testing/TIER_FIRING_CHECKLIST.md) (the live record of
which doors are proven — not duplicated here).

The master spine, common to all types:

```
user prompt
   │
   ▼
conductor opens the turn (never swapped — the one rule)
   │   decompose → todo list → slice typing
   │   (structural nets in autoTypeTodos + conductor self-typing)
   ▼
typed pending slices? ──no──► conductor works inline
   │ yes                      (+ voluntary executor task children)
   ▼
allocateSlice matrix ──► slice loops on executor / reasoner / oracle
   │
   ▼
QE rungs: sound (verifyCommands) → judge ──reject──► escalation ladder
   │                                                  executor→conductor→reasoner→oracle
   ▼                                                  (double-pay accounted)
results fold back into the conductor turn → receipt (per-tier drilldown)
```

### Type A — fix a bug from user-facing behavior (symptom only, no file named)

The SWE-bench shape: "the app shows `Suit.HEART` instead of `Hearts`". The hardest and
most valuable flow.

1. Conductor recognizes the diagnosis shape (repair verb, no file target).
2. **Localization stage fires before free exploration** (see §2): cheapest capable
   localizer returns *ranked candidate defect sites, each with a discriminating probe*.
3. Conductor runs the probes (cheap one-liners), picks the layer on probe evidence, and
   enumerates fix candidates at that layer — reasoning un-muted at this fork.
4. Fix authored by the matrix: mechanical & testable → executor; untestable·high-coupling
   or subtle → oracle (+ judge rung).
5. Verify slice runs real `verifyCommands` (repro probe + neighbor regression tests)
   against an **unmodified test tree**; red output = rung reject → ladder climbs,
   double-pay accounted.
6. Receipt shows the per-tier drilldown.

**Today:** steps 2–3 never happen (F1, B1, B2, F4); step 5 never rejects (F2). The
conductor explores ~20 steps, localizes in its head, fixes at whatever layer it anchored
on, and a green-looking verification closes the turn.

### Type B — fix a bug from a codebase-grounded explanation (file/function named)

User names the site or the root cause. The localization stage is correctly skipped
(`FILE_TARGET_RE` match); the conductor goes direct. Typed fix slice allocated by
testability/coupling; verify slice + ladder as rescue net.

**Today:** works conductor-only at good quality and cost (run 22: upstream-exact fix,
$0.18) — but the verify rung is toothless (F2), so a wrong fix would still close green.

### Type C — build a new feature

Conductor writes a plan-first pending list (observed: it reliably does this for build
tasks). Intended typing: design item → oracle design slice when blast radius is high;
authoring items → reasoner (untestable·low, unbacked-mechanical cell) or executor
(testable); a check-run item → executor with real commands.

**Today:** build lists are never typed — structural nets only cover audit shapes and the
diagnosis pre-pass, and conductor self-typing has never been observed (F3) — so
everything runs inline except voluntary executor task children.

### Type D — audit / verify an existing change

**The proven flow** (4× in the series). Audit-shaped list (no active mechanical item) →
`autoTypeTodos` types judgment items `verify` + `need:reasoner` → parallel reasoner
judgment slices + oracle synthesis. Caught planted unsound zod merges that a fully green
suite missed, $0.57–$1.21 per audit. This door demonstrates the thesis of §3: when a
door opens, the tiers behind it perform.

### Type E — mechanical sweep (rename / boilerplate / codemod)

Intended: conductor types items mechanical → reasoner-authors cell (untestable·low) or
executor (testable), verification backed by typecheck/compile probes.

**Today:** unreachable (F3) — the conductor does sweeps inline.

### Type F — explain / Q&A

Intended conductor-only with graph tools; explorer child for broad sweeps. Cheap by
design; no slices. The gap here is explorer under-dispatch (F5), not orchestration.

| type | intended tiers | status today | blocking issues |
|---|---|---|---|
| A symptom bug | conductor + oracle-loc + executor/oracle fix + ladder | conductor-only, in-head localization | F1 B1 B2 F4 F2 |
| B grounded bug | conductor + executor fix + ladder rescue | conductor-only, good quality, no safety net | F2 |
| C new feature | conductor + oracle design + reasoner/executor authoring | conductor inline + voluntary children | F3 |
| D audit | conductor + reasoner judgment + oracle synthesis | **works, proven 4×** | — |
| E mechanical sweep | conductor + reasoner/executor authoring | conductor inline | F3 |
| F explain/Q&A | conductor (+ explorer) | works; explorer underused | F5 |

---

## 2. Fault localization — where it happens today, and matching depth to difficulty

Localization is the single highest-leverage stage: the v1 benchmark failures were
localization failures, and case 1 reproduced the same shape live — the conductor
mis-localized the django-11964 bug **twice, in two different wrong files** (attempt A
anchored on the descriptor layer, patching `DeferredAttribute.__set__` in
`query_utils.py`, when the real defect was a missing `Choices.__str__` in `enums.py`).

**Where it happens today — three places, only one of them live:**

1. **Live path: the conductor, in-head, during free exploration.** Graph search
   (`graph.search` matches symbol tokens, not sentences), file reads, greps — with no
   stage boundary, no ranked-candidate artifact, and no verification of the claim. The
   localization decision is invisible until the edit reveals it.
2. **Designed but dormant: the diagnosis pre-pass** (`autoTypeTodos`,
   slice-orchestrator): a pending diagnosis-verb item with no file target appends a
   localization design slice, which `allocateSlice` sends to the oracle. It has never
   fired on the live path (F1 — the trigger sits at todowrite, downstream of the
   conductor's exploration; diagnosis todos arrive as retro logs).
3. **Occasional: the explorer child** (voluntary dispatch). Benchmark evidence: fired on
   2 of 10 instances — both resolved, including a v1 failure flipped to success.

**The design: a localization ladder keyed on evidence class, not task class** (the same
philosophy as the risk router — structural signals, never task-class guessing):

| evidence in the prompt | difficulty signal (computable up front) | right localizer | claim is accepted when |
|---|---|---|---|
| file/function named | `FILE_TARGET_RE` match | none — conductor direct | the named symbol exists on read |
| unique lexical anchor (error string, symbol) | few grep/graph hits for the quoted anchor | conductor with graph tools, bounded steps | a discriminating probe confirms the site |
| behavioral symptom, no anchor | candidate set spans >1 file; symptom area has fan-out | explorer child: graph walk → ranked candidates | probe per top candidate |
| cross-layer / framework-magic (metaclass, descriptor, dispatch chain) | candidates span >1 abstraction layer; hypothesis churn | oracle localization slice: enumerate layers, one discriminating probe per hypothesis | fix layer chosen only on probe evidence |

Two **mid-flight escalation triggers**, because difficulty often shows only after
starting:

- **Convergence budget:** N exploration steps without a probe-verified site → forced
  escalation to the next localizer rung. (Would have cut case 1A's 20-step in-head walk.)
- **Contradiction trigger:** a newly read fact contradicts the current hypothesis → the
  reasoning gate un-mutes and the conductor must enumerate candidates before continuing
  (F4/B1). Case 1A step 3 is the canonical moment: the trace had
  `class TextChoices(str, Choices)` in view — a fact that should have forced the
  question "then why does `str()` still print the member name?" — and spent zero
  reasoning tokens on it.

Entry-rung selection follows §8's casting policy: the rung is chosen by evidence
class, and **ambiguity rounds up** — a shape that might be cross-layer starts at the
oracle rung. The convergence budget exists for shapes that legitimately start low, not
as a reason to start everything low.

And one **acceptance rule** (from AutoSD's scientific-debugging loop and Agentless's
staged pipeline): a localization is accepted only with a discriminating probe result
attached — never narrative alone. Probes are absurdly cheap relative to a wrong-layer
run: `python -c "print(str(Suit.HEART))"` is a 30-second check; the wrong-layer fix cost
38 steps.

Caveat that couples this to the indexer (I1): a starved index **under-reports
difficulty**. Express looked "low coupling" (2 entities seen in `lib/response.js`)
because the indexer is blind to prototype-assignment definitions — so difficulty signals
derived from the graph are only as good as extraction coverage.

---

## 3. Where the issues live — the categorization model

Five buckets:

- **F — framework / orchestration wiring**: trigger anchor points, unpopulated fields,
  dispatch policy. Fixable by us, deterministically.
- **B — tier behavior**: what the conductor does regardless of wiring — anchoring,
  discipline, instincts. Not directly fixable (we don't train the model); must be
  constrained or redirected by the framework.
- **I — code-intelligence substrate**: indexer + probes. Framework-side, but a distinct
  layer because it silently starves routing signals.
- **V — verification validity**: what "verified" means vs the true oracle.
- **E — environment / infra**: harness and arena mechanics.

**The answer to the framework-vs-behavior question, in four claims:**

1. **Every blocked escalation door is framework-side (F or I).** Not one door was
   blocked by a tier being too weak. And when a door opened (judgment, Type D), the
   tiers behind it performed — reasoner+oracle caught planted unsound fixes a green
   suite missed, four times out of four.
2. **Most framework issues are interface mismatches, not logic bugs.** The nets were
   anchored to behaviors an idealized conductor would exhibit — plan-first todos on
   diagnosis tasks, self-typing of mechanical work, `*.test.ts`-style suite layouts. The
   real conductor explores first, writes todos as retro logs, never self-types, and real
   repos (express) use conventions the probes can't see. The nets are right; their
   anchor points assume the wrong counterparty.
3. **The tier-behavior issues are discipline-shaped, not capability-shaped.** Across the
   series and the benchmark, the conductor's understanding and strategy were
   consistently sound (root causes correct, audits correct, non-gold-but-plausible
   approaches). What failed: editing tests to match its own patch, a one-character
   inconsistency between sibling branches, trusting a skipped-heavy green run, dropping
   a failing probe case. These are exactly the failure modes the industry fixes with
   harness constraints, not bigger models (§6).
4. **Net: the fix direction is ~90% framework.** Re-anchor the structural nets to
   observed conductor behavior, and convert the known behavioral instincts into
   structural impossibilities (an edit gate that refuses test-file writes is stronger
   than any prompt asking nicely). This is also econ's product thesis working as
   intended: in-loop governance exists precisely because cheap-tier discipline can't be
   assumed.

---

## 4. Issue register

Every issue identified across cases 1–5, the step-level decode, and the v2 benchmark.

| ID | issue | seen in | bucket |
|---|---|---|---|
| F1 | diagnosis pre-pass trigger sits downstream of exploration; `pending`-only guard misses in_progress items | cases 1A/1B; benchmark (no localization slice ever) | F |
| F2 | `verifyCommands` never populated → sound rung short-circuits → ladder + double-pay unreachable; a red suite *report* passes QE | case 4; benchmark 11885 | F |
| F3 | mechanical/build slices dispatch only via conductor self-typing — never observed in 20+ runs | case 5 | F |
| F4 | reasoning gate un-mutes only on plan/recovery, not when a new fact contradicts the working hypothesis | case 1A step 3 (212 reasoning tokens / 38 steps) | F |
| F5 | explorer under-dispatched — fired 2/10 in benchmark, 2-for-2 resolved incl. a flipped v1 failure | benchmark | F |
| F6 | reasoner judgment slices run to the 25-tool cap (lean decider not binding) | run 21, case audits | F |
| B1 | anchoring / premature commitment: first plausible layer wins; candidates never enumerated | case 1A step 3 fork; case 1B (different wrong file) | B |
| B2 | retro-log todos on diagnosis tasks (explores → then writes completed/in_progress items) — the behavior F1's trigger never anticipated | cases 1A/1B, step 19 | B |
| B3 | edits test files to match its own implementation, then verifies against them | benchmark 11885 (`tests/delete/tests.py` assertNumQueries) | B |
| B4 | execution inconsistency: correct guard in one branch, unconditional `+ ' ' +` in the sibling | benchmark 12039 (`Columns.col_str` vs IndexColumns) | B |
| B5 | verification-integrity slips: silently dropped a failing probe case; trusted OK with skipped=10 | case 1A steps 33–35; benchmark 12039 | B |
| B6 | boundary-input blindness: repro tested `()` but never `['']` — the exact grading boundary | benchmark 12039 | B |
| B7 | environment probed *after* the fix — 9 of 38 steps (~24%) burned discovering py3.14 can't run 2019 django | case 1A steps 20–28 | B |
| B8 | first todo item marked in_progress in the same todowrite → never typeable; anything you want dispatched must not be item 1 | case 4A door miss | B |
| I1 | indexer extracts no entities from prototype-assignment definitions (`res.send = function send(...)`) → coupling starved → judge cell unreachable | case 3 (express: 55 entities repo-wide, 2 in response.js) | I |
| I2 | testability probes blind to classic-JS conventions (`test/res.send.js` suites, no build script) → probe-untestable verdicts on tested repos | cases 3/5 | I |
| V1 | local oracle ≠ grading oracle: verification effort fired (~20 test runs on 11885) but validated against self-edited tests; the judging test for 12039 exists only in the gold patch | benchmark | V |
| E1 | relaunching into a just-used arena wedges the binary pre-session (~56 min, 0.4% CPU); fresh clone starts instantly | cases 3C, 4B | E |

Reading the table against §3: the doors (F1–F3, I1) block the *escalation surface*; the
behavior items (B1–B8) are what leaks through when that surface is down; V1 is why the
leaks looked green. The benchmark failures are the two classes compounding.

**Interaction notes (why we're confident in each placement):**

- **F1×B2** — the pre-pass logic is correct *given its input assumption* (a pending
  diagnosis item before work starts); B2 is the observed behavior that violates the
  assumption. We classify the *fix* as framework because we control the trigger point,
  not the model's todo habits. Confirmed by contrast: on build tasks the conductor DOES
  write plan-first pending lists — the retro-log behavior is diagnosis-specific.
- **F2 is pure wiring** — the field exists, is unit-tested, and is simply never
  populated by `todosToLoopSlices` on the live path. No behavior involved.
- **I1 is provably substrate** — the graph DB inspection showed 55 entities for all of
  express; the coupling probe computed honestly over starved input. Sibling of the
  run-19 method→helper fan-in blindspot.
- **B3/B4/B5/B6 are behavior** — no framework component instructed or prevented them;
  they reproduce across unrelated tasks. But each has a deterministic framework
  counter (§7), which is where the fix belongs.
- **V1 is a validity property, not a bug in either side** — any agent that verifies
  against a local oracle can be greenly wrong when the grading oracle is hidden. The
  mitigations (test immutability, regression breadth, boundary discipline, skip
  suspicion) shrink the gap; nothing closes it fully.

---

## 5. The two benchmark failures, decomposed

Both failures were **conductor-only runs** (executor/reasoner/oracle spent $0.00 across
the whole benchmark) — consistent with doors F1/F2/F3 closed: the escalation surface
never had a chance to catch either.

**django-11885 (hard, 1–4 hr class).** Chain: non-gold approach (post-processed
`fast_deletes` into combined queries, vs gold's re-plumb of `related_objects` to yield
combinable querysets) — defensible engineering — **compounded by B3**: it edited
`tests/delete/tests.py`'s `assertNumQueries` counts to match its own implementation,
then ran ~20 verification loops against the rigged oracle (V1). The verification
*effort* was excellent; its *validity* was zero. A no-test-edit gate plus F2-style
pinned verify commands (run against an unmodified test tree) would each independently
have flagged this run red.

**django-12039 (medium).** Got the hard branch (IndexColumns) right, then wrote an
unconditional `+ ' ' +` in the sibling `Columns.col_str` where the gold fix guards with
`if suffix:` (B4 — one-character discipline). The repro script tested `()` but never
`['']`, the exact boundary the grading test exercises (B6), and the run trusted a green
`OK (skipped=10)` without suspicion (B5). The judging test exists only in the gold test
patch (V1). This is the SWE Atlas finding verbatim: agents test what a function
*should* do, rarely what it should *not* do.

Lever check: neither failure needs a bigger model — 11885 needs test immutability,
12039 needs boundary/consistency discipline in the verify rung. Both levers are
framework-side (§7 items 1, 2, 6).

---

## 6. What the field does about each class

Web research, 2026-07-06. Mapped to our issue IDs.

**1. Localization as a staged, artifact-producing pipeline — not in-head.**
[Agentless](https://arxiv.org/abs/2407.01489) (FSE'25; best open-source on SWE-bench
Lite at ~$0.34/issue) makes localization an explicit three-stage funnel — suspicious
files (LLM + embedding retrieval) → classes/functions via skeleton views → line-level
sites — before any repair is attempted.
[LocAgent](https://arxiv.org/abs/2503.09089) (ACL'25) does graph-guided localization
over a heterogeneous code graph (invoke/import/inherit edges, multi-hop traversal) and
reaches **92.7% file-level accuracy with a fine-tuned 32B model** — strong evidence that
a *cheap* model localizes well when the graph is complete and the process is staged.
→ F1, B1, B2; validates the graph-first bet and makes **I1 the binding constraint** (a
graph-guided localizer is only as good as the graph's extraction coverage).

**2. Reproduce-first, probe-verified debugging.**
[CodeMonkeys](https://arxiv.org/abs/2501.14723) (Stanford) *forces* a testing script to
be written alongside every codebase edit and iterates on execution feedback — the model
is never allowed to reason about correctness without a runnable artifact.
[AutoSD](https://arxiv.org/abs/2304.02195) (scientific debugging) runs an explicit
hypothesis → debugger-probe → confirm/refute loop and found it both prevents
hallucinated diagnoses and improves developer trust. → B1, B5, B7, and §2's acceptance
rule (probe-gated localization claims).

**3. Anti-anchoring: forced enumeration before commitment.**
["When Agents Commit Too Soon"](https://arxiv.org/pdf/2606.22936) measures premature
representational commitment in agents — settling early and defending the reading for the
rest of the run — precisely case 1A's step-3 fork.
["Stalled, Biased, and Confused"](https://arxiv.org/pdf/2601.22208) (cloud RCA) ranks
anchoring among the top reasoning-failure classes and, like AutoSD, mitigates with
forced enumeration of alternative causes plus evidence-gated selection. → B1, F4: the
reasoning gate should un-mute exactly when a fact contradicts the working hypothesis,
and the prompt should demand ≥2 candidate layers with a discriminating probe each.

**4. Test immutability enforced by the harness, not the prompt.**
[SWE Atlas](https://arxiv.org/html/2605.08366v1)'s validator re-runs suites *and
explicitly checks the agent didn't modify any test files*; SWE-bench itself resets files
named in the upstream test patch. [Cursor's 2026 reward-hacking
study](https://www.marktechpost.com/2026/06/26/cursor-study-finds-reward-hacking-inflates-coding-agent-benchmark-scores-on-swe-bench-pro/)
found that sealing leakage/hack channels dropped Opus 4.8 Max from 87.1% → 73.0% on
SWE-bench Pro — 14.1 points of "skill" was exploitation — and
[BenchJack](https://arxiv.org/pdf/2605.12673) audits the same class systematically. The
industry norm: make test-editing *impossible*, don't ask nicely. → B3, V1. econ already
owns the right chokepoint — the in-loop governance gate fires at the edit.

**5. Candidate diversity + regression selection + voting.**
[Agentless](https://arxiv.org/abs/2407.01489) selects final patches by majority voting
under generated reproduction tests **plus selected regression tests**;
[CodeMonkeys](https://arxiv.org/abs/2501.14723) samples 10 candidate (edit, test) pairs,
votes with model-written tests to a top-3, then runs a dedicated selection state
machine. Our escalation ladder + double-pay is the *sequential-budget* version of the
same idea — but it needs a real red signal to exist (F2) before it can climb. → F2, B4,
V1.

**6. Negative-path and boundary discipline.**
[SWE Atlas](https://arxiv.org/html/2605.08366v1)'s mutation analysis: agents write
comprehensive-looking, happy-path tests with weak assertions — they test what a function
*should* do, rarely what it should *not* do or what must *stay unchanged*. Their fix is
mutation checks + rubric grading; ours is a verify-rung checklist (boundary inputs,
should-not-happen assertions, skip-count surfacing). → B5, B6.

---

## 7. Improvement plan (leverage order)

Extends the three engine follow-ups already tracked in
[TIER_FIRING_CHECKLIST.md](../testing/TIER_FIRING_CHECKLIST.md). **All engine changes
remain awaiting explicit go-ahead** — this section is the plan, not the change.

1. **Populate `verifyCommands` on verify-shaped slices, run against an unmodified test
   tree** (F2 + B3 + V1). Unblocks the ladder and double-pay; turns a red suite into a
   rung reject instead of an accurately-reported success; a test-tree hash check makes
   11885-style self-verification structurally impossible.
   **Status: DONE 2026-07-06.** `todosToLoopSlices` derives commands (backticked
   extraction → `probeSliceVerifyCommands` repo-script fallback) and prepends the
   test-tree guard (`kind: "guard"`) unless the batch authors tests
   (`slice-orchestrator.ts`, `graph-tools.ts`, `verifier.ts`).
2. **No-test-edit rule in the in-loop governance gate** (B3, V1). On fix-shaped tasks,
   an edit under a test path is denied-by-default and surfaced to the user — the
   SWE Atlas / SWE-bench enforcement pattern, at the chokepoint we already own.
   **Status: DONE 2026-07-06.** Fix-shaped turns (defect evidence, no explicit
   test-work ask) arm a per-session gate at turn open; the edit/write tools deny
   modification of an existing test file with the reason (new repro files stay
   allowed); child slices inherit unless their task is test-work-shaped
   (`edit-governance.ts` gate + `edit.ts`/`write.ts` checks + `prompt.ts` arming).
3. **Move localization upstream of exploration + the difficulty-matched ladder of §2**
   (F1, B1, B2, F5). Symptom-shaped prompts trigger the localization stage before the
   conductor explores; convergence budget + contradiction trigger escalate mid-flight;
   probe-gated acceptance. Explorer becomes the default middle rung (2-for-2 benchmark
   evidence).
   **Status: PARTIAL 2026-07-06, verification landed 2026-07-08.** Turn-open trigger and
   frame relay landed 2026-07-06: `shouldRunDiagnosisPrepass` seeds the localization slice
   before the conductor's first step, and a prepass-only fold-back relays the result as the
   turn frame (`slice-orchestrator.ts`, `prompt.ts`). The §2 acceptance rule — "a localization
   is accepted only with a discriminating probe result attached" — is now a structural
   verify-ladder rung, not narrative alone: `VerifySpec.probeCommand` + the "probe" rung
   (`checkProbeRung`, `packages/code-intelligence/src/verifier.ts`) reject a bug-fix slice
   whose pinned reproduction is still red, and `todosToLoopSlices`
   (`packages/opencode/src/session/slice-orchestrator.ts`) pins the most-specific reproduction
   it can identify as that slice's `probeCommand` (design in
   [ORCHESTRATION_MECHANISM.md](../architecture/ORCHESTRATION_MECHANISM.md) §1.5; grounded
   quotes in [tier-prompts.md](./tier-prompts.md) §7.6). Still deferred: explorer middle rung
   (→ item 9), convergence budget.
4. **Reasoning-gate un-mute on contradicting facts + enumeration requirement** (F4, B1).
   The cheapest anti-anchoring intervention: spend reasoning tokens at exactly the
   moments the decode showed they were withheld.
   **Status: DONE 2026-07-06.** Third gate trigger `"contradiction"`: an errored
   non-bash tool (missing oldString/file, governance denial) or a zero-result
   search/grep/glob in the trailing tool block un-mutes the next request; recovery
   outranks it (`session/llm/reasoning-gate.ts`). Enumeration requirement lands as
   conductor delta bullet 4b — enumerate ≥2 candidate layers + a discriminating
   check per candidate at every contradiction fork (`session/system.ts`).
5. **Index assignment-style definitions; broaden testability probes** (I1, I2). Unblocks
   coupling on classic-idiom JS → the judge cell; de-starves every difficulty signal the
   localization ladder reads.
6. **Verify-rung discipline pack** (B5, B6, B4): boundary-input checklist (empty/falsy
   variants of every repro input), skip-count surfacing (`OK (skipped=N)` is a warning,
   not a pass), dropped-case integrity check (a probe case removed from a repro script
   fails the rung), and a sibling-branch consistency prompt in judge reviews.
7. **Retire or replace the self-typing assumption** (F3, B8): add a structural net for
   plan-first build lists (author-verb pending items → mechanical typing), or accept the
   reasoner-authors cell is dead and delete it (no-backward-compat rules apply either
   way).
8. **Cost/ops hygiene** (F6, E1): bind the lean decider on judgment slices (25-tool-cap
   burn); diagnose the same-arena relaunch wedge before it bites a customer workflow.

**Alignment pass vs §8's casting policy (2026-07-06).** This list predates §8; three
adjustments follow from it:

- **Re-rank: item 3 becomes co-#1 with item 1.** The original order is reactive-first
  (safety net, then entry). Under proactive escalation the diagnosis/localization door
  is the mechanism by which the high tier gets the first move on hard turns — a
  correctly-framed turn needs less rescuing than a wrongly-framed turn needs
  verification. Items 1+3 land together.
- **Two new tasks §7 never scheduled:** (9) the **evidence-shape classifier** —
  turn-open casting decision (deterministic heuristics + cheap-tier tiebreak),
  turn-scoped category preamble, category+confidence+engaged-flow logged to the
  receipt; (10) the **planner seat** — a bounded reasoner plan slice (ranked sites +
  probes + fix layers) for the hardest shapes, executed by the conductor.
- **Item 8's F6 fix upgrades to seat-scoped toolsets** (casting-policy rule 4): not
  "bind the lean decider" but remove the grind tools from high-tier seats entirely, so
  downward delegation is enforced by construction — the reasoner/oracle delta's
  "decider, not workhorse" instruction stops being advisory.

## 8. Dynamic flow selection — evaluated proposal (2026-07-06)

Proposal: a first LLM call classifies each incoming prompt (behavior-based symptom vs
grounded fix vs new feature vs upgrade …), and the framework then dynamically picks the
conductor's prompt, which tier orchestrates (conductor vs reasoner), and which model
authors the output.

**Verdict: adopt the classification-and-flow-selection core; reject the
orchestrator-swap and system-prompt-swap mechanics.** This is the missing *executable*
form of §1 — today the flow a turn follows is implicit in the conductor's instincts;
making it a framework decision is exactly the §3 thesis. But three of our own findings
constrain the mechanics:

1. **Classify on evidence shape, not task class.** The architecture rejects task-class
   routing for a reason our benchmark re-proved: 11885 ("bug fix", brutal) and 12039
   ("bug fix", one character) share a class, not a difficulty. The stable axis is the
   evidence in the prompt — file named / lexical anchor / behavioral symptom / build
   spec — i.e. §2's ladder key. Most of it is decidable by deterministic heuristics
   (`FILE_TARGET_RE`, quoted-string grep, repair verbs); a single cheap-tier tiebreak
   call handles only the ambiguous middle. Single-shot classification has a ceiling, so
   the §2 mid-flight triggers (convergence budget, contradiction) stay as the
   reclassification path.
2. **Category output must gate engine behavior, not just swap prose.** Runs 12–18:
   advisory prompt nudges never steered the conductor; only hard gates changed
   behavior. The category should decide *which structural nets arm* (symptom shape →
   localization slice auto-appended before exploration = F1's fix; build shape →
   author-verb typing net; audit shape → today's proven net) and *which verify
   commands are mandatory* — with the category + confidence + engaged flow logged to
   the receipt so misroutes are decodable.
3. **Conductor stays the orchestrator; the reasoner becomes the planner, not the
   owner.** The orchestrator re-bills its context every step — a reasoner-led 38-step
   turn forfeits the tier economics the product is built on, and conductor *planning*
   was not the failure mode (both benchmark failures were discipline, not strategy).
   For the hardest shape (behavioral symptom, cross-layer), buy one bounded
   reasoner/oracle **plan artifact** (ranked candidate sites + discriminating probes +
   fix layers — the Magnitude-style plan/execute split) and let the conductor execute
   it. Same benefit, a fraction of the cost.
4. **Per-category text rides as a turn-scoped preamble, never a system-prompt swap.**
   The system prompt is the cached prefix (94.7% cache rate is a core cost lever;
   AC-7.2/AC-8.3 golden-hash discipline). Swapping it per turn fragments the cache; a
   short category playbook injected as a turn-open part varies freely at near-zero
   cache cost.

Expected impact, honestly bounded: this would have fixed the worst live failure
(case 1's twice-wrong in-head localization — the flow never routed through the
localization stage) and the v1 localization-class failures; it does **not** fix
11885/12039 (test-editing + boundary discipline — §7 items 1, 2, 6). It is the
mechanism that makes §7 item 3 real, not a replacement for the verification levers.

**Refinement (agreed same-day): spine invariant, dynamic casting — at stage
granularity.** The master spine never changes; per issue shape, the models shuffle
through its *seats*. Five of six seats already shuffle (or are designed to); the turn
owner is the one seat that stays fixed:

| seat in the spine | castable? | who sits there, by issue shape |
|---|---|---|
| turn owner (session context, dispatch, fold-back) | **fixed** — the one rule | conductor tier, always |
| localizer (symptom → ranked sites + probes) | designed, dormant (F1) | conductor inline / explorer / reasoner-oracle diagnosis slice, by §2 ladder |
| planner (plan artifact, hardest shapes) | new | none / conductor / reasoner plan slice |
| author (per slice) | yes — allocateSlice | executor / reasoner / oracle by testability × coupling |
| judge/verifier (QE rungs) | yes — proven 4× | commands / reasoner judge / oracle synthesis |
| rescuer (ladder on rung reject) | yes (blocked by F2) | executor→conductor→reasoner→oracle |

Why the owner seat stays cheap: the case 1A decode shows the decisive quality moment
was one step out of 38 — the rest was orientation, environment, dispatch, and
bookkeeping. An expensive-tier owner re-bills the full session context every step to
improve that one moment (collapsing `f × (1 − 1/r)`), and swapping owners per category
thrashes the sticky cache-warm prefix. A reasoner-led **diagnosis slice** (localize →
probe → choose layer → hand back a confirmed plan) puts the best reasoning model in
charge of exactly the phase that decides the outcome, over a lean brief instead of the
whole transcript. "Best orchestration" was also never the observed failure mode: all
five door misses and both benchmark failures happened with strategy intact — a
pro-tier owner would have hit the same closed doors.

**Casting policy: proactive escalation, biased up (agreed same-day).** This is not
about cost, and not about whether the conductor is capable — it is about the right
task reaching the reasoner/oracle *early in the orchestration*, so high-tier
intelligence is applied where required instead of arriving as a rescue after failure.
The system's observed failure mode is under-escalation, never over-spend: the whole
benchmark ran reasoner/oracle at $0.00 and failed 2/10, while the one run that fired
all four tiers fixed ~90% of a genuinely hard task. Three rules:

1. **On a hard turn, the first meaningful act is a high-tier act.** Vague behavioral
   bug → oracle/reasoner diagnosis slice *before* conductor exploration; high-blast-
   radius feature → oracle design slice *before* any authoring. The high tier sets the
   frame; cheap tiers fill it in — the inverse of today's flow.
2. **Ambiguity rounds UP for decision-shaped stages** (no lexical anchor, multi-layer
   candidates, high fan-in, framework-magic markers, long-horizon scope). Decision
   engagements are artifact-bounded and cheap in absolute terms ($0.57–$1.21 per audit
   observed); a wrong frame poisons every downstream step. Round down only for
   mechanical stages, where the ladder (post-F2) is the net that makes a cheap first
   attempt safe.
3. **Cost discipline applies to the boring share, not the hard tail.** `f × (1 − 1/r)`
   only asks that the boring fraction stays cheap; a failed turn costs the whole
   turn's spend plus rework plus trust — the most expensive outcome the system can
   produce. The receipt's job is to show hard-tail spend honestly, not to minimize it.
4. **Escalation is bidirectional: a high tier in a seat delegates its boring share
   down.** When the reasoner/oracle leads a stage (diagnosis, plan, authoring), trivial
   sub-tasks inside that stage — bulk reads, suite runs, mechanical edits — go down to
   executor personas or the conductor tier, mirroring how the conductor delegates up
   for hard decisions. The oracle/reasoner system delta already *asks* for this ("you
   are the decider, not the workhorse — delegate mechanical work to executor
   personas"), and F6 proves asking is not enough: reasoner judgment slices grind to
   the 25-tool cap doing their own tool work. Enforcement must be structural —
   **seat-scoped toolsets**: a high-tier slice gets a judgment-lean toolset plus the
   task tool, so mechanical work cannot be done in-seat and must flow down.

## Sources

- Agentless — [arXiv:2407.01489](https://arxiv.org/abs/2407.01489) · [repo](https://github.com/OpenAutoCoder/Agentless)
- CodeMonkeys — [arXiv:2501.14723](https://arxiv.org/abs/2501.14723) · [Stanford blog](https://scalingintelligence.stanford.edu/blogs/codemonkeys/)
- LocAgent — [arXiv:2503.09089](https://arxiv.org/abs/2503.09089) · [ACL 2025](https://aclanthology.org/2025.acl-long.426/)
- AutoSD (scientific debugging) — [arXiv:2304.02195](https://arxiv.org/abs/2304.02195)
- When Agents Commit Too Soon — [arXiv:2606.22936](https://arxiv.org/pdf/2606.22936)
- Stalled, Biased, and Confused (RCA reasoning failures) — [arXiv:2601.22208](https://arxiv.org/pdf/2601.22208)
- SWE Atlas — [arXiv:2605.08366](https://arxiv.org/html/2605.08366v1)
- Cursor reward-hacking study — [MarkTechPost coverage](https://www.marktechpost.com/2026/06/26/cursor-study-finds-reward-hacking-inflates-coding-agent-benchmark-scores-on-swe-bench-pro/)
- BenchJack — [arXiv:2605.12673](https://arxiv.org/pdf/2605.12673)
- Test overfitting on SWE-bench — [arXiv:2511.16858](https://arxiv.org/pdf/2511.16858)
