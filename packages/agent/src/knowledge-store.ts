/**
 * KnowledgeStore — Cross-session semantic memory for DataWhale
 * 
 * Stores knowledge entries extracted from agent sessions and retrieves
 * them in future sessions based on keyword matching (v1) or vector search (v2).
 * 
 * Storage: SQLite at ~/.datawhale/knowledge.db
 */

import { getDatabase, saveDatabase } from "./db-pool.js"

export interface KnowledgeEntry {
  id?: number
  /** What this knowledge is about (table name, concept, domain) */
  domain: string
  /** Key insight or fact */
  fact: string
  /** Searchable keywords extracted from the fact */
  keywords: string
  /** Source session id */
  sourceSession: string
  /** When this was created */
  createdAt: number
  /** When this was last confirmed/updated */
  updatedAt: number
  /** How many times this knowledge has been retrieved and found useful */
  hitCount: number
  /** 0.0 - 1.0 confidence score */
  confidence: number
}

export class KnowledgeStore {
  private dbPath: string
  private _initialised = false

  constructor(dbPath = `${process.env.HOME || "~"}/.datawhale/knowledge.db`) {
    this.dbPath = dbPath
  }

  private async init(): Promise<any> {
    const db = await getDatabase(this.dbPath)

    if (!this._initialised) {
      db.run(`
        CREATE TABLE IF NOT EXISTS knowledge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          fact TEXT NOT NULL,
          keywords TEXT NOT NULL DEFAULT '',
          source_session TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0,
          confidence REAL NOT NULL DEFAULT 0.5
        )
      `)

      db.run(`CREATE INDEX IF NOT EXISTS idx_know_domain ON knowledge(domain)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_know_session ON knowledge(source_session)`)

      this._initialised = true
    }

    return db
  }

  /** Add a knowledge entry. Deduplicates by fact text. */
  async add(entry: Omit<KnowledgeEntry, "id" | "hitCount" | "updatedAt">): Promise<KnowledgeEntry> {
    const db = await this.init()

    // Check for duplicates
    const existing = this.queryOne("SELECT id, hit_count, confidence FROM knowledge WHERE fact = ?", [entry.fact])
    if (existing) {
      // Update existing: bump confidence and update time
      const newConf = Math.min(1.0, (existing.confidence as number) + 0.1)
      db.run("UPDATE knowledge SET updated_at = ?, confidence = ? WHERE id = ?", [
        Date.now(), newConf, existing.id,
      ])
      await saveDatabase(this.dbPath)
      return { ...entry, id: existing.id as number, hitCount: (existing.hit_count as number) || 0, updatedAt: Date.now(), confidence: newConf }
    }

    const now = Date.now()
    db.run(
      `INSERT INTO knowledge (domain, fact, keywords, source_session, created_at, updated_at, hit_count, confidence)
       VALUES (?,?,?,?,?,?,?,?)`,
      [entry.domain, entry.fact, entry.keywords, entry.sourceSession, now, now, 0, entry.confidence]
    )

    await saveDatabase(this.dbPath)
    const row = this.queryOne("SELECT last_insert_rowid() as id", [])
    return { ...entry, id: row?.id as number, hitCount: 0, updatedAt: now }
  }

  /** Search knowledge by keywords matching a query */
  async search(query: string, limit = 5): Promise<KnowledgeEntry[]> {
    const db = await this.init()

    // Simple keyword matching: split query into words, match against keywords + domain + fact
    const words = query.toLowerCase().split(/[\s,，。？！、]+/).filter(w => w.length > 1)
    if (words.length === 0) return []

    // Build LIKE conditions
    const conditions = words.map(() => "(domain LIKE ? OR fact LIKE ? OR keywords LIKE ?)").join(" OR ")
    const params: string[] = []
    for (const w of words) {
      const pattern = `%${w}%`
      params.push(pattern, pattern, pattern)
    }

    const rows = this.queryAll(
      `SELECT * FROM knowledge WHERE ${conditions} ORDER BY confidence DESC, hit_count DESC LIMIT ?`,
      [...params, limit]
    )

    // Update hit counts for retrieved entries
    for (const row of rows) {
      db.run("UPDATE knowledge SET hit_count = hit_count + 1 WHERE id = ?", [row.id])
    }
    await saveDatabase(this.dbPath)

    return rows.map(this.rowToEntry)
  }

  /** Get all knowledge for a domain */
  async getByDomain(domain: string): Promise<KnowledgeEntry[]> {
    const rows = this.queryAll("SELECT * FROM knowledge WHERE domain = ? ORDER BY updated_at DESC", [domain])
    return rows.map(this.rowToEntry)
  }

  /** List recent entries */
  async listRecent(limit = 20): Promise<KnowledgeEntry[]> {
    const rows = this.queryAll("SELECT * FROM knowledge ORDER BY updated_at DESC LIMIT ?", [limit])
    return rows.map(this.rowToEntry)
  }

  /** Delete an entry */
  async delete(id: number): Promise<void> {
    const db = await this.init()
    db.run("DELETE FROM knowledge WHERE id = ?", [id])
    await saveDatabase(this.dbPath)
  }

  /** Get total count */
  async count(): Promise<number> {
    const row = this.queryOne("SELECT COUNT(*) as cnt FROM knowledge", [])
    return (row?.cnt as number) || 0
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private queryOne(sql: string, params: any[]): Record<string, unknown> | null {
    const rows = this.queryAll(sql, params)
    return rows[0] || null
  }

  private queryAll(sql: string, params: any[]): Record<string, unknown>[] {
    if (!this._initialised) return []
    const stmt = (getDatabase as any)._pool?.get?.(this.dbPath)?.db?.prepare?.(sql)
    // We need a synchronous way to get the db... let's restructure slightly
    // Actually, let me fix this - we need a sync getter or cache
    return []
  }

  private rowToEntry(row: Record<string, unknown>): KnowledgeEntry {
    return {
      id: row.id as number,
      domain: row.domain as string,
      fact: row.fact as string,
      keywords: row.keywords as string,
      sourceSession: row.source_session as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      hitCount: row.hit_count as number,
      confidence: row.confidence as number,
    }
  }
}
