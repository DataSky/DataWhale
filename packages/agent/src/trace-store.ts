/**
 * TraceStore — Full observability for Agent interactions
 * 
 * Records every turn: user input → LLM call → tool execution → agent response
 * Data is invaluable for:
 * - Short-term: analyzing agent behavior, finding failure patterns
 * - Long-term: reinforcement learning training data
 * 
 * Stored in SQLite at ~/.datawhale/traces.db
 */

import { getDatabase, saveDatabase } from "./db-pool.js"

export interface TraceRecord {
  id?: number
  traceId: string
  sessionId: string
  turn: number
  eventType: "user_msg" | "llm_call" | "tool_call" | "tool_result" | "agent_response" | "error" | "session_start" | "session_end"
  timestamp: number
  model?: string
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  toolName?: string
  toolArgs?: string
  toolResultSummary?: string
  toolIsError?: boolean
  errorMessage?: string
  contentPreview?: string
  metadata?: Record<string, unknown>
}

export class TraceStore {
  private dbPath: string
  private _db: any = null
  private _initialised = false

  constructor(dbPath = `${process.env.HOME || "~"}/.datawhale/traces.db`) {
    this.dbPath = dbPath
  }

  private async init(): Promise<any> {
    if (this._db && this._initialised) return this._db

    this._db = await getDatabase(this.dbPath)

    if (!this._initialised) {
      this._db.run(`
        CREATE TABLE IF NOT EXISTS traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn INTEGER NOT NULL DEFAULT 0,
          event_type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          model TEXT,
          latency_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          tool_name TEXT,
          tool_args TEXT,
          tool_result_summary TEXT,
          tool_is_error INTEGER DEFAULT 0,
          error_message TEXT,
          content_preview TEXT,
          metadata TEXT
        )
      `)

      this._db.run(`CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id)`)
      this._db.run(`CREATE INDEX IF NOT EXISTS idx_traces_event ON traces(event_type)`)
      this._db.run(`CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp)`)

      this._initialised = true
      // Persist table structure immediately so restarts don't lose the schema
      await saveDatabase(this.dbPath)
    }

    return this._db
  }

  async record(entry: TraceRecord): Promise<void> {
    const db = await this.init()
    db.run(
      `INSERT INTO traces (trace_id, session_id, turn, event_type, timestamp, model, latency_ms, input_tokens, output_tokens, tool_name, tool_args, tool_result_summary, tool_is_error, error_message, content_preview, metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.traceId,
        entry.sessionId,
        entry.turn,
        entry.eventType,
        entry.timestamp,
        entry.model || null,
        entry.latencyMs || null,
        entry.inputTokens || null,
        entry.outputTokens || null,
        entry.toolName || null,
        entry.toolArgs || null,
        entry.toolResultSummary || null,
        entry.toolIsError ? 1 : 0,
        entry.errorMessage || null,
        entry.contentPreview?.slice(0, 500) || null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ]
    )
    await saveDatabase(this.dbPath)
  }

  async query(sessionId?: string, eventType?: string, limit = 100): Promise<TraceRecord[]> {
    const db = await this.init()
    let sql = "SELECT * FROM traces WHERE 1=1"
    const params: any[] = []

    if (sessionId) { sql += " AND session_id = ?"; params.push(sessionId) }
    if (eventType) { sql += " AND event_type = ?"; params.push(eventType) }
    sql += " ORDER BY id DESC LIMIT ?"
    params.push(limit)

    const stmt = db.prepare(sql)
    stmt.bind(params)

    const results: TraceRecord[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      results.push(this.rowToRecord(row))
    }
    stmt.free()
    return results.reverse()
  }

  /** Get aggregated stats for a session */
  async sessionStats(sessionId: string): Promise<{
    totalTurns: number
    totalToolCalls: number
    totalErrors: number
    totalInputTokens: number
    totalOutputTokens: number
    avgLatencyMs: number
  }> {
    const db = await this.init()
    const rows = [
      db.prepare("SELECT COUNT(DISTINCT turn) as cnt FROM traces WHERE session_id = ? AND event_type = 'llm_call'"),
      db.prepare("SELECT COUNT(*) as cnt FROM traces WHERE session_id = ? AND event_type = 'tool_call'"),
      db.prepare("SELECT COUNT(*) as cnt FROM traces WHERE session_id = ? AND event_type = 'error'"),
      db.prepare("SELECT COALESCE(SUM(input_tokens),0) as sum FROM traces WHERE session_id = ?"),
      db.prepare("SELECT COALESCE(SUM(output_tokens),0) as sum FROM traces WHERE session_id = ?"),
      db.prepare("SELECT COALESCE(AVG(latency_ms),0) as avg FROM traces WHERE session_id = ? AND latency_ms > 0"),
    ]

    for (const stmt of rows) {
      stmt.bind([sessionId])
      stmt.step()
    }

    const stats = rows.map((s) => s.getAsObject())
    rows.forEach((s) => s.free())

    return {
      totalTurns: (stats[0] as any).cnt || 0,
      totalToolCalls: (stats[1] as any).cnt || 0,
      totalErrors: (stats[2] as any).cnt || 0,
      totalInputTokens: (stats[3] as any).sum || 0,
      totalOutputTokens: (stats[4] as any).sum || 0,
      avgLatencyMs: Math.round((stats[5] as any).avg || 0),
    }
  }

  private rowToRecord(row: any): TraceRecord {
    return {
      id: row.id as number,
      traceId: row.trace_id as string,
      sessionId: row.session_id as string,
      turn: row.turn as number,
      eventType: row.event_type as TraceRecord["eventType"],
      timestamp: row.timestamp as number,
      model: row.model as string || undefined,
      latencyMs: row.latency_ms as number || undefined,
      inputTokens: row.input_tokens as number || undefined,
      outputTokens: row.output_tokens as number || undefined,
      toolName: row.tool_name as string || undefined,
      toolArgs: row.tool_args as string || undefined,
      toolResultSummary: row.tool_result_summary as string || undefined,
      toolIsError: row.tool_is_error === 1,
      errorMessage: row.error_message as string || undefined,
      contentPreview: row.content_preview as string || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }
  }
}
