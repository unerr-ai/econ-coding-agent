# econ — Confidential Computing (TEE GPU) Market Research

**Status:** Drafted 2026-07-01; §7 build thesis added 2026-07-02. Validated market research on
GPU-based Trusted Execution Environments (confidential computing / CC): why they exist, whether the
frontier labs offer them, the demand-vs-supply picture, which sectors are most starved, and a
discovered **build thesis** — a sovereign CC-GPU marketplace for India (§7). This is a *market/context* doc;
the *legal derivation + provider shortlist* for econ lives in
[GPU_UTILIZATION_ECONOMICS.md](./GPU_UTILIZATION_ECONOMICS.md) (§6.1, §7), the *model facts* in
[MODEL_RESEARCH.md](./MODEL_RESEARCH.md).

> Market-size figures below are **third-party analyst estimates** and disagree widely (a sign of an
> immature market) — treat the CAGR direction as the signal, not any single dollar figure.

---

## 1. Why anyone needs a TEE GPU — the "data-in-use" gap

Standard security encrypts data **at rest** (disk) and **in transit** (network). During
**processing**, data sits as **plaintext in GPU/CPU memory**, where the cloud operator, host, or
model vendor could in principle read it. A GPU TEE closes that last gap: it encrypts data **in use**
inside a hardware enclave and lets the client **cryptographically attest** the environment before
sending secrets. Two distinct assets get protected:

- **The user's data** — prompts, code, records: private from host / vendor / subpoena.
- **The model owner's weights** — IP protection so the host can't exfiltrate the model.

The defining property: **you don't trust the operator, you verify the silicon.** That is what
separates CC from a contractual "we promise not to look."

---

## 2. Do the frontier labs offer this? — two levels: contractual vs hardware

There is a crucial distinction between **contractual privacy** (today's default for most customers)
and **hardware CC** (the emerging frontier).

| Provider | What they offer today |
|---|---|
| **Anthropic** | **Actively building hardware CC** — published *"Confidential Inference via Trusted VMs"* + a whitepaper with Pattern Labs (June 2025) extending TEE to **prompt privacy + output non-disclosure + weight protection**. Contractual layer: Enterprise/API no-training-by-default, DPAs. |
| **Apple (PCC)** | **The at-scale gold standard** — Private Cloud Compute is verifiable private AI in production, now extending to **Google Cloud + NVIDIA CC**, with external-auditor transparency. |
| **Google Cloud** | "Powering the next era of Confidential AI" — offers confidential GPUs **and hosts Apple PCC**. |
| **OpenAI** | Mostly **contractual** (Zero Data Retention, DPAs, enterprise no-training) + runs on **Azure confidential** infra; less publicly TEE-forward than Anthropic/Apple. |
| **Meta** | Adopted NVIDIA CC for user privacy. |

**So "don't Claude/OpenAI already have these?":** for *most* customers the labs sell **contractual
privacy** (ZDR, DPA, no-training) — **not** hardware TEE. Hardware CC is the **next tier up**, and
it is **emerging, selective, not the universal default yet**. Anthropic / Apple / Google are clearly
moving there; NVIDIA's stated goal is CC "without code changes." **Are they planning to offer CC to
everyone? The trajectory says yes — but today it serves the highest-assurance needs, not every API
call.**

---

## 3. Market size — large, fast, and immature

| Firm | 2025–26 size | Forecast | CAGR |
|---|---|---|---|
| Mordor Intelligence | $9.3B (2025) → $15.2B (2026) | $173B by 2031 | **62.7%** |
| Grand View Research | $18.1B (2026) | $154B by 2030 | 61.1% |
| MarketsandMarkets | — | $59.4B by 2028 | 62.1% |
| Fortune Business Insights | $42.7B (2026) | $464B by 2034 | 34.7% |

The **spread itself is the signal** — the base is disputed because the market is young — but every
firm agrees on ~**35–63% CAGR**. **TEEs ≈ 50% of the confidential-computing market**, and **~50% of
organisations running AI/ML on sensitive data are expected to adopt CC.** Drivers: rising cyberattack
sophistication, **sovereign-cloud mandates**, and falling runtime overhead (<7%).

---

## 4. Demand vs supply — the four shortcomings

Demand is regulatory-driven and compounding; **supply is gated by four gaps**:

1. **Multi-GPU CC is *disabled* on Hopper (the #1 shortcoming).** Per NVIDIA's own docs, GPU-CC on
   H100/H200 works **single-GPU only** in the current Hopper release. Large/frontier models needing
   8-GPU tensor-parallel **cannot run in CC mode on Hopper.** **Trusted I/O (multi-GPU CC) is a
   Blackwell feature** (native NVLink + PCIe 5.0 encryption). So *frontier-scale* confidential
   inference only arrives with Blackwell.
2. **CC GPUs are a scarce subset of already-scarce silicon.** Confidential H100/H200/Blackwell sit on
   top of general GPU scarcity; the multi-GPU-capable Blackwell parts are the newest and tightest.
3. **Thin provider field + region lock.** ~6 credible GPU-TEE providers (Azure, GCP, Phala, Tinfoil,
   Super Protocol, Spheron); **AWS has none**; essentially **none are India-located** — a direct
   supply hole for sovereignty markets.
4. **Attestation-tooling immaturity** on the newer parts (H200 / Blackwell) — real engineering, not
   push-button, outside the specialist providers.

**Net:** demand (regulated AI) is real and growing ~35–63%/yr; supply of **frontier-scale,
multi-GPU, verifiable confidential inference** is **only now becoming possible (Blackwell)** and
**geographically concentrated (US/EU)**. That mismatch *is* the market gap.

---

## 5. Which sector suffers most from the lack

The **regulated triad** is where AI adoption is actively **blocked** — data privacy / IP has become
a critical bottleneck, not a nice-to-have.

| Sector | Sensitive data | Why it's starved |
|---|---|---|
| **Healthcare** 🩺 | PHI, genomic, clinical-trial (HIPAA) | **Biggest *blocked value*** — enormous AI upside dammed behind privacy law; can't send patient data to cloud LLMs. Most-cited stalled sector. |
| **Government / Defense** 🛡️ | Classified, CUI, ITAR | **Hardest *requirement*** — cannot use commercial cloud AI at classification levels without cryptographic guarantees. Most absolutely blocked. |
| **Financial services** 💳 | MNPI, PII, payment data | **Biggest *immediate spend*** — wants LLMs on material non-public info but compliance-gated. |
| **Legal / Pharma** ⚖️ | Privilege, embargoed trial data | Niche but high-value, fully blocked. |
| **Sovereign / public sector (EU, India)** 🌏 | Citizen data under residency law | Blocked by localization mandates *plus* confidentiality demand. |

**Single "suffering most":** a tie by different measures — **healthcare** has the largest pool of
*unrealized* AI value behind privacy law; **government/defense** has the *strictest* requirement
(can't touch cloud AI at all without CC). Combined with shortcoming #1 (no multi-GPU CC on Hopper),
the most-starved sub-segment is **any regulated buyer that needs a *frontier-scale* model
confidentially** — they've been waiting on Blackwell multi-GPU CC, which is only now shipping and
scarce.

---

## 6. The gap — and what it means for econ

- **Structural opportunity:** a ~35–63%-CAGR market whose bottleneck is **supply of verifiable,
  frontier-scale, *in-region* confidential inference** — acute anywhere that is **not US/EU** (no
  India-located GPU-TEE provider exists).
- **econ's angle:** don't build TEE silicon — be the **harness + routing layer** that delivers
  confidential inference to Indian regulated buyers (healthcare, BFSI, GCC, gov) by combining
  **India-located hosting** (residency, per [GPU_UTILIZATION_ECONOMICS.md §6.1](./GPU_UTILIZATION_ECONOMICS.md))
  **+ CC** (confidentiality). That two-axis intersection is exactly where the underserved Indian
  regulated market sits and where no current provider is present.
- **Timing caveat:** *large*-model confidential inference needs **Blackwell multi-GPU CC**, so those
  workloads are gated on Blackwell availability; *single-GPU / small-model* confidential inference
  works on Hopper today.

**Bottom line.** TEE GPUs exist because regulated sectors are *legally blocked* from cloud AI without
them; the frontier labs offer mostly *contractual* privacy today with *hardware* CC emerging
(Anthropic / Apple / Google leading); the market grows ~35–63%/yr but supply is gated by
no-multi-GPU-CC-on-Hopper, silicon scarcity, a thin ~6-provider field, and **zero India presence**;
and the sectors suffering most — **healthcare, defense/government, finance** — are precisely the
buyers econ's India-hosted-plus-CC combination could unlock.

> Not legal advice; regulatory and product facts current to the 2026-07-01 research pass and change
> as NVIDIA Blackwell CC and provider coverage mature.

---

## 7. Build thesis — a sovereign CC-GPU marketplace ("Phala for India")

A **separate business proposition** discovered from this research: use confidential computing to
attack the GPU **under-utilization crisis** — operators can't freely backfill idle GPU hours with
strangers' workloads because of confidentiality, and CC removes exactly that barrier. Pool idle
capacity across regions and owners, sell the spare hours, and let the buyer **attest the silicon**
instead of trusting the operator. India serves Indian workloads in IST business hours; its idle
IST-night hours sell to US/EU daytime demand, and vice-versa — **follow-the-sun smoothing** that
directly lifts the ~27% effective-utilization floor (see
[GPU_UTILIZATION_ECONOMICS.md](./GPU_UTILIZATION_ECONOMICS.md) §0–§4).

**This is validated, not novel:** the category already exists — Phala calls it *dAGI* (decentralized
confidential AI); **Phala** (pay-as-you-go Hopper TEEs by the hour, deploy-anywhere, on-chain
attestation) and **Tinfoil** (managed, OpenAI-compatible API) are this idea shipping today, alongside
Super Protocol and Spheron. So the move is to **enter as a regional/sovereign instance, not to invent
the substrate.**

### 7.1 What's right about it
CC genuinely dissolves the trust barrier behind idle-GPU backfill; idle GPU is the margin-killer, and
confidentiality is the exact reason operators can't rent idle hours to strangers. CC makes the
backfill *sellable*. The cross-region, cross-owner pooling the thesis describes is real and already
productized.

### 7.2 Four constraints that reshape the plan
1. **Residency ≠ confidentiality (critical).** CC neutralizes the *CLOUD-Act / who-can-read-it*
   axis, unlocking cross-region pooling for **confidentiality-constrained** workloads (most
   enterprise). It does **not** relocate **residency-constrained** data — RBI payment data, GDPR-
   localized EU data must stay on-soil regardless of encryption. Cross-region "expose spare capacity"
   works for the **default lane**, never the **regulated lane** (the two-lane split of §6.1 in
   [GPU_UTILIZATION_ECONOMICS.md](./GPU_UTILIZATION_ECONOMICS.md)).
2. **Regional entrant, not category creator.** Phala/Tinfoil/Super Protocol/Spheron already build the
   attestation + TEE-orchestration substrate. **Don't rebuild it** — Phala explicitly deploys "to any
   location," so *India nodes on an existing substrate* is config, not a new protocol.
3. **The wedge is sovereignty + subsidized supply.** India-jurisdiction operator + India-soil GPUs +
   DPDP/RBI compliance + **IndiaAI's subsidized pool** (~34k GPUs at ₹65–150/GPU-hr vs ₹210–335 for
   AWS/GCP/Azure, targeting 100k+ public by Dec 2026) — a combination **no global CC marketplace has**
   (none are India-located).
4. **Hardware gating + power ceiling.** Single-GPU confidential inference works on India's Hopper
   (H100/H200) pool now; multi-GPU/frontier confidential serving waits for **Blackwell TEE-I/O**
   density (see §4). India's real supply ceiling is **power** (100k H100 ≈ 300 MW; grid, not GPUs, is
   the bottleneck) — which *strengthens* a utilization-maximizing marketplace thesis.

### 7.3 Adjacent layer, not a rival — the governance stack
Companies like **Dynamo AI** (and peers WitnessAI, Lakera, Vijil, Credo, Prove AI, OneTrust, Apheris)
are **AI governance / guardrails / compliance software** — a layer **above** the hardware. CC protects
data *in the box*; governance tools police *what the model does with it* (leakage, policy, audit).
Complementary, not competitive: a regulated Indian buyer wants **both**, so this marketplace could
bundle or partner rather than compete.

### 7.4 Scope flag
This is an **infrastructure/marketplace business**, distinct from econ-the-coding-agent. Two framings:
(a) a **substrate econ consumes** — econ runs its own confidential inference on it for regulated
Indian buyers; or (b) a **standalone product** competing with Phala/Nebius/hyperscalers on infra,
away from econ's harness/routing edge. Decide deliberately before investing.

**Honest one-line version:** *a sovereign, compliant CC-inference layer for India, built on an
existing TEE substrate, monetizing IndiaAI's idle subsidized pool via follow-the-sun backfill —
confidentiality lane cross-region, residency lane on-soil, single-GPU now / multi-GPU as Blackwell
lands.*

---

## 8. Sources

- Market size: [Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/confidential-computing-market),
  [Grand View Research](https://www.grandviewresearch.com/industry-analysis/confidential-computing-market-report),
  MarketsandMarkets & Fortune Business Insights confidential-computing reports.
- Frontier-lab CC: [Anthropic — Confidential Inference via Trusted VMs](https://www.anthropic.com/research/confidential-inference-trusted-vms),
  [Apple — Private Cloud Compute](https://security.apple.com/blog/private-cloud-compute/),
  [Apple PCC → Google Cloud + NVIDIA CC](https://blogs.nvidia.com/blog/nvidia-confidential-computing-apple-private-cloud-compute/),
  [Google Cloud — the next era of Confidential AI](https://cloud.google.com/blog/products/identity-security/powering-the-next-era-of-confidential-ai).
- NVIDIA hardware / roadmap: [Secure AI with Blackwell and Hopper GPUs (whitepaper)](https://docs.nvidia.com/nvidia-secure-ai-with-blackwell-and-hopper-gpus-whitepaper.pdf),
  [GPU CC demystified (arxiv 2507.02770)](https://arxiv.org/html/2507.02770v1),
  [NVIDIA Confidential Computing (Rubin/Blackwell/Hopper)](https://www.nvidia.com/en-us/data-center/solutions/confidential-computing/),
  [Corvex — CC on NVIDIA HGX B200 (TEE-I/O, multi-GPU)](https://www.corvex.ai/blog/confidential-computing-meets-nvidia-hgxtm-b200-secure-ai-without-the-performance-trade-off),
  [Confidential computing for AI by industry (NVIDIA)](https://developer.nvidia.com/blog/protecting-sensitive-data-and-ai-models-with-confidential-computing/).
- CC techniques (silicon vs crypto): [Opaque — enclaves vs HE/MPC](https://www.opaque.co/resources/articles/secure-computation-homomorphic-encryption-or-hardware-enclaves),
  [CSA — FHE vs confidential computing](https://cloudsecurityalliance.org/blog/2024/08/22/understanding-the-differences-between-fully-homomorphic-encryption-and-confidential-computing).
- Build thesis (§7): [Phala — Beyond SGX: GPU TEE for dAGI](https://phala.com/posts/beyond-sgx-embracing-gpu-tee-for-decentralized-ai-dagi),
  [Phala vs Tinfoil](https://phala.com/compare/phala-vs-tinfoil),
  [Dynamo AI (YC)](https://www.ycombinator.com/companies/dynamo-ai),
  [IndiaAI compute capacity](https://indiaai.gov.in/hub/indiaai-compute-capacity),
  [IndiaAI 34k GPUs at ₹65–150/hr](https://www.abhs.in/blog/indiaai-mission-34000-gpus-cheap-compute-developers-2026).
