# econ vs. vanilla Claude Code — the SWE mini-10 cost/resource comparison

**What this is.** A head-to-head on the same 10 SWE-bench (Django) instances — our
**econ** agent (open-model tier team + unerr graph + governance) against **vanilla
Claude Code** driving Anthropic's own models (Haiku 4.5, Sonnet, Opus). Two axes:
**what each solves** (real-graded against the hidden F2P∪P2P) and **what each burns
to get there** (tokens in/out, cache hits, cost, turns).

> One home per fact: the *why-it-failed* forensics for individual instances live in
> [HARNESS_AND_VARIANCE_REPORT.md](./HARNESS_AND_VARIANCE_REPORT.md) and
> [STRICT_CYCLE.md](./STRICT_CYCLE.md); this doc owns only the cross-model
> cost/resource comparison.

---

## TL;DR

All four runs are **real-graded** under identical strict conditions (base commit,
strip-the-future, no gold plant during solving, hidden F2P∪P2P after).

| Agent | Model(s) | Solved | Total cost | Turns | $/solve |
|---|---|:--:|---:|---:|---:|
| **econ** | open tiers (minimax conductor + worker/junior) | **9 solid + 11815 @ 2/3** | **~$2.35–2.47** | 492–511 | **~$0.25** |
| Claude Code | Opus (+Haiku sub-work) | **10 / 10** | $9.0320 | 225 | ~$0.90 |
| Claude Code | Sonnet | **9 / 10** | $5.8097 | 211 | ~$0.65 |
| Claude Code | Haiku 4.5 | **5 / 10** | $3.8235 | 433 | ~$0.76 |

**The three findings that matter:**

1. **econ reaches near-Opus quality at ~¼ the cost.** Opus is the only clean 10/10,
   at **$9.03 — 3.8× econ's spend**. econ lands 9 solid (10 on a good 11815 draw) for
   ~$2.35. Sonnet costs 2.5× econ and still loses an instance.

2. **"Cheap model" is a trap in an agentic loop.** Haiku is the *cheapest per token*
   and the **second-most expensive per solved instance** ($0.76 vs Sonnet's $0.65) —
   it thrashes: **433 turns and 21.67M cache-read tokens**, 2× Sonnet's token volume
   for half the solves. Price-per-token is not cost; **tokens × turns** is. This is
   the single best argument against "just route everything to a cheap model," and it
   is exactly what econ's routing must beat rather than imitate.

3. **econ's cost win is cheaper tiers, not fewer tokens.** Contrary to our prior:
   econ runs **more** turns than Sonnet/Opus (492 vs ~210), not fewer. What the graph
   harness buys is a **leaner per-turn context** (~25k cache-read/turn vs Sonnet's
   ~40k, Haiku's ~50k), which keeps token growth in check *despite* the extra turns —
   and the open tiers then price those tokens ~5–10× lower. The savings identity
   `f × (1 − 1/r)` is being carried mostly by `r`, not `f`.

### Per-instance verdicts (all four, real-graded)

| Instance | econ | Haiku | Sonnet | Opus | Notes |
|---|:--:|:--:|:--:|:--:|---|
| 11790 | ✅ | ✅ | ✅ | ✅ | |
| 11815 | ⚠️ 2/3 | ❌ | ❌ | ✅ | **oracle inversion** — only Opus cleared it (n=1) |
| 11848 | ✅ | ❌ | ✅ | ✅ | `.now()`/`utcnow()` convention variance |
| 11880 | ✅ | ✅ | ✅ | ✅ | |
| 11885 | ✅ | ❌ | ✅ | ✅ | ambiguous optimization-proposal issue |
| 11951 | ✅ | ✅ | ✅ | ✅ | |
| 11964 | ✅ | ❌ | ✅ | ✅ | spec-gap / root-most-layer choice |
| 11999 | ✅ | ✅ | ✅ | ✅ § | Opus hit the 900s wall; partial patch still passed |
| 12039 | ✅ | ❌ | ✅ | ✅ | |
| 12050 | ✅ | ✅ | ✅ | ✅ | |
| **Solved** | **9 + ⚠️** | **5** | **9** | **10** | |

Haiku's 5 losses are spread across the genuinely-hard classes; Sonnet's single loss
and econ's single flaky instance are **the same one** (11815).

---

## Method — strict, identical conditions

Both agents worked from the same base commit per instance, under the same
strip-the-future discipline. Nothing was leaked and nothing was hand-graded green.

- **Strict arena.** Each instance reset to its `base_commit`; working tree clean.
  **Strip-the-future:** every git ref except detached `HEAD@base` deleted + reflog
  expired, so `git log --all` / `git show` cannot reveal the gold fix. No gold
  `test_patch` planted during solving.
- **Vanilla Claude invocation (source of truth:** `unerr-benchmarks
  e2e/reference/claude/.../run-instance.sh`, **OFF arm** — no unerr operator policy,
  no MCP). Both non-interactivity layers present so the run is *truly* autonomous:
  ```
  timeout -k 20 900s claude -p "$PROMPT" \
    --model <haiku|sonnet|opus> \
    --append-system-prompt "$AUTONOMY_PROMPT" \   # behavioral: never ask/plan, edit directly
    --output-format json \
    --dangerously-skip-permissions \              # mechanical: no permission stalls
    --strict-mcp-config                           # zero MCP servers → clean baseline
  ```
  `AUTONOMY_PROMPT` = the base directive *"You are operating fully autonomously in an
  automated benchmark… Never ask questions, present options, seek confirmation, or
  enter plan mode — pick the most reasonable interpretation, implement it, and then
  stop."* (Layer 1 `--dangerously-skip-permissions` kills permission interactivity;
  Layer 2 the system-prompt kills conversational interactivity. Both are required —
  without Layer 2, headless Claude will stop and ask a clarifying question on an
  ambiguous issue, then exit with an empty diff.)
- **Parallelism.** The three models ran **concurrently** on disjoint arena trees
  (`arena-*` / `arena-sonnet-*` / `arena-opus-*`; hardlinked git clones + per-tree
  venvs) — cutting wall-clock ~3×.
- **Real-graded, every model.** `grade-any.sh` = `grade.sh` generalized to the
  per-model arena trees: **normalize → revert tests to gold → apply gold `test_patch`
  → run F2P∪P2P at module level**. The normalize step (`git reset --mixed $BASE`) is
  mandatory and easy to miss: the sweep driver never folds the agent's commits, and
  `git checkout HEAD -- tests/` against a moved HEAD would restore *the agent's own
  committed test edits* — a false green. Edit-stats were captured **before** grading
  (the gold `test_patch` lands in the working tree and would otherwise pollute them).
- **Metrics source.** Claude: the `claude -p --output-format json` envelope
  (`total_cost_usd`, `num_turns`, `modelUsage[*].{input,output,cacheRead,cacheCreation}`).
  econ: the per-run **econ receipt** (`in / out / think / cache r / cache hit% /
  spent / turns`).

**Caveats — read these before quoting any number.**
1. **n=1 per cell.** Each (model, instance) is a single run. econ's own 11815 went
   ✅✅❌ across three runs, so per-instance verdicts carry real variance; treat
   single-run pass/fail as a sample, not a constant. Only econ has repeat draws here.
2. **Prices are provider list at run time**, and econ's open tiers vs Anthropic's
   models sit on different scales. Read cost *with* the token columns.
3. **econ was not strip-the-future'd** (it navigates by the unerr graph, not
   `git log`, so it had no future to peek at); the Claude runs were, putting both
   under the same effective information.
4. **Opus 11999 is a re-run** at an 1800s wall (its first attempt was killed by the
   900s cap before emitting metrics). Same patch, same verdict; only the cost/turns
   come from the re-run.
5. **Wall-clock is not comparable** — three models ran concurrently on one machine
   and contended for CPU. Only cost/tokens/turns are.
6. **econ's 11815 cell is not a like-for-like single draw** — it is the one instance
   with repeat measurement (✅✅❌). Every other cell in this doc is n=1.

### Retired: the 2026-07-03 Opus baseline (do not quote it)

An earlier Opus mini-10 reference —
`unerr-benchmarks/benchmark-results/claude-off-mini10-verified-2026-07-03`, reporting
**$3.12 / 81 turns / 10 solved** — is **not comparable to this sweep and must not be
cited**. Two method gaps, both definitive:

1. **No strip-the-future.** Its runner (`e2e/reference/claude/.../run-instance.sh`) resets
   the arena with `git checkout` + `reset --hard` + `clean` only. Every git ref and the
   reflog survive, so the gold fix remains reachable via `git log --all` / `git show`. The
   sweep in this doc deletes every ref except detached `HEAD@base` and expires the reflog
   (`claude-ref-mini10.sh:18-21`).
2. **Self-reported, not real-graded.** It records "RESOLVED: 10/10 (no verification,
   edit-and-stop)"; no hidden-F2P∪P2P grading was run against it.

**The diagnostic signature.** Turn counts inflate **2.8× overall** under strip-the-future,
but not uniformly — and the non-uniformity is the point:

| Instance | 07-03 (no strip) | 07-15 (strip) | Ratio |
|---|---:|---:|---:|
| 11815 | 4 | 36 | **9.0×** |
| 11880 | 3 | 13 | **4.3×** |
| 11885 (the hard one) | 39 | 35 | **0.9×** |
| **Total** | **81** | **225** | **2.8×** |

Memorizable instances explode; the one instance requiring genuine exploration is
statistically unchanged. History access only buys you anything where history holds the
answer. *Honest limit:* no transcript line showing Opus invoking `git log` was recovered,
so leakage is inferred from the method gap plus this differential — the
**not-comparable** verdict rests on method, which is sufficient on its own.

**Why this matters beyond bookkeeping.** The 07-03 numbers made econ look like it was at
*cost parity* with Opus ($2.47 vs $3.12) despite an ~8× per-token price advantage — an
alarming result that triggered a turn-economy investigation. Against the honest baseline
econ is **~3.8× cheaper**, and the parity alarm was an artifact. The investigation still
paid for itself (it found real internal waste — see
[HARNESS_AND_VARIANCE_REPORT.md](./HARNESS_AND_VARIANCE_REPORT.md) Part VII), but the
premise that provoked it was false. This is the strip-the-future trap from
[STRICT_CYCLE.md](./STRICT_CYCLE.md) biting a *reference* run instead of one of ours.

---

## econ — real-graded, full metrics (9 solid + 11815 flaky)

Open-model tier team (minimax conductor, worker/junior escalation), unerr
graph-targeted context, in-loop governance. Cache hit ~78–93%; `out` tokens tiny
(graph slices, not whole files). Measured from the econ receipts.

| Instance | Pass | Cost | Turns | in | out | cache read | cache hit | total tok |
|---|:--:|---:|---:|---:|---:|---:|---:|---:|
| 11790 | ✅ | $0.0531 | 20 | 48.9k | 2.6k | 504.9k | 91.2% | 560.5k |
| 11815 | ⚠️ 2/3 † | $0.39–0.51 | 66–86 | 325.3k | 18.3k | 2.03M | 86.2% | 2.39M |
| 11848 | ✅ | $0.3383 | 44 | 138.0k | 11.4k | 1.05M | 88.4% | 1.24M |
| 11880 | ✅ | $0.2364 | 59 | 94.5k | 13.8k | 1.29M | 93.2% | 1.41M |
| 11885 | ✅ | $0.2936 | 70 | 217.0k | 22.6k | 2.91M | 93.1% | 3.17M |
| 11951 | ✅ | $0.0560 | 24 | 47.5k | 4.4k | 520.4k | 91.6% | 576.6k |
| 11964 | ✅ | $0.1715 | 41 | 185.0k | 6.5k | 1.31M | 87.7% | 1.53M |
| 11999 | ✅ | $0.6149 | 100 | 261.7k | 22.7k | 2.17M | 89.3% | 2.49M |
| 12039 | ✅ | $0.1735 | 48 | 134.1k | 11.7k | 1.68M | 92.6% | 1.84M |
| 12050 | ✅ | $0.0267 | 19 | 62.0k | 2.1k | 218.4k | 77.9% | 283.7k |
| **Total** | **9 solid + 11815 @ 2/3** | **~$2.35–2.47** | **492–511** | | | | | |

† **11815 is NOT closed — it is 2/3, and the third failure is a different
mechanism.** Post-fix (`1270cbccd`) runs: r1 ✅ $0.39/67t (via witness-breadth → M4
`oracle_inversion`), r2 ✅ $0.48/66t (via the new F18 seen-red partition), **r3 ❌
$0.5116/86t** (this doc's re-measure). In r3 the oracle-inversion seams fired **zero
times** and econ shipped a *bug-preserving* `serializer.py` refactor —
`repr(self.value.value)` inside `%s.%s(%s)`, i.e. still `TextEnum('a-value')` rather
than the name-based `TextEnum['A']` the hidden F2P wants.

**Why the seams missed it:** all three seams key off the agent writing a **general
fix** and then seeing the bug-encoding committed tests go red. In r3 econ never
attempted a general fix, so the inverted visible suite stayed **green**, F18's
confirm-GREEN was satisfied, and the wrong fix shipped unchallenged. The inverted
oracle doesn't just block a right fix — **it actively confirms a wrong one** when the
agent never reaches for the right one. The fix pack covers the *gate-forced-retreat*
path; it does not cover the *never-tried* path. Treat econ's mini-10 as **9/10 solid,
10/10 on a good 11815 draw**.

---

## Vanilla Claude Code — real-graded + full metrics (parallel sweep)

Source-of-truth OFF-arm invocation above; strict; every instance real-graded.
`edit` = the agent's diff vs base, captured **before** grading (includes fixes the
agent committed — `claude -p` often commits, which an uncorrected working-tree diff
reads as "no edit").

### Haiku 4.5

| Instance | Pass | edit (files/±) | Cost | Turns | in | out | cache create | cache read | dur |
|---|:--:|---|---:|---:|---:|---:|---:|---:|---:|
| 11790 | ✅ | 2 files, 16+ | $0.4280 | 30 | 3.1k | 19.7k | 92.5k | 1.85M | 113.5s |
| 11815 | ❌ | 1 file, 2+/3− | $0.3413 | 51 | 1.3k | 11.8k | 30.6k | 2.20M | 194.8s |
| 11848 | ❌ | 2 files, 29+/3− | $0.1963 | 22 | 872 | 8.3k | 31.9k | 901.6k | 97.8s |
| 11880 | ✅ | 2 files, 61+ | $0.2651 | 36 | 1.1k | 7.8k | 37.3k | 1.50M | 177.8s |
| 11885 | ❌ | 2 files, 32+/8− | $0.6515 | 53 | 1.3k | 27.1k | 87.4k | 3.40M | 286.4s |
| 11951 | ✅ | 1 file, 2+/1− | $0.0878 | 11 | 788 | 3.4k | 19.3k | 316.6k | 40.8s |
| 11964 | ❌ | 4 files, 87+/1− | $0.7491 | 85 | 1.9k | 27.6k | 68.2k | 4.73M | 407.9s |
| 11999 | ✅ | 3 files, 100+/11− | $0.5886 | 85 | 1.4k | 17.4k | 49.3k | 4.02M | 308.4s |
| 12039 | ❌ | 1 file, 5+/2− | $0.2173 | 30 | 1.1k | 10.2k | 27.8k | 1.10M | 150.5s |
| 12050 | ✅ | 2 files, 15+/1− | $0.2986 | 30 | 837 | 6.2k | 49.9k | 1.67M | 118.1s |
| **Total** | **5 / 10** | | **$3.8235** | **433** | 13.8k | 139.3k | 494.0k | **21.67M** | |

Failures: 11815 (`failures=2`), 11848 (`errors=7`), 11885 (`failures=2`),
11964 (`failures=15`), 12039 (`failures=1`). 11815 was re-solved from a clean base
(its first arena was consumed by the econ 11815 re-measure); the row above is that
graded re-solve.

### Sonnet

| Instance | Pass | edit (files/±) | Cost | Turns | in | out | cache create | cache read | dur |
|---|:--:|---|---:|---:|---:|---:|---:|---:|---:|
| 11790 | ✅ | 2 files, 5+/1− | $0.4657 | 19 | 701 | 5.5k | 25.4k | 765.5k | 129.6s |
| 11815 | ❌ | 2 files, 32+/28− | $0.7633 | 29 | 992 | 10.2k | 34.7k | 1.34M | 184.2s |
| 11848 | ✅ | 2 files, 25+/3− | $0.5050 | 21 | 736 | 6.9k | 24.6k | 843.6k | 94.1s |
| 11880 | ✅ | 2 files, 13+ | $0.2691 | 10 | 820 | 2.1k | 20.4k | 379.8k | 37.8s |
| 11885 | ✅ | 3 files, 53+/34− | $1.7825 | 47 | 951 | 21.6k | 72.5k | 3.41M | 371.3s |
| 11951 | ✅ | 2 files, 13+/1− | $0.4169 | 18 | 742 | 4.4k | 23.4k | 701.7k | 70.4s |
| 11964 | ✅ | 1 file, 7+/1− | $0.2490 | 11 | 1.2k | 2.1k | 16.2k | 395.4k | 45.1s |
| 11999 | ✅ | 2 files, 16+/2− | $0.5655 | 23 | 739 | 5.9k | 28.5k | 1.02M | 228.5s |
| 12039 | ✅ | 1 file, 9+/3− | $0.3343 | 13 | 894 | 4.1k | 20.5k | 495.1k | 59.6s |
| 12050 | ✅ | 2 files, 16+/1− | $0.4584 | 20 | 635 | 5.1k | 24.0k | 792.0k | 103.3s |
| **Total** | **9 / 10** | | **$5.8097** | **211** | 8.4k | 68.1k | 290.2k | **10.13M** | |

Sonnet's single loss is **11815 — the oracle-inversion instance** (`failures=1`): the
same trap that defeated econ until commit `1270cbccd`. Gold's `test_patch` rewrites
the visible suite so its assertions encode the bug; a general fix reddens them. Left
to its own devices, Sonnet lands on the narrow patch that fails the hidden F2P.

### Opus

Note: `--model opus` runs report `modelUsage` across **two** models —
`claude-opus-4-8` **and** `claude-haiku-4-5`. Claude Code routes some cheap sub-work
to Haiku on its own, so this column is Opus+Haiku blended (summed here — the honest
total). Anthropic's harness does a form of tier routing too; econ's difference is
that it routes across *open* tiers and escalates on graph-structural risk.

| Instance | Pass | edit (files/±) | Cost | Turns | in | out | cache create | cache read | dur |
|---|:--:|---|---:|---:|---:|---:|---:|---:|---:|
| 11790 | ✅ | 2 files, 5+/1− | $0.5066 | 16 | 1.3k | 5.8k | 16.9k | 381.0k | 103.3s |
| 11815 | ✅ | 2 files, 71+/15− | $1.2742 | 36 | 1.0k | 14.0k | 29.4k | 1.26M | 212.1s |
| 11848 | ✅ | 1 file, 7+/3− | $0.2212 | 6 | 706 | 1.8k | 10.7k | 138.3k | 29.7s |
| 11880 | ✅ | 2 files, 16+/1− | $0.4172 | 13 | 825 | 4.1k | 14.9k | 332.1k | 67.6s |
| 11885 | ✅ | 4 files, 57+/35− | $1.7590 | 35 | 923 | 16.9k | 49.5k | 1.68M | **891.9s** |
| 11951 | ✅ | 2 files, 11+/1− | $0.8729 | 22 | 747 | 5.4k | 35.5k | 761.9k | 113.8s |
| 11964 | ✅ | 2 files, 22+/1− | $1.3534 | 26 | 1.4k | 19.4k | 43.1k | 873.3k | 261.5s |
| 11999 | ✅ § | 2 files, 30+/2− | $0.6800 | 20 | 730 | 7.6k | 18.9k | 603.0k | 850.9s |
| 12039 | ✅ | 2 files, 44+/4− | $1.0758 | 26 | 917 | 11.6k | 32.1k | 930.9k | 179.8s |
| 12050 | ✅ | 2 files, 36+/2− | $0.8717 | 25 | 642 | 9.9k | 24.5k | 757.8k | 163.8s |
| **Total** | **10 / 10** | | **$9.0320** | **225** | 9.2k | 96.4k | 275.5k | **7.72M** | |

§ 11999's **first** attempt hit the 900s wall (`timeout` exit 124) and was killed
before emitting its JSON envelope — its partial patch still graded OK, but its cost
was unrecorded. The row above is a **re-run at an 1800s wall**: it completed in
850.9s (i.e. it was borderline, not pathological), produced the **same** 2-file/30+
patch, and graded OK. Worth noting Opus's latency generally: 11885 finished at
891.9s, ~8s from the same fate. **900s is too tight a wall for Opus.**

---

## Analysis — where the cost actually goes

1. **Tokens × turns, not price-per-token.** Haiku is ~1/15th Opus's per-token price
   and still costs **$0.76 per solved instance** vs Opus's ~$0.95 — because it burns
   **433 turns / 21.67M cache-read tokens** to Opus's **225 / 7.72M**. Every turn
   re-sends accumulated context, so thrash multiplies directly into the bill. A weak
   model doesn't fail cheaply; **it fails expensively and repeatedly**.

2. **Turn count tracks capability, inversely.** Opus 11848: **6 turns, $0.22, solved**.
   Haiku 11848: 22 turns, 901k cache-read, **failed** (`errors=7`). The strong model's
   economy is that it is *right early*. This is the ceiling on how far cheap-tier
   routing alone can go, and why econ's escalation-on-structural-risk matters more
   than its tier prices.

3. **econ trades turns for token price — and wins on net.** econ runs **more** turns
   than either frontier model (492 vs ~210) but its per-turn context is leaner
   (~25k cache-read/turn vs Sonnet ~40k, Haiku ~50k) thanks to graph-targeted slices,
   and its open tiers price those tokens far lower. Net: ~¼ of Opus's spend at
   near-Opus solve rate. The win is **mostly `r` (price ratio), partly `f`** — we
   should stop claiming the harness wins on raw token count; it does not.

4. **11815 separates the field — and indicts the benchmark.** Opus ✅ · Sonnet ❌ ·
   Haiku ❌ · econ 2/3. Gold's `test_patch` rewrites the visible suite so its
   assertions encode the bug: a general fix reddens them, a bug-preserving one goes
   green. Opus was the only model to reason past its own passing tests (one draw —
   we have no evidence it does so *reliably*). Note the
   asymmetry this creates for *any* harness with a confirm-green finish gate
   (econ's F18 included) — on this instance class **green is not evidence**, and a
   gate that trusts it will confirm the wrong fix (see the econ 11815 note above).

5. **Frontier harnesses tier too.** `--model opus` transparently delegates cheap
   sub-work to Haiku. Multi-tier routing is not econ's differentiator; routing across
   *open* tiers, on *graph-structural* risk, with an in-loop governance gate, is.

---

## Provenance

- Drivers: `~/econ-swe-arena/claude-ref-mini10.sh <model> <arena_prefix>` (vanilla
  OFF-arm solve, one disjoint arena tree per model so all three run concurrently).
- Graders: `grade-any.sh <short> <arena_dir>` (grade.sh generalized + the mandatory
  commit-normalize), driven by `grade-sweep.sh <model> <arena_prefix>`.
- Metrics: `extract_metrics.py` (JSON→row), `md_rows.py <model> <prefix>`
  (→ markdown table body; run it BEFORE grading).
- Raw: `ref-<model>-<instance>.json` (envelope), `grade-<model>-<instance>.log`
  (verdict), `ref-<model>.log` (driver).
- econ receipts: `~/econ-swe-arena/mini10-<instance>-run.log`;
  11815 re-measure: `econ-11815-remeasure-{run,chain}.log`.
- Related: [SWE_BENCH_TRACKER.md](./SWE_BENCH_TRACKER.md) ·
  [HARNESS_AND_VARIANCE_REPORT.md](./HARNESS_AND_VARIANCE_REPORT.md) ·
  [STRICT_CYCLE.md](./STRICT_CYCLE.md) ·
  [REFERENCE_APPROACHES.md](./REFERENCE_APPROACHES.md)
