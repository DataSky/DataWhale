/**
 * DataWhale E2E Tests
 * Run: bun packages/cli/test/e2e.ts
 */

const BASE = "http://localhost:3000"
let passed = 0, failed = 0

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e: any) { console.log(`  ✗ ${name}: ${e.message}`); failed++ }
}

async function test_pages() {
  for (const ep of ["/", "/settings/", "/dashboard/"]) {
    const res = await fetch(`${BASE}${ep}`)
    if (res.status !== 200) throw new Error(`${ep} → ${res.status}`)
  }
}

async function test_sessions_api() {
  const res = await fetch(`${BASE}/api/sessions`)
  if (res.status !== 200) throw new Error(`sessions → ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error("sessions not array")
}

async function test_chat_sse() {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "reply with just: E2E_OK" }),
  })
  if (res.status !== 200 || !res.body) throw new Error("chat SSE failed")
  const reader = res.body.getReader()
  let buf = "", content = ""
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    buf += new TextDecoder().decode(value, { stream: true })
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data: ")) continue
      try { const ev = JSON.parse(line.slice(6)); if (ev.type === "message_update") content += ev.delta } catch {}
    }
  }
  if (!content || content.includes("Error")) throw new Error(`bad response: ${content.slice(0, 50)}`)
}

async function test_session_read() {
  const sessions = await (await fetch(`${BASE}/api/sessions`)).json()
  if (!sessions.length) throw new Error("no sessions to read")
  const sid = sessions[0].id
  const s = await (await fetch(`${BASE}/api/sessions/${sid}`)).json()
  if (!s.messages || s.messages.length < 2) throw new Error("expected at least 2 messages")
}

async function test_session_delete() {
  const sessions = await (await fetch(`${BASE}/api/sessions`)).json()
  if (!sessions.length) throw new Error("no sessions to delete")
  const sid = sessions[0].id
  const del = await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE" })
  if (del.status !== 200) throw new Error(`delete → ${del.status}`)
}

async function run() {
  console.log("\n🦈 DataWhale E2E Tests\n" + "─".repeat(40))
  await check("Static pages (/,/settings,/dashboard)", test_pages)
  await check("GET /api/sessions", test_sessions_api)
  await check("POST /api/chat (SSE)", test_chat_sse)
  await check("Session read (messages)", test_session_read)
  await check("Session delete", test_session_delete)
  console.log("─".repeat(40))
  console.log(`  ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
