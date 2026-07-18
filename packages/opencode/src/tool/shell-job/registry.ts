/**
 * In-process registry for background shell jobs (09-ops-hands D1). Jobs must outlive the
 * tool-call Effect scope that started them, so this spawns with Node's `child_process.spawn`
 * directly instead of going through `ChildProcessSpawner` — a plain-TS singleton patterned on
 * `shellQualityMonitor()` (shell-compress/quality-monitor.ts), not an Effect service. Stdout and
 * stderr are teed into one append-only log file on disk (the source of truth); reads are
 * cursor-based and bounded, and `wait()` is a harness-side poll loop so the model never pays
 * tokens or turns to watch a job run.
 *
 * @sem domain=tool role=job-registry
 */

import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Global } from "@opencode-ai/core/global"
import { Shell } from "@opencode-ai/core/shell"

export const JOB_LOG_DIR = path.join(Global.Path.data, "job-output")

const FORCE_KILL_AFTER_MS = 3_000
const WAIT_POLL_MS = 500
const OUTPUT_CHUNK_CAP_BYTES = 256 * 1024

export type JobStatus = "running" | "exited" | "killed"

export interface JobInfo {
  id: string
  command: string
  cwd: string
  pid: number | undefined
  logPath: string
  startedAt: number
  status: JobStatus
  exitCode?: number
  signal?: NodeJS.Signals
}

export interface StartJobOptions {
  command: string
  cwd: string
  shell: string
  env: NodeJS.ProcessEnv
  sessionID: string
  callID?: string
}

export interface ReadOutputResult {
  chunk: string
  nextByte: number
  running: boolean
  exitCode?: number
  skippedBytes?: number
}

export interface WaitOptions {
  timeoutMs: number
  pattern?: string
}

export interface WaitResult extends JobInfo {
  reason: "exit" | "pattern" | "timeout" | "error"
  matchedLine?: string
  error?: string
}

export interface JobRegistry {
  startJob(opts: StartJobOptions): JobInfo
  getJob(id: string): JobInfo | undefined
  listJobs(sessionID?: string): JobInfo[]
  readOutput(id: string, fromByte?: number): ReadOutputResult
  wait(id: string, opts: WaitOptions): Promise<WaitResult>
  kill(id: string): { killed: boolean }
}

export interface JobRegistryOptions {
  /** Override the on-disk log directory — tests point this at a tmp dir; omit for JOB_LOG_DIR. */
  logDir?: string
}

interface JobRecord {
  id: string
  command: string
  cwd: string
  pid: number | undefined
  logPath: string
  startedAt: number
  status: JobStatus
  exitCode?: number
  signal?: NodeJS.Signals
  sessionID: string
  child: ChildProcess
  logFd: number
  killRequested: boolean
  /** Auto-advancing "last served to the model" byte offset — see readOutput(). */
  cursor: number
}

function toJobInfo(job: JobRecord): JobInfo {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    pid: job.pid,
    logPath: job.logPath,
    startedAt: job.startedAt,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
  }
}

// Mirrors ShellTool's zsh NOMATCH guard (packages/opencode/src/tool/shell.ts:335) — reimplemented
// here (not imported) because shell.ts imports jobRegistry() to spawn background jobs, and
// importing shellCommandFor back from shell.ts would create a module cycle.
function nomatchGuard(shellPath: string, command: string): string {
  if (Shell.name(shellPath) !== "zsh") return command
  return `unsetopt nomatch 2>/dev/null; ${command}`
}

function readFileRange(filePath: string, start: number, end: number): string {
  if (end <= start) return ""
  const fd = openSync(filePath, "r")
  try {
    const length = end - start
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, start)
    return buf.toString("utf-8")
  } finally {
    closeSync(fd)
  }
}

function fileSize(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0
}

/**
 * Creates a job registry instance: one in-memory map of running/finished jobs plus a
 * process-exit finalizer (installed once per instance, on first startJob) that best-effort
 * SIGTERMs every job still running when the host process exits — jobs die with the `opencode
 * run` process by design in v1, no cross-process recovery.
 *
 * @sem domain=tool role=job-registry
 */
export function createJobRegistry(opts: JobRegistryOptions = {}): JobRegistry {
  const logDir = opts.logDir ?? JOB_LOG_DIR
  const jobs = new Map<string, JobRecord>()
  let counter = 0
  let exitHandlerInstalled = false

  function killProcessGroup(pid: number, signal: NodeJS.Signals) {
    try {
      if (process.platform === "win32") {
        if (signal === "SIGKILL") spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" }).unref()
        return
      }
      process.kill(-pid, signal)
    } catch {
      // Process already gone, or never got a real process group — best effort.
    }
  }

  function installExitHandler() {
    if (exitHandlerInstalled) return
    exitHandlerInstalled = true
    // `exit` handlers must be fully synchronous (Node gives no chance for a scheduled
    // SIGKILL-after-3s to fire once this listener returns) — this is a best-effort SIGTERM
    // sweep, not the same two-step kill() below performs during normal operation.
    process.on("exit", () => {
      for (const job of jobs.values()) {
        if (job.status !== "running" || !job.pid) continue
        killProcessGroup(job.pid, "SIGTERM")
      }
    })
  }

  function startJob(opts: StartJobOptions): JobInfo {
    installExitHandler()
    mkdirSync(logDir, { recursive: true })
    const id = `job_${++counter}`
    const logPath = path.join(logDir, `${id}.log`)
    const logFd = openSync(logPath, "a")

    const usePowershell = process.platform === "win32" && Shell.ps(opts.shell)
    const child = usePowershell
      ? spawn(opts.shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", opts.command], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["ignore", logFd, logFd],
          detached: false,
        })
      : spawn(nomatchGuard(opts.shell, opts.command), [], {
          shell: opts.shell,
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["ignore", logFd, logFd],
          detached: process.platform !== "win32",
        })

    const record: JobRecord = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      pid: child.pid,
      logPath,
      startedAt: Date.now(),
      status: "running",
      sessionID: opts.sessionID,
      child,
      logFd,
      killRequested: false,
      cursor: 0,
    }
    jobs.set(id, record)

    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      record.status = record.killRequested ? "killed" : "exited"
      record.exitCode = code ?? undefined
      record.signal = signal ?? undefined
      try {
        closeSync(record.logFd)
      } catch {
        // Already closed — fine.
      }
    }
    child.once("exit", finalize)
    child.once("error", () => finalize(null, null))
    // Never let a background job hold the harness process's event loop open.
    child.unref()

    return toJobInfo(record)
  }

  function getJob(id: string): JobInfo | undefined {
    const job = jobs.get(id)
    return job ? toJobInfo(job) : undefined
  }

  function listJobs(sessionID?: string): JobInfo[] {
    const all = [...jobs.values()]
    return (sessionID ? all.filter((job) => job.sessionID === sessionID) : all).map(toJobInfo)
  }

  function readOutput(id: string, fromByte?: number): ReadOutputResult {
    const job = jobs.get(id)
    if (!job) throw new Error(`Unknown job: ${id}`)
    const size = fileSize(job.logPath)
    const auto = fromByte === undefined
    const requestedStart = Math.min(Math.max(auto ? job.cursor : fromByte, 0), size)

    let readStart = requestedStart
    let skippedBytes = 0
    const available = size - requestedStart
    if (available > OUTPUT_CHUNK_CAP_BYTES) {
      skippedBytes = available - OUTPUT_CHUNK_CAP_BYTES
      readStart = size - OUTPUT_CHUNK_CAP_BYTES
    }

    const chunk = readFileRange(job.logPath, readStart, size)
    if (auto) job.cursor = size

    return {
      chunk,
      nextByte: size,
      running: job.status === "running",
      exitCode: job.exitCode,
      ...(skippedBytes > 0 ? { skippedBytes } : {}),
    }
  }

  async function wait(id: string, opts: WaitOptions): Promise<WaitResult> {
    const job = jobs.get(id)
    if (!job) throw new Error(`Unknown job: ${id}`)

    let regex: RegExp | undefined
    if (opts.pattern !== undefined) {
      try {
        regex = new RegExp(opts.pattern)
      } catch (err) {
        return { ...toJobInfo(job), reason: "error", error: `Invalid pattern "${opts.pattern}": ${String(err)}` }
      }
    }

    // Only lines appended AFTER this call count as "new" for the pattern match — a repeat
    // wait() on the same job must not re-match a line an earlier wait() already returned.
    const baseline = fileSize(job.logPath)
    const deadline = Date.now() + opts.timeoutMs

    while (true) {
      // Exit wins over pattern/timeout on every tick — silence-is-not-success, but a finished
      // job is always reported as finished regardless of what the pattern was looking for.
      if (job.status !== "running") return { ...toJobInfo(job), reason: "exit" }

      if (regex) {
        const size = fileSize(job.logPath)
        if (size > baseline) {
          const text = readFileRange(job.logPath, baseline, size)
          for (const line of text.split("\n")) {
            if (regex.test(line)) return { ...toJobInfo(job), reason: "pattern", matchedLine: line }
          }
        }
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ...toJobInfo(job), reason: "timeout" }
      await sleep(Math.min(WAIT_POLL_MS, remaining))
    }
  }

  function kill(id: string): { killed: boolean } {
    const job = jobs.get(id)
    if (!job || job.status !== "running" || !job.pid) return { killed: false }
    job.killRequested = true
    killProcessGroup(job.pid, "SIGTERM")
    const pid = job.pid
    setTimeout(() => {
      if (job.status === "running") killProcessGroup(pid, "SIGKILL")
    }, FORCE_KILL_AFTER_MS).unref()
    return { killed: true }
  }

  return { startJob, getJob, listJobs, readOutput, wait, kill }
}

let singleton: JobRegistry | undefined

/**
 * Process-wide job registry accessor, mirroring `shellQualityMonitor()` — lazily creates the
 * one instance every ShellTool/JobTool call in this `opencode run` process shares.
 *
 * @sem domain=tool role=job-registry
 */
export function jobRegistry(): JobRegistry {
  if (!singleton) singleton = createJobRegistry()
  return singleton
}

export type WaitAnyResult = { kind: "exit"; job: JobInfo } | { kind: "timeout"; running: JobInfo[] } | { kind: "none" }

/**
 * D4 (09-ops-hands) — headless completion re-entry's harness-side wait: the FIRST currently
 * running job started by `sessionID` to exit, or `timeoutMs` elapsed, whichever comes first.
 * `"none"` is the cheap fast path (no running jobs at all) prompt.ts's finish gate checks
 * before paying for a poll — the inert case. Reuses each job's own `wait()` poll loop via
 * `Promise.race` rather than a second poller; a `"timeout"` result carries every job still
 * running at that point, not just the one that raced first.
 *
 * @sem domain=tool role=job-registry
 */
export async function waitAnyForSession(
  sessionID: string,
  timeoutMs: number,
  registry: JobRegistry = jobRegistry(),
): Promise<WaitAnyResult> {
  const running = registry.listJobs(sessionID).filter((job) => job.status === "running")
  if (running.length === 0) return { kind: "none" }

  const first = await Promise.race(running.map((job) => registry.wait(job.id, { timeoutMs })))
  if (first.reason === "exit") return { kind: "exit", job: first }

  return { kind: "timeout", running: registry.listJobs(sessionID).filter((job) => job.status === "running") }
}
