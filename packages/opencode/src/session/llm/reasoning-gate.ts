import type { ModelMessage } from "ai"

// Jest/vitest-style failure signatures scanned in a trailing bash tool result's text.
const FAILURE_PATTERNS: RegExp[] = [
  /\bFAIL\b/,
  /suite failed to run/,
  /\b[1-9]\d* (failed|failing)\b/,
  /error TS\d+/,
  /npm ERR!|Command failed|non-zero exit|exit code [1-9]/i,
]

// Robustly pull the text out of a tool result's output, whatever shape the
// provider sent it in ({type:"text"}, {type:"error-text"}, or {type:"content"}).
function extractToolText(output: any): string | undefined {
  if (!output) return undefined
  if (output.type === "text" || output.type === "error-text") return output.value
  if (output.type === "content" && Array.isArray(output.value)) {
    return output.value
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text as string)
      .join("\n")
  }
  return undefined
}

function isBashFailure(output: any): boolean {
  if (!output) return false
  if (output.type === "error-text") return true
  const text = extractToolText(output)
  if (text === undefined) return false
  return text.includes("✕") || FAILURE_PATTERNS.some((pattern) => pattern.test(text))
}

// F4 — contradiction signatures: a tool result that falsifies the premise the
// model acted on. Three shapes: (a) an errored non-bash tool — the edit's
// oldString is not in the file, the file/path does not exist, a governance
// gate denied the action — i.e. the world disagreed with the model's mental
// state; (b) a zero-result lookup from a search-class tool — the model
// searched for something it believed existed; (c) a scoped search that
// SUCCEEDED (non-empty, no error) but found nothing inside the scope it
// named — "found things, but not where you looked" (rule 4b, scope-miss).
// (c) only fires when the originating query names an explicit scope (a path
// fragment, glob, or quoted symbol) and the result can be parsed defensively
// for the paths/names it references; any ambiguity recovering the query or
// parsing the result biases toward not firing. These are exactly the forks
// where the case 1A/1B decodes showed the muted conductor anchoring: it
// re-queried or retried mechanically instead of revising the hypothesis.
const SEARCH_CLASS_TOOLS = new Set(["search", "grep", "glob"])
const EMPTY_LOOKUP_RE = /^no (?:files|matches|results|entities)\b/i

// Scope-miss (F4b) support: recover the query a search-class tool ran with,
// pull an explicit scope token out of it, and check whether the (successful)
// result actually references anything under that scope.
const SCOPE_GLOB_RE = /\*\*?\/?[\w./*-]*/
const SCOPE_PATH_RE = /[\w.@-]*\/[\w./@-]+/
const SCOPE_QUOTED_RE = /[`'"]([\w$.-]+)[`'"]/

type ScopeToken = { value: string; kind: "path" | "glob" | "symbol" }

// Walk the full message history backward for the assistant tool-call part
// whose toolCallId matches this tool-result — that's the only place the
// original query/args live. Returns undefined (never guesses) if none found.
function resolveToolInput(messages: ModelMessage[], toolCallId: string): unknown {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) return part.input
    }
  }
  return undefined
}

// A scope token is only recognized when explicitly present in the query or an
// explicit scope/path/glob/pattern arg — no token means no scope-miss check.
function extractScopeToken(input: unknown): ScopeToken | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  const parts: string[] = []
  for (const key of ["scope", "path", "glob", "pattern", "query"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") parts.push(value)
  }
  const combined = parts.join(" ")
  if (!combined) return undefined
  const globMatch = combined.match(SCOPE_GLOB_RE)
  if (globMatch) return { value: globMatch[0], kind: "glob" }
  const pathMatch = combined.match(SCOPE_PATH_RE)
  if (pathMatch) return { value: pathMatch[0], kind: "path" }
  const quotedMatch = combined.match(SCOPE_QUOTED_RE)
  if (quotedMatch) return { value: quotedMatch[1], kind: "symbol" }
  return undefined
}

// Defensive parse of a search-class result for the file paths / entity names
// it references — a JSON array of objects (file/path/key/name fields), or
// plain text lines containing path-like fragments. Returns undefined on any
// ambiguity (nothing parsed) so the caller does not fire.
function extractResultPaths(text: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (Array.isArray(parsed)) {
    const paths: string[] = []
    for (const entry of parsed) {
      if (entry && typeof entry === "object") {
        for (const key of ["file", "path", "key", "name"] as const) {
          const value = (entry as Record<string, unknown>)[key]
          if (typeof value === "string") paths.push(value)
        }
      }
    }
    return paths.length > 0 ? paths : undefined
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const paths = lines.filter((line) => SCOPE_PATH_RE.test(line))
  return paths.length > 0 ? paths : undefined
}

function scopeTokenMatchesPaths(token: ScopeToken, paths: string[]): boolean {
  if (token.kind === "symbol") return paths.some((path) => path === token.value)
  if (token.kind === "glob") {
    const pattern = token.value
      .split("**")
      .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
      .join(".*")
    const regex = new RegExp(pattern)
    return paths.some((path) => regex.test(path))
  }
  return paths.some((path) => path.includes(token.value))
}

// The scope-miss check itself: recover the query, extract its scope token (if
// any), parse the result's referenced paths/names (if parseable), and fire
// only when both are recoverable and neither references the named scope.
function isScopeMissResult(messages: ModelMessage[], toolCallId: string, text: string): boolean {
  const input = resolveToolInput(messages, toolCallId)
  if (input === undefined) return false
  const scopeToken = extractScopeToken(input)
  if (!scopeToken) return false
  const paths = extractResultPaths(text)
  if (!paths) return false
  return !scopeTokenMatchesPaths(scopeToken, paths)
}

function isContradictionResult(toolName: string, output: any, messages: ModelMessage[], toolCallId: string): boolean {
  if (output?.type === "error-text") return true
  if (!SEARCH_CLASS_TOOLS.has(toolName)) return false
  const text = extractToolText(output)
  if (text === undefined) return false
  const trimmed = text.trim()
  if (trimmed === "" || trimmed === "[]" || EMPTY_LOOKUP_RE.test(trimmed)) return true
  return isScopeMissResult(messages, toolCallId, trimmed)
}

/**
 * Un-mutes thinking for one request when the turn's shape calls for judgement:
 * the turn's first (plan) step, the step right after a failed bash command
 * (recovery), or the step right after a tool result contradicted the model's
 * working premise (contradiction — F4's anti-anchoring trigger). Deletes the
 * muted conductor tier's `reasoningEffort:"none"` marker so the server-side
 * thinking default applies for exactly that request, leaving every other step
 * on the cheap non-thinking default. Recovery outranks contradiction when the
 * same trailing block carries both.
 *
 * @sem domain=routing role=gate
 */
export function applyAdaptiveReasoning(
  messages: ModelMessage[],
  options: Record<string, any>,
): "plan" | "recovery" | "contradiction" | undefined {
  // Only the conductor tier is muted this way (executor uses "low", oracle/reasoner
  // "high") — anything else passes through untouched.
  if (options.reasoningEffort !== "none") return undefined

  const last = messages[messages.length - 1]
  if (last?.role === "user") {
    delete options.reasoningEffort
    return "plan"
  }

  // Trailing contiguous block of tool-result messages, walking back from the end.
  let i = messages.length - 1
  while (i >= 0 && messages[i].role === "tool") i--
  const trailingTools = messages.slice(i + 1)

  let contradiction = false
  for (const message of trailingTools) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      if (part.toolName === "bash") {
        if (isBashFailure(part.output)) {
          delete options.reasoningEffort
          return "recovery"
        }
        continue
      }
      if (!contradiction && isContradictionResult(part.toolName, part.output, messages, part.toolCallId))
        contradiction = true
    }
  }

  if (contradiction) {
    delete options.reasoningEffort
    return "contradiction"
  }

  return undefined
}
