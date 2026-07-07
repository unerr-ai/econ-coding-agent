import { formatCount, formatReportDate } from "./format.js"

export function renderSummary(count: number, when: Date): string {
  return `${formatCount(count)} items as of ${formatReportDate(when)}`
}
