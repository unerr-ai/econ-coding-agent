/**
 * Model-facing control surface for background shell jobs (09-ops-hands D3): status/output/
 * wait/kill over the job registry. `wait` blocks harness-side (no token cost) and always says
 * which of exit/pattern/timeout happened so the model can't mistake "still running" for "done";
 * `output`/the post-wait read route through `compressShellOutput` (D6) so a job's log never
 * costs more context than a normal shell call.
 *
 * @sem domain=tool role=job-tool
 */

import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import * as Tool from "../tool"
import DESCRIPTION from "./job.txt"
import { compressShellOutput } from "../shell-compress/index"
import { jobRegistry, type JobInfo, type WaitResult } from "./registry"

const DEFAULT_WAIT_TIMEOUT_MS = 300_000
const COMPRESS_ABOVE_BYTES = 2 * 1024

export const Parameters = Schema.Struct({
  action: Schema.Literals(["status", "output", "wait", "kill"]).annotate({
    description: "What to do with the job: \"status\", \"output\", \"wait\", or \"kill\".",
  }),
  id: Schema.String.annotate({
    description: 'The job id returned when the background job was started (e.g. "job_1").',
  }),
  timeoutMs: Schema.optional(PositiveInt).annotate({
    description: 'wait only: max milliseconds to block before returning reason "timeout" (default 300000).',
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description:
      "wait only: a regex. wait returns as soon as a NEW output line matches it, in addition to always " +
      "returning when the job exits.",
  }),
  fromByte: Schema.optional(NonNegativeInt).annotate({
    description: "output only: byte offset to read from. Omit to read output produced since your last read/wait.",
  }),
})
export type Parameters = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  jobId: string
}

/**
 * D6 output-compression treatment shared with the headless completion re-entry gate
 * (prompt.ts, via `backgroundJobCompletionNudgeText`) — the job tool's own `output`/`wait`
 * actions and the D4 finish-time nudge must never diverge on how a job's log is presented.
 */
export function compressJobOutput(command: string, chunk: string, exitCode: number | undefined, cwd: string): string {
  if (Buffer.byteLength(chunk, "utf-8") <= COMPRESS_ABOVE_BYTES) return chunk
  return compressShellOutput(command, chunk, undefined, exitCode, cwd).text
}

function statusLine(job: JobInfo): string {
  const uptimeMs = Date.now() - job.startedAt
  return JSON.stringify({
    id: job.id,
    command: job.command,
    status: job.status,
    uptime: `${(uptimeMs / 1000).toFixed(1)}s`,
    exitCode: job.exitCode ?? null,
    logPath: job.logPath,
  })
}

function waitLead(id: string, result: WaitResult): string {
  const elapsedSec = ((Date.now() - result.startedAt) / 1000).toFixed(1)
  if (result.reason === "exit") return `Job ${id} — exit: exited with code ${result.exitCode ?? "null"} after ${elapsedSec}s`
  if (result.reason === "pattern") return `Job ${id} — pattern: pattern matched: ${result.matchedLine}`
  return `Job ${id} — timeout: still running after ${elapsedSec}s (timeout)`
}

export const JobTool = Tool.define(
  "job",
  Effect.gen(function* () {
    const run = Effect.fn("JobTool.execute")(function* (params: Parameters, ctx: Tool.Context<Metadata>) {
      const registry = jobRegistry()
      const job = registry.getJob(params.id)
      if (!job) return yield* Effect.fail(new Error(`No job with id "${params.id}".`))

      switch (params.action) {
        case "status": {
          return { title: `job ${job.id}`, output: statusLine(job), metadata: { jobId: job.id } }
        }

        case "output": {
          const result = registry.readOutput(job.id, params.fromByte)
          const text = compressJobOutput(job.command, result.chunk, result.exitCode, job.cwd)
          const skipped = result.skippedBytes ? `\n(skipped ${result.skippedBytes} older bytes)` : ""
          const status = result.running ? "running" : `finished (exit ${result.exitCode ?? "null"})`
          const output = `Job ${job.id} — ${status}${skipped}\n\n${text || "(no new output)"}\n\nFull log: ${job.logPath} (next byte: ${result.nextByte})`
          return { title: `job ${job.id} output`, output, metadata: { jobId: job.id } }
        }

        case "wait": {
          const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
          const result = yield* Effect.promise(() => registry.wait(job.id, { timeoutMs, pattern: params.pattern }))
          if (result.reason === "error") {
            return { title: `job ${job.id} wait`, output: `Job ${job.id} — invalid pattern: ${result.error}`, metadata: { jobId: job.id } }
          }
          const fresh = registry.readOutput(job.id)
          const text = compressJobOutput(job.command, fresh.chunk, result.exitCode, job.cwd)
          const output = `${waitLead(job.id, result)}\n\n${text || "(no new output)"}\n\nFull log: ${job.logPath}`
          return { title: `job ${job.id} wait`, output, metadata: { jobId: job.id } }
        }

        case "kill": {
          const result = registry.kill(job.id)
          const output = result.killed
            ? `Job ${job.id} — kill signal sent (SIGTERM, SIGKILL after 3s if still running).`
            : `Job ${job.id} — not killed (already ${job.status}).`
          return { title: `job ${job.id} kill`, output, metadata: { jobId: job.id } }
        }
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context<Metadata>) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
