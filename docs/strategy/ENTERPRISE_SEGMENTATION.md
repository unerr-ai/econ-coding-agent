# econ — Enterprise Segmentation: Affordability × Independence (global)

**Status:** Drafted 2026-07-07. This doc answers one planning question: *how critical are AI-cost
affordability and independence-from-frontier-models for each category of enterprise, worldwide* —
so we can plan GTM by **segment**, not just by region. It is the cross-segment companion to
[POSITIONING.md](./POSITIONING.md) (which owns the regional "one-product / three-triggers" GTM, the
wedge, and the moat) and [MARKET_ECONOMICS.md](./MARKET_ECONOMICS.md) (which owns the India buyer
economics and the 15× pain stat). Figures are 2026 market research; sources new to this doc are in
§9, shared sources live in [POSITIONING.md §11](./POSITIONING.md) and
[MARKET_ECONOMICS.md §8](./MARKET_ECONOMICS.md).

> **The one-paragraph verdict.** Affordability and independence are **two independent demand axes**,
> and almost every enterprise sits high on at least one — but *which* one, and *why*, decides the
> pitch. Affordability itself has two engines: **parity** (the tool is a large share of a cheap
> salary — emerging markets, SMBs) and **scale** (per-seat is fine but total metered spend became a
> P&L line — services firms and big enterprises). Cost-led volume (India/SEA services + GCCs) is the
> **beachhead**; the high-affordability × high-independence **intersection** (regulated BFSI/health
> at scale — now including frontier-native giants hit by bill-shock) is the **highest-value, stickiest
> lane**; forced-independence (defense/gov, China-domestic) is the **patient premium track**. One
> product serves all three because the model bound to each tier is a **per-enterprise configuration**,
> not a fixed choice.

---

## 1. Two axes — and affordability has two engines

**In plain terms:** stop treating "they want it cheaper" as one thing. A bootstrapped founder in
Lagos and a managing director at Goldman both want a lower AI bill, but for opposite reasons, and
they buy on different words. And "they can't depend on US models" is a *separate* axis that a US
startup feels not at all and a European bank feels as law.

### Under the hood

**Axis A — Affordability.** Two distinct engines:

- **Parity-affordability** — the tool costs a large slice of a *cheap salary*. A serious agentic
  seat (~$2,400/yr) is **24–40%** of an Indian developer's salary, ~**30–33%** in the
  Philippines/Nigeria, vs **~1.8%** in the US. These buyers *cannot afford it at all* → emerging
  markets, SMBs, solo devs. (The India detail — the 15× pain asymmetry — is owned by
  [MARKET_ECONOMICS.md §2](./MARKET_ECONOMICS.md); the cross-region parity spread is the global
  addition here.)
- **Scale-affordability** — per-seat is affordable, but *total metered spend across thousands of
  devs* exploded into a board-level line. Uber capped spend at **$1,500/mo per developer after
  burning its entire 2026 coding budget in four months** across ~5,000 engineers; Gartner projects
  AI coding cost to **surpass the average developer's salary by 2028**. These buyers *can* afford it
  but want the bill cut → services firms, GCCs, big enterprises.

**Axis B — Independence** (from US frontier models — Claude / GPT / Gemini). Driven by data-residency
law, export-control exposure, sovereignty policy, or air-gap requirement — *not* by price. The
June 2026 Fable 5 / Mythos 5 export-control blackout (a US directive took two frontier models
offline worldwide for ~18 days) turned this from a preference into a demonstrated risk; the full
episode is owned by [POSITIONING.md §6.1](./POSITIONING.md).

The two axes are independent: a US startup is high-affordability / low-independence; a European
defense contractor is the reverse.

---

## 2. The map — affordability × independence

**In plain terms:** place every buyer on a 2×2. The corner they land in *is* the pitch.

```
                 INDEPENDENCE need  ──►  HIGH
        ┌─────────────────────────────┬─────────────────────────────┐
   HIGH │  ★ THE INTERSECTION         │  SOVEREIGN / FORCED          │
   A    │  EU regulated BFSI / health │  Defense · gov · intel       │
   F    │  India/SEA regulated + resid│    (ITAR / IL6 → air-gap)    │
   F    │  US & global BFSI at scale  │  China / Russia (forced —    │
   O    │  → "governed AND cheaper"   │   not addressable by us)     │
   R  ──┼─────────────────────────────┼─────────────────────────────┤
   D    │  COST-LED (the beachhead)   │  SOVEREIGNTY-LED (prefer)    │
   LOW  │  India / SEA services, GCCs │  Gulf (buys frontier), Japan │
        │  LatAm nearshore            │  / Korea, EU discretionary   │
        │  Bootstrapped SMBs globally │  → weak cost story alone     │
        │  → "cheap, self-serve"      │                              │
        └─────────────────────────────┴─────────────────────────────┘
   LOW ◄── FRONTIER-NATIVE (US/Canada big-tech, ANZ, funded startups):
           historically not a target — but addressable once scale-affordability
           bites (Uber, Goldman), via the model-agnostic config of §6.
```

The four quadrants, decided:

- **Cost-led (high aff / low indep)** — the beachhead. Price is the only axis that moves the buyer;
  procurement is fast and startup-open. Volume, low ARPU, where the data flywheel accrues cheapest.
- **The intersection (high aff / high indep)** — the highest-value lane. Governance/compliance
  pressure *and* a scale bill at once. Bigger contracts, stickier (the integration and accumulated
  per-org memory are what lock them in). Lead with "governed **and** cheaper."
- **Sovereign / forced (high indep)** — defense, government, intelligence, and the fully-decoupled
  states. Cost is secondary; the constraint is legal/political. China and Russia are the largest
  forced-independent markets on Earth but are **not addressable by a foreign vendor** — treat as
  out of scope, not opportunity.
- **Frontier-native (low / low)** — US/Canada big-tech, ANZ, funded startups. The hardest sell on
  cost historically; §6 shows how the model-agnostic config converts the *scale-affordability*
  slice of this corner (Uber/Goldman-type bill-shock) into a reachable buyer.

---

## 3. By business type

**In plain terms:** rank the categories by how hard each axis bites, and what to open with.

### Under the hood

| Segment | Afford. | Indep. | Engine | Lead with |
|---|---|---|---|---|
| **IT services / SIs** (India, E.Europe, LatAm) | **HIGH** | LOW–MED | scale | Savings receipt — seat bills of **$137–281M/yr** land on **13–24%** operating margins across 300k–600k devs |
| **GCCs** (MNC captives) | **HIGH** | MED | scale + residency | Price + in-region; cost arbitrage is their founding mandate ([MARKET_ECONOMICS.md §6](./MARKET_ECONOMICS.md)) |
| **Regulated BFSI** (EU + now US at scale) | **MED→HIGH** | **HIGH** | scale + governance | Governed + accountable + cheaper on the boring 80% — **the intersection** |
| **Healthcare / pharma** | MED | **HIGH** | governance | On-prem / air-gapped + affordable |
| **Defense / gov / intel** | LOW–MED | **HIGHEST** (forced) | forced | Air-gapped sovereign — patient track ([DEFENSE_OPPORTUNITY.md](./DEFENSE_OPPORTUNITY.md)) |
| **Bootstrapped / SMB startups** (global) | **HIGH** | LOW | parity | Cheap, self-serve, community-led |
| **Funded startups** | LOW–MED | LOW | capability | Not primary |
| **Big-tech / frontier-native** | LOW (rising) | LOW | capability | Not primary — but watch the scale crack (Uber, Goldman) |

**The scale-affordability correction.** Regulated BFSI and big-tech were long assumed to be
cost-insensitive ("they optimize for capability and compliance, not price"). At the top of the
spend curve that no longer holds: a US BFSI giant spending heavily on Claude + Copilot + Devin and
actively hunting for cost relief (a directly-disclosed 2026 signal, corroborating the Uber/Gartner
pattern) sits in the **intersection**, not the low-priority corner — scale-affordability pain plus
hard independence pressure (model-risk governance, customer-data residency). Treat this as a real
but **slower, higher-value** motion: the enterprise trust/procurement bar (accreditation, security
review, references) is brutal, and these buyers default today to accredited frontier incumbents.
Do not let it pull focus off the cost-led beachhead that funds the company and feeds the flywheel.

---

## 4. By region

**In plain terms:** each region leans on one axis. Sell where an axis we serve is the *dominant* one.

### Under the hood

| Bucket | Regions | Our fit |
|---|---|---|
| **Frontier-native** (cost secondary) | North America, Australia/NZ | Hardest sell; reachable only via §6 config on scale-affordability |
| **Cost-led** | India, SEA, LatAm, E.Europe, Africa | **Home field** |
| **Sovereignty-led** | W.Europe / UK, Gulf, Japan / Korea | EU strong (cost **+** residency gate); Gulf weak (buys frontier at any price — [POSITIONING.md §6](./POSITIONING.md)) |
| **Locked-out / forced-domestic** | China (Russia) | Not addressable by a foreign vendor |

This maps onto — and does not replace — the regional sequencing in
[POSITIONING.md §5](./POSITIONING.md) (India = cost, Europe = compliance, Gulf = sovereignty) and
the Europe self-hosting analysis in [MARKET_ECONOMICS_EUROPE.md](./MARKET_ECONOMICS_EUROPE.md).

**Highest-opportunity region × sector cells, in priority order:**

1. **India × IT-services / GCCs** — the largest cost-led, English-first, high-AI-trust developer
   base, with startup-open procurement. The beachhead.
2. **W. Europe × regulated mid-market** (finance/DORA, health, public) — sovereignty is a *scored
   procurement gate* (EU AI Act fully applies **Aug 2, 2026**); lead on residency, close on cost.
3. **SEA (Vietnam / Indonesia) × dev shops + data-localized regulated firms** — cost **plus**
   residency laws that US SaaS cannot satisfy.
4. **LatAm (Brazil / Mexico) × nearshore engineering + digitizing government** — cost-led,
   fast-growing, low frontier lock-in, open field early.

---

## 5. Forced vs. prefer — the independence spectrum

**In plain terms:** independence ranges from "would be nice" to "illegal not to." The buyers with
*no choice* are the ones sovereignty-first messaging is actually for.

### Under the hood, highest-criticality first:

- **FORCED (no choice):** China / Russia / sanctioned states (barred from US frontier models); and
  **air-gapped / controlled-data workloads in every country** — defense/ITAR, classified government,
  and regulated BFSI/health data that ITAR / IL6 / HIPAA / GDPR Art. 46 push off US closed-model
  APIs regardless of geography. These already default to self-hosted **open** models — econ's native
  ground.
- **PREFER → hardening toward FORCED:** the **EU** — AI Act, GDPR, US-CLOUD-Act exposure, and the
  June 2026 blackout together moved sovereignty from preference toward policy for sensitive
  workloads, though most commercial EU use is still discretionary.
- **PREFER (conditional):** the tier-2 middle — Gulf (conditionally forced via US licensing
  leverage, but buys frontier when permitted), India, SEA, LatAm (prefer independence for cost and
  residency, exposed to government-to-government gating).
- **PREFER (soft):** commercial buyers in US-aligned countries — driven by the cost and latency gap,
  not by any legal bar.

---

## 6. One product, every segment — model choice is a per-enterprise config

**In plain terms:** we do not need a different product per segment. The savings come from the
*harness* — decomposing a task and routing each slice to the cheapest capable tier, then verifying —
not from the models being open-weight. So each customer configures which model backs each tier, and
the *same* product serves the cost-led startup, the governed bank, and the air-gapped agency.

### Under the hood

The four tiers — **conductor, executor, reasoner, oracle** — are independent sockets. A per-enterprise
binding decides what fills each:

- **Default: all four open-weight** (econ's identity, margin, and independence story). Per the `dec`
  on `ECON_TIER_BINDING`, the default team is the open-weight tier lineup, the conductor being the
  fast/cheap dispatcher slot — the single source of truth for tier↔model bindings
  ([MODEL_SELECTION.md](./MODEL_SELECTION.md)).
- **Org option: bind any/all sockets to the models they choose** — all frontier, all open, or any
  mix — from a **characterized menu** (each binding needs a cost profile, cache-accounting,
  session-affinity, and verify-behaviour characterization before real work routes to it; the
  per-model manifest already carries these fields). It is "your models, your choice," from a vetted
  list — which enterprises prefer anyway.

Why this is the mechanism that unifies the segmentation:

- **The mixed config is the best-value point, and the smart default for the intersection.** Bind the
  oracle to a frontier model (quality on the irreducible-hard 10–20% tail a bank won't trust to open
  weights) and keep conductor/executor open-weight (the boring 80%). The savings identity
  `reduction ≈ f × (1 − 1/r)` then runs with the best of both — open-weight base rate on the bulk,
  frontier only where reasoning is genuinely hard — beating both all-frontier and all-open. It is
  just a config. (The compute-dial logic is owned by
  [design/adaptive-compute.md](../design/adaptive-compute.md).)
- **The config *is* the segmentation:** cost-led → all open-weight (default); intersection
  (BFSI/health at scale) → mixed, their accredited models on the tiers they care about;
  sovereign/air-gapped → all open-weight, self-hosted, no frontier egress.
- **Bring-your-own-keys resolves the reseller trap.** If the org binds a frontier socket with *its
  own* Anthropic/OpenAI contract and keys, econ is not reselling frontier — it is the **control
  plane over the customer's own model accounts**, so the frontier-cutoff and margin risk are theirs,
  and econ is not a thin pass-through a lab can absorb.
- **The verifier makes every config safe.** Whatever a customer binds to the executor, the same
  in-loop verification gates it — routing down is not a quality gamble
  ([ECON_ARCHITECTURE.md](../architecture/ECON_ARCHITECTURE.md)).

The config is a go-to-market **unlock and objection-killer** — it neutralizes the "open-weight is
6–12 months behind" objection for capability-sensitive buyers, and reaches the frontier-native
scale-affordability slice with zero switching cost. It is **not the moat**; the durable value stays
the harness plus the accumulated per-org verified memory (see [POSITIONING.md §3](./POSITIONING.md)).
Don't mistake the feature for the moat.

---

## 7. The three GTM lanes

**In plain terms:** the segmentation collapses to three sales motions. One product, three lanes,
sequenced by effort and value.

### Under the hood

| Lane | Segment | Motion | Dominant axis | Effort |
|---|---|---|---|---|
| **1. Cost fast-lane** | India / SEA / LatAm services, GCCs, SMBs | Self-serve + savings receipt; price-led; community launch when benchmarks land | affordability (parity + scale) | **Beachhead — most effort** |
| **2. Governed-enterprise** | EU regulated BFSI/health/public + frontier-native enterprises at scale (Goldman-type) | "Governed + in-region + cheaper on the boring 80%"; land-and-expand; mixed config | intersection (both) | High-value — build toward it |
| **3. Sovereign / air-gapped** | Defense, government, Gulf sovereigns | Forced-independence; long procurement | independence (forced) | Patient 2nd track (~10–15%) |

These lanes are the **segment cut** of the same strategy that
[POSITIONING.md §5](./POSITIONING.md) expresses as the **regional cut** (three triggers). Lane 1 ≈
India cost trigger; Lane 2 ≈ Europe compliance trigger + the scale-affordability enterprises the
regional model didn't name; Lane 3 ≈ Gulf/defense sovereignty trigger. Detailed defense sizing and
posture: [DEFENSE_OPPORTUNITY.md](./DEFENSE_OPPORTUNITY.md).

---

## 8. The honest caveats (what must be held)

1. **Open-weight wins on cost and residency, not capability.** In enterprise *production* spend,
   frontier labs still dominate (~88% of LLM usage; the leading lab ~42–54% of the coding segment),
   and open-weight's share of production spend actually *fell to ~11–13%* in 2025 even as
   usage/downloads surged. Sell where the cost/residency axes dominate — not where capability is the
   only axis. (Where capability is required, the mixed config of §6 answers it.)
2. **The intersection is high-value but slow.** Regulated enterprises convert on a trust/procurement
   timeline measured in quarters. The cost-led beachhead funds the company while Lane 2 matures.
3. **Scale-affordability at frontier-native firms is an emerging crack, not yet a market.** One
   disclosed signal corroborating a documented pattern (Uber, Gartner) is a reason to *start
   collecting enterprise conversations now* — not to reprioritize off the beachhead.
4. **The config knob and the harness are the wedge; the moat is what accumulates.** Per-org verified
   memory + integration is the only asset a competitor cannot rent or rebuild
   ([POSITIONING.md §3](./POSITIONING.md)).

---

## 9. Sources (new to this doc)

2026 market research. Shared sources (per-seat economics, autonomous factories, IT/GCC workforce,
the Fable/Mythos kill-switch, EU AI Act, sovereign-model programs) live in
[POSITIONING.md §11](./POSITIONING.md) and [MARKET_ECONOMICS.md §8](./MARKET_ECONOMICS.md); only
sources introduced here are listed below.

- **Scale-affordability** — Gartner (Jun 2026): AI coding cost to surpass average developer salary
  by 2028; TechCrunch (Jun 2026): Uber $1,500/mo/dev cap after burning its 2026 budget in four
  months (~5,000 engineers).
- **Cross-region salary parity** — a serious agentic seat as % of local average developer salary:
  India 24–40%, Philippines/Nigeria ~30–33%, vs US ~1.8% (2026 salary aggregators; local-market
  figures).
- **Production-spend vs. usage** — Menlo Ventures (Dec 2025): frontier labs ~88% of enterprise LLM
  usage; open-weight production-spend share ~11–13% (fell in 2025 as usage rose).
- **Independence / export controls** — US tiered-access Executive Order (Jun 2, 2026); EU AI Act
  full applicability Aug 2, 2026; China domestic-open-weight share (>45% of weekly OpenRouter volume
  by Apr 2026). Corroborated by top-tier legal/policy coverage; some market-share percentages trace
  to secondary outlets and should be re-verified before external quotation.
