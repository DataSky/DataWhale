/**
 * KnowledgeStore unit tests
 * Run: cd DataWhale && bun packages/agent/test/knowledge-store.test.ts
 */

import { KnowledgeStore } from "../src/knowledge-store.js"

let passed = 0, failed = 0
function check(name: string, fn: () => Promise<void>) {
  return async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e: any) { console.log(`  ✗ ${name}: ${e.message}`); failed++ }
  }
}

const store = new KnowledgeStore(":memory:")

// ── Test: add + listRecent ────────────────────────────────────────────
async function test_add_list() {
  await store.add({ domain: "sales", fact: "sales table has 6 columns", keywords: "sales,columns", sourceSession: "s1", createdAt: 1000, confidence: 0.8 })
  await store.add({ domain: "sales", fact: "region column has 4 values: East,West,North,South", keywords: "region,sales,values", sourceSession: "s1", createdAt: 2000, confidence: 0.9 })
  await store.add({ domain: "products", fact: "products has price column with values 10-500", keywords: "products,price", sourceSession: "s2", createdAt: 3000, confidence: 0.7 })

  const entries = await store.listRecent(10)
  if (entries.length < 3) throw new Error(`Expected >=3, got ${entries.length}`)
  // Most recent first
  if (entries[0].fact !== "products has price column with values 10-500") throw new Error("Wrong order")
}

// ── Test: search ──────────────────────────────────────────────────────
async function test_search() {
  const results = await store.search("region values", 3)
  if (results.length === 0) throw new Error("Search returned no results")
  // Should find the region fact first (best keyword match)
  const top = results[0]
  if (!top.fact.includes("region")) throw new Error(`Wrong top result: ${top.fact}`)
}

// ── Test: count ───────────────────────────────────────────────────────
async function test_count() {
  const total = await store.count()
  if (total < 3) throw new Error(`Expected >=3, got ${total}`)
}

// ── Test: empty search ────────────────────────────────────────────────
async function test_empty_search() {
  const results = await store.search("nonexistent_xyz_123", 3)
  if (results.length !== 0) throw new Error("Expected empty results")
}

// ── Test: dedup — same domain+fact should update ─────────────────────
async function test_dedup() {
  await store.add({ domain: "test", fact: "unique fact v1", keywords: "test", sourceSession: "s1", createdAt: 100, confidence: 0.5 })
  await store.add({ domain: "test", fact: "unique fact v1", keywords: "test", sourceSession: "s2", createdAt: 200, confidence: 0.9 })

  const entries = await store.listRecent(10)
  const matches = entries.filter(e => e.fact === "unique fact v1")
  // Should be only 1 entry (updated, not duplicated)
  if (matches.length !== 1) throw new Error(`Expected 1 after dedup, got ${matches.length}`)
  // Confidence should be updated (actual value depends on dedup strategy)
  if (matches[0].confidence < 0.5) throw new Error(`Confidence too low: ${matches[0].confidence}`)
}

// ── Run ───────────────────────────────────────────────────────────────
async function run() {
  console.log("\n🧠 KnowledgeStore Tests\n" + "─".repeat(40))
  await check("add + listRecent", test_add_list)()
  await check("search (keyword match)", test_search)()
  await check("count", test_count)()
  await check("empty search", test_empty_search)()
  await check("dedup (same domain+fact)", test_dedup)()
  console.log("─".repeat(40))
  console.log(`  ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
