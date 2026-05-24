/**
 * Data I/O tools — CSV / JSON loading, data summarization
 * 
 * Provides AgentTools for:
 * - load_csv: Import CSV files into SQLite
 * - load_json: Import JSON arrays / NDJSON
 * - summarize_table: Generate column-level statistics
 */

import type { AgentTool } from "@datawhale/agent"

// We access the shared SQLite DB through DuckDBTools.initDB()
// But we need a reference. We'll import dynamically to avoid circular deps.
let _getDB: (() => Promise<any>) | null = null

export function setDBProvider(fn: () => Promise<any>): void {
  _getDB = fn
}

async function getDB(): Promise<any> {
  if (!_getDB) {
    const mod = await import("./duckdb.js")
    _getDB = () => mod.DuckDBTools.initDB()
  }
  return _getDB()
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) throw new Error("CSV must have at least a header row and one data row")

  const headers = parseCSVLine(lines[0])
  const rows: string[][] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const values = parseCSVLine(line)
    if (values.length !== headers.length) {
      // Pad or truncate to match headers
      while (values.length < headers.length) values.push("")
      values.length = headers.length
    }
    rows.push(values)
  }

  return { headers, rows }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ",") {
        result.push(current.trim())
        current = ""
      } else {
        current += ch
      }
    }
  }
  result.push(current.trim())
  return result
}

// ─── Type Inference ───────────────────────────────────────────────────────────

function inferSQLType(values: string[]): string {
  let intCount = 0
  let floatCount = 0
  let dateCount = 0
  let total = 0

  for (const v of values) {
    if (!v || v === "NULL" || v === "null" || v === "NA" || v === "") continue
    total++
    if (/^-?\d+$/.test(v)) intCount++
    else if (/^-?\d+\.?\d*$/.test(v)) floatCount++
    else if (/^\d{4}-\d{2}-\d{2}/.test(v)) dateCount++
  }

  if (total === 0) return "TEXT"
  if (intCount > total * 0.7) return "INTEGER"
  if (floatCount + intCount > total * 0.7) return "REAL"
  if (dateCount > total * 0.7) return "TEXT" // SQLite no native date, use TEXT
  return "TEXT"
}

// ─── Tool: load_csv ───────────────────────────────────────────────────────────

const loadCsvTool: AgentTool = {
  name: "load_csv",
  description:
    "Load a CSV file into the database. Creates a new table automatically, inferring column types from the data. The table name defaults to the filename (without extension).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the CSV file",
      },
      table_name: {
        type: "string",
        description: "Optional: custom table name (defaults to filename)",
      },
    },
    required: ["path"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const filePath = params.path as string
    const tableName = (params.table_name as string) || filePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "csv_data"

    // Read file
    const fs = await import("node:fs")
    const absPath = fs.existsSync(filePath) ? filePath : `${process.cwd()}/${filePath}`
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${absPath}`)
    }

    const content = fs.readFileSync(absPath, "utf-8")
    const { headers, rows } = parseCSV(content)

    // Sanitize column names
    const safeHeaders = headers.map((h) =>
      h.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || `col_${Math.random().toString(36).slice(2, 6)}`
    )
    // Ensure uniqueness
    const seen = new Set<string>()
    const uniqueHeaders = safeHeaders.map((h) => {
      let candidate = h
      let suffix = 2
      while (seen.has(candidate)) candidate = `${h}_${suffix++}`
      seen.add(candidate)
      return candidate
    })

    // Infer types
    const colTypes: string[] = []
    for (let c = 0; c < uniqueHeaders.length; c++) {
      const colValues = rows.map((r) => r[c] || "")
      colTypes.push(inferSQLType(colValues))
    }

    // Create table
    const db = await getDB()
    const colDefs = uniqueHeaders.map((h, i) => `"${h}" ${colTypes[i]}`).join(", ")
    db.run(`DROP TABLE IF EXISTS "${tableName}"`)
    db.run(`CREATE TABLE "${tableName}" (${colDefs})`)

    // Insert data in batches
    const BATCH = 500
    const placeholders = uniqueHeaders.map(() => "?").join(", ")
    const insertSQL = `INSERT INTO "${tableName}" VALUES (${placeholders})`
    const stmt = db.prepare(insertSQL)

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      for (const row of batch) {
        const values = uniqueHeaders.map((_, c) => {
          const v = row[c]
          if (!v || v === "NULL" || v === "null" || v === "NA") return null
          if (colTypes[c] === "INTEGER") return parseInt(v, 10) || null
          if (colTypes[c] === "REAL") return parseFloat(v) || null
          return v
        })
        stmt.run(values)
      }
    }
    stmt.free()

    // Get summary
    const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`)
    countStmt.step()
    const countRow = countStmt.getAsObject()
    const rowCount = countRow.cnt || 0
    countStmt.free()
    const sample = db.prepare(`SELECT * FROM "${tableName}" LIMIT 3`)

    const sampleRows: Record<string, unknown>[] = []
    while (sample.step()) sampleRows.push(sample.getAsObject())
    sample.free()

    let output = `Loaded "${tableName}" from ${absPath}\n`
    output += `  Rows: ${rowCount}\n`
    output += `  Columns: ${uniqueHeaders.length}\n\n`
    output += `Schema:\n`
    for (let i = 0; i < uniqueHeaders.length; i++) {
      output += `  ${uniqueHeaders[i]}: ${colTypes[i]}\n`
    }
    if (sampleRows.length > 0) {
      output += `\nSample (first 3 rows):\n`
      output += `  ${Object.keys(sampleRows[0]).join(" | ")}\n`
      output += `  ${"-".repeat(50)}\n`
      for (const r of sampleRows) {
        output += `  ${Object.values(r).map((v) => v ?? "NULL").join(" | ")}\n`
      }
    }

    return { content: output, details: { table: tableName, rows: rowCount, columns: uniqueHeaders.length } }
  },
}

// ─── Tool: load_json ──────────────────────────────────────────────────────────

const loadJsonTool: AgentTool = {
  name: "load_json",
  description:
    "Load a JSON file (array of objects or NDJSON) into the database. Creates a new table automatically.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the JSON file",
      },
      table_name: {
        type: "string",
        description: "Optional: custom table name",
      },
    },
    required: ["path"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const filePath = params.path as string
    const tableName = (params.table_name as string) || filePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "json_data"

    const fs = await import("node:fs")
    const absPath = fs.existsSync(filePath) ? filePath : `${process.cwd()}/${filePath}`
    if (!fs.existsSync(absPath)) throw new Error(`File not found: ${absPath}`)

    const content = fs.readFileSync(absPath, "utf-8")
    let objects: Record<string, unknown>[]

    try {
      const parsed = JSON.parse(content)
      objects = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // Try NDJSON (one JSON object per line)
      objects = content
        .trim()
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    }

    if (objects.length === 0) throw new Error("No JSON objects found in file")

    // Collect all keys
    const keySet = new Set<string>()
    for (const obj of objects) Object.keys(obj).forEach((k) => keySet.add(k))
    const columns = [...keySet].sort()

    // Infer types
    const colTypes: Record<string, string> = {}
    for (const col of columns) {
      const values = objects.map((o) => String(o[col] ?? ""))
      colTypes[col] = inferSQLType(values)
    }

    // Create table
    const db = await getDB()
    const colDefs = columns.map((c) => `"${c}" ${colTypes[c]}`).join(", ")
    db.run(`DROP TABLE IF EXISTS "${tableName}"`)
    db.run(`CREATE TABLE "${tableName}" (${colDefs})`)

    // Insert
    const placeholders = columns.map(() => "?").join(", ")
    const insertSQL = `INSERT INTO "${tableName}" VALUES (${placeholders})`
    const stmt = db.prepare(insertSQL)

    for (const obj of objects) {
      const values = columns.map((c) => {
        const v = obj[c]
        if (v === null || v === undefined) return null
        if (colTypes[c] === "INTEGER") return typeof v === "number" ? Math.floor(v) : parseInt(String(v), 10) || null
        if (colTypes[c] === "REAL") return typeof v === "number" ? v : parseFloat(String(v)) || null
        if (typeof v === "object") return JSON.stringify(v)
        return String(v)
      })
      stmt.run(values)
    }
    stmt.free()

    const countStmt2 = db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`)
    countStmt2.step()
    const countRow2 = countStmt2.getAsObject()
    countStmt2.free()
    return {
      content: `Loaded "${tableName}" from ${absPath}\n  Rows: ${countRow2.cnt || 0}\n  Columns: ${columns.length} (${columns.join(", ")})`,
      details: { table: tableName, rows: countRow2.cnt || 0, columns: columns.length },
    }
  },
}

// ─── Tool: summarize_table ────────────────────────────────────────────────────

const summarizeTableTool: AgentTool = {
  name: "summarize_table",
  description:
    "Generate column-level statistics for a table: count, nulls, distinct values, min/max/avg for numeric columns. Use this to understand data distribution before diving deeper.",
  parameters: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "The table name to summarize",
      },
    },
    required: ["table"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const tableName = params.table as string
    const db = await getDB()

    // Get column info
    const cols = []
    const colStmt = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`)
    while (colStmt.step()) cols.push(colStmt.getAsObject())
    colStmt.free()

    if (cols.length === 0) throw new Error(`Table "${tableName}" not found`)

    const totalStmt = db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName.replace(/"/g, '""')}"`)
    totalStmt.step()
    const totalRow = totalStmt.getAsObject()
    totalStmt.free()
    const total = (totalRow.cnt as number) || 0

    let output = `Summary of "${tableName}" (${total} rows, ${cols.length} columns):\n\n`

    for (const col of cols as any[]) {
      const name = col.name
      const type = col.type

      // Null count
      const nullStmt = db.prepare(
        `SELECT COUNT(*) as cnt FROM "${tableName.replace(/"/g, '""')}" WHERE "${name}" IS NULL`
      )
      nullStmt.step()
      const nullRow = nullStmt.getAsObject()
      nullStmt.free()
      const nullCount = (nullRow.cnt as number) || 0
      const nullPct = total > 0 ? ((nullCount / total) * 100).toFixed(1) : "0"

      // Distinct count
      const distinctStmt = db.prepare(
        `SELECT COUNT(DISTINCT "${name}") as cnt FROM "${tableName.replace(/"/g, '""')}"`
      )
      distinctStmt.step()
      const distinctRow = distinctStmt.getAsObject()
      distinctStmt.free()
      const distinctCount = (distinctRow.cnt as number) || 0

      output += `${name} (${type}):\n`
      output += `  non-null: ${total - nullCount}  |  nulls: ${nullCount} (${nullPct}%)  |  distinct: ${distinctCount}\n`

      // Numeric stats
      if (type === "INTEGER" || type === "REAL" || type.includes("NUM") || type.includes("DECIMAL")) {
        try {
          const statsStmt = db.prepare(
            `SELECT 
              MIN(CAST("${name}" AS REAL)) as min_val,
              MAX(CAST("${name}" AS REAL)) as max_val,
              AVG(CAST("${name}" AS REAL)) as avg_val
            FROM "${tableName.replace(/"/g, '""')}"
            WHERE "${name}" IS NOT NULL`
          )
          if (statsStmt.step()) {
            const stats = statsStmt.getAsObject()
            const minV = stats.min_val != null ? Number(stats.min_val).toFixed(2) : "N/A"
            const maxV = stats.max_val != null ? Number(stats.max_val).toFixed(2) : "N/A"
            const avgV = stats.avg_val != null ? Number(stats.avg_val).toFixed(2) : "N/A"
            output += `  min: ${minV}  |  max: ${maxV}  |  avg: ${avgV}\n`
          }
          statsStmt.free()
        } catch {
          // Skip stats if cast fails
        }
      }
    }

    return { content: output, details: { table: tableName, totalRows: total, columns: cols.length } }
  },
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const DataIOTools = {
  all: [loadCsvTool, loadJsonTool, summarizeTableTool] as AgentTool[],
  loadCsv: loadCsvTool,
  loadJson: loadJsonTool,
  summarizeTable: summarizeTableTool,
}
