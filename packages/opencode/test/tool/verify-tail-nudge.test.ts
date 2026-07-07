import { describe, expect, it } from "bun:test"
import { TEST_COMMAND_RE, noteVerifyCommand } from "../../src/tool/verify-tail-nudge"

let sessionCounter = 0
const nextSession = () => `verify-tail-nudge-test-${++sessionCounter}`

const BASE = 1_700_000_000_000
const WINDOW_MS = 15 * 60 * 1000

describe("verify-tail-nudge", () => {
  describe("TEST_COMMAND_RE", () => {
    const POSITIVE = [
      "jest",
      "TZ=UTC npx jest",
      "bun test",
      "tsc --noEmit",
      "vitest run",
      "pytest -k foo",
      "go test ./...",
      "cargo test",
      "cargo check",
      "npm test",
      "yarn test",
      "pnpm test",
      "pnpm run typecheck",
    ]

    it.each(POSITIVE)("matches %s", (command) => {
      expect(TEST_COMMAND_RE.test(command)).toBe(true)
    })

    const NEGATIVE = ["git status", "ls", "cat docs/contest.md", "echo jestful", "cat tsconfig.json"]

    it.each(NEGATIVE)("does not match %s", (command) => {
      expect(TEST_COMMAND_RE.test(command)).toBe(false)
    })
  })

  describe("noteVerifyCommand", () => {
    it("stays null until the 3rd matching command in the window, then fires with #3", () => {
      const session = nextSession()
      expect(noteVerifyCommand(session, "conductor", "jest", BASE)).toBeNull()
      expect(noteVerifyCommand(session, "conductor", "jest", BASE + 1000)).toBeNull()
      expect(noteVerifyCommand(session, "conductor", "jest", BASE + 2000)).toBe(
        '[econ-nudge] verify-tail: this is test/build run #3 this window — hand the remaining verification matrix to ONE runner side-task (task tool, subagent_type:"runner", with the exact commands in order and the report format you expect), then continue non-overlapping work.',
      )
    })

    it("fires again at the 8th matching command, but stays silent in between", () => {
      const session = nextSession()
      for (let i = 1; i <= 7; i++) {
        const result = noteVerifyCommand(session, "conductor", "jest", BASE + i * 1000)
        if (i === 3) expect(result).not.toBeNull()
        else expect(result).toBeNull()
      }
      const eighth = noteVerifyCommand(session, "conductor", "jest", BASE + 8000)
      expect(eighth).toContain("run #8")
    })

    it("fires at most twice per window (nothing after #8)", () => {
      const session = nextSession()
      let lastResult: string | null = null
      for (let i = 1; i <= 12; i++) {
        lastResult = noteVerifyCommand(session, "conductor", "jest", BASE + i * 1000)
        if (i !== 3 && i !== 8) expect(lastResult).toBeNull()
      }
      expect(lastResult).toBeNull()
    })

    it("resets the count once more than 15 minutes pass since the last matching command", () => {
      const session = nextSession()
      noteVerifyCommand(session, "conductor", "jest", BASE)
      noteVerifyCommand(session, "conductor", "jest", BASE + 1000)
      const afterReset = BASE + 1000 + WINDOW_MS + 1
      // More than 15 min after lastAt -> the window resets, so this is count 1, not 3.
      expect(noteVerifyCommand(session, "conductor", "jest", afterReset)).toBeNull()
      expect(noteVerifyCommand(session, "conductor", "jest", afterReset + 1000)).toBeNull()
      expect(noteVerifyCommand(session, "conductor", "jest", afterReset + 2000)).not.toBeNull()
    })

    it("never counts for a non-conductor agent", () => {
      const session = nextSession()
      for (let i = 0; i < 10; i++) {
        expect(noteVerifyCommand(session, "runner", "jest", BASE + i * 1000)).toBeNull()
      }
    })

    it("never counts a non-test command", () => {
      const session = nextSession()
      for (let i = 0; i < 10; i++) {
        expect(noteVerifyCommand(session, "conductor", "git status", BASE + i * 1000)).toBeNull()
      }
    })
  })
})
