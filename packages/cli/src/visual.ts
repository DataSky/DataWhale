/**
 * CLI visualization helpers — ASCII tables, sparklines, bar charts
 * Zero dependencies, pure TypeScript
 */

// ─── Unicode Characters ─────────────────────────────────────────────────────

const SPARK_CHARS = "▁▂▃▄▅▆▇█"
const BAR_FULL = "█"
const BAR_EMPTY = "░"

// ─── ASCII Table ─────────────────────────────────────────────────────────────

/** Render headers + rows as a bordered ASCII table */
export function renderTable(
  headers: string[],
  rows: (string | number | null)[][],
  maxWidth = 30
): string {
  // Calculate column widths
  const widths = headers.map((h, i) => {
    let max = h.length
    for (const row of rows) {
      const val = String(row[i] ?? "")
      max = Math.max(max, val.length)
    }
    return Math.min(max, maxWidth)
  })

  const pad = (s: string, w: number) => {
    if (s.length > w) return s.slice(0, w - 1) + "…"
    return s + " ".repeat(w - s.length)
  }

  const sep = "─"
  const top = "┌" + widths.map((w) => sep.repeat(w + 2)).join("┬") + "┐"
  const mid = "├" + widths.map((w) => sep.repeat(w + 2)).join("┼") + "┤"
  const bot = "└" + widths.map((w) => sep.repeat(w + 2)).join("┴") + "┘"

  const lines: string[] = [top]
  lines.push("│ " + headers.map((h, i) => pad(h, widths[i])).join(" │ ") + " │")
  lines.push(mid)

  for (const row of rows) {
    const cells = row.map((v, i) => pad(v === null || v === undefined ? "NULL" : String(v), widths[i]))
    lines.push("│ " + cells.join(" │ ") + " │")
  }

  lines.push(bot)
  return lines.join("\n")
}

// ─── Sparkline ───────────────────────────────────────────────────────────────

/** Convert a number array to a sparkline string ▁▂▃▄▅▆▇█ */
export function sparkline(values: number[]): string {
  if (values.length === 0) return ""
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  let result = ""
  for (const v of values) {
    const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1))
    result += SPARK_CHARS[Math.min(idx, SPARK_CHARS.length - 1)]
  }
  return result
}

// ─── Bar Chart ───────────────────────────────────────────────────────────────

/** Render a horizontal bar chart */
export function barChart(
  labels: string[],
  values: number[],
  maxBarLen = 30
): string {
  const max = Math.max(...values, 1)
  const maxLabelLen = Math.max(...labels.map((l) => l.length))

  const lines: string[] = []
  for (let i = 0; i < labels.length; i++) {
    const barLen = Math.round((values[i] / max) * maxBarLen)
    const bar = BAR_FULL.repeat(barLen) + BAR_EMPTY.repeat(maxBarLen - barLen)
    const label = labels[i].padEnd(maxLabelLen)
    lines.push(`${label}  ${bar}  ${values[i]}`)
  }
  return lines.join("\n")
}

// ─── Auto-format query results ──────────────────────────────────────────────

/** Take raw query result rows and auto-format as a bordered table */
export function formatQueryResult(columns: string[], rows: Record<string, unknown>[], maxRows = 20): string {
  if (rows.length === 0) return "Query returned no rows."

  const displayRows = rows.slice(0, maxRows).map((row) =>
    columns.map((c) => {
      const v = row[c]
      if (v === null || v === undefined) return "NULL"
      if (typeof v === "bigint") return v.toString()
      if (typeof v === "number") {
        // Format numbers nicely
        if (Number.isInteger(v)) return v.toString()
        return Number(v).toFixed(2)
      }
      return String(v)
    })
  )

  let output = renderTable(columns, displayRows)
  if (rows.length > maxRows) {
    output += `\n(Showing ${maxRows} of ${rows.length} rows)`
  }
  return output
}

/** Attach a sparkline to a row of numeric values */
export function sparklineRow(values: number[]): string {
  return sparkline(values)
}
