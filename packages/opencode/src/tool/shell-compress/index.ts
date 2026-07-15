/**
 * Shell output compression pipeline.
 * Wires: ANSI-strip → redact → git-status fast-path → cloud-CLI parser → user-filter DSL →
 * classify → strategy dispatch → omni fallback.
 *
 * Port of unerr-cli src/proxy/shell-compressor.ts — telemetry wired to _shared meter,
 * graph-boost gated on unerrd daemon presence (no-op when absent).
 *
 * Strategies now live (Sprint 1B):
 *   git_status, tabular, test_results, log_text, diff, structured, key_value,
 *   error_diagnostic, yaml, tree_paths, progress_streaming, cloud (aws/gcp/azure/kubectl).
 *
 * PRE-CLASSIFY TRANSFORMS: redact strips credential shapes (API keys, bearer tokens,
 * passwords, AWS keys, connection strings) right after ANSI-strip, before anything else
 * sees the text. The user filter DSL reads repo-local `.econ/filters.toml` + global
 * `~/.config/econ/filters.toml` (first-matching-filter-wins) right before classify;
 * missing config files are a no-op.
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
import { compressCloud } from "./strategies/cloud"
import { applyUserFilter } from "./strategies/filter-dsl"
import { compressGitStatus } from "./strategies/git-status"
import { compressKeyValue } from "./strategies/key-value"
import { compressLogText } from "./strategies/log-text"
import { compressMultiRegion } from "./strategies/multi-region"
import { compressOmni } from "./strategies/omni"
import { compressProgress } from "./strategies/progress"
import { redactOutput } from "./strategies/redact"
import { compressStructured } from "./strategies/structured"
import { compressTabular } from "./strategies/tabular"
import { compressTestResults } from "./strategies/test-results"
import { compressTreePaths } from "./strategies/tree-paths"
import { compressYaml } from "./strategies/yaml"
import { compressDiff } from "./strategies/diff"
import { compressErrorDiagnostic } from "./strategies/error-diagnostic"
import { isDaemonAvailable, buildDiffRiskMap } from "./strategies/graph-boost"
import { createCompressionQualityMonitor } from "./quality-monitor"
import type { CompressionQualityMonitor } from "./quality-monitor"

const CONFIDENCE_GATE = 0.7

/**
 * Signals below this ratio are worth feedback-tracking: a passthrough or
 * near-passthrough compression can't have hidden anything, so a re-run after
 * one must not count as an over-compression signal.
 */
const QUALITY_TRACK_RATIO = 0.9

let qualityMonitorInstance: CompressionQualityMonitor | undefined

/**
 * Shared quality monitor for the shell compression path — one instance per
 * process so over-compression signals accumulate across commands. shell.ts
 * reports every command execution here; this module records compressions and
 * consults conservative mode before picking a lossy strategy.
 *
 * @sem domain=tool role=quality-monitor
 */
export function shellQualityMonitor(): CompressionQualityMonitor {
  if (!qualityMonitorInstance) qualityMonitorInstance = createCompressionQualityMonitor()
  return qualityMonitorInstance
}

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

export function applyStrategy(
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
 * @param cwd      - working directory for the user filter DSL config lookup
 *                   (`.econ/filters.toml`); defaults to process.cwd()
 */
export function compressShellOutput(
  command: string,
  stdout: string,
  stderr?: string,
  exitCode?: number,
  cwd?: string,
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

  // Redact credential shapes (API keys, bearer tokens, passwords, AWS keys, connection
  // strings) before anything downstream sees the text.
  const stripped = redactOutput(stripAnsiCodes(raw))

  // Dedicated git status fast-path (bypasses classifier; ~70-85% savings)
  if (/^\s*git\s+status\b/.test(command)) {
    const gitOut = compressGitStatus(stripped)
    if (gitOut) {
      const meta = withMeta(raw, gitOut)
      recordToolCall({ tool: "shell", ...meta })
      if (meta.ratio < QUALITY_TRACK_RATIO) {
        // Fast path bypasses the classifier; git status compresses via the key_value parser.
        shellQualityMonitor().recordCompression({
          command,
          category: "key_value",
          confidence: 1,
          rawTokens: meta.raw_tokens,
          returnedTokens: meta.returned_tokens,
          ratio: meta.ratio,
          timestamp: Date.now(),
        })
      }
      return { text: gitOut, meta }
    }
  }

  // Cloud-CLI parser fast-path (AWS/GCP/Azure/kubectl/docker-inspect) — tried before
  // generic classification for cloud commands.
  const cloudOut = compressCloud(stripped, command)
  if (cloudOut) {
    const meta = withMeta(raw, cloudOut)
    recordToolCall({ tool: "shell", ...meta })
    if (meta.ratio < QUALITY_TRACK_RATIO) {
      shellQualityMonitor().recordCompression({
        command,
        category: "structured",
        confidence: 1,
        rawTokens: meta.raw_tokens,
        returnedTokens: meta.returned_tokens,
        ratio: meta.ratio,
        timestamp: Date.now(),
      })
    }
    return { text: cloudOut, meta }
  }

  // User filter DSL — repo-local .econ/filters.toml + global ~/.config/econ/filters.toml,
  // first-matching-filter-wins, applied before classify. No-op when no filter matches or
  // neither config file exists.
  const userFiltered = applyUserFilter(command, stripped, cwd ?? process.cwd())
  if (userFiltered) {
    const meta = withMeta(raw, userFiltered.text)
    recordToolCall({ tool: "shell", ...meta })
    if (meta.ratio < QUALITY_TRACK_RATIO) {
      shellQualityMonitor().recordCompression({
        command,
        category: "log_text",
        confidence: 1,
        rawTokens: meta.raw_tokens,
        returnedTokens: meta.returned_tokens,
        ratio: meta.ratio,
        timestamp: Date.now(),
      })
    }
    return { text: userFiltered.text, meta }
  }

  const classification = classifyShellOutput(command, stripped)

  let text: string
  if (classification.non_silent_segments > 1) {
    // Composite command (e.g. `a && b && c`) — matchCommandHint can only pick
    // ONE category for the whole interleaved output, so any single-category
    // strategy would keep the recognized segment and drop the rest. Try the
    // region-aware split first (each contiguous same-category region gets its
    // own strategy); fall back to the dedup-only omni path, which preserves
    // every line, when the split isn't confident enough to be worth it.
    text = compressMultiRegion(stripped, command, exitCode) ?? compressOmni(stripped)
  } else if (shellQualityMonitor().isConservative(classification.category)) {
    // The quality monitor saw repeated re-runs right after this category's
    // compressions — back off to the dedup-only omni path until the good
    // streak decays conservative mode.
    text = compressOmni(stripped)
  } else if (classification.confidence < CONFIDENCE_GATE) {
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
  // Composite commands already route through the dedup-only omni path above,
  // which never inflates, so this only needs to guard single-segment results.
  if (
    classification.non_silent_segments <= 1 &&
    classification.category === "test_results" &&
    text.length > stripped.length
  ) {
    text = stripped
  }

  const meta = withMeta(raw, text)
  recordToolCall({ tool: "shell", ...meta })
  if (meta.ratio < QUALITY_TRACK_RATIO) {
    shellQualityMonitor().recordCompression({
      command,
      category: classification.category,
      confidence: classification.confidence,
      rawTokens: meta.raw_tokens,
      returnedTokens: meta.returned_tokens,
      ratio: meta.ratio,
      timestamp: Date.now(),
    })
  }
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
  cwd?: string,
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

  const stripped = redactOutput(stripAnsiCodes(raw))

  if (/^\s*git\s+status\b/.test(command)) {
    const gitOut = compressGitStatus(stripped)
    if (gitOut) {
      const meta = withMeta(raw, gitOut)
      recordToolCall({ tool: "shell", ...meta })
      return { text: gitOut, meta }
    }
  }

  const cloudOut = compressCloud(stripped, command)
  if (cloudOut) {
    const meta = withMeta(raw, cloudOut)
    recordToolCall({ tool: "shell", ...meta })
    return { text: cloudOut, meta }
  }

  const userFiltered = applyUserFilter(command, stripped, cwd ?? process.cwd())
  if (userFiltered) {
    const meta = withMeta(raw, userFiltered.text)
    recordToolCall({ tool: "shell", ...meta })
    return { text: userFiltered.text, meta }
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
  return compressShellOutput(command, stdout, stderr, exitCode, cwd)
}
