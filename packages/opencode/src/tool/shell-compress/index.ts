/**
 * Shell output compression pipeline.
 * Wires: ANSI-strip → stderr-merge → git-status fast-path → classify → strategy dispatch → omni fallback.
 *
 * Port of unerr-cli src/proxy/shell-compressor.ts — telemetry wired to _shared meter,
 * graph-boost gated on unerrd daemon presence (no-op when absent).
 *
 * Strategies now live (Sprint 1B):
 *   git_status, tabular, test_results, log_text, diff, structured, key_value,
 *   error_diagnostic, yaml, tree_paths, progress_streaming.
 *
 * STDERR-MERGE: when shell.ts supplies separate stderr (shouldMergeStderr commands —
 * tsc/cargo/pytest/eslint/go/gradle/mvn/webpack/vite/esbuild/terraform/…), stderr is
 * folded into stdout with line-level dedup before classify, so compiler errors that
 * land on stderr are compressed by the error_diagnostic strategy rather than passing
 * through as a separate blob.
 *
 * @sem domain=tool role=compressor
 */

import type { ToolMeta } from "../_shared"
import { recordToolCall, withMeta } from "../_shared"
import type { OutputCategory } from "./classifier"
import { classifyShellOutput } from "./classifier"
import { compressGitStatus } from "./strategies/git-status"
import { compressKeyValue } from "./strategies/key-value"
import { compressLogText } from "./strategies/log-text"
import { compressOmni } from "./strategies/omni"
import { compressProgress } from "./strategies/progress"
import { compressStructured } from "./strategies/structured"
import { compressTabular } from "./strategies/tabular"
import { compressTestResults } from "./strategies/test-results"
import { compressTreePaths } from "./strategies/tree-paths"
import { compressYaml } from "./strategies/yaml"
import { compressDiff } from "./strategies/diff"
import { compressErrorDiagnostic } from "./strategies/error-diagnostic"
import { isDaemonAvailable, buildDiffRiskMap } from "./strategies/graph-boost"

const CONFIDENCE_GATE = 0.7

/**
 * Result of compressing one command's captured output.
 * meta is the shared ToolMeta contract (raw_tokens, returned_tokens, ratio).
 */
export interface ShellCompressResult {
  text: string
  meta: ToolMeta
}

// ---------------------------------------------------------------------------
// STDERR-MERGE
// ---------------------------------------------------------------------------

/**
 * Commands that typically emit diagnostics on stderr.
 * When both stdout and stderr are available separately, we fold stderr into
 * stdout with line-level dedup so error_diagnostic can group them as one stream.
 */
const MERGE_STDERR_RE =
  /\b(tsc|typescript|cargo\s+(?:build|check|test|clippy)|pytest|py\.test|python\s+-m\s+pytest|eslint|biome|go\s+(?:build|test|vet)|gradle(?:w)?|mvn|mvnw|webpack|vite\s+build|esbuild|rollup|terraform\s+(?:plan|apply|validate)|golangci-lint|mypy|pyright|ruff|flake8|pylint|javac|kotlinc|dotnet\s+build|cmake|ninja|make)\b/i

/**
 * Returns true when stderr should be merged into stdout before classification.
 * Covers the ~30 compile/test/lint commands whose diagnostics land on stderr.
 */
export function shouldMergeStderr(command: string): boolean {
  return MERGE_STDERR_RE.test(command)
}

/**
 * Merge stdout and stderr with line-level deduplication.
 * Lines that appear in both streams (e.g. echoed command prefixes) are emitted once.
 * Preserves order: stdout lines first, then stderr-only lines appended.
 */
function mergeWithDedup(stdout: string, stderr: string): string {
  if (!stderr.trim()) return stdout
  const stdoutLines = stdout.split("\n")
  const stderrLines = stderr.split("\n")
  const stdoutSet = new Set(stdoutLines.map((l) => l.trimEnd()))
  const extra = stderrLines.filter((l) => !stdoutSet.has(l.trimEnd()))
  if (extra.length === 0) return stdout
  return stdoutLines.concat(extra).join("\n")
}

// ---------------------------------------------------------------------------
// ANSI / token helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences (CSI + OSC). No external dep. */
function stripAnsiCodes(text: string): string {
  const esc = String.fromCharCode(27)
  const bel = String.fromCharCode(7)
  const csi = new RegExp(`${esc}\\[[0-9;?]*[\\w~]`, "g")
  const osc = new RegExp(`${esc}\\][^${bel}]*${bel}`, "g")
  return text.replace(csi, "").replace(osc, "")
}

// ---------------------------------------------------------------------------
// Strategy dispatch
// ---------------------------------------------------------------------------

function applyStrategy(
  category: OutputCategory,
  stripped: string,
  command: string,
  exitCode?: number,
): string {
  switch (category) {
    case "tabular":
      return compressTabular(stripped, command)
    case "log_text":
      return compressLogText(stripped, command)
    case "test_results":
      return compressTestResults(stripped, command, exitCode)
    case "diff":
      return compressDiff(stripped, undefined, command)
    case "structured":
      return compressStructured(stripped, command)
    case "key_value":
      return compressKeyValue(stripped, command)
    case "error_diagnostic":
      return compressErrorDiagnostic(stripped, command)
    case "yaml":
      return compressYaml(stripped, command)
    case "tree_paths":
      return compressTreePaths(stripped, command)
    case "progress_streaming":
      return compressProgress(stripped, command)
    default:
      return stripped
  }
}

// ---------------------------------------------------------------------------
// Graph-risk boost for diff (gated)
// ---------------------------------------------------------------------------

/**
 * If the unerrd daemon is available and the command looks like a diff,
 * annotate diff hunks with fan-in risk from the graph.
 * Falls through to the plain diff strategy on any failure.
 *
 * TODO(econ-graph-boost): wire buildDiffRiskMap → UDS proxy query once the
 * unerrd sidecar is available from the econ backend context.
 */
async function applyDiffWithGraphBoost(stripped: string, command: string): Promise<string> {
  if (!isDaemonAvailable()) {
    return compressDiff(stripped, undefined, command)
  }
  try {
    const risks = await buildDiffRiskMap(stripped)
    return compressDiff(stripped, risks, command)
  } catch {
    return compressDiff(stripped, undefined, command)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compress captured shell output using command-aware strategy selection.
 * Call after capture, before the existing truncate step in shell.ts run().
 *
 * @param command  - the shell command string (for classification hints)
 * @param stdout   - captured stdout (ANSI stripping done here)
 * @param stderr   - captured stderr, if available separately; merged when
 *                   shouldMergeStderr(command) returns true
 * @param exitCode - process exit code; passed to test_results for safe short-circuit
 */
export function compressShellOutput(
  command: string,
  stdout: string,
  stderr?: string,
  exitCode?: number,
): ShellCompressResult {
  // Merge stderr into stdout when appropriate (compile/test commands)
  const raw =
    stderr && shouldMergeStderr(command)
      ? mergeWithDedup(stdout, stderr)
      : stderr
        ? `${stdout}${stderr ? "\n" + stderr : ""}`
        : stdout

  // Empty output — nothing to compress
  if (!raw.trim()) {
    return { text: raw, meta: withMeta(raw, raw) }
  }

  // Binary output (contains null bytes) — pass through verbatim
  if (raw.indexOf(String.fromCharCode(0)) !== -1) {
    const meta = withMeta(raw, raw)
    return { text: raw, meta }
  }

  const stripped = stripAnsiCodes(raw)

  // Dedicated git status fast-path (bypasses classifier; ~70-85% savings)
  if (/^\s*git\s+status\b/.test(command)) {
    const gitOut = compressGitStatus(stripped)
    if (gitOut) {
      const meta = withMeta(raw, gitOut)
      recordToolCall({ tool: "shell", ...meta })
      return { text: gitOut, meta }
    }
  }

  const classification = classifyShellOutput(command, stripped)

  let text: string
  if (classification.confidence < CONFIDENCE_GATE) {
    // Low confidence: try best-guess strategy AND omni, pick whichever compresses more
    const omniResult = compressOmni(stripped)
    let strategyResult: string | null = null
    try {
      strategyResult = applyStrategy(classification.category, stripped, command, exitCode)
    } catch {
      // strategy threw — fall back to omni
    }
    if (strategyResult && strategyResult.length < stripped.length * 0.8) {
      const stratRatio = strategyResult.length / stripped.length
      const omniRatio = omniResult.length / stripped.length
      text = stratRatio <= omniRatio * 1.1 ? strategyResult : omniResult
    } else {
      text = omniResult
    }
  } else {
    text = applyStrategy(classification.category, stripped, command, exitCode)
  }

  // Safety net: test_results must never inflate (misclassified minified JSON etc.)
  if (classification.category === "test_results" && text.length > stripped.length) {
    text = stripped
  }

  const meta = withMeta(raw, text)
  recordToolCall({ tool: "shell", ...meta })
  return { text, meta }
}

/**
 * Async variant that enables graph-risk boost for diff output.
 * Falls back to compressShellOutput when graph is unavailable or on error.
 * Use this variant from shell.ts when an async context is available.
 *
 * TODO(econ-graph-boost): adopt this variant in shell.ts once the Effect.gen
 * context allows Promise.resolve integration (or wrap in Effect.promise).
 */
export async function compressShellOutputAsync(
  command: string,
  stdout: string,
  stderr?: string,
  exitCode?: number,
): Promise<ShellCompressResult> {
  const raw =
    stderr && shouldMergeStderr(command)
      ? mergeWithDedup(stdout, stderr)
      : stderr
        ? `${stdout}${stderr ? "\n" + stderr : ""}`
        : stdout

  if (!raw.trim()) return { text: raw, meta: withMeta(raw, raw) }
  if (raw.indexOf(String.fromCharCode(0)) !== -1) {
    const meta = withMeta(raw, raw)
    return { text: raw, meta }
  }

  const stripped = stripAnsiCodes(raw)

  if (/^\s*git\s+status\b/.test(command)) {
    const gitOut = compressGitStatus(stripped)
    if (gitOut) {
      const meta = withMeta(raw, gitOut)
      recordToolCall({ tool: "shell", ...meta })
      return { text: gitOut, meta }
    }
  }

  const classification = classifyShellOutput(command, stripped)

  // Graph-risk boost for diff category
  if (classification.category === "diff" && classification.confidence >= CONFIDENCE_GATE) {
    const text = await applyDiffWithGraphBoost(stripped, command)
    const meta = withMeta(raw, text)
    recordToolCall({ tool: "shell", ...meta })
    return { text, meta }
  }

  // Standard path
  return compressShellOutput(command, stdout, stderr, exitCode)
}
