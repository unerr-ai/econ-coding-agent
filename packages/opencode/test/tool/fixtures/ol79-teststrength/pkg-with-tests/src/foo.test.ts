import { test } from "bun:test"
import { foo } from "./foo"

test("foo", () => {
  foo()
})
