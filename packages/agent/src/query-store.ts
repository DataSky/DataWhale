/**
 * QueryStore — Persistent storage for Query objects
 * 
 * Stores complete Query (userContent + spans[]) as JSON in SQLite.
 * One Query per row, no more fragmented messages.
 * 
 * Compatible dual-format writes: also writes to messages/sessions tables
 * so the existing frontend (which reads from messages table) continues
 * to work while gradually migrating to Query/Span format.
 */

import type { Query, Span, ToolCallSpan } from "./query-types.js"

export class QueryStore {
  private dbPath: string
  private _db: any = null

  constructor(dbPath = `${process.env.HOME || "~"}/.datawhale/sessions.db`) {
    this.dbPath = dbPath
  }

  async init(): Promise<any> {
    if (this._db) return this._db

    const initSqlJs = (await import("sql.js")).default
    const SQL = await initSqlJs()
    const fs = await import("node:fs")
    const path = await import("node:path")

    const dir = path.dirname(this.dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath)
      this._db = new SQL.Database(buf)
    } else {
      this._db = new SQL.Database()
    }

    // ── New format: queries table ─────────────────────────────────────────────
    this._db.run(`
      CREATE TABLE IF NOT EXISTS queries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_content TEXT NOT NULL,
        spans_json TEXT NOT NULL,
        model TEXT DEFAULT 'unknown',
        usage_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `)

    this._db.run(`CREATE INDEX IF NOT EXISTS idx_queries_session ON queries(session_id)`)
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at)`)

    // ── Old format: sessions and messages tables (compatible writes) ──────────
    // These tables match SessionStore's schema exactly so both stores
    // can safely operate on the same file.
    this._db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0,
        model TEXT DEFAULT 'deepseek'
      )
    `)

    this._db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        thinking TEXT,
        timestamp INTEGER NOT NULL,
        meta TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `)

    // ── Auto-migration: add missing columns (same as SessionStore) ────────────
    try {
      const cols = this._db.exec("PRAGMA table_info(messages)")
      if (cols[0]) {
        const colNames = cols[0].values.map((r: any) => r[1])
        if (!colNames.includes("thinking")) {
          this._db.run("ALTER TABLE messages ADD COLUMN thinking TEXT")
        }
        if (!colNames.includes("meta")) {
          this._db.run("ALTER TABLE messages ADD COLUMN meta TEXT")
        }
      }
    } catch {}

    return this._db
  }

  // ─── Core: Query CRUD ──────────────────────────────────────────────────────

  async saveQuery(query: Query): Promise<void> {
    const db = await this.init()

    // 1) Write new-format: queries table
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO queries (id, session_id, user_content, spans_json, model, usage_json, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    stmt.run([
      query.id,
      query.sessionId,
      query.userContent,
      JSON.stringify(query.spans),
      query.model,
      query.usage ? JSON.stringify(query.usage) : null,
      query.createdAt,
    ])
    stmt.free()

    // 2) Write old-format compatible: sessions + messages tables
    this._ensureSession(query.sessionId, query.userContent.slice(0, 40), query.model)
    this._writeMessages(query)

    await this._save()
  }

  async loadQueries(sessionId: string): Promise<Query[]> {
    const db = await this.init()
    const stmt = db.prepare(
      `SELECT id, session_id, user_content, spans_json, model, usage_json, created_at 
       FROM queries WHERE session_id = ? ORDER BY created_at ASC`
    )
    stmt.bind([sessionId])

    const results: Query[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      results.push({
        id: row.id as string,
        sessionId: row.session_id as string,
        userContent: row.user_content as string,
        spans: JSON.parse(row.spans_json as string) as Span[],
        model: row.model as string || "unknown",
        usage: row.usage_json ? JSON.parse(row.usage_json as string) : undefined,
        createdAt: row.created_at as number,
      })
    }
    stmt.free()
    return results
  }

  async count(sessionId?: string): Promise<number> {
    const db = await this.init()
    const sql = sessionId
      ? "SELECT COUNT(*) as cnt FROM queries WHERE session_id = ?"
      : "SELECT COUNT(*) as cnt FROM queries"
    const stmt = db.prepare(sql)
    if (sessionId) stmt.bind([sessionId])
    stmt.step()
    const cnt = (stmt.getAsObject() as any).cnt as number
    stmt.free()
    return cnt
  }

  // ─── Compatible writes: old-format sessions + messages ─────────────────────

  /** Ensure a session row exists so FK constraint is satisfied. */
  private _ensureSession(sessionId: string, title: string, model: string): void {
    const now = Date.now()
    this._db.run(
      `INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, title || "Untitled", now, now, model]
    )
  }

  /** Convert Query spans into old-format message rows and insert them. */
  private _writeMessages(query: Query): void {
    const db = this._db
    const insertStmt = db.prepare(
      "INSERT OR IGNORE INTO messages (session_id, role, content, thinking, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)"
    )

    // ── User message ──
    insertStmt.run([
      query.sessionId,
      "user",
      query.userContent,
      null,
      query.createdAt,
      "{}",
    ])

    // ── Assistant message (reconstructed from spans) ──
    let textContent = ""
    let thinkingContent = ""
    const toolCalls: Array<{ id: string; name: string; arguments: string; result: string }> = []

    for (const span of query.spans) {
      switch (span.type) {
        case "thinking":
          thinkingContent += span.content
          break
        case "text":
          textContent += span.content
          break
        case "tool_call": {
          const tc = span as ToolCallSpan
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            result: tc.result || "",
          })
          break
        }
      }
    }

    const meta: Record<string, unknown> = {}
    if (toolCalls.length > 0) meta.toolCalls = toolCalls
    if (query.usage) meta.usage = query.usage

    insertStmt.run([
      query.sessionId,
      "assistant",
      textContent,
      thinkingContent || null,
      query.createdAt + 1, // slightly after user message
      JSON.stringify(meta),
    ])

    insertStmt.free()
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private async _save(): Promise<void> {
    if (!this._db) return
    const fs = await import("node:fs")
    const data = this._db.export()
    fs.writeFileSync(this.dbPath, Buffer.from(data))
  }
}
