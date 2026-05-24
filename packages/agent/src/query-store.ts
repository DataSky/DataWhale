/**
 * QueryStore — Persistent storage for Query objects
 * 
 * Stores complete Query (userContent + spans[]) as JSON in SQLite.
 * One Query per row, no more fragmented messages.
 */

import type { Query, Span } from "./query-types.js"

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
    return this._db
  }

  async saveQuery(query: Query): Promise<void> {
    const db = await this.init()
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

  private async _save(): Promise<void> {
    if (!this._db) return
    const fs = await import("node:fs")
    const data = this._db.export()
    fs.writeFileSync(this.dbPath, Buffer.from(data))
  }
}
