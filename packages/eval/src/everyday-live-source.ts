/**
 * Live sources for the everyday-capability eval (OL-7.12) — shell out to the
 * built econ binary to measure real trivial-turn latency, real
 * clarify-vs-guess traces run inside a test-poor fixture repo's directory,
 * and real multi-turn coherence across a compaction boundary via
 * `opencode run --session <id>` resumption. Requires the built binary + live
 * model credentials; NOT part of default test/CI — only ever invoked via
 * `everyday-live`, and refuses to run any live process unless the env gate
 * `ECON_EVAL_LIVE=1` is set (mirrors loop-live-source.ts's dry-run-by-default
 * posture, plus an explicit opt-in since this shells out against real
 * fixture repos on disk).
 * @sem domain=eval role=provider
 */

import type {
  ClarifyCase,
  CoherenceCase,
  EverydayCase,
  EverydayTurn,
  LatencyCase,
  ToolCallRecord,
} from "./everyday-types.js"
import { repoDir, TEST_POOR_REPOS } from "./test-poor-repos.js"

/** Default path to the built econ binary (darwin-arm64 dist output) — same default as loop-live-source.ts. */
export const DEFAULT_BINARY_PATH = "packages/opencode/dist/opencode-darwin-arm64/bin/opencode"

/** The env gate — live sources refuse to spawn anything unless this is exactly "1". */
export function liveRunEnabled(): boolean {
  return process.env["ECON_EVAL_LIVE"] === "1"
}

interface RunJsonEvent {
  type: string
  sessionID?: string
  part?: { text?: string; tool?: string; state?: { input?: Record<string, unknown> } }
}

function parseNdjson(stdout: string): RunJsonEvent[] {
  const events: RunJsonEvent[] = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as RunJsonEvent)
    } catch {
      continue // non-JSON stdout line — skip rather than abort the eval
    }
  }
  return events
}

function eventsToTurn(events: RunJsonEvent[], latencyMs: number): EverydayTurn {
  const textParts: string[] = []
  const toolCalls: ToolCallRecord[] = []
  for (const event of events) {
    if (event.type === "text" && typeof event.part?.text === "string") textParts.push(event.part.text)
    if (event.type === "tool_use" && event.part?.tool) toolCalls.push({ name: event.part.tool, input: event.part.state?.input })
  }
  return { textParts, toolCalls, latencyMs }
}

/** One `opencode run --format json` invocation; returns its parsed events, wall latency, and session id. */
async function spawnRun(
  binaryPath: string,
  prompt: string,
  opts: { cwd?: string; env?: Record<string, string | undefined>; session?: string } = {},
): Promise<{ events: RunJsonEvent[]; latencyMs: number; sessionID?: string }> {
  const args = [binaryPath, "run", prompt, "--format", "json"]
  if (opts.session) args.push("--session", opts.session)

  const start = performance.now()
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const latencyMs = performance.now() - start

  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text().catch(() => "")
    console.error(`everyday-live: "${binaryPath} run" exited ${code} for prompt "${prompt}": ${stderr}`)
  }

  const events = parseNdjson(out)
  const sessionID = events.find((e) => typeof e.sessionID === "string")?.sessionID
  return { events, latencyMs, sessionID }
}

/**
 * Live latency source: runs the same trivial prompt twice and measures real
 * wall latency for both runs (orchestration is unconditional in production
 * as of 2026-07-04, so both runs exercise the same decompose path — this
 * checks run-to-run latency stability rather than a mode delta). When the
 * env gate is off, returns the case unchanged (its canned numbers) so
 * callers can no-op safely.
 */
export async function binaryLatencySource(c: LatencyCase, binaryPath: string = DEFAULT_BINARY_PATH): Promise<LatencyCase> {
  if (!liveRunEnabled()) return c
  const baseline = await spawnRun(binaryPath, c.prompt)
  const decompose = await spawnRun(binaryPath, c.prompt)
  return { ...c, baselineLatencyMs: baseline.latencyMs, decomposeLatencyMs: decompose.latencyMs }
}

/** Live clarify source: runs the case's prompt with cwd set to its test-poor repo's fixture directory. */
export async function binaryClarifySource(c: ClarifyCase, binaryPath: string = DEFAULT_BINARY_PATH): Promise<ClarifyCase> {
  if (!liveRunEnabled()) return c
  const repo = TEST_POOR_REPOS.find((r) => r.id === c.repoId)
  if (!repo) throw new Error(`everyday-live: unknown repoId "${c.repoId}" for case "${c.id}"`)
  const { events, latencyMs } = await spawnRun(binaryPath, c.prompt, { cwd: repoDir(repo) })
  return { ...c, mockTrace: eventsToTurn(events, latencyMs) }
}

/**
 * Live coherence source: runs each turnPrompt in sequence inside the case's
 * test-poor repo, resuming the same session (`--session <id>`) captured from
 * the prior turn's event stream so the conversation — and any compaction
 * boundary the runtime triggers — is real, not simulated.
 */
export async function binaryCoherenceSource(c: CoherenceCase, binaryPath: string = DEFAULT_BINARY_PATH): Promise<CoherenceCase> {
  if (!liveRunEnabled()) return c
  const repo = TEST_POOR_REPOS.find((r) => r.id === c.repoId)
  if (!repo) throw new Error(`everyday-live: unknown repoId "${c.repoId}" for case "${c.id}"`)

  let sessionID: string | undefined
  const mockTurns: EverydayTurn[] = []
  for (const prompt of c.turnPrompts) {
    const { events, latencyMs, sessionID: nextSessionID } = await spawnRun(binaryPath, prompt, {
      cwd: repoDir(repo),
      session: sessionID,
    })
    sessionID = nextSessionID ?? sessionID
    mockTurns.push(eventsToTurn(events, latencyMs))
  }
  return { ...c, mockTurns }
}

/** Dispatches to the right live source by metric — the single entry point `everyday-live.ts` calls. */
export async function liveEverydaySource(c: EverydayCase, binaryPath: string = DEFAULT_BINARY_PATH): Promise<EverydayCase> {
  switch (c.metric) {
    case "trivial_latency":
      return binaryLatencySource(c, binaryPath)
    case "clarify_vs_guess":
      return binaryClarifySource(c, binaryPath)
    case "multiturn_coherence":
      return binaryCoherenceSource(c, binaryPath)
  }
}
