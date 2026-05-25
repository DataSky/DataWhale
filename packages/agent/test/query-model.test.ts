/**
 * Query/Turn/Span 四级模型 — 单元测试 + 集成测试
 * Run: cd DataWhale && bun packages/agent/test/query-model.test.ts
 */

import { QueryStore, makeQuery, makeTurn } from "../src/index.js"
import type { Query, Span, Turn, ThinkingSpan, ToolCallSpan, TextSpan } from "../src/query-types.js"

let passed = 0, failed = 0

function check(name: string, fn: () => Promise<void>) {
  return async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e: any) { console.log(`  ✗ ${name}: ${e.message}`); failed++ }
  }
}

// ── Unit: makeQuery / makeTurn ──────────────────────────────────────────────

async function test_make_query() {
  const q = makeQuery({ sessionId: "s1", userContent: "hello", model: "deepseek" })
  if (!q.id.startsWith("q_")) throw new Error("Invalid id")
  if (q.sessionId !== "s1") throw new Error("Wrong sessionId")
  if (q.userContent !== "hello") throw new Error("Wrong userContent")
  if (q.turns.length !== 0) throw new Error("Turns should be empty")
}

async function test_make_turn() {
  const spans: Span[] = [
    { type: "thinking", content: "hmm", startedAt: 1000, completedAt: 2000 } as ThinkingSpan,
    { type: "text", content: "answer", startedAt: 2000, completedAt: 3000 } as TextSpan,
  ]
  const turn = makeTurn(spans)
  if (turn.spans.length !== 2) throw new Error("Wrong spans count")
  if (turn.startedAt !== 1000) throw new Error("Wrong startedAt")
}

// ── Unit: Span types ────────────────────────────────────────────────────────

async function test_span_types() {
  const thinking: ThinkingSpan = { type: "thinking", content: "t", startedAt: 1 }
  const toolCall: ToolCallSpan = { type: "tool_call", id: "c1", name: "test", arguments: "{}", isError: false, startedAt: 2 }
  const text: TextSpan = { type: "text", content: "hi", startedAt: 3 }
  const spans: Span[] = [thinking, toolCall, text]
  if (spans.length !== 3) throw new Error("Wrong length")
  if (spans[0].type !== "thinking") throw new Error("Wrong type")
  if (spans[1].type !== "tool_call") throw new Error("Wrong type")
  if (spans[2].type !== "text") throw new Error("Wrong type")
}

// ── Integration: QueryStore CRUD ────────────────────────────────────────────

async function test_query_store_crud() {
  const store = new QueryStore(":memory:")
  const q = makeQuery({ sessionId: "test_store", userContent: "search", model: "m1" })
  q.turns = [makeTurn([
    { type: "thinking", content: "thinking...", startedAt: 100, completedAt: 200 } as ThinkingSpan,
    { type: "tool_call", id: "c1", name: "web_search", arguments: '{"q":"x"}', result: "found", isError: false, startedAt: 200, completedAt: 300 } as ToolCallSpan,
    { type: "text", content: "result text", startedAt: 300, completedAt: 400 } as TextSpan,
  ])]
  await store.saveQuery(q)

  const loaded = await store.loadQueries("test_store")
  if (loaded.length !== 1) throw new Error(`Expected 1, got ${loaded.length}`)
  const lq = loaded[0]
  if (lq.userContent !== "search") throw new Error("Wrong user content")
  if (lq.turns.length !== 1) throw new Error("Wrong turns count")
  if (lq.turns[0].spans.length !== 3) throw new Error(`Expected 3 spans, got ${lq.turns[0].spans.length}`)
  if (lq.turns[0].spans[0].type !== "thinking") throw new Error("First span should be thinking")
  if (lq.turns[0].spans[1].type !== "tool_call") throw new Error("Second span should be tool_call")
  if ((lq.turns[0].spans[1] as ToolCallSpan).result !== "found") throw new Error("Tool result not preserved")
  if (lq.turns[0].spans[2].type !== "text") throw new Error("Third span should be text")
}

// ── Integration: Multiple queries ───────────────────────────────────────────

async function test_multiple_queries() {
  const store = new QueryStore(":memory:")
  await store.saveQuery(makeQuery({ sessionId: "multi", userContent: "q1" }))
  await store.saveQuery(makeQuery({ sessionId: "multi", userContent: "q2" }))
  await store.saveQuery(makeQuery({ sessionId: "other", userContent: "q3" }))
  
  const qs1 = await store.loadQueries("multi")
  if (qs1.length !== 2) throw new Error(`multi: expected 2, got ${qs1.length}`)
  const qs2 = await store.loadQueries("other")
  if (qs2.length !== 1) throw new Error(`other: expected 1, got ${qs2.length}`)
}

// ── Integration: API /api/queries endpoint ──────────────────────────────────

async function test_api_queries() {
  const BASE = "http://localhost:3000"
  try {
    const res = await fetch(`${BASE}/api/sessions`)
    if (!res.ok) throw new Error("Server not running")
    const sessions = await res.json()
    if (!sessions.length) throw new Error("No sessions — create one first")
    const sid = sessions[0].id
    const qRes = await fetch(`${BASE}/api/queries?sessionId=${sid}`)
    if (!qRes.ok) throw new Error(`queries endpoint: ${qRes.status}`)
    const queries = await qRes.json()
    if (!Array.isArray(queries)) throw new Error("Expected array")
    console.log(`    (${queries.length} queries in session)`)
  } catch (e: any) {
    if (e.message?.includes("Server not running")) {
      console.log("    ⚠ Server not running — skipping integration test")
    } else {
      throw e
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n🦈 Query/Turn/Span Model Tests\n" + "─".repeat(50))
  await check("makeQuery helper", test_make_query)()
  await check("makeTurn helper", test_make_turn)()
  await check("Span types", test_span_types)()
  await check("QueryStore CRUD (save+load)", test_query_store_crud)()
  await check("Multiple queries per session", test_multiple_queries)()
  await check("/api/queries endpoint", test_api_queries)()
  console.log("─".repeat(50))
  console.log(`  ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
