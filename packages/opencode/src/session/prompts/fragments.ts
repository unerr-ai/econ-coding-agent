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
  if (ids.length > 1)
    notes.push(
      "- Batch independent tool calls into the same response — reads of different files, parallel searches, independent commands. One call per turn wastes a full round trip.",
    )
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
