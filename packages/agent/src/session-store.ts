/**
 * Session persistence — save/restore conversations to SQLite
 * 
 * Stores: session metadata, message history, tool results
 * Enables: session listing, resume, export
 */

import type { AgentMessage, AgentState } from "../index.js"

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  model: string
}

// ─── Session Store ────────────────────────────────────────────────────────────

export class SessionStore {
  private dbPath: string
  private _db: any = null

  constructor(dbPath = `${process.env.HOME || "~"}/.datawhale/sessions.db`) {
    this.dbPath = dbPath
  }

  private async init(): Promise<any> {
    if (this._db) return this._db

    const initSqlJs = (await import("sql.js")).default
    const SQL = await initSqlJs()

    // Try loading existing DB, or create new
    const fs = await import("node:fs")
    const path = await import("node:path")

    const dir = path.dirname(this.dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath)
      this._db = new SQL.Database(buf)
    } else {
      this._db = new SQL.Database()
    }

    // Ensure schema
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

    return this._db
  }

  private async save(): Promise<void> {
    if (!this._db) return
    const fs = await import("node:fs")
    const data = this._db.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(this.dbPath, buffer)
  }

  // ─── Session CRUD ───────────────────────────────────────────────────────────

  async createSession(title: string, model = "deepseek"): Promise<SessionMeta> {
    const db = await this.init()
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()

    db.run("INSERT INTO sessions (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?)", [
      id, title, now, now, model,
    ])
    await this.save()

    return { id, title, createdAt: now, updatedAt: now, messageCount: 0, model }
  }

  async listSessions(limit = 20): Promise<SessionMeta[]> {
    const db = await this.init()
    const stmt = db.prepare(
      "SELECT id, title, created_at, updated_at, message_count, model FROM sessions ORDER BY updated_at DESC LIMIT ?"
    )
    stmt.bind([limit])

    const sessions: SessionMeta[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      sessions.push({
        id: row.id as string,
        title: row.title as string,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        messageCount: row.message_count as number,
        model: row.model as string,
      })
    }
    stmt.free()
    return sessions
  }

  async getSession(id: string): Promise<SessionMeta | null> {
    const db = await this.init()
    const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?")
    stmt.bind([id])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const row = stmt.getAsObject()
    stmt.free()
    return {
      id: row.id as string,
      title: row.title as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      messageCount: row.message_count as number,
      model: row.model as string,
    }
  }

  async deleteSession(id: string): Promise<void> {
    const db = await this.init()
    db.run("DELETE FROM messages WHERE session_id = ?", [id])
    db.run("DELETE FROM sessions WHERE id = ?", [id])
    await this.save()
  }

  // ─── Message Persistence ─────────────────────────────────────────────────────

  async saveMessages(sessionId: string, messages: AgentMessage[]): Promise<void> {
    const db = await this.init()

    // Only save new messages (avoid duplicates by content hash)
    const insertStmt = db.prepare(
      "INSERT OR IGNORE INTO messages (session_id, role, content, thinking, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)"
    )

    const now = Date.now()
    for (const msg of messages) {
      // Flatten content array to pure text for consistent display
      const content = typeof msg.content === "string"
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.filter(function(p: any) { return p && p.type === "text" }).map(function(p: any) { return p.text || "" }).join("\n") : "")
      // Collapse one-word-per-line patterns (DeepSeek V4 quirk)
      const collapsed = collapseNewlines(content)
      // Extract tool calls into meta for frontend display
      const toolCalls = Array.isArray(msg.content)
        ? msg.content.filter(function(p: any) { return p && p.type === "tool_call" }).map(function(p: any) { return { id: p.id, name: p.name, arguments: p.arguments } })
        : []
      const meta = { ...(msg.meta || {}), ...(toolCalls.length > 0 ? { toolCalls } : {}) }
      const metaJson = JSON.stringify(meta)
      const thinking = msg.thinking || null
      insertStmt.run([sessionId, msg.role, collapsed, thinking, msg.timestamp || now, metaJson])
    }
    insertStmt.free()

    // Update message count
    db.run(
      "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), updated_at = ? WHERE id = ?",
      [sessionId, now, sessionId]
    )

    await this.save()
  }

  async loadMessages(sessionId: string): Promise<AgentMessage[]> {
    const db = await this.init()
    const stmt = db.prepare(
      "SELECT role, content, thinking, timestamp, meta FROM messages WHERE session_id = ? ORDER BY id ASC"
    )
    stmt.bind([sessionId])

    const messages: AgentMessage[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      messages.push({
        role: row.role as AgentMessage["role"],
        content: (row.content as string) || "",
        thinking: (row as any).thinking || undefined,
        timestamp: row.timestamp as number,
        meta: row.meta ? JSON.parse(row.meta as string) : undefined,
      })
    }
    stmt.free()
    return messages
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    const db = await this.init()
    db.run("UPDATE sessions SET title = ? WHERE id = ?", [title, sessionId])
    await this.save()
  }
}

// Heuristic: collapse one-word-per-line to continuous prose
// When >15% of characters are newlines and most newlines are single (not double),
// merge single \n into spaces while preserving \n\n as paragraph breaks.
function collapseNewlines(text: string): string {
  if (!text) return text
  const newlineCount = (text.match(/\n/g) || []).length
  const totalChars = text.length
  if (newlineCount === 0 || totalChars === 0) return text
  
  // Only process if more than 10% of chars are newlines (heuristic for word-per-line)
  const newlineRatio = newlineCount / totalChars
  if (newlineRatio < 0.10) return text
  
  // Merge: single \n → space, \n\n kept as paragraph break
  // Strategy: replace \n that are NOT part of \n\n sequences
  const result = text
    .replace(/\n\n/g, "\x00")  // Temporarily mark paragraph breaks
    .replace(/\n/g, " ")        // Single newlines → space
    .replace(/\x00/g, "\n\n")   // Restore paragraph breaks
    .replace(/  +/g, " ")       // Collapse multiple spaces
    .trim()
  
  return result
}
