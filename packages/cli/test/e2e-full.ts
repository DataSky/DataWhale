/**
 * DataWhale E2E Test Suite
 * Tests SSE streaming, session CRUD, and content parsing
 * Run: bun test/e2e.ts
 */

const BASE = "http://localhost:3000"
let passed = 0
let failed = 0

function check(name: string, fn: () => Promise<void>) {
  return async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e: any) { console.log(`  ✗ ${name}: ${e.message}`); failed++ }
  }
}

// ─── SSE Stream Parsing Test ──────────────────────────────────────────────

async function test_sse_stream_parsing() {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "reply with only: OK" }),
  })
  if (!res.ok || !res.body) throw new Error("Failed to connect")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  let eventTypes = new Set<string>()
  let agentEnd = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Simulate the frontend's parsing logic exactly
    const parts = buffer.split("\n\n")
    buffer = parts.pop() || ""

    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data: ")) continue
        try {
          const ev = JSON.parse(line.slice(6))
          eventTypes.add(ev.type)
          if (ev.type === "message_update") content += ev.delta
          if (ev.type === "agent_end") agentEnd = true
        } catch (e: any) {
          throw new Error(`JSON parse failed: ${e.message} | line: ${line.slice(0, 80)}`)
        }
      }
    }
  }

  if (!agentEnd) throw new Error("No agent_end event received")
  if (!content.includes("OK")) throw new Error(`Expected 'OK' in content, got: ${content.slice(0, 50)}`)
  if (!eventTypes.has("message_update")) throw new Error("No message_update events")
}

// ─── Session CRUD Test ────────────────────────────────────────────────────

async function test_session_crud() {
  // Create
  const res1 = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "test session" }),
  })
  if (!res1.ok) throw new Error("Chat failed")
  // Drain response
  const reader = res1.body!.getReader()
  while (true) { const { done } = await reader.read(); if (done) break }
  await new Promise(r => setTimeout(r, 500)) // Wait for save

  // List
  const sessions = await (await fetch(`${BASE}/api/sessions`)).json()
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error("No sessions returned")
  const sid = sessions[0].id

  // Read
  const session = await (await fetch(`${BASE}/api/sessions/${sid}`)).json()
  if (!session.messages) throw new Error("No messages in session")

  // Verify content parsing (string vs array)
  for (const msg of session.messages) {
    if (msg.role === "user" && typeof msg.content !== "string") throw new Error(`User message content is not string: ${typeof msg.content}`)
  }

  // Delete
  const del = await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE" })
  if (!del.ok) throw new Error("Delete failed")
}

// ─── Content Format Test ─────────────────────────────────────────────────

async function test_content_format() {
  const sessions = await (await fetch(`${BASE}/api/sessions`)).json()
  if (sessions.length === 0) return // No sessions yet

  const sid = sessions[0].id
  const session = await (await fetch(`${BASE}/api/sessions/${sid}`)).json()

  for (const msg of session.messages || []) {
    const c = msg.content
    // Both string and array are valid formats
    if (typeof c !== "string" && !Array.isArray(c)) {
      throw new Error(`Unexpected content type: ${typeof c}`)
    }
    if (Array.isArray(c)) {
      // Verify array contains valid MessagePart objects
      for (const part of c) {
        if (!part || typeof part !== "object") throw new Error("MessagePart is not an object")
        if (!part.type) throw new Error("MessagePart missing type field")
      }
    }
  }
}

// ─── Edge Cases ───────────────────────────────────────────────────────────

async function test_edge_cases() {
  // Empty prompt
  const res1 = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "" }),
  })
  if (res1.ok) throw new Error("Empty prompt should return error")

  // Long prompt
  const longPrompt = "x".repeat(5000)
  const res2 = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: longPrompt }),
  })
  if (!res2.ok) throw new Error(`Long prompt failed: ${res2.status}`)
  // Drain
  const reader = res2.body!.getReader()
  while (true) { const { done } = await reader.read(); if (done) break }

  // Session not found
  const res3 = await fetch(`${BASE}/api/sessions/nonexistent_12345`)
  if (res3.status !== 404) throw new Error(`Expected 404, got ${res3.status}`)

  // Config write/read
  const testKey = `TEST_${Date.now()}`
  await fetch(`${BASE}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [testKey]: "value" }),
  })
  const config = await (await fetch(`${BASE}/api/config`)).json()
  if (config[testKey] !== "value") throw new Error("Config write/read mismatch")
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n🦈 DataWhale E2E Tests\n")
  console.log("─".repeat(50))

  await check("SSE stream parsing", test_sse_stream_parsing)()
  await check("Session CRUD + delete", test_session_crud)()
  await check("Content format validation", test_content_format)()
  await check("Edge cases (empty/long/404/config)", test_edge_cases)()

  console.log("─".repeat(50))
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
