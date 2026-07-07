import { describe, expect, it } from "bun:test"
import { shellCommandFor } from "../../src/tool/shell"

describe("shellCommandFor", () => {
  it("prepends unsetopt nomatch for zsh so an unmatched glob doesn't abort the chain", () => {
    const command = "ls jest.config* babel.config*"
    expect(shellCommandFor("/bin/zsh", command)).toBe(`unsetopt nomatch 2>/dev/null; ${command}`)
  })

  it("matches zsh regardless of the resolved binary's directory", () => {
    const command = "echo hi"
    expect(shellCommandFor("/usr/local/bin/zsh", command)).toBe(`unsetopt nomatch 2>/dev/null; ${command}`)
  })

  const NON_ZSH = ["/bin/bash", "/bin/sh", "/usr/local/bin/fish", "/usr/bin/dash"]

  it.each(NON_ZSH)("leaves the command unchanged for %s", (shellPath) => {
    const command = "ls jest.config* babel.config*"
    expect(shellCommandFor(shellPath, command)).toBe(command)
  })

  it("is pure — the original command string is untouched after the call", () => {
    const command = "ls jest.config* babel.config*"
    const before = command
    shellCommandFor("/bin/zsh", command)
    expect(command).toBe(before)
  })
})
