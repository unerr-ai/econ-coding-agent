import { describe, it, expect } from "bun:test"
import { classifyReproDrift, extractScriptFilename, extractScriptPath } from "../../src/session/repro-drift"

// Table tests over synthetic step inputs — the shape prompt.ts's SM4 block
// passes: `stepObs.failedCommands` (from turn-supervisor's observeStep) and
// the raw completed-assistant-message parts for the same step.

function editErr(error: string) {
  return { type: "tool", tool: "edit", state: { status: "error", error } }
}
function writeErr(error: string) {
  return { type: "tool", tool: "write", state: { status: "error", error } }
}
function editOk() {
  return { type: "tool", tool: "edit", state: { status: "completed" } }
}
function bashOk(command: string) {
  return { type: "tool", tool: "bash", state: { status: "completed", input: { command } } }
}

const NO_TEST_EDIT_ERROR =
  'Edit denied by the no-test-edit gate: "tests/test_utils.py" is an existing test file and this turn is fixing a defect. Changing tests to match a patch invalidates the only oracle that can catch a wrong fix.'
const ECON_GATE_BLOCK_ERROR = "[econ-gate] BLOCKED: breaking signature change in src/foo.ts. 1 caller at risk."

describe("classifyReproDrift — inline-repro", () => {
  it("fires on a python -c one-liner carrying an assertion", () => {
    const kinds = classifyReproDrift({ failedCommands: ['python -c "assert 1 == 2"'], parts: [] })
    expect(kinds).toContain("inline-repro")
  })

  it("fires on python3 -c with a raise", () => {
    const kinds = classifyReproDrift({ failedCommands: ["python3 -c \"raise AssertionError('254 != 255')\""], parts: [] })
    expect(kinds).toContain("inline-repro")
  })

  it("fires on node -e with an expect() call", () => {
    const kinds = classifyReproDrift({ failedCommands: ['node -e "expect(actual).toBe(5)"'], parts: [] })
    expect(kinds).toContain("inline-repro")
  })

  it("fires on a shell heredoc carrying an assertion", () => {
    const kinds = classifyReproDrift({ failedCommands: ["python <<'EOF'\nassert 1 == 2\nEOF"], parts: [] })
    expect(kinds).toContain("inline-repro")
  })

  it("does NOT fire on an inline command with no assertion/raise/expect", () => {
    const kinds = classifyReproDrift({ failedCommands: ['python -c "print(1)"'], parts: [] })
    expect(kinds).not.toContain("inline-repro")
  })

  it("does NOT fire on a real repro FILE (not -c/-e/heredoc)", () => {
    const kinds = classifyReproDrift({ failedCommands: ["python repro_issue.py"], parts: [] })
    expect(kinds).not.toContain("inline-repro")
  })
})

describe("classifyReproDrift — suite-edit-denied", () => {
  it("fires on an errored edit part whose state.error names the no-test-edit gate", () => {
    const kinds = classifyReproDrift({ failedCommands: [], parts: [editErr(NO_TEST_EDIT_ERROR)] })
    expect(kinds).toContain("suite-edit-denied")
  })

  it("fires on an errored write part the same way", () => {
    const kinds = classifyReproDrift({ failedCommands: [], parts: [writeErr(NO_TEST_EDIT_ERROR)] })
    expect(kinds).toContain("suite-edit-denied")
  })

  it("does NOT fire on an unrelated gate block (econ-gate BLOCKED, not no-test-edit)", () => {
    const kinds = classifyReproDrift({ failedCommands: [], parts: [editErr(ECON_GATE_BLOCK_ERROR)] })
    expect(kinds).not.toContain("suite-edit-denied")
  })

  it("does NOT fire on a completed (non-error) edit", () => {
    const kinds = classifyReproDrift({ failedCommands: [], parts: [editOk()] })
    expect(kinds).not.toContain("suite-edit-denied")
  })
})

describe("classifyReproDrift — unpinnable-red", () => {
  it("fires when the only failed command is a bare whole-suite run", () => {
    const kinds = classifyReproDrift({ failedCommands: ["pnpm test"], parts: [] })
    expect(kinds).toContain("unpinnable-red")
  })

  it("fires when the only failed command is multi-line/compound", () => {
    const kinds = classifyReproDrift({ failedCommands: ["pytest tests/test_foo.py\npytest tests/test_bar.py"], parts: [] })
    expect(kinds).toContain("unpinnable-red")
  })

  it("does NOT fire when at least one failed candidate is a named test file", () => {
    const kinds = classifyReproDrift({
      failedCommands: ["pnpm test", "pytest tests/test_foo.py::test_bar"],
      parts: [],
    })
    expect(kinds).not.toContain("unpinnable-red")
  })

  it("does NOT fire when the only failed candidate is an authored repro script", () => {
    const kinds = classifyReproDrift({ failedCommands: ["python repro_issue.py"], parts: [] })
    expect(kinds).not.toContain("unpinnable-red")
  })

  it("does NOT fire when there are no failed commands", () => {
    const kinds = classifyReproDrift({ failedCommands: [], parts: [] })
    expect(kinds).not.toContain("unpinnable-red")
  })
})

describe("classifyReproDrift — combined / silent otherwise", () => {
  it("returns multiple kinds when a step exhibits more than one", () => {
    const kinds = classifyReproDrift({
      failedCommands: ['python -c "assert 1 == 2"'],
      parts: [editErr(NO_TEST_EDIT_ERROR)],
    })
    expect(kinds).toContain("inline-repro")
    expect(kinds).toContain("suite-edit-denied")
    // the inline one-liner also scores 0 under reproSpecificity — both fire
    expect(kinds).toContain("unpinnable-red")
  })

  it("returns an empty array for a clean step (no drift signal at all)", () => {
    const kinds = classifyReproDrift({ failedCommands: [], parts: [editOk()] })
    expect(kinds).toEqual([])
  })

  it("returns an empty array when the failing command is already pinnable", () => {
    const kinds = classifyReproDrift({ failedCommands: ["pytest tests/test_foo.py::test_bar"], parts: [] })
    expect(kinds).toEqual([])
  })
})

describe("classifyReproDrift — pinned-repro-deleted", () => {
  it("fires on an `rm` of the pinned script's basename", () => {
    const kinds = classifyReproDrift({
      failedCommands: [],
      parts: [bashOk("rm repro_issue.py")],
      pinnedScript: "repro_issue.py",
    })
    expect(kinds).toContain("pinned-repro-deleted")
  })

  it("does NOT fire on an `rm` of an unrelated file", () => {
    const kinds = classifyReproDrift({
      failedCommands: [],
      parts: [bashOk("rm scratch.log")],
      pinnedScript: "repro_issue.py",
    })
    expect(kinds).not.toContain("pinned-repro-deleted")
  })

  it("never fires with no pinnedScript input, even on a matching rm", () => {
    const kinds = classifyReproDrift({ failedCommands: [], parts: [bashOk("rm repro_issue.py")] })
    expect(kinds).not.toContain("pinned-repro-deleted")
  })
})

describe("extractScriptFilename", () => {
  it("extracts the basename from a python invocation with a venv path prefix", () => {
    expect(extractScriptFilename(".venv/bin/python repro_issue.py")).toBe("repro_issue.py")
  })

  it("extracts the basename from a nested test-directory path", () => {
    expect(extractScriptFilename("python tests/x/repro_y.py")).toBe("repro_y.py")
  })

  it("returns undefined when the command names no file", () => {
    expect(extractScriptFilename("bun test")).toBeUndefined()
  })
})

describe("extractScriptPath", () => {
  it("preserves an absolute path verbatim — round-F's basename-extraction miss made readPinnedReproFile join cwd+basename and degrade to file-missing", () => {
    const command = "python /var/folders/ab/T/opencode/repro_parse_http_date.py"
    expect(extractScriptPath(command)).toBe("/var/folders/ab/T/opencode/repro_parse_http_date.py")
  })

  it("returns a relative path token as-is", () => {
    expect(extractScriptPath("python scripts/repro.py")).toBe("scripts/repro.py")
  })

  it("contrasts with extractScriptFilename, which returns only the basename for the same absolute-path command", () => {
    const command = "python /var/folders/ab/T/opencode/repro_parse_http_date.py"
    expect(extractScriptFilename(command)).toBe("repro_parse_http_date.py")
  })

  it("returns undefined when the command names no file", () => {
    expect(extractScriptPath("bun test")).toBeUndefined()
  })
})
