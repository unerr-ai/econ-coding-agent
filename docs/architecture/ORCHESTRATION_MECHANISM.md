# The econ Orchestration Mechanism

**Status: v1.7 (2026-07-10) — implemented and always-on: the merged turn-read + code-decided arming (U1's successor — one temp-0 extraction call, `decideArming` pure table, neutral degrade, continuation turns; `48a3499ce`, `e372a3c1d`), goal-tracked open (U2), containment bracket (U3), the pre-dispatch evaluator (U4), the M2/M3/M4 gates, the uncertainty-management engine (§8 — prior-resolution phase, two-axis allocation, posterior-uncertainty gate, wired re-decomposition), and the 2026-07-10 improvement round's P6 (blocked slices, scope-overlap serialization, live venue inputs — `229a9303a`, `5ce310868`), P8–P10 and P12 (`229a9303a`), and P3/P4 taxonomy fills (research/refactor shapes, no-edits gate — `e372a3c1d`); live-fire smoked. In progress: P11 (model-initiated tier delegation, W4). Open work: the §6 SM-series hardening and #62 (perplexity activation — blocked on gateway streaming-logprobs support, §8.5). U5 (cache-aware casting) was CUT 2026-07-10: the helper was deleted unwired — its evaluator input was never populated — and the cache economics stay live via session affinity + per-turn hysteresis.**
This doc also absorbed the still-relevant content of the three retired plan docs
(DECOMPOSITION_ORCHESTRATION_PLAN, PERSONA_ORCHESTRATION_PLAN, SELF_ORCHESTRATION_PLAN —
deleted 2026-07-07) into §7 "Inherited foundations".
The turn-read runs on every fresh root turn open with no feature flag (base-flow features ship
enabled; mock-provider test harnesses switch the turn-open calls off via the
`SessionPrompt.TurnOpenCalls` service). Two live-fire lessons hold from the smoke: small
(housekeeping) calls skip the adaptive reasoning gate (un-muted thinking starved the extraction
JSON), and the merged call's blocking cap is 12s (`TURN_READ_TIMEOUT_MS` — the whole turn-open
budget now; the old two stacked calls capped at 22s worst-case). All research
streams are in (Claude Code source recon, econ seam map, routing/triage literature, cache
economics, hierarchy/fan-out); every §5 decision is closed; §6's U1–U4 + U3 have shipped (always-on), leaving the SM-series as the open build (U5 was cut 2026-07-10). Companion docs:
[ECON_ARCHITECTURE](./ECON_ARCHITECTURE.md) (whole-system design),
[failure-taxonomy](../design/failure-taxonomy.md) (the evidence this doc is built on; its §8
holds the flow-selection verdict + casting policy this doc extends),
[cross-tier-context](../design/cross-tier-context.md) (how tiers share context),
[TIER_FIRING_CHECKLIST](../testing/TIER_FIRING_CHECKLIST.md) (live-fire playbook).

econ runs a team of models at different pay grades — executor (junior), conductor (team
lead), reasoner (specialist), oracle (principal). The orchestration mechanism is everything
that happens between "user hits enter" and "the receipt prints": understanding the request,
splitting it into tracked goals, deciding who works on what, checking the work, and cleaning
up when an attempt fails. This doc is the single home for that mechanism's design.

---

## 1. The new mechanism — a prompt's journey

The whole pipeline, end to end. Stages tagged **NEW** were the upgrades this doc introduced
— all have since shipped (see the status header); §2 has the as-built detail.

```
 user prompt
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [1] UNDERSTAND (turn-read) ── ONE merged temp-0 LLM call →      │
 │     goals + constraints + evidence; arming decided in CODE      │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [2] TRACK ── every goal becomes a todo at turn open (NEW:       │
 │     skeleton written before the conductor's first token);       │
 │     constraints arm hard gates; frame slices seeded per goal    │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [3] EVALUATE ── NEW: pre-flight check per task, AT DISPATCH:    │
 │     difficulty + blast radius + verifiability + history →       │
 │     pick the tier, UP or DOWN                                   │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [4] EXECUTE ── seat-scoped child sessions (exists): lean brief, │
 │     persona, step budget; deciders can't edit, runners can't    │
 │     write, the conductor never grinds                           │
 └─────────────────────────────────────────────────────────────────┘
    │
    ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ [5] VERIFY ── 5-rung ladder (exists): run the actual build/     │
 │     tests, watch for test-dodging, case-count shrink, skips     │
 └─────────────────────────────────────────────────────────────────┘
    │ pass                          │ reject
    ▼                               ▼
 fold-back → receipt      ┌──────────────────────────────────────┐
                          │ [6] CONTAIN ── NEW: restore the tree │
                          │     to pre-attempt snapshot; failed  │
                          │     diff becomes advice, not residue │
                          └──────────────────────────────────────┘
                                    │
                                    ▼
                          ┌──────────────────────────────────────┐
                          │ [7] ESCALATE ── one tier up (exists),│
                          │     both attempts on the receipt     │
                          │     (double-pay) → back to [3]       │
                          └──────────────────────────────────────┘
```

**The uncertainty-management overlay (§8).** The pipeline above is the mechanical spine; §8
adds one orthogonal principle on top of it — route by the *type* of uncertainty. Before [3]
EVALUATE, a **prior-resolution** gate (§8.2) settles an ambiguous approach *before* decomposing;
the allocator itself is reframed onto **two axes** (§8.3 — generator ← difficulty, verifier ←
consequence); and at [5] VERIFY, a **posterior-uncertainty** gate (§8.4) can escalate a slice
that passed but that we were unsure about. Those overlays are documented together in §8; the
stage descriptions below are unchanged.

### 1.1 Understand: one merged read of the prompt, judged in code

A single label per prompt breaks on compound requests — *"audit these five fixes, fix the
profile-name bug users are reporting, and don't touch any tests"* has three intents and fits
no single label. Goal decomposition is the answer — and the whole read happens in **one**
call.

The first act of every fresh turn is the **turn-read** (`runTurnRead`, `turn-triage.ts`):
one small, fast LLM call (conductor tier, its own tiny context, temperature 0, forced JSON,
~2s median, still well under a cent) that fills a strict form — the goals, the constraints,
a confidence, the turn's role (fresh vs continuation), and, per diagnosis-shaped goal, the
localization **evidence**:

```
goals:
  1. "Audit the five fixes…"            → shape: audit
  2. "fix the profile-name bug…"        → shape: diagnosis-vague
     evidence: locationNamed=false, fixSpecified=false, hardness=moderate
constraints:
  - "don't touch any tests"             → kind: no-test-edit
confidence: high    turnRole: fresh
```

Three rules keep the cheap model honest (each backed by the research in §3):

- **It can only quote, never invent.** Every goal and constraint must be a verbatim span of
  the user's prompt, and we validate that the span exists — an evidence claim without its
  quote degrades to `false`. The turn-read cannot hallucinate work, and it cannot start
  planning — extraction only.
- **It reports facts; code makes the decision.** The model answers a fixed form, not an open
  question — the forced schema is what makes the call reliable and cheap, and why the
  conductor tier suffices without waking a heavyweight reasoner (the tier floor runs the
  other way too: splitting a nuanced compound prompt is where small models measurably fail —
  §3.2 rule 5, so this call runs on the conductor, not the executor; §4.1). The arming call
  itself — does this turn need a localization pre-pass? — is a **pure code table over the
  extracted evidence** (`decideArming`, §8.1), never the model's ruling.
- **If it fails, the turn degrades neutrally.** A completed-but-invalid answer retries once;
  a still-null verdict re-asks ONCE on the reasoner (a different model family — a genuinely
  independent failure domain); still null → the turn proceeds with **no preamble, no
  skeleton, and arming stood down**. There is no regex fallback — a wrong guess steers the
  conductor worse than no guess (P5) — and a null-rate counter (`turnReadNulls`/`turnReads`)
  meters the degrade path.

**Follow-up turns are modeled, not re-read (P4).** A short, code-free ack on a session with
prior turns ("go ahead", "still broken") short-circuits the call entirely; anything longer
pays the call and the model's `turnRole` decides. A **continuation** inherits the last fresh
turn's verdict, preamble, arming decision, and pinned reproduction (`turn-read-store.ts`)
instead of re-deriving them — so re-fired diagnosis language cannot re-arm a settled
pre-pass; it routes to re-verify — and stands down the resolution gate, the skeleton reseed,
and the per-turn resolve-budget reset (§8.2). Genuine new work in a follow-up message is
still fresh: its goals are extracted normally.

### 1.2 Track: goals become todos before any work starts

If triage found more than one goal, the todo list is written **at turn open** — before the
conductor produces its first token. The conductor wakes up to a tracked plan instead of a
wall of text. This finishes a journey we've already been on: live fire proved the cheap
conductor won't reliably *type* todos (structural nets now do it), and this step stops
trusting it to *create* them, too.

Each goal also brings its own setup, and the seed follows the goal's shape (P12): a
symptom-shaped goal seeds the **localization writer** pre-pass when the arming decision arms
it (`decideArming`, §8.1; the difficulty-allocated generator localizes *and* fixes — the
door that produced the django gold-file fix; it owns edit → run → verify per §1.4's
correction, rather than handing a plan down); a hard **build** goal (`needsPlan`) seeds the
**plan** pre-pass instead — a forward-looking, edit-free decomposition brief
(`PLAN_SLICE_CONTENT`) that delivers a DAG of typed slices, never the bug-hunt (a feature
with no bug and no failing test must not receive a "run the failing test" brief); a
build-list goal arms the mechanical dispatch net; and every extracted constraint arms a
*hard* gate — "don't touch tests" becomes an edit-time block, and "propose, don't code"
(the `no-edits` kind, P3) becomes a hard deny on **every** edit/write for the turn (children
inherit it; a continuation disarms it — "go ahead" after a plan-only turn IS the user
lifting the prohibition). The negation bug we hand-patched ("Do not modify any test files"
accidentally *disarming* the gate) becomes structurally impossible: the constraint is
understood, not pattern-matched.

**The list is a tree, executed as a star.** Goals from triage form the top level; each goal
decomposes into its own child items, and those into sub-items where genuinely needed. Two
caps keep the tree honest — both set by the evidence in §3.4, not by taste:

- **Data depth ≤3** (goal → task → sub-item). Recursive decomposition measurably helps up
  to depth 2–3 and falls off past it (error compounding, context fragmentation).
- **Branching 3–5 per node.** Parallel fan-out pays off at 3–5 independent branches; past
  ~5, coordination overhead and tail latency eat the speedup. A task that keeps failing
  gets a *higher tier*, not a wider fan-out.

Unrelated goals run as **parallel instances** — two independent goals can each get their
own child session at the same time, on the same tier or different tiers (the zod run
already does this for slices; the tree extends it to whole goals). But the tree is a
*tracker* structure, not an execution hierarchy: **children never spawn grandchildren.** A
child that discovers its task needs further splitting returns the sub-plan to the
conductor, which re-dispatches — recursion happens *through the hub*, never below it. The
write-heavy-agent evidence is unambiguous that executed depth fragments context (§3.4);
read-only exploration inside a research child is the one place a second level is allowed.

```
   tracker (tree, depth ≤3)              execution (always a star)
   goal A ── task A1                            conductor
          └─ task A2 ── sub A2a                ╱    │    ╲
   goal B ── task B1                     child(A1) child(A2) child(B1)
                                         parallel, ≤3–5 live at once;
                                         a child needing a further split
                                         folds its sub-plan back to the hub
```

**Correction (2026-07-08, SM-series):** the tree above governs *mechanical* decomposition —
splitting a build-list or an audit into independently verifiable pieces. An atomic-insight
bug (one line of correct code away, but the "one line" takes real reasoning to find) does
not decompose usefully; it routes **whole** to a reasoning tier that owns edit → run →
verify end to end. Decomposition's job is peeling off the mechanical propagation around an
insight, never slicing the insight itself (see §7.2's matching correction).

### 1.3 Evaluate: a pre-flight check before anyone is hired

This is the third mechanism the system has been missing. Today a task's tier is decided
once, from static metadata, when the plan is written — and the only thing that ever changes
it is a *failure* after the money is spent. Neither vibes nor failure: every task gets
**evaluated at dispatch time**, and the evaluation can move the tier in *both* directions.

The evaluator's inputs, all cheap to read:

| signal | question it answers |
|---|---|
| graph probes (fan-in, blast radius) | how much breaks if this goes wrong? |
| verify strength (tests exist? commands derived?) | will a failure even be *detected*? |
| triage shape + difficulty | what kind of work is this, per the goal it serves? |
| attempt history + prior-failure notes | has this slice (or this entity) burned us before? |

And one rule does most of the deciding: **verification strength is what makes a cheap
attempt safe.** If the work is well-tested and cleanly revertible, giving it to the junior
is a bounded gamble — worst case we lose a few cents and escalate. If verification is weak
*and* the blast radius is high, a cheap failure would be silent and expensive — so the
senior goes first. Ambiguity still rounds **up** for decision-shaped work (the §8 casting
policy), and rounds **down** only for mechanical work sitting inside a strong safety net.

The evaluator also decides **who executes — the working thread itself, or a child** (the
venue). Spawning is not free: a child duplicates context the parent already holds warm (a
brief compile plus a cold cache write), and indiscriminate multi-agent use runs up to ~15×
the tokens of a single thread (§3.4). Hence the affinity rule: **if a subtask runs on the
same tier as the thread already working, and mostly needs context that thread already
holds, it runs inline — no child is spawned.** Delegation is for the cases where it earns
its cost: the tier changes, the needed context genuinely diverges (a lean brief suffices),
or the work is read-only and parallelizable — the one shape where fan-out reliably pays.
One or two small same-tier items are always cheaper done inline than spawned.

The evaluator also re-runs mid-flight: a slice that stalls (no progress, contradicting
evidence) doesn't just get a nudge — it gets *re-classified* ("is this harder than we
thought?"), which the literature finds catches 60–70% of misrouted-hard tasks before the
budget burns (§3.2, rule 3).

### 1.4 Execute: the right seat, with the right tools removed

Work runs in child sessions with **seat-scoped toolsets** — but the seat, not the tier,
decides which tools are removed. A senior brought in to *decide for a fan-out* (plan a
build-list, judge/audit someone else's work) physically cannot edit files or run shell
commands — deciding is the job, grinding is delegated down. A runner brought in to *execute
a build* cannot edit. Every child gets a lean compiled brief, never the session transcript.
(Proven live: the zod runner ran the build with edit permissions denied.) Step budgets
follow difficulty (P8, `sliceStepBudget`): a design-typed slice, a judge-rated-hard turn, or
an escalated rescue dispatch gets ×1.5 the persona's step cap — exhaustion is not graceful
(a `[BUDGET EXHAUSTED]` digest fails verification and the ladder double-pays a rescue), so
the hard tail buys its headroom up front.

**Correction (2026-07-09):** tool-removal is scoped to those *decider* and *build-runner*
seats — not to every high-tier child. The **diagnosis pre-pass** (§1.2's atomic-insight
route, §7.2) is a **writer**, not a planner: it localizes, applies the
minimal fix, and runs the failing test to green — it owns edit → run → verify end to end,
because handing an atomic insight off to a second seat costs more context-switching than it
saves (the authoring seat already holds the diagnosis warm). The old "django planner delivers a
ranked plan in 9 read-only steps, executor applies it" split is retired for this path: a
read-only pre-pass has no test-run stopping signal, so it wandered its budget and shipped
empty patches. The pre-pass now writes; it falls back to a *ranked-candidates* hand-off to
the conductor only when it genuinely cannot localize. Decider and build-runner seats are
unchanged.

**Correction (2026-07-10):** the writer-owns-edit→run→verify shape above is unchanged — only
*how the pre-pass's tier is chosen* changes, on two counts. **(1) The arming decision owns
diagnosis-localization; `needsPlan` owns build-planning — cleanly split.** `armLocalization`
(§8.1) is now the *sole* authority on whether a *diagnosis* bug gets a localization pre-pass;
the turn-read `needsPlan` flag decides planning for **build** goals only and no longer OR-bypasses
the decision to force-plant a pre-pass on a diagnosis goal. **(2) The pre-pass tier is
difficulty-allocated, not reasoner-pinned.** The old `need:"reasoner"` pin is gone: the pre-pass
now allocates on the generator axis (§8.3, difficulty ← arming `hardness`; §7.2's SM5
correction) — a mechanical, *already-located* fix goes to the **executor** (the cheap mechanical
seat), and only a genuinely *hard* or *ambiguous* bug floors up to the **reasoner** via the
allocator's difficulty floor. The `shouldOrchestrate` benefit gate opens on the *allocated*
tier, not on a raw `need` hint. Under the hood, this was paid for by **django-12039** — a
trivial, already-located fix that the old `needsPlan` OR-bypass plus the reasoner pin
force-routed to the reasoner, where it burned the full 8-min wall-clock cap and cost ~2× the
prior conductor-only pass.

### 1.5 Verify: the work is checked, not trusted

Also unchanged — the five-rung verifier ladder runs the actual build/test commands, watches
the trajectory for test-dodging, rejects suspicious skips and shrinking test counts, and
falls back to judge/consistency checks when no tests exist. Gating order is behavior-gate →
sound → probe: a suspicious trajectory rejects before the sound check is even trusted, and
once sound has passed (or is inapplicable) a bug-fix slice's own pinned reproduction
(`VerifySpec.probeCommand`, the "probe" rung, task #7 — landed 2026-07-08, §7.6 of
[tier-prompts.md](../design/tier-prompts.md)) must also go red→green — rejecting even when the
generic `verifyCommands` list passed — before an untestable slice degrades further to the
extension rung, judge, or QE. This is the load-bearing wall: both the cheap-first gamble
(§1.3) and the containment story (§1.6) only work because failure is *detected* here. Notably,
the incumbent doesn't have this wall at all — Claude Code merges subagent work back on pure
trust (§3.1). It can afford trust; a system built on cheap tiers cannot.

**Correction (2026-07-08):** the turn-level pin that arms this wall on the inline path (M4,
§4.6) has a real gap of its own — it derives the pinned reproduction from prompt text, which
finds nothing to pin on a narrative SWE-bench-shaped prompt. See §4.6's correction and §6's
SM-series (SM1) for the fix: derive from tests red at turn-open, not prompt text.

### 1.6 Contain: a failed attempt costs its tokens, not the tree

The gap the zod live fire exposed. Today, when the junior's attempt fails verification, its
edits **stay in the working tree** and the escalated senior starts from that corrupted
state — anchored to the failed approach at best, building on broken code at worst. And if
the turn ends there, the residue ships.

**The upgrade** brackets every attempt with a snapshot (the git-based snapshot subsystem
already exists in the codebase — it's just never been wired to the slice loop):

```
        snapshot ──► attempt ──► verify ──► pass ──► keep, fold back
           │                        │
           │                        └─ reject
           │                             │
           └────────── restore ◄─────────┘
                          │
                          ▼
              escalation brief gains:
              "prior attempt's diff (rejected because X) —
               context to learn from, not code to keep"
```

The escalated tier starts from a **clean tree**, and the failed diff rides along as
*advice*. This keeps the one accidental benefit of today's dirty-tree behavior (the senior
can see what was tried) without the corruption risk. Parallel slices get the same guarantee
via worktree isolation — borrowing Claude Code's mechanic but not its blind merge: econ
merges only diffs that passed the rungs.

A reject doesn't escalate on the first miss either: it first squeezes the SAME tier while the
rejection's evidence keeps changing, and only climbs once that stalls (M2, §4.2) — the ladder
climb becomes the second-to-last resort, not the first hop. A structurally critical slice
(high coupling, or risk over the allocator's tiebreak) additionally may never settle
unverified below the oracle (M3, the escalation floor, §4.2) — it forces the climb the cost
cap would otherwise stop, settling loudly only once genuinely stuck at the ceiling.

M1–M3 all fire inside the SLICE loop, which only runs when the conductor decomposes the turn
into typed slices — an INLINE fix (no `todowrite`, zero slices dispatched) bypasses all three,
and a bug-fix turn could report "done" without ever re-running its own reproduction. **M4, the
turn-level pinned-reproduction gate** (§4.6), closes that gap: it pins the reproduction the
prompt names at turn open and re-checks it at turn close, independent of whether any slice ever
dispatched.

### 1.7 The cache rule: the owner stays put; only briefs travel

Prompt caches are per-model. Move work between tiers and the new model starts cold — so a
naive "cheapest capable tier per task" rule can quietly cost more than it saves. The
research (§3.3) reduces this to one clean principle and one guardrail:

- **The turn owner never moves.** The conductor's session context is the one big, hot,
  constantly re-read prefix. At a healthy hit rate its effective cost per call drops ~4×;
  moving it to another model re-bills everything. This was already the §8 "spine" rule for
  stability reasons — the cache math is its economic proof.
- **Per-slice switching is cheap *because* only the brief travels.** A child slice carries a
  30–60k-token brief, not the transcript. On econ's provider path (mostly no cache-write
  premium), a cold start on a brief costs cents. The lean-brief architecture is not a
  nice-to-have — it is what makes multi-tier routing affordable at all.
- **The guardrail:** don't bounce a *group* of related slices across tiers item-by-item, and
  treat a falling hit rate (<70%) as a prefix-invalidation bug to fix, never as a routing
  signal to react to.

### 1.8 The receipt

Every stage above leaves a decodable trace: which goals were found, what the evaluator
decided and why, which seats ran, what was verified, what got reverted, where escalation
double-paid. The user-facing receipt stays a per-tier cost drilldown (facts only, no
counterfactual "you would have paid X elsewhere" — that lives in benchmarks, never in
product); the internal trace is what makes a misrouted turn diagnosable after the fact.

---

## 2. Today's mechanism, and the five gaps

### 2.1 As built (updated 2026-07-08 — seam map verified by direct code recon)

> Since the original 2026-07-06 snapshot, §6's U1–U4 and the containment bracket (U3) have
> shipped and are always-on (see the status header); the rows below reflect that current state.
> §6 stays the ordered plan — most of its rungs are now complete, with the SM-series still
> open (U5, cache-aware casting, was cut 2026-07-10 — its helper was deleted unwired).

| stage | what runs today | where |
|---|---|---|
| turn-read | ONE merged temp-0 conductor call → goals + constraints + evidence + turnRole; `decideArming` (pure code) arms the localization pre-pass; preamble; gates (no-test-edit, no-edits); shape-matched frame seed (localization vs plan); continuation short-circuit + inherit | `packages/opencode/src/session/turn-triage.ts`, `arming-judge.ts`, step-0 block in `session/prompt.ts` |
| decompose | conductor plans; structural nets type todos (`autoTypeTodos`: judgment / diagnosis / `typeBuildPlan`); `shouldOrchestrate` benefit gate | `slice-orchestrator.ts` |
| probe | coupling / testStrength / verifyCommands probed **once, at decompose time** | `probeSlice*` in `packages/opencode/src/tool/graph-tools.ts` |
| allocate | static matrix sliceType × coupling × testStrength × need → tier; risk breaks exactly one borderline cell toward oracle (`risk > 70`). U4's `evaluate()` (§4.2) now runs at dispatch and re-dispatch — the earlier "no dispatch-time re-eval" gap is closed | `packages/code-intelligence/src/allocation.ts:147-227` (risk tiebreak `:205-211`); `evaluate()` at `slice-loop.ts:914` (dispatch) + `:599` (escalation re-eval) |
| execute | seat-scoped child sessions, personas, step budgets, lean briefs | `childSlicePermission`, dispatch site in `session/prompt.ts` |
| verify | 5 rungs — behavior gate → sound (runs `verifyCommands`; case-count, shrink-reject and skip-flag checks live inside it) → probe (task #7 pinned reproduction — gates sound-accept + untestable paths) → extra/judge rung → QE veto; a terminal flagged unverified-accept when none apply | `packages/code-intelligence/src/verifier.ts:544-562` (probe), `:597-691` (ladder) |
| escalate | a genuine reject first squeezes the SAME tier while its failure signature keeps changing (M2, ≤2 retries), climbing only on stall — executor → conductor → reasoner → oracle with type ceilings; a CRITICAL slice (high coupling or risk>70) forces a climb at every exhaustion point instead of settling unverified below the oracle (M3, the escalation floor); each hop's escalation brief carries the rejected diff as REVERTED advice (verdict + ≤6k-char digest + files/commands lists, U3 containment); double-pay booked per rung | `slice-loop.ts:1048-1097` (squeeze+climb chain), `:503-539` (brief), `:619-633` (`recordEscalation` booking into `double-pay.ts`) |
| close | outcomes settle todos (a `blocked` slice settles `cancelled` — never attempted ≠ failed — and counts as a re-decomposition coverage gap, P6a); synthesis hop runs on the **reasoner by default**, escalating to the oracle only when MIXED outcomes (an `unverified` or `blocked` slice among the done) need arbitration (P9); M4 turn-close probe gate | `slice-orchestrator.ts` (settle), synthesis dispatch in `session/prompt.ts` (`synthesis_dispatched` logs the tier + reason) |
| observe | `turn_triage` / `arming_decided` / `turn_continuation` / `turn_read_degraded` / `orchestration_engaged` events (plus `turnReads`/`turnReadNulls`/`turnContinuations` counters); M4's `turn_probe_pinned` / `turn_probe_gate` / `turn_probe_unresolved` (§4.6); `EconReceipt` per-tier drilldown | session logs, receipt |

Live-fire status: diagnosis-planner door FIRED with payoff (django gold-file fix, ~$0.15);
mechanical-dispatch door FIRED (zod, ~$0.07); escalation ladder FIRED live with double-pay
visible; judgment door proven 4×; residual/judge-sampler door awaits an express-style case.

### 2.2 The five gaps

> Status (2026-07-10): G1/G2/G3 are now closed by the shipped U1/U2, U4 and U3, and G5 is being
> closed by the prompt-content overhaul. **G4 (cache-blind switching) remains a known economic
> gap**, but its U5 switch-pricing helper was deleted unwired on 2026-07-10 (its evaluator input
> was never populated); the live mitigations are session affinity and the per-turn hysteresis
> hold. The descriptions below are retained as the motivation for §6.

**G1 — one label per prompt.** Compound requests are unrepresentable; even a clean build
prompt was mislabeled `qa/low` in live fire (harmless only because a structural net caught
the todos downstream).

**G2 — tier decisions are frozen, and only failure changes them.** Probes run once at
decompose time; nothing re-evaluates at dispatch or between rungs; de-escalation doesn't
exist. By the time failure teaches us the tier was wrong, we've paid for the attempt, the
rework, and G3.

**G3 — no failure containment.** Rejected attempts leave their edits in the tree (confirmed
in code and observed live). The snapshot subsystem that fixes this exists
(`packages/opencode/src/snapshot/index.ts:44-53` — `track/restore/revert/diff`, git-based)
but is wired only to user-facing revert.

**G4 — cache-blind switching.** Nothing prices the cold-start cost of moving work between
models. Already measured internally: one tier's provider discounts cached reads ≈11.6×;
session-affinity behavior differs per model (W8 probe, `model-registry.ts` notes). The U5
switch-pricing helper built for this was deleted on 2026-07-10 — it never gained a production
caller, and the evaluator input it was meant to feed was never populated. What keeps G4
contained in practice: session affinity (the owner seat never moves, §3.3) and the per-turn
hysteresis hold (§4.2). Revisit a pricing term only if real switch-cost signals get wired
into dispatch.

**G5 — the mechanism runs invisibly to the models that must cooperate with it.** Several stages need model cooperation the prompts don't supply: the generator is never shown the judge's checks (§1.5), so it can't pre-satisfy them; the reasoner delta described a delegating principal, not the leaf slice it actually runs as; the conductor is never told that inline edits escape the containment bracket (§1.6). Verify (generator pre-satisfies checks), Track (conductor types slices correctly), Execute (well-formed edits) and Contain (route uncertain edits into slices) each have a cooperation seam the prompts were silent on. Being closed by the prompt-content overhaul — the prompt-side companion to U3/U4. The Verify seam narrows further with the task #7 probe rung (§1.5, landed 2026-07-08): a bug-fix slice's own pinned reproduction becomes a checked verify rung rather than a flag-and-continue warning, and the LOCALIZATION/PLANNER prompt tweak (tier-prompts.md §5.3) now asks the generator to name each discriminating probe as a single runnable, backticked command — so the artifact the conductor produces is the exact string the probe rung later pins and re-runs.

---

## 3. What the research says

### 3.1 The incumbent (Claude Code source, `../claude-code-source-code`)

| mechanism | what the source shows | lesson for econ |
|---|---|---|
| cheap pre-processing | one blocking small-model call: the auto-mode permission classifier (structured verdict, allowlist fast-path skips the call) — no prompt-triage call | the *pattern* (small model + forced schema + blocking gate + fast-path) is exactly our triage shape, aimed at a different question |
| todo evaluation | none — todos are never scored for difficulty/risk; one nice nudge: a 3+ item list closing without a verification item triggers a reminder | copy the nudge; the evaluator itself is ours to build |
| routing | static per-agent model config; **no capability escalation exists** — only capacity fallback on overload errors | our ladder is a real differentiator, not table stakes |
| checkpoints | snapshot after every loop iteration; user-driven rewind; **no automatic revert on failure** | adopt the per-turn cadence as backstop; the automatic restore at rung-reject is ours |
| subagents | git worktree per agent, merged back **with zero verification — trust** | worktree mechanics transfer; the trust model doesn't — cheap tiers must be verified |
| failure handling | categorized retry errors only; no "prior attempt failed because X" context | our escalation brief is already ahead; feed it the rejected diff |

One frontier model buys quality with trust; a cheap-tier team buys it with verification.
econ's mechanism cannot be "Claude Code, cheaper" — evaluated casting, verification, and
containment *are* the product.

### 3.2 Routing & triage literature (distilled to design rules)

1. **Cascade (try cheap → verify → escalate) beats predicting the tier upfront** for coding
   — FrugalGPT, RouteLLM, RouterBench all land on the same cost-quality frontier result.
   **No paper contradicted our design.** The caveats are about the *deferral signal*, not
   the shape.
2. **A model's own confidence is a weak escalation signal; external verification is
   strong** (AutoMix, NeurIPS-23 deferral study). Validates commands-over-confidence rungs;
   argues for agreement-sampling on untestable slices.
3. **Route per-step, not per-task, and re-classify on stall** — catches 60–70% of
   misrouted-hard tasks early (agentic routing literature). Direct support for the
   dispatch-time + mid-flight evaluator.
4. **Coarse-route then fine-cascade** (Cluster/Route/Escalate, ETH 2025) — exactly the
   triage + ladder split.
5. **Small-model triage is reliable only as scoped extraction with a fallback** (open-ended
   triage: ~39% for small models; scoped few-shot classification: 84%+), and **extractive
   decomposition beats generative** (hallucinated subtasks are the documented failure mode
   — TaskBench, GRAFT). This is why §1.1's schema quotes, validates, and falls back.
6. **Blocking triage is the right latency pattern** for chat-shaped agents (~100–200ms class
   latency for large savings on the simple share).
7. **The architect/editor split is independently proven** (Aider: reasoning model plans,
   cheap model edits, 30–50% cheaper at parity) — the same split our **mechanical
   decomposition** (conductor plans a build-list, executor edits) uses; the atomic-insight
   path deliberately keeps reasoning-and-editing in one seat instead (§1.4 correction).

Citations: FrugalGPT [2305.05176](https://arxiv.org/abs/2305.05176) · RouteLLM
[2406.18665](https://arxiv.org/abs/2406.18665) · AutoMix
[2310.12963](https://arxiv.org/abs/2310.12963) · RouterBench
[2403.12031](https://arxiv.org/abs/2403.12031) · Cascade deferral
[NeurIPS 2023](https://openreview.net/forum?id=4KZhZJSPYU) · Cluster/Route/Escalate
[2606.27457](https://arxiv.org/abs/2606.27457) · Agent-as-a-Router
[2606.22902](https://arxiv.org/abs/2606.22902) · Adaptive-RAG
[2403.14403](https://arxiv.org/abs/2403.14403) · Decomposed Prompting
[2210.02406](https://arxiv.org/abs/2210.02406) · GRAFT
[2605.11706](https://arxiv.org/abs/2605.11706) ·
[TaskBench](https://proceedings.neurips.cc/paper_files/paper/2024/file/085185ea97db31ae6dcac7497616fd3e-Paper-Datasets_and_Benchmarks_Track.pdf) ·
[Aider architect mode](https://aider.chat/2024/09/26/architect.html).

### 3.3 Cache economics (why §1.7 is stated the way it is)

Provider mechanics converge on ~10× cached-read discounts, with differing write premiums:
explicit-cache providers charge one (1.25–2× on the write), automatic-prefix providers
charge none (first call at standard rate; DeepSeek-style disk caches read at ≈0.02×). The
reasoner's measured ≈11.6× read discount is in `model-registry.ts`. Self-hosted serving
reproduces the same economics via prefix caching (vLLM, SGLang RadixAttention) **only with
cache-aware routing** — session affinity lifts hit rates from ~60% to 85–96%. Production
discipline is unanimous (Manus, Anthropic guidance): byte-stable prefix, append-only
history, deterministic serialization. LiteLLM caveat: several streamed providers omit cache
fields — `EconModelProfile.cacheAccounting` stays canonical
([cross-tier-context §6.1](../design/cross-tier-context.md) owns the blind-spot record and
the >85% conductor hit-rate target).

The switch-vs-stay inequality, for a slice group of N expected calls — context `T_ctx` on
warm model M₁ (hit rate `h`, read discount `d`) vs a compiled brief `T_brief` on colder,
cheaper M₂ (write premium `w`):

```
Cost_stay(N)   = N × T_ctx × rate_M1 × (h·d + (1−h))
Cost_switch(N) = T_brief × rate_M2 × w  +  (N−1) × T_brief × rate_M2 × d
```

Worked shape — **verified against real `ECON_COST_MATRIX` rates** (the since-removed
`cache-switch.test.ts`, 2026-07-06): every current econ model bills cache writes at the plain input rate
(`writePremium = 1.0` across all four; conductor↔oracle is an exact 10× price pair), and at
that setting a lean-brief switch to a cheaper tier wins at **every** group size — the
"~20-call amortization threshold" in an earlier draft was an artifact of illustrative
write-premium rates and is corrected here. A stay-warm crossover only exists on
write-premium providers, or when the brief stops being lean (brief/context ≳ 0.235 at these
rates). **The decisive variable is `T_brief`, not the price ratio** — and the owner seat is
the ρ = 1 endpoint of that same rule: moving the owner means moving the whole transcript,
which is why it never moves.

Bottom line for G4: down-switching is *not* generally punished on econ's provider path
(lean briefs + mostly no write premium). What must never move is the owner seat's warm
session prefix. The genuine risks are bouncing a *group* item-by-item, and
prefix-invalidation bugs misread as routing problems. And per
[TOKEN_ECONOMICS](../strategy/TOKEN_ECONOMICS.md), oracle token-share dominates blended
cost — switching *to avoid* an oracle call is always worth a cold brief write.

### 3.4 Hierarchy, fan-out & delegation economics

The evidence splits cleanly by *what kind of work* is being delegated:

- **Recursion depth.** ADaPT (recursive decompose-on-need) shows recursion genuinely
  helps at depth 2 (task success 26.9% → 78.2% on its hardest split) and still helps at
  depth 3 with diminishing returns — but that is read/planning work. For **write-heavy
  agents the production record is one executed level**: Anthropic's research system is
  orchestrator → workers (read-only research, ~90% time cut, ~15× tokens), AgentOrchestra
  is conductor → specialists, Claude Code subagents are flat, and Cognition's "Don't Build
  Multi-Agents" documents the failure mode of going deeper — siblings and grandchildren
  make conflicting implicit decisions because none sees the others' work.
- **Branching.** 3–5 parallel workers is the repeated production optimum for moderate
  complexity; past ~5, coordination overhead and tail latency dominate the gains. When a
  task keeps failing, **escalating its tier beats widening the fan-out.**
- **Inline vs delegate.** Reads parallelize; writes inline (the Anthropic/Cognition split,
  both right about their own domain). Detailed child briefs (objective, output shape,
  boundaries) are non-negotiable for parallel dispatch — vague briefs measurably produce
  duplicated and conflicting sibling work.
- **Decomposition quality is a real, checkable property**, not taste: fixed verifiable
  pipelines can beat free-form agents outright (Agentless: 60.4% SWE-bench Verified at
  ~1/10 the cost of interactive agents); good splits minimize coupling (≤2–3 dependency
  edges per subtask), size each unit to be *independently verifiable*, and get checked
  before execution (rubric judge: no cycles, a success criterion per item, budget
  headroom), with explicit re-decomposition triggers during execution.

Citations: ADaPT [2311.05772](https://arxiv.org/abs/2311.05772) ·
[Anthropic — multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ·
[Cognition — Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) ·
AgentOrchestra [2506.12508](https://arxiv.org/abs/2506.12508) ·
Kimi-Dev / Agentless results [2509.23045](https://arxiv.org/html/2509.23045v2) ·
[LangChain — how and when to build multi-agent](https://blog.langchain.com/how-and-when-to-build-multi-agent-systems/) ·
LLM-agent evaluation survey [2507.21504](https://arxiv.org/html/2507.21504v1).

**Verdict on the goal tree:** yes to the tree, bounded exactly where proposed — the 3–4
cap lands on the evidence numbers (data depth 3, branching 3–5) — and **executed as a
star**: the tracker holds the hierarchy, the conductor stays the only spawner.

---

## 4. Design details (under the hood)

### 4.1 The turn-read

One **conductor-tier** call at fresh-turn open (`runTurnRead`, `turn-triage.ts`; the system
prompt is `TURN_READ_SYSTEM_PROMPT`, `prompts/judges.ts`); own tiny context (the session's
golden cached prefix is never touched — this is a separate small request, so model choice
doesn't affect the warm prefix either way); forced schema; temperature 0; **blocking**
(12s cap, `TURN_READ_TIMEOUT_MS`) — its output gates seeds, and the §7-item-3 lesson
stands: the pre-pass must exist *before* exploration starts. It merges what used to be two
stacked calls (triage extraction + arming judgment) into one read (P1-alt): the model
extracts, and every judgment expressible as a rule over the extracted facts moved into
code. Tier decision (Q1, closed 2026-07-06): the *executor* binding is below the
language-competence floor for splitting and categorizing nuanced compound prompts — the
§3.2 small-model triage numbers are the documented risk — while the conductor is still
cheap enough that the call costs well under a cent. Capability floor beats the generic
"extraction is small-model work" rule.

```ts
type TriageVerdict = {
  goals: Array<{
    quote: string          // VERBATIM span of the user prompt — validated; extraction only
    shape: "diagnosis-vague" | "diagnosis-grounded" | "build" | "refactor" | "audit"
         | "qa" | "research" | "run-only"
    deliverable: string    // one line: what "done" looks like
    dependsOn?: number[]   // ordering ("apply whichever fixes the audit approves")
    needsPlan?: boolean    // BUILD goals only: plan a build-list (diagnosis-localization is decideArming's call, §8.1)
    evidence?: {           // diagnosis-shaped goals only — facts, never a ruling
      locationNamed: boolean; locationQuote?: string   // a true claim must carry its verbatim quote
      fixSpecified: boolean; fixQuote?: string
      hardness?: "trivial" | "moderate" | "hard"       // the two genuinely judged fields
      ambiguity?: "clear" | "ambiguous"
    }
  }>
  constraints: Array<{ quote: string; kind: "no-test-edit" | "no-edits" | "scope-limit" | "no-new-files" | "other" }>
  confidence: "high" | "low"
  turnRole: "fresh" | "continuation"   // P4 — continuation = pure steering/iteration, may carry zero goals
}
```

The two P3 shape discriminators live in the extraction prompt, not in keywords: `research`
= the deliverable needs **external sources** (a question this repo's code alone can answer
is `qa`); `refactor` = restructures **without changing behavior** (anything that adds
behavior is `build`; a prompt that does both carries both goals).

Hard rules: quotes validated against the prompt (a goal that can't cite its span is
dropped; an evidence claim without its quote degrades to `false`); ≤7 goals (zero goals
valid only on a continuation); the turn-read never localizes or designs. Failure path (P5):
a completed-but-invalid answer retries ONCE on the same tier; a null verdict then re-asks
ONCE on the **reasoner** (a different model family — real redundancy); still null →
**neutral degrade** — no preamble, no skeleton, arming stands down, nothing is planted
(`turn_read_degraded` + the `turnReadNulls`/`turnReads` null-rate counter, P5's acceptance
metric: <2% of turns). A *low-confidence* verdict also re-runs on the reasoner, keeping the
richer of the two verdicts. A short, code-free ack on a session with prior turns
(`isContinuationShortCircuit`) skips the call entirely (P4 — §1.1). Consumers: todo
skeleton (§1.2), shape-matched frame seeding (localization vs plan), constraint→gate arming
(no-test-edit, no-edits), `decideArming`'s evidence (§8.1), the M4 probe pin (a
diagnosis-shaped goal arms it, §4.6), `shouldOrchestrate` goal count, and the researcher
auto-cast on research-shaped turns (recon slices run as the web-enabled researcher persona;
researcher slices pin `testStrength:"untestable"` and verify by citation, never the test
rung — P3/Q-D).

### 4.2 Pre-dispatch evaluator

Runs at dispatch and at every re-dispatch; inputs per §1.3 (probes — refreshed if the tree
changed since decompose — triage shape, attempt history + `rsk` anchors on touched entities,
verify strength). Decision rules, in priority order:

1. Constraint pins win (`need:` pins, slice-type ceilings — unchanged).
2. Decision-shaped work rounds up on ambiguity (§8 casting policy — unchanged).
3. **Mechanical work rounds down only inside a strong safety net**: verify commands exist
   AND containment can restore cleanly. Weak net + high blast radius → up front.
4. **Venue — the affinity rule (inline vs child):** same tier as the requesting thread AND
   high context overlap (the child's brief would mostly reproduce what the thread already
   holds warm), or a write tightly coupled to work in flight → **inline, no spawn**.
   Delegate when the tier changes, the context diverges (a lean brief suffices), or the
   work is read-only parallel. One or two small same-tier items: always inline. The rule's
   inputs are live since P6c: `requestingTier` comes from the calling seat and
   `sameFilesInScope` from the slice's predicted edit scope ∩ the parent thread's scope —
   but the verdict itself is **honest telemetry** today (P7b): dispatch still spawns, the
   coarse `autoTypeTodos` stand-down captures small same-tier batches wholesale, and the
   measured inline-would-have-fired rate is the evidence that will justify (or kill) a real
   per-slice inline path.
5. Hysteresis: re-evaluation within a turn needs a signal *delta* (new failure, new
   contradiction, refreshed probe change), not a marginal score wobble.

**Decomposition quality gate — the plan itself is verified before any spend.** Checked
mechanically where possible, by a cheap rubric judge where not: no dependency cycles;
every item carries a one-line objective, an expected output shape, and a success criterion
the rungs can actually check; ≤3 inbound dependencies per item; branching ≤5, tree depth
≤3; summed child estimates ≤70% of the turn budget (30% reserved for synthesis and
correction). A plan that fails the gate is re-decomposed *before* the first child spawns —
this is the anti-"vibes" step for the breakdown itself, mirroring what the rungs are for
the code.

**Dependency failure & scope overlap (P6, wired 2026-07-10).** Slice relations are
*derived*, never asked for. A dependency that settles terminal-failed **blocks** its
dependents before any spend (P6a): they are never dispatched, settle as outcome state
`"blocked"` (with `blockedBy` naming the failed deps), cascade transitively, land on the
todo list as `cancelled` (never attempted ≠ failed), and count as re-decomposition coverage
gaps (Q-J — the re-plan seed owns them). Before waves run, an `editScopeOf` probe (the
slice text's own path tokens, wired at the conductor seam) predicts each editing slice's
file scope, and `serializeOverlappingScopes` adds an **implicit later→earlier dep** between
same-wave slices with intersecting scopes (P6b) — "no concurrent same-file edits" becomes a
computed fact instead of prompt discipline. Overlap only ever ADDS ordering (declared deps
are never dropped — they carry information flow via `withUpstreamContext`, and the implicit
edges feed it too); the check iterates to a fixpoint; read-only slices are exempt; without
a probe the wave plan is byte-identical. The same scope signal feeds the venue rule's
`sameFilesInScope` (P6c, rule 4 above).

**Re-decomposition triggers (during execution):** a child running >50% over its budget →
escalate that slice's tier, don't widen the fan-out; a sibling conflict detected at
fold-back → stop and re-plan with less parallelism; coverage gaps at synthesis → the
missing work becomes new tracked items, never silent scope loss; wall-clock ≥2× estimate →
suspect a hidden sequential dependency and re-order. **(Wired 2026-07-09, #55 — §8.6:**
`redecompositionCheck` now derives these triggers from a settled run's outcomes — an
`unverified` **or** `blocked` slice is a coverage gap — and reseeds a reasoner-pinned
re-decomposition pre-pass on a coverage gap, bounded by the *same* recursion counter as the
prior-resolution gate.)

Mid-flight: the convergence-budget and contradiction triggers become evaluator re-entry
points — a stalled slice is re-classified, not just un-muted.

**The squeeze-then-climb chain (M2/M3, `runSlice` in `slice-loop.ts`).** A rejected slice does
not climb immediately: it first retries the SAME tier while its failure signature
(`rung|missing`) keeps changing, up to `SAME_TIER_RETRY_BUDGET` (2) — squeezing the cheap tier
before paying for an escalation — and only climbs once the signature repeats or the squeeze
budget is spent (a stall). Climb depth is its own counter (`climbs` vs `maxClimbs`), decoupled
from `MAX_SLICE_ATTEMPTS` (8, a runaway backstop on total dispatches only, not the real
control): a non-critical slice climbs at most once (`maxClimbs = 1`, executor→conductor)
before it may settle unverified; a read-only (recon/verify) slice never squeezes or climbs
(`maxClimbs = 0`). A CRITICAL slice (`isCritical` — high coupling, or risk above the
allocator's tiebreak) bypasses `maxClimbs` via `forceFloorClimb` and keeps climbing at every
exhaustion point up to the oracle ceiling, settling loudly
(`rungReason: "critical-unverified-at-ceiling"`) only once it is genuinely stuck there. The
invariant this guarantees: a non-read-only slice failing at the cheap tier always reaches at
least the conductor before it may settle unverified.

### 4.3 Failure containment

`snap.track()` before each attempt → rungs reject → `restore()` → escalate on a clean tree,
with the failed diff attached to the escalation brief as context ("rejected because X — do
not repeat this approach"). The wired containment is this shadow-git snapshot bracket —
worktree isolation for parallel slices remains an unbuilt follow-up (§6 U3); only
rung-passed diffs fold back.
Per-turn snapshot cadence (the Claude Code pattern) as the outer backstop so a turn that
dies mid-failure is still revertible from the receipt. Default is clean-tree
(diff-as-advice), not salvage-in-place — revisit only with live-fire evidence that
re-derivation cost dominates (§5 Q3).

Cost note: a "snapshot" here is a commit in the shadow git repo the snapshot subsystem
already maintains (content-addressed, compressed, delta-only — unchanged files store
nothing new). Per-attempt cost ≈ the compressed diff, typically kilobytes; the watchpoint
is `git add` scan latency on very large repos (tens of ms), not storage. Two lean-keeping
rules: read-only slices (explorer/planner/decider seats) get **no bracket** — nothing to
roll back; attempt-level snapshots are pruned once the turn closes cleanly, keeping only
the per-turn backstop for user-facing rewind.

### 4.4 Cache-aware casting rules

> Design intent, not shipped mechanism: the U5 switch-pricing helper that implemented
> rule 3 was cut 2026-07-10 (deleted unwired — no dispatch path ever computed the term).
> Rules 1–2 hold by construction today (the owner seat never moves; only briefs travel);
> tier stickiness comes from session affinity + the §4.2 hysteresis hold.

1. The owner seat never moves (economic proof in §3.3; spine rule in failure-taxonomy §8).
2. Only briefs travel — never a transcript.
3. Price every proposed group move with the §3.3 inequality, using live rates from
   `ECON_COST_MATRIX` + per-model `cacheAccounting` (never hardcoded premiums).
4. Group same-tier slices consecutively; never down-switch mid-group for one small item.
5. Hit rate <70% on any tier is a prefix-invalidation alarm
   ([cross-tier-context](../design/cross-tier-context.md) owns the >85% target): fix the
   prefix; never route around a broken cache.

### 4.5 The goal tree — structure, caps, instances

The tracker stores the hierarchy (each todo carries a parent reference): triage goals are
root nodes, decomposition fills in tasks and sub-items beneath them. Caps, from §3.4's
evidence: **data depth ≤3** (goal → task → sub-item), **branching 3–5 per node**. Execution
is a **star, never a tree**: the conductor is the only spawner; at most one level of live
children; unrelated goals may run as parallel instances simultaneously (same tier or
different tiers, within the branching cap); a child that needs a further split folds its
sub-plan back to the conductor for re-dispatch. The single sanctioned exception: read-only
exploration inside a research child may fan out one more level — the one shape the
evidence supports going deeper. The affinity rule (§4.2 rule 4) decides per item whether
it becomes a child at all or stays inline on the thread that already holds the context.

### 4.6 Turn-level pinned-reproduction gate (M4)

The gap M1–M3 leave: all three fire inside the SLICE loop (`slice-loop.ts`), which only runs
when the conductor decomposes the turn into typed slices via `todowrite`. When the conductor
fixes a bug **inline** — no slices dispatched — the entire M1–M3 machinery (probe rung, squeeze,
escalation floor) is bypassed, and a bug-fix turn could report "done" without ever having
re-run the reproduction that proved the bug.

**M4 closes it at the TURN level**, in `runLoop`
(`packages/opencode/src/session/prompt.ts`) — always-on (no flag) and root-session-only
(`!session.parentID`; child slice sessions already have M1's slice-level probe rung):

- **Turn-open pin** (`step === 0`, armed when the turn-read verdict carries a
  diagnosis-shaped goal — P5 re-homed the trigger off the regex; `isFixShapedPrompt` now
  only ORs into the no-test-edit governance gate; turn-read failed ⇒ no pin this turn):
  `deriveTurnProbe(userText)` (`slice-orchestrator.ts:695`) extracts the most-specific
  pinned reproduction COMMAND straight from the prompt text — not from dispatched slices, which
  are empty on the inline path. Logs `turn_probe_pinned`. The pin is stored per session
  (`turn-read-store.ts`): a fresh turn clears it at open, and a continuation turn (P4)
  restores it — the reproduction is still the contract a follow-up is steering toward.
- **Turn-end gate** (`prompt.ts:1510-1558`, just before the loop's exit `break`): if a probe was
  pinned, `runTurnProbeGate` (`slice-orchestrator.ts:578-610`) runs it. When the turn forbids
  test edits (`testEditGateArmed`), it first re-runs the test-tree guard
  (`TEST_TREE_GUARD_COMMAND`, the same guard the sound rung uses) — a modified test file rejects
  with rung `"test-tree"` before the probe is even tried. Then it runs the pinned probe; a
  non-zero exit rejects with rung `"probe"`.
- **Bounded retry**: a reject re-injects the gate's `reason` (a content-specific nudge, e.g.
  "The pinned reproduction `…` is STILL FAILING (exit N): …") as a synthetic user message and
  re-enters the loop — up to `MAX_PROBE_GATE_RETRIES` (3, `prompt.ts:1427`), reusing the same
  length-continuation re-entry primitive as the output-truncation backstop (§7.4).
- **Loud unresolved**: if retries exhaust and the probe is still red, the turn logs
  `turn_probe_unresolved` (a WARNING) and exits anyway — it does not silently report success.

This is a NUDGE_V2-style targeted nudge (event-triggered, silent unless there is a real failing
signal, hard-gated, content-specific) — complementary to, not a replacement for, the
no-test-edit hard gate (`setTestEditGate` / `edit-governance.ts`). Full mutation-surface
bookkeeping: [tier-prompts.md](../design/tier-prompts.md) §5.9, §6.

**Correction (2026-07-08, SM1, §6):** `deriveTurnProbe`'s prompt-text extraction is a real
gap, not a theoretical one — it finds no command in a narrative SWE-bench-shaped prompt (no
literal `pytest …` span to quote), so the turn-open pin never arms and the turn-end gate
no-ops on exactly the prompts this mechanism most needs to cover. SM1 replaces text-extraction
with tests-RED-at-turn-open as the pin's source of truth, restores any test files the attempt
modified before the gate runs, and regression-gates on neighboring tests.

---

## 5. Open decisions

| # | question | recommendation | state |
|---|---|---|---|
| Q1 | Triage tier: executor vs conductor | **decided: conductor** (2026-07-06) — the executor binding is below the language-competence floor for splitting/categorizing compound prompts (it cannot perform this activity at all today; §3.2 rule 5 documents the small-model triage floor); conductor is still sub-cent per call. Low-confidence verdicts escalate to the reasoner. | decided |
| Q2 | Triage writes the todo skeleton directly vs conductor confirms | **decided: direct write** (2026-07-06) — mooted by Q1: triage already runs on the conductor tier, so a confirmation pass would pay the same model twice to agree with itself. The framework materializes the skeleton mechanically from the triage verdict; the session thread can amend but never has to create. | decided |
| Q3 | Containment default: clean-tree + diff-as-advice vs salvage-in-place | **decided (2026-07-06): clean tree**, failed diff rides the escalation brief as advice; revisit only on live-fire evidence that re-derivation cost dominates | decided |
| Q4 | Cache term formula + premiums | **decided** — §3.3 inequality, live rates from model profiles (§4.4 rule 3) | decided |
| Q5 | De-escalation triggers beyond verify-strength | **decided (2026-07-06): verify-strength only** to start; new signals only from receipt evidence | decided |
| Q6 | Where hysteresis state lives | **decided (2026-07-06): per turn**; session-level only if receipts show cross-turn thrash | decided |
| Q7 | Goal-tree data depth cap | **decided (2026-07-06): 3** (goal → task → sub-item) — evidence degrades past depth 3 | decided |
| Q8 | Live branching cap | **decided (2026-07-06): 3 default, 5 max** — 5 only for provably independent read-heavy work | decided |
| Q9 | Affinity overlap threshold | **decided (2026-07-06): qualitative to start** — same tier + same files/entities in scope → inline; quantify from receipt data later | decided |

---

## 6. Implementation plan — what gets upgraded

Ordered by dependency; each step is independently shippable and live-fire-testable. What
does **not** change: the spine (conductor owns the turn), the structural nets (they remain
the enforcement layer triage advises), the verifier rungs, and the ladder itself.

**U1 — Turn Triage call** *(unlocks U2; biggest single fix — kills G1)* — **shipped, then
superseded by the merged turn-read (2026-07-10, `48a3499ce`).** The original build: a
schema-forced **conductor-tier** triage call (Q1 decided; low-confidence escalates to the
reasoner) wired into the `prompt.ts` step-0 block, with the regex classifier demoted to
fallback + shadow signal. The 2026-07-10 rewrite (P1-alt/P2a/P5) then merged triage and the
arming judgment into ONE temperature-0 turn-read and **deleted the regex shadow taxonomy
entirely** — failure now degrades neutrally through a reasoner re-ask, metered by the
null-rate counter that replaced the disagreement telemetry (§4.1).

**U2 — Goal-tracked turn open, tree-shaped** *(kills the compound-prompt gap end-to-end)*
Multi-goal verdicts materialize the todo skeleton at turn open; per-goal frame seeding
(planner/localization per goal, not per turn); constraints arm gates (`no-test-edit` from
the constraint, regex kept as belt-and-braces); `shouldOrchestrate` reads goal count. The
tracker gains the tree: todos carry a parent reference (goal → task → sub-item, depth ≤3,
branching ≤5); unrelated goals dispatch as parallel instances; fold-back accepts a
child-returned sub-plan and re-dispatches through the hub (children never spawn
grandchildren).

**U3 — Containment bracket** *(kills G3; small, high-value — the snapshot API already exists)*
`snap.track()` / `restore()` around slice attempts in `slice-loop.ts`; failed diff attached
to `buildEscalationBrief`; escalation-trigger provenance logged at INFO (the live-fire
decode gap); per-turn snapshot backstop. Worktree isolation for parallel slices lands as a
follow-up.

**U4 — Pre-dispatch evaluator** *(kills G2; depends on U1 for the triage signal, U3 for the
safe-gamble rule)*
`evaluate()` before `allocate()` at dispatch time: probe refresh on tree change, history +
`rsk` anchors, the §4.2 rule stack — including the venue/affinity rule (inline vs child)
and the decomposition quality gate on the plan itself — hysteresis state, de-escalation,
and the §4.2 re-decomposition triggers during execution. Mid-flight re-entry from the
convergence/contradiction triggers. `allocate()` keeps ceilings and pins.

**U5 — Cache-aware casting term** *(was to complete G4; depends on U4)* — **CUT 2026-07-10.**
The switch-pricing helper (reading `ECON_COST_MATRIX` + `cacheAccounting`) was built with
tests but never wired into dispatch — the evaluator input it fed was never populated — and
was deleted. G4 stays mitigated by session affinity + the §4.2 hysteresis hold; revisit only
if real switch-cost signals get wired. The group-move rule and hit-rate alarm (<70%) remain
unbuilt design intent (§4.4).

**U6 — Receipt & decode upgrades** *(rides along each step)*
Goals + evaluator verdicts (with reasons) + reverts + escalation provenance on the internal
trace; receipt rollup unchanged in shape (facts only, per-tier drilldown).

Suggested order: **U1 → U2 → U3 → U4 → U5**, U6 riding along. U3 can land in parallel with
U1/U2 (no shared seams). Each step re-fires the relevant live-fire case from
[TIER_FIRING_CHECKLIST](../testing/TIER_FIRING_CHECKLIST.md) before the next begins.

### SM-series — state-machine hardening

North star: a cheap model inside a disciplined state machine should behave like Claude
Code — the discipline is harness-supplied and fully transferable (understand → plan → act →
verify → don't-fake-green → don't-thrash). What is *not* transferable is the hard-tail
reasoning itself: it is *routed to* — un-mute the conductor's own thinking, then escalate to
the reasoner — never manufactured inside a cheap model. Per Anthropic's own framing: *"the
guarantees in loop engineering live in the harness, not the model's good intentions."*

**Two loops, one gap.** The ROOT turn loop (`runLoop`'s `while(true)` at `prompt.ts:1430` —
the inline path every non-decomposed fix runs on) currently has **no per-step supervisor**.
That gap is where django-11885 thrashed 12× on the same red test, then fake-green-edited
`test_large_delete` to make it pass. The SLICE loop (`slice-loop.ts`) already has real
discipline — a `verdictSignature` stall detector plus the squeeze-then-climb chain (M2/M3,
§4.2) — but it only runs on slices the conductor actually dispatched via `todowrite`; the
inline path bypasses all of it (the same shape of gap M4, §4.6, closed for verification —
this series closes it for supervision).

```
 ROOT loop (prompt.ts:1430)            SLICE loop (slice-loop.ts)
 while(true), the inline path           runSlice, dispatched slices only
 NO per-step supervisor  ◄── the gap    verdictSignature stall detector
 (django-11885: 12× thrash,             squeeze-then-climb (M2/M3)
  then fake-green via test edit)
```

**Pattern decision.** The ROOT loop is already the `while(true)` shape, so it adopts Claude
Code's loop pattern outright (`query.ts:204–239,307`): one explicit `State` object plus
`Continue`/`Terminal` discriminated unions carrying a named `reason` per
continuation/termination, so every loop exit is a labeled decision instead of an implicit
fallthrough. The branchier SLICE loop instead gets a pure `transition(state, event)`
reducer, reserved for it alone — its state carries more live axes (rung, climb depth,
squeeze budget) than a `Continue`/`Terminal` pair fits cleanly. Explicit **do-not-copy list**
from the incumbent: trust-merge of subagent results, streaming-trust, and its total lack of
stuck-detection — econ's supervisor + escalation ladder + verification gate are the
differentiators the incumbent deliberately doesn't have; adopt the loop *shape*, not its
trust model.

**SM0 — Shared state-machine contract.** *(shipped, unwired)*
`packages/code-intelligence/src/orchestration-fsm.ts` now holds the `State`/`Event` types,
the pure `sliceTransition` reducer, and `createStuckSupervisor` — deterministic, no clock or
randomness, table-testable without a live model or shell. Nothing calls it yet; SM3 and SM4
below are the wiring.

**SM1 — Verification: make red real** *(first — red must be real before any stuck signal can
exist)*
Derive the turn probe from tests that are RED at turn-open, not from prompt text — M4's
`deriveTurnProbe` → `extractVerifyCommands` finds no command in a narrative SWE-bench prompt,
so the gate no-ops (detail + correction in §1.5 and §4.6). Restore any test files the attempt
modified before the gate runs, and regression-gate on neighboring tests, not just the pinned
one.

**SM2 — Governance: close fake-green.**
The no-test-edit gate becomes ALWAYS-ON and structural — armed by the turn's actual state,
not derived from prompt `constraintKinds`. A red→green transition reached via a test edit
becomes a *stuck signal routed to the reasoner*, which adjudicates code-wrong vs. test-stale
— not a blanket ban (gold patches legitimately edit tests).

**SM3 — Slice FSM substrate.**
Extract `slice-loop.ts`'s implicit tuple (rung, climb depth, squeeze budget, failure
signature) into SM0's pure reducer; add real terminal states so a settled slice is never
re-dispatched — this fixes the logged run-8 blocker where slices were never marked settled
and the whole batch re-ran 4–12×.

**SM4 — Orchestration: supervise the root loop.**
Add a per-step supervisor to the ROOT loop (the inline-path gap) and extend the existing
child watchdog (`prompt.ts:2145`). On stuck: rung 1 un-mutes the conductor's own reasoning
(the adaptive reasoning gate, §7.4); rung 2 escalates to the reasoner as the edit-and-run
**owner**, not an oracle of last resort — the reasoner is the first climb rung here.
Escalations are capped.

**SM5 — Allocation-matrix design-bug fix.**
High coupling + testable does not imply the executor is sufficient: an atomic INSIGHT bug can
sit in that cell and still exceed executor capability outright, because coupling and
difficulty are different axes (correction landed in §7.2). Insight-heavy work routes up
regardless of coupling. Also adds internal-trace telemetry for the routing decision.

**SM6 — Validation live-fire.**
Re-fire django-11885 end to end. Pass bar: no thrash, no test-edit-as-fix, and a probe that
was genuinely red at turn-open.

Ordering: **SM0 → SM1 → SM2 → SM3 → SM4 → SM5 → SM6.** SM1 goes first because red must be
real before any stuck signal can exist; SM2 (governance) precedes SM4 (orchestration) because
the test-edit escape hatch both closes a governance hole and *feeds* the stuck trigger SM4
depends on.

---

## 7. Inherited foundations

This doc absorbed and superseded the three earlier plan docs
(`SELF_ORCHESTRATION_PLAN.md`, `DECOMPOSITION_ORCHESTRATION_PLAN.md`,
`PERSONA_ORCHESTRATION_PLAN.md`, all deleted 2026-07-07). Their build history lives in git;
what carries forward is below — the economics that justify the mechanism, the shipped
execution-substrate invariants, the wire-level lessons, and the open items.

### 7.1 The cost thesis — why decomposition, not routing, is the lever

The savings identity: **`reduction ≈ f × (1 − 1/r)`** — `f` is the *boring share* (the
fraction of work that runs on cheap tiers) and `r` the price ratio between the expensive and
cheap tier. A whole-turn risk router does not move `f`; it only picks one tier for a
monolith. **Decomposition raises `f`**: split the task into typed slices, allocate each to
the cheapest tier that clears its need, and only the irreducible-hard core pays the oracle
rate. Risk is thereby demoted from *the decision* to *one feature* in per-slice allocation;
whole-turn risk routing survives only as the degenerate single-slice case. What makes
"default cheap" safe is the per-slice **verification gate** — execute cheap, verify,
escalate only actual failures — which is strictly cheaper than escalating on the *fear* of
failure.

Worked shape (a ~50k-token "migrate auth middleware + propagate to 40 callers" task):
whole-turn risk-veto sends all 50k to the oracle ≈ $0.22; decomposition sends 5k of design
to the oracle and 45k of verified mechanical work to the executor ≈ $0.031 — **~7× cheaper
at the same quality**. The win is entirely the `f ≈ 0.9` boring share.

The frontier gap decomposes into three parts, each with its own closer:

| Gap component | Closer |
|---|---|
| Knowledge (what the code/APIs look like) | retrieval: graph wiring + targeted web into slice briefs |
| Deterministic/coupling errors | the sound verifier ladder + behavior monitoring |
| True reasoning residual (a few % of coding work) | oracle tier; frontier escape-hatch for the last resort |

### 7.2 The allocation matrix (coupling × test-strength)

The evaluator's base allocation (`allocation.ts`) is built on this 2×2, with risk as the
tiebreaker (one cell, >70) — never the primary decision:

| | **testable** | **untestable** |
|---|---|---|
| **low coupling** | executor + verify | reasoner (spec-less mechanical) |
| **high coupling** | executor + graph wiring + verify | oracle + judge rung |

Design slices always floor at the oracle; recon/verify slices ceiling at the conductor. The
operational recipe per slice: inject wiring → dispatch cheap → sound-verify → accept, or
climb the ladder with the reverted diff as advice (§4.3).

**Correction (2026-07-08, SM5, §6):** the high-coupling+testable cell reads as "the executor
is sufficient because a safety net exists" — it isn't, for an atomic INSIGHT bug. Coupling
and difficulty are different axes: a bug can touch few files (low coupling) yet need real
reasoning to find, or touch many (high coupling) yet be pure propagation. SM5 routes
insight-heavy work up regardless of which coupling cell it lands in; the matrix's coupling
axis governs *wiring strategy* for mechanical work, not whether the executor's reasoning is
enough. **This is now formalized as the *difficulty axis* of the two-axis allocator (§8.3):**
the arming decision's `hardness` floors the *generator* independently of the coupling cell, while
coupling/consequence governs the *verifier* rung — the SM5 fix expressed as a standing axis,
not a per-cell patch.

### 7.3 Execution substrate — shipped invariants

- **Six executor personas** (Explorer / Runner / Applier / Author / Researcher / Procedure):
  each a real agent definition with its own system prompt *and* its own toolset; none
  carries `task`, `question`, or `todowrite`. Scaling principle: **routines are data,
  personas are code** — a new recurring flow becomes a parameterized brief template, never a
  new persona. Seams: `agent/` definitions, `session/system.ts` `PERSONA_DELTA`.
- **Conductor briefing contract**: every slice brief carries (a) the exact paths/entities
  the conductor already identified, (b) the method when method matters, (c) the report
  format expected back. A brief must prove the conductor understood the work.
- **Delegation is conductor-only, at every depth.** No persona can spawn or ask; the
  permission service backstops the class — in a headless run every would-be ask
  auto-resolves as reject-with-feedback, so no child can ever park on an unanswerable
  question.
- **Session-tier memory policy** — three kinds of memory, only one carries over: the
  conversation is the conductor's running memory (persistent, warm prefix, 84–97% observed
  hit rate); a worker's memory is disposable (fresh session, lean brief in, digest out);
  durable memory lives outside the chat (code graph + anchored notes). Reasoner and oracle
  sessions persist with the `x-session-affinity` gateway header for replica-sticky caching;
  the executor stays stateless with a per-persona constant prefix. Two invariants survive
  every economic argument: **the judge stays stateless** (a verifier that remembers
  endorsing the plan is a correlated verifier), and **compiled-brief discipline survives
  persistence** (a session-long oracle still gets tight deltas, never raw transcript).
- **Web search is a slice-brief ingredient, not a turn phase**: small, targeted, woven into
  the brief of the slice that needs the external fact.

### 7.4 Wire-level lessons (paid for in live-fire runs)

- **AI-SDK option naming**: on the `@ai-sdk/openai-compatible` path, snake_case option keys
  (`reasoning_effort`) are silently clobbered by the SDK's camelCase handling — config must
  use `reasoningEffort`. All four tiers ran with decorative reasoning config for weeks
  before this surfaced. If the native LLM runtime is ever enabled for the gateway provider,
  options must additionally nest under the provider slug (`openai.reasoningEffort`).
- **Hybrid thinkers default to thinking ON server-side.** The conductor is deliberately
  no-think (`reasoningEffort:"none"`, un-muted per-request by the adaptive reasoning gate
  for plan/recovery/contradiction steps only — and never for `small:true` housekeeping
  calls); thinking tiers need a 32k output ceiling so a thought can complete. Measured
  trade-off of the no-think conductor: ~+50% wall clock, +10% cost, in exchange for
  structurally eliminating the mid-think output-truncation failure class and keeping every
  token accountable.
- **Truncation is not completion**: a `finish: "length"` response with zero tool calls is a
  continuation-required condition (bounded nudge, then a visible error) — never a silent
  successful exit.

### 7.5 Carried-forward open items

| Item | Origin | State |
|---|---|---|
| Executor model swap eval (NVIDIA Nemotron 3 vs gpt-oss-120b + verify gate) | OL-M.1 | post-POC, eval-gated |
| Self-host break-even calibration folded into the live receipt | OL-M.3 / #108 | needs monthly-volume input |
| Interim summaries back from long-running children | OL-5.2 | needs bg-job event machinery |
| Canary + rollback rollout discipline | OL-6.3 | post-GA ops |
| Execution-free RM verifier rung: host the judge model, pin its ID in the registry | OL-7.8a / F16 | seam shipped (`ECON_VERIFIER_RM` endpoint config); model unhosted |
| Frontier escape-hatch: stay all-OSS or reach a true frontier model for the residual | OL-7.10 / §9 | open decision; hatch resolver ships, no product env read |
| Everyday-capability eval on test-poor repos: define the harness's case set | OL-7.12 | harness exists, case set thin |
| Gateway region move sin → bom when capacity returns | infra | tracked in feature 08 |

---

## 8. The uncertainty-management engine (prior ⟂ posterior)

**Status: implemented 2026-07-09.** Wave 3 + Wave 4a are committed (`a89c59d15`, `c52facdd0`);
Wave 4b (#55 re-decomposition, #56B logprob extraction, #59 verbalized confidence, #61
resolution-contract fix) is verified in the working tree. This section is the single home for
the engine; §1, §4.2 and §7.2 carry forward-pointers to it.

The evaluator (§4.2) asks *how hard* and *how consequential* a piece of work is. The
uncertainty engine asks the orthogonal question — *how sure are we, and **when** did we find
out?* — and routes on the answer, because the two kinds of doubt are fixed by opposite means:

- **Prior uncertainty** lives BEFORE execution: an unclear request, or an unsettled approach.
  It is **RESOLVABLE** — burn the ambiguity down with a resolution pass, *then* decompose into
  cheap slices. "Default cheap" is only safe here because the doubt was removed first.
- **Posterior uncertainty** appears only AFTER execution: verification is green, but did the
  work solve the *right* problem? Planning cannot fix this; it is only **TRUSTABLE** through a
  confidence signal. A pass on a slice we were unsure about earns one more look.

Between them sits the allocator, reframed onto **two orthogonal axes** so "how hard" and "how
consequential" never collapse into one dial (§8.3).

```
                     ┌────────── TURN-READ + decideArming (§8.1) ──────────┐
                     │  one extraction call at turn open + a pure code     │
                     │  table → {armLocalization, hardness, ambiguity}     │
                     └──────────────────────┬──────────────────────────────┘
     PRIOR (pre-exec)                       │                    POSTERIOR (post-exec)
     ambiguity → RESOLVABLE                 ▼                    green-but-wrong → TRUSTABLE
 ┌── §8.2 resolve approach ──┐   §8.3 allocate on TWO axes  ┌── §8.4 gate on green ──┐
 │ resolutionDecision →      │   generator ← difficulty     │ prior-flagged slice +  │
 │ resolve, THEN decompose   │   verifier  ← consequence    │ high uncertainty →     │
 │ (recursive, bounded)      │                              │ ONE more generator hop │
 └───────────────────────────┘                              └──────────┬─────────────┘
                                                                        │ signal (§8.5)
                                        §8.6 re-decompose on            perplexity (dormant)
                                        coverage gaps, bounded          ?? verbalized (live)
```

### 8.1 The arming decision — extracted evidence, decided in code

The turn's difficulty/ambiguity read rides the §4.1 turn-read: the model reports **facts**
per diagnosis-shaped goal (`locationNamed`/`fixSpecified`, each requiring a verbatim quote,
plus the judged `hardness`/`ambiguity`), and the decision itself is a **pure code table**
(`decideArming`, `arming-judge.ts`; applied at the `prompt.ts` step-0 block, root session
only, P1-alt):

```
arm = !fixSpecified && (!locationNamed || hardness === "hard")   // OR-ed across diagnosis goals
```

A handed fix is an executor grep (no pre-pass even with no file named); a named location
skips the pre-pass unless the bug is judged hard (knowing the file is not knowing the
mechanism); anything else arms. `localized` = every diagnosis goal names a location;
turn-level `hardness` is the max judged hardness, floored to `hard` by any `needsPlan` goal;
`ambiguity` ORs the per-goal judgement with a low-confidence extraction. Missing or invalid
evidence reads as the conservative posture (unlocated, no handed fix ⇒ arm — a cheap
pre-pass beats an expensive wrong guess); a **null verdict stands down entirely** — the P5
neutral degrade never guesses. The resulting `ArmingVerdict` (`armLocalization`,
`localized`, `hardness`, `ambiguity`, and the `evidence` spans that decided it) is stored
per-session (`setArmingDecision`) so every downstream door reads the *same* decision. It is
the **sole** authority on whether a *diagnosis* bug gets a localization pre-pass — the
turn-read `needsPlan` flag governs **build**-planning only and never overrides it (§1.4's
2026-07-10 correction). Misapplied prose rules (the django-12039 class: a trivial,
file-named fix cascading to the oracle) are structurally impossible; policy changes are code
review; the rig's decision tests are table tests. The offline arming-rig (`corpus.ts` +
`run.ts`, 41 rows) regression-guards the whole chain — over/under-fire plus wrong-seed,
wrong-role, and wrong-shape scoring — so a prompt or table change is validated without
live-fire spend. The two signals the decision produces — `hardness` and `ambiguity` — are
the inputs the rest of this engine reads.

### 8.2 Prior uncertainty — resolve the approach, then decompose (#53/#54/#61)

Before a turn decomposes, a **resolution gate** decides whether the approach is settled enough
to slice. `resolutionDecision` (`resolution-phase.ts`) runs in `slice-orchestrator.ts`
immediately before `todosToLoopSlices`, and returns a mode:

- **approach not settled** (prior uncertainty is high) → **resolve first**: a design/recon pass
  fixes an approach, or — interactively only (#54, guarded on `OPENCODE_HEADLESS !== "1"`, never
  in `opencode run`/benchmarks) — a non-blocking **clarify-and-yield** asks the user one
  question and returns `{engaged:false}` rather than guessing.
- **approach settled / plan valid** → **decompose now**.

The resolve-first pass's brief follows the turn's shape (P12's residual case): an armed
vague diagnosis resolves by planting the **localization writer** seed; anything else (an
ambiguous build/audit) resolves by planting the **plan** seed — never by hunting a bug that
does not exist.

Resolution is **recursive but bounded — per task, not per session (P10)**: the counter
(`resolution-store.ts`, `MAX_RESOLVE_ATTEMPTS`) caps how many times a turn may re-enter
resolve→decompose, and #55's re-decomposition (§8.6) shares that *same* counter — one
unified recursion budget. Every FRESH turn calls `resetResolveAttempts` at turn open, so an
ambiguous turn that burned both passes cannot disable resolution for every later turn of a
long session; a **continuation** turn (P4) skips the reset — the same task is still running,
and its recursion bound must hold across the follow-up — and stands the whole gate down (the
fresh turn that started the task already resolved it; a follow-up steers, it doesn't
restart).

**#61 — the resolution contract.** `validatePlan` (`evaluator.ts`) gained a `requireNodeFields`
structural-only mode so a free-text, todo-derived plan (no per-node objective/outputShape/
successCriterion) can still satisfy the valid-plan short-circuit. Before the fix,
`resolutionDecision` validated todo plans with the full-field requirement, so its "already valid
→ decompose-now" branch could never fire for todo callers and the gate had to work around it.
#61 threads `requireNodeFields:false` through `resolutionDecision` and removes the workaround —
the decision is now made in one place.

### 8.3 Two-axis allocation — generator ← difficulty, verifier ← consequence (#45–#47)

The allocator is reframed onto **two orthogonal axes** (`allocateSlice`, `allocation.ts`):

| axis | driven by | what it moves | rule |
|---|---|---|---|
| **generator tier** | **difficulty** (arming `hardness`) | which tier *authors* the slice | `hard` floors the author at the reasoner |
| **verifier rung** | **consequence** (coupling / blast-radius / risk) | which rung *gates* the slice | risk raises the verifier toward the judge |

The invariant: **neither axis crosses.** Difficulty raises the *author*, never the verifier;
consequence raises the *verifier*, never the author. This supersedes the old single-dial "risk
breaks one borderline cell toward oracle" tiebreak and formalizes the SM5 correction (§7.2): an
atomic-insight bug is *hard* (author floors up) but may be *low-coupling* (verifier stays
cheap), and a sprawling-but-mechanical change is the reverse. #46 threads arming
`hardness`/`ambiguity` onto every `LoopSlice` `todosToLoopSlices` builds, so the generator axis
has its signal; #47 redirects the M3 critical-floor to force the *verifier*, not the generator,
when consequence is high.

### 8.4 Posterior uncertainty — escalate on green (#48)

Even a **green** sound verdict is not automatically trusted. On a slice the arming decision flagged
as ambiguous or hard, the verify ladder's accept-on-green passes through a
**posterior-uncertainty gate** (`posterior-uncertainty.ts`, wired into the accept path of
`slice-loop.ts`): if the slice's confidence signal (§8.5) is high-uncertainty, it earns **one**
extra generator escalation *despite verification having passed*, reported via `onProvenance` as
`"posterior-uncertain-review"`. The gate reuses `dispatchRescueHop`, settles after exactly one
hop, and never re-enters the squeeze/climb FSM. An **unflagged or confident** slice accepts on
green unchanged — the extra look is spent only where prior evidence said to be suspicious.

### 8.5 The confidence signal — perplexity primary (dormant), verbalized fallback (live) (#56B/#59/#62)

The posterior gate reads `cheap.uncertainty ?? confidenceGenerate(...)` — perplexity first,
verbalized confidence as the fallback:

- **Perplexity** `= exp(−mean(token logprob))` over the dispatch's *own* generation, computed
  host-side (`logprobTokensFromParts` → `answerChannelTokens` — a per-family strip: the executor
  family strips up to/including the `<|channel|>final` boundary, the conductor family strips
  `<mm:think>…</mm:think>` — → `perplexityFromLogprobs` → `signalFromPerplexity`). It needs **no
  extra inference**: it rides logprobs the generator already produced. It is **dormant** — #62
  (probed 2026-07-09) found the LiteLLM gateway returns logprobs in *non-streaming* mode on both
  tiers but **drops them in streaming**, and every dispatch streams. The extraction is verified
  correct against real non-streaming output, and the clean injection seam exists (the central
  per-provider fetch wrapper, `provider.ts:1692`); both light up automatically the day the
  gateway emits streaming logprobs. That is an infra precondition, not app work.
- **Verbalized confidence** (#59, `confidenceGenerate` in `prompt.ts`) is therefore the **live
  primary** signal, not a compromise: a cheap conductor-tier probe that rates 0–1 how confident
  the model is that the slice solved the *intended* problem (`parseVerbalizedConfidence`,
  defaults 1.0 on empty/error). For a streaming agent this is the correct primary — obtainable
  from one cheap dedicated call without abandoning streaming or paying for a redundant
  non-streaming re-generation.

### 8.6 Re-decomposition — the §4.2 triggers, now wired (#55)

The §4.2 re-decomposition triggers are now live. After a run settles,
`redecompositionSignalsFromOutcomes` (`slice-orchestrator.ts`) derives the signals from the
outcome set (`coverageGaps` = count of `unverified` **plus `blocked`** slices — a dependent
that was never dispatched because its dep terminal-failed is work the run did not deliver,
P6a/Q-J; `budgetOverrunPct` from the escalated fraction), `redecompositionCheck` maps them to
triggers, and the post-settle block in `runConductorOrchestration` acts on them:

| trigger | condition | action |
|---|---|---|
| `new-items` | coverage gap at synthesis | reseed a **reasoner-pinned** re-decomposition pre-pass todo |
| `escalate-tier` | child >50% over budget | escalate that slice's tier (not a wider fan-out) |
| `replan-less-parallel` | sibling conflict at fold-back | re-plan with less parallelism |
| `reorder` | wall-clock ≥2× estimate | suspect a hidden sequential dependency, re-order |

Only `new-items` currently reseeds work, and it does so through the **same recursion counter**
as the prior-resolution gate (§8.2) — a re-decomposition and a re-resolution draw on one shared
budget, so the turn cannot loop unboundedly. An `onRedecomposition` telemetry sink reports the
triggers and the signals behind them on every settled run, whether or not any was acted on.
