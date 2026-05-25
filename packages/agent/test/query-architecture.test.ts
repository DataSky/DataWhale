/**
 * Unit tests for new Query/Turn/Span architecture
 * Run: bun test query-architecture.test.ts
 */

import { QueryStore } from "../src/query-store.js"
import { makeQuery } from "../src/query-types.js"
import type { Query, Span, ThinkingSpan, ToolCallSpan, TextSpan } from "../src/query-types.js"
import { releaseDatabase } from "../src/db-pool.js"

let passed = 0
let failed = 0

function check(name: string, fn: () => Promise<void>) {
  return async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e: any) { console.log(`  ✗ ${name}: ${e.message}`); failed++ }
  }
}

// ─── Test 1: QueryStore CRUD ──────────────────────────────────────────────

async function test_query_store_crud() {
  const store = new QueryStore(":memory:")
  
  // Build test spans
  const spans: Span[] = [
    { type: "thinking", content: "Let me think...", startedAt: 1000, completedAt: 2000 } as ThinkingSpan,
    { type: "tool_call", id: "call_1", name: "web_search", arguments: '{"q":"test"}', result: "Found 5 results", isError: false, startedAt: 2000, completedAt: 3000 } as ToolCallSpan,
    { type: "text", content: "Here are the results.", startedAt: 3000, completedAt: 3500 } as TextSpan,
  ]

  const q: Query = {
    id: "test_query_1",
    sessionId: "session_test",
    userContent: "search for test",
    spans,
    model: "deepseek-v4-pro",
    usage: { inputTokens: 100, outputTokens: 50 },
    createdAt: Date.now(),
  }

  await store.saveQuery(q)

  // Load
  const loaded = await store.loadQueries("session_test")
  if (loaded.length !== 1) throw new Error(`Expected 1 query, got ${loaded.length}`)
  
  const lq = loaded[0]
  if (lq.id !== "test_query_1") throw new Error("Wrong id")
  if (lq.userContent !== "search for test") throw new Error("Wrong user content")
  if (lq.spans.length !== 3) throw new Error(`Expected 3 spans, got ${lq.spans.length}`)
  if (lq.spans[0].type !== "thinking") throw new Error(`Wrong span type: ${lq.spans[0].type}`)
  if (lq.spans[1].type !== "tool_call") throw new Error("Missing tool_call span")
  if (lq.spans[2].type !== "text") throw new Error("Missing text span")
  if (lq.model !== "deepseek-v4-pro") throw new Error("Wrong model")
  if (!lq.usage || lq.usage.inputTokens !== 100) throw new Error("Wrong usage")

  // Count
  const cnt = await store.count("session_test")
  if (cnt !== 1) throw new Error(`Expected count 1, got ${cnt}`)

  // Count all
  const cntAll = await store.count()
  if (cntAll !== 1) throw new Error(`Expected all count 1, got ${cntAll}`)

  releaseDatabase(":memory:")
}

// ─── Test 2: makeQuery helper ─────────────────────────────────────────────

async function test_make_query_helper() {
  const q = makeQuery({
    sessionId: "s1",
    userContent: "hello",
    spans: [{ type: "text", content: "hi", startedAt: 100, completedAt: 200 }],
    model: "deepseek",
    usage: { inputTokens: 5, outputTokens: 2 },
  })

  if (!q.id.startsWith("q_")) throw new Error("Invalid id format")
  if (q.sessionId !== "s1") throw new Error("Wrong sessionId")
  if (q.userContent !== "hello") throw new Error("Wrong userContent")
  if (q.spans.length !== 1) throw new Error("Wrong spans count")
  if (q.model !== "deepseek") throw new Error("Wrong model")
}

// ─── Test 3: Span type safety ─────────────────────────────────────────────

async function test_span_type_safety() {
  // Verify that all Span types have required fields
  const thinking: ThinkingSpan = { type: "thinking", content: "t", startedAt: 1, completedAt: 2 }
  const toolCall: ToolCallSpan = { type: "tool_call", id: "c1", name: "test_tool", arguments: "{}", result: "ok", isError: false, startedAt: 2, completedAt: 3 }
  const text: TextSpan = { type: "text", content: "hello", startedAt: 3, completedAt: 4 }

  // Test that they can be assigned to Span[] (type union)
  const spans: Span[] = [thinking, toolCall, text]
  if (spans.length !== 3) throw new Error("Wrong spans array length")

  // Test optional fields
  const partial: TextSpan = { type: "text", content: "partial", startedAt: 1 }
  if (partial.completedAt !== undefined) throw new Error("completedAt should be undefined")
}

// ─── Test 4: Multiple queries per session ─────────────────────────────────

async function test_multiple_queries() {
  const store = new QueryStore(":memory:")
  
  await store.saveQuery(makeQuery({ sessionId: "multi", userContent: "q1", spans: [], model: "m1" }))
  await store.saveQuery(makeQuery({ sessionId: "multi", userContent: "q2", spans: [], model: "m2" }))
  await store.saveQuery(makeQuery({ sessionId: "other", userContent: "q3", spans: [], model: "m3" }))

  const multi = await store.loadQueries("multi")
  if (multi.length !== 2) throw new Error(`Expected 2 queries in multi, got ${multi.length}`)

  const other = await store.loadQueries("other")
  if (other.length !== 1) throw new Error(`Expected 1 query in other, got ${other.length}`)

  releaseDatabase(":memory:")
}

// ─── Test 5: Empty spans ──────────────────────────────────────────────────

async function test_empty_spans() {
  const store = new QueryStore(":memory:")
  const q = makeQuery({ sessionId: "empty", userContent: "test", spans: [] })
  await store.saveQuery(q)

  const loaded = await store.loadQueries("empty")
  if (loaded.length !== 1) throw new Error("Query not saved")
  if (loaded[0].spans.length !== 0) throw new Error("Expected empty spans")

  releaseDatabase(":memory:")
}

// ─── Test 6: Dual-format writes (QueryStore → messages table) ─────────────

async function test_dual_format_writes() {
  const store = new QueryStore(":memory:")

  const spans: Span[] = [
    { type: "thinking", content: "Let me analyze...", startedAt: 1000, completedAt: 2000 } as ThinkingSpan,
    { type: "tool_call", id: "tc1", name: "query", arguments: '{"sql":"SELECT 1"}', result: "1 row", isError: false, startedAt: 2000, completedAt: 3000 } as ToolCallSpan,
    { type: "text", content: "Analysis complete: 1 result found.", startedAt: 3000, completedAt: 3500 } as TextSpan,
  ]

  const q: Query = {
    id: "dual_test_1",
    sessionId: "session_dual",
    userContent: "What is 1+1?",
    spans,
    model: "deepseek-v4-pro",
    usage: { inputTokens: 10, outputTokens: 20 },
    createdAt: 1700000000000,
  }

  await store.saveQuery(q)

  // Verify new format: queries table
  const loaded = await store.loadQueries("session_dual")
  if (loaded.length !== 1) throw new Error(`Expected 1 query, got ${loaded.length}`)
  if (loaded[0].spans[1].type !== "tool_call") throw new Error("Tool call span not preserved")

  // Verify old format: messages table was written
  const db = await store.init()
  const msgStmt = db.prepare(
    "SELECT role, content, thinking, meta FROM messages WHERE session_id = ? ORDER BY timestamp ASC"
  )
  msgStmt.bind(["session_dual"])

  const messages: any[] = []
  while (msgStmt.step()) {
    messages.push(msgStmt.getAsObject())
  }
  msgStmt.free()

  // Should have 2 messages: user + assistant
  if (messages.length !== 2) throw new Error(`Expected 2 messages (user + assistant), got ${messages.length}`)

  // User message
  const userMsg = messages[0]
  if (userMsg.role !== "user") throw new Error(`Expected user role, got ${userMsg.role}`)
  if (userMsg.content !== "What is 1+1?") throw new Error(`Wrong user content: "${userMsg.content}"`)

  // Assistant message
  const assistantMsg = messages[1]
  if (assistantMsg.role !== "assistant") throw new Error(`Expected assistant role, got ${assistantMsg.role}`)
  if (assistantMsg.thinking !== "Let me analyze...") throw new Error(`Wrong thinking: "${assistantMsg.thinking}"`)
  if (assistantMsg.content !== "Analysis complete: 1 result found.") throw new Error(`Wrong text content: "${assistantMsg.content}"`)

  // Tool calls in meta
  const meta = JSON.parse(assistantMsg.meta as string)
  if (!meta.toolCalls || meta.toolCalls.length !== 1) throw new Error("Expected 1 tool call in meta")
  if (meta.toolCalls[0].name !== "query") throw new Error(`Wrong tool name: ${meta.toolCalls[0].name}`)
  if (meta.toolCalls[0].result !== "1 row") throw new Error(`Wrong tool result: ${meta.toolCalls[0].result}`)

  // Usage in meta
  if (!meta.usage || meta.usage.inputTokens !== 10) throw new Error("Usage not preserved in meta")

  // Verify sessions table
  const sessStmt = db.prepare("SELECT id, title FROM sessions WHERE id = ?")
  sessStmt.bind(["session_dual"])
  if (!sessStmt.step()) throw new Error("Session row not created")
  const sessionRow = sessStmt.getAsObject()
  if (sessionRow.title !== "What is 1+1?") throw new Error(`Wrong session title: "${sessionRow.title}"`)
  sessStmt.free()

  releaseDatabase(":memory:")
}

// ─── Test 7: Dual-format with only text spans (no tool calls) ─────────────

async function test_dual_format_text_only() {
  const store = new QueryStore(":memory:")

  const q = makeQuery({
    sessionId: "session_text_only",
    userContent: "Hello",
    spans: [{ type: "text", content: "Hi there!", startedAt: 100, completedAt: 200 }],
    model: "deepseek",
  })

  await store.saveQuery(q)

  const db = await store.init()
  const msgStmt = db.prepare(
    "SELECT role, content, thinking, meta FROM messages WHERE session_id = ? ORDER BY timestamp ASC"
  )
  msgStmt.bind(["session_text_only"])
  
  const messages: any[] = []
  while (msgStmt.step()) messages.push(msgStmt.getAsObject())
  msgStmt.free()

  if (messages.length !== 2) throw new Error(`Expected 2 messages, got ${messages.length}`)
  
  const assistantMsg = messages[1]
  if (assistantMsg.content !== "Hi there!") throw new Error(`Wrong text: "${assistantMsg.content}"`)
  if (assistantMsg.thinking) throw new Error("Expected no thinking content")

  const meta = JSON.parse(assistantMsg.meta as string)
  if (meta.toolCalls) throw new Error("Expected no toolCalls in meta for text-only response")

  releaseDatabase(":memory:")
}

// ─── Test 8: App-server API endpoints (integration) ───────────────────────

async function test_api_queries_endpoint() {
  const BASE = "http://localhost:3000"
  
  // First create a session via chat
  const res1 = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "test queries api" }) })
  if (!res1.ok) throw new Error(`Chat failed: ${res1.status}`)
  // Drain SSE
  const reader = res1.body!.getReader()
  while (true) { const { done } = await reader.read(); if (done) break }
  await new Promise(r => setTimeout(r, 1000)) // Wait for save

  // Get sessions
  const sessions = await (await fetch(`${BASE}/api/sessions`)).json()
  if (!sessions.length) throw new Error("No sessions")
  const sid = sessions[0].id

  // Get queries
  const res2 = await fetch(`${BASE}/api/queries?sessionId=${sid}`)
  if (!res2.ok) throw new Error(`Queries endpoint failed: ${res2.status}`)
  const queries = await res2.json()

  if (!Array.isArray(queries)) throw new Error("Expected array")
  // Should have at least 1 query from the chat we just did
  if (queries.length === 0) throw new Error("No queries found — QueryStore may not be saving")
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n🦈 DataWhale Query/Span Architecture Tests\n")
  console.log("─".repeat(50))

  await check("QueryStore CRUD", test_query_store_crud)()
  await check("makeQuery helper", test_make_query_helper)()
  await check("Span type safety", test_span_type_safety)()
  await check("Multiple queries", test_multiple_queries)()
  await check("Empty spans", test_empty_spans)()
  await check("Dual-format writes", test_dual_format_writes)()
  await check("Dual-format text only", test_dual_format_text_only)()

  // Integration test (requires running server)
  try {
    const res = await fetch("http://localhost:3000/api/sessions")
    if (res.ok) {
      await check("API /api/queries (integration)", test_api_queries_endpoint)()
    } else {
      console.log("  ⚠ Server not running — skipping integration tests")
    }
  } catch {
    console.log("  ⚠ Server not running — skipping integration tests")
  }

  console.log("─".repeat(50))
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
