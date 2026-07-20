/**
 * P1 extensions to seen-red.ts (docs/design/agnostic-hands-eyes.md §2.2):
 * profile-driven test-shaped classification for non-Python ecosystems (via
 * the real `deriveRepoProfile`, exercised through `getRepoProfileSync`) and
 * structural laundered-red detection from an attached structured test
 * report (`reportContent`). Kept in its own file so the pre-existing
 * seen-red.test.ts suite stays byte-identical.
 */
import { describe, it, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { findUnresolvedSeenRed, collectObservedRedTestIds, type SeenRedExecution } from "../../src/session/seen-red"

function makeFixtureRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function withFixture(prefix: string, build: (root: string) => void, run: (root: string) => void): void {
  const root = makeFixtureRepo(prefix)
  try {
    build(root)
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("profile-driven test-shaped classification (§2.2)", () => {
  it("an `npx jest` command classifies test-shaped via the real deriveRepoProfile, and a jest --json report with a failure reads red — even though neither TEST_SHAPED_COMMAND_RE nor the plain output text matches", () => {
    withFixture(
      "econ-seen-red-jest-",
      (root) => {
        write(root, "package.json", JSON.stringify({ name: "demo", devDependencies: { jest: "^29.0.0" } }))
      },
      (root) => {
        const jestReport = JSON.stringify({
          testResults: [
            {
              name: `${root}/src/math.test.ts`,
              assertionResults: [
                { fullName: "adds numbers", title: "adds numbers", status: "passed", failureMessages: [] },
                { fullName: "subtracts numbers", title: "subtracts numbers", status: "failed", failureMessages: ["Error: expected 2 got 3"] },
              ],
            },
          ],
        })
        const executions: SeenRedExecution[] = [
          {
            command: "npx jest",
            exitCode: 1,
            // Plain output carries none of TEST_SHAPED_COMMAND_RE's or
            // TEST_FAILURE_SIGNATURE_RE's tokens — only the profile
            // (runner="jest") and the structured report can classify/red this.
            output: "",
            reportContent: jestReport,
          },
        ]
        const unresolved = findUnresolvedSeenRed(executions, undefined, root)
        expect(unresolved).toHaveLength(1)
        expect(unresolved[0]!.command).toBe("npx jest")
      },
    )
  })

  it("a `go test ./...` command's failure reads red via a go test -json report", () => {
    withFixture(
      "econ-seen-red-go-",
      (root) => {
        write(root, "go.mod", "module example.com/demo\n\ngo 1.21\n")
      },
      (root) => {
        const goReportStream = [
          '{"Action":"run","Package":"example.com/demo","Test":"TestAdd"}',
          '{"Action":"output","Package":"example.com/demo","Test":"TestAdd","Output":"--- FAIL: TestAdd (0.00s)\\n"}',
          '{"Action":"fail","Package":"example.com/demo","Test":"TestAdd","Elapsed":0.00}',
        ].join("\n")
        const executions: SeenRedExecution[] = [
          { command: "go test ./...", exitCode: 1, output: "", reportContent: goReportStream },
        ]
        const unresolved = findUnresolvedSeenRed(executions, undefined, root)
        expect(unresolved).toHaveLength(1)
        const ids = collectObservedRedTestIds(executions, root)
        expect(ids).toContain("example.com/demo.TestAdd")
      },
    )
  })

  it("a no-manifest fixture repo (empty profile) falls back to plain TEST_SHAPED_COMMAND_RE behavior — a non-test bash command stays ignored", () => {
    withFixture(
      "econ-seen-red-empty-",
      () => {
        /* no manifest files at all */
      },
      (root) => {
        const executions: SeenRedExecution[] = [{ command: "grep foo file", exitCode: 1, output: "" }]
        expect(findUnresolvedSeenRed(executions, undefined, root)).toEqual([])
      },
    )
  })
})

describe("laundered-red-by-construction (§2.2: structural, no regex family needed)", () => {
  it("exit 0 + a failing JUnit report is red, even though the plain output text matches no failure signature", () => {
    const junitReport =
      '<testsuite name="pytest" tests="2" failures="1" errors="0" skipped="0">' +
      '<testcase classname="tests.test_math" name="test_ok" time="0.01"/>' +
      '<testcase classname="tests.test_math" name="test_bad" time="0.02">' +
      '<failure message="AssertionError: assert 1 == 2">Traceback ...</failure>' +
      "</testcase></testsuite>"
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_math.py --junitxml=/tmp/report.xml",
        exitCode: 0,
        output: "collected 2 items",
        reportContent: junitReport,
      },
    ]
    const unresolved = findUnresolvedSeenRed(executions)
    expect(unresolved).toHaveLength(1)
  })

  it("exit 0 + a clean-passing report (no failures) is NOT red", () => {
    const junitReport =
      '<testsuite name="pytest" tests="1" failures="0" errors="0" skipped="0">' +
      '<testcase classname="tests.test_math" name="test_ok" time="0.01"/>' +
      "</testsuite>"
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_math.py --junitxml=/tmp/report.xml",
        exitCode: 0,
        output: "collected 1 item",
        reportContent: junitReport,
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("a report with failures is still excluded by the env-red guard (missing module) — the same discipline as the textual path", () => {
    const junitReport =
      '<testsuite tests="1" failures="1"><testcase classname="tests.test_math" name="test_bad"><failure message="boom"/></testcase></testsuite>'
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_math.py --junitxml=/tmp/report.xml",
        exitCode: 0,
        output: "ModuleNotFoundError: No module named 'foo'",
        reportContent: junitReport,
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("collectObservedRedTestIds unions report-native fail/error ids alongside the extracted command-token id", () => {
    const junitReport =
      '<testsuite tests="1" failures="1"><testcase classname="tests.test_math" name="test_bad"><failure message="boom"/></testcase></testsuite>'
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_math.py --junitxml=/tmp/report.xml",
        exitCode: 0,
        output: "collected 1 item",
        reportContent: junitReport,
      },
    ]
    const ids = collectObservedRedTestIds(executions)
    expect(ids).toContain("tests.test_math.test_bad")
  })
})
