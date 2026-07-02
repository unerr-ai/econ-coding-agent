# econ — Positioning & Geographic Go-to-Market

**Status:** Drafted 2026-06-30; sovereignty-vs-residency (kill-switch) axis added 2026-07-02 (§6.1),
grounded in the June 2026 Fable 5 / Mythos 5 export-control episode; §2/§8 benchmarks refreshed to
current standings 2026-07-02; the tooling-stack cost wedge (§4) and competitor set (§9) refreshed
the same day. This is the strategic anchor doc for *how econ positions itself
in the coding-agent market, by geography* — which buyer, which wedge, which region, in which
order. It is the market-facing companion to the system design in
[ECON_ARCHITECTURE.md](./ECON_ARCHITECTURE.md) and the model picks in
[MODEL_SELECTION.md](./MODEL_SELECTION.md). Every claim here is grounded in market research
(June 2026); sources are listed in §11.

> **One-line position.** econ is **the coding agent for the way the rest of the world actually
> ships software** — frontier-class capability at a cost and compliance posture that fits India's
> software-delivery workforce first, then the regulated enterprises of Europe and the Gulf that
> US tools are *legally excluded* from serving. We win by *assembling* commodity pieces (cheap
> open models, sovereign infra) around the one thing that can't be bought: a context engine that
> compounds into per-codebase switching cost.

---

## 1. The one-paragraph version

Every "obvious" moat in this category has already been commoditized by someone better funded than
us — cheap models (MiniMax at $0.07/task), routing (Martian at a ~$1.3B valuation), sovereign
hosting (Yotta/E2E/Sarvam on $1B+ of IndiaAI money), and even low price (the floor is $0:
Copilot Free, Cline at 4M installs). What is **not** commoditized is a *product-grade, horizontal
coding agent* built natively for a specific underserved buyer, wrapped around a **context-
intelligence layer that makes cheap models stay accurate over real, long, messy codebases** — and
that gets *better per customer the longer it runs*. That accumulated codebase knowledge is the
only asset a competitor cannot rent or copy. Point that product at **India's IT-services firms and
GCCs** (the world's largest concentration of cost-pressured, compliance-bound developers), use
**cost** as the wedge in India, **compliance** as the wedge in Europe, and **sovereignty** as the
wedge in the Gulf — one product, three triggers.

---

## 2. The thesis behind the thesis — everything rentable is commoditized

**In plain terms:** we kept looking for the moat in the cheapest, most obvious places — and each
time, the research showed someone with far more money already owns it. The lesson isn't "give up";
it's "the moat is the *one* thing you build and accumulate, not the things you buy."

### Under the hood — the elimination table

Each row is a candidate moat we tested against the market and had to discard:

| Candidate moat | Verdict | Who already owns it |
|---|---|---|
| Cheap models | ❌ Commodity | Best open-weight now ~**80.6%** SWE-bench Verified (DeepSeek V4-Pro-Max, MiniMax M3) at a fraction of frontier token price; GLM-5.1, Qwen3-Coder, Kimi close behind |
| Multi-tier routing | ❌ Commodity — owned by horizontal infra | Martian (~$1.3B), OpenRouter ($500M / $50M ARR) |
| Sovereign in-region hosting | ❌ Commodity infra you **rent** | Yotta (Shakti Cloud), E2E, Sarvam, IndiaAI Mission ($1B+) |
| Low price / "affordable" | ❌ Floor is **$0** | Copilot Free, Cursor Hobby, Windsurf Free, Cline (4M installs) |
| Indian foundation models | ❌ Taken, government-backed | Sarvam, Krutrim, BharatGen |
| Raw benchmark score | ❌ It's the *model's* credit, not the harness's | frontier labs |

**The pattern (state it honestly):** anything that can be *bought or rented* is commoditized.
Exactly one thing is left that can only be *built and accumulated* — the context engine and the
per-customer codebase knowledge it grows. The whole positioning hangs off that single survivor.

> **Why the router is *secondary*, not the pitch.** Current SWE-bench Verified (July 2026): the best
> *generally-available* frontier oracle (Claude Opus 4.8, **88.6%**) leads the best *self-hostable*
> open-weight model (DeepSeek V4-Pro-Max / MiniMax M3, **~80.6%**) by ~**8 points**; on the harder
> SWE-bench Pro the gap runs ~10–20 points. (The 95%+ models — Fable 5 / Mythos 5 — are precisely the
> export-controlled / US-restricted ones, §6.1, so they aren't the sovereign ceiling.) So escalating
> the *hard tail* to a stronger oracle is a real cost-quality lever — but it is **out-leveraged by
> the harness**: running the *same model* through an identical standardized scaffold vs a tuned agent
> harness swings scores by **10–30 points**, "mostly context retrieval and tool-use quality, not
> model capability" (Scale). The lever ordering is **context engine (10–30 pts) > cheap-vs-frontier
> model gap (~8–20 pts) > frontier-vs-frontier swaps (smallest)**. Routing therefore stays in econ as
> a genuine cost/quality optimization (see [ECON_ARCHITECTURE.md §4](./ECON_ARCHITECTURE.md)) — **not**
> the pitch. And under §6.1's sovereignty constraint the escalation oracle must be *self-hostable*, so
> the sovereign config's ceiling is the best **open** model (~80.6%), not 88.6%. The pitch is the
> context engine.

---

## 3. The moat that survives — accumulated codebase context = switching cost

**In plain terms:** the longer econ works inside a customer's code, the more it learns their
repos, their conventions, their reviewers' rules — and the harder it becomes to rip out. A rival
with a better model or a lower price still shows up knowing *nothing* about that customer's
codebase. That head start can't be bought; it's earned, one month of usage at a time.

### Under the hood

This is belief #2 from the architecture ([ECON_ARCHITECTURE.md §5–6](./ECON_ARCHITECTURE.md))
re-read as a *business* moat, not just a quality feature:

- **The code graph** maps the customer's (often sprawling, legacy) repos — sub-5ms lookups,
  single-call recon bundles.
- **Anchored memory + auto-detected conventions** accumulate *their* delivery standards, their
  client-specific patterns, their architectural boundaries — pinned to real code, re-anchored as
  the code moves.
- **The compounding effect:** every month, the cheap models stay good on *their* code
  specifically, and the cost of switching to a competitor (who starts cold) rises.

```
   month 1            month 6              month 18
   ░░ thin            ▒▒ moderate          ██ deep
   graph mapped       conventions learned  delivery patterns, client
   basic recon        memory accumulating  rules, boundaries internalized
   ──────────────────────────────────────────────────────────▶
   switching cost rises every month — a rival still arrives COLD
```

Price, sovereignty, models, and routing can never be this — they are identical on day 1 for
anyone. **This is the only moat in the doc that deepens with time.** Every hour of engineering
should defend it.

---

## 4. The bullseye buyer — India's software-delivery workforce

**In plain terms:** the one customer on Earth that needs *all* of econ's pieces at once — cheap,
compliant, good-at-scale, in-region — is India's IT-services firms and the global captive dev
centers (GCCs) here. There are millions of developers in this segment, it is uniquely
concentrated in India, and no global or Indian player is structurally built to serve it.

### Under the hood

> **Primary segment:** the **5M+ developers** inside IT-services firms (TCS, Infosys, Wipro, HCL,
> Tech Mahindra, Cognizant + thousands of mid-tier shops) and the **1,700+ GCCs** (global captive
> dev centers operating from India).

Why this segment makes our "weaknesses" into their *requirements*:

1. **Their business model is labor-cost arbitrage — and the AI stack now lands *directly* on that
   margin.** The 2026 agentic stack, bought as separate tools, runs **$100–300/mo per active
   developer** (agent: Cursor/Codex $60–200; PR-review: CodeRabbit/Greptile/Qodo $12–30; plus
   completion/debug — and post-June-2026 usage billing makes it spikier still). Against an Indian
   services-dev salary of **~$10k/yr, that $3,000–3,600/yr is 30–36% of pay** — versus ~2.4% for a
   $150k US dev. That **15× pain asymmetry** (detail in [MARKET_ECONOMICS.md](./MARKET_ECONOMICS.md))
   is the wedge, and it means the pitch is *not* "cheaper Cursor": it is **collapsing the fragmented
   $300 stack into one open-MoE-powered agent — code + review + debug — at ~$30–60/mo**, the only way
   to deploy AI to thousands of delivery devs without destroying project margins. Frontier resellers
   (Cursor/Copilot) structurally cannot match this at services-firm scale — their cheap tiers *bleed*
   on VC subsidy. (econ is the **framework that orchestrates cheap open-weight MoE models**, not a
   model builder — MoE is *how* the COGS stays low, never the buyer-facing pitch.)
2. **They carry client data-residency obligations.** Building for a US bank or an EU insurer means
   contractual compliance clauses → they *need* in-region/VPC/on-prem, which econ rides for free on
   Yotta/E2E. Global SaaS agents can't offer this cleanly (see the CLOUD Act point, §6).
3. **They have thousands of seats and standardized delivery** — exactly where the §3 context moat
   compounds fastest, and exactly the scale at which switching cost becomes a lock.

**Adjacent paying segments (the funnel targets, §7):** Indian startups/SMEs (team seats), and at
the premium end, regulated enterprises (the sovereign play). **Non-paying but strategic:** students
and individual devs — serve them on the free tier as adoption + brand, *not* as a revenue line
(their willingness-to-pay is ~$0 and incumbents already give it away free).

> **Companion:** the hard buyer economics behind this segment — per-seat cost, the $20-vs-$100
> plan reality, the 15× India pain asymmetry, autonomous "software factories," and whether GCCs /
> services firms survive AI — live in [MARKET_ECONOMICS.md](./MARKET_ECONOMICS.md).

---

## 5. Geographic positioning — one product, three triggers

**In plain terms:** the *same* econ product is wanted for a *different reason* in each region. In
India it sells on **cost**. In Europe it sells on **compliance** (it's becoming illegal not to). In
the Gulf it sells on **sovereignty** (governments with near-infinite budgets demanding local
control). That one-product / three-triggers shape is a rare and powerful expansion story.

### Under the hood — the regional map

| Region | The trigger that sells it | Demand strength | Sales speed | Willingness to pay | Verdict |
|---|---|---|---|---|---|
| **India** 🇮🇳 | **COST** — services-firm / GCC margin pressure | ⭐⭐⭐ | Fast (we're local) | Low–mid, but volume | **Beachhead — sell here first** |
| **Middle East** 🇦🇪🇸🇦 | **SOVEREIGNTY + near-infinite capital** | ⭐⭐⭐ | Slow (relationship / government) | **Highest on Earth** | **Biggest deals — partner-led, phase 2** |
| **Europe** 🇪🇺 | **COMPLIANCE — becoming illegal not to** | ⭐⭐⭐ | Medium | High | **Highest-margin wedge — phase 2** |
| **SE Asia** 🇻🇳🇮🇩🇵🇭 | **COST** (same services DNA as India) | ⭐⭐ | Fast | **Lowest** | **Volume funnel — do last** |

```
        ┌──────────── ONE PRODUCT ────────────┐
        │  econ: open-weight coding agent +     │
        │  context engine + in-region deploy    │
        └───┬─────────────┬─────────────┬───────┘
            │ COST          │ COMPLIANCE   │ SOVEREIGNTY
            ▼               ▼              ▼
       India / SEA       Europe         Gulf (UAE/Saudi)
       services-firm     EU AI Act +    $1T capital,
       margins           CLOUD Act      "local intelligence"
       (volume)          (margin)       (biggest deals)
```

---

## 6. The regulatory gift — US incumbents are *legally excluded* from the two richest regions

**In plain terms:** the biggest competitors (Cursor, Copilot, Claude Code) are American — and in
Europe and the Gulf, new rules mean sensitive code legally *cannot* be handled by a US-headquartered
provider, no matter where the servers sit. econ, being open-weight and self-hostable, is *eligible
where they are forbidden*. That's not a marketing edge; it's a legal exclusion of our biggest rivals
from the highest-paying buyers.

### Under the hood

- **Europe:** The **EU AI Act is fully applicable from Aug 2, 2026** for high-risk systems — "the
  end of compliance by accident." Critically, the **US CLOUD Act** means an EU region of a US
  hyperscaler does **not** satisfy residency: if the provider is US-HQ'd, US law can compel the
  data even from Frankfurt or Zurich. An in-region deployment by a US-HQ'd provider (Bedrock's
  EU / GovCloud regions and Azure Foundry included) cures data-*residency* but not this
  jurisdictional reach — and, as the Fable 5 episode showed (§6.1), not the risk of the model being
  *switched off* by US order either. So US coding agents remain structurally non-compliant for
  sensitive EU work *by law*. **61% of Western European CIOs** now
  prioritize local providers; **52%** are accelerating data-sovereignty spend; **47%** are
  reevaluating non-EU cloud dependencies. (Local sovereign *model* players exist — Mistral, Aleph
  Alpha, Scaleway — but none is a coding-agent product; they are potential suppliers, not rivals.)
- **Middle East (UAE / Saudi):** Saudi's **$1T** investment pledge, HUMAIN (PIF), 11 data centers;
  regional data-center capacity tripling 1→3.3 GW by 2030. Governments demand *"local intelligence,
  not just data residency — the right to understand, audit, and control."* Residency laws create a
  **captive market** for regulated + government entities. Highest willingness-to-pay on Earth,
  gated by relationships and local presence.

### 6.1 Residency ≠ sovereignty — the kill-switch axis (the Fable 5 proof)

**In plain terms:** keeping the data in-region is not the same as controlling the model. A US
frontier model can be switched off *for you* overnight by *US* order — no matter where it runs. In
June 2026 that stopped being hypothetical.

#### Under the hood

On **June 12, 2026** the US Commerce Department issued an **export-control directive (EAR)** ordering
Anthropic to suspend **Claude Fable 5 and Mythos 5 for *every foreign national worldwide*** —
triggered by an Amazon-reported *"fix this code"* jailbreak that turned the model into a software-
vulnerability finder. Unable to verify nationality in real time, Anthropic took **both models fully
offline for everyone for ~18 days** (June 12 → July 1). To bring them back it shipped a jailbreak
classifier, routed flagged prompts to a fallback model, and **conceded US-government pre-release
testing of future frontier models**; the less-restricted **Mythos 5 remains gated to US
organizations + Project Glasswing partners.** (Notably, Anthropic itself argued the capability is
"widely available from other models" — so an *open-weight* model carries it too; the difference is
that no government can switch *yours* off.)

This separates two things the market kept conflating:

| | What it means | Solvable by a US provider's in-region cloud? |
|---|---|---|
| **Residency** | *Where the bytes sit* | ✅ Yes — Bedrock FedRAMP/GovCloud, Azure Foundry in-region |
| **Sovereignty** | *Who controls whether the model runs, for whom, at what capability* | ❌ **No** — export control, kill-switch, and capability-tiering hit the **model/provider layer** and apply **even to an in-VPC US model** |

**Why this is a gift to econ specifically.** The incident's trigger was a *coding* capability, and
the buyers most exposed — non-US governments and regulated enterprises — are exactly econ's
EU / Gulf / India targets. An **open-weight, self-hostable** agent has no foreign kill-switch, no
nationality gate, and no capability tier reserved for another country. So **sovereignty is not just
the Gulf trigger** (§5): after Fable 5 it is a cross-region reinforcement of the whole thesis, and
it rides an *already-funded* sovereign-model wave (Mistral ~€6B; India's BharatGen / AI4Bharat /
Sarvam; Gulf G42 / HUMAIN) whose default build path is fine-tuning open weights (Llama / Mistral /
Qwen) — precisely the stacks econ sits on top of.

**The design constraint it forces on us.** econ's escalation / oracle tier (§8) must itself be a
**large open-weight model on-soil**. Escalating the hard tail to a US frontier API would re-import
the exact kill-switch the sovereign buyer is paying us to avoid — breaking the value prop at the one
path that most needs to hold.

**The fundraise sentence this unlocks:**

> *"econ is a coding agent that is **eligible where Cursor and Copilot are legally excluded.**
> Same product, three triggers: India's services firms buy it on **cost**, Europe on **EU-AI-Act /
> CLOUD-Act compliance**, the Gulf on **sovereignty** — and it gets smarter about each customer's
> codebase the longer it runs. Beachhead India for proof and volume; expand into the EU and Gulf
> for margin."*

---

## 7. The motion — PLG funnel that builds the moat

**In plain terms:** give the cheap/free tier to individual Indian devs and students to win
adoption and brand (our open-model economics make this *sustainable*, unlike rivals who burn
subsidy). Those devs champion econ inside their employers; the firm then buys at scale to cut its
bill and meet client compliance — and every month of usage deepens the §3 context moat that keeps
them.

### Under the hood

```
FREE individual tier          →  TEAM seats (startups/SMEs,    →  ENTERPRISE (services firms +
(students + Indian devs;          INR/UPI, PPP-priced;             GCCs: thousands of seats, VPC /
sustainable on open-model         bottoms-up adoption inside       on-prem on Yotta/E2E, their repos
COGS — we don't bleed)            services firms & GCCs)           mapped → context moat compounds)

  ── adoption & brand ──         ── thin but real revenue ──       ── the real money + the lock-in ──
```

- **Price is the wedge in; accumulated context is the reason they never leave.**
- The free tier is affordable to run *only* because econ's COGS rides cheap open models
  (`reduction ≈ 1 − large-tier token share`; see [ECON_ARCHITECTURE.md §12](./ECON_ARCHITECTURE.md)) —
  a frontier-reseller's free funnel bleeds; ours doesn't.
- **India pricing:** localize hard — INR / UPI, PPP-discounted (3–5× lower than US list for
  B2C/SMB), meaningful annual-prepay discount to lift LTV.

---

## 8. The benchmark question — win the axis our architecture is built for

**In plain terms:** chasing the top of the raw "% of bugs solved" leaderboard is the wrong game for
us — our routing design can at best *tie* its strongest model there, and that's the model vendor's
credit. The leaderboard we can genuinely own is **most problems solved per dollar**, which is
exactly what econ is engineered for.

### Under the hood

- **The harness is where points (and product value) actually live:** running the *same model*
  through an identical standardized scaffold vs a tuned agent harness swings **SWE-bench Pro by
  10–30 points** — a spread that is "mostly context retrieval and tool-use quality, not model
  capability" (Scale's standardized-vs-vendor leaderboard). That swing is *larger than* the
  ~8-point cheap-vs-frontier *model* gap (§2). Our context engine *is* that harness — the single
  highest-leverage place to invest.
- **Routing can't exceed its oracle's accuracy** — it only moves you along the cost-quality
  frontier. So on raw %-resolved, econ ties its oracle at best; on **$-per-resolved-task**, econ can
  lead. Submit two configs: an *accuracy* config (route aggressively to the strongest **self-hostable**
  oracle — today ~80.6% Verified, the sovereign ceiling per §6.1) and a *cost-frontier* config (the
  product default). Lead public claims with the cost-normalized number and the harder, less-
  contaminated **SWE-bench Pro**, not Verified.
- **Probability read (honest):** top-10 by raw % is ~20–30% and fragile (it's the model's win);
  top-5 on **cost-per-resolved-task is ~50–70%** and on-brand. Point the benchmark strategy there.

---

## 9. Competitive landscape — why each rival structurally can't take this position

**In plain terms:** every competitor can copy one or two of our pieces, but none is built to
assemble *all* of them and aim them at India's services workforce.

### Under the hood

| Rival | Why they can't take this position |
|---|---|
| **Cursor / Copilot / Windsurf** | Resell frontier tokens → economics break at services-firm scale; no India residency/VPC story; legally excluded from sensitive EU/Gulf work (§6); little incentive to chase low-ARPU × high-volume |
| **Qodo / Tabnine** (all-in-one platforms) | The closest to the "consolidated stack" idea — Qodo bundles multi-agent review + test-gen (open PR-Agent core, $19); Tabnine runs switchable **open** models self-hosted ($12–39). But Qodo is review/test-centric (not a full agent) and US-cost; Tabnine does authoring/agent but has **no PR-review/CI** and isn't cost-arbitrage-positioned. Neither combines open-MoE COGS **+** full stack (code+review+debug) **+** India services GTM |
| **Sarvam / Krutrim / BharatGen** | Build *models*, historically **Indian-language**-first (voice, gov, translation). Sarvam's *next* funded model now targets **coding / agentic / cybersecurity** — but it's ~2–3 yrs behind frontier and, being a *model* not a harness, is a likely open-weight **supplier** for econ's oracle tier (§6.1) more than a head-to-head rival |
| **Martian / OpenRouter** | Horizontal routing infra — no vertical coding product, no India GTM, no codebase-context layer |
| **Yotta / E2E / sovereign clouds** | Sell compute — they're our **landlord**, never the product |
| **Cline / Aider / Continue** | Free BYO-key wrappers — no product depth, no context moat, no enterprise motion, no monetization |
| **TCS / Infosys building in-house** | The real risk — but they're systems integrators, not product builders; they'd rather buy / white-label than build *and maintain* a context engine. **Partner before they reflexively build.** |

**The defensible whole:** real coding product **+** sustainable cheap economics **+** in-region
compliance **+** a compounding codebase-context moat **+** India services-firm GTM. No single
incumbent is *structurally assembled* to do all five for this market.

---

## 10. Sell + fund — they're the same move

**In plain terms:** the single best thing we can do for both revenue *and* a raise is land a few
paying design partners now. The usage and savings data from those partners *is* the fundable
artifact — and it's a paid contract.

### Under the hood

VCs in 2026 fund **real usage + a sharp vertical wedge or proprietary-data moat**, and explicitly
reject "undifferentiated GPT wrappers." Founders close ~70% faster leading with the wedge. So:

**To sell now (cash in 1–3 months):**
1. **Paid POC with an Indian IT-services firm or GCC** feeling the cost cap. GCCs are ideal — a GCC
   win pulls through to its EU/US parent.
2. **One Gulf government-linked / BFSI entity via a local SI channel** — slow, but a single deal can
   be transformational given the budgets.

**To get funded (parallel, same artifact):**
3. **Lead with the context-engine moat + vertical wedge + "eligible where US tools are banned."**
   Pattern-match to Cursor / Glean, *never* to "we route to cheap models" (that reads as a wrapper).
4. **Investor pools:** India dev-tool/deep-tech (Peak XV, Accel India, Elevation, Blume, Together
   Fund) **+** global dev-tool / sovereign-angle funds (a16z, Khosla) **+** Gulf sovereign funds
   (our sovereignty thesis is their literal mandate).
5. **The proof slide is design-partner usage/savings**, not a benchmark: *"Firm X, 4,000 devs, 70%
   cost cut, in-region, won't switch because econ knows their codebase."*

### Sequencing — don't boil the ocean

```
NOW (0–3mo)     India design partners (services / GCC)  → revenue + the fundraise proof
                  ↓ same data
SEED (2–4mo)    Raise on: context moat + vertical wedge + "eligible where US tools are banned"
                  ↓
PHASE 2 (post)  Europe (compliance wedge — highest margin) + Gulf (sovereignty — biggest deals)
PHASE 3         SE Asia (cost wedge — volume funnel, lowest WTP, do last)
```

---

## 11. Honest risks (what must be true)

1. **The context engine has to actually deliver.** Cheap models *staying accurate over long, messy,
   legacy services-firm codebases* is the entire quality bet and the entire moat. If it's mediocre,
   econ is just another cheap wrapper. ~80% of engineering should defend §3.
2. **Land one lighthouse services firm or GCC.** The defensible/fundable artifact is a reference
   customer with retained-savings + usage data — not a leaderboard rank.
3. **Move before Sarvam or a GSI closes the gap.** It is now being *noticed* — Sarvam's next funded
   model explicitly targets coding/agentic — but execution runs ~2–3 yrs behind frontier, which
   preserves the window. The defense is *depth of the context moat × head start*, not secrecy; and
   Sarvam's coding model is more plausibly an open-weight **supplier** (§9) than a product rival.
4. **Services-firm procurement is slow.** Bottoms-up free adoption (PLG) is what shortens the
   enterprise sales cycle — seed the free tier early.
5. **The sovereign coding capability is dual-use — and cuts both ways.** The very thing that makes
   econ valuable to sovereign buyers — an open-weight agent that reads a codebase and finds/fixes
   flaws — is the capability that got Fable 5 pulled (§6.1), and it already lives in open models
   (e.g. Kimi K2.7). No *US* kill-switch touches econ, but a *sovereign's own* regulator (or US
   secondary pressure) could eventually restrict it. Treat responsible-use guardrails as table
   stakes, not an afterthought.

---

## 12. Positioning in one line (the commit)

> Don't be a sovereign agent, a cheap agent, or "an Indian Cursor." Be **the coding agent for
> India's software-delivery workforce** — winning on **sustainable-cheap economics + in-region
> compliance** to get in, and locking in on a **context engine that compounds into per-codebase
> switching cost** — then expand into **Europe (compliance) and the Gulf (sovereignty), where US
> incumbents are legally excluded.** Price is the wedge in, never the moat.

---

## 13. Sources

Market research, June 2026 (full URLs captured in the conversation that produced this doc):

- **Scaffold vs. model on benchmarks** — Scale (labs.scale.com, standardized-vs-vendor harness =
  10–30 pt swing, "mostly context retrieval and tool-use quality"); particula.tech (scaffolding beats
  model upgrades); digitalapplied.com; mindstudio.ai (harness > model)
- **Current standings (July 2026 refresh, §2/§8)** — SWE-bench Verified: Opus 4.8 **88.6%**, GPT-5.5
  82.6%, best open-weight (DeepSeek V4-Pro-Max / MiniMax M3) **~80.6%**; Fable 5 / Mythos 5 95–95.5%
  (export-controlled/US-restricted). SWE-bench Pro: Opus 4.8 69.2% (vendor), Scale standardized 59.1%
  top / 38.7% top open-weight. Sources: swebench.com; morphllm.com/swe-bench-pro & /best-ai-model-for-coding;
  benchlm.ai/benchmarks/sweVerified & /swePro; llm-stats.com; labs.scale.com/leaderboard/swe_bench_pro_public;
  kilo.ai (open-weight standings)
- **Routing economics** — zilliz.com (RouteLLM cost-quality)
- **Inference/routing funding** — techtimes.com ($1.8B/2 days); ainvest.com (Inferact $150M seed);
  sacra.com (OpenRouter); Martian ~$1.3B valuation
- **AI coding cost crisis** — techtimes.com (Gartner; Uber 4-month burn); mlq.ai (Meta caps);
  spheron.network (inference cost economics)
- **Tooling-stack cost & competitors (§4/§9, July 2026)** — getdx.com & developersdigest.tech
  (agent stack $100–300/dev/mo; June-2026 usage-billing shift, $29→$750 spikes); qodo.ai/pricing &
  greptile.com (CodeRabbit $12–24, Greptile $30, Qodo $19 review pricing); qodo.ai (Qodo 2.0
  multi-agent review + test-gen, open PR-Agent); tabnine.com/pricing (switchable open models,
  self-host, $12–39); levels.fyi/6figr (Infosys median ~₹9.22L ≈ $11k; freshers ₹3.5–7L). Sarvam
  next-model coding/agentic pivot — forbesindia.com, en.wikipedia.org/wiki/Sarvam_AI,
  inc42.com (sovereign AI reality check)
- **India sovereign AI** — sarvam.ai; restofworld.org (Sarvam/Krutrim); nvidia.com (Yotta Shakti
  Cloud; E2E + Nemotron); blogs.nvidia.com (Persistent code workflows); explainx.ai (IndiaAI status)
- **Affordable/consumer floor** — nocode.mba (Copilot pricing); developersdigest.tech (free tiers);
  rocket.new (Cline 4M installs); atlascloud.ai (GLM/Atlas coding plans)
- **India WTP / PPP pricing** — playto.so (India vs international SaaS pricing)
- **Europe sovereignty** — lyceum.technology (EU data residency / CLOUD Act); aimadetools.com (EU
  sovereign landscape); EU AI Act full applicability Aug 2, 2026
- **Middle East** — introl.com (UAE/Saudi $100B+ / $1T, HUMAIN); microsoft/AWS 2026 KSA regions
- **SE Asia** — secondtalent.com (SEA AI engineering talent; 71% Copilot/Cursor usage);
  smartdev.com (Vietnam IT workforce)
- **Funding patterns** — sky9capital.com; waveup.com (lead with vertical wedge / proprietary-data
  moat; VCs reject GPT wrappers)
- **Sovereignty / export-control kill-switch (§6.1)** — Anthropic newsroom (statement on the
  Fable 5 / Mythos 5 suspension; "Redeploying Fable 5"; Project Glasswing); Fortune ("fix this
  code"); CNBC & CNN (controls lifted Jun 30 – Jul 1 2026); Tom's Hardware; MLQ (Amazon/Jassy
  trigger). Legal architecture: BIS "Framework for AI Diffusion" (published Jan 13 2025, controlled
  model weights + foreign-national access; rescinded May 12–13 2025, replacement pending). Sovereign-
  model programs: Mistral (~€6B), India BharatGen / AI4Bharat / Sarvam, Gulf G42 / HUMAIN; CNAS
  Sovereign AI Index; open-weight fine-tune default (Llama / Mistral / Qwen)

> Buyer-economics sources (per-seat cost, plan limits, autonomous factories, IT/GCC workforce) live
> in [MARKET_ECONOMICS.md §8](./MARKET_ECONOMICS.md).
