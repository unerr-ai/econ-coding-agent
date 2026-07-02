# econ — Market Economics & Buyer Reality

**Status:** Drafted 2026-06-30. This doc pressure-tests the positioning against the *hard numbers*
before we go deep on the India market: what an AI coding seat actually costs, whether the cheap
plan is enough, whether autonomous "software factories" make human-driven agents irrelevant, and
whether the services firms and GCCs we sell to are about to be wiped out by AI. It is the
evidence base under [POSITIONING.md](./POSITIONING.md) (which carries the strategy); see also
[ECON_ARCHITECTURE.md](./ECON_ARCHITECTURE.md) and [MODEL_SELECTION.md](./MODEL_SELECTION.md).
All figures are June 2026 market research; sources in §8.

> **This doc is India-focused.** The Europe counterpart — sovereignty-led, with the self-hosting
> cost & feasibility analysis — is [MARKET_ECONOMICS_EUROPE.md](./MARKET_ECONOMICS_EUROPE.md).

> **The one-sentence verdict.** **Cost — not capability or sovereignty — is the binding constraint
> everywhere; that cost hurts an Indian firm ~15× more than a US one; the GCC/services seat pool is
> *growing*, not vanishing; and autonomous coding is real but governance-gated to human-in-the-loop
> in exactly our target segment** — so we are on the right track *provided* we lead with cost and
> add an autonomous tier (the moat stays the context engine, not the discount).

---

## 1. The three "why buy us" reasons — reordered by segment

**In plain terms:** the order of reasons a customer cares about depends on *who* they are.
Sovereignty-first is right only for the premium regulated slice; for the volume buyer
(GCC / services firm), **cost is #1.**

### Under the hood

| Buyer | #1 trigger | #2 | #3 |
|---|---|---|---|
| **Regulated enterprise** (bank, defense, healthcare) | **Sovereignty** | US-vendor risk | Cost |
| **Services firm / GCC** (the bullseye) | **Cost** | Sovereignty (client-driven) | US-vendor / billing risk |
| **Startup / individual dev** | **Cost** | — | — |

Reason #3 ("pure US-based billing") is real and bundles three distinct pains for an Indian CFO:

- **(a) Forex risk** — USD bill against INR revenue.
- **(b) Unpredictable token bills** — usage-metered cost the finance team can't forecast.
- **(c) Kill-switch risk** — the Mythos/Fable global suspension in
  [ECON_ARCHITECTURE §14.1](./ECON_ARCHITECTURE.md): a US vendor cut the world off overnight.

"Priced in INR, predictable, and can't be switched off by a foreign directive" is a genuine third
pillar. **Operational rule: lead with sovereignty in BFSI/defense pitches; lead with cost in
services/GCC pitches.** Same product, different opening line.

---

## 2. What an AI coding seat actually costs — and the 15× India asymmetry

**In plain terms:** a serious AI coding seat now costs the employer hundreds of dollars a month —
and because Indian developer salaries are a fraction of US ones, the *same* tool bill is far more
painful here. That asymmetry, not raw price, is the heart of the cost pitch.

### Under the hood

**The cost the buyer is fighting (June 2026):**

| Layer | Cost |
|---|---|
| Enterprise seat floor | **$39–100/seat/mo** (Copilot Enterprise $39, Cursor Business $40 + GitHub Enterprise Cloud $21 ≈ $60 effective) |
| **All-in TCO per dev** (seat + token overage + governance + agentic compute) | **$200–600/dev/month** for agentic users |
| At 1,000 devs | **~$200–500/dev/month all-in** |
| Gartner headline | **"AI coding agents will cost *more* than real developers"** |
| Heavy-end prediction | a **$100k/yr-per-dev** AI bill |

**The Indian math — the single sharpest stat we have:**

```
US dev:     $300/mo AI tool  on a  $150k/yr salary   →   ~2%  of cost   (a rounding error)
India dev:  $300/mo AI tool  on an  $8k–20k/yr cost  →  20–50% of cost   (a board-level line item)
                                          └──── SAME tool cost is ~15× MORE PAINFUL in India ────┘
```

A serious agentic bill ($2,400–6,000/yr) lands on an Indian services/GCC dev who costs the firm
$8k–20k/yr — so the tool becomes **20–50% of the developer's fully-loaded cost.** In the US the
same tool sits on top of a $150k salary (≈2%). **The identical tool cost is ~15× more painful in
India**, which is exactly why this is a CFO-level problem here and a footnote there.

---

## 3. Is the $20 plan enough? No — the floor for all-day agentic work is ~$100

**In plain terms:** the cheap $20 plan is fine for occasional, few-hours-a-day use, but it is *not*
enough for a developer who uses an agent as their primary, all-day tool. Real agentic engineering
needs the $100+ tier.

### Under the hood

Plan tiers map directly to usage intensity (Claude Code data, representative of the market):

| Plan | Capacity (5-hr window) | What it really supports |
|---|---|---|
| **Pro $20/mo** | ~44K tokens | 3–5 hrs/day, multi-file edits — **NOT** all-day primary IDE. Partial/occasional use. |
| **Max 5x $100/mo** | ~88K tokens; 140–280 hrs Sonnet + 15–35 hrs Opus/wk | **Primary tool all workday, agent teams, real Opus** — the professional floor. |
| **Max 20x $200/mo** | ~220K tokens | **Rate limits stop mattering** for full-day agentic work. |

> **The per-seat number econ must beat is ~$100–300/seat/month.** $20 is partial-use; real all-day
> agentic engineering (what a services firm standardizes on) needs $100+. econ's open-model COGS
> delivers all-day agentic *sustainably* at a fraction of that — and undercutting $300 × thousands
> of seats, in-region and INR-billed, is a board-level saving, not a nice-to-have.

(One data point on why subscriptions beat raw API for heavy users: a dev who burned 10B tokens
over 8 months would owe ~$15,000 on API vs ~$800 on a $100/mo Max plan — a 93% saving — which also
shows how expensive heavy agentic usage is in absolute terms.)

---

## 4. Autonomous software building — real, but governance-gated to HITL

**In plain terms:** fully autonomous coding (the "dark factory": AI plans → writes → tests →
deploys with no human review) is now *capable* but not how enterprises actually *adopt* — they keep
a human in the loop for anything that matters.

### Under the hood

- **Capability exists:** leading frontier models are above the threshold for many real-world
  dark-factory tasks.
- **Adoption is human-in-the-loop (HITL):** agents *propose*; humans approve "Red Zone" changes.
  **Regulated industries *require* HITL** for explainability, auditability, and approval trails.
- **Proof it's real:** Cognition's Devin writes **~89–90% of Cognition's own production code** (up
  from 13% in Dec 2025) — but that is *greenfield, their own codebase*, not a bank's 20-year legacy.

**Implication:** fully autonomous works in **narrow / greenfield** contexts today; **enterprise +
regulated + legacy stays HITL** for years (governance, not capability, is the gate). That is
*protective* of our thesis — our bullseye (services firms on messy legacy code, under compliance)
is exactly where HITL persists and where the context engine
([ECON_ARCHITECTURE §5](./ECON_ARCHITECTURE.md)) matters most: you cannot autonomously touch code
you don't understand.

---

## 5. The software-factory startups — and the partnership that should scare us

**In plain terms:** a new class of "autonomous software engineer" startups is raising enormous
money and starting to court our exact buyers. We need to track them and have an answer.

### Under the hood

| Player | Status (2026) |
|---|---|
| **Cognition (Devin)** | **$26B valuation**, raised **$1B+**, revenue **$37M → $492M run-rate in a year** (~1,230% growth) |
| **Factory AI ("Droids")** | **$1.5B valuation**, $150M Series C (Khosla), **enterprise-infrastructure** focus |
| Market shape | **Bifurcated:** IDE assistants (Cursor/Copilot/Windsurf) ↔ autonomous long-horizon platforms (Devin, Factory, Claude Code Enterprise) |

> **The signal:** **Cognizant partnered with Cognition (Jan 2026)** to scale autonomous software
> engineering across delivery. A top-tier services firm hedging its own labor-arbitrage model by
> bolting on a US autonomous agent — both a **threat** (US autonomous players courting our exact
> buyers) and a **template** (services firms will buy/partner rather than build).

**So econ needs three modes, not one** — and the architecture already supports them:

```
ASSISTANT (IDE)      →   HITL AGENT (services/GCC      →   AUTONOMOUS "FACTORY" mode
today's buyers           sweet spot, where the             (where Devin/Factory pull
                         buyers are now)                    the market)
        ── econ's conductor/oracle/executor + long-horizon checkpointing spans all three ──
```

The differentiator vs Devin/Factory is unchanged: **in-region + cost + context moat.** An Indian
firm would far rather run a sovereign, INR-billed autonomous agent than ship its client's legacy
code to a US $26B startup's cloud.

---

## 6. Are GCCs & services firms going away? No — the pyramid reshapes, it doesn't collapse

**In plain terms:** the worry is that LLMs gut the very buyer we're targeting. The data says the
opposite: traditional repetitive roles shrink, but the overall workforce and especially GCCs are
*growing*. The pyramid is being reshaped toward agent-orchestration, not flattened.

### Under the hood

| Signal | Data |
|---|---|
| TCS cut headcount | **23,460 in FY26** (largest), citing AI-first pivot, reduced bench, fewer freshers |
| **But total Indian IT workforce GREW** | **+1.4 lakh to 59 lakh** by 2026 — growth in AI/cloud/data/**GCC** roles |
| **GCCs are BOOMING** | adding **3–4 lakh roles** — the **strongest hiring market in India 2026** (Walmart, JPMorgan, Goldman, Shell, Apple expanding India GCCs) |
| The shift | from mass entry-level hiring → fewer, specialized, AI-augmented engineers |

The **bottom of the pyramid** (freshers on boilerplate — the easy AI-replaceable work) shrinks; the
**middle/top** (engineers *orchestrating* agents) and **GCCs** grow. The sellable seat pool is
**growing**, just shifting from "junior writing code" to "engineer directing agents."

> **The "Claude desktop spree" clincher.** Uber/Microsoft rolled Claude Code out to thousands of
> devs — and the result was **not** mass replacement; it was **hit a cost wall and cap spending**
> (Uber's budget gone in 4 months; a Microsoft division forced off Claude Code). The binding
> constraint was **cost, not capability** — exactly econ's wedge. The spree proved demand is
> massive, humans got *expensive tools* (not pink slips), and the frontier bill is unsustainable.

**Positioning reframe:** don't sell econ as "cheaper autocomplete for the juniors you're laying
off." Sell it as **"the affordable agent-orchestration layer for the AI-augmented engineer and the
booming GCC seat"** — the role that is *growing*.

---

## 7. Things to fold into the GTM (don't lose these)

1. **The 15× pain asymmetry (§2)** — the single sharpest cost stat. Lead with it.
2. **The "agent tax" framing** — orgs now pay a per-dev tax of $200–500/mo just to use AI; econ's
   pitch is "cut your agent tax ~5×, in INR, in India."
3. **A 3-mode product** (assistant → HITL agent → autonomous factory), not one.
4. **GCC parent-pull** — a GCC is a captive arm of a global enterprise; winning the Bengaluru GCC
   is a warm path to the EU/US parent (and the compliance wedge there, see
   [POSITIONING.md §6](./POSITIONING.md)).
5. **Forex + predictability** — INR billing + flat-rate (not token-metered) pricing is itself a
   feature for CFOs burned by unpredictable USD token bills.
6. **The honest long-term risk** — if autonomous factories mature *and* commoditize, the
   labor-arbitrage model erodes and the buyer's budget shifts from "seats" to "outcomes." Hedge by
   owning the autonomous tier (point 3) so econ rides the shift instead of being disrupted by it.

---

## 8. Sources

Market research, June 2026 (full URLs captured in the conversation that produced this doc):

- **Per-seat / enterprise AI tooling economics** (§2–3) — digitalapplied.com (seat economics);
  palma.ai (cost for 1,000 devs); computerweekly.com (Gartner: agents cost more than developers);
  kilo.ai ($100k/yr-per-dev); morphllm.com & verdent.ai (Claude Code $20/$100/$200 plan limits &
  token windows)
- **Autonomous coding / software factories** (§4–5) — mindstudio.ai (dark factory);
  securityboulevard.com (HITL vs autonomous); ai2.work (Cognition $26B); entrepreneurloop.com
  (Devin writes 89–90% of own code; revenue run-rate); tech-insider.org (Factory AI $1.5B / Khosla
  Series C); news.cognizant.com (Cognizant × Cognition partnership, Jan 2026)
- **India IT / GCC workforce under AI** (§6) — layofftrends.com (TCS 23,460 FY26 cuts);
  zeebiz.com (IT workforce grew to 59 lakh despite layoffs); thefinancestory.com (GCC-driven shift,
  3–4 lakh GCC roles)
- **AI coding cost crisis** (the spree / cost wall, §6) — techtimes.com (Uber 4-month burn;
  Gartner); mlq.ai (Meta caps token spend)
