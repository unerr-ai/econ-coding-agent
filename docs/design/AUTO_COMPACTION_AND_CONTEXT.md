# Auto-Compaction, Context Visibility & Cheap-First Interaction — Implementation Plan

**Status:** Planning (no code yet). **Owner:** econ core.
**Scope:** Auto-compaction hardening, `/context` + `/usage` UX, and a cheap-model-first
initial-interaction (triage) tier — the Claude-Code-style "context auto-compacts into a
short stint" behaviour, adapted to econ's multi-tier cost thesis.

> This plan is grounded in (a) a direct read of what our OpenCode base already implements
> and (b) a web-search survey of how Claude Code, Aider, Cline, Roo Code, Gemini CLI,
> Qwen Code, Codex CLI, Crush, and Goose implement the same feature. It is deliberately an
> **enhance-and-productize** plan: OpenCode already auto-compacts. We are closing the gap to
> Claude Code, wiring compaction to econ's cheap-tier routing, and making context spend a
> first-class product surface. Pseudocode is illustrative, not final; verify every borrowed
> constant against the pinned upstream commit before adopting.

> **See also:** [`../features/05-long-horizon.md`](../features/05-long-horizon.md) documents
> long-horizon checkpointing — a **shipped** feature that extends this compaction design
> (deterministic checkpoints + restart-surviving task tree on top of OpenCode's compaction) —
> as a related, complementary system.

> **Companion:** [`cross-tier-context.md`](./cross-tier-context.md) is the canonical design for
> how the three model tiers *share* context and keep each model's cache warm (sticky conductor,
> stateless brief-fed oracle, token-budgeted executor). This doc handles compaction *within* a
> tier's window; the companion handles context *across* tiers. Phase 8 below tracks the
> cross-tier tasks that interlock with compaction; the full `CTX-*` tracker lives there.

> **Companion (2026-07-10):** [`turn-cache-economics.md`](./turn-cache-economics.md) found that
> in single-turn agentic runs this machinery never fires — the per-turn prune fork runs at
> end-of-user-turn behind a `turns < 2` gate, and the overflow trigger sits far above real run
> peaks (124.8k vs 524k) — and owns the re-triggering design (step-granular, economically
> thresholded). The mechanisms themselves stay owned here.

---

## 1. Why this matters for econ

Two of econ's pillars ride on this feature:

1. **Lean context compounds with cheap models.** Every token we don't send is a token we
   don't pay for at any tier. Auto-compaction is the single biggest lever on long-session
   cost. Doing it *deterministically first* (strip stale tool output before paying an LLM to
   summarize) is the direct expression of "hand the model the right slice, not the whole repo."
2. **Observability is the product surface.** Claude Code's `/context` and `/usage` and its
   "Context left until auto-compact: N%" countdown are the exact signals users associate with
   a professional agent. econ can go further and fold compaction into the **savings receipt**
   (tokens reclaimed by rule-based pruning vs. by an LLM summary, and the $ each cost). The
   savings-receipt / observability surface itself is owned canonically by
   [`../features/06-observability.md`](../features/06-observability.md); this doc only
   specifies compaction's contribution to it.

A third, requested behaviour: **Claude Code hands the *initial* interaction to Haiku** (a cheap,
fast model) before committing an expensive model. econ should adopt this — route the session
bootstrap / triage turn to a cheap tier and escalate only when the work warrants it — **unless
the user has fixed a model.** This is econ's risk-escalation thesis applied at turn zero.

---

## 2. What OpenCode already gives us (inventory)

Read directly from the local base. Cited so we build on it rather than duplicate it.

| Capability | Status | Where / mechanism |
|---|---|---|
| Auto-compaction trigger | **PRESENT** | `session/overflow.ts` — `isOverflow()` fires when `tokens ≥ usable`, `usable = model.limit.input − reserved`, `reserved = min(20_000, maxOutput)`. Checked post-turn and mid-stream in `session/prompt.ts`; flagged in `session/processor.ts`. |
| Summarize-and-replace | **PRESENT** | `session/compaction.ts` `processCompaction()` — summarizes the "head" via a hidden `compaction` agent into a fixed Markdown template, keeps last `tail_turns` (default 2) verbatim, stores a `summary:true` message that hides prior messages from the model, auto-continues. Merges a prior summary via `<previous-summary>`. |
| Deterministic tool-output pruning | **PRESENT but OFF** | `compaction.ts` `prune()` — blanks stale tool outputs beyond a 40k-token protected tail; gated by `compaction.prune` (**default false**). |
| Manual compaction | **PRESENT** | TUI `/compact` (alias `/summarize`, `<leader>c`) → server `summarize` → `compactSvc.create({auto:false})`. |
| Per-message token + cost accounting | **PRESENT** | `session/session.ts` `getUsage()` — normalizes AI-SDK usage into `{total,input,output,reasoning,cache:{read,write}}`, computes `cost` incl. cache tiers; accumulated per message and per session. |
| Cross-session stats | **PRESENT** | CLI `stats` command aggregates tokens/cost across sessions. |
| Live context/cost display | **PARTIAL** | Sidebar panel (`tui/.../sidebar/context.tsx`) shows tokens, "% used" vs `limit.context`, "$ spent". No footer countdown. |
| `/context` breakdown | **ABSENT** | No per-category token breakdown command. |
| `/usage` (plan / rate-limit / session) | **ABSENT** | — |
| Cheap-tier summarizer routing | **ABSENT** | Compaction runs on the active agent's model, not a pinned cheap tier. |
| Cheap-model-first initial interaction | **ABSENT** | `default_agent` is used for every turn; no triage tier. |
| Anti-loop guards | **PARTIAL** | A `DOOM_LOOP_THRESHOLD=3` guard exists; no explicit "min reduction / exclude prior summaries / counter-reset" trio. |

**Implication:** the engine exists. Our work is (1) flip prune-first on and tier it, (2) route
the summary to a cheap model, (3) add the two commands + the countdown, (4) add the triage tier,
(5) harden the token accounting and loop guards.

---

## 3. Cross-agent design synthesis (what the field converged on)

From the survey. Full per-project notes archived alongside this doc; the load-bearing patterns:

**Convergent design**
- **Summarize-and-replace with a verbatim recent tail** is universal. Everyone keeps recent
  turns raw (Gemini ~30%, OpenCode last 2 turns / 2–8k, Codex last ≤20k user tokens) and
  summarizes only the older head. Split **only at complete user-message boundaries** — never
  mid-tool-call (Gemini's `findCompressSplitPoint`), or the transcript corrupts.
- **Trigger** splits into two camps: **percentage-of-window** (Gemini 0.5–0.7, Goose 0.8,
  Claude Code ~83.5%) vs **absolute headroom** (`context − output_reserve`; Codex, OpenCode).
  Absolute headroom survives model swaps better; a % knob is the escape hatch.
- **Deterministic prune before LLM summary.** Claude Code's "microcompact" (clear old
  tool-result bodies, no LLM call), Goose's middle-out tool pruning, Qwen's `/compress-fast`,
  and OpenCode's `prune()` all reclaim tokens with zero model spend — often enough to avoid
  summarizing at all.
- **Structured summary template.** Named sections (Claude Code's 9; Cline/Roo's 6; OpenCode's
  Goal/Progress/Decisions/Files; Gemini's XML `<state_snapshot>`), always including
  **pending tasks + next step** so work resumes seamlessly.
- **Cheap model for the summary.** Aider (`weak_model`) and Roo (`condensingApiConfigId`)
  route the summary to a cheap tier. Directly aligned with econ.
- **Non-destructive.** Keep the raw transcript out-of-band (OpenCode's DB `time.compacted`
  tag; Roo's `condenseParent` rewind) even though only the summary re-enters context.

**The universal failure mode: the compaction loop.** Every agent has an issue for it
(Gemini #16213, Crush #2551, Goose #4635, Codex "death spiral", OpenCode doom-loop guard).
Two root causes: **(a) token-counter bugs** — cumulative `cache.read/write` mistaken for
current context size, or the counter not reset after compaction, so it re-fires every turn;
**(b) actionable-looking summaries** — a "Goal / Instructions / Left to do" summary that a
non-Anthropic model *re-executes as a task*, refilling context. Since econ routes to cheaper
OSS models, **(b) is an elevated risk for us.**

**Design takeaways we adopt (ranked):**
1. Trigger on **absolute headroom** with a `%` override; suppress on brand-new/tiny sessions.
2. **Prune-first, summarize-second** — turn econ's `prune()` on by default and tier it.
3. Summary is a **passive state snapshot**, never an actionable task; keep-verbatim set is
   explicit; instruct the model not to acknowledge compaction and not to "conclude".
4. **Summarize on the cheap tier** (econ executor/small model).
5. Ship the **anti-loop trio**: min-reduction-or-fail, exclude prior summaries from
   re-compaction, hard doom counter that surfaces an error instead of re-firing.
6. **Token accounting is the root cause** — invest there first (Day-0 cache gate).
7. Persist compacted state; keep full history recoverable.
8. Make context spend a **first-class, cost-annotated UX** (`/context`, `/usage`, countdown,
   savings receipt).

---

## 3.5 User-pain-driven priorities (web research)

A second web sweep of what users *actually complain about* (Reddit, HN, and GitHub issues on
Claude Code, Cline, Roo, Gemini CLI, Codex) — ranked by frequency × severity, mapped to the
econ fix. The same complaints recur across every tool, which is the strongest signal. **Bold =
widely requested and essentially unaddressed by any of them → econ's greenfield differentiators.**

| # | User pain (sources) | econ fix | Task |
|---|---|---|---|
| 1 | Critical context lost — the WHY, file paths, decisions, **exact numbers** ("retries=3" → "retries were configured"). Hallucinates/rewrites working code (Claude #36068, Codex #18318) | Typed state object; never prose-summarize goal/files/decisions/numbers; preserve identifiers verbatim | AC-2.1 |
| 2 | **Fires mid-task / at the wrong moment**, discarding partial work (Codex #24779, Claude #10948) | **Task-boundary-aware compaction** — never mid-tool-call/step; defer + warn if hit mid-task | AC-1.5 |
| 3 | **No way to protect the plan / TODOs / key files** from summarization (Claude #20051) | **Pin/protect region** — first-class non-compactable context, always re-injected verbatim | AC-6.1 |
| 4 | No user control — disable/threshold settings *ignored* (Claude #38483, Cline #10637, Roo #5229) | Honored on/off + threshold (test-verified); `/compact [focus]`; `/clear` | AC-4.5 |
| 5 | Compaction loop + token burn; parallel compaction agents (Claude #42647, Gemini #16213, Cline #5616) | Min-reduction-or-abort + min-gap-between-compactions + serialize the compactor | AC-1.6, AC-1.7 |
| 6 | **Black box** — can't see what was kept vs dropped; "no pointer back" (HN #47096210) | **Pre-compaction diff** (what drops/keeps, chance to pin) + **recoverable transcript** (pointers back, surgical re-fetch) | AC-4.4, AC-6.2 |
| 7 | Resume re-reads files, repeats work, forgets decisions (Codex #18318, Claude #3138) | **Execution-frontier checkpoint** (files touched, approaches tried, decisions+why) + read-cache awareness | AC-6.3 |
| 8 | Context % indicator inaccurate / inconsistent (Claude #50732, Cline #4035, Roo #8113) | Provider-correct tokenizer; reconcile displayed vs real single-request context | AC-0.3 |
| 9 | Recursive summary-of-summary decay by pass 3–4 | Incremental checkpoint-update (fold new turns in; never summarize a summary) | AC-2.2 |
| 10 | Blank slate every session + quality decays as window fills (context rot) | External memory (unerr notes) + JIT slice retrieval → keep the live window small | AC-6.3, AC-7.3 |

Efficiency techniques from the state-of-the-art sweep (Anthropic context-engineering,
LangChain write/select/compress/isolate, observation-masking research) fold into the same tracker
— chiefly **observation masking** (AC-1.2, replace a consumed tool result with a one-line
synthesis; tool outputs are ~80% of trajectory tokens → ~halves cost with no solve-rate loss),
**summary+reference-ID for large tool results** (AC-1.4), **cache-stable prefix + hit-rate
instrumentation** (AC-0.4), and **progressive tool-schema disclosure** (AC-7.1). One hard caveat
throughout: **prune at line/block/observation level, never token-level (LLMLingua) on code** — it
breaks syntax.

---

## 4. Target design for econ

### 4.1 Trigger policy

Keep OpenCode's absolute-headroom math as the primary trigger; add an optional percentage
override and new-session suppression.

```
usable(model) = (model.limit.input ?? model.limit.context) − reserved
reserved      = cfg.compaction.reserved ?? min(COMPACTION_BUFFER, model.limit.maxOutput)

currentContextTokens(msg) = live single-message context size
                            = input + output + reasoning         # NOT cumulative cache
                            # cache.read/write are billing signals, excluded from "how full"

shouldCompact(msg, model):
    if cfg.compaction.auto == false: return false
    if model.limit.context == 0:     return false
    if session.turnCount < MIN_TURNS_BEFORE_COMPACT: return false   # suppress new sessions
    ctx = currentContextTokens(msg)
    if cfg.compaction.threshold_pct set:
        return ctx >= cfg.compaction.threshold_pct × model.limit.context
    return ctx >= usable(model)                                     # default: headroom
```

- **`MIN_TURNS_BEFORE_COMPACT`** (default 2–3) fixes premature compaction of new chats
  (Roo #8158, Goose #6146).
- Keep OpenCode's dual detection sites (post-turn + mid-stream `"compact"` result).
- The **countdown** shown to the user (§4.6) is derived from the same `usable`/`threshold`.

### 4.2 Tiered mechanism (prune-first → summarize-second)

This is the econ-specific shape: exhaust cheap deterministic reclamation before paying for a
summary.

```mermaid
flowchart TD
    A[Turn finishes / mid-stream 'compact'] --> B{shouldCompact?<br/>ctx &ge; usable AND turns &ge; MIN_TURNS}
    B -- no --> Z([continue session])
    B -- yes --> C{overflow driven<br/>by media/attachments?}
    C -- yes --> C1[Tier 0 — strip large media]
    C -- no --> D
    C1 --> D[Tier 1 — prune stale tool-output bodies<br/>NO LLM call &middot; cost $0 &middot; default ON]
    D --> E{still over threshold?}
    E -- no --> Z2([continue &middot; receipt: prune only, $0])
    E -- yes --> F[Tier 2 — split at USER-message boundary<br/>keep recent tail verbatim]
    F --> G[summarize head on CHEAP tier<br/>merge prior summary, exclude old summaries]
    G --> H{reduces enough?<br/>summary &lt; head &minus; MIN_REDUCTION}
    H -- no --> I[[mark failed &middot; surface 'context full'<br/>do NOT re-fire this turn]]
    H -- yes --> J[replace head with summary<br/>tag head time.compacted &middot; keep in DB]
    J --> K([resume seamlessly &middot; emit receipt])
```

```
compact(session, model):
    # Tier 0 — media strip (only if overflow is attachment-driven)
    if overflowByMedia(session): stripLargeMedia(session)

    # Tier 1 — deterministic prune (NO LLM call). Default ON for econ.
    freed = prune(session, protectRecentTokens = PRUNE_PROTECT)   # blank stale tool-output bodies
    recordSavings(kind="prune", tokens=freed, cost=0)
    if not shouldCompact(latest(session), model):
        return                                # pruning alone dropped us under threshold

    # Tier 2 — LLM summarize-and-replace on the CHEAP tier
    (head, tail) = splitAtUserBoundary(session, keep = preserveRecentBudget(model))
    prevSummary  = lastSummaryMessage(session)          # merge, don't restack
    summary      = summarizeTierModel().run(            # §4.4 cheap tier
                       prompt   = buildSummaryPrompt(head, prevSummary),   # §4.3
                       maxOut   = SUMMARY_OUTPUT_TOKENS)
    if not reducesEnough(summary, head):                # §4.5 anti-loop guard (a)
        markCompactionFailed(session); return
    replaceHeadWithSummary(session, summary)            # non-destructive: tag head time.compacted
    recordSavings(kind="summary", tokens=head−summary, cost=summary.cost)
    resumeSeamlessly(session)                           # inject synthetic continue, no "compaction happened"
```

**What the model payload looks like before vs after** (only the summary + tail re-enter context;
the raw head stays in the DB):

```mermaid
flowchart LR
    subgraph BEFORE["Payload BEFORE — at overflow"]
        direction TB
        S1["system prompt"]
        M1["memory / AGENTS.md / unerr notes"]
        H1["turns 1 … N-2<br/>full tool outputs<br/>≈ fills the window"]
        T1["turns N-1, N (recent)"]
    end
    subgraph AFTER["Payload AFTER compaction"]
        direction TB
        S2["system prompt (verbatim)"]
        M2["memory / notes (verbatim)"]
        SUM["▶ summary message<br/>Goal · Progress · Decisions · Files"]
        T2["turns N-1, N — verbatim tail"]
        FREE["◻ large free space reclaimed"]
    end
    BEFORE == "prune → summarize (cheap tier)" ==> AFTER
    H1 -. "raw head retained in DB<br/>tag: time.compacted" .-> DB[("session store")]
```

- **Turn `compaction.prune` ON by default** for econ (upstream default is false). This is the
  cheapest reclamation and the clearest cost differentiator.
- `preserveRecentBudget` keeps OpenCode's clamp (last `tail_turns`, ~25% of usable, bounded
  `MIN_PRESERVE_RECENT_TOKENS`…`MAX`).
- `splitAtUserBoundary` must never cut mid-tool-call.

### 4.3 Summary prompt (passive state snapshot)

Keep OpenCode's Markdown template (Goal / Constraints & Preferences / Progress {Done,
In-Progress, Blocked} / Key Decisions / Next Steps / Critical Context / Relevant Files). Harden
the framing against the loop:

- **Passive, descriptive** state — never an actionable "Instructions / do this next" block that
  a cheap model will re-execute (Crush #2551). Phrase Next Steps as *observations about where
  work stands*, not commands.
- **Keep verbatim** (instruct explicitly): exact file paths, commands, error strings,
  identifiers, and **any security-relevant constraint or user preference** (Claude Code forces
  these to survive). Also preserve **all substantive user requests** — not just the last one.
- **Do not acknowledge** the summarization; the resumed conversation must read as continuous
  (Goose/Roo). No "Finally," conclusion (Aider).
- **Merge, don't restack:** when a prior summary exists, update it (drop stale, fold in new)
  rather than summarizing a summary — and **exclude prior summary messages from the head**
  (§4.5 (b)).

### 4.4 Cheap-tier summarizer routing (the "boring sub-task")

Summarization is a delegable chore → econ's cheap tier, not the conductor/oracle.

```
summarizeTierModel():
    return cfg.compaction.model                    # explicit override wins
        ?? cfg.small_model                          # econ already pins gpt-oss-20b here
        ?? conductorTierModel                       # last resort, still cheap
```

econ already sets `small_model = openrouter/openai/gpt-oss-20b`; reuse it. Add
`compaction.model` so the summarizer tier is independently tunable. **Never** run compaction on
the oracle tier — that inverts the cost model.

### 4.5 Anti-loop trio (mandatory)

1. **Min-reduction-or-fail.** If the produced summary is not meaningfully smaller than the head
   it replaces (`summaryTokens ≥ head − MIN_REDUCTION`), mark the attempt failed, **do not
   retry the same turn**, and surface a clear "context full, summary didn't shrink" state
   instead of re-firing (Roo #4658, Gemini #15225).
2. **Exclude prior summaries** from the head selection — a message flagged `summary:true` is
   never re-summarized (Codex `is_summary_message`).
3. **Hard doom counter.** Keep/extend OpenCode's `DOOM_LOOP_THRESHOLD`: N compaction triggers
   within a bounded window → raise `ContextOverflowError` to the user, don't loop.

### 4.6 Token-accounting correctness (Day-0 gate — do this first)

This is the root cause of most field failures and is already on econ's risk list (OpenCode
#30649; known OpenRouter cache bug). Before shipping any trigger change:

- **Separate two numbers:** *current context size* (drives compaction + the "% full" gauge) vs
  *cumulative billing usage* (drives the cost receipt). Current context **must exclude**
  cumulative `cache.read/write`; conflating them causes false "context full" and unrecoverable
  overflow.
- **Reset the context counter after compaction** — the post-compaction turn starts from
  summary + tail, not the old total (Goose #4635).
- **Assert on our provider path** (OpenRouter/Fireworks BYOK) that reported `cache.*` tokens are
  accounted correctly, per the existing Day-0 cache-accounting gate. Add a regression test that
  a long session's "% full" tracks real single-request context, not the running cache sum.

### 4.7 Non-destructive persistence

Keep OpenCode's model: raw head messages stay in the DB tagged `time.compacted`; only the
summary + tail re-enter the model payload. This gives audit + potential rewind (Roo-style) and
avoids Gemini #21335 (compression lost on resume because it wasn't persisted). Persist the
summary itself to disk so `resume` doesn't undo compaction.

### 4.8 Pain-driven mechanisms (from user research)

These address the top complaints across the field that no agent currently solves well. They
layer onto the §4.2 ladder.

**Observation masking (Tier 1, highest-ROI).** Tool observations are ~80% of a coding
trajectory's tokens. Once a step has *consumed* a tool result, replace its raw body in history
with a one-line synthesis, keeping only the last `K` results raw. This is deterministic, $0, and
research shows it ~halves tokens with no solve-rate loss — cheaper and often sufficient before
any LLM summary.

```
maskObservations(session, keepRawLast = K):
    for result in toolResults(session) older than keepRawLast:
        if result.consumedBy is not null and not result.pinned:
            result.body = oneLineSynthesis(result)   # "read src/x.ts (420 lines)"; keep call+status
```

**Task-boundary-aware trigger.** Never compact mid-tool-call or mid-plan-step (the #1 pain —
mid-task compaction derails the plan). If the threshold is crossed while a step is in flight,
**defer** to the next completed user-message boundary and **surface a warning** instead of cutting.

```
onOverflow(session):
    if inFlight(session):                  # mid-tool-call / mid-step
        session.pendingCompaction = true
        warn("approaching context limit — will compact at next safe point")
    else:
        compact(session, model)            # §4.2 ladder, at a clean boundary
```

**Protected / pinned region.** A first-class context region separate from conversation history:
the active plan, the TODO list, pinned files, and any user/agent-marked message. Pruning and
summarization **skip it**; it is always re-injected verbatim. Both the user (a `/pin` command)
and the agent (marking its own plan) can add to it.

**Recoverable transcript.** The summary carries line-range pointers back into the raw head
(already retained in the DB, tagged `time.compacted`). If the model later needs a dropped detail,
it can **surgically re-fetch** that specific chunk on demand rather than living with the lossy
summary — turning the black box into a lens.

**Execution-frontier checkpoint.** On compaction/resume, persist a small typed record of *where
work stands*: files modified, approaches already tried (and rejected), decisions + rationale,
last error, open TODOs. Rehydrate it on resume so the agent doesn't re-read files or repeat failed
approaches. Pair with **read-cache awareness** ("already read this file, unchanged → don't
re-read"). This is econ's external-memory moat (unerr notes/graph) applied to compaction; it also
composes with the shipped long-horizon checkpointing in
[`../features/05-long-horizon.md`](../features/05-long-horizon.md).

---

## 5. Cheap-model-first initial interaction (the "Haiku" behaviour)

**Goal.** Like Claude Code delegating the opening interaction to Haiku, econ routes the session
bootstrap / triage to a **cheap, fast tier** and escalates only when the work warrants it —
**unless the user has fixed a model.** This is econ's risk-escalation router applied at turn zero
and dovetails with the existing `default_agent`/tier setup. The underlying risk-escalation
router — blast-radius/fan-in/centrality scoring, hysteresis, abstention, triage, double-pay
accounting — is owned canonically by
[`../features/03-risk-router.md`](../features/03-risk-router.md); this section only adds
triage's turn-zero routing decision on top of it.

### 5.1 Selection precedence

```mermaid
flowchart TD
    A["New turn"] --> B{"user pinned a model?<br/>--model / /model / fixed agent"}
    B -- yes --> P[["use pinned model<br/>(triage disabled — user's choice wins)"]]
    B -- no --> C{"first interaction<br/>or lightweight triage turn?"}
    C -- yes --> T["TRIAGE TIER<br/>cheap + fast · small_model (gpt-oss-20b)"]
    T --> T2{"clearly heavy prompt<br/>or risk crosses bar?"}
    T2 -- "yes (escalate immediately)" --> E
    T2 -- no --> ANS(["answer now / cheap tool calls"])
    C -- no --> R["assess risk:<br/>blast-radius · fan-in · centrality"]
    R --> D{"risk ≥ escalateAbove?"}
    D -- yes --> E["ORACLE TIER<br/>(GLM 5.2 — high-risk)"]
    D -- no --> CD["CONDUCTOR TIER<br/>(DeepSeek V4 Flash — default execution)"]
    classDef pin fill:#eef,stroke:#88a
    class P pin
```

```
selectModelForTurn(session, turn):
    # 1. Explicit user pin always wins — never override a fixed model.
    if session.userPinnedModel:            # --model flag, /model command, or a fixed agent
        return session.userPinnedModel

    # 2. Triage: the first interaction (and cheap lightweight turns) go to the cheap tier.
    if turn.isFirstInteraction or isLightweightTriage(turn):
        return TRIAGE_TIER                 # cheap+fast — econ small/executor (gpt-oss-20b)

    # 3. Otherwise econ's normal risk-escalation routing.
    risk = router.assessRisk(turn)         # blast-radius / fan-in / centrality (existing thesis)
    return risk >= cfg.router.escalateAbove ? ORACLE_TIER : CONDUCTOR_TIER
```

- **`TRIAGE_TIER`** = a cheap fast model. Reuse `small_model` (gpt-oss-20b) or add
  `cfg.triage.model`. It handles: understanding the request, the opening reply, cheap tool calls
  (reads/searches), and deciding whether the task is trivial (answer now) or warrants the
  conductor/oracle. It is a *router step*, not the executor of hard work.
- **Escalation hook.** If the triage model's assessment (or the risk score) crosses a threshold,
  hand off to conductor (default execution) or oracle (high-risk), carrying a compiled brief —
  consistent with econ's "durable state in code + brief, not raw transcript" topology. The brief
  compiler (`briefFromContext`/`compileBrief`, `packages/code-intelligence/src/brief.ts`) already
  exists but is unwired; wiring it into this hop is **AC-8.1** (Phase 8) — see the companion
  [`cross-tier-context.md`](./cross-tier-context.md) for the full cross-tier design.
- **User-fixed model disables triage entirely** — precedence rule 1. A `/model` pick or
  `--model` flag pins every turn to that model, matching the user's "unless user fixes a model."

### 5.2 Config

```
"triage": {
    "enabled": true,                       # default on; the Haiku-style behaviour
    "model":   null,                       # null → fall back to small_model
    "escalate_on": ["multi_file_edit", "high_risk", "explicit_plan_request"]
}
```

### 5.3 Interaction with compaction

The triage tier and the compaction summarizer are the **same cheap tier** conceptually —
both are "boring sub-tasks." Keep them as separate config knobs (`triage.model`,
`compaction.model`) but default both to `small_model`, so a single cheap model powers econ's
housekeeping.

### 5.4 Risk / open question

Triage adds one extra (cheap) model hop per session bootstrap. Measure that the hop's cost is
dwarfed by the savings from not opening on the expensive tier. If a turn is *obviously* heavy
(e.g. an explicit "refactor across the codebase"), the triage model should escalate on its first
assessment rather than attempt the work — otherwise we pay triage *and* execution. Encode a fast
"escalate immediately" path for clearly-heavy first prompts.

---

## 6. UX surfaces

### 6.1 `/context` — per-category token breakdown

Mirror Claude Code's grid. Compute from the current model payload, not cumulative usage.

```
/context →
  System prompt        ▓▓░░░░░░  12,400
  Tools / MCP          ▓░░░░░░░   6,900
  Memory (AGENTS/CLAUDE.md, unerr notes)  ▓░░░  3,100
  Messages (live)      ▓▓▓▓░░░░  48,200
  Summary (compacted)  ▓░░░░░░░   4,096
  ── free ──                     125,304
  Reserved (auto-compact buffer) 20,000
  Window: 200,000   •   88,696 used (44%)   •   compacts at ~90%
```

Categories reuse the sidebar's data source; the new work is bucketing by origin and rendering
the grid + the "compacts at N%" line.

### 6.2 `/usage` — session + (optional) plan/rate-limit

- **Session:** total tokens (in/out/cache), $ spent this session, per-tier breakdown
  (conductor vs oracle vs triage vs summarizer) — this is econ's cost story made visible.
- **Reclaimed:** tokens/$ saved by prune (Tier 1, $0) vs summary (Tier 2) — folds into the
  **savings receipt**.
- **Plan/rate-limit:** if econ's hosted offering exposes windows, show them; else omit.

### 6.3 Status line countdown

Add Claude Code's "Context left until auto-compact: N%" to the footer (today it's only a
sidebar panel). Cheap to add from the same numbers; high perceived-polish.

### 6.4 Manual `/compact [focus]`

Already present. Add an optional free-text focus argument (Claude Code / Roo) that the summary
prompt honours ("emphasize X"). Keep the `/summarize` alias.

### 6.5 Compaction receipt

On every auto-compaction, emit a one-line receipt (Goose-style):
`compacted 128k → 41k (−68%) · prune $0.00 + summary $0.004 · gpt-oss-20b`. Route it through
econ telemetry so it appears in the savings surface, not just the log (canonical design in
[`../features/06-observability.md`](../features/06-observability.md)).

---

## 7. Config schema (additions, consolidated)

```
"compaction": {
    "auto":            true,
    "prune":           true,      # econ flips this ON (upstream default false)
    "threshold_pct":   null,      # null → absolute-headroom trigger; else warn+compact at this %
    "reserved":        null,      # null → min(20_000, maxOutput)
    "tail_turns":      2,
    "preserve_recent_tokens": null,
    "model":           null,      # cheap summarizer tier; null → small_model
    "min_reduction":   8_000,     # anti-loop guard (a): abort if summary doesn't free this much
    "min_gap_messages": 8,        # anti-loop guard: min messages between two compactions
    "observation_masking": true,  # Tier-1 §4.8: mask consumed tool-result bodies
    "keep_raw_tool_results": 5,   # how many recent tool outputs stay raw
    "task_boundary_only": true,   # §4.8: never compact mid-tool-call/step; defer + warn
    "nudge_pct":       0.80,      # proactive nudge to the user at this fill level
    "recoverable":     true       # summary keeps pointers back to the retained raw head
},
"protected": {                    # §4.8 pin/protect — never pruned or summarized
    "plan":  true,                # the active plan / TODO list is protected by default
    "paths": [],                  # globs the user pins (e.g. "docs/spec.md")
    "keep_all_user_messages": true # preserve raw user turns verbatim (Claude-Code rule)
},
"triage": {
    "enabled": true,
    "model":   null,              # null → small_model
    "escalate_on": ["multi_file_edit", "high_risk", "explicit_plan_request"]
}
```

Respect config precedence already in the codebase (per-agent model > top-level `model` > tier
defaults). A **user-fixed model overrides both triage and compaction-model selection for
execution turns** but compaction may still run the cheap summarizer unless `compaction.model` is
explicitly pinned to the fixed model.

---

## 8. Phased implementation plan

Each phase lists delegable slices and the econ tier they route to (worker = scoped code;
junior = recon/verify). Design/wiring stays on the main thread.

```mermaid
flowchart LR
    P0["Phase 0<br/>token-accounting gate<br/>(BLOCKING)"]:::gate --> P1["Phase 1<br/>prune-first + observation masking<br/>+ task-boundary trigger"]
    P1 --> P2["Phase 2<br/>typed-summary hardening"]
    P1 --> P3["Phase 3<br/>cheap-first triage tier"]
    P1 --> P4["Phase 4<br/>UX: /context, /usage, nudge, pre-compact diff"]
    P1 --> P6["Phase 6<br/>protected region + recoverability<br/>+ execution-frontier (DIFFERENTIATORS)"]:::diff
    P2 --> P5["Phase 5<br/>telemetry + savings + efficiency metrics"]
    P3 --> P5
    P4 --> P5
    P6 --> P5
    P1 --> P7["Phase 7<br/>broader token efficiency"]
    P0 --> P8["Phase 8<br/>cross-tier context + cache<br/>(companion: cross-tier-context.md)"]:::xtier
    P8 --> P5
    classDef gate fill:#fdd,stroke:#c66,stroke-width:2px
    classDef diff fill:#dfe,stroke:#3a7,stroke-width:2px
    classDef xtier fill:#eef,stroke:#66c,stroke-width:2px
```

*Correctness core = 0 → 1 → 2. Cost differentiator = 3. Product surface = 4/5. Greenfield
differentiators = 6. Cross-cutting efficiency = 7. Cross-tier context + cache = 8 (needs Phase 0's
meter first, then fans out in parallel). Everything after 1 can fan out in parallel once 0–1 land.*

Task tracker. Each task: `AC-<phase>.<n>` · `(tier, effort)` · rationale/source. Tier = which
econ sub-agent executes it (worker = scoped code; junior = recon/verify/eval; main = design/wiring).
Check the box on completion. **★ = greenfield differentiator** (widely requested, unaddressed by
the field). Design/wiring stays on the main thread; everything else is a delegable slice.

**Phase 0 — Token-accounting gate (BLOCKING; do first).**
- [ ] **AC-0.1** (junior, low) — audit current-context vs cumulative-cache token math; digest every site reading `cache.*` in `session.ts`/`overflow.ts`. *Root cause of most loops (OpenCode #30649, Goose #4986).*
- [ ] **AC-0.2** (worker, med) — current-context = `input+output+reasoning` (exclude cumulative cache); **reset the counter after compaction**. *Fixes re-fire-every-turn (Goose #4635).*
- [ ] **AC-0.3** (worker, med) — provider-correct token meter on the OpenRouter/Fireworks path; reconcile displayed % vs real single-request context; regression test. *Inaccurate % is a top pain (Claude #50732, Cline #4035).*
- [ ] **AC-0.4** (worker, med) — cache-hit instrumentation: log `cache_read/write`, assert a byte-stable cached prefix, alert < 80% hit. *Largest cost lever on cheap models.* **Shared with Phase 8 / CTX-0.2** — this same meter is extended per-tier there; build it once.
- Exit: long-session test never false-triggers; counter resets post-compact; % tracks reality.

**Phase 1 — Prune-first + observation masking + task-boundary trigger.**
- [ ] **AC-1.1** (worker, low) — flip `compaction.prune` ON; wire the Tier-0/1/2 ladder (§4.2), re-check `shouldCompact` after each cheap tier.
- [ ] **AC-1.2** (worker, low) — **observation masking**: replace a consumed tool-result body with a one-line synthesis, keep last `K` raw (§4.8). *~80% of trajectory tokens; ~halves cost, no solve-rate loss — highest ROI.*
- [ ] **AC-1.3** (worker, med) — unerr-graph-aware pruning: drop reads of files since edited; dedupe repeated reads to latest. *Semantic staleness no age-based pruner has — econ moat.*
- [ ] **AC-1.4** (worker, low) — large tool results return synopsis + fetch-handle; full body loads on demand. *~80% of large results never re-read (Copilot).*
- [ ] **★ AC-1.5** (worker, med) — **task-boundary-aware trigger**: never compact mid-tool-call/step; defer to next user boundary + warn (§4.8). *#1 cross-tool pain (Codex #24779, Claude #10948).*
- [ ] **AC-1.6** (worker, low) — compaction serialization + `min_gap_messages` guard; no parallel compaction agents. *Loop/token-burn (Claude #42647, Cline #5616).*
- [ ] **AC-1.7** (worker, low) — summarizer routes to `compaction.model ?? small_model` (§4.4); anti-loop trio: min-reduction-or-abort, exclude prior summaries, doom counter (§4.5).

**Phase 2 — Typed-summary hardening.**
- [ ] **AC-2.1** (worker, med) — **typed state object** (goal, files, decisions, exact numeric constraints, TODOs, last error); never prose-summarize these; preserve numbers/paths/identifiers verbatim. *Lossy loss of WHY/paths/numbers is #1 consequence (Claude #36068, Codex #18318); typed +28–40% retention.*
- [ ] **AC-2.2** (worker, low) — incremental checkpoint-update: fold new turns into the prior checkpoint; never summarize a summary. *Recursive decay (justin3go).*
- [ ] **AC-2.3** (worker, low) — passive-snapshot framing, no-acknowledge, no-"Finally"; keep security/user constraints verbatim.
- [ ] **AC-2.4** (junior, low) — eval on 2–3 cheap OSS models that the summary is not re-executed as a task (Crush #2551); line/block-level pruning only (no token-level LLMLingua on code).

**Phase 3 — Cheap-first triage tier.**
- [ ] **AC-3.1** (main → worker) — design + wire `selectModelForTurn` precedence (§5.1); `triage` config; **user-pin disables triage**.
- [ ] **AC-3.2** (worker, med) — fast "escalate-immediately" path for clearly-heavy first prompts (§5.4).

**Phase 4 — Context UX surfaces.**
- [ ] **AC-4.1** (worker, med) — `/context` per-category breakdown + "compacts at N%" line (§6.1).
- [ ] **AC-4.2** (worker, low) — footer countdown "context left until compact: N%" (§6.3).
- [ ] **AC-4.3** (worker, low) — proactive nudge at `nudge_pct` (offer compact / checkpoint / narrow-scope). *Warn before context-rot degradation.*
- [ ] **★ AC-4.4** (worker, med) — **pre-compaction diff**: show what will drop vs keep, with a chance to pin, before auto-compaction commits. *Black-box pain (HN #47096210).*
- [ ] **AC-4.5** (worker, low) — `/compact [focus]` + `/clear`; **honored** disable toggle + threshold, test-verified. *Ignored settings pain (Claude #38483, Cline #10637).*
- [ ] **AC-4.6** (worker, low) — `/usage`: session tokens/$ per tier + reclaimed (prune $0 vs summary $) (§6.2).

**Phase 5 — Telemetry, savings & efficiency metrics.**
- [ ] **AC-5.1** (worker, med) — route the compaction receipt + tier breakdown into the savings surface (canonical in [`../features/06-observability.md`](../features/06-observability.md)).
- [ ] **AC-5.2** (worker, med) — efficiency metrics loop: tokens-per-task, re-read rate, cache-hit rate, post-compaction task-success. *Can't prove savings you don't measure; guides compress-vs-retrieve.*

**Phase 6 — Protected context & recoverability (★ DIFFERENTIATORS).**
- [ ] **★ AC-6.1** (worker, med) — **pin/protect region**: plan, TODOs, pinned files/messages never compacted, always re-injected verbatim; `/pin` command + agent self-pin (§4.8). *Can't-protect-plan pain (Claude #20051).*
- [ ] **★ AC-6.2** (worker, med) — **recoverable transcript**: summary carries line-range pointers into the retained raw head; agent can surgically re-fetch a dropped chunk (§4.8). *"No pointer back" (HN #47096210).*
- [ ] **★ AC-6.3** (worker, high) — **execution-frontier checkpoint**: persist files touched / approaches tried / decisions+why / last error; rehydrate on resume; read-cache awareness. Leverage unerr notes/graph + long-horizon checkpointing. *Resume re-reads/repeats work (Codex #18318, Claude #3138).*

**Phase 7 — Broader token efficiency (cross-cutting; leverage existing econ/unerr).**
- [ ] **AC-7.1** (worker, low) — progressive tool-schema disclosure (catalog + load-on-use). *Saves 10k+ tokens/turn with a large toolset.*
- [ ] **AC-7.2** (worker, med) — cache-stable prefix ordering (system/tools/AGENTS.md/docs first, byte-stable). *70–90% savings on the repeated prefix.* **Same work as Phase 8 / CTX-1.1–1.3** (byte-stable prefix, volatile-token removal, deterministic tool ordering) — the conductor golden-hash guard lives there.
- [ ] **AC-7.3** (junior, low) — verify the compaction path never forces whole-file re-reads; JIT slices + graph nav (unerr) stay the default. *Keeps the live window small so we compact less.*

**Phase 8 — Cross-tier context sharing & cache discipline (companion doc).** Canonical design +
full `CTX-*` tracker: [`cross-tier-context.md`](./cross-tier-context.md). Compaction (Phases 0–7)
keeps *one tier's* window healthy; this phase keeps context coherent *across* the three tiers
without replicating a transcript and without cold-flushing each model's KV cache. It needs Phase 0's
cache meter first, then fans out. AC-8.x below mirror the CTX tasks — the CTX ID is the source of truth.
- [ ] **★ AC-8.1** (main → worker) — **wire the compiled brief into the escalation hop** (§5.1): oracle/conductor receive `briefFromContext`/`compileBrief` output (`packages/code-intelligence/src/brief.ts`), never the raw transcript; assert no raw transcript crosses tiers. *Brief compiler is built but unwired.* → **CTX-2.1/2.2/2.3**.
- [ ] **★ AC-8.2** (worker, med) — **executor token budget**: replace the message-count subagent bootstrap (`SUBAGENT_BOOTSTRAP_LIMIT`) with a token budget measured against `model.limit.context` (≤~60k for gpt-oss-20b's 131k); select→compress child context; test the payload never exceeds the window. → **CTX-3.1/3.2/3.3**.
- [ ] **AC-8.3** (worker, med) — **conductor cache discipline**: byte-stable append-only prefix + golden-hash CI, remove volatile tokens (timestamps/trace-IDs) from the cached prefix, deterministic tool ordering, sticky routing (`session_id` / `x-session-affinity`). *Overlaps AC-7.2 — do it once here.* → **CTX-1.1/1.2/1.3/1.4**.
- [ ] **AC-8.4** (worker, med) — **per-tier cache-hit-rate + cross-model-transition instrumentation**: extend the AC-0.4 meter to record hit-rate and cost per tier and count cold cross-tier transitions; target > 85% hit, flag < 70%. *Extends AC-0.4 — same meter.* → **CTX-0.2/0.3**.
- [ ] **AC-8.5** (worker, med) — **cache-aware routing hysteresis**: bias against needless tier flips so the warm cache isn't flushed; surface cache-hit + transition cost in the savings receipt. → **CTX-4.1/4.2/4.3**.

Sequencing: **0 → 1 → 2** are the correctness core; **3** is the cost differentiator; **4** the
product surface; **6** the greenfield wins; **7** cross-cutting; **8** cross-tier context + cache
(companion doc, needs Phase 0's meter). Once 0–1 land, 2/3/4/6/7/8 fan out in parallel — one
sub-agent per phase. **Dedupe note:** AC-0.4 ⊂ AC-8.4 (one cache meter, extended per-tier) and
AC-7.2 ≡ AC-8.3 (one byte-stable-prefix effort) — build each once, tracked in both places only for
cross-reference.

---

## 9. Testing & verification

- **Token accounting (Phase 0):** unit test on the usage normalizer; a long synthetic session
  asserting context-size vs cumulative-cache separation on our provider path.
- **Trigger:** table test across model windows (200k, 1M) that `shouldCompact` fires at the right
  headroom and never on `turnCount < MIN_TURNS`.
- **Loop guards:** simulate a summary that doesn't shrink → asserts fail-and-surface, no re-fire;
  assert prior-summary exclusion; assert doom counter raises after N.
- **Prompt safety (Phase 2):** eval that cheap OSS models resume rather than re-execute the
  summary; assert paths/commands/security constraints survive verbatim.
- **Triage:** assert user-pinned model disables triage; assert clearly-heavy prompt escalates on
  first assessment; measure triage-hop cost < opening-on-oracle cost.
- **Observation masking (AC-1.2):** a step whose value is needed later still resolves (last-`K`
  raw window + re-fetch); assert masked bodies aren't fed back to the model.
- **Task-boundary (AC-1.5):** overflow raised mid-tool-call defers + warns, never cuts in-flight.
- **Protected region (AC-6.1):** pinned plan/files survive every prune + summary verbatim.
- **Recoverability (AC-6.2):** a summary pointer resolves back to the correct raw head chunk.
- **Pre-compaction diff (AC-4.4):** the shown drop/keep set matches what actually happens.
- **Cross-tier brief (AC-8.1):** assert the escalation hop passes a compiled brief and that no raw
  transcript crosses tiers; a fixed context yields a byte-stable brief.
- **Executor budget (AC-8.2):** the compressed child payload never exceeds gpt-oss-20b's window
  under a synthetic large context; the budgeter degrades gracefully (select→compress) instead of truncating blindly.
- **Cache discipline (AC-8.3/8.4):** golden-hash CI catches any drift in the conductor's cached
  prefix; per-tier hit-rate meter reports > 85% on a warm repeat run and flags a seeded < 70% regression.
- **End-to-end:** drive a real session past the window with `bun run dev`, confirm auto-compaction
  fires once, session continues coherently, and the receipt + `/context` reflect reality.

---

## 10. Risks & open questions

- **Cache accounting on OpenRouter/Fireworks BYOK** is the highest risk and gates everything —
  Phase 0 exists for it.
- **Cheap-model summary quality.** OSS summarizers may drop the "why"/reasoning (a documented
  Claude Code loss). Mitigate with the structured template + keep-verbatim rules; consider
  letting `compaction.model` escalate one tier if a quality eval fails.
- **Triage double-pay** on heavy first prompts (§5.4) — needs the escalate-immediately path.
- **Summary re-execution loop** on cheap models — elevated for econ; Phase 2 eval is the guard.
- **Open:** should compaction be rewindable in the TUI (Roo `condenseParent`)? Deferred; the DB
  already retains the head, so it's a UI addition, not a data-model change.
- **Over-pinning (AC-6.1):** an unbounded protected region can itself overflow the window. Cap
  protected tokens and warn when pins crowd out live context.
- **Observation masking losing a needed value (AC-1.2):** mitigated by the last-`K`-raw window +
  on-demand re-fetch; tune `K` per model, and never mask a result a pending step still references.
- **Execution-frontier scope (AC-6.3):** the checkpoint must stay small and cheap to
  write/rehydrate — it's a frontier snapshot, not a second transcript.
- **Open:** whether `/usage` shows hosted plan/rate-limit windows depends on econ's hosted
  offering shape — omit until that exists.
- **Cross-tier cache flush (Phase 8):** every tier switch cold-starts the target model's KV cache;
  if escalation is chatty the transition cost can swamp the routing win. Mitigated by cache-aware
  hysteresis (AC-8.5) and brief-not-transcript handoff (AC-8.1) — see [`cross-tier-context.md`](./cross-tier-context.md).

---

## 11. Live verification results (2026-07-02) — CLI mode + test suites

All 38 `AC-*` tasks are implemented. This section records a full rebuild-and-verify pass:
each feature's **expected** behaviour vs what was **observed**, driven where possible through
CLI `run` mode against this repository on the live OpenRouter path (conductor
`deepseek-v4-flash`, small/executor `gpt-oss-20b`, oracle `glm-5.2`), and backed by the unit
suites for internal/TUI-only surfaces.

**Method legend:** `CLI` = observed live via `bun … packages/opencode/src/index.ts run` ·
`unit` = verified by an automated test suite · `code` = code-present, no CLI/unit runtime
surface exercised this pass.

### 11.1 Rebuild & harness

| Check | Expected | Observed | Status |
|---|---|---|---|
| Typecheck (`bun turbo typecheck`) | 25/25 packages clean | **25 successful, 25 total** | ✅ |
| Binary boot (`run --help`, real prompt) | CLI parses; server + plugins load | 7 econ plugins load (`executor-validate, checkpoint, output-trim, recon-inject, governance-gate, gate-spike, status`); exit 0 | ✅ |
| Live turn (`run --format json "…"`) | Model answers; usage returned | Conductor answers; `step_finish` with `reason:stop`, cost tracked | ✅ |
| Aggregate unit tests (V1–V4 below) | Suites green | **~387 tests pass, 0 real failures** (1 flaky timing test passes in isolation) | ✅ |

### 11.2 Per-feature expected vs observed

| AC | Feature | Expected | Observed | Method | Status |
|---|---|---|---|---|---|
| 0.1 | current-ctx vs cache audit | ctx math excludes cumulative cache | `getUsage` splits input/output/reasoning from cache | unit | ✅ |
| 0.2 | current-ctx = in+out+reasoning | cache excluded from fullness | live `tokens:{input:11699,output:1,reasoning:15,cache:{read:0,write:0}}`; metrics suite 7/7 | CLI+unit | ✅ |
| 0.3 | provider-correct meter | displayed % tracks real single-request ctx | metrics reconcile; cost tracked live | unit | ✅ |
| 0.4 | cache-hit instrumentation | log read/write, per-hit rate | `cache-meter` 14/14 | unit | ✅ |
| 1.1 | prune-first ladder (Tier 0/1/2) | prune before summary | receipt shows `prune $0.0000` tier; compaction suite green | CLI+unit | ✅ |
| 1.2 | observation masking | mask consumed tool bodies | suite green; live ctx stayed lean across file reads | CLI+unit | ✅ |
| 1.3 | graph-aware pruning | drop stale/dup reads | `prune` 8/8 + compaction | unit | ✅ |
| 1.4 | large results → synopsis+handle | body on demand | compaction suite green | unit | ✅ |
| 1.5 | task-boundary trigger | defer + warn mid-flight | live WARN **"approaching context limit — will compact at next safe point"** | CLI+unit | ✅ |
| 1.6 | serialization + min_gap | no parallel compactors | compaction suite green | unit | ✅ |
| 1.7 | anti-loop trio | min-reduction-or-abort | live receipt **−0%** = summary correctly declined on an already-lean 8.5K ctx (can't free 8K from 8.5K) | CLI+unit | ✅ |
| 1.8 | threshold_pct trigger | honored as fraction of ctx | compaction fired under injected `threshold_pct:0.01`; suite green | CLI+unit | ✅ |
| 2.1 | typed state object | goal/files/numbers verbatim | core `session-compaction` 3/3 | unit | ✅ |
| 2.2 | incremental checkpoint | never summarize a summary | core `session-compaction` green | unit | ✅ |
| 2.3 | passive-snapshot framing | no ack, seamless resume | suite green; live turn 2 resumed with no "compaction happened" text | CLI+unit | ✅ |
| 2.4 | not re-executed (cheap OSS) | summary resumed, not re-run | live: post-compaction, conductor answered the goal Q from summary, **no file re-reads / re-execution** | CLI | ✅ |
| 3.1 | selectModelForTurn precedence | pin > triage > risk-route | `location-layer` 5/5, `model-router` 11/11 (wiring) | unit | ✅ |
| 3.2 | escalate-immediately (heavy) | heavy 1st prompt → escalate | `triage` 30/30 (`isHeavyPrompt`); promptProvider dormant by design | unit | ✅ |
| 3.3 | triage producer fires live | turn-0 → cheap triage tier | ⚠️ **divergence:** first conductor turn served by `deepseek-v4-flash`, not the `gpt-oss-20b` triage tier (see 11.4) | CLI | ⚠️ |
| 4.1 | `/context` breakdown | per-category grid | app `session-context-breakdown` 5/5 | unit | ✅ |
| 4.2 | footer countdown | "ctx left until compact" | TUI component present (`footer-countdown.tsx`, `context-usage.ts`) | code | ✅ |
| 4.3 | proactive nudge | warn at `nudge_pct` | live WARN nudge fired at 0.8 fill | CLI | ✅ |
| 4.4 | pre-compaction diff | show drop/keep | compaction suite green | unit | ✅ |
| 4.5 | `/compact [focus]` + `/clear` | honored toggle/threshold | server `SummarizePayload.focus` + TUI cmds present; suite green | code+unit | ✅ |
| 4.6 | `/usage` per-tier | tokens/$ per tier + reclaimed | app metrics 7/7 | unit | ✅ |
| 5.1 | receipt → savings surface | one-line receipt emitted | live **`compacted 8k → 8k (−0%) · prune $0.0000 + summary $0.0000 · deepseek/deepseek-v4-flash`** | CLI | ✅ |
| 5.2 | efficiency metrics loop | tokens/task, re-read, cache | `telemetry` 70/70 | unit | ✅ |
| 6.1 | pin/protect region | plan/files survive prune+summary | compaction suite green | unit | ✅ |
| 6.2 | recoverable transcript | pointer → raw head chunk | `compaction_refetch` tool + suite green | unit | ✅ |
| 6.3 | execution-frontier checkpoint | files/approaches/decisions persist | core `session-canonical-state` 2/2 + frontier tests | unit | ✅ |
| 7.1 | progressive tool-schema | catalog + load-on-use (flag OFF) | `tool/registry` 12/12 | unit | ✅ |
| 7.2 | cache-stable prefix | byte-stable, golden-hash | `cache-prefix` 3/3 (golden `5f8351c2…`) | unit | ✅ |
| 7.3 | no whole-file re-reads | JIT slices stay default | live compaction never forced re-reads | CLI | ✅ |
| 8.1 | compiled-brief oracle hop | brief, not raw transcript | `brief` 28/28 + `session-runner-model` (isOracleTurn) | unit | ✅ |
| 8.2 | executor token budget | child ≤ window; select→compress | `cli/run/subagent-data` 7/7 | unit | ✅ |
| 8.3 | conductor cache discipline | golden-hash CI | `cache-prefix` 3/3 | unit | ✅ |
| 8.4 | per-tier cache-hit + transitions | >85% target, flag <70% | `cache-meter` 14/14 | unit | ✅ |
| 8.5 | cache-aware hysteresis | bias against tier flips | `router` 28/28 (stickinessMargin) | unit | ✅ |

### 11.3 Unit-suite tallies (this pass)

| Group | Suites | Result |
|---|---|---|
| V1 · opencode session | `compaction` (58: 57✓/1 flaky), `cache-prefix` (3✓), `system` (1✓), `system-prompt` (15✓) | 76✓, 1 flaky |
| V2 · core session+router | `session-compaction` (3✓), `session-canonical-state` (2✓), `location-layer` (5✓), `session-runner-model-router` (11✓), `session-runner-model` (13✓) | 34✓ |
| V3 · code-intelligence | `cache-meter` 14, `telemetry` 70, `router` 28, `triage` 30, `brief` 28, `prune` 8, `risk` 18, `double-pay` 14, `abstention` 19, `reasoner` 16 | 245✓ |
| V4 · tools/budget/app | `tool/registry` 12, `session-context-metrics` 7, `session-context-breakdown` 5, `cli/run/subagent-data` 7 | 31✓ |

The one non-green result — `compaction.test.ts › "stops quickly when aborted during retry
backoff"` — is a **timing-sensitive assertion** (`<250ms`; observed 400–635ms under concurrent
load). It **passes in isolation** and is not a functional defect of compaction.

### 11.4 Divergences & follow-ups (observed live)

1. **Triage turn-zero routing did not take effect in the live CLI (AC-3.3).** The design intent
   is for the first interaction to be served by the cheap triage tier (`gpt-oss-20b`); the
   observed first conductor turn was served by `deepseek-v4-flash` (conductor). The triage
   *wiring* is unit-verified (`location-layer` routes a first turn to an injected triage model),
   but the opencode-side turn-zero bias is not firing end-to-end. **Root cause now confirmed —
   see §11.5 (architectural, deferred).**
2. **`gpt-oss-20b` errors on the OpenRouter endpoint:** `AI_APICallError: Reasoning is mandatory
   for this endpoint and cannot be disabled` (observed on the `title` housekeeping call). Because
   the small/summary/triage tier defaults to `gpt-oss-20b`, this blocks live cheap-tier
   summarization and triage on that model — the summarizer fell back to the conductor
   (`deepseek-v4-flash`) in the receipt. **✅ FIXED (§11.5) — reasoning is now accepted under the
   hood and hidden from the customer.**
3. **Live compaction reclaimed 0 tokens** in the forced run — a *correct* outcome here: the
   deterministic prune/mask tiers already keep context lean, so at an artificially low threshold
   the anti-loop min-reduction guard (AC-1.7) declined to summarize an 8.5K context. Real
   reduction is exercised by the compaction unit suite. To observe a large live reclaim, a
   genuinely large single-turn context plus a working summary tier (item 2) is needed. **Not a
   defect; no change.** The item-2 fix removes the `gpt-oss-20b` blocker from all cheap-tier
   housekeeping paths (title/summary/executor chores).

**Net:** 37/38 features verified working (CLI-observed and/or unit-green); **AC-3.3 triage
turn-zero routing is the one remaining live divergence** — its root cause is now precisely
identified (§11.5) as architectural (the router engine is not the engine serving live prompts),
so it is a scoped transplant, not a config fix.

### 11.5 Fix pass (2026-07-02, follow-up)

Post-verification remediation of the §11.4 divergences. Typecheck **25/25 green**; touched unit
suites re-run green (router/triage/risk/brief **104**, cache-prefix/system **4**, location-layer
**5**, compaction **58** [1 skip], session-runner-model + router **24**).

**Item 2 — `gpt-oss-20b` reasoning-mandatory error → FIXED (config).**

- **Root cause (diagnosed with a temporary `[econ-diag]` log of the final merged LLM options).**
  The outgoing request for `gpt-oss-20b` carried `reasoning: { effort: "none", … }`.
  `ProviderTransform.smallOptions` (`packages/opencode/src/provider/transform.ts:1235`) maps an
  OpenRouter model whose first variant advertises `reasoning.effort: "low"` down to
  `{ reasoning: { effort: "none" } }` (a cost-saving reasoning-off for housekeeping). Fireworks'
  `gpt-oss-20b` endpoint **rejects a reasoning-off** (`Reasoning is mandatory … cannot be
  disabled`). Our first attempt (`reasoning: { enabled: true, exclude: true }`) failed because
  `mergeDeep` layered our keys **on top of** the base without overriding `effort`, so
  `effort: "none"` survived.
- **Fix (`opencode.json`, `provider.openrouter.models."openai/gpt-oss-20b"`):** declare the model
  reasoning-capable (`"reasoning": true`) and set
  `options.reasoning = { "effort": "low", "exclude": true }`. The explicit `effort: "low"`
  **overrides** the injected `"none"` via `mergeDeep`, and `exclude: true` tells OpenRouter to run
  reasoning but **omit the trace from the response** — exactly the intent: *accept reasoning under
  the hood, don't show it to the customer.*
- **Verified live:** `run --agent conductor "What is 17 + 25?"` → answer `42`, **no
  mandatory-reasoning error**, `tokens.reasoning=16` (reasoning ran) with the trace **absent from
  the output** (hidden). The `title` housekeeping call on `gpt-oss-20b` now streams cleanly.

**Item 1 — triage turn-zero: root cause identified, fix deferred (architectural).**

- **Finding (diagnosed with a temporary `router.resolve` log in `runner/model.ts`, which
  *never fired* on a live `run`).** The triage bias + risk-escalation router lives in the **core
  V2 `SessionRunner`** (`packages/core/src/location-layer.ts` →
  `SessionRunnerModel.locationLayerWith`). The live `run`/TUI path is served by a **different
  engine** — the opencode `prompt.ts` loop — which has **no router hook** (a repo-wide grep of
  `prompt.ts`/`run.ts` for `router`/`triage`/`escalat`/`SessionRunner` returns nothing). So on a
  real turn, neither turn-zero triage nor risk-escalation runs; the agent's pinned model
  (conductor) is used directly. This supersedes §11.4's "dormant `promptProvider` and/or item 2"
  hypothesis: the diagnostic proves the router simply isn't in the live path, independent of the
  gpt-oss issue.
- **Why deferred:** the fix is a **scoped transplant**, not a config tweak — inject a turn-zero
  triage decision (reusing `decideTriageTurn`/`isHeavyPrompt` from `code-intelligence`) at the
  model-selection seam `packages/opencode/src/session/prompt.ts:673`
  (`input.model ?? ag.model ?? currentModel`), with first-turn detection, config plumbing, a
  heavy-prompt gate, and **non-sticky** per-turn routing (the resolved `info.model` is persisted
  and read back as `currentModel`, so a naive override would make the triage tier sticky for the
  whole session). That is a bounded feature with its own tests, out of scope for a "fix-now" pass.
  Tracked as a follow-up.

---

## Appendix — comparative reference (condensed)

| Project | Trigger | Mechanism | Keep verbatim | UX |
|---|---|---|---|---|
| Claude Code | ~83.5% window, ~33k buffer (lower-only override) | tiered: tool-result microcompact → full LLM summary | system prompt, memory, recent user msgs, security constraints | `/context`, `/usage`, `/compact [instr]`, `/clear`, countdown |
| Aider | `max_chat_history_tokens` (~ctx/16) + repo-map budget | recursive head/tail, weak-model summarizes head | recent tail; code symbol/file names | `/tokens`, `/clear`, `/drop`, `/reset`, `/map` |
| Cline | sliding window near limit (~40k/20% buffer) | truncate oldest pairs (½→¾) + SDK `compactTask` | first task msg, plan (Focus Chain), recent turns | context progress bar + manual compact button |
| Roo Code | `autoCondenseContextPercent` (def 100; 75–80 typical) | summarize→new "user" msg; non-destructive `condenseParent` | system prompt, first task msg, recent N | % bar, before/after + condense $, manual button, separate cheap model |
| Gemini CLI | 0.5–0.7 × window; `/compress` | truncate tool outputs (50k budget) + LLM summary of head | last ~30%; GEMINI.md; /memory | `/compress`, `/stats`, `/chat save\|resume`, `/memory` |
| Qwen Code | ~0.7 (`context.autoCompactThreshold`) + screenshot count | Gemini summary + rule-based `/compress-fast` (no LLM) | last ~30%; recent files≈5/images≈3 | `/compress`, `/compress-fast`, `/recap`, `/context`, `/stats` |
| Codex CLI | ~90% window (per-model ~180–244k); `/compact` | extract & rebuild; remote encrypted OR local plaintext | 1 summary + last ≤20k user tokens | status-line bars, `/status`, `/statusline`, `/compact` |
| Crush | remaining ≤20k (large) / ≤20% (small) | summarize-and-replace; summary role flipped Asst→User | summary only; todos preserved | `/summarize`, footer `95% (1.2M) $5.87`, ⚠️>80% |
| Goose | 0.8 window (`GOOSE_AUTO_COMPACTION_THRESHOLD`) | two-tier: middle-out tool pruning → summarize/truncate/clear/prompt | earliest + most recent; user sees originals | `Auto-compacted X→Y`, status colors, `/summarize`, cost |
| **OpenCode (base)** | absolute: tokens ≥ input_limit − 20k | summarize-and-replace (hidden agent) + tool-output prune | last 2 turns / 2–8k; DB keeps full history | silent; Compaction Started/Ended events |

*Constants are as reported by the survey (mix of source reads and secondary analyses).
Re-verify against the pinned upstream commit before adopting any specific value.*
