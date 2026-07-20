# Agnostic hands & eyes — a language/framework/architecture-agnostic sensing layer

**Status:** PLAN (2026-07-20). This is the implementation design for **H5** (the
ecosystem-adapter layer, [gap-closure-plan.md §3](./gap-closure-plan.md#3-scheduled-next-not-this-wave)),
grounded in a four-track research pass run 2026-07-20: (1) SOTA harness survey, (2) universal
substrate facts (structured test output, LSP, tree-sitter, toolchain resolvers), (3) empirical
research on how human developers work in unfamiliar repos, (4) an exhaustive inventory of every
framework-coupled site in our engine, classified by per-run cost shape. Nothing here is claimed
shipped; validation bars per [path-to-85.md §6](./path-to-85.md#6-measurement-plan-nothing-above-is-claimed-until-these-run).

Companions: [path-to-85.md §4](./path-to-85.md#4-any-language-any-repo--the-ecosystem-adapter-layer-the-real-new-work)
(the strategy sketch this doc supersedes as design), [gap-closure-plan.md](./gap-closure-plan.md)
(H5 scheduling + the §2.7 invariant kernel this design plugs into),
[graph-navigation-audit.md](./graph-navigation-audit.md) (graph consumer map).

---

## 0. Verdict up front

1. **The brain is already generic; only the senses are Python-shaped.** Verified in code:
   the claim–evidence kernel (`code-intelligence/claim-evidence.ts`), the deterministic
   escalation gate, deferral arming (`turn-supervisor.ts`), deadline/ops logic — zero
   framework or benchmark names. The coupling is localized to **9 files**: test-run
   detection (`seen-red.ts`), regression-neighbor discovery (`regression-neighbors.ts`),
   result parsing (`verifier.ts`), repro authoring prose (`prompts/seeds.ts`, `nudges.ts`),
   repro-file patterns (`slice-orchestrator.ts`), test-file classification (`edit-impact.ts`).
2. **The cost explosion is a token-shape bug, not a feature tax.** The inventory splits the
   coupling by cost shape: ~20 CPU-side sites (regexes, FS scans — **$0 per run**, all
   load-bearing) vs ~6 prompt-text sites carrying **~9–10k tokens of Python-specific prose**
   on the repro/drift/grind paths (seeds + nudges — none load-bearing). Adding a framework
   today means adding more prose to those seeds — that is the observed bare-$0.10 → $0.30
   step (user-reported 2026-07-20; needs a §6-compliant band before quoting, but the shape
   is confirmed by the inventory). **Design law: framework knowledge is cached per-repo
   DATA; the prompt only ever names ONE ecosystem — this repo's.** Cost per added ecosystem
   ≈ $0 by construction.
3. **Research consensus: nobody wins with per-framework harness code.** mini-swe-agent hits
   76.8% Verified with bash + exit codes and zero machinery; Terminal-Bench verification is
   pure end-state checking; SWE-rebench V2 covers 20 languages by **synthesizing per-repo
   setup once and caching it**; Aider simply asks the user for `--test-cmd`. Every system
   supporting 5+ languages keeps language knowledge out of the harness and in the
   environment or a cached artifact. Discovery (how to run tests) is the hard half;
   parsing is solved by structured output.
4. **The substrate for generic senses already exists.** Every major ecosystem emits
   machine-readable test results (JUnit XML is the de-facto interchange — 20+ runners,
   built-in or one plugin; JSON/TAP/TRX cover the rest); every ecosystem has a cheap
   deterministic compile/typecheck red signal; tree-sitter has 300+ grammars; LSP servers
   are solid for all majors; `mise`/`.tool-versions` conventions make toolchain resolution
   near-universal. We parse **~4 formats, not ~30 frameworks**.
5. **The human model is ecosystem-invariant, and it is our spec.** The comprehension
   literature says developers don't know 30 frameworks either — they run one ritual:
   README + manifest + directory scan → trace the entry point → run the failing thing →
   **paste the exact error into web search** (a top-5 developer search category) → minimal
   fix → run the nearest tests. The senses below implement that ritual as machinery.

---

## 1. Evidence base (compact)

### 1.1 What the winners do (SOTA survey)

| System | Discovery | Parsing | Per-language harness code |
|---|---|---|---|
| mini-swe-agent (76.8% Verified) | model infers per turn | exit code only | none |
| SWE-agent | model via ACI tool | exit code + re-query on bad syntax | none (generic tool bundles) |
| Aider | **delegated to the human** (`--test-cmd`) | exit code | none (tree-sitter repo map is nav-only) |
| Agentless | assumes ready | Python-AST | Python-locked — the named blocker |
| SWE-rebench V2 (20 langs) | **LLM-synthesized once per repo, cached** | deterministic after synthesis | none (pipeline generic) |
| Terminal-Bench 2.x | none needed | **end-state verification** | none |
| OpenHands / Devin / Cursor | model infers; container provides toolchain | exit code + stdout | none (per-lang Docker images) |

Cross-cutting: discovery > parsing in difficulty; the published caching pattern is
**validate-once-then-cache per repo** (SWE-Gym, SWE-rebench), and no system pays
per-framework prompt text per turn — cost control comes from caching, not prompting.

### 1.2 The universal substrate (verified facts)

- **Structured test output:** pytest `--junitxml` (built-in), jest/vitest `--json`,
  `go test -json`, cargo-nextest JUnit/JSON, Maven Surefire XML (default), Gradle XML,
  `dotnet test --logger trx`, RSpec `--format json`, PHPUnit `--log-junit`, ctest
  `--output-junit`, GoogleTest `--gtest_output=xml`, ExUnit junit-formatter. **Formats to
  parse: JUnit XML, JSON (3 dialects), TAP, TRX — a bounded, fixed set.**
- **Cheap universal red signal:** `tsc --noEmit`, `cargo check`, `go vet`/`go build`,
  `mvn -q compile`, `ruby -c`, `php -l`, mypy/ruff — every ecosystem, exit-code reliable.
- **Toolchain pins:** `.tool-versions`/`mise.toml` (polyglot), `.nvmrc`, `go.mod toolchain`,
  `rust-toolchain.toml`, venv/conda, Gemfile — `mise` reads nearly all of them natively.
- **Structure:** tree-sitter 300+ grammars (syntax-only; macros/templates/dynamic dispatch
  need semantics); LSP definition/references/documentSymbol/diagnostics solid for all major
  languages (~50–150 MB per server, headless-capable; SCIP for precomputed indexes).
- **Convention catalogs exist as data:** neotest's adapter set and VS Code testing
  extensions encode per-framework discovery conventions we can mine into a table.

### 1.3 The human ritual (research-grounded)

Developers spend ~58% of time comprehending, not writing; in an unknown repo they scan
README + manifests + directory shape and trace one path, not every file (LaToza/Ko/Myers
information-needs line). Searching **exact exception text** is one of the top five
developer web-search categories (Xia et al.; Google's own logs: ~5 search sessions/day,
1–2 term queries incrementally refined); docs get consulted opportunistically, examples
first (Brandt et al.). A fix is "done" when the failing case passes and the **nearest**
test subset is green locally — the full suite is CI's job. Polyglot developers transfer on
ecosystem-invariant signals (naming conventions, build systems, manifests), not deep
language knowledge. Each of these has a mechanical counterpart below.

### 1.4 Our coupling inventory (cost-shaped)

| Cost shape | Sites | Load-bearing? | Fate |
|---|---|---|---|
| **(T) prompt tokens** — `seeds.ts:48-62` repro slice (~5–6k tok), `nudges.ts:114-148` repro-drift/converge nudges (~1.4k), grind brief (~2k) — all Python prose (`repro_issue.py`, `python -c`, pytest node-ids) | ~6 | **No** — prose, not logic | **Compile from RepoProfile**; one ecosystem per prompt, same-or-smaller size |
| **(C) CPU-side** — `seen-red.ts` regex family (test-shaped command, failure signatures, laundered-red, token extraction; `isRedTestExecution` 16 callers), `regression-neighbors.ts` (Django twin pass, pytest scan, venv/conda interpreter probe), `verifier.ts` (per-runner case-count + skip regexes), `edit-impact.ts` test-file patterns (13 callers), `slice-orchestrator.ts` repro-path regexes | ~20 | **Yes** — gates depend on them | **Re-implement behind unchanged signatures**, driven by profile + structured output |
| **(J) judge payload** | 0 | — | judges are already language-neutral |

---

## 2. The design — three sensing layers over an unchanged brain

```
                    ┌─────────────────────────────────────────────┐
                    │  BRAIN (unchanged): claim–evidence kernel,  │
                    │  escalation gate, deferral, signal bus      │
                    └────────────▲────────────────▲───────────────┘
                        signals  │                │  signals
        ┌────────────────────────┴───┐   ┌────────┴─────────────────────┐
        │ L2 NAVIGATION              │   │ L3 OBSERVATION               │
        │ graph (tree-sitter edges,  │   │ structured test output first │
        │ per-lang coverage measured)│   │ (JUnit XML/JSON/TAP/TRX) →   │
        │ + LSP refs/diagnostics     │   │ exit code + generic grammar →│
        │ (lazy, profile-gated)      │   │ bounded LLM read, cached     │
        └────────────▲───────────────┘   └────────▲─────────────────────┘
                     │        both parameterized by │
                    ┌┴───────────────────────────────┴┐
                    │ L1 REPO PROFILE (the "first ten │
                    │ minutes", computed once, cached)│
                    │ manifests · CI config · Makefile│
                    │ → runner, commands, conventions,│
                    │   toolchain, build-check, repro │
                    └─────────────────────────────────┘
```

### 2.1 L1 — RepoProfile: the first ten minutes, once, as data

A small typed artifact derived per repo (per ecosystem root in a monorepo), cached, and
consumed by every sense. It is the machine form of what a human learns in the first ten
minutes, and the **only** place framework knowledge lives.

```ts
type RepoProfile = {
  version: 1
  derivedFrom: { commitish: string; manifests: string[] }   // cache key + invalidation
  ecosystems: EcosystemProfile[]                            // usually 1; monorepos >1
}
type EcosystemProfile = {
  language: string                       // "python" | "typescript" | "go" | "rust" | ...
  root: string                           // subtree this profile governs
  toolchain: { probeLadder: string[] }   // F14a/F21 generalized (see 2.3)
  versions: {                            // resolved, never guessed — see §3.1
    language?: string                    // pin-file or probed `--version` (once, at derivation)
    runner?: string                      // structured-output dialects vary by runner version
    deps: Record<string, string>         // lockfile-resolved: framework + key direct deps
  }
  buildCheck?: string                    // tsc --noEmit / cargo check / go vet / mvn -q compile
  tests:
    | {
        runner: string                   // "pytest" | "jest" | "go test" | ...
        suite: string                    // canonical full/subset invocation
        single: string                   // template: run ONE test by id
        structured: { flag: string; format: "junitxml" | "json" | "tap" | "trx" }
        conventions: { dirs: string[]; filePatterns: string[]; twinRule: string }
      }
    | { unknown: true }                  // fail-loud: SURFACE, never silent (§4)
  repro: { ext: string; run: string }    // repro_issue.<ext> + how to execute it
  verify?: { smoke?: string; ciCommands?: string[] }  // non-test repos: end-state style
}
```

**Derivation ladder (cost-ordered, mirrors the human ritual):**

1. **Deterministic scans (CPU, ~always sufficient):** manifest fingerprints
   (`pyproject.toml`/`package.json`/`go.mod`/`Cargo.toml`/`pom.xml`/`build.gradle*`/
   `Gemfile`/`composer.json`/`CMakeLists.txt`/`mix.exs`/`*.csproj`), **lockfiles as the
   resolved-version fingerprint** (`uv.lock`/`poetry.lock`/`package-lock.json`/
   `pnpm-lock.yaml`/`go.sum`/`Cargo.lock`/`Gemfile.lock` — exact versions, zero tokens;
   the raw material for §3.1), test-dir conventions, **CI config as ground truth** (`.github/workflows/*`, `.gitlab-ci.yml`,
   Makefile/justfile targets, `package.json` scripts — the repo's own declaration of how it
   verifies itself; a human reads exactly these), toolchain pin files.
2. **One bounded LLM synthesis call (conductor tier)** only when the scans are ambiguous —
   the SWE-rebench pattern. Its output is **validated by execution** (run the candidate
   suite command once, expect a parseable result; execution costs CPU-seconds, not tokens —
   the H2 repricing rule) before it is cached.
3. **Cache + invalidate** on manifest/CI-file change. Wire into `opencode init` beside the
   graph warm-up (same precedent). Benchmark arenas derive the profile in-arena at run
   start from repo state at the base commit — repo-derived facts, so strip-the-future safe.

The conventions piece is a **data table, not code**: per-ecosystem rows for twin discovery
(`test_<stem>.py` / `<stem>_test.py` / `__tests__/` / `*_test.go` / `src/test/java` mirror /
`tests/` crates / `spec/`), single-test id syntax, structured-output flag. The Django
`runtests.py` layout — today a hardcoded code branch (`djangoExactTwinCommands`) — becomes
**one row** (a framework *variant* keyed on a detected fingerprint), and every future
framework is a row too. Seed rows from the neotest/VS Code adapter catalogs.

### 2.2 L3 — Observation: parse formats, not frameworks

The evidence ladder replacing the pytest/Django stdout regexes, in strict order:

1. **Structured output first.** The harness appends the profile's structured flag to
   test-shaped commands it controls (regression lane, repro runs) and parses the report —
   the flag and its dialect are validated at profile-derivation time by executing them
   (output schemas vary by runner *version* — §3.1), then cached —
   **one parser per format** (JUnit XML, JSON dialects, TAP, TRX; a fixed set of ~4), giving
   exact per-test ids, counts, and failure text for every ecosystem at once. Immediate
   wins over today: `verifier.ts` case counts and skip detection come from the report, not
   six per-runner summary regexes; `checkTestSetCoverage` ids become report-native
   (classname+name) instead of pytest node-id parsing; **laundered-red detection becomes
   structural** — exit 0 with failures in the report is laundering by construction, no
   regex family needed.
2. **Exit code + a small generic failure grammar** for agent-authored commands we don't
   control (the mini-swe-agent datum: exit codes carry most of the signal). The generic
   grammar keeps only cross-language shapes (nonzero exit on a test-shaped command,
   `error`/`fail` density in the tail) — no runner-specific lines.
3. **Bounded LLM read of the output tail, cached as a profile parser-hint** (SWE-rebench
   synthesis pattern) only when 1 and 2 disagree or both miss — once per repo×runner, then
   it's data.

"Test-shaped command" itself becomes profile-driven: a command is test-shaped iff it
invokes the profile's runner/suite tokens, touches paths matching the profile's test
conventions, or is the profile's repro run command. `seen-red.ts` keeps its exported
signatures (16 callers of `isRedTestExecution` untouched); only the implementation changes.

### 2.3 L2 — Navigation: graph parity + LSP as the semantic fallback

- **Per-language edge parity in BunSqliteGraph** via tree-sitter grammars, with **measured
  edge coverage per language before risk signals are trusted there** (the wave-5 metric:
  resolved-import ratio; Python went 30%→84.7%). Unmeasured ecosystem → the profile
  reports `coupling=unknown` → routes to the judge rung, degraded-but-loud — the
  path-to-85 §4 contract, now enforced by profile field rather than convention.
- **LSP, lazy and profile-gated** (phase 6, optional per repo): `references`/`definition`
  where graph edges are weak (C++ templates, Java overloads, dynamic dispatch), and
  `diagnostics` as a **universal post-edit red signal** feeding the same bus the
  build-check uses. Never always-on (50–150 MB per server); the profile records
  availability and the gates degrade loudly without it.
- **Doctrine unchanged:** the graph routes *risk and verification strictness*, never
  localization (AutoCodeRover 45%→19% caution stands).

### 2.4 Hands: repro authoring and toolchain, profile-parameterized

- **Repro:** `repro_issue.py` → `repro_issue.<profile.repro.ext>`, executed via
  `profile.repro.run`. The witness discipline (typed asserts, all-witness single run,
  roundtrip synthesis — H1) is already language-neutral; only the vehicle changes. For
  **compiled targets, build-first discipline**: the profile's `buildCheck` runs as a rung
  BEFORE any test/probe rung, and a compile failure is a deterministic gate block — never
  conflated with a test red (the ts-repair lesson from path-to-85 §4).
- **Toolchain:** generalize F14a/F21 into one probe ladder per ecosystem: (1) the
  turn-harvested toolchain from an observed-green run (F21, already generic in principle),
  (2) repo-local pins (venv/conda dirs; `.nvmrc`; `rust-toolchain.toml`; `go.mod
  toolchain`; `.tool-versions` — shell out to `mise` when present, it reads nearly all of
  them), (3) PATH. Same shape as today's Python ladder, per-ecosystem rows.
- **Repro-artifact recognition** (`slice-orchestrator.ts` regexes) keys on
  `profile.repro.ext` instead of a hardcoded extension list.

---

## 3. Web search as a first-class sense (the human move, signal-gated)

Humans don't just search docs — **searching the exact error text is a first-line debugging
move** (top-5 search category; Xia et al.). We already ship default-on Exa with the
"ONE search EARLY" doctrine. This design adds deterministic triggers (never blanket,
per the no-advisory + cost rules):

| Trigger (deterministic) | Search built | Why |
|---|---|---|
| Error signature the profile's parsers don't recognize, or a trace rooted in a **dependency** rather than repo code | normalized trace: strip local paths/line numbers, keep the invariant message + framework + version (the documented human refinement ritual) | env/dependency bugs are exactly where repo-internal evidence can't help (the astropy `np.int` class — H8's env-red) |
| `repro_unresolved` after N attempts on an error mentioning an external API | quoted error + API name | confidence-triggered doc lookup (Brandt) |
| Turn-read says the task hinges on external knowledge | existing S2.3a doctrine, unchanged | lookup-shaped tasks resolve in one search ~54% of the time |

One search per firing, results ride the existing webfetch compression path. Benchmark
arenas keep `OPENCODE_DISABLE_WEBSEARCH=1` (strip-the-web is untouched — this sense is for
real-world use, and its triggers simply never fire there).

### 3.1 Version discipline (cross-cutting rule)

Different versions of the same dependency behave differently — APIs are added/removed
across majors, runner output dialects shift (pytest's JUnit XML changed schema families
across versions; `go test -json` and cargo's message formats are version-gated), and doc
sites are versioned. A sense that ignores versions imports wrong answers with high
confidence. We have a live in-house specimen: **astropy-8707/8872** — numpy ≥1.20 removed
`np.int`, the arena env didn't match the code's era, and the agent burned $1.01 chasing
pure version drift as if it were the bug ([gap-closure H8](./gap-closure-plan.md#h8--differential-regression-baseline-env-red--model-red--new-round-2)).

The rule, applied at every sense:

1. **Versions are read, never guessed.** The profile's `versions` block comes from
   lockfiles (exact resolved versions, CPU-only) or a one-time probed `--version` at
   derivation. No sense may assume "latest".
2. **Every external lookup carries the version.** Web-search queries embed the resolved
   framework/dep version (the documented human refinement ritual: invariant message +
   framework + version); doc fetches prefer **version-pinned URLs** (e.g.
   `docs.djangoproject.com/en/<X.Y>/`, `docs.rs/<crate>/<version>`, `/en/stable` over
   `/en/latest`) built from the profile.
3. **Version-mismatched guidance is flagged, not silently applied.** A search result or
   doc targeting a different major than the profile's resolved version is surfaced with a
   mismatch warning riding the result — the model sees "this answer is for v2; the repo
   pins v5" instead of absorbing it as truth.
4. **Version drift is an environment fact, reported once, loudly.** When a red traces to
   an API that the resolved dependency version no longer (or doesn't yet) provide, that is
   H8's env-red lane — the report can now name the *cause* ("numpy 1.24 in env; code
   targets <1.20"), not just the symptom, because the fingerprint is on hand.
5. **Cost shape:** lockfile parsing is CPU; version probes are one-time at profile
   derivation; the mismatch check is string comparison. ≈ $0 per run.

---

## 4. Brain updates (small, and mostly "consume the new field")

The kernel and gates stay; these consumers change what they read:

1. **`verification=unknown` is a first-class signal.** A repo where no test command is
   derivable (profile `tests.unknown`) must never silently skip verification: headless →
   abstain/surface in the finish summary ("no verification surface derived"); interactive →
   ASK-USER (the Aider `--test-cmd` move — delegating discovery to the human is the
   published, honest fallback). This is the H2 fail-loud rule generalized to discovery.
2. **Regression gate (F11/F20/H2/H8):** neighbor discovery reads the conventions table;
   the differential baseline (H8), fail-loud zero-selection (H2), and subset-scope rule are
   already generic and ride unchanged. The Django code branch is deleted in favor of its
   table row.
3. **Repro-fidelity judge + T1 extractors:** witness contracts unchanged; judge prompts
   drop pytest node-id examples and receive the profile's runner facts (H3's diff-aware
   input pattern). `extractIssueExpectations`/`Thresholds` are text-level and stay.
4. **Finish gates:** test ids flow from structured reports, so `checkTestSetCoverage`
   compares report-native ids — strictly more reliable than regex-harvested pytest ids.
5. **Escalation gate:** no change. New profile facts (`coupling=unknown`,
   `verification=unknown`) arrive as inputs on the existing signal bus.
6. **Prompt compilation:** seeds/nudges/playbooks become templates filled from the profile
   at turn-open. The compiled repro seed names exactly one runner, one file extension, one
   run command — **the prompt for a Go repo contains zero Python and zero "if pytest…"
   prose.** Size budget: ≤ today's Python-only seed.

---

## 5. Cost discipline (why this cannot re-explode)

The observed pressure: bare run <$0.10; framework-specific injection pushed runs to ~$0.30
(user-reported 2026-07-20; the inventory confirms the mechanism — ~9–10k tokens of
Python prose on the repro/drift/grind paths, and every added framework would have grown
it). Four standing rules, enforceable at review time:

1. **Framework knowledge is data, never prompt catalog.** No turn ever carries prose for
   an ecosystem the repo isn't. The per-ecosystem knowledge lives in the conventions table
   (CPU) and the cached profile (CPU); the compiled seed is single-ecosystem and
   size-capped at today's Python seed.
2. **Discovery is amortized.** Profile = deterministic scans + at most one bounded LLM call
   + one validation execution, **once per repo**, then cached (the SWE-Gym/SWE-rebench
   pattern: cache the validated setup, don't re-infer). Marginal cost per run ≈ $0.
3. **Observation is CPU-side.** Structured-report parsing costs no tokens; the LLM
   output-read is a bounded, cached, last-rung fallback.
4. **Measurement per path-to-85 §6.6:** any cost claim needs a ≥3-run band; acceptance bar
   for this wave = bare-run cost holds the current conductor-only floor (~$0.07–0.14) on
   the mini-10, and adding an ecosystem adds ~0 prompt tokens (auditable in the receipt's
   per-tier drilldown — count seed tokens per turn before/after).

---

## 6. Any repo *type*, not just any language

Server, client, app, data pipeline, event-driven — the profile's `verify` field records
**how this repo demonstrates correctness**, which is not always "run the unit suite":

- **Test-verifiable repos:** the default path above.
- **Ops/end-state-shaped work** (build it, deploy it, wire it): the H4 end-state
  deliverable checklist + the claim–evidence kernel's `deliverables` scope already cover
  this generically — Terminal-Bench's verification model, which carries zero framework
  knowledge, is the proof this style generalizes.
- **Integration-heavy repos** (pipelines, event consumers): profile records a smoke
  command (CI-derived) and the regression lane bounds by wall-clock, not test count
  (H2.3's repricing rule); when only a subset ran, the finish summary states the verified
  scope (H2.4) — never an implied "no regressions".

The repo *type* never routes model tiers or localization — it only selects the
verification style, keeping the "graph routes risk, not localization" doctrine intact.

---

## 7. Phased implementation plan

| Phase | Work | Effort | Validation (binding) |
|---|---|---|---|
| **P0 — RepoProfile core** | type + deterministic derivation (manifests, CI parse, Makefile/scripts, lockfile version fingerprint, conventions table) + cache + `opencode init` wiring | ~1 d | fixture corpus: ≥10 polyglot repos (py/ts/go/rust/java + one Django, one monorepo, one no-test repo) — profile correctness asserted per field, **including resolved versions** |
| **P1 — Observation rewrite** | format parsers (JUnit XML, JSON, TAP, TRX); `seen-red.ts`/`verifier.ts` re-implemented behind unchanged signatures; structural laundered-red | ~1.5–2 d | unit fixtures per format; **mini-10 must hold 10/10** (Python behavior parity is the regression gate for the rewrite itself) |
| **P2 — Toolchain + build-first** | probe ladder per ecosystem (mise-aware, F21-first); `buildCheck` rung before test rungs on compiled targets, deterministic block | ~1–1.5 d | replay: compiled-target fixture repo; interpreter-probe unit parity on the Python ladder |
| **P3 — Regression neighbors → table** | conventions-table twin discovery; delete the Django code branch into a row; H8/H2 ride along | ~1 d | 13236/7606/8872 replays stay converted; Django twin parity fixtures |
| **P4 — Prompt compilation** | seeds/nudges templated from profile; `repro_issue.<ext>`; slice-orchestrator patterns profile-driven | ~1 d | seed token-size audit (≤ today's); repro-drift replay on one non-Python fixture |
| **P5 — Web-search sense** | unrecognized-trace + dependency-rooted triggers, normalized **version-pinned** query builder (§3.1), version-mismatch flag on results, signal-gated | ~0.5–1 d | trigger-rate audit on mini-10 (must be ~0 there — arenas disable it); live-repo probe on a dependency-bug specimen incl. a version-drift case |
| **P6 — Graph coverage parity** | per-language edge-coverage measurement; `coupling=unknown` route. **LSP declined — see §7.1** | ~1 d | edge-coverage report per language published in the doc; degraded-route unit tests |
| **Gate** | SWE-bench Multilingual probe (300 tasks) + mini-10 ×3 band + TB smoke + cost band | — | expectation: **frontier-relative** (frontier itself drops to 43–47% multilingual), not Python parity; no score/cost claims before this runs |

Total: **~7–9.5 days**, agent-built. Sequencing note: P0→P1 are the spine (everything else
parameterizes on the profile); P3/P4/P5 are parallelizable after P0; P6 is independent.

### 7.1 P6 decision — LSP declined; P6 is measurement + `coupling=unknown` only (2026-07-20)

P6 was scheduled with "LSP diagnostics as optional post-edit red" as a third deliverable.
Two measurement tracks were run before building it — an inventory of what our graph already
provides per language, and an evidence review on LSP-for-agents. **Verdict: no LSP.** P6
ships its first two deliverables only.

**Track A — what the graph already provides.** 13 languages parse (regex extractor with an
optional tree-sitter WASM fallback); two edge kinds, `import` and `call`. Call edges are
100% resolved-or-dropped everywhere (an unresolved call is never stored). **Import
resolution is the whole split:**

| Ecosystem | Import resolution | Measured on |
|---|---|---|
| Python | 76.8% (django, 3036 files; 90.7% of all edges) — 39% on `requests` | `resolvePythonImport`, wave-5 |
| TypeScript / JavaScript | ~84% relative-only; external npm stays null (econ's own source: 84.4% of all edges) | `resolveRelativeImport` |
| Go, Java, Rust, C, C++ | **null — no resolver rules exist** | — |

**The finding that decided P6 is not about navigation at all.** `computeRisk` weights fan-in
35%, blast radius 35%, centrality 20%. On an ecosystem with no import resolution those three
inputs are all 0, so the risk score is low *by construction* — and indistinguishable from a
genuinely safe edit. The router reads "staying cheap is justified"; the hub gate reads "not a
hub." `stats()` returns only `{files, entities, edges}` — no per-language breakdown, no
resolved ratio, no telemetry — so nothing detects this. That is a silent false-negative on
every compiled-language repo, and it violates the §2.7 no-advisory invariant: a signal that
neither converts, defers, nor surfaces.

**Track B — LSP evidence.** **No published ablation isolates LSP with model and harness held
constant.** Adoption is therefore an operational judgement, and the operational facts run
against us:

1. **It fails exactly where we need it.** `jdtls` requires a successful build or
   `compile_commands.json`; `clangd` the same, failing silently without it; `rust-analyzer`
   emits no per-file diagnostics until a project-wide index completes. Our arenas frequently
   cannot even install dependencies — so LSP returns nothing precisely on Java/C++/Rust, the
   ecosystems whose edges are weakest.
2. **The cost shape is wrong for us.** ~10s cold start per language, 200MB–1GB resident.
   Arena and CI runs kill daemons between tasks, so the warm-daemon amortization that
   justifies LSP in an IDE never happens — every run pays cold start. Against the <$0.10
   bare-run floor this is the same class of regression §5 exists to prevent.
3. **Our own base disagrees.** Upstream OpenCode ships LSP and documents that it "is not
   always a net positive… can get out of sync, use significant memory… and slow down agent
   workflows."
4. **Its dominant real use is already occupied.** Across the agents that ship it, LSP is used
   for post-edit diagnostics far more than pre-edit navigation — and P2's `buildCheck` rung
   already holds that seam with a stateless CLI typecheck (`tsc --noEmit` / `cargo check` /
   `go build ./...`), the documented "80% of the value for 10% of the effort" pattern.

**The decisive point:** LSP would not fix the Track-A finding. Coupling blindness is a
*measurement* gap, not a symbol-resolution gap. Adopting LSP first would deliver plausible
symbol navigation while risk routing stayed blind — hiding today's visible zero-coupling
behind a correct-looking surface, which is strictly worse than the current failure mode.

**Revisit trigger (falsifiable, so this decision can be overturned by evidence):** a
non-Python instance class where the `coupling=unknown` route measurably over-escalates —
i.e. the degraded route fires often enough to cost more than the mis-routing it prevents.
That is a cost/quality band, not a preference, and it is only measurable after P6a/P6b ship.

---

## 8. Explicitly not building (Tier-3 style, so the decisions are recorded)

- **Per-framework adapter code sprawl** — 30 framework classes each with discovery+parse
  code. We parse ~4 *formats* and keep conventions as *data rows*; a new framework is a
  table entry, not a module.
- **Per-turn LLM discovery** (the mini-swe-agent move) — repeated token cost and
  model-capability-dependent; we cache the validated answer instead. The thin pipe stays
  the yardstick (E1), not the design.
- **LSP in any form, always-on or lazy** — declined outright 2026-07-20 after the two-track
  measurement in §7.1: no published ablation isolates its effect; it fails on the very
  ecosystems it would serve (build-dependent servers in arenas that cannot install deps);
  its cold-start/memory shape is wrong for short-lived runs; and it would not fix the
  coupling-measurement gap that motivated P6 in the first place.
- **Graph-guided localization** — doctrine unchanged.
- **Blanket web search per turn** — triggers are deterministic and tail-shaped; arenas
  keep it disabled.
- **A universal "repo-type classifier" that routes models** — type selects verification
  style only; routing stays on structural-risk signals.

---

## 9. Relationship to the existing plans

- **Supersedes** the sketch table in [path-to-85.md §4](./path-to-85.md#4-any-language-any-repo--the-ecosystem-adapter-layer-the-real-new-work)
  as the *implementation* design (that section remains the strategy statement and
  multilingual yardstick).
- **Implements H5** from [gap-closure-plan.md §3](./gap-closure-plan.md#3-scheduled-next-not-this-wave);
  the metamorphic-relation library scheduled there plugs into the profile's `twinRule`/
  witness synthesis seam once this lands.
- **Feeds the §2.7 kernel:** every new sense publishes onto the existing signal bus as
  convert/defer/surface — the two new signals (`verification=unknown`,
  `coupling=unknown`) arrive with consumers wired on day one (the H9 lesson: no signal
  ships without its consumer).
- **Durability tag (per the gap-closure standing rule):** the profile, format parsers,
  build-first rung, differential baseline, and end-state checklists are all
  **model-agnostic verification** — the invest-freely category that survives every model
  upgrade and transfers to frontier-model mode unchanged.
