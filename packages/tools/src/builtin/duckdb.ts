/**
 * Built-in database tools — SQLite (via sql.js WASM)
 * 
 * Uses sql.js: pure WASM, no Worker threads, works everywhere (Bun / Node / browser).
 * Provides the same AgentTools: list_tables, describe_table, query, get_sample.
 */

import type { AgentTool } from "@datawhale/agent"

// ─── SQL.js Initialization ────────────────────────────────────────────────────

let _db: any = null
let _initPromise: Promise<any> | null = null

async function initDB(): Promise<any> {
  if (_db) {
    try {
      _db.exec("SELECT 1")
      return _db
    } catch {
      _db = null
      _initPromise = null
    }
  }

  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    const initSqlJs = (await import("sql.js")).default
    const SQL = await initSqlJs()
    _db = new SQL.Database()
    return _db
  })()

  return _initPromise
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

async function query(sql: string): Promise<Record<string, unknown>[]> {
  const db = await initDB()
  const results: Record<string, unknown>[] = []
  try {
    const stmt = db.prepare(sql)
    if (!stmt) throw new Error(`Failed to prepare: ${sql.slice(0, 80)}`)
    while (stmt.step()) {
      const row = stmt.getAsObject()
      results.push(row)
    }
    stmt.free()
  } catch (err: any) {
    // sql.js throws on DDL statements via prepare; use exec for those
    if (err.message?.includes("prepared statement")) {
      db.exec(sql)
    } else {
      throw err
    }
  }
  return results
}

async function exec(sql: string): Promise<void> {
  const db = await initDB()
  db.run(sql)
}

interface QueryCacheEntry {
  result: string
  timestamp: number
}

const queryCache = new Map<string, QueryCacheEntry>()
const CACHE_TTL = 60_000

function cacheKey(sql: string): string {
  return sql.trim().toLowerCase()
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "bigint") return v.toString()
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const listTablesTool: AgentTool = {
  name: "list_tables",
  description:
    "List all tables in the database. Use this to discover what data is available before querying.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Optional: search pattern to filter table names (LIKE syntax)",
      },
    },
    required: [],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const pattern = (params.pattern as string) || ""
    let sql = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    if (pattern) {
      sql = `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '${pattern.replace(/'/g, "''")}' ORDER BY name`
    }
    const rows = await query(sql)
    if (rows.length === 0) {
      return { content: "No tables found in the database.", details: { tableCount: 0 } }
    }
    const names = rows.map((r) => String(r.name))
    return {
      content: `Found ${names.length} table(s):\n${names.map((t) => `  - ${t}`).join("\n")}`,
      details: { tableCount: names.length, tables: names },
    }
  },
}

const describeTableTool: AgentTool = {
  name: "describe_table",
  description:
    "Get the schema (column names, types, nullability) for a specific table. Use this before writing queries.",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string", description: "The table name to describe" },
    },
    required: ["table"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const tableName = params.table as string
    const cols = await query(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`)
    if (cols.length === 0) {
      return {
        content: `Table "${tableName}" not found or has no columns.`,
        details: { table: tableName, columns: [], rowCount: 0 },
      }
    }
    const countResult = await query(
      `SELECT COUNT(*) as cnt FROM "${tableName.replace(/"/g, '""')}"`
    )
    const rowCount = countResult[0]?.cnt ?? "unknown"

    const lines = cols.map(
      (c: any) =>
        `  - ${c.name}: ${c.type}${c.notnull ? " (NOT NULL)" : ""}${c.pk ? " [PK]" : ""}`
    )
    return {
      content: `Table: ${tableName}\nRows: ${rowCount}\nColumns:\n${lines.join("\n")}`,
      details: {
        table: tableName,
        rowCount: typeof rowCount === "bigint" ? Number(rowCount) : rowCount,
        columns: cols.map((c: any) => ({
          name: c.name,
          type: c.type,
          nullable: !c.notnull,
        })),
      },
    }
  },
}

const queryTool: AgentTool = {
  name: "query",
  description:
    "Execute a SQL query. Only SELECT allowed for safety. Results limited to 1000 rows. Always explore schema first.",
  parameters: {
    type: "object",
    properties: {
      sql: { type: "string", description: "The SQL query (SELECT only)" },
      limit: { type: "number", description: "Max rows (default 100, max 1000)" },
    },
    required: ["sql"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    let sql = (params.sql as string).trim()
    const upperSql = sql.toUpperCase()

    if (
      !upperSql.startsWith("SELECT") &&
      !upperSql.startsWith("WITH") &&
      !upperSql.startsWith("EXPLAIN") &&
      !upperSql.startsWith("PRAGMA")
    ) {
      throw new Error("Only read-only queries (SELECT, WITH, EXPLAIN, PRAGMA) are allowed.")
    }

    const key = cacheKey(sql)
    const cached = queryCache.get(key)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return { content: cached.result, details: { cached: true } }
    }

    const limit = Math.min((params.limit as number) || 100, 1000)
    if (!upperSql.includes("LIMIT")) {
      sql = `${sql} LIMIT ${limit}`
    }

    const rows = await query(sql)
    if (rows.length === 0) {
      return { content: "Query returned no rows.", details: { rowCount: 0, sql } }
    }

    const columns = Object.keys(rows[0])
    const displayRows = rows.slice(0, limit)
    let output = `Query returned ${rows.length} row(s).`
    if (rows.length > limit) output += ` Showing first ${limit}.`

    // ASCII table renderer
    const colWidths = columns.map((c, i) => {
      let w = c.length
      for (const r of displayRows) w = Math.max(w, String(r[c] ?? "NULL").length)
      return Math.min(w, 25)
    })
    const tblPad = (s: string, w: number) => {
      if (s.length > w) return s.slice(0, w - 1) + "…"
      return s + " ".repeat(w - s.length)
    }
    const sep = "─"
    output += `\n┌${colWidths.map((w) => sep.repeat(w + 2)).join("┬")}┐`
    output += `\n│ ${columns.map((c, i) => tblPad(c, colWidths[i])).join(" │ ")} │`
    output += `\n├${colWidths.map((w) => sep.repeat(w + 2)).join("┼")}┤`

    for (const row of displayRows) {
      const vals = columns.map((c, i) => {
        const v = row[c]
        if (v === null) return "NULL"
        if (typeof v === "bigint") return v.toString()
        if (typeof v === "number") return Number.isInteger(v) ? v.toString() : Number(v).toFixed(2)
        return String(v)
      })
      output += `\n│ ${vals.map((v, i) => tblPad(v, colWidths[i])).join(" │ ")} │`
    }
    output += `\n└${colWidths.map((w) => sep.repeat(w + 2)).join("┴")}┘`

    // Truncate long outputs to avoid context explosion
    const maxLen = 6000
    if (output.length > maxLen) {
      output = output.slice(0, maxLen) + `\n... (truncated, ${output.length} chars total, ${rows.length} rows)`
    }

    queryCache.set(key, { result: output, timestamp: Date.now() })
    return {
      content: output,
      details: { rowCount: rows.length, displayCount: displayRows.length, columns, sql },
    }
  },
}

const getSampleTool: AgentTool = {
  name: "get_sample",
  description: "Get random sample rows from a table. Useful for understanding actual data values.",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      rows: { type: "number", description: "Sample size (default 5, max 20)" },
    },
    required: ["table"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const tableName = params.table as string
    const count = Math.min((params.rows as number) || 5, 20)

    const rows = await query(
      `SELECT * FROM "${tableName.replace(/"/g, '""')}" ORDER BY RANDOM() LIMIT ${count}`
    )
    if (rows.length === 0) {
      return {
        content: `Table "${tableName}" is empty.`,
        details: { table: tableName, sampleRows: 0 },
      }
    }

    const columns = Object.keys(rows[0])
    let output = `Sample of ${tableName} (${rows.length} rows):\n\nColumns: ${columns.join(" | ")}\n${"-".repeat(60)}`
    for (const row of rows) {
      output += `\n${columns.map((c) => formatValue(row[c])).join(" | ")}`
    }

    return { content: output, details: { table: tableName, sampleRows: rows.length, columns } }
  },
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const DuckDBTools = {
  all: [listTablesTool, describeTableTool, queryTool, getSampleTool] as AgentTool[],
  listTables: listTablesTool,
  describeTable: describeTableTool,
  query: queryTool,
  getSample: getSampleTool,
  /** Raw DB init for testing/setup (bypasses query safety checks) */
  initDB,
}
