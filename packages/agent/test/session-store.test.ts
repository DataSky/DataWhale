/**
 * SessionStore unit tests
 * Run: cd DataWhale && bun packages/agent/test/session-store.test.ts
 */

import { SessionStore } from "../src/session-store.js"

let passed = 0, failed = 0
function check(name: string, fn: () => Promise<void>) {
  return async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e: any) { console.log(`  ✗ ${name}: ${e.message}`); failed++ }
  }
}

const store = new SessionStore(":memory:")

// ── Test: createSession ──────────────────────────────────────────────────
async function test_create_session() {
  const meta = await store.createSession("Test Session", "deepseek")
  if (!meta.id) throw new Error("No id returned")
  if (meta.title !== "Test Session") throw new Error("Wrong title")
  if (meta.model !== "deepseek") throw new Error("Wrong model")
  if (meta.messageCount !== 0) throw new Error("Expected 0 messages")
  if (!meta.createdAt) throw new Error("No createdAt")
}

// ── Test: getSession / listSessions ─────────────────────────────────────
let testSessionId = ""

async function test_get_and_list() {
  const meta = await store.createSession("Get Test", "v4-pro")
  testSessionId = meta.id

  const got = await store.getSession(testSessionId)
  if (!got) throw new Error("getSession returned null")
  if (got.title !== "Get Test") throw new Error("Wrong title")

  const list = await store.listSessions(10)
  if (list.length < 1) throw new Error("listSessions empty")
  const found = list.find(s => s.id === testSessionId)
  if (!found) throw new Error("Created session not in list")
}

// ── Test: saveMessages + loadMessages ────────────────────────────────────
async function test_save_load_messages() {
  const messages = [
    { role: "user" as const, content: "hello", timestamp: 1000 },
    { role: "assistant" as const, content: "hi there", timestamp: 2000, thinking: "I should say hi", meta: { toolCalls: [{ id: "c1", name: "test_tool", arguments: "{}" }] } },
    { role: "user" as const, content: "how are you", timestamp: 3000 },
  ]
  await store.saveMessages(testSessionId, messages)

  const loaded = await store.loadMessages(testSessionId)
  if (loaded.length !== 3) throw new Error(`Expected 3 messages, got ${loaded.length}`)
  if (loaded[0].role !== "user") throw new Error("Wrong role for msg 0")
  if (loaded[0].content !== "hello") throw new Error("Wrong content for msg 0")
  if (loaded[1].role !== "assistant") throw new Error("Wrong role for msg 1")
  if (loaded[1].thinking !== "I should say hi") throw new Error("Thinking not preserved")
  if (!loaded[1].meta?.toolCalls) throw new Error("Tool calls not preserved")
  if (loaded[1].meta.toolCalls[0].name !== "test_tool") throw new Error("Wrong tool name")
  if (loaded[2].content !== "how are you") throw new Error("Wrong content for msg 2")
}

// ── Test: updateTitle ────────────────────────────────────────────────────
async function test_update_title() {
  await store.updateTitle(testSessionId, "Renamed Session")
  const got = await store.getSession(testSessionId)
  if (got?.title !== "Renamed Session") throw new Error("Title not updated")
}

// ── Test: deleteSession ──────────────────────────────────────────────────
async function test_delete_session() {
  const meta = await store.createSession("To Delete", "v4")
  const sid = meta.id
  // Add some messages
  await store.saveMessages(sid, [{ role: "user" as const, content: "del", timestamp: 1 }])

  await store.deleteSession(sid)
  const got = await store.getSession(sid)
  if (got !== null) throw new Error("Session not deleted")
  // Messages should also be deleted (CASCADE)
  const msgs = await store.loadMessages(sid)
  if (msgs.length !== 0) throw new Error("Messages not cascade-deleted")
}

// ── Test: empty / edge cases ─────────────────────────────────────────────
async function test_empty_cases() {
  // Non-existent session
  const got = await store.getSession("nonexistent")
  if (got !== null) throw new Error("Expected null for nonexistent")

  // Empty messages
  const msgs = await store.loadMessages("nonexistent")
  if (msgs.length !== 0) throw new Error("Expected empty array")

  // Delete nonexistent
  await store.deleteSession("nonexistent") // should not throw
}

// ── Test: message count accuracy ─────────────────────────────────────────
async function test_message_count() {
  const meta = await store.createSession("Count Test", "v4")
  await store.saveMessages(meta.id, [
    { role: "user" as const, content: "a", timestamp: 1 },
    { role: "assistant" as const, content: "b", timestamp: 2 },
  ])
  const got = await store.getSession(meta.id)
  if (got?.messageCount !== 2) throw new Error(`Expected 2, got ${got?.messageCount}`)
}

// ── Run ──────────────────────────────────────────────────────────────────
async function run() {
  console.log("\n🗄️  SessionStore Tests\n" + "─".repeat(40))
  await check("createSession", test_create_session)()
  await check("getSession + listSessions", test_get_and_list)()
  await check("saveMessages + loadMessages", test_save_load_messages)()
  await check("updateTitle", test_update_title)()
  await check("deleteSession (cascade)", test_delete_session)()
  await check("empty / edge cases", test_empty_cases)()
  await check("message count", test_message_count)()
  console.log("─".repeat(40))
  console.log(`  ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
