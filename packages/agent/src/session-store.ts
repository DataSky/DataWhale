/**
 * Session persistence — save/restore conversations to SQLite
 * 
 * Stores: session metadata, message history, tool results
 * Enables: session listing, resume, export
 */

import type { AgentMessage, AgentState } from "../index.js"
import { getDatabase, saveDatabase } from "./db-pool.js"

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
  private _initialised = false

  constructor(dbPath = `${process.env.HOME || "~"}/.datawhale/sessions.db`) {
    this.dbPath = dbPath
  }

  private async init(): Promise<any> {
    const db = await getDatabase(this.dbPath)

    if (!this._initialised) {
      // Ensure schema (idempotent)
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

      // ── Auto-migration: add missing columns ──────────────────────────────
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
      // ──────────────────────────────────────────────────────────────────────

      this._initialised = true
    }

    return db
  }

  // ─── Session CRUD ───────────────────────────────────────────────────────────

  async createSession(title: string, model = "deepseek"): Promise<SessionMeta> {
    const db = await this.init()
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()

    db.run("INSERT INTO sessions (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?)", [
      id, title, now, now, model,
    ])
    await saveDatabase(this.dbPath)

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
    await saveDatabase(this.dbPath)
  }

  // ─── Message Persistence ─────────────────────────────────────────────────────

  async saveMessages(sessionId: string, messages: AgentMessage[]): Promise<void> {
    const db = await this.init()

    // Incremental save: use session.message_count (owned solely by us) to
    // determine the slice point. This avoids COUNT skew from external writes.
    const metaStmt = db.prepare("SELECT message_count FROM sessions WHERE id = ?")
    metaStmt.bind([sessionId])
    metaStmt.step()
    const alreadySaved = (metaStmt.getAsObject().message_count as number) || 0
    metaStmt.free()
    const newMessages = messages.slice(alreadySaved)
    if (newMessages.length === 0) return

    const insertStmt = db.prepare(
      "INSERT INTO messages (session_id, role, content, thinking, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)"
    )

    const now = Date.now()
    // Build a map of tool results from subsequent tool_result messages
    const toolResults: Record<string, string> = {}
    for (const msg of messages) {
      if (msg.role === "tool_result" && Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if ((p as any).type === "tool_result" && (p as any).toolCallId) {
            toolResults[(p as any).toolCallId] = (p as any).content || ""
          }
        }
      }
    }

    // Collect artifact data from tool_result → forward to next assistant message
    interface PendingArtifact { id: string; type: string; title: string; html?: string; fileUrl?: string }
    const pendingArtifacts: PendingArtifact[] = []

    for (const msg of newMessages) {
      // Check if this tool_result carries artifact data (from generate_html or execute_python)
      if (msg.role === "tool_result" && msg.meta?.details) {
        const dt = msg.meta.details as Record<string, unknown>
        // Inline HTML artifact (generate_html)
        if (dt.artifactHtml && dt.artifactId) {
          pendingArtifacts.push({
            id: dt.artifactId as string,
            type: (dt.artifactType as string) || "html",
            title: (dt.title as string) || "Artifact",
            html: dt.artifactHtml as string,
          })
        }
        // File-based HTML artifacts (execute_python → .html file export)
        const htmlArts = dt.htmlArtifacts as Array<{ id: string; title: string; fileUrl: string }> | undefined
        if (htmlArts && htmlArts.length > 0) {
          for (const ha of htmlArts) {
            pendingArtifacts.push({
              id: ha.id, type: "html", title: ha.title, fileUrl: ha.fileUrl,
            })
          }
        }
      }

      // Flatten content: handle tool_result specially (its content is in type="tool_result" parts, not "text")
      let rawContent: string
      if (typeof msg.content === "string") {
        rawContent = msg.content
      } else if (msg.role === "tool_result" && Array.isArray(msg.content)) {
        const trParts = msg.content.filter((p: any) => p && p.type === "tool_result")
        rawContent = trParts.map((p: any) => p.content || "").join("")
      } else if (Array.isArray(msg.content)) {
        rawContent = msg.content.filter(function(p: any) { return p && p.type === "text" }).map(function(p: any) { return p.text || "" }).join("")
      } else {
        rawContent = ""
      }
      // Collapse one-word-per-line patterns (DeepSeek V4 quirk)
      const content = collapseNewlines(rawContent)
      // Extract tool calls into meta for frontend display (include results)
      const toolCalls = Array.isArray(msg.content)
        ? msg.content.filter((p: any) => p && p.type === "tool_call").map((tc: any) => ({
            id: tc.id,  // preserve original toolCallId for matching with tool_result
            name: tc.name,
            args: tc.arguments ? JSON.stringify(tc.arguments) : "{}",
            result: toolResults[tc.id] || "",
          }))
        : []

      // Merge original meta with extracted toolCalls (preserve Agent-provided meta)
      const mergedMeta: Record<string, unknown> = { ...(msg.meta || {}) }

      // Preserve toolCallId for tool_result messages so loadMessages can rebuild them
      if (msg.role === "tool_result" && Array.isArray(msg.content)) {
        const trParts = msg.content.filter((p: any) => p && p.type === "tool_result")
        if (trParts.length > 0 && trParts[0].toolCallId) {
          mergedMeta.toolCallId = trParts[0].toolCallId
        }
      }

      const allToolCalls = [
        ...((msg.meta?.toolCalls as any[]) || []),
        ...toolCalls.map((tc: any) => ({ ...tc, id: tc.id || `tc_${Date.now()}` }))
      ]
      if (allToolCalls.length > 0) mergedMeta.toolCalls = allToolCalls

      // Attach pending artifacts to this assistant message
      if (msg.role === "assistant" && pendingArtifacts.length > 0) {
        mergedMeta.artifacts = pendingArtifacts.map(a => {
          const entry: Record<string, unknown> = { id: a.id, type: a.type, title: a.title }
          if (a.html) entry.html = a.html
          if (a.fileUrl) entry.fileUrl = a.fileUrl
          return entry
        })
        pendingArtifacts.length = 0
      }

      const meta = Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null
      const thinking = (msg as any).thinking as string || null

      insertStmt.run([sessionId, msg.role, content, thinking, msg.timestamp, meta])
    }
    insertStmt.free()

    // Flush any remaining artifacts onto the last assistant message.
    // This handles the case where tool_results at the end of a turn
    // produce artifacts but no subsequent assistant message exists yet.
    if (pendingArtifacts.length > 0) {
      const artJson = JSON.stringify(pendingArtifacts.map(a => {
        const e: Record<string, unknown> = { id: a.id, type: a.type, title: a.title }
        if (a.html) e.html = a.html
        if (a.fileUrl) e.fileUrl = a.fileUrl
        return e
      }))
      // Find the last assistant message in this batch and update its meta
      const lastAssistant = [...newMessages].reverse().find(m => m.role === "assistant")
      if (lastAssistant) {
        const existingMeta: Record<string, unknown> = (lastAssistant.meta || {}) as Record<string, unknown>
        existingMeta.artifacts = JSON.parse(artJson)
        db.run("UPDATE messages SET meta = ? WHERE session_id = ? AND role = ? AND timestamp = ?",
          [JSON.stringify(existingMeta), sessionId, "assistant", lastAssistant.timestamp])
      }
    }

    // Update session metadata — use our own counter, not table COUNT
    const newCount = alreadySaved + newMessages.length
    db.run("UPDATE sessions SET updated_at = ?, message_count = ? WHERE id = ?", [
      now, newCount, sessionId,
    ])

    await saveDatabase(this.dbPath)
  }

  async loadMessages(sessionId: string): Promise<AgentMessage[]> {
    const db = await this.init()
    const stmt = db.prepare(
      "SELECT role, content, thinking, timestamp, meta FROM messages WHERE session_id = ? ORDER BY id ASC"
    )
    stmt.bind([sessionId])

    const messages: AgentMessage[] = []
    const seen = new Set<string>()
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const role = row.role as string
      const content = row.content as string
      const timestamp = row.timestamp as number
      const thinking = row.thinking as string || undefined
      let meta: Record<string, unknown> | undefined
      try { meta = row.meta ? JSON.parse(row.meta as string) : undefined } catch {}

      // Reconstruct content: if meta has toolCalls/toolCallId, build proper content array
      let messageContent: string | any[]
      if (role === "tool_result" && meta?.toolCallId) {
        // Preserve tool_result structure so LLM receives valid tool messages
        messageContent = [{
          type: "tool_result",
          toolCallId: meta.toolCallId as string,
          content: content,
          isError: false,
        }]
      } else if (meta?.toolCalls && Array.isArray(meta.toolCalls) && role === "assistant") {
        const parts: any[] = (meta.toolCalls as any[]).map((tc: any) => ({
          type: "tool_call",
          id: tc.id || `tc_${Date.now()}`,
          name: tc.name,
          arguments: tc.args,
        }))
        if (content) {
          parts.push({ type: "text", text: content })
        }
        messageContent = parts
      } else {
        messageContent = content
      }

      // Dedup: skip messages already seen (mitigates historical duplicate bloat)
      const dedupKey = `${role}|${JSON.stringify(messageContent)}|${timestamp}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      messages.push({
        role: role as AgentMessage["role"],
        content: messageContent,
        timestamp,
        thinking,
        meta,
      })
    }
    stmt.free()
    return messages
  }

  /** Persist uploaded file metadata to the latest user message of a session */
  async attachFiles(sessionId: string, files: Array<{ name: string; path: string; size: number }>): Promise<void> {
    if (!files || files.length === 0) return
    const db = await this.init()
    // Find the latest user message for this session
    const stmt = db.prepare(
      "SELECT meta FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
    )
    stmt.bind([sessionId])
    if (stmt.step()) {
      const row = stmt.getAsObject()
      let meta: Record<string, unknown> = {}
      try { meta = row.meta ? JSON.parse(row.meta as string) : {} } catch {}
      meta.files = files
      db.run("UPDATE messages SET meta = ? WHERE session_id = ? AND role = 'user' AND id = (SELECT MAX(id) FROM messages WHERE session_id = ? AND role = 'user')",
        [JSON.stringify(meta), sessionId, sessionId])
    }
    stmt.free()
    await saveDatabase(this.dbPath)
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const db = await this.init()
    db.run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [
      title, Date.now(), id,
    ])
    await saveDatabase(this.dbPath)
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function collapseNewlines(text: string): string {
  // Heuristic: detect "one-word-per-line" pattern from DeepSeek V4
  // When >50% of non-empty lines are single characters, merge them.
  const lines = text.split("\n")
  const nonEmpty = lines.filter(l => l.trim().length > 0)
  if (nonEmpty.length >= 5) {
    const singleChars = nonEmpty.filter(l => l.trim().length <= 2).length
    if (singleChars > nonEmpty.length * 0.5) {
      // Merge single-character lines, preserve paragraph breaks (double newlines)
      const merged: string[] = []
      let buf = ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) {
          if (buf) { merged.push(buf); buf = "" }
          merged.push("")
        } else if (trimmed.length <= 2) {
          buf += trimmed
        } else {
          if (buf) { merged.push(buf); buf = "" }
          merged.push(line)
        }
      }
      if (buf) merged.push(buf)
      return merged.join("\n").replace(/\n{4,}/g, "\n\n\n")
    }
  }
  return text.replace(/\n{4,}/g, "\n\n\n")
}
