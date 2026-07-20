// One external CommonJS require (stays unresolved, no local file to
// resolve against) — see coverage-invariant.test.ts's CORPUS row for the
// exact expected counts this file exists to produce.
const _ = require("lodash")

function double(x) {
  return x * 2
}

module.exports = { double }
