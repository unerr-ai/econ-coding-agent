// Formats a report date. Two call sites in this tiny repo already disagree
// on the target format (index.ts uses ISO, the CHANGELOG generator — not
// included here — expects "DD/MM/YYYY"), which is exactly why "make the date
// formatting consistent" is an ambiguous ask without more context: consistent
// with which of the two existing conventions?
export function formatReportDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-IN")
}
