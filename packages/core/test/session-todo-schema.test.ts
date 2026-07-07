import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionTodo } from "@opencode-ai/core/session/todo"

const decode = Schema.decodeUnknownSync(SessionTodo.Info)

const untyped = { content: "do a thing", status: "pending", priority: "high" }

describe("SessionTodo.Info — OL-7.1 typed decomposition fields", () => {
  test("backward compat: an untyped item (no new fields) round-trips unchanged", () => {
    expect(decode(untyped)).toEqual(untyped)
  })

  test("accepts a fully typed slice with sliceType, need, deps, coupling, testStrength", () => {
    const typed = {
      ...untyped,
      sliceType: "mechanical",
      need: "executor",
      deps: ["design-the-interface"],
      coupling: "high",
      testStrength: "testable",
    }
    expect(decode(typed)).toEqual(typed)
  })

  test("accepts a slice with only sliceType and need set (deps/coupling/testStrength omitted)", () => {
    const partial = { ...untyped, sliceType: "design", need: "oracle" }
    expect(decode(partial)).toEqual(partial)
  })

  test("accepts an empty deps array (a root slice with no dependencies)", () => {
    const withDeps = { ...untyped, deps: [] }
    expect(decode(withDeps)).toEqual(withDeps)
  })

  test("rejects a non-string sliceType", () => {
    expect(() => decode({ ...untyped, sliceType: 1 })).toThrow()
  })

  test("rejects a non-array deps", () => {
    expect(() => decode({ ...untyped, deps: "design-the-interface" })).toThrow()
  })

  test("rejects a deps array with a non-string element", () => {
    expect(() => decode({ ...untyped, deps: [1, 2] })).toThrow()
  })

  test("still rejects payloads missing the required base fields", () => {
    expect(() => decode({ content: "do a thing" })).toThrow()
  })
})
