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
// model acted on. Two shapes: (a) an errored non-bash tool — the edit's
// oldString is not in the file, the file/path does not exist, a governance
// gate denied the action — i.e. the world disagreed with the model's mental
// state; (b) a zero-result lookup from a search-class tool — the model
// searched for something it believed existed. These are exactly the forks
// where the case 1A/1B decodes showed the muted conductor anchoring: it
// re-queried or retried mechanically instead of revising the hypothesis.
const SEARCH_CLASS_TOOLS = new Set(["search", "grep", "glob"])
const EMPTY_LOOKUP_RE = /^no (?:files|matches|results|entities)\b/i

function isContradictionResult(toolName: string, output: any): boolean {
  if (output?.type === "error-text") return true
  if (!SEARCH_CLASS_TOOLS.has(toolName)) return false
  const text = extractToolText(output)
  if (text === undefined) return false
  const trimmed = text.trim()
  return trimmed === "" || trimmed === "[]" || EMPTY_LOOKUP_RE.test(trimmed)
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
      if (!contradiction && isContradictionResult(part.toolName, part.output)) contradiction = true
    }
  }

  if (contradiction) {
    delete options.reasoningEffort
    return "contradiction"
  }

  return undefined
}
