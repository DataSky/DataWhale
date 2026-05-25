/**
 * DatabasePool — sql.js instance sharing for multi-store safety
 * 
 * Problem: Multiple stores (SessionStore, QueryStore) writing to the same
 * SQLite file with independent sql.js Database instances causes silent data
 * loss — each store loads its own copy and `fs.writeFileSync` overwrites
 * whatever the other store wrote last.
 * 
 * Solution: A module-level pool keyed by dbPath. Every store for a given
 * file shares the same Database instance. Persistence via `saveDatabase()`
 * serialises the shared state safely.
 */

let initSqlJsFn: (() => Promise<any>) | null = null

async function getInitSqlJs(): Promise<any> {
  if (!initSqlJsFn) {
    initSqlJsFn = (await import("sql.js")).default
  }
  return initSqlJsFn!()
}

// ─── Pool ──────────────────────────────────────────────────────────────────

interface PoolEntry {
  db: any // sql.js Database
  refs: number
}

const _pool = new Map<string, PoolEntry>()

/**
 * Get or create a sql.js Database for `dbPath`.
 * Multiple callers sharing the same path get the identical instance.
 */
export async function getDatabase(dbPath: string): Promise<any> {
  const entry = _pool.get(dbPath)
  if (entry) {
    entry.refs++
    return entry.db
  }

  const fs = await import("node:fs")
  const path = await import("node:path")

  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const SQL = await getInitSqlJs()

  let db: any
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath)
    db = new SQL.Database(buf)
  } else {
    db = new SQL.Database()
  }

  _pool.set(dbPath, { db, refs: 1 })
  return db
}

/**
 * Persist the shared Database for `dbPath` to disk.
 * Safe to call from any store sharing this path — the shared state is written.
 */
export async function saveDatabase(dbPath: string): Promise<void> {
  const entry = _pool.get(dbPath)
  if (!entry) return

  const fs = await import("node:fs")
  const data = entry.db.export()
  fs.writeFileSync(dbPath, Buffer.from(data))
}

/**
 * Release a reference. When refs hit 0 the Database is closed and removed.
 * Most callers should NOT call this during normal operation; it's for test
 * cleanup or explicit lifetime control.
 */
export function releaseDatabase(dbPath: string): void {
  const entry = _pool.get(dbPath)
  if (!entry) return
  entry.refs--
  if (entry.refs <= 0) {
    try { entry.db.close() } catch {}
    _pool.delete(dbPath)
  }
}

/**
 * Return the number of active pool entries (for diagnostics).
 */
export function poolSize(): number {
  return _pool.size
}
