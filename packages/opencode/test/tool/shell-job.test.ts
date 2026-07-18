/**
 * Unit tests for the background-job registry (09-ops-hands D1) with real, sub-second child
 * processes — no mocked child_process — plus a registration check for the `job` model tool
 * (D3), mirroring graph-tools-registration.test.ts's registration-only style.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { createJobRegistry, waitAnyForSession, type JobRegistry } from "../../src/tool/shell-job/registry"
import { JobTool } from "../../src/tool/shell-job/tool"
import { HIDDEN_FROM_MODEL, CATALOG_TOOL_IDS } from "../../src/tool/registry"

let tmpDir: string
let registry: JobRegistry

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "econ-job-registry-"))
  registry = createJobRegistry({ logDir: tmpDir })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function start(command: string) {
  return registry.startJob({
    command,
    cwd: process.cwd(),
    shell: "/bin/sh",
    env: process.env as NodeJS.ProcessEnv,
    sessionID: "ses_test",
  })
}

describe("createJobRegistry — wait", () => {
  test(
    "start -> wait resolves reason:'exit' with code 0",
    async () => {
      const job = start("echo start; sleep 0.3; echo done")
      const result = await registry.wait(job.id, { timeoutMs: 5000 })
      expect(result.reason).toBe("exit")
      expect(result.exitCode).toBe(0)
      expect(result.status).toBe("exited")
    },
    10_000,
  )

  test(
    "pattern wait resolves reason:'pattern' on the first new matching line",
    async () => {
      const job = start("echo nothing; sleep 0.2; echo MARKER; sleep 5")
      const result = await registry.wait(job.id, { timeoutMs: 5000, pattern: "MARKER" })
      expect(result.reason).toBe("pattern")
      expect(result.matchedLine).toBe("MARKER")
      expect(result.status).toBe("running")
      registry.kill(job.id)
    },
    10_000,
  )

  test(
    "invalid regex -> error result, not a throw",
    async () => {
      const job = start("sleep 0.2")
      const result = await registry.wait(job.id, { timeoutMs: 1000, pattern: "(unterminated[" })
      expect(result.reason).toBe("error")
      expect(result.error).toBeDefined()
    },
    5_000,
  )

  test(
    "kill flips status and wait resolves",
    async () => {
      const job = start("sleep 5")
      const killed = registry.kill(job.id)
      expect(killed.killed).toBe(true)
      const result = await registry.wait(job.id, { timeoutMs: 5000 })
      expect(result.reason).toBe("exit")
      expect(result.status).toBe("killed")
    },
    10_000,
  )
})

describe("createJobRegistry — readOutput", () => {
  test(
    "cursor returns incremental bytes",
    async () => {
      const job = start("echo one; sleep 0.2; echo two")
      const exited = await registry.wait(job.id, { timeoutMs: 5000 })
      expect(exited.reason).toBe("exit")

      const full = registry.readOutput(job.id, 0)
      expect(full.chunk).toContain("one")
      expect(full.chunk).toContain("two")
      expect(full.running).toBe(false)

      const mid = Math.floor(full.chunk.length / 2)
      const partial = registry.readOutput(job.id, mid)
      expect(partial.chunk).toBe(full.chunk.slice(mid))
      expect(partial.nextByte).toBe(full.nextByte)

      // Auto-cursor (fromByte omitted) starts at 0 and advances on each read — the
      // job tool's "wait" action relies on this to serve fresh output with no cursor
      // from the model.
      const auto1 = registry.readOutput(job.id)
      expect(auto1.chunk).toBe(full.chunk)
      const auto2 = registry.readOutput(job.id)
      expect(auto2.chunk).toBe("")
    },
    10_000,
  )
})

describe("waitAnyForSession", () => {
  test("no running jobs for the session -> kind:'none' (the cheap inert path)", async () => {
    const result = await waitAnyForSession("ses_test", 1000, registry)
    expect(result.kind).toBe("none")
  })

  test("a job started by a DIFFERENT session doesn't count -> kind:'none'", async () => {
    registry.startJob({
      command: "sleep 5",
      cwd: process.cwd(),
      shell: "/bin/sh",
      env: process.env as NodeJS.ProcessEnv,
      sessionID: "ses_other",
    })
    const result = await waitAnyForSession("ses_test", 500, registry)
    expect(result.kind).toBe("none")
    registry.listJobs("ses_other").forEach((job) => registry.kill(job.id))
  })

  test(
    "the session's job exits before the timeout -> kind:'exit' with the job",
    async () => {
      const job = start("echo start; sleep 0.2; echo done")
      const result = await waitAnyForSession("ses_test", 5000, registry)
      expect(result.kind).toBe("exit")
      if (result.kind === "exit") {
        expect(result.job.id).toBe(job.id)
        expect(result.job.exitCode).toBe(0)
      }
    },
    10_000,
  )

  test(
    "the session's job outlives the timeout -> kind:'timeout' listing it as still running",
    async () => {
      const job = start("sleep 5")
      const result = await waitAnyForSession("ses_test", 300, registry)
      expect(result.kind).toBe("timeout")
      if (result.kind === "timeout") {
        expect(result.running.map((j) => j.id)).toContain(job.id)
      }
      registry.kill(job.id)
    },
    10_000,
  )

  test(
    "resolves on the FIRST of several running jobs to exit, not the slowest",
    async () => {
      const slow = start("sleep 5")
      const fast = start("sleep 0.2; echo fast-done")
      const result = await waitAnyForSession("ses_test", 5000, registry)
      expect(result.kind).toBe("exit")
      if (result.kind === "exit") expect(result.job.id).toBe(fast.id)
      registry.kill(slow.id)
    },
    10_000,
  )
})

describe("job tool — registration", () => {
  test("job tool carries the id the registry wires it under", () => {
    expect(JobTool.id).toBe("job")
  })

  test("job tool is advertised like shell — not hidden, not catalog-compacted", () => {
    expect(HIDDEN_FROM_MODEL.has(JobTool.id)).toBe(false)
    expect(CATALOG_TOOL_IDS.has(JobTool.id)).toBe(false)
  })
})
