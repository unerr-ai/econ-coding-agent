/**
 * Convention auto-detection layer: infers project-level coding rules from
 * sample source snippets so the agent can adopt them without manual
 * configuration — reducing hallucinated style drift across sessions.
 *
 * @sem domain=intelligence role=analysis
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single detected convention with a human-readable description and a
 * confidence score so callers can threshold weak signals from strong ones.
 *
 * @sem domain=intelligence role=analysis
 */
export interface ConventionRule {
  id: string
  description: string
  confidence: number
}

/**
 * Surface for pluggable convention-detection strategies; implementations
 * receive raw source samples and return zero or more typed rules.
 *
 * @sem domain=intelligence role=analysis
 */
export interface ConventionDetector {
  detect(samples: string[]): ConventionRule[]
}

// ---------------------------------------------------------------------------
// detectConventions
// ---------------------------------------------------------------------------

/**
 * Inspects an array of source-file snippets and returns the coding conventions
 * that appear consistently across them, giving downstream prompts a concise
 * style brief rather than requiring the model to re-infer rules each turn.
 *
 * @sem domain=intelligence role=analysis
 */
export function detectConventions(samples: string[]): ConventionRule[] {
  // TODO: infer conventions from sample sources — detect import order,
  // naming conventions, brace style, async patterns, etc. — once the
  // tree-sitter AST surface is available at runtime.
  void samples
  return []
}
