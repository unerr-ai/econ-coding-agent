// Generates the weekly ops report. Plain JS, no types, no tests — the shape
// of a real "legacy" script a test-poor repo actually has.
function generateReport(rows) {
  return rows.map((r) => `${r.name}: ${r.value}`).join("\n")
}

module.exports = { generateReport }
