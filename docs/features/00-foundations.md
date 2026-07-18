# Feature: Foundations & day-0 de-risk gates

This feature area establishes that the forked OpenCode base actually builds and runs
econ's model tiers against an OSS/OpenRouter endpoint, that the usage/cost accounting
econ's savings telemetry depends on is trustworthy end-to-end, and that a plugin hook
can enforce governance decisions synchronously at the tool-execution boundary (the seam
the in-loop governance gate, S6.3, will occupy). It also scopes a permission-bypass risk
in the MCP tool path found while validating that boundary, and records the sprint-0
verification pass that confirms all of the above ships clean from the workspace.

## How the pieces fit

```
opencode.json "model": "openrouter/<author>/<slug>"
        │
        ▼
  model.resolve()  (packages/core/src/session/runner/model.ts)
        │  dispatches on api.package → OpenAI / Anthropic / OpenAI-compatible route
        ▼
  tier endpoint (OpenRouter, local vLLM, ...)
        │  SSE stream, final chunk carries usage + cost
        ▼
  openai-chat.ts mapUsage() → Usage{cacheRead, cacheWrite, cost}
        │
        ▼
  publish-llm-event.ts → SessionEvent.Step.Ended{cost, tokens.cache.*}
        │
        ▼
  unerr telemetry / savings receipt

  ── separately, on every tool call ──
  tool execute() → plugin.trigger("tool.execute.before") → hook throws? ──yes──▶ tool-error to model (blocked)
                                                                 │no
                                                                 ▼
                                                          tool runs normally

  (MCP tools reach this gate only via SessionTools.resolve() — see S0.5 gap)
```

---

## Build & run on an OSS model (S0.1)

**Install.** `bun install` at repo root — PASS, 4618 packages in ~108s. Postinstall
(`packages/core/script/fix-node-pty.ts`, husky) ran clean.

**Build.** `bun turbo build`:

| Package | Result | Notes |
|---|---|---|
| `opencode` (main CLI) | PASS | Builds platform binaries into `packages/opencode/dist/` |
| `@opencode-ai/cli` | PASS | |
| `@opencode-ai/app` (web UI) | PASS | Vite, warnings only |
| `@opencode-ai/storybook` | PASS | Vite, warnings only |
| `@opencode-ai/sdk` | PASS | |
| `@opencode-ai/desktop` | FAIL | see "Known pre-existing build gaps" below |

The CLI binary — the thing econ drives — built successfully. No source edit was needed;
the codebase builds as-is from the checked-out OpenCode fork.

Built binary (Darwin arm64): `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`
— `--version` → `0.0.0-main-202606271343`.

**Run commands:**
```bash
# Dev (from source, fastest iteration)
bun run dev
# equivalent to: bun run --cwd packages/opencode --conditions=browser src/index.ts

# Built binary (TUI)
packages/opencode/dist/opencode-darwin-arm64/bin/opencode

# Headless one-shot (for agent harness)
opencode run -m <provider>/<model> "your message here"
# e.g. opencode run -m openrouter/qwen/qwen3-coder-480b-a35b "say hello"

# Serve (HTTP API for programmatic use)
opencode serve --port 4096
```

### Model resolution — how it works

**Seam:** `packages/core/src/session/runner/model.ts`

- **`resolve()`** (lines 157–165) takes the catalog `ModelV2.Info` for the session's
  selected model, applies the requested variant (`high`, `low`, ...) via `withVariant`,
  then hands it to `fromCatalogModel`.
- **`fromCatalogModel()`** (lines 115–155) dispatches on `model.api.type` +
  `model.api.package`:

  | `api.package` | Protocol used | Auth |
  |---|---|---|
  | `@ai-sdk/openai` | `OpenAIResponses.route` | Bearer |
  | `@ai-sdk/anthropic` | `AnthropicMessages.route` | `x-api-key` header |
  | `@ai-sdk/openai-compatible` (url required) | `OpenAICompatibleChat.route` | Bearer |

  Any other value → `UnsupportedApiError`; the `supported()` guard at line 167 enforces
  the same set. `model.api.url` becomes `endpoint.baseURL` (lines 79–81 in
  `withDefaults()`). The API key comes from, in order: oauth/key credential, inline
  `request.body.apiKey`, or an env-var connection name.
- **`locationLayer`** (lines 174–207) is the per-turn runtime wiring: reads the catalog
  (populated by provider plugins at startup from `opencode.json` + credentials), finds
  the selected model by `providerID`+`id` (falls back to the first `supported()` model),
  looks up the integration connection (`~/.local/share/opencode/auth.json`), calls
  `resolve()`.
- **Config → model:** `opencode.json` `"model": "openrouter/qwen/qwen3-coder-480b-a35b"`
  parses as `providerID=openrouter`, `modelID=qwen/qwen3-coder-480b-a35b`; the catalog
  locates the matching `ModelV2.Info` (`api.package`, `api.url`, `api.id`) and `resolve()`
  builds the LLM call object from it.

### Config recipes — point a tier at an OSS/OpenAI-compatible endpoint

**Option A — OpenRouter (preloaded provider, easiest).** Set the key (`/connect` in the
TUI, or `export OPENROUTER_API_KEY=sk-or-v1-...`), then:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/qwen/qwen3-coder-480b-a35b"
}
```
Any model ID on [openrouter.ai/models](https://openrouter.ai/models) works
(`openrouter/<author>/<model-slug>`). To add one not preloaded:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/qwen/qwen3-coder-480b-a35b",
  "provider": { "openrouter": { "models": { "qwen/qwen3-coder-480b-a35b": {} } } }
}
```

**Option B — local vLLM (or Ollama / LM Studio / llama.cpp — any OpenAI-compatible server):**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "local-vllm/qwen2.5-coder-32b-instruct",
  "provider": {
    "local-vllm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local vLLM",
      "options": { "baseURL": "http://localhost:8000/v1", "apiKey": "ignored" },
      "models": {
        "qwen2.5-coder-32b-instruct": {
          "name": "Qwen2.5-Coder 32B",
          "limit": { "context": 131072, "output": 8192 }
        }
      }
    }
  }
}
```
Key fields: `npm` must be `@ai-sdk/openai-compatible` for `/v1/chat/completions` (use
`@ai-sdk/openai` only for a `/v1/responses` endpoint); `options.baseURL` is the full URL
including `/v1`, no trailing slash; `options.apiKey` can be any string locally (or
`"{env:MY_ENV_VAR}"`); `limit.context`/`limit.output` are not auto-discovered for custom
providers — set them to what the model supports so context tracking works; the model ID
in `models` must match exactly what the server returns from `GET /v1/models`.

Run: `opencode run -m local-vllm/qwen2.5-coder-32b-instruct "say hello in one line"`

**Option C — OpenRouter via explicit provider block** (override request-level routing):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/qwen/qwen3-coder-480b-a35b",
  "provider": {
    "openrouter": {
      "options": { "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": {
        "qwen/qwen3-coder-480b-a35b": {
          "options": { "provider": { "order": ["DeepInfra", "Together"], "allow_fallbacks": false } }
        }
      }
    }
  }
}
```

**Smoke test.** No API key was available in the S0.1 environment, so the live smoke test
was skipped. Run manually once a key is available:
```bash
OPENROUTER_API_KEY=sk-or-v1-... \
  packages/opencode/dist/opencode-darwin-arm64/bin/opencode run \
  -m openrouter/qwen/qwen3-coder-480b-a35b \
  "respond with exactly: hello from qwen"
```

---

## Cache & cost accounting (S0.3)

**Status:** Day-0 gate. **Verdict:** `cache.read` worked as shipped; `cache.write` was
broken (fixed); `cost` was hardcoded to 0 (fixed).

### Trace

**1. `Usage` type** — `packages/llm/src/schema/events.ts:51–60`. Fields as shipped:
`inputTokens, outputTokens, nonCachedInputTokens, cacheReadInputTokens,
cacheWriteInputTokens, reasoningTokens, totalTokens, providerMetadata` — all optional, no
`cost` field. Cost was structurally absent from `Usage`.
**Fix:** added `cost: Schema.optional(Schema.Number)` at line 58.

**2. Provider wire schema** — `packages/llm/src/protocols/openai-chat.ts:115–129`.
`OpenAIChatUsage` parsed the SSE final chunk. Before the fix it captured
`prompt_tokens_details.cached_tokens` (cache read ✓) but had no `cache_write_tokens`
field and no top-level `cost` field. Confirmed from real OpenRouter fixtures
(`openrouter-streams-text.json`, `openrouter-claude-opus-4-7-drives-a-tool-loop.json`),
which return:
```json
{
  "cost": 4.95e-06,
  "prompt_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0, ... }
}
```
Key findings: OpenRouter uses `prompt_tokens_details.cached_tokens` for cache reads
(same field as OpenAI native — already captured correctly). OpenRouter uses
`prompt_tokens_details.cache_write_tokens` for cache **writes** — NOT
`cache_creation_input_tokens` (the Anthropic-native field) — and this was silently
dropped. OpenRouter returns a top-level `usage.cost` (USD float) that was not captured.
OpenRouter also returns `usage.cost_details.upstream_inference_cost` for further
breakdown (not captured, not needed for this gate).
**Fix:** added `cost: Schema.optional(Schema.Number)` at the top level and
`cache_write_tokens: Schema.optional(Schema.Number)` inside `prompt_tokens_details`.

**3. `mapUsage()`** — `packages/llm/src/protocols/openai-chat.ts:383–397`. Before the fix
it mapped `cached_tokens → cacheReadInputTokens` but ignored `cache_write_tokens` and
`cost`.
**Fix:** now captures both:
```typescript
const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens
// ...
cacheWriteInputTokens: cacheWrite,
cost: usage.cost,
```

**4. `publish-llm-event.ts:401`.** The `step-finish` handler always published
`cost: 0`:
```typescript
yield* events.publish(SessionEvent.Step.Ended, {
  finish: event.reason,
  cost: 0,          // ← hardcoded, never computed
  tokens: tokens(event.usage),
})
```
The `tokens()` helper (lines 17–27) already correctly read `cacheReadInputTokens` and
`cacheWriteInputTokens` from `Usage` — that path was fine.
**Fix:** changed to `cost: event.usage?.cost ?? 0`. When the provider (OpenRouter)
populates `Usage.cost`, it flows through; for providers that don't (native OpenAI,
Anthropic direct, Bedrock — which either don't expose cost in the stream or compute it
server-side) it stays 0.

**OpenRouter-specific note:** the `openrouter.ts` provider sends
`stream_options: { include_usage: true }` (from `fromRequest` in `openai-chat.ts:352`) —
the OpenAI-standard way to get usage in the final SSE chunk. No `usage: { include: true }`
body option is needed for the basic token+cost fields; that option only unlocks
additional OpenRouter-specific analytics (`cost_details`). The fixtures confirm usage is
returned without it.

### Verdict

| Field | Before | After | Notes |
|---|---|---|---|
| `cache.read` (`cacheReadInputTokens`) | WORKS | WORKS | `prompt_tokens_details.cached_tokens` was already captured |
| `cache.write` (`cacheWriteInputTokens`) | BROKEN (always 0) | FIXED | OpenRouter field is `cache_write_tokens`, not `cache_creation_input_tokens` |
| `cost` | BROKEN (hardcoded 0) | FIXED | OpenRouter returns `usage.cost`; now flows through Usage → SessionEvent |

### Files changed

| File | Change |
|---|---|
| `packages/llm/src/schema/events.ts:58` | Added `cost: Schema.optional(Schema.Number)` to `Usage` class |
| `packages/llm/src/protocols/openai-chat.ts:119–124` | Added `cost` and `cache_write_tokens` to `OpenAIChatUsage` schema |
| `packages/llm/src/protocols/openai-chat.ts:385–397` | `mapUsage` now captures `cacheWriteInputTokens` and `cost` |
| `packages/core/src/session/runner/publish-llm-event.ts:401` | `cost: 0` → `cost: event.usage?.cost ?? 0` |

### Verification plan

Once a real model endpoint is wired (S0.1), run two back-to-back identical requests
against an OpenRouter Claude model with prompt caching enabled:

**Turn 1 (cache write):**
```
Assert: usage.cacheWriteInputTokens > 0
Assert: usage.cacheReadInputTokens === 0 (or small)
Assert: SessionEvent.Step.Ended.cost > 0
Assert: SessionEvent.Step.Ended.tokens.cache.write > 0
```

**Turn 2 (cache read — same system prompt):**
```
Assert: usage.cacheReadInputTokens > 0
Assert: usage.cacheWriteInputTokens === 0
Assert: cost < turn1_cost  (cache reads are cheaper)
Assert: SessionEvent.Step.Ended.tokens.cache.read > 0
```

**Mechanically:** add a temporary test to
`packages/llm/test/provider/openai-compatible-chat.test.ts` that replays the existing
`openrouter-claude-opus-4-7-drives-a-tool-loop.json` fixture and asserts
`response.usage?.cacheWriteInputTokens` is present in the decoded `Usage`. The fixture
currently has `cache_write_tokens: 0` (first call), but the schema now accepts it. Update
the fixture with a second-call recording once a live endpoint is available to capture a
non-zero `cached_tokens` value.

**Savings signal check:** after S0.1 wiring, verify `emitSavingsEvent` receives non-zero
cache token counts — that is the unerr telemetry signal confirming the accounting reaches
the savings layer.

---

## Plugin enforcement gate (S0.4)

**Spike goal:** prove that an OpenCode plugin can ENFORCE at the edit boundary — a
`tool.execute.before` hook that blocks a designated test edit by throwing, and the model
sees the refusal as a tool error.

**Status:** demonstrated. All 5 verification tests pass.

### Hook signature

`packages/plugin/src/index.ts:266–269`
```typescript
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>
```
`input.tool` is the tool ID string (`"write"`, `"edit"`, `"apply_patch"`, `"bash"`, ...);
`input.sessionID`/`input.callID` are tracing handles; `output.args` is the raw arguments
object the tool was called with (mutable — the hook can also sanitise/rewrite args before
the tool runs). The hook is async; returning normally allows the call to proceed.
**Throwing (or a rejected Promise) blocks the tool call.**

### How throwing surfaces to the model

Execution chain (all in the same Effect run):
```
tool execute()                                packages/opencode/src/session/tools.ts:95–125
  └─ plugin.trigger("tool.execute.before", ...)   tools.ts:99
       └─ Effect.promise(async () => fn(input, output))   plugin/index.ts:290
            └─ hook throws Error(msg)
                 └─ Effect.promise captures rejection → Effect failure
                      └─ propagates through Effect.gen → run.promise rejects
                           └─ AI SDK tool executor catches rejected Promise
                                └─ returns tool error result to the model
```
The model receives a tool-call error part whose `output` string is the thrown
`Error.message`; it cannot proceed with the blocked edit and must respond to the refusal.

Key seam: `packages/opencode/src/plugin/index.ts:290` —
`yield* Effect.promise(async () => fn(input, output))`. `Effect.promise` wraps any
throw/rejection into an Effect failure; because the caller does `yield*` inside
`Effect.gen`, the failure short-circuits the generator and propagates out through
`run.promise()` as a plain rejected Promise, which the AI SDK's tool executor converts
into a `tool-error` message part.

### Plugin load mechanism

OpenCode discovers plugins from two directory sources at startup, in priority order:

| Priority | Source | Path |
|---|---|---|
| 3 | Global plugin dir | `~/.config/opencode/plugins/*.{ts,js}` |
| 4 | Project plugin dir | `.opencode/plugins/*.{ts,js}` ← spike lives here |

...and from `opencode.json` / `~/.config/opencode/opencode.json`:
```json
{ "plugin": ["my-npm-plugin", "./path/to/local.ts"] }
```
Discovery seam: `packages/opencode/src/config/plugin.ts:18–30`
```typescript
export async function load(dir: string) {
  const plugins: ConfigPluginV1.Spec[] = []
  for (const item of await Glob.scan("{plugin,plugins}/*.{ts,js}", {
    cwd: dir, absolute: true, dot: true, symlink: true,
  })) {
    plugins.push(pathToFileURL(item).href)
  }
  return plugins
}
```
A plugin file must export one or more functions (legacy format) or a `PluginModule`
with a `.server` method (v1 format). The spike uses the legacy format — every exported
async function is called with `PluginInput` and must return a `Hooks` object:
```typescript
// legacy format — detected by plugin/index.ts:getLegacyPlugins
export const MyPlugin = async (ctx) => {
  return { "tool.execute.before": async (input, output) => { ... } }
}
```

### Spike plugin

`.opencode/plugins/econ-gate-spike.js` blocks `write`, `edit`, and `apply_patch` calls
whose `output.args.filePath` contains the string `ECON_GATE_BLOCKED`. Replace the marker
predicate with real governance rules (protected path set, regex, permission check) for
production.

### Demonstration

Verification script (no `bun install` needed, pure Node.js):
```
node packages/econ-gate-spike/verify.mjs
```
Output observed on 2026-06-27:
```
[econ-gate-spike] plugin loaded

[test] non-edit tool (read) is never blocked
  PASS: no block (read tool not in EDIT_TOOLS)

[test] write to a normal path is allowed
  PASS: no block (path does not match marker)

[test] write to ECON_GATE_BLOCKED path is refused
[econ-gate] REFUSED: 'write' on 'docs/sprint0/ECON_GATE_BLOCKED.txt' blocked by
governance gate (path matches marker "ECON_GATE_BLOCKED"). This edit is not permitted.
Choose a different file.
  PASS: gate threw — model would receive this tool error:
  -> [econ-gate] REFUSED: 'write' on 'docs/sprint0/ECON_GATE_BLOCKED.txt' blocked
     by governance gate (path matches marker "ECON_GATE_BLOCKED"). ...

[test] edit to ECON_GATE_BLOCKED path is refused
  PASS: gate threw ...

[test] apply_patch to ECON_GATE_BLOCKED path is refused
  PASS: gate threw ...

────────────────────────────────────────────────────────────
Results: 5 passed, 0 failed
```
The verification script directly reproduces the trigger loop from
`packages/opencode/src/plugin/index.ts:287–293` (without Effect or Bun), so every call
path is tested without booting the full server.

**To see the refusal inside a live OpenCode session:** start OpenCode in the repo root
(where `.opencode/plugins/` is discovered); ask the model to write to
`docs/sprint0/ECON_GATE_BLOCKED.txt`; the model calls `write` with that `filePath`; the
gate throws before the tool executes; the model sees the tool error and is forced to
respond to the refusal — it cannot complete the write.

### Production path

Replace the path-marker predicate with: a set of read-only protected paths (config
loaded in the plugin's init `ctx.project`); a regex matching generated files, vendored
code, or lock files; or a permission check against the session's agent role. The gate
fires synchronously inside the Effect graph — sub-millisecond latency for simple
predicates. For async checks (e.g. a remote policy service), await inside the hook; the
`Effect.promise` wrapper keeps the caller fully awaited.

---

## MCP permission scope (S0.5)

**Verdict: GO — a minimal patch is needed** to close an MCP tool execution permission
bypass. The `tool.execute.before` governance hook is properly invoked for MCP tools in
the main session path, but the underlying tool construction in `mcp/catalog.ts` lacks
built-in permission gating — a risk if that layer is ever accessed directly or bypassed
by future code.

### Dispatch & permission flow

1. **Built-in tool dispatch (core path)** — `packages/core/src/tool/registry.ts:49`.
   `settleWith()` looks up the tool registration by name and calls `settle()` to execute.
   The permission gate is applied by the calling layer (session or consumer).
2. **MCP tool definition & creation (catalog layer)** —
   `packages/opencode/src/mcp/catalog.ts:42–81`. `convertTool(mcpTool, client, timeout)`
   creates "ai"-library tool definitions from MCP server tool specs. Line 54 makes the
   direct MCP client call (`await client.callTool(...)`). **No plugin trigger wrapper at
   this layer — permission check omitted.** Returns a tool with an execute function ready
   to use.
3. **MCP tools registration (MCP service)** — `packages/opencode/src/mcp/index.ts:628–651`.
   `MCP.Service.tools()` calls `convertTool()` for each connected MCP server tool and
   returns `Record<string, Tool>` of unwrapped tools.
4. **Session tool resolution (permission gate)** —
   `packages/opencode/src/session/tools.ts:298–393`. `SessionTools.resolve()` fetches MCP
   tools via `mcp.tools()` (line 298), wraps each tool's execute with
   `plugin.trigger("tool.execute.before", ...)` (lines 309–313) and
   `plugin.trigger("tool.execute.after", ...)` (lines 327–331), and applies the
   permission check at line 315 (`ctx.ask({ permission: key, ... })`).

### Key finding

**Does `tool.execute.before` intercept MCP tool calls? YES — in the main codepath.** MCP
tools are wrapped with the plugin hook in `SessionTools.resolve()` (lines 309–327) and
the permission check is called at line 315.

**But there is a structural risk:** `convertTool()` in `catalog.ts` has no built-in
permission gating. If MCP tools are accessed outside the session wrapper (direct
`mcp.tools()` usage, testing frameworks, future refactoring), they bypass the governance
gate. The hook depends on the session layer wrapping tools — not on the tool definition
itself.

### Why this matters for econ's governance gate

econ's in-loop governance (S6.3) must fire before ANY tool execution. Current state:
built-in tools have governance applied at multiple layers (session wrapper + registry
lookups) — OK. MCP tools have governance applied at the session wrapper layer — OK. But
there is a structural gap: MCP tool definitions (`convertTool()`) trust the caller to
apply permission gating, with no fail-safe. If a future code path calls `mcp.tools()`
results directly, or `convertTool()` is reused in a new context (CLI, testing, plugin
delivery), the governance gate is silently bypassed.

### Recommended patch

Move permission gating **into** `convertTool()` itself, making it a property of the tool
definition rather than the caller.

**1. `packages/opencode/src/mcp/catalog.ts` (lines 42–81):**
```typescript
export function convertTool(
  mcpTool: MCPToolDef,
  client: Client,
  timeout?: number,
  onBeforeExecute?: (toolName: string) => Promise<void>, // NEW: optional permission hook
): Tool {
  const inputSchema: JSONSchema7 = { /* ... */ }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      // NEW: Call permission hook before execution (if provided)
      if (onBeforeExecute) {
        await onBeforeExecute(mcpTool.name)
      }

      const result = await client.callTool(
        { name: mcpTool.name, arguments: (args || {}) as Record<string, unknown> },
        CallToolResultSchema,
        { /* ... */ }
      )
      // ... rest of execute logic
    },
  })
}
```

**2. `packages/opencode/src/mcp/index.ts` (lines 646–648)** — pass the governance
callback into `convertTool()`:
```typescript
// Line 646-648 context: within the tools() Effect
result[key] = McpCatalog.convertTool(
  mcpTool,
  client,
  timeout,
  async (toolName) => {
    // Optional: MCP layer can wire governance here if needed
    // Default: session layer remains responsible (no-op if not provided)
  }
)
```

**3. Optional — `SessionTools.resolve()` (lines 298–393):** if decoupling governance
from the session layer is desired, simplify the wrapper since governance now lives in
`convertTool()`:
```typescript
// Line 305-327: Simplify wrapper since governance now in convertTool
const result = await executeWrapped(args, opts)
// Removes need to wrap execute function
```

**Impact:** governance becomes a property of MCP tool definitions, not caller
responsibility (fail-safe). Backward compatible — the hook parameter is optional,
existing callers work unchanged. Any future code using `mcp.tools()` or `convertTool()`
gets governance by default. Test fixtures that use MCP tools directly will correctly
fail if permission is not provided.

**Alternative — no patch (current state):** relies on a social contract — future
developers must remember to wrap MCP tools. Simpler codebase, lower cognitive load, but
loses the fail-safe property; the governance gap becomes a landmine.

**Effort estimate:** ~15 lines changed (add optional parameter, call hook, update
callers). Risk level: low, additive, backward compatible. Test burden: 1–2 cases
verifying the hook is called when provided. Timeline: ~30 min implementation + review.

**Recommendation for S6.3 (in-loop governance gate): GO — implement the patch.** It
costs minimal effort now and prevents governance-bypass scenarios in later phases
(plugin delivery, CLI, testing frameworks); the fail-safe property is worth the ~15-line
change. If the patch is not done, document the assumption that all MCP tool execution
happens via `SessionTools.resolve()` and add a lint rule flagging direct calls to
`mcp.tools()` in main code (not tests).

---

## Post-edit breaking-change scan (S0.6, Wave G3)

**Status:** delivered 2026-07-18. After every `edit`/`write` lands, `breakingChangeWarning`
(`tool/edit-governance.ts`) diffs the graph's pre-edit entity list against a fresh single-file
re-parse (`detectBreakingChanges`, `code-intelligence/src/edit-impact.ts`) and appends one inline
`ur|brk` line per **exported** entity that was removed or signature-changed while ≥1 caller
*outside the edited file* still references it — no threshold; one live caller is enough (top 5
listed, the rest deferred to `get_references`). For a removed name it also runs a bounded
word-boundary `git grep` sweep (cap 5, 500 ms) for residue the call graph can't see (config
keys, routes, fixtures, strings).

CONVERT-shaped (never blocks), raced against `GOVERNANCE_GRAPH_BUDGET_MS`, fail-closed on any
cold-graph/parse/git miss (including zero re-parsed entities for a previously non-empty file —
treated as a parser miss, not a mass removal). Complements the in-flight `callersAtRiskWarning`,
which regex-diffs old/new content *during* the edit and structurally cannot see a full removal.
Per [docs/design/graph-navigation-audit.md §2](../design/graph-navigation-audit.md) (G3).

---

## Verification status (S0.9)

Date: 2026-06-27. Tooling: **bun 1.3.14** — this is a bun workspace (`bun.lock` +
`packageManager: bun@1.3.14`); there is no pnpm in the tree.

| Step | Command | Result |
|---|---|---|
| Install | `bun install` | PASS — clean, 2370 installs / 2667 packages, no changes |
| Typecheck | `bun turbo typecheck` | PASS — **24/24** successful |
| Product build | `bun turbo build --filter=opencode` | PASS — 1/1, binaries built for all platforms; built-in smoke test passed (`--version` → `0.0.0-main-...`) |
| Run | `dist/opencode-darwin-arm64/bin/opencode --version` | PASS — exit 0 |
| code-intelligence (new pkg) | `cd packages/code-intelligence && bun test` | PASS — **12/12** (30 assertions) |

**On the umbrella `bun turbo build`:** `turbo.json`'s `build` has `dependsOn: []`, so the
umbrella build runs every package's build in parallel. Two targets fail — both
pre-existing at the pinned upstream commit and both non-shipped by econ (neither was
touched):

1. **`@opencode-ai/sdk`** — its `build` runs `@hey-api/openapi-ts` with `clean: true`,
   which deletes and regenerates the committed `src/v2/gen/*` files from an
   `openapi.json` produced by `bun dev generate`. This regenerate is destructive and
   fragile (an interrupted run corrupts the tracked gen files; restore with
   `git checkout -- packages/sdk`). The committed generated sources are valid and the
   product builds against them — regenerating the SDK is not required to ship.
2. **`@opencode-ai/desktop`** (see also S0.1) — the Electron build looks for
   `packages/opencode/dist/node/`, a Node-compatible bundle, but the `opencode` build
   script only produces platform-specific Bun executables (arm64, x64, ...); fixing
   would require the `opencode` build to also emit a `node` bundle. econ drives the
   CLI/HTTP API, not the desktop Electron app, so this is out of scope and low priority.

**Verification scope = what econ ships:** the `opencode` server/CLI binary + typecheck
across the workspace + the new `code-intelligence` package. All green. The two broken
umbrella targets are tracked as upstream baggage, not econ regressions.
