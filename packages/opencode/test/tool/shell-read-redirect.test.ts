import { describe, expect, test } from "bun:test"
import { readShapedCommand } from "../../src/tool/shell"

// econ: read-shaped bash commands are short-circuited (in ShellTool.execute, gated on
// experimental.redirect_bash_reads) with a result that redirects the model to the read/search/
// file_outline tools. readShapedCommand is the classifier; these cases pin its boundary so the
// "bash is never a read path" guarantee can't silently regress.
describe("readShapedCommand", () => {
  // Pure read / list / search commands the model reaches for to orient — must redirect.
  const REDIRECT: Array<[string, string]> = [
    ["ls -la", "ls"],
    ["cat src/foo.ts", "cat"],
    ["find . -name '*.ts' | wc -l", "find"],
    ['find ~/x -type f -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l', "find"],
    ["find . -type f -exec wc -l {} +", "find"],
    ["grep -rn compressShellOutput src", "grep"],
    ["rg -e 'pattern' .", "rg"],
    ["head -50 a.ts", "head"],
    ["tail -f b.log 2>&1", "tail"],
    ["tree src", "tree"],
    ["du -sh .", "du"],
    ["wc -l x 2>&1", "wc"],
    ["/usr/bin/cat file", "cat"], // absolute path → basename
  ]

  test.each(REDIRECT)("redirects read-shaped command: %s", (command, bin) => {
    expect(readShapedCommand(command)).toBe(bin)
  })

  // Real work, or a read command that also mutates / writes a file — must pass through to bash.
  const PASS = [
    "npm test",
    "git log --oneline",
    "bun run build",
    "node script.js",
    "find . -name '*.log' -delete", // mutating find
    "find . -type f -exec rm {} +", // mutating find
    "cat template.txt > out.txt", // writes a file
    "grep x f >> hits.txt", // appends a file
    "rm -rf dist",
    "mkdir -p build",
    "tee log.txt",
  ]

  test.each(PASS)("passes through (not a pure read): %s", (command) => {
    expect(readShapedCommand(command)).toBeUndefined()
  })
})
