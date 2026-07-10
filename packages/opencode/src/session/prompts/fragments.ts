// Single source of the tool-call batching doctrine — composed into the tool block below, all six persona deltas (personas.ts), and the conductor delta (roles.ts).
// L1.2b (turn-cache-economics.md §5-L1): the earlier advisory phrasing was ignored by the default
// tier (266/267 messages single-call) — failure-taxonomy learning: a RULE with a consequence and a
// self-check steers this tier; advice does not. Hence the count-your-calls form below.
export const BATCH_RULE =
  "RULE: before sending, count your tool calls. If this message has ONE tool call and another independent read/search/command is already known to be needed, you are wasting a full round trip — add it to THIS message. Independent = neither call needs the other's output; example: reading a file AND running its tests = two calls, ONE message. Only a dependency chain — the next call needs this call's output — justifies a single-call message."

// L2.3 (turn-cache-economics.md §5-L2 item 3, §7 protected-region row) — the context-eviction
// contract, ported from CC: step-granular masking/pruning clears old tool outputs mid-run, and a
// model that was never told treats a cleared result as a surprise and re-reads the file — spending
// the steps the eviction saved. Environment fact + one imperative, in the same rule register as
// BATCH_RULE. Composed into the tool block below so it reaches every tier and persona that runs a
// tool loop (the conductor included) from the one source.
export const EVICTION_RULE =
  "As the session grows, older tool results may be cleared from your context mid-session — replaced by `[Old tool result content cleared]` or a one-line summary. Carry the facts you still need forward in your own words (paths, symbols, key output lines, conclusions) as you work, instead of planning to re-read a result later."

// L3.3 (turn-cache-economics.md §5-L3 item 3) — verify-once discipline, CC's line ported. Hard
// runs spend 12–21 steps re-running suites that already passed (11964 ran the same variants 12×,
// 11885 21×), and controlled studies show most re-verification buys nothing. RULE register on
// purpose: the failure-mode overhaul showed rules steer this tier, advice does not. Gated on
// `bash` in the tool block below — an agent that cannot run commands has no re-verify failure
// mode to guard against.
export const VERIFY_ONCE =
  "RULE: verify once, at the finish line. Do not re-run a test suite that already passed unless a file has changed since that run — a second green proves nothing new and wastes a step. One green run of the full relevant suite IS the finish line, not N runs of it."

// Generate the authoritative tool-usage section from the live advertised tool set (Sprint 5b §10.1).
// This is the single source of truth: the prompt can never name a tool the model isn't given, which
// closes the prompt↔tool drift class (the grep/glob coupling) permanently. The full per-tool schema
// is already sent in the API `tools` field, so this block stays lean — it enumerates the canonical
// ids and adds only econ-specific usage the model must follow, each note gated on its tool's presence.
export function toolUsage(toolIds: readonly string[]): string {
  const ids = [...new Set(toolIds)].sort()
  if (ids.length === 0) return ""
  const has = (id: string) => ids.includes(id)
  const notes: string[] = []
  // Hard rule first: reading/searching/listing code is what the read tools are for; bash is only
  // for running things. An OSS model left to its own habits reaches for `bash find/grep/cat/ls` —
  // that path is denied for reads here, so state the boundary as NEVER, not a preference. Gated on
  // `bash` too (OL-9.2a): an agent with no bash tool at all (e.g. the explorer persona) has no
  // failure mode this note guards against, so it's dropped to keep that agent's prompt lean.
  if ((has("read") || has("search") || has("file_outline")) && has("bash"))
    notes.push(
      "- To read, search, or list code you use the read tools — never `bash`. `bash` is only for running things (build, test, git, scripts); it is not a way to read files, search text, or list directories. Reaching for `bash cat/ls/find/grep/wc` to inspect code is wrong even when it would work.",
    )
  if (has("search"))
    notes.push(
      "- `search` is how you find anything: a plain phrase describing what you need returns the relevant code in one shot (start any unfamiliar task here), or pass `mode` for exact text (`literal`/`regex`), filenames (`glob`), or a symbol's callers/callees (`refs`).",
    )
  if (has("read"))
    notes.push(
      "- `read` returns a file with line numbers; pass `entity` to get just one symbol (a function or class) instead of the whole file, and `offset`/`limit` to page a large file.",
    )
  if (has("file_outline"))
    notes.push(
      "- `file_outline` lists a file's entities (name, kind, line range) and imports — call it before reading a large file to jump straight to the part you need.",
    )
  if (has("webfetch"))
    notes.push(
      "- `webfetch` returns compressed, relevance-ranked passages — pass a `prompt` to focus the ranking and page with `cache_ref` at near-zero cost.",
    )
  if (has("edit"))
    notes.push(
      "- `edit` replaces `oldString` with `newString`: `oldString` must reproduce the target byte-for-byte (exact whitespace and indentation) as ONE contiguous block — never elide the middle with `...`; include enough surrounding context that exactly one span matches (or set `replaceAll` for a deliberate rename). An ambiguous, non-contiguous, or partial `oldString` is rejected.",
    )
  if (has("write"))
    notes.push(
      "- `write` creates a new file or replaces a whole file — use it for a new file, or when a change is large enough that a full rewrite is cleaner than a partial `edit`; never leave a placeholder like `// ... unchanged` in what you write.",
    )
  // OL-9.4a — batching: live-run evidence showed 47/70 turns carrying exactly one tool call, so
  // every independent read became its own round trip. Gated on having more than one tool at all —
  // a single-tool agent has nothing to batch.
  if (ids.length > 1) notes.push(`- ${BATCH_RULE}`)
  // L3.3 — verify-once rides every bash-holding prompt: only an agent that can run commands
  // can burn steps re-proving a green result.
  if (has("bash")) notes.push(`- ${VERIFY_ONCE}`)
  // L2.3 — the eviction contract rides every tool-holding prompt, single-tool agents included:
  // masking clears completed tool results regardless of how many tools the agent holds.
  notes.push(`- ${EVICTION_RULE}`)
  return [
    "# Available tools",
    `You have exactly these tools, and no others — call each by its exact id: ${ids.join(", ")}.`,
    ...(notes.length
      ? [
          "The full description of each tool is supplied in the API tools field. econ-specific usage you must follow:",
          ...notes,
        ]
      : []),
    "Never call a tool whose id is not in the list above.",
  ].join("\n")
}
