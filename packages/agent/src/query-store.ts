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
import { getDatabase, saveDatabase } from "./db-pool.js"

export class QueryStore {
  private dbPath: string
  private _initialised = false

  constructor(dbPath = `${process.env.HOME || "~"}/.datawhale/sessions.db`) {
    this.dbPath = dbPath
  }

  async init(): Promise<any> {
    const db = await getDatabase(this.dbPath)

    if (!this._initialised) {
      // ── New format: queries table ───────────────────────────────────────────
      db.run(`
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

      db.run(`CREATE INDEX IF NOT EXISTS idx_queries_session ON queries(session_id)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at)`)

      // ── Old format: sessions and messages tables (compatible writes) ────────
      // These tables match SessionStore's schema exactly so both stores
      // can safely operate on the same shared Database instance via db-pool.
      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          message_count INTEGER DEFAULT 0,
          model TEXT DEFAULT 'deepseek'
        )
      `)

      db.run(`
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

      // ── Auto-migration: add missing columns (same as SessionStore) ──────────
      try {
        const cols = db.exec("PRAGMA table_info(messages)")
        if (cols[0]) {
          const colNames = cols[0].values.map((r: any) => r[1])
          if (!colNames.includes("thinking")) {
            db.run("ALTER TABLE messages ADD COLUMN thinking TEXT")
          }
          if (!colNames.includes("meta")) {
            db.run("ALTER TABLE messages ADD COLUMN meta TEXT")
          }
        }
      } catch {}

      this._initialised = true
    }

    return db
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
      JSON.stringify(query.turns || (query as any).spans || []),
      query.model,
      query.usage ? JSON.stringify(query.usage) : null,
      query.createdAt,
    ])
    stmt.free()

    // 2) Compatible writes removed — sessionStore now owns messages persistence.
    // Dual-write was causing COUNT skew in sessionStore's incremental save,
    // leading to lost tool_result messages and tool_call_id mismatches.
    await saveDatabase(this.dbPath)
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
      const parsed = JSON.parse(row.spans_json as string)
      let turns: import("./query-types.js").Turn[] = []
      if (Array.isArray(parsed) && parsed.length > 0 && (parsed[0] as any).spans) {
        turns = parsed as import("./query-types.js").Turn[]
      } else if (Array.isArray(parsed)) {
        turns = [{ spans: parsed as Span[], startedAt: row.created_at as number, completedAt: row.created_at as number }]
      }
      results.push({
        id: row.id as string,
        sessionId: row.session_id as string,
        userContent: row.user_content as string,
        turns,
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
  private _ensureSession(db: any, sessionId: string, title: string, model: string): void {
    const now = Date.now()
    db.run(
      `INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, title || "Untitled", now, now, model]
    )
  }

  /** Convert Query spans into old-format message rows and insert them. */
  private _writeMessages(db: any, query: Query): void {
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
}
