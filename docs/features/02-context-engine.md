# Feature: The context engine (hand over the right slice)

The context engine is the turn-time layer that decides what the model actually
sees. A single plugin hook — `context.assemble.before` — gives push-based
injection points for recon and memory, landing before the conversation history
so the shared prefix stays prompt-cache-friendly. Around that hook sits a set
of pure, degrade-safe compression and pruning modules (output trimming,
web-fetch ranking, window pruning) that each shrink a specific slice of
context, and a fidelity gate that wraps every one of them so a compression
pass can never silently drop something the model needed. A semantic layer
(`@sem domain=/role=`) tags graph entities with meaning so recon bundles and
reads carry intent, not just names. Together these pieces implement the
project's second pillar — hand the model the right slice, not the whole repo.

Status: implemented (S2.0–S2.6). All modules below ship with passing test
suites; see each section's "Tests" line.

> **Plugin layer retired (2026-07-13).** The `.opencode/plugins/econ-*.js` MVP
> plugins that originally wired these seams (econ-recon-inject S2.1,
> econ-output-trim S2.2, and siblings) are deleted — the engine owns recon,
> trimming, governance, and checkpointing natively. Any run launched with the
> old plugin dir present double-hooked the loop: on the fly fleet's mini-10
> (2026-07-13) econ-recon-inject injected a recon bundle on EVERY step, and the
> conductor patched the injected symptom layer instead of investigating —
> 3/10 wrong-layer failures that never reproduced locally. The diagrams below
> are preserved as the design record of those seams.

---

## Turn-time flow

```
                         ┌───────────────────────────────┐
 user prompt ───────────▶│ LLMRequestPrep.prepare()       │
                         │ (packages/opencode/src/session/│
                         │  llm/request.ts)                │
                         └───────────────┬─────────────────┘
                                          │
                          1. system[] assembled
                          2. experimental.chat.system.transform
                          3. context.assemble.before  ◀── S2.0 hook
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                                          ▼
        econ-recon-inject (S2.1)                    (memory injection, future)
        query graph for task phrase                  push {role:"user", ...}
        push recon bundle → output.messages
        (placed BEFORE conversation history —
         keeps [system]+[recon] prefix cache-stable)
                     │
                     ▼
          messages[] = system ++ contextInject.messages ++ input.messages
                     │
                     ▼
                model call, tool loop begins
                     │
                     ▼
        tool.execute.after  ◀── econ-output-trim (S2.2)
        bash/read/grep/glob output > budget → smartTruncate()
                     │
        (web-fetch tool path)
        webfetch_compress (S2.3): HTML → markdown → passages
        → BM25 rank → top-K → cache
                     │
                     ▼
        every compressor above (trim / BM25 / prune) is wrapped by
        gateCompression() ◀── S2.5 fidelity gate
        answer keys missing? → reject, return original (degraded:true)
                     │
                     ▼
        before the next model call: pruneWindow() ◀── S2.4
        dedupe tool outputs → drop old reasoning → drop old
        assistant messages, keepLastN always verbatim
                     │
                     ▼
                 model sees a trimmed, deduped, fidelity-checked window
```

Semantic tags (S2.6) are orthogonal to this pipeline: they are stored once at
index time and ride along on every `search`/`recon`/`getEntity` result the
other stages consume (e.g. the S2.1 recon bundle's `[domain=<d> role=<r>]`
suffix).

---

## Shared substrate

Three pieces of infrastructure are reused across the sections below rather
than reimplemented per module — noted once here, cross-referenced elsewhere:

- **`estimateTokens()` / `smartTruncate()`** (`packages/code-intelligence/src/trim.ts`,
  S2.2) — the token-budget heuristic and truncation strategy used directly by
  output trimming, and imported by `prune.ts` (S2.4, with a `Math.ceil(chars/4)`
  fallback if `trim.ts` isn't present) and exercised as the reference
  compressor in the fidelity gate's regression set (S2.5).
- **`BunSqliteGraph`** (`packages/code-intelligence/src/bun-sqlite-graph.ts`) —
  the code graph backing `search`/`recon`/`getEntity`. S2.1's recon-inject
  plugin holds a lazy singleton of it (same pattern as
  `packages/opencode/src/tool/graph-tools.ts`); S2.6 adds the `domain`/`role`
  columns it serves.
- **Pure-module discipline** — `trim.ts`, `prune.ts`, `fidelity.ts`, and the
  `webfetch/` modules are all dependency-free (or Bun-global-only) pure TS:
  no I/O, no mutation, easy to unit test and to wrap in the fidelity gate.

---

## Context-assemble hook — S2.0

**Hook:** `context.assemble.before`, defined in `packages/plugin/src/index.ts`
inside the `Hooks` interface:

```typescript
"context.assemble.before"?: (
  input: {
    sessionID: string
    agent: string
    model: Model           // from @opencode-ai/sdk
    provider: ProviderContext
    message: UserMessage   // the triggering user turn
  },
  output: {
    /** Push strings to append to the assembled system prompt */
    system: string[]
    /**
     * Push plain-text model messages to inject immediately before the
     * conversation history. Use "system" for context blocks,
     * "user" for memory/recon turn-level injections.
     */
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  },
) => Promise<void>
```

`output.system` is the live system array (same reference used by
`experimental.chat.system.transform`); pushing to it extends the system
prompt. `output.messages` starts empty; entries are prepended before the
conversation history in the final `ModelMessage[]` sent to the LLM.

**Fire point.** File: `packages/opencode/src/session/llm/request.ts`,
function `LLMRequestPrep.prepare`. The hook fires **after**
`experimental.chat.system.transform` has run (system is fully assembled) and
**before** the `messages` local variable is built (the array shipped to the
AI SDK) — the latest point where both `system` and `messages` can still be
mutated before the model call.

```
1. system[] assembled from agent.prompt + input.system + user.system
2. plugin.trigger("experimental.chat.system.transform", ...)   ← existing
3. plugin.trigger("context.assemble.before", ...)              ← S2.0
4. messages[] = [...system as ModelMessages, ...contextInject.messages, ...input.messages]
5. plugin.trigger("chat.params", ...)
6. plugin.trigger("chat.headers", ...)
7. return { system, messages, tools, params, headers }
```

Approximate line in the file after the S2.0 edit: **~79–97** (after the
`experimental.chat.system.transform` block, before `const variant = ...`).

**Design constraints:**

- **Text-only injections.** `output.messages` accepts `{ role, content: string }`
  only. Multi-part or file-based injections must go through
  `experimental.chat.messages.transform` at the `WithParts[]` level (fires
  earlier in `prompt.ts`).
- **No model call.** The hook fires synchronously within the Effect runtime;
  awaited Promises are fine, but the hook must resolve before the LLM stream
  starts.
- **isWorkflow / isOpenaiOauth bypass.** When `isWorkflow` or `isOpenaiOauth`
  is true, `messages` is passed through unchanged (OpenAI OAuth and GitLab
  Workflow models manage their own context). Injections from
  `context.assemble.before` are still pushed to `output.messages` but not
  prepended in those paths (see S2.1's note below for the practical
  consequence). Consumer plugins should check `input.provider` and skip
  injection for those providers if needed.

This hook is the sole integration point that S2.1 (recon injection) and a
future memory-injection plugin both build on.

---

## Recon injection — S2.1

**Plugin:** `econ-recon-inject` (`.opencode/plugins/econ-recon-inject.js`).
Fires on every `context.assemble.before` turn, queries the in-process code
graph for the user's task phrase, and injects a compact **recon bundle** (top
entities + references + anchored notes) as a context message immediately
before the conversation history. The model starts each turn with
graph-derived context pre-loaded — no `search_code` / `file_read` fan-out
required.

**Injection position (cache-friendly):**

```
[ system prompt(s) ]       ← stable, cacheable
[ recon bundle ]           ← injected here, stable position
[ conversation history ]   ← changes each turn
```

The bundle sits **before** the conversation history so the
`[system prompt] + [recon bundle]` prefix is invariant across turns and can
be prompt-cached by the provider (Anthropic cache_read, OpenRouter caching).
The injection uses `role: "user"` so it's clearly separated from the system
block and readable by all models that support multi-turn context.

**Bundle format:**

```
=== RECON: <task phrase> ===
ENTITIES:
  <name> (<kind>) <filePath>:<lineStart>  [domain=<d> role=<r>]
    sig: <signature>
REFERENCES:
  <fromEntity> → <toEntity> (<kind>)
NOTES:
  <anchored note>
=== END RECON ===
```

- **ENTITIES** — up to 8 entities ranked by name-match relevance to the task,
  each with file location and optional `@sem` domain/role tags (S2.6).
- **REFERENCES** — up to 12 unique caller/callee edges among the matched
  entities.
- **NOTES** — prose notes anchored to matched files (populated when unerr
  brain sidecar is connected; empty from the local `BunSqliteGraph` stub).

**No-read-fan-out claim.** Without this plugin, a model handling a
code-editing turn must: `search_code(task)` → `file_read(entity)` × N →
`get_references(entity)` × N — that's `1 + 2N` tool calls before the first
substantive output. With the recon bundle pre-loaded, the model sees entity
names, file locations, signatures, and caller edges in its starting context.
For the common case (routing, impact assessment, single-function edits),
**zero additional reads are needed**. Deep dives (full function bodies,
secondary callers) still require a targeted read but are rare.

**Implementation:**

| Artifact | Path |
|---|---|
| Plugin | `.opencode/plugins/econ-recon-inject.js` |
| Test | `packages/opencode/test/session/recon-inject.test.ts` |
| Graph backend | `packages/code-intelligence/src/bun-sqlite-graph.ts` (shared substrate) |
| Hook contract | `packages/plugin/src/index.ts` `Hooks["context.assemble.before"]` |
| Fire point | `packages/opencode/src/session/llm/request.ts` ~line 83 |

The plugin holds a lazy `BunSqliteGraph` singleton, identical to the pattern
in `packages/opencode/src/tool/graph-tools.ts`, indexed from `process.cwd()`
on first use — the first turn of a session may see an empty bundle (index not
yet complete); subsequent turns see the full graph.

**Task-phrase extraction.** `input.message` is a `UserMessage` (session
metadata, no raw text). The plugin derives the task phrase in priority order:
`message.text` (some host integrations) → `message.summary.title`
(post-compaction) → `message.summary.body` (truncated to 120 chars) →
fallback `"code"` (broad enough to return common entities).

**Design constraints:**

- **Read-only graph access** — never writes to the graph or
  `packages/code-intelligence` source.
- **Graceful degradation** — if the graph fails to initialise or `recon()`
  throws, the hook logs and returns without injecting; the turn proceeds
  normally.
- **Empty bundle skip** — when `recon()` returns zero entities and zero
  notes, no message is pushed (avoids a useless filler turn in history).
- **isWorkflow / isOpenaiOauth paths** — `contextInject.messages` is not
  prepended in these paths (`request.ts` line 119–132). The bundle is still
  queried and formatted (wasted work) but harmless; a future optimisation can
  check `input.provider` and short-circuit early.

**Tests:** `packages/opencode/test/session/recon-inject.test.ts` — 4 tests,
all against a seeded in-memory `BunSqliteGraph` and
`LLMRequestPrep.prepare()` with a mock plugin (no live model call):

| Test | Assertion |
|---|---|
| bundle before history | Injected message index < conversation-history index |
| graph-derived content | Bundle contains entity name (`parseTask`) + kind (`function`) |
| empty graph → no injection | No `=== RECON:` block when graph has no indexed entities |
| multiple entities listed | At least one `(function)` entity line in ENTITIES section |

---

## Output trimming — S2.2

**Module:** `packages/code-intelligence/src/trim.ts` — ported from
`../unerr-cli/src/intelligence/`:

| Source | Ported into |
|---|---|
| `token-estimator.ts` (`detectContentType` + `estimateTokenCount`) | `trim.ts` → `estimateTokens()` |
| `smart-truncate.ts` (structural-priority truncation) | `trim.ts` → `smartTruncate()` |

**Adaptation note.** The original `smartTruncate` operates on structured
entity sections (metadata / imports / signatures / bodies). This port targets
flat tool output (bash stdout, file reads) — input is a plain `string` and
the strategy is **head + match-context + tail** rather than structural
priority. The token-estimator heuristic is unchanged: content-type detection
+ whitespace-discounted char ratio. No external dependency was introduced —
the `gpt-tokenizer` import from the original is intentionally omitted; the
heuristic fallback is sufficient for a budget guardrail (accuracy ±10–20%).

**Trim policy:**

```
Budget:  4000 estimated tokens  (plugin constant OUTPUT_BUDGET)
Head:    40% of budget          (preamble, imports, command header)
Middle:  30% of budget          (query match context when query supplied)
Tail:    30% of budget          (result, exports, exit status)
Margin:  100-char reserve for the elision marker line
```

Elision marker: `... [N lines elided — T estimated tokens, budget B] ...` —
embeds the full estimated token count `T` so the model can decide whether the
missing content warrants a targeted follow-up.

**Hook wiring.** Plugin: `.opencode/plugins/econ-output-trim.js`, on
`tool.execute.after` (`packages/plugin/src/index.ts` line 274):

```ts
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
) => Promise<void>
```

The plugin mutates `output.output` in place (mirrors how the `.before` hook
mutates `output.args` in `econ-gate-spike.js`). Targeted tools: `bash`
(`packages/opencode/src/tool/shell/id.ts`), `read`, `grep`, `glob`. `write`,
`edit`, `apply_patch` are excluded — their outputs are short confirmations,
not potentially large text blobs.

**Files delivered:**

| File | Role |
|---|---|
| `packages/code-intelligence/src/trim.ts` | Pure TS trim module (no deps) |
| `.opencode/plugins/econ-output-trim.js` | Plugin with `tool.execute.after` hook |
| `packages/code-intelligence/test/trim.test.ts` | bun:test suite (17 assertions) |

`packages/code-intelligence/src/index.ts` and `packages/plugin/src/index.ts`
were not touched by S2.2 (owned by S2.6 and S2.0 respectively).

---

## Web-fetch compression — S2.3

**Tool:** `webfetch_compress` — BM25-ranked, hash-cached web fetch. Ported
modules live under `packages/code-intelligence/src/webfetch/`, no new runtime
dependencies (uses only `node:crypto`, available in Bun).

| File | Origin | Purpose |
|---|---|---|
| `extract.ts` | `unerr-cli/src/tools/web/extract.ts` (`rawBodyFromHtmlSync`) | Regex-only HTML → markdown; strips nav/header/footer/script/style; converts h1-h6, links, code blocks, bold/italic, lists. No DOM. |
| `passage-split.ts` | Direct port | Splits markdown into heading-or-blank-line-delimited passages; keeps code fences whole. |
| `bm25.ts` | Ported; `wink-bm25-text-search` replaced with inline pure-TS impl | Okapi BM25 (k1=1.5, b=0.75) with separate heading/text field weights; prose-candidate filter (min 150 chars, link-density < 0.4). Synchronous. |
| `cache.ts` | New | In-process `Map`-backed cache keyed by SHA-256(html) + URL + prompt + topK. |

**Adaptation notes vs unerr-cli:** `extract.ts` drops the jsdom /
Defuddle / `@mozilla/readability` pipeline — the `rawBodyFromHtmlSync` regex
path is the entire implementation, plus it converts structural tags to
markdown instead of returning raw text. `bm25.ts` replaces the native-compiled
`wink-bm25-text-search` with an inline 40-line scorer (identical formula,
zero native deps, now synchronous — `Passage[]` not `Promise<Passage[]>`).
`passage-split.ts` is identical to unerr-cli; only import paths changed.

**Ranking + cache pipeline:**

```
fetch(url)
  │
  ├─ contentHash(html) ──► buildCacheKey(url, hash, prompt, topK)
  │                               │
  │                        getCached(key) ──► HIT: return cached output
  │
  ▼
htmlToMarkdown(html)          # strip chrome, convert tags → markdown
  ▼
splitMarkdownIntoPassages()   # heading sections + blank-line blocks
  ▼
rankPassagesByPrompt()        # BM25 filter+score; prose-candidate pre-filter
  ▼
format + setCached(key, …)    # store for next call
  ▼
return { output, compressionRatio, passageCount, cached }
```

**Cache key** = `url + '\0' + sha256(html).slice(0,16) + '\0' + prompt + '\0' + topK`.
Changing page content (different HTML) or query parameters produces a new
key; the old entry stays valid for unchanged content.

**Tool registration.** `packages/opencode/src/tool/webfetch-compress.ts`
exports `WebFetchCompressTool`, registered in
`packages/opencode/src/tool/registry.ts` (Z2.3 block) following the same
`Effect.succeed` + `Effect.promise` pattern as the S1.2 graph tools. No
Effect layers required — calls Bun's global `fetch()` directly.

**Tool ID:** `webfetch_compress`. **Parameters:** `url` (string, required),
`prompt` (string, optional — BM25 ranking query; omit for document-order
top-K), `top_k` (number, optional, default 10). **Returns** metadata
`{ cached, compressionRatio, passageCount }` plus the formatted passage
output.

**Size-reduction numbers** (test fixture: synthetic HTML doc page, ~18 KB raw
HTML, 10 thematic sections):

| Stage | Characters | Ratio to raw HTML |
|---|---|---|
| Raw HTML | ~18 000 | 1.00 |
| Extracted markdown (all passages) | ~9 500 | ~0.53 |
| Top-3 BM25 passages (targeted query) | < 7 200 | **< 0.40** |

The test asserts `ratio < 0.40` (≥60% reduction) for a targeted 3-passage
query; in practice with `topK=3` on a 10-section page the ratio is closer to
0.15–0.25 depending on section lengths.

**Tests:** `packages/code-intelligence/test/webfetch-compress.test.ts` — 6
tests, 0 fail (27ms):

| Test | Assertion |
|---|---|
| size reduction | output < 40% of raw HTML length |
| BM25 relevance | top-ranked passage text matches query terms |
| cache hit | `getCached` returns identical string on second lookup |
| cache miss on changed content | different HTML hash → `undefined` |
| contentHash stability | same input → same 16-char hex digest |
| code fence integrity | fence passages contain exactly two ` ``` ` markers |

---

## Web search default enablement — S2.3a

**Status:** shipped 2026-07-16, tests green.

Exa-backed web search (`websearch` tool) is now default-on for every econ tier and
persona as a cost-efficient lookup capability. The goal: one targeted search early
when a task hinges on external knowledge — a single good search resolves ~54% of
lookup-shaped tasks without further recon turns (user-supplied motivating stat).
The model can explicitly request more results (defaults: 5 results, 8000-char context
limit) or webfetch additional pages.

**Control surfaces:**

- **Runtime flag:** `enableExa` (packages/opencode/src/effect/runtime-flags.ts:31–40)
  defaults `TRUE`; single kill switch `OPENCODE_DISABLE_WEBSEARCH=1`.
- **Tool registration:** `webSearchEnabled` simplified in
  `packages/opencode/src/tool/registry.ts:62–64` — advertised on every provider path
  including our litellm gateway.
- **Prompt doctrine:** `WEB_LOOKUP_DOCTRINE` fragment (packages/opencode/src/session/prompts/fragments.ts:35–51)
  composes into `BASE` (prompts/base.ts:17) → inherited by all 4 tiers + 6 personas.
  Explorer persona delta (personas.ts:27). Read-only playbook lookup clause
  (preambles.ts:48). Doctrine: ONE targeted search EARLY when task hinges on external
  knowledge; search → webfetch the authoritative source; never search what the repo
  answers; denied search = proceed on local evidence.
- **Cost-lean defaults:** `numResults: 5` (max 20), `contextMaxCharacters: 8000` (max 50000).
- **Deterministic provider:** explicit `OPENCODE_WEBSEARCH_PROVIDER` override >
  parallel-only-if-sole-enabled > Exa always. The old `checksum(sessionID)%2`
  per-session coin flip was deleted (per §6.8 route-determinism rule).

**Files touched:**

| File | Change |
|---|---|
| `packages/opencode/src/effect/runtime-flags.ts:31–40` | `enableExa` defaults TRUE, kill switch OPENCODE_DISABLE_WEBSEARCH |
| `packages/opencode/src/tool/registry.ts:62–64` | `webSearchEnabled` simplified |
| `packages/opencode/src/tool/websearch.ts` | `selectWebSearchProvider`, deterministic routing |
| `packages/core/src/tool/websearch.ts` | `defaultConfigLayer` (dormant, zero callers) |
| `packages/opencode/src/session/prompts/fragments.ts:35–51` | `WEB_LOOKUP_DOCTRINE` |
| `packages/opencode/src/session/prompts/base.ts:17` | doctrine composes into BASE |
| `packages/opencode/src/session/prompts/personas.ts:27` | explorer delta |
| `packages/opencode/src/session/prompts/preambles.ts:48` | READ_ONLY_PLAYBOOK lookup clause |
| `packages/opencode/test/config/econ-defaults.test.ts:198–231` | seat coverage drift tests (websearch/webfetch allow floor) |
| `packages/opencode/src/session/slice-orchestrator.ts` | deny-precedence fix: no automatic allow overlay |
| `packages/opencode/src/config/econ-defaults.ts` | permission floor (agent.permission first, session overlay last) |

**Deny-precedence fix:** `childSlicePermission` (slice-orchestrator.ts) no longer
appends `websearch`/`webfetch` allow rules — the config-layer floor
(config/econ-defaults.ts permission block) grants web per-seat. An explicit user or
arena `opencode.json` deny now wins by merge order (agent.permission merged first,
session overlay last; evaluation is `findLast` — last matching rule wins, and the
overlay no longer carries a web rule to shadow the deny). Previously the overlay silently overrode
an explicit deny for every slice child — a strict-benchmark integrity hole now closed.
Benchmark arenas additionally set `OPENCODE_DISABLE_WEBSEARCH=1` + per-seat config
denies (host-side scripts, outside this repo).

**Tests:** `packages/opencode/test/config/econ-defaults.test.ts:198–231` drift tests
verify no seat drops the `websearch`/`webfetch` tools (derived from ECON_PERSONAS).
All green.

---

## Window pruning — S2.4

**Module:** `packages/code-intelligence/src/prune.ts`.
`pruneWindow(messages, { tokenBudget, keepLastN })` takes an ordered
conversation window (oldest-first `Message[]`) and returns a pruned list plus
a structured `PruneReport`. The window is guaranteed to fit within
`tokenBudget` estimated tokens after pruning. The most recent `keepLastN`
messages are always returned verbatim — never subject to any pruning stage.

**Prune policy** — three ordered stages, each running only if the window is
still over budget after the previous stage:

1. **Deduplicate completed tool outputs.** Stale: an earlier completed call
   to the same tool with the exact same serialised JSON input. Load-bearing:
   the most recent completed result for each `(tool, input)` key. Walks the
   old-message region to find the highest-index occurrence of each key, then
   drops all earlier occurrences — catches repeated `read_file` on the same
   path, repeated `shell` with the same command, etc.
2. **Drop reasoning parts from the old region.** Stale: `reasoning`-type
   parts (chain-of-thought / extended thinking) outside the protected tail.
   Load-bearing: all `reasoning` parts inside `keepLastN` (untouched).
3. **Drop entire old assistant messages, oldest first.** Stale: the oldest
   assistant messages that no longer carry load-bearing tool outputs (after
   Stage 1) or reasoning (after Stage 2). Load-bearing: user messages are
   *never* dropped — they are the structural anchor of the conversation. Only
   `role: "assistant"` messages in the old region are candidates. Oldest
   evicted first so the most recently integrated context survives longest.

| Content | Stale when… | Always kept |
|---|---|---|
| Tool output (`type: "tool"`, `status: "completed"`) | A later call used the same tool + input | Latest result for each (tool, input) pair |
| Reasoning (`type: "reasoning"`) | Outside the `keepLastN` tail | Inside `keepLastN` |
| Text (`type: "text"`) | Entire assistant message is dropped (Stage 3) | Inside `keepLastN`; user messages never |
| User messages | Never stale | Always |
| Pending/running tool calls | Never subject to Stage 1 dedup (state not `completed`) | Structural role in the turn |

**Token estimation** reuses the shared substrate: `prune.ts` imports
`estimateTokens` from `./trim` (S2.2); if that module is absent it falls back
to `Math.ceil(chars / 4)` (±15% accuracy, sufficient for budget gating).

**Wiring to S2.0** (owned by the S2.0 sibling task — this describes the
intended integration point):

```typescript
// Conceptual wiring — NOT in prune.ts itself
import { pruneWindow } from "@opencode-ai/code-intelligence/prune"

const { messages: pruned, report } = pruneWindow(history, {
  tokenBudget: modelContextLimit * 0.85, // leave headroom for the response
  keepLastN: 6,
})
// log report.droppedToolOutputs, report.estimatedOutputTokens → unerr telemetry
sendToModel(pruned)
```

`PruneReport` is surfaced to unerr telemetry so savings from context
compression appear in the savings receipt alongside model-routing savings.

**Tests:** `packages/code-intelligence/test/prune.test.ts` covers: no-op when
already under budget (same reference returned); stays within `tokenBudget`
after pruning a 50-message window; `keepLastN` tail always preserved
verbatim; stale duplicate tool outputs dropped, latest survives; distinct
tool calls (different inputs) not deduplicated; reasoning parts dropped
before whole messages; user messages never dropped; report fields
(`inputMessages`, `estimatedInputTokens`, `estimatedOutputTokens`) correct.

---

## Fidelity gate — S2.5

**Status:** implemented. **File:** `packages/code-intelligence/src/fidelity.ts`.
**Tests:** `packages/code-intelligence/test/fidelity.test.ts`.

**Purpose.** Every compression pass in the stack (output trimming, BM25
passage selection, context pruning) trades token cost for information loss.
The fidelity gate is a standing check: before accepting a compressed result,
verify that every "answer key" — a substring the downstream model must see —
survived. If any key is missing, the gate rejects the saving and returns the
original, uncompressed content (degrade-safe). This is the ARCH §5 guard.

**Verdict shape:**

```ts
interface FidelityVerdict {
  kept: boolean        // false if any required key is missing
  tokensSaved: number  // estimated tokens saved (can be negative)
  fidelityScore: number // fraction of keys that survived (0–1)
  missing: string[]    // keys not found in the compressed output
}
```

`assessFidelity({ before, after, answerKey })` is pure — no I/O, no mutation.

**Gate wrapper:**

```ts
gateCompression(compressor, input, answerKeys, opts?)
// → { output, verdict, degraded }
```

`output` is the compressed result when all keys survive (`degraded: false`),
or the original `input` when any key is missing (`degraded: true`). The
`verdict` is always reported so callers can observe token savings and missing
keys. For non-string compressors (BM25 passage arrays, message arrays) supply
`opts.serializeBefore` / `opts.serializeAfter` to project both sides to
strings before key-checking.

**Regression set** — four compressor types, six cases, two deliberately
trigger a gate rejection (proving the gate bites):

| Compressor | Case | Answer keys | Gate result |
|---|---|---|---|
| `smartTruncate` (trim.ts, S2.2) | Normal budget (300 tok) | `HEAD_SENTINEL`, `TAIL_SENTINEL` | Green — both survive in head/tail |
| `smartTruncate` (trim.ts, S2.2) | **Over-aggressive** (50 tok) | `MIDDLE_SENTINEL` | **Red** — middle elided, gate rejects |
| `rankPassagesByPrompt` (BM25, S2.3) | topK=3, relevant query | `BM25_TARGET_PHRASE` | Green — relevant passage in top-3 |
| `rankPassagesByPrompt` (BM25, S2.3) | **Over-aggressive** topK=1, unrelated query | `BM25_TARGET_PHRASE` | **Red** — wrong passage returned, gate rejects |
| `pruneWindow` (prune.ts, S2.4) | Recent message in keepLastN | `RECENT_FACT` | Green — recent tail never dropped |
| `pruneWindow` (prune.ts, S2.4) | Stale tool outputs deduped | `PRESERVED_KEY` | Green — recent text preserved |

**How it plugs in as a standing gate.** Any new compression step should be
wrapped:

```ts
const { output, verdict } = gateCompression(myCompressor, input, requiredKeys)
if (verdict.tokensSaved > 0) {
  emitSavingsEvent({ saved: verdict.tokensSaved, fidelity: verdict.fidelityScore })
}
// `output` is always safe to use — original if fidelity failed
```

The gate is cheap (string scan + token estimate) and stateless. It must run
inside the same call frame as the compressor so the fallback is transparent
to callers. Never accept a compressed result without first running it
through `assessFidelity` with the answer keys for the current task context.

**What counts as an answer key.** Answer keys are caller-supplied. Good
sources: explicit user questions (extract the key entity/fact names);
tool-call inputs (the file path, function name, or query string the model
needed to see); prior model output markers (if the model already named a
symbol, that name must survive into the next window). Vague keys (single
common words) cause false positives — prefer multi-word phrases or
structured tokens (`ERROR_CODE`, `function_name`, `file.ts:42`).

---

## Semantic layer — S2.6

**What was built.** The code-intelligence graph parses
`@sem domain=<tag> role=<tag>` annotations from doc comments and stores them
as first-class columns on every indexed entity. All query outputs
(`getEntity`, `search`, `recon`, tool JSON) carry `domain` and `role` so
agents reason over meaning, not just names — this is what feeds the
`[domain=<d> role=<r>]` suffix in the S2.1 recon bundle's ENTITIES section.

**`@sem` parse rules.** A `/** ... */` block comment placed directly above
the entity declaration (no blank line between `*/` and the
`export`/`function`/`class` keyword):

```typescript
/**
 * One-to-two sentence prose summary — what the entity does and why.
 * Never restate the entity name; never describe the how.
 *
 * @sem domain=<tag> role=<tag>
 */
export function myEntity(...) { ... }
```

Single-line form is also accepted: `/** Short summary. @sem domain=<tag> role=<tag> */`.

**`@sem` line grammar:** `@sem domain=<word> role=<word>`. Both are single
words (no spaces, no quotes); the line may appear anywhere inside the block
comment; other `@`-tag lines (`@param`, `@returns`, etc.) are ignored; a
missing `domain` or `role` stores `NULL` for that field.

**Extraction algorithm** (`extractDocComment` in `ast-extractor.ts`): walk
backward from the entity's line index skipping blank lines; require the
nearest non-blank line to end with `*/`; walk further back to find the
opening `/**`; strip comment markers from each interior line; match
`/domain=(\S+)/` and `/role=(\S+)/` on any line starting with `@sem`; return
`{ semDomain, semRole }` (both optional).

**Schema additions** (`bun-sqlite-graph.ts`, shared substrate) — two nullable
TEXT columns on the `entities` table:

```sql
domain  TEXT,   -- @sem domain=<tag>
role    TEXT,   -- @sem role=<tag>
```

**Migration.** The constructor runs:

```typescript
try { db.exec("ALTER TABLE entities ADD COLUMN domain TEXT") } catch {}
try { db.exec("ALTER TABLE entities ADD COLUMN role TEXT") } catch {}
```

No-op for new (in-memory) DBs where the columns are already in the
`CREATE TABLE` statement; safely adds the columns to any existing persistent
DB. The `index()` upsert includes `domain` and `role` in both the INSERT
column list and the `ON CONFLICT DO UPDATE SET` clause, so re-indexing keeps
annotations current.

**How reads and recon carry domain/role.** `Entity` (`index.ts`) gains
`domain?: string` / `role?: string` (undefined when not annotated).
`rowToEntity` (`bun-sqlite-graph.ts`) maps the columns:
`domain: row["domain"] ? String(row["domain"]) : undefined` (same pattern for
`role`).

| Method | domain/role present? |
|---|---|
| `getEntity(key)` | Yes — via `rowToEntity` |
| `search(query)` | Yes — via `rowToEntity` |
| `recon(task)` | Yes — entities returned by `search` carry the tags |
| `makeReconTool` JSON output | Yes — serialised by `JSON.stringify(bundle)` |
| `makeFileReadTool` entity profile | Yes — `getEntity` result JSON |
| `makeGetReferencesTool` | N/A — returns `Reference` edges, not entities |

**Tests:** `test/semantic.test.ts`. Fixture `test/fixture/sem.ts` — two
annotated exports (`computeRisk` with `domain=risk role=analysis`,
`ModelRouter` with `domain=routing role=decision`) and one unannotated export
(`unannotated`). Assertions: `getEntity("computeRisk")` →
`domain="risk"`, `role="analysis"`; `getEntity("ModelRouter")` →
`domain="routing"`, `role="decision"`; `getEntity("unannotated")` and
`getEntity("greet")` (existing fixture, no annotation) → both undefined;
`search("computeRisk")` → first result carries tags; `recon("risk analysis")`
bundle → matched entity carries tags; `makeReconTool` JSON output →
serialised `domain`/`role` fields present.
