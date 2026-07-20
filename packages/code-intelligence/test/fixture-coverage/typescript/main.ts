// One relative import (resolves), one directory-index import (resolves via
// ./utils -> ./utils/index.ts), one external import (stays unresolved — a
// node: builtin rather than an npm package so the fixture typechecks
// without a real dependency; the resolver treats any non-relative
// specifier identically) — see coverage-invariant.test.ts's CORPUS row for
// the exact expected counts this file exists to produce.
import { helper } from "./helper"
import { util } from "./utils"
import { EOL } from "node:os"

export function run(): number {
  return helper() + util()
}
