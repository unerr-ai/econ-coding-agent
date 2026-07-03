/**
 * Live trace source that shells out to the built econ binary
 * (`opencode run "<prompt>" --format json`) and maps its NDJSON event
 * stream into a LoopTrace. Requires the binary to be built and live model
 * credentials configured for the `opencode` CLI — only ever invoked
 * explicitly via the `loop-live` script, never in default test/CI.
 * @sem domain=eval role=provider
 */

import type { LoopCase, LoopTrace, ToolCallRecord } from "./loop-types.js"

/** Default path to the built econ binary (darwin-arm64 dist output). */
export const DEFAULT_BINARY_PATH = "packages/opencode/dist/opencode-darwin-arm64/bin/opencode"

interface RunJsonTextEvent {
  type: "text"
  part?: { text?: string }
}

interface RunJsonToolUseEvent {
  type: "tool_use"
  part?: { tool?: string; state?: { input?: Record<string, unknown> } }
}

/**
 * Runs one case's prompt through the built `opencode` binary in
 * `--format json` mode and parses its NDJSON stdout into a LoopTrace.
 *
 * Field mapping — only what the JSON stream actually carries, nothing
 * faked:
 *  - `textParts`  <- "text" events' `part.text` (final/completed text
 *    parts, in stream order — matches has_meta_plan's opening-text check).
 *  - `toolCalls`  <- "tool_use" events' `{ name: part.tool, input:
 *    part.state.input }` (covers the todowrite/task calls the scorer reads
 *    for used_task_list / delegated_when_expected / verified_nontrivial).
 * The stream carries no other signal the scorer consumes, so no field here
 * is best-effort or approximated.
 *
 * If the binary is missing, fails to spawn, or exits non-zero, returns an
 * empty trace with a "[run-failed]" marker as its only text part — every
 * applicable signal then scores false, so the case is a scored miss
 * instead of crashing the eval run.
 */
export async function binaryTraceSource(loopCase: LoopCase, binaryPath: string = DEFAULT_BINARY_PATH): Promise<LoopTrace> {
  let stdout: string
  let exitCode: number
  try {
    const proc = Bun.spawn([binaryPath, "run", loopCase.prompt, "--format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    stdout = out
    exitCode = code
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "")
      console.error(`loop-live: "${binaryPath} run" exited ${exitCode} for case "${loopCase.id}": ${stderr}`)
    }
  } catch (err) {
    console.error(`loop-live: failed to spawn "${binaryPath}" for case "${loopCase.id}":`, err)
    return { textParts: ["[run-failed]"], toolCalls: [] }
  }

  if (exitCode !== 0) {
    return { textParts: ["[run-failed]"], toolCalls: [] }
  }

  const textParts: string[] = []
  const toolCalls: ToolCallRecord[] = []

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let event: RunJsonTextEvent | RunJsonToolUseEvent | { type: string }
    try {
      event = JSON.parse(trimmed) as RunJsonTextEvent | RunJsonToolUseEvent | { type: string }
    } catch {
      continue // non-JSON stdout line — skip rather than abort the eval
    }

    if (event.type === "text") {
      const text = (event as RunJsonTextEvent).part?.text
      if (typeof text === "string") textParts.push(text)
    }

    if (event.type === "tool_use") {
      const part = (event as RunJsonToolUseEvent).part
      if (part?.tool) toolCalls.push({ name: part.tool, input: part.state?.input })
    }
  }

  return { textParts, toolCalls }
}
