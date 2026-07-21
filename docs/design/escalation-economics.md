# Escalation economics — why the deferral cascade over-fires

> **Status (2026-07-21): BUILT, NOT YET MEASURED** — committed as `3a527a5a1`. The root cause
> below is source-verified against the live engine. §10 Steps 1, 2, 4 and 5 are **implemented,
> wired and unit-green** (`deferral-policy.ts` + its wiring, the `escalationEarned` gate guard,
> `issue-scope.ts`, the trigger-rate invariant test, and the escalated-payload trim).
> **No live run has been done.** Every cost and rate claim in §10 remains a prediction until
> the A/B lands.
>
> One caveat on an earlier revision of this header: it called Step 4 "implemented and
> unit-green" while `evaluateIssueScopeGate` had **12 green tests and zero production callers**.
> It was unreachable. Wired in `3a527a5a1` via the exported `evaluateHubEditGate`. Green tests
> are not evidence of reach — check callers.
>
> The current binary (`bin-snapshots/opencode-v2-0720-2114`) holds **10/10 real-graded on the
> SWE mini-10** ([§1](#1-the-measured-result)) — that is the only evidence we have that today's
> finish path is safe, so it stays the reference. **Step 3 is blocking**: nothing here may be
> called a success until the A/B holds 10/10 *and* the trigger rate reads ≤15%.
>
> Known behavioral deltas to watch on that run: escalation now requires a cheap rung to have
> been spent first, `hub_bounce_repeat` no longer escalates at all, and the turn-wide rung bound
> is `CHEAP_RESPONSE_BUDGET = 1` (restoring the single-rung bound the old one-shot deferral
> budget enforced). Issue-scope DENY ships **off** (`ECON_ISSUE_SCOPE_DENY`) so the run measures
> the boundary's precision before it can veto anything.
>
> **This doc is the post-implementation measurement of [gap-closure-plan.md](./gap-closure-plan.md)
> H9 and §4.3.** Read that first — it is the parent plan. H9 proposed wiring the Tier-2
> deferral triggers into the escalation gate; §4.3 collapsed the solve ladder to
> `conductor → oracle` and re-scoped the reasoner as judge-only. Both shipped. This doc reports
> what they cost in the live V2 fleet, and finds that **H9's own two stated preconditions were
> never met** ([§4.5](#45-h9s-unmet-preconditions)).
>
> Other companions: the deferral **mechanism** is owned by
> [`features/08-signal-bus.md` §3](../features/08-signal-bus.md); the agnostic sensing layer by
> [`design/agnostic-hands-eyes.md`](./agnostic-hands-eyes.md); cross-tier briefs by
> [`design/cross-tier-context.md`](./cross-tier-context.md); the tier/judge decision by
> [gap-closure-plan.md §4.3](./gap-closure-plan.md) (**not re-litigated here**). This doc owns
> only the **economics**: when escalation is worth its price, and why it currently is not.

---

## 0. The one-paragraph version

Eight independent, deterministic gates can arm a deferral. None of them requires evidence
that the fix is **wrong** — they all fire on *suspicion* (a red test, an unverified finish,
hub coupling). Routing the resulting seed to the oracle is correct **by design**
([gap-closure-plan §4.3](./gap-closure-plan.md)); the defect is **how often** it fires and
**what it is handed**. H9 set the bar at *"must stay rare — target ≤15% extra escalations"*
and specified *"ONE bounded oracle draw (compiled brief + 12-step cap)"*. The live V2 fleet
escalated on **6 of 10 instances (60%)**, and the compiled brief **was never wired** — the
oracle still receives the full cold transcript. Meanwhile the guardrail meant to keep the
deferral seed from buying orchestration automatically is circular: the gate deciding whether
an escalation "earned" its dispatch accepts *the arming signal itself* as the qualification.
The result is a category error — the arms detect *"I did not verify this,"* and the system
responds *"re-author it with a bigger model."* An oracle cannot verify; it can only re-derive.
Re-deriving an already-correct fix is a no-op, which is exactly what we measured: **six
escalations, zero source edits authored, 32–61% of all turns spent above the conductor.**

---

## 1. The measured result

V2 clean-room fleet, 2026-07-20, binary `opencode-v2-0720-2114`, strict mode
(no planted tests, gold vaulted during the run, strip-the-future hard gate, zero
`CALIBRATED:` exclusions, ancestry leak audit clean on all ten).

| instance | cost | turns | escalated | arming trigger |
|---|---|---|---|---|
| 11790 | $0.0458 | 18 | no | — |
| 11815 | $0.5949 | 114 | yes | `fidelity_finish_reject` |
| 11848 | $0.4921 | 79 | yes | `unverified_finish` |
| 11880 | $0.5295 | 97 | yes | `unverified_finish` |
| 11885 | $1.3134 | 206 | no | — |
| 11951 | $0.0628 | 27 | no | — |
| 11964 | $0.3225 | 63 | yes | `hub_bounce_repeat` |
| 11999 | $0.2632 | 59 | yes | `hub_bounce_repeat` |
| 12039 | $0.6174 | 137 | yes | `fidelity_finish_reject` |
| 12050 | $0.1769 | 75 | no | — |

**10/10 PASS, $4.4185, 875 turns.** Six of ten escalated.

### 1.1 Escalation authored nothing — 6/6

Method: locate the `deferral_dispatched` log line, then classify every non-test `.py` edit
as before or after it.

| instance | dispatch @ line | oracle window | source edits after dispatch |
|---|---|---|---|
| 11815 | 1636 | — | none (only a test edit, denied by the no-test-edit gate) |
| 11848 | 591 | — | none |
| 11880 | 557 | 558–937 | 5 edits — **all `agent=conductor`**, decisive one at 3232, ~2,300 lines after the oracle window closed |
| 11964 | 1228 | 1229+ | none |
| 11999 | 723 | 724–942 | none (only edit at 535, pre-dispatch) |
| 12039 | 2191 | 2192–2773 | none (last edit at 2033, pre-dispatch) |

Oracle-tier turns were **32–61% of all turns** on these six.

> **Cost caveat.** The run logs carry **no per-turn cost telemetry** — the only cost field is
> `cost=0` and `spent:` appears once at the end. Any claim of a dollar split between
> pre- and post-escalation spend is unfounded. Oracle **turn share** is the defensible proxy.

### 1.2 The near-miss that looked like a win

11964 shipped the correct root-layer fix (`__str__` on `Choices`, `enums.py`) on the instance
our notes record as the tier-immune spec-gap failure. It is tempting to credit escalation.
The log timeline refutes it:

- **line 816–828** — agent tries `query_utils.py`; the hub-edit gate bounces it **twice**,
  naming `django/db/models/enums.py` as the defining site
- **line 929, 974** — agent edits `enums.py`. **The correct fix is now on disk.**
- **line 1181** — `deferral_armed`, consuming `hub_bounce_repeat`
- **line 1228** — dispatched; 42 oracle turns begin
- **line 1504, 1541** — the oracle concludes: *"Single minimal edit at `enums.py:46-47`, on
  the `Choices` base class"* — re-deriving what was already there

What cured 11964 was the **deterministic `hub_edit_gate`**, ~250 log lines before the gate
even armed. This is the sharpest single piece of evidence in the study.

---

## 2. The arming surface — all eight arms

Seven failure-evidence arms in `prompt.ts` plus the H9 arm in `turn-supervisor.ts`.
**Every precondition is deterministic** — counters, latches, transcript scans, regex, signal
presence. No LLM call sits inside any arm.

| # | trigger | site | indicator | fires on a correct fix? |
|---|---|---|---|---|
| 1 | `probe_gate_exhausted` | `prompt.ts:~3887` | lagging | yes |
| 2 | `oracle_inversion` | `prompt.ts:~3729` | lagging | yes (red is the *good* sign) |
| 3 | `fidelity_finish_reject` | `prompt.ts:~4007` | lagging | yes |
| 4 | `promoted_pin_green` | `prompt.ts:~4049` | lagging | yes |
| 5 | `seen_red_unresolved` | `prompt.ts:~4376` | lagging | yes |
| 6 | `unverified_finish` | `prompt.ts:~4710` | lagging | yes |
| 7 | `regression_red` | `prompt.ts:~5246` | lagging | yes |
| 8 | `hub_bounce_repeat` | `prompt.ts:~5311` via `shouldArmHubBounceDeferral` (`turn-supervisor.ts:653-666`) | **lagging** — fires on the otherwise-clean finish path | yes |

**Disjunction, one budget.** Each arm is independent, but `markDeferralUsed`
(`prompt.ts:3595`) spends a single per-session deferral, so the first arm to fire wins and
the rest go quiet or loud. Eight ORed detectors over any non-trivial bug is near-certain to
trip.

**No arm demands proof the fix is wrong.** This is the core defect, not an implementation
bug. Every arm escalates on symptom-layer or structural suspicion. All eight can fire on a
run whose fix is already complete and correct.

**`hub_bounce_repeat` is a lagging indicator of a *solved* problem.** It means "the agent
tried the wrong layer twice and was corrected." By the time it is true, the correction has
already happened (§1.2).

---

## 3. The cost mechanism — a diagnosis request routed to an implementer

`deferralPrepassTodo` (`slice-orchestrator.ts:1435-1444`):

```ts
return {
  content,
  status: "pending",
  priority: "high",
  sliceType: "design",   // ← routes to oracle
  need: "reasoner",      // ← ALSO routes to oracle
  persona: "researcher",
}
```

Both fields land in the same place:

- `allocation.ts:259` — `if (sliceType === "design") tier = "oracle"`
  *"§4.3: the reasoner is judge-only now, so the insight-heavy floor lands straight on the
  oracle — one hop, no maybe-rung."*
- `allocation.ts:322` — `tier = needTier === "reasoner" ? "oracle" : needTier`
  *"a `reasoner` need hint is honored … redirected to the one solve rung above conductor
  (oracle) — the reasoner is judge-only and never generates."*

**This routing is intended, not a bug.** [gap-closure-plan §4.3](./gap-closure-plan.md)
deliberately collapsed the solve ladder to one hop — *"conductor → oracle … Keep the reasoner
slot, re-scoped as the judge tier only … It never solves"* — precisely to kill the six-rung
judge cascade that 11880 exhibited. Both `allocation.ts` lines are that decision, faithfully
implemented. **Do not "fix" the tier.**

What §4.3 did *not* anticipate is the interaction: the seed's `need: "reasoner"` is the
**honest expression of intent** — it wants a *diagnosis*, not an implementation. Once reasoner
stopped being a solve rung, that intent had nowhere to land and now falls through to the
oracle (`z-ai/glm-5.2`). A request for verification is answered by the most expensive
*author* we have. This is the mechanical reason each escalation costs 42–100 oracle turns, and
it is why the fix belongs in **what gets dispatched** (§10 Step 1), never in the tier map.

Dispatch bound: `ABOVE_CONDUCTOR_STEP_CAP = 12` steps per oracle dispatch
(`slice-orchestrator.ts:358`) — *agent-reported, not independently verified.*

> **Doc drift found:** [`features/08-signal-bus.md` §3](../features/08-signal-bus.md) states
> the design rule routes the author to the **reasoner** tier at `allocation.ts:240`. That was
> true when written and is now **stale** — §4.3 changed it to oracle at `allocation.ts:259`.
> Corrected in the same change that added this doc. The stale line is part of why the cost
> stayed invisible.

---

## 4. The circularity — the guardrail defeats itself

`deferralPrepassTodo` is **deliberately excluded** from `HARNESS_SEED_CONTENTS`
(`slice-orchestrator.ts:1413-1417`, comment at `:1426-1431`):

> *"DELIBERATELY excluded from `HARNESS_SEED_CONTENTS`: the deferral cascade has a measured
> cost cliff (11964 shipped a 15/17-failing patch after `deferral_armed`; 11880 burned 62
> above-conductor turns post-deferral for zero outcome change), so this seed must earn
> orchestration the normal way (real width, or probe-derived coupling/risk) rather than
> buying it automatically the way the other three prepass seeds do."*

The prior cost cliff was therefore **already known and already documented**. But the gate that
enforces "earn it the normal way" is `explainOrchestrationGate`
(`slice-orchestrator.ts:2204-2221`):

```ts
if (slices.some((s) => s.harnessSeeded)) return { engage: true, trigger: "harness-seed" }
if (slices.length >= 6)                  return { engage: true, trigger: "breadth" }
if ((goalCount ?? 0) >= 2)               return { engage: true, trigger: "goal-width" }
if (slices.some((s) => s.coupling === "high" || (s.risk ?? 0) > ALLOCATION_RISK_TIEBREAK))
                                         return { engage: true, trigger: "coupling-risk" }
// H9 — checked last
if (signals?.hubBounceRepeat)    return { engage: true, trigger: "hub-bounce-repeat" }
if (signals?.probeGateExhausted) return { engage: true, trigger: "probe-gate-exhausted" }
if (signals?.reproUnresolved)    return { engage: true, trigger: "repro-unresolved" }
return { engage: false, trigger: "none" }
```

Lines 2217–2219 accept `hubBounceRepeat`, `probeGateExhausted`, `reproUnresolved` — **the same
signals that arm the deferral**. Signal X arms the escalation, then signal X is accepted as
proof the escalation earned its dispatch.

Those three lines are **H9** ([gap-closure-plan.md](./gap-closure-plan.md), lines 269-286),
which specified exactly this: *"Add three deterministic triggers to the gate (`247cf53b3`
lineage): (a) second hub-gate bounce on the same turn, (b) `probe_gate_exhausted`, (c)
`repro_unresolved` at finish-intent."*

**Neither change is wrong on its own.** The `HARNESS_SEED_CONTENTS` exclusion says the
deferral seed must earn orchestration; H9 says these three signals are sufficient earning
evidence. Each is defensible in isolation. Together they close a loop neither author saw,
because the same three signals sit on both sides of it. This is an **interaction defect**, not
a mistake by either change — which is why reading only one of the two commits explains
nothing.

**Consequence:** narrowing the `escalationSeedPending` bypass alone (see §5) would change
almost nothing, because the arming signal independently opens the gate. Any fix must address
the circularity, or it is cosmetic.

---

### 4.5 H9's unmet preconditions

H9 did not ship unconditionally. It carried two explicit constraints, and **both are currently
unmet in the live binary** — which is the single most actionable finding in this document.

| H9's stated requirement | verbatim | live state |
|---|---|---|
| **Trigger rate must stay rare** | *"trigger-rate audit on the 26 resolved instances (must stay rare — **target ≤15% extra escalations**)"* | ❌ **60%** — 6 of 10 V2 instances escalated (§1). **4× the bar.** |
| **Dispatch carries a compiled brief** | *"Each opens ONE bounded oracle draw (**compiled brief** + 12-step cap, §4.3)"* | ✅ **Wired** — `compileBrief` reaches production via `buildEscalationBrief` (`slice-loop.ts:611`, called from `dispatchRescueHop:717`) and `buildAboveConductorSliceBrief` (`slice-orchestrator.ts:2948`). |
| **12-step cap** | *"+ 12-step cap"* | ✅ `ABOVE_CONDUCTOR_STEP_CAP = 12` (`slice-orchestrator.ts:358`). |

> **Correction (2026-07-21).** An earlier revision of this section claimed the compiled brief
> was *never wired* and that the escalated tier receives the full cold transcript. **That was
> false**, caught when a build agent ran `get_references` on `compileBrief` before implementing
> the "fix" and refused to proceed on a bad premise. The wiring landed 2026-07-15, before this
> research began. See §13 correction 3 — this is the study's fourth source-verification catch,
> and the only one that survived into a published draft.

So **one** of H9's three constraints is unmet, not two. It is the load-bearing one.

The residual on the payload side is narrow and real but is *not* the described defect: on the
`escalated: true` branch, `prompt.ts:6451-6456` still wraps the already-compiled brief in
`repoPrimer` + `renderSliceDigestLedger` + `parentTask`. Both wrappers are bounded and capped —
redundancy worth trimming (§10 Step 5), not a full-transcript dispatch.

The conclusion survives the correction, and gets sharper:

1. **We are not looking at a design failure. We are looking at an unvalidated deployment.**
   H9's own acceptance test — the trigger-rate audit — appears never to have been run against
   a live fleet. Had it been, 60% would have failed it and H9 would not have shipped in this
   shape. The plan's judgement was sound; the gate between plan and production was missing.
2. **Rate is the whole problem.** With the brief wired and the step cap live, the payload and
   bound H9 specified are both in place. What moved against us is **frequency alone** — and
   frequency is exactly what the never-run audit was supposed to catch. This *narrows* the fix:
   §10 Step 1 (respond to the complaint) and Step 2 (break the circularity) are the remedy;
   the payload work is a minor trim.

**This gives us our acceptance criterion for free.** We do not need to invent a target: H9
already set one. Any fix ships only when the trigger-rate audit reads **≤15%** and the 10/10
holds (§10 Step 3).

---

## 5. How #40 (V1-FIX) fits

`resolution-phase.ts` branch order, in evaluation order:

| branch | condition | mode |
|---|---|---|
| **0** | `escalationSeedPending === true` | `decompose-now` — *"gate-mandated dispatch, precedes armed-inline policy"* |
| 1 | `!flagged` | `decompose-now` |
| 1b | `armLocalization === true` | `resolve-first` → then `continue-inline` |
| 2 | `candidatePlan` valid | `continue-inline` (2b valve) or `decompose-now` |
| 3 | `needsUserInput && interactive` | `ask-user` |
| 4 | `resolveAttempts >= MAX_RESOLVE_ATTEMPTS` | `decompose-now` |
| 5 | fallthrough | `resolve-first` |

Branch 0 was added by **#40** to fix a real bug: branch 1b's `continue-inline` was vetoing an
armed deferral's dispatch, and an unverified regression shipped on 11885 (V1-LESSON). The fix
was correct in intent but wrong in remedy — it gave the seed **unconditional highest
precedence**, which is the automatic dispatch the `HARNESS_SEED_CONTENTS` exclusion existed to
prevent.

**#40's justification is also now hollow:** the V1-LESSON regression it targeted was on
11885, which V2 passed with **zero escalation** (§1).

**Do not simply revert #40** — that restores the 1b veto and the original bug. The fix must
keep dispatch reachable while removing both the unconditional precedence *and* the §4
circularity.

---

## 6. Scope leak — escalation expands the patch (#43)

**The hub-edit gate is live, not dead code.** Wired at `prompt.ts:5532`
(`setHubEditGate(sessionID, true); setHubEditIssueText(sessionID, userText)`), inherited by
children at `prompt.ts:5508`. The graph reports **2 production callers, 31 test callers** for
`evaluateHubEditGate`.

But it is a **hub-coupling gate, not an issue-scope gate**. Its defining-site allowlist is
used only to *allow* (`edit-governance.ts:937-942`); **nothing anywhere denies an edit for
being outside the issue's scope.** Files below the fan-in threshold are allowed
unconditionally — the gate has no opinion, because it is not asking that question.

### 6.1 The django-11880 chain

1. Escalation dispatches
2. Agent runs a broad multi-app sweep (`forms_tests model_forms … validators`)
3. Sweep surfaces two **pre-existing** failures unrelated to the issue:
   `validators.tests.TestValidators [URLValidator]` newline cases
4. Agent runs the *correct* experiment — `git stash push django/forms/fields.py`, re-runs,
   sees the **same two failures** — and thereby **proves they pre-date its change**
5. Agent ships 8 unrequested lines into `django/core/validators.py` anyway

Required fix: **1 line** in `django/forms/fields.py` (F2P = a single test,
`test_field_deep_copy_error_messages`; the gold patch is one line). It graded OK only because
those `URLValidator` tests are **not in P2P** (P2P's only validators entry is
`test_validators_independence` in `forms_tests`). On an instance where the collaterally-edited
module *is* graded, this breaks an otherwise-passing run.

**Two missing primitives:**
- an **in-scope file set** derived from the issue's resolved defining sites, used to *deny*,
  not only to allow
- a place to record **"this failure pre-dates my change"** — the agent computed that proof
  itself and had nowhere to put it

---

## 7. Tiers and judges (#44) — should the reasoner stay the judge?

**Binding** (`model-registry.ts:177-182`):

```ts
conductor: "minimax/minimax-m3"
executor:  "openai/gpt-oss-120b"
reasoner:  "deepseek/deepseek-v4-pro"
oracle:    "z-ai/glm-5.2"
```

- **reasoner = judge-only.** Never generates code (`allocation.ts:259`, `:322`, and
  `lowerTier` skips it when descending).
- **oracle = implementer-only.** Never appears in a judge context.
- `resolveJudgeTier` defaults to **reasoner**, overridable by `ECON_VERIFIER_JUDGE`
  (`model-registry.ts:355-359`) — *agent-reported.*

### 7.1 This was already decided — and the evidence confirms it

**[gap-closure-plan §4.3](./gap-closure-plan.md) owns this decision**, and it is not reopened
here: *"Keep the reasoner slot, re-scoped as the judge tier only … It never solves."* Its
rationale was cross-family judging (a model should not judge its own family — 52pp
self-preference, per [`cheap-judgment-research-2026-07`]). Per the one-home-per-fact rule, the
decision lives there; this section only reports whether the V2 evidence **supports or
undermines** it.

**Verdict: supports it.** Nothing measured argues for moving the judge to the oracle, and one
thing argues against it (§4.5 — the oracle is already the cost sink; adding judging would
enlarge it). #44 can close as *confirmed, no change*.

The "cheap model can't judge a cheap model" concern is real research, but **it does not apply
to what is causing over-escalation** — all eight arms are deterministic (§2). Where LLM judges
*are* load-bearing for cost, they are already cross-tier by design:

| judge | site | judges | verdict |
|---|---|---|---|
| cross-model judge | `judge.ts:119` | **executor** output, from a different family | correct shape |
| QE veto | `qe.ts:263` | **executor** output, from oracle/reasoner family | correct shape |
| repro-fidelity | `repro-fidelity-judge.ts:240` (`dispatchPinnedReproFidelity`) | the pinned repro | LLM verdict is **overridden** by deterministic checks (`hasAssertionTeeth`, `detectRenderedAssert`, `detectStringifiedMirrorAssert`, …) — determinism has final say |

That last row is already the architecture the research recommends: the cheap LLM is advisory,
the deterministic check decides. Moving judging to the oracle would cost more and buy nothing.

**The finish-time fidelity check specifically** (`fidelity_finish_reject`) is **not** an LLM
judge — it is deterministic, $0, no model call. It is the largest single arming source (2 of 6
in V2), but deleting it treats the symptom: the cost lives in what it *arms*, not in the check.
Keep the check; fix the response.

---

## 8. Knowledge senses (#46) — the missing "fetch before escalate"

Already built and good:

| capability | site | notes |
|---|---|---|
| code-graph index | `graph-tools.ts:208` (`prepareGraphIndex`) | lazy, incremental, persistent; language-agnostic |
| error-search | `error-search.ts:262` (`shouldSearchForError`) | fires on unrecognized / dependency-rooted errors, or repro unresolved ≥2 |
| **version pinning** | `error-search.ts:242` (`embedVersion`) | queries carry the **lockfile-resolved** version |
| lockfile resolution | `repo-profile.ts:643-670` | uv/poetry, pnpm/npm/bun/yarn, Cargo, go.mod, Gemfile — never assumes "latest" |
| versioned doc URLs | `error-search.ts:~357` (`docUrlForDependency`) | `docs.rs/<v>`, `npmjs.com/v/`, `djangoproject.com/en/X.Y/` |
| fetch + compress | `fetch-batch.ts:226`, `extract.ts:387` | DOM extraction → markdown, BM25 ranking |

This satisfies the standing rule that *every external lookup must carry the lockfile-resolved
dependency version*.

**The gap:** there is **no code path that routes a confounded agent to knowledge-fetch before
escalating tier.** Tier routing is decided at turn-open from prompt heaviness and structural
risk, and never consults repro state. Error-search is available as a tool but is not on the
escalation path. So a turn that loops on an unresolved repro jumps to the oracle rather than
first fetching the right versioned doc at the cheap tier.

*(An earlier revision noted `docUrlForDependency` hardcoding Django as a minor debt. Fixed in
`3a527a5a1` — it is now a data table; see [§11](#11-language-agnosticism-and-v3-20).)*

---

## 9. Multi-agent / Fugu mode (#45)

**Exists:** wave-parallel slice dispatch (`slice-loop.ts:1472-1492`, `Promise.all` within a
topological wave); the posterior-uncertainty second opinion
(`posterior-uncertainty.ts:170-174`, E1-gated, one hop, double-pay ledgered); personas
(`ECON_PERSONAS`, `model-registry.ts:193`); the escalation ladder
(`escalateTier`, `slice-loop.ts:1307`).

**Does not exist:** any cross-model comparison, voting, or reconciliation. Confirmed absent.

**Payload state (corrected 2026-07-21).** `compileBrief` **is** wired in production — via
`buildEscalationBrief` (`slice-loop.ts:611` → `dispatchRescueHop:717`) and
`buildAboveConductorSliceBrief` (`slice-orchestrator.ts:2948`). The executor token budget
(`subagent-data.ts`, `SUBAGENT_TOKEN_BUDGET_DEFAULT`) is wired too. An earlier draft of this
section claimed both were missing; see §4.5 and §13 correction 3.

Two genuinely open items remain, both small:
- `prompt.ts:6451-6456` wraps the compiled brief in `repoPrimer` + `renderSliceDigestLedger` +
  `parentTask` on the `escalated: true` branch. Bounded and capped, so it is redundancy to
  trim, not a defect.
- `briefFromContext` (the `ReconBundle` adapter) has **zero** production callers — dead code.

**Then**, a two-proposal + reconcile mode. Genuinely new work: a reconciliation rule, a
multi-proposal brief format, and a tiebreaker. Must be **signal-gated and off by default**
(`ECON_MULTI_AGENT_MODE=off|two-tier|triadic`), with a cost ceiling asserting the cooperative
path costs less than escalating straight to oracle. This does **not** contradict the standing
"no blanket best-of-N" rule, which declines *unconditional* N-draws, not signal-gated
redundancy on the hard tail.

---

## 10. The plan

Ordered. Each step is independently revertible.

### Step 1 — route the response to the complaint (the core fix)

Classify what each arm is actually complaining about, and answer *that*:

| complaint | arms | correct response | tier |
|---|---|---|---|
| **verification gap** | `unverified_finish`, `seen_red_unresolved`, `probe_gate_exhausted` | run the discovered check | conductor — no escalation |
| **knowledge gap** | unrecognized / dependency-rooted error, repro unresolved | error-search + version-pinned docs (§8) | conductor — no escalation |
| **already corrected** | `hub_bounce_repeat` | **nothing** — lagging; the hub gate already fixed it (§1.2) | none |
| **capability gap** | residual, only after the above are exhausted | escalate | oracle |

This preserves escalation for the cases that need it, which is the stated requirement.

### Step 2 — break the circularity (§4)

`explainOrchestrationGate` must stop accepting the arming signal as earning evidence.
Without this, Step 1 is cosmetic.

### Step 3 — re-run V2 against the pinned binary, and run H9's audit

**Non-negotiable and blocking.** The 10/10 is our only evidence today's finish path is safe,
and every change above touches it. A/B against `opencode-v2-0720-2114`.

**Two acceptance gates, both required:**

| gate | source | pass condition |
|---|---|---|
| pass rate | V2 baseline | **10/10 real-graded**, zero `CALIBRATED:` exclusions |
| trigger rate | **H9's own bar** (§4.5) | **≤15%** of instances escalate (V2 today: 60%) |

The trigger-rate audit is the acceptance test H9 specified and that appears never to have been
run (§4.5). Running it is not new scope — it is the missing half of a change we already
shipped. It also makes the audit **permanent**: escalation rate becomes a tracked invariant
per run, the way per-language coverage became one in G4b, so this cannot silently regress again.

### Step 4 — issue-scope boundary (§6)

Derive an in-scope file set from the resolved defining sites and let it **deny**. Capture the
pre-existing-failure proof the agent already computes.

### Step 5 — trim the escalated dispatch payload (§9)

**Reduced in scope after correction** — the compiled brief is already wired. What is left:
strip the redundant `repoPrimer` / digest-ledger / `parentTask` wrappers from the
`escalated: true` branch (`prompt.ts:6451-6456`), and delete the dead `briefFromContext`.
Minor cost trim, no behavior change.

### Step 6 — generalize the arena, then V3 (§11)

### Step 7 — revisit Fugu-mode with real data (§9)

---

## 11. Language agnosticism and V3 (#20)

The **engine** is in good shape. `ECOSYSTEM_CONVENTIONS` (`repo-profile.ts:140-294`) is a
genuine data table (python-pytest, python-django, javascript-jest, javascript-vitest, go,
rust, java-maven, java-gradle, ruby, php); adding Kotlin is one row. `compileReproVehicle`
(`nudges.ts:27-34`) substitutes the vehicle at injection time, so seeds and identity
comparisons stay in the repo's own ecosystem. Skip-detection and case-count extraction use
multi-pattern fallbacks plus a structured-report override.

**Engine debts — re-measured against source 2026-07-21 (`3a527a5a1`).** An earlier revision of
this table listed three debts. Three of the four items below were **already fixed when it was
written**; the table was inferred from a design doc's to-do state rather than checked against
the code. Corrected:

| claimed debt | site | verdict |
|---|---|---|
| `PYTHON_REPRO_VEHICLE` fallback default | `prompts/nudges.ts:17` | **not a debt** — fail-soft only. Both production callers (`prompt.ts:2802`, `:5912`) already derive the vehicle from `getRepoProfileSync(...).ecosystems[0]?.repro`; the constant is reached only when detection fails outright. |
| `REPRO_SLICE_CONTENT` frozen at the Python default | `seeds.ts:71` | **not a debt** — sole production path is `reproSliceContent` → `reproPrepassTodo` → `buildTriageTodoSkeleton` → `prompt.ts:5920`, which passes that same profile-derived vehicle. (This had been carried as an open blocker on the grounds that its consumers were unverified; they are now traced.) |
| ecosystem branch in the regression gate | `prompt.ts:~5138-5167` (was cited as `:5027`/`:5030`/`:5054`) | **not a debt** — `resolveToolchainEcosystem` / `discoverProjectToolchain` are already a generic per-ecosystem dispatcher. The residual `=== "python"` checks scope the python-only `topLevelPackage` rung, which no other ecosystem's ladder needs. |
| `docUrlForDependency` hardcodes Django | `error-search.ts:~340-388` | **fixed** in `3a527a5a1` — replaced by two data tables (`ECOSYSTEM_DOC_URL`, `FRAMEWORK_DOC_URL`), with go and ruby added. Django's output is byte-identical. |
| interpreter regex in the probe-gate arm | `prompt.ts:3639` — `/^python3?\b/` | **real, but mis-sited.** Generalizing this gate *alone* is a no-op: `rewriteSegmentHead` (`regression-neighbors.ts:1297`) returns the segment untouched unless the head is literally `python` or `python3`, so every other ecosystem would run a shell probe each turn and always find nothing to rewrite. The fix belongs in `regression-neighbors.ts`. **This is the only surviving engine debt.** |

**Net: one real debt, not three — and it sits one layer deeper than the table said.** This is the
same failure mode §13 catalogues: a to-do state in a plan doc was copied forward as a
measurement. The engine's agnosticism is in better shape than this section previously claimed.

**The binding V3 blocker is the arena, not the engine.** `~/econ-swe-arena` is hardcoded to
**Django specifically**, not merely Python:

| site | assumption |
|---|---|
| `build_run.sh:14` | `PY39=~/.pyenv/versions/3.9.19/bin/python3.9` |
| `build_run.sh:65-66` | `python -m venv .venv` + `pip install -e .` |
| `build_run.sh:100`, `grade.sh:45` | `tests/runtests.py --settings=test_sqlite` — Django's own runner, not even pytest |

`pull_meta.py` already falls back from `SWE-bench_Verified` to full `SWE-bench`, but both
splits are Python-only, so a non-Python instance needs a different dataset **and** a
generalized driver.

**Fix shape** (this is exactly the discovery principle from
`../unerr-benchmarks/e2e/distributed/HARNESS_UNIVERSAL.md`, applied to our arena): discover
`{install, test}` per instance from the repo's own CI/manifests, cache to
`meta/<id>/commands.json`, and have `build_run.sh` / `grade.sh` consume that ledger instead of
literal Django commands.

> **Scope note on HARNESS_UNIVERSAL.md:** that doc explicitly scopes itself to the `claude-*`
> arms and says it does **not** apply to the econ arm, and it is marked DESIGN (not built).
> We adopt its *principles* — discovery over hardcoding, done-signal bound to a discovered
> command, mechanical-only stuck detection, delegation over in-session escalation — not its
> implementation sketch, which describes a different codebase.

**Honest framing:** the arena's Django-hardcoding does not refute the engine's agnosticism
claim — it means we currently have **no way to prove it**. That is what V3 exists for.

---

## 12. What is NOT established

- **"Escalation never helps" is not proven.** The zero-value result is solid for the six V2
  escalations. It is not a general law. Step 1 must be measured, not assumed.
- **No dollar attribution.** §1.1 — the logs have no per-turn cost field. Turn share only.
- **The roundF A/B is unusable as a cost baseline.** Those runs pre-date the strip-the-future
  fix, so their arenas still reached ~25k future commits; cheap numbers there may reflect
  leaked gold fixes. RoundF validly establishes only *engine behavior*: arming happened
  (11815, 11880, 11951 each armed twice) and dispatch did not.
- **Single-run cost claims are unsound generally** — we have measured ±44% swings on an
  identical binary.
- **Step 1's taxonomy is a hypothesis.** Mapping arm → complaint class is a design judgement,
  not a measurement.

---

## 13. Provenance, and corrections made during the research

Synthesized 2026-07-21 from eight parallel source-grounded research streams (arming census,
tier roles, judge inventory, agnosticism audit, scope control, dispatch machinery, knowledge
senses, multi-agent feasibility) plus direct main-thread verification. **No web research** —
every claim is grounded in this repo, `~/econ-swe-arena`, or the V2 run logs.

Three sub-agent claims were wrong and were corrected against source. Recording them because
the same failure mode will recur:

1. **"`evaluateHubEditGate` is dead code — all 31 callers are tests."** False. 2 production
   callers (`prompt.ts:5508`, `:5532`). The agent read a **truncated** caller list dominated by
   tests and inferred absence. Contradicted by live log evidence (the gate bounced
   `query_utils.py` on 11964).
2. **"`interpreter_mismatch` / `interpreter_harvested` do not exist in the codebase."** False —
   both fired in `run-11964.log`. A search failure, not an absence.
3. **Fabricated cost splits** ("pre-escalation $0.3505 / 58.9%", "oracle consumed 71.7% of
   budget"). No such data exists in the logs (§1.1). Also wrongly reported 11880 as having no
   post-dispatch source edits; there were five.
4. **"`brief.ts` is built but unwired; the oracle receives the full cold transcript."** False,
   and the only one of the four that reached a published draft of this document (§4.5, §9,
   §10 Step 5, and the `docs/README.md` index entry all had to be corrected). `compileBrief`
   has had production callers since 2026-07-15 — *before this research began*. Caught only
   because the build agent assigned to "wire the brief" ran `get_references` first and refused
   to implement against a false premise. **The absence of a caller was never verified; it was
   inferred from a design doc's to-do state.**

Three earlier main-thread conclusions were also wrong, all corrected in this document:

1. *"Narrow #40 so the seed earns orchestration the normal way."* §4 shows the earn-gate
   accepts the arming signal itself, so that change alone would accomplish nearly nothing.
2. *"The deferral seed is **mis-routed** to the oracle."* It is not. Reading
   [gap-closure-plan §4.3](./gap-closure-plan.md) showed the `conductor → oracle` collapse is a
   deliberate, reasoned decision, and both `allocation.ts` lines implement it faithfully. The
   defect is the **frequency** of firing and the **payload** it carries (§4.5), not the tier
   map. §3 was rewritten accordingly.
3. *"§11 lists three real engine debts."* Three of them were already fixed, and the one that
   survived is mis-sited — the interpreter branch cannot be generalized where §11 pointed,
   because `rewriteSegmentHead` gates on a literal `python` head one layer down. The table had
   been copied forward from a plan's to-do state and never re-checked against source. This is
   correction 4's failure mode repeating on the main thread rather than in a sub-agent, which
   is the point: **the discipline is not "distrust sub-agents," it is "verify the decisive
   measurement was actually taken" — by whoever wrote it.**

**Correction 2 is the methodological lesson of this research.** The first eight streams read
only *source*, and source alone made a deliberate decision look like an accident — the code
cannot tell you what it was trying to do. Reading the one upstream *plan* doc reversed the
finding, and then supplied the acceptance criterion (≤15%) and half the remedy (the compiled
brief) already written down. **Read the plan that produced the code before diagnosing the
code.**

**Standing rule this reinforces:** treat a sub-agent's *verdict* as a hypothesis and its
*measurements* as data — always check whether the decisive measurement was actually taken.
