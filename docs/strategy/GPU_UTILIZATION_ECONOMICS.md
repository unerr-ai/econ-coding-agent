# econ — GPU Utilization Economics: idle, buy-vs-rent, sovereignty & TEE

**Status:** Drafted 2026-07-02. How real operators keep GPUs busy and profitable, and what that
means for econ's self-hosting. Covers the idle-GPU problem, buy-vs-rent, the utilization playbook,
offsetting India's timezone trough, the sovereign hosting model, and the sovereignty/CLOUD-Act rules
around rented + Confidential-Computing GPUs. Companion to
[TOKEN_ECONOMICS.md](./TOKEN_ECONOMICS.md) (cost/pricing model), [SOVEREIGN_HOSTING.md](./SOVEREIGN_HOSTING.md)
(rent-vs-own + capital), and [MODEL_RESEARCH.md](./MODEL_RESEARCH.md) (model facts).

> **One-line thesis.** Utilization *is* the margin. An India-only coding agent runs GPUs ~8 h/day →
> **~27% effective utilization**, at which **renting per-token beats owning**. You earn the right to
> own by *aggregating uncorrelated demand* (models × timezones × workload-types × tenants) onto one
> continuously-batched fleet. Cheap out-of-region rental is fine — but **only for non-customer-data
> work**, because the US CLOUD Act reaches the *provider*, not you.

Figures are vendor/market data as of mid-2026 (sources §9); treat as directional, re-check before commitments.

---

## 0. The one law — utilization is the margin

- A GPU at **30% utilization costs 3.3× more per unit of work** than one at 100%.
- GPU businesses therefore cap at **50–60% gross margin** (Fireworks ~50%, target 60%) vs software's
  80–90% — the GPU sits in COGS.
- Continuous batching (vLLM PagedAttention) lifts a fleet from **15–30% → 60–80%** utilization
  (3–4× effective throughput at the same cost) — the single biggest software lever.

---

## 1. The idle-GPU problem (econ's starting point)

An India-only coding agent is used in Indian business hours: **~8 h/day at ~80% peak →
effective 24×7 utilization ≈ 0.33 × 0.80 ≈ 27%.** At ~27%:

- Per-token cost is ~3–4× the busy-fleet floor.
- **Owning loses to renting** (see §2) — the asset obsoletes before it pays back.
- So the entire task is lifting effective utilization toward ~60–80% *before* self-hosting makes sense.

---

## 2. Buy vs rent — the validated framework

| | 2026 numbers |
|---|---|
| **Buy** H100 | $25k–40k/GPU (PCIe vs SXM5) + DC/power/networking |
| **Rent** H100 | on-demand $1.38–8.00/hr (median ~$2.3–3.1); **spot $1.03–1.91/hr** |
| Naive payback | ~12 months — *misleading* |
| **Real break-even** | **18+ months of near-100% utilization** |
| At 40% utilization | break-even **~29 months** — lands *just before* the **36-month obsolescence cliff** |

**Decision rule (industry consensus):**
- **Rent** if utilization is unknown, bursty, or <40 GPU-hrs/week. No capex bet while demand is unproven.
- **Buy** only with **near-100% for 18+ months**, existing DC infra, and 24/7 need.
- **2026 favors renting** — rental rates are at multi-year lows.
- **Depreciation is the quiet killer:** below ~50% utilization the card obsoletes before payback.

> **econ verdict:** at ~27% util, **rent** (hosted per-token today). Only buy the tiers/hours you can
> guarantee near-100% for 18+ months — which requires first building the demand in §4.

---

## 3. How operators keep GPUs busy — the utilization playbook

Nobody relies on one workload. They **aggregate uncorrelated demand onto one fleet**. Five stacked tactics:

| Tactic | What it does | Example |
|---|---|---|
| **Capacity tiering** | Reserved (finances the capex, predictable floor) + On-demand (burst, high price) + Spot (interruptible backfill) on the same hardware | CoreWeave Flex Reservations + Spot |
| **Multi-model fleet smoothing** | Serve many models so one's peak = another's trough → the fleet averages out | Together, Fireworks |
| **Continuous batching** | 15–30% → 60–80% utilization, 3–4× throughput at same cost | vLLM PagedAttention |
| **Model pooling** | Multiplex many models on few GPUs instead of one-GPU-per-model | Aegaeon (SOSP'25): 1,192 → 213 GPUs, −82%, same SLA |
| **Batch/overnight backfill** | Training, evals, offline batch fill interactive troughs — "never truly idle" | model labs |

Inference-tuned operators (batching + SLA) earn **20–40% more revenue/GPU-hr** than those renting
raw compute to training customers.

---

## 4. Offsetting econ's ~27% trough — four levers (ranked)

```
Priority   Lever                              Class
────────   ────────────────────────────────   ─────────────────────────────
  1        Don't own the idle                 avoid owning the trough
  2        Follow-the-sun (serve other TZs)   fill trough with REVENUE
  3        Overnight batch + training          fill trough with OWN work + moat
  4        Rent out to Vast.ai/spot            sell the trough (backstop)
```

**1 — Don't own the idle (cleanest).** Own the *baseline*, burst-rent the daytime *peak*; pool the
three tiers (executor/engineer/oracle) on a shared, continuously-batched fleet (Aegaeon). Attacks the
27% at the root.

**2 — Follow-the-sun geographic serving (best *revenue* fill).** Serve regions whose peak = India's
trough (18:00→09:00 IST). Google's follow-the-sun proved **+37% effective capacity**.

```
 Region (9–6 local)     in IST            fills India's…
 ───────────────────    ───────────────   ─────────────────────
 Europe   (UTC+0/+1)    13:30–22:30 IST   early-evening trough
 LATAM    (UTC−3)       17:30–02:30 IST   evening + night
 US       (UTC−5/−8)    19:30–07:30 IST   deep night  ← best
 Australia(UTC+10/+12)  04:30–13:30 IST   dawn + morning
```

Latency is a non-issue for an *agent* (multi-second turns, ~1 s TTFT budget): India↔EU ~130 ms,
↔AU ~150 ms, ↔SG ~30–60 ms, ↔US ~200–250 ms. **The prize is the FX spread** — serving strong-currency
devs from India-cost infra is high-margin revenue that *also* fills the trough. (Only keystroke
autocomplete, needing <100 ms, would suffer.)

**3 — Overnight batch as a product + the training flywheel (best *moat* fill).** Batch coding is
~10× cheaper/token than interactive. Ship a **"submit a job, get a PR by 9 a.m."** tier (refactors,
migrations, codemods, test/doc-gen, security sweeps); run **your own fine-tuning + synthetic-data +
evals** overnight (see [MODEL_RESEARCH.md §4](./MODEL_RESEARCH.md)) → idle becomes a **proprietary
model moat**. Online-offline colocation (Valve-style) preempts batch within bounded latency so
daytime SLA is safe. *Avoid* games/rendering — different stack/customer, dilutive.

**4 — Rent out to a marketplace (backstop only).** Vast.ai/Aethir: H100 host earns **$1.45–3.50/GPU-hr**
($25–40k/mo per 8-GPU node at 95%+ util). But you're a **price-taker at the market bottom** and troughs
are **correlated** (everyone idle together). Recovers ~30–50% of idle cost — a floor, not a strategy;
your own batch is higher-value for the same hours.

---

## 5. The sovereign hosting playbook (Nebius, Crusoe)

Sovereign operators win on **cheap power + owned hardware design + anchor tenants**, not patriotism:

- **Nebius:** GPUaaS core (H200 $3.50, H100 $2.95, **L40S $1.55**/hr); needs **~80% utilization** to be
  viable; sites in **Finland** for $0.05–0.07/kWh power + ambient cooling; **designs own racks** to cut
  middlemen.
- **Crusoe:** built on **stranded/renewable energy** — power is the differentiator.
- **Sovereign premium:** in-region data + keeping GPU capex off the customer's balance sheet lifts
  revenue/GPU-hr above the price-war floor.

> **econ takeaway:** if econ ever owns, copy this — **cheap power + reserved anchor tenant (bank/GCC
> that guarantees a utilization floor) + own-rack**, not speculative GPU buying.

---

## 6. Sovereignty & rented compute — the CLOUD Act rules

**Sovereignty is two independent axes**, not "rent vs own":
1. **GPU physical location** → data **residency** (DPDP/RBI).
2. **Operator legal nationality** → **CLOUD Act** reach.

**The CLOUD Act rule:** jurisdiction attaches to the **entity, not the data**. US law can compel any
**US-controlled provider** for data in *any* datacenter (foreign included); a provider operating
*exclusively* outside the US is not reachable. **econ being Indian is no shield** — the warrant hits
the *provider*, not the data-owner. Two triggers, either one exposes you:

| Trigger | Reachable? |
|---|---|
| US-jurisdiction provider (even if GPU is in the EU) | ✅ yes |
| GPU physically in the US (even if provider is foreign) | ✅ yes (territorial) |
| Non-US provider **and** non-US (India) hardware | ❌ no |

**Vast.ai / DePIN fail sovereignty on three counts:** US-incorporated (CLOUD-Act control plane) +
P2P unknown-location hosts (fails residency) + multi-tenant physical-host access. **The "India region"
trap:** AWS/Azure/GCP Mumbai gives residency but **not** CLOUD-Act immunity (US parent compellable) —
*India location + US operator ≠ sovereign*.

**The resolution — classify by data sensitivity (bake into the router):**

```
NON-customer-data  (own training, synthetic-data, evals, benchmarking)
  → rent CHEAP out-of-region (US/EU spot/marketplace). CLOUD Act IRRELEVANT — no
    protected data. Ideal home for the training flywheel: cheaper, no India-timezone
    contention, latency-insensitive.

CUSTOMER-data (sovereign) inference
  → India-located + India-jurisdiction operator (Yotta/E2E/CtrlS/Tata/Jio/IndiaAI),
    or customer-VPC. NEVER Vast/DePIN/US-region. Regulated buyers → India-only, full stop.
```

This captures the out-of-region price/availability arbitrage **without** putting sovereign data under
US jurisdiction.

### 6.1 The Indian-law derivation — residency ≠ confidentiality (our reasoning)

A refinement that changes the sovereignty capital story: **encryption defeats *reading*; it does not
satisfy a *location* mandate.** And Indian law is **more permissive on location than assumed** — so a
TEE out-of-region is legal for the general market, and India-soil is required only for a regulated
subset. The derivation:

| Regime | What it requires | TEE out-of-region OK? |
|---|---|---|
| **DPDP Act** (general personal data) | **Negative-list** cross-border model — transfer *allowed* unless the government blacklists a country. **Not** a blanket localization law (unlike GDPR). | ✅ **Yes** — cross-border is permitted; TEE adds confidentiality on top |
| **RBI payment-data localization** | Payment data must be stored **only in India** (hard mandate) | ❌ **No** — a *location* rule; encryption doesn't satisfy it |
| **Sector rules** (parts of gov / health / telecom) | Some carry in-country storage/processing | ❌ Usually no |
| **Regulated-buyer contracts** (banks, GCCs) | Often *contractually* require in-country + auditor "where does the byte sit?" | ❌ No — procurement/audit blocker, not a legal one |

**What TEE does and doesn't buy** (the two axes, restated): a verified GPU TEE gives
**confidentiality** — even a US-jurisdiction host holds only ciphertext, so a CLOUD-Act warrant yields
nothing readable (keys live only inside the attested enclave). It does **not** give **residency** — the
bytes still physically sit on a US/EU server. TEE solves the *access* problem, not the *location* rule.

**The resulting two-tier design:**

```
DEFAULT tier  (individual devs, startups, most enterprises)
  → OUT-OF-REGION verified GPU TEE (Phala/Tinfoil): legal under DPDP's negative-list,
    confidentiality-proven, cheaper, NO India GPU buildout. This is the bulk of the market.

REGULATED tier  (banks, GCCs, RBI-payment, gov / hard-localization + audit)
  → India-located hosting REQUIRED — a TEE anywhere does NOT override a localization
    mandate or an auditor's physical-location demand. Premium tier, prices for it.
```

**Why this matters for capital:** it means econ does **not** need India infrastructure for *everyone* —
only for the regulated slice that pays a premium for it. TEE-anywhere covers confidentiality + the
DPDP-general market; India-soil is reserved for hard-localization customers. This shrinks the
sovereignty buildout from "host India for all" to "host India for the regulated tier only."

> **⚠️ Not legal advice.** The DPDP-negative-list vs RBI-localization distinction is the general legal
> *shape* as we understand it; confirm with Indian data-protection counsel for exact customer segments
> and data categories before betting GTM on it.

---

## 7. Confidential Computing (TEE) GPUs — how rentable, really

CC (H100 TEE) encrypts model+data in a GPU enclave (AES-256-GCM, encrypted bounce buffers, signed
kernels) so **even the host can't read it**, at **<5–7% overhead** (~0 for large models). Against the
CLOUD Act it helps: if econ holds the keys (remote attestation) and the provider holds only ciphertext,
they **cannot produce readable data**. **But rentability splits sharply:**

**The full provider landscape (~6 credible, a thin slice — GPU CC only GA'd in 2024).** Two camps:
hyperscaler-managed and specialist. AWS is notably absent.

| Provider | Camp | TEE GPUs | Access model | Note |
|---|---|---|---|---|
| **Azure** NCC H100 v5 | hyperscaler | ✅ H100 NVL (GA) | 🟢 push-button SKU | AMD SEV-SNP + attestation service; **East US2 + West Europe only — not India** |
| **GCP** (A3 / G4) | hyperscaler | ⚠️ H100 preview; Blackwell G4 | 🟡 manual CC-mode enable | Intel TDX; limited regions |
| **AWS** | hyperscaler | ❌ **none** | — | P5 H100 but Nitro Enclaves are **CPU-only** — no GPU TEE |
| **Phala Cloud** | specialist | ✅ H100/H200/B300 | 🟢 turnkey, on-demand + 24h trial | dual attestation built-in; multi-GPU (`h200.16xlarge`) |
| **Tinfoil** | specialist | ✅ Hopper + Blackwell | 🟢 on-demand | claims **only multi-GPU CC**; Red Hat collaborating; private-inference focus |
| **Super Protocol** | specialist | ✅ NVIDIA + CPU TEE | 🟡 decentralized | GPU+CPU TEE compatibility framework |
| **Spheron** | specialist | ⚠️ H100/H200/B200 | 🔴 reserved-only (BIOS-level) | highest-VRAM H200 (141 GB); not on-demand |
| **Vast.ai / RunPod** | marketplace | ⚠️/❌ | 🔴 host/BIOS-level, not a click | marketplace CC ≈ unavailable on-demand |
| _Fluence, Marlin_ | decentralized | ❓ unproven | — | mentioned but no confirmed GPU-CC specifics; Nillion is MPC, not TEE |

**econ shortlist:** **Phala + Tinfoil** (specialist, on-demand, attestation-native, multi-GPU) for
redundancy, plus **Azure** if a hyperscaler SLA is wanted (US/EU + premium). **None is India-located** —
every credible GPU-TEE provider is US/EU/global, which is exactly why TEE covers confidentiality but not
the India-residency tier (§6.1).

**Why marketplaces make it hard:** CC is a **host/BIOS/VBIOS-level** setup (persistent enable → GPU
reset → memory scrub → firewall), needs a **matched CPU TEE** (AMD SEV-SNP / Intel TDX) + CC hypervisor,
and **attestation engineering** (nvtrust). **Newer GPUs lag** — H200 attestation was incomplete on raw
marketplaces, multi-GPU CC is the frontier (Phala/Tinfoil claim it); **H100 is the most mature choice**.

> **Takeaway (three-way split).** (1) **Non-customer-data** (training/synth-data/evals) → cheapest plain
> rental, no CC needed. (2) **Default customer tier** (confidentiality, non-regulated) → **on-demand
> verified TEE genuinely exists** via specialists (**Phala/Tinfoil**, ~$3.50/hr 1×H200) — premium over
> raw spot but workable, and legal out-of-region under DPDP (§6.1). (3) **Regulated tier** → **India-soil
> required**; no TEE substitutes for a localization mandate, and no credible GPU-TEE provider is
> India-located today. So CC *does* rescue out-of-region for the default tier — just not on the *cheapest*
> marketplace GPUs, and not for the regulated tier.

---

## 8. Synthesis — the sequence for econ

1. **Rent now** (hosted per-token). At ~27% util, owning loses to depreciation.
2. **Pool the three tiers + continuous batching** — the 30%→70% move.
3. **Aggregate uncorrelated demand** to raise the floor: follow-the-sun (US/LATAM/EU/AU, high-margin
   FX) + overnight batch product + multi-tenant B2B inference.
4. **Route cheap out-of-region rental to non-customer-data work** (training/synth-data/evals) — no CC
   needed, CLOUD Act irrelevant.
5. **Keep customer inference on India-jurisdiction + India-soil** (or Azure/Phala CC for non-regulated).
6. **Only then own**, and only for near-100%/18-month tiers, copying the sovereign playbook (cheap
   power + anchor tenant + own-rack).
7. **Marketplace rent-out (Vast/Aethir) is the last-resort backstop** for whatever batch doesn't consume.

---

## 9. Sources

Utilization / neoclouds: [CoreWeave flexible pricing (DCK)](https://www.datacenterknowledge.com/cloud/coreweave-s-flexible-pricing-bet-signals-strategic-shift),
[AI Neocloud Playbook (SemiAnalysis)](https://semianalysis.com/2024/10/03/ai-neocloud-playbook-and-anatomy/),
[Nebius sovereign model (Interconnected)](https://interconnected.blog/europes-hidden-sovereign-ai-gem-nebius/),
[inference unit economics (Introl)](https://introl.com/blog/inference-unit-economics-true-cost-per-million-tokens-guide),
[Fireworks economics (Sacra)](https://sacra.com/c/fireworks-ai/),
[Aegaeon GPU pooling (SOSP'25)](https://ennanzhai.github.io/pub/sosp25-aegaeon.pdf),
[follow-the-sun scheduling (Introl)](https://introl.com/blog/ai-workload-scheduling-gpu-utilization-time-zones).

Buy vs rent: [buy-vs-rent decision guide (DigitalApplied)](https://www.digitalapplied.com/blog/gpu-buy-vs-rent-vs-cloud-ai-inference-2026-decision-guide),
[H100 cost + break-even (CloudZero)](https://www.cloudzero.com/blog/h100-gpu-cost/),
[batch inference 10× cheaper (Spheron)](https://www.spheron.network/blog/batch-llm-inference-gpu-cloud/),
[idle GPU monetization / Aethir](https://ecosystem.aethir.com/blog-posts/monetize-idle-gpus-in-2025-7-proven-strategies-for-cloud-hosts).

Sovereignty / CLOUD Act: [CLOUD Act FAQ (Cross-Border Data Forum)](https://www.crossborderdataforum.org/cloudactfaqs/),
[CLOUD Act CRS R45173 (Congress.gov)](https://www.congress.gov/crs-product/R45173),
[Vast.ai security/jurisdiction](https://docs.vast.ai/guides/reference/faq/security).

Confidential Computing: [Azure confidential VM + H100 GA (NVIDIA)](https://blogs.nvidia.com/blog/azure-confidential-vm-h100-general-availability/),
[Azure NCC H100 v5 regions (MS)](https://techcommunity.microsoft.com/blog/azureconfidentialcomputingblog/general-availability-azure-confidential-vms-with-nvidia-h100-tensor-core-gpus/4242644),
[Phala GPU-TEE cloud](https://phala.com/gpu-tee),
[Spheron CC reserved-only](https://www.spheron.network/blog/confidential-gpu-computing-nvidia-tee-encrypted-vram/),
[H200 attestation gaps (NVIDIA forums)](https://forums.developer.nvidia.com/t/h200-confidential-compute-fully-supported/325755),
[H100 Confidential Computing (NVIDIA dev blog)](https://developer.nvidia.com/blog/confidential-computing-on-h100-gpus-for-secure-and-trustworthy-ai/).
