import { describe, expect, it } from "bun:test"
import { getBuiltinRedactRules, redactOutput, REDACTION_MARKER } from "../../src/tool/shell-compress/strategies/redact"
import { compressShellOutput } from "../../src/tool/shell-compress/index"

describe("redactOutput — secret redaction", () => {
  it("redacts an AWS access key id", () => {
    const out = redactOutput("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(out).toContain(REDACTION_MARKER)
  })

  it("redacts an aws_secret_access_key assignment, keeping the key name", () => {
    const out = redactOutput("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    expect(out).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    expect(out).toContain("aws_secret_access_key")
    expect(out).toContain(REDACTION_MARKER)
  })

  it("redacts an Authorization bearer header", () => {
    const out = redactOutput("Authorization: Bearer abcDEF123.token-value_here")
    expect(out).not.toContain("abcDEF123.token-value_here")
    expect(out).toContain(REDACTION_MARKER)
  })

  it("redacts a bare bearer token not preceded by an Authorization header", () => {
    const out = redactOutput('curl -H "Bearer sk-live-1234567890abcdef"')
    expect(out).not.toContain("sk-live-1234567890abcdef")
    expect(out).toContain(REDACTION_MARKER)
  })

  it("redacts a password assignment in JSON-shaped output, keeping the key name", () => {
    const out = redactOutput('{"user":"admin","password":"hunter2"}')
    expect(out).not.toContain("hunter2")
    expect(out).toContain('"password":"' + REDACTION_MARKER + '"')
  })

  it("redacts a generic api_key assignment", () => {
    const out = redactOutput("api_key=sk_test_51Hxxxxxxxxxxxxxxxxxxxx")
    expect(out).not.toContain("sk_test_51Hxxxxxxxxxxxxxxxxxxxx")
    expect(out).toContain("api_key")
    expect(out).toContain(REDACTION_MARKER)
  })

  it("redacts credentials embedded in a connection string but keeps user/host", () => {
    const out = redactOutput("postgres://dbuser:s3cr3t@db.internal:5432/prod")
    expect(out).not.toContain("s3cr3t")
    expect(out).toBe(`postgres://dbuser:${REDACTION_MARKER}@db.internal:5432/prod`)
  })

  it("redacts a GitHub personal access token", () => {
    const out = redactOutput("token=ghp_1234567890ABCDEFghijklmnopqrstuvwxyz")
    expect(out).not.toContain("ghp_1234567890ABCDEFghijklmnopqrstuvwxyz")
  })

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    const out = redactOutput(`session=${jwt}`)
    expect(out).not.toContain(jwt)
    expect(out).toContain(REDACTION_MARKER)
  })

  it("leaves ordinary output untouched", () => {
    const text = "Compiling... done in 1.2s\n3 files changed"
    expect(redactOutput(text)).toBe(text)
  })

  it("is a no-op on empty input", () => {
    expect(redactOutput("")).toBe("")
  })

  it("exposes builtin rules for inspection", () => {
    expect(getBuiltinRedactRules().length).toBeGreaterThan(0)
  })
})

describe("compressShellOutput — redaction wired before classify", () => {
  it("never leaks a bearer token even through the generic strategy path", () => {
    const command = "curl -sS https://api.example.com/v1/status"
    const output = [
      "Authorization: Bearer abcDEF123.token-value_here",
      "HTTP/1.1 200 OK",
      "content-type: application/json",
      '{"status":"ok"}',
    ].join("\n")

    const result = compressShellOutput(command, output)

    expect(result.text).not.toContain("abcDEF123.token-value_here")
  })
})
