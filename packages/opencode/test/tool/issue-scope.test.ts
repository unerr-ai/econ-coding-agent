/**
 * §10 Step 4 issue-scope boundary (docs/design/escalation-economics.md
 * §6/§6.1) — pure derivation unit tests for issue-scope.ts. The session-
 * armed decision point (evaluateIssueScopeGate) is covered separately in
 * edit-governance.test.ts.
 */

import { describe, it, expect } from "bun:test"
import type { EditImpactGraph } from "@opencode-ai/code-intelligence"
import {
  deriveIssueScope,
  issueScopeDenyEnabled,
  recordPreExistingFailure,
  preExistingFailures,
  clearPreExistingFailures,
  issueScopeReason,
} from "../../src/tool/issue-scope"

function fakeGraph(opts: {
  entitiesByFile?: Record<string, string[]>
  callersByEntityKey?: Record<string, string[]>
  throwing?: boolean
  throwingFiles?: string[]
}): EditImpactGraph {
  return {
    getEntitiesInFile: async (filePath: string) => {
      if (opts.throwing || opts.throwingFiles?.includes(filePath)) throw new Error("graph unavailable")
      const names = opts.entitiesByFile?.[filePath] ?? []
      return names.map((name) => ({
        key: `${filePath}:${name}:function`,
        name,
        kind: "function",
        filePath,
        lineStart: 1,
        lineEnd: 2,
        signature: "()",
        contentHash: "fake",
      }))
    },
    getCallers: async (entityKey: string) => {
      if (opts.throwing) throw new Error("graph unavailable")
      const fromFiles = opts.callersByEntityKey?.[entityKey] ?? []
      return fromFiles.map((fromFile) => ({
        fromEntity: "caller",
        fromFile,
        toEntity: entityKey,
        kind: "call",
      }))
    },
  }
}

describe("deriveIssueScope", () => {
  it("empty defining files → empty scope (unknown, not 'everything out of scope')", async () => {
    const scope = await deriveIssueScope([], fakeGraph({}))
    expect(scope.size).toBe(0)
  })

  it("defining files alone, no callers → scope is exactly the defining files", async () => {
    const scope = await deriveIssueScope(["fields.py"], fakeGraph({}))
    expect(scope).toEqual(new Set(["fields.py"]))
  })

  it("adds the one-hop reverse-call neighborhood — a file with an entity that calls a defining site's entity", async () => {
    const graph = fakeGraph({
      entitiesByFile: { "fields.py": ["CharField"] },
      callersByEntityKey: { "fields.py:CharField:function": ["widgets.py", "forms.py"] },
    })
    const scope = await deriveIssueScope(["fields.py"], graph)
    expect(scope).toEqual(new Set(["fields.py", "widgets.py", "forms.py"]))
  })

  it("does NOT pull in a defining site's own dependency (what it calls out to) — reverse-call only, one-way", async () => {
    // fields.py "calls into" validators.py in the real repo, but nothing in
    // this graph reports validators.py as a CALLER of fields.py's entities,
    // so it must never appear in the derived scope.
    const graph = fakeGraph({
      entitiesByFile: { "fields.py": ["CharField"] },
      callersByEntityKey: { "fields.py:CharField:function": [] },
    })
    const scope = await deriveIssueScope(["fields.py"], graph)
    expect(scope.has("validators.py")).toBe(false)
    expect(scope).toEqual(new Set(["fields.py"]))
  })

  it("dedups a neighbor reached via multiple entities/defining files", async () => {
    const graph = fakeGraph({
      entitiesByFile: { "fields.py": ["CharField", "IntegerField"], "enums.py": ["Choices"] },
      callersByEntityKey: {
        "fields.py:CharField:function": ["widgets.py"],
        "fields.py:IntegerField:function": ["widgets.py"],
        "enums.py:Choices:function": ["widgets.py"],
      },
    })
    const scope = await deriveIssueScope(["fields.py", "enums.py"], graph)
    expect(scope).toEqual(new Set(["fields.py", "enums.py", "widgets.py"]))
  })

  it("defensive: a defining file whose entities/callers are unresolvable is skipped, never fails the whole derivation", async () => {
    const graph = fakeGraph({
      entitiesByFile: { "enums.py": ["Choices"] },
      callersByEntityKey: { "enums.py:Choices:function": ["widgets.py"] },
      throwingFiles: ["fields.py"],
    })
    const scope = await deriveIssueScope(["fields.py", "enums.py"], graph)
    expect(scope).toEqual(new Set(["fields.py", "enums.py", "widgets.py"]))
  })

  it("defensive: a fully throwing graph degrades to the defining files themselves", async () => {
    const scope = await deriveIssueScope(["fields.py"], fakeGraph({ throwing: true }))
    expect(scope).toEqual(new Set(["fields.py"]))
  })
})

describe("issueScopeDenyEnabled", () => {
  const previous = process.env.ECON_ISSUE_SCOPE_DENY

  it("defaults to false when unset", () => {
    delete process.env.ECON_ISSUE_SCOPE_DENY
    expect(issueScopeDenyEnabled()).toBe(false)
  })

  it("true for '1' and 'true'", () => {
    process.env.ECON_ISSUE_SCOPE_DENY = "1"
    expect(issueScopeDenyEnabled()).toBe(true)
    process.env.ECON_ISSUE_SCOPE_DENY = "true"
    expect(issueScopeDenyEnabled()).toBe(true)
  })

  it("false for any other value ('0', 'false', garbage)", () => {
    process.env.ECON_ISSUE_SCOPE_DENY = "0"
    expect(issueScopeDenyEnabled()).toBe(false)
    process.env.ECON_ISSUE_SCOPE_DENY = "false"
    expect(issueScopeDenyEnabled()).toBe(false)
    process.env.ECON_ISSUE_SCOPE_DENY = "yes"
    expect(issueScopeDenyEnabled()).toBe(false)
  })

  it("restores the ambient env", () => {
    if (previous === undefined) delete process.env.ECON_ISSUE_SCOPE_DENY
    else process.env.ECON_ISSUE_SCOPE_DENY = previous
    expect(true).toBe(true)
  })
})

describe("§6.1 — pre-existing-failure proof store", () => {
  it("empty for a session with nothing recorded", () => {
    expect(preExistingFailures("ses_pef_unknown")).toEqual([])
  })

  it("records and dedups, insertion order preserved", () => {
    recordPreExistingFailure("ses_pef_a", "validators.tests.TestValidators [URLValidator]")
    recordPreExistingFailure("ses_pef_a", "another.signature")
    recordPreExistingFailure("ses_pef_a", "validators.tests.TestValidators [URLValidator]")
    expect(preExistingFailures("ses_pef_a")).toEqual([
      "validators.tests.TestValidators [URLValidator]",
      "another.signature",
    ])
  })

  it("clearPreExistingFailures empties the session's store", () => {
    recordPreExistingFailure("ses_pef_b", "sig")
    expect(preExistingFailures("ses_pef_b")).toEqual(["sig"])
    clearPreExistingFailures("ses_pef_b")
    expect(preExistingFailures("ses_pef_b")).toEqual([])
  })

  it("is per-session — recording for one session never leaks into another", () => {
    recordPreExistingFailure("ses_pef_c1", "sig-c1")
    expect(preExistingFailures("ses_pef_c2")).toEqual([])
  })
})

describe("issueScopeReason", () => {
  it("names the file and the resolved scope", () => {
    const msg = issueScopeReason("validators.py", ["fields.py", "widgets.py"], "ses_reason_a")
    expect(msg).toContain("validators.py is outside the derived scope for this issue")
    expect(msg).toContain("fields.py")
    expect(msg).toContain("widgets.py")
  })

  it("names '(none resolved)' when the scope is empty", () => {
    const msg = issueScopeReason("validators.py", [], "ses_reason_b")
    expect(msg).toContain("(none resolved)")
  })

  it("omits the pre-existing-failure clause when nothing is recorded", () => {
    const msg = issueScopeReason("validators.py", ["fields.py"], "ses_reason_c")
    expect(msg).not.toContain("already proved")
  })

  it("appends the pre-existing-failure clause when the session recorded one", () => {
    recordPreExistingFailure("ses_reason_d", "validators.tests.TestValidators [URLValidator]")
    const msg = issueScopeReason("validators.py", ["fields.py"], "ses_reason_d")
    expect(msg).toContain("already proved")
    expect(msg).toContain("validators.tests.TestValidators [URLValidator]")
    expect(msg).toContain("leave it alone")
  })
})
