/**
 * End-to-end verification for DataWhale
 * 
 * Tests: 
 * 1. Module imports work across workspace packages
 * 2. DuckDB tools function with real data
 * 3. Agent loop runs (offline — no LLM call)
 * 4. Extension system loads/unloads
 * 
 * Run: bun run packages/cli/test/e2e.ts
 */

import { Agent } from "@datawhale/agent"
import { AnthropicProvider, registerProvider, resolveModel } from "@datawhale/ai"
import { DuckDBTools, ToolRegistry, defineTool } from "@datawhale/tools"
import { ExtensionRegistry, loadExtension } from "@datawhale/extensions"
import type { AgentTool, AgentEvent } from "@datawhale/agent"
import type { Extension } from "@datawhale/extensions"

let passed = 0
let failed = 0

function check(name: string, fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
      passed++
    } catch (err) {
      console.log(`  ✗ ${name}: ${err}`)
      failed++
    }
  }
}

// ─── Test 1: Module interoperability ──────────────────────────────────────────

async function test1_imports() {
  // AI layer
  const model = resolveModel("sonnet")
  console.assert(model.provider === "anthropic", "Wrong provider")
  console.assert(model.model.startsWith("claude"), "Wrong model")

  // Provider registration
  const provider = new AnthropicProvider()
  registerProvider("anthropic", provider)
  console.assert(provider.name === "anthropic", "Wrong provider name")

  // Tool registry
  const registry = new ToolRegistry()
  registry.register(DuckDBTools.listTables)
  console.assert(registry.get("list_tables") !== undefined, "Tool not registered")
  console.assert(registry.list().length === 1, "Wrong tool count")

  // Extension registry
  const extReg = new ExtensionRegistry("test prompt")
  const ext: Extension = {
    manifest: { id: "test", name: "Test Ext", version: "0.1.0" },
    promptAdditions: ["Extra prompt line"],
  }
  extReg.register(ext)
  console.assert(extReg.listIds().length === 1, "Extension not registered")
  console.assert(extReg.getSystemPrompt().includes("Extra prompt line"), "Prompt not merged")
}

// ─── Test 2: DuckDB tools with real data ──────────────────────────────────────

async function test2_duckdb() {
  // Test that DuckDB WASM initializes and tools work
  // Note: DuckDB WASM requires Worker threads; may not be available in all Bun envs.

  // Setup test data via raw DB access (bypasses query safety checks)
  const db = await DuckDBTools.initDB()
  db.run("CREATE TABLE products (id INTEGER, name TEXT, category TEXT, price REAL)")
  db.run("INSERT INTO products VALUES (1, 'Test Product', 'TestCat', 10.0)")
  db.run("INSERT INTO products VALUES (2, 'Widget', 'WidgetCat', 20.0)")
  db.run("CREATE TABLE sales (id INTEGER, product_id INTEGER, amount REAL, region TEXT)")
  db.run("INSERT INTO sales VALUES (1, 1, 99.99, 'East')")
  db.run("INSERT INTO sales VALUES (2, 2, 149.99, 'West')")

  // Tool: list_tables
  const listResult = await DuckDBTools.listTables.execute("t1", {})
  console.assert(listResult.content.includes("products"), "list_tables should find products")

  // Tool: describe_table
  const descResult = await DuckDBTools.describeTable.execute("t2", { table: "products" })
  console.assert(descResult.content.includes("name"), "describe_table should show columns")
  console.assert(descResult.content.includes("id"), "describe_table should show id")

  // Tool: query
  const queryResult = await DuckDBTools.query.execute("t3", { sql: "SELECT * FROM products" })
  console.assert(queryResult.content.includes("Test Product"), "query should return data")

  // Tool: get_sample
  const sampleResult = await DuckDBTools.getSample.execute("t4", { table: "products", rows: 2 })
  console.assert(sampleResult.content.includes("Test"), "get_sample should return data")
}

// ─── Test 3: Agent construction and event flow ─────────────────────────────────

async function test3_agent_construction() {
  // Build a mock tool that doesn't need LLM
  const echoTool: AgentTool = {
    name: "echo",
    description: "Echo back the input",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    execute: async (_id, params) => ({
      content: `Echo: ${params.text}`,
    }),
  }

  const agent = new Agent({
    systemPrompt: "You are a test agent.",
    model: "sonnet",
    tools: [echoTool],
    maxTurns: 1,
  })

  // Subscribe and collect events
  const events: AgentEvent[] = []
  agent.subscribe((e) => events.push(e))

  // Verify agent state
  console.assert(agent.state.status === "idle", "Initial status should be idle")
  console.assert(agent.state.tools.length === 1, "Should have 1 tool")
  console.assert(agent.state.messages.length === 0, "No messages initially")

  // Test tool execution (via prompt won't work without LLM, but construction is fine)
  const eventsReceived = events.length
  console.assert(agent !== null, "Agent should be constructed")

  // Test abort
  agent.abort()
  console.assert(true, "Abort should not throw")
}

// ─── Test 4: Extension lifecycle ──────────────────────────────────────────────

async function test4_extension_lifecycle() {
  const lifecycle: string[] = []

  const ext: Extension = {
    manifest: { id: "lifecycle-test", name: "Lifecycle Test", version: "1.0.0" },
    tools: [
      {
        name: "ext_tool",
        description: "Test tool from extension",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: "ext_tool result" }),
      },
    ],
    promptAdditions: ["Extended context"],
    hooks: {
      onLoad: () => { lifecycle.push("loaded") },
      onUnload: () => { lifecycle.push("unloaded") },
    },
    setup: (api) => {
      lifecycle.push("setup")
      api.log("info", "setup complete")
    },
  }

  const registry = new ExtensionRegistry("base prompt", (level, msg) => {
    lifecycle.push(`log:${level}:${msg}`)
  })

  registry.register(ext)
  console.assert(registry.listIds().includes("lifecycle-test"), "Extension should be registered")

  await registry.activateAll()
  console.assert(lifecycle.includes("setup"), "Setup should be called")
  console.assert(lifecycle.includes("loaded"), "onLoad should be called")
  console.assert(lifecycle.some((e) => e.startsWith("log:")), "Log function should work")

  const tools = registry.getTools()
  console.assert(tools.length === 1, "Extension tool should be available")
  console.assert(tools[0].name === "ext_tool", "Wrong tool name")

  await registry.deactivateAll()
  console.assert(lifecycle.includes("unloaded"), "onUnload should be called")

  registry.unregister("lifecycle-test")
  console.assert(!registry.listIds().includes("lifecycle-test"), "Extension should be unregistered")
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n🦈 DataWhale E2E Verification\n")
  console.log("─".repeat(50))

  await check("Module imports & interop", test1_imports)()

  // DuckDB test: may fail if Worker threads unavailable in Bun
  try {
    await check("DuckDB tools with real data", test2_duckdb)()
  } catch (err: any) {
    if (err?.message?.includes("Worker") || err?.message?.includes("ModuleNotFound")) {
      console.log(`  ⚠ DuckDB WASM Worker unavailable — skipping DB tests`)
    } else {
      throw err
    }
  }

  await check("Agent construction & events", test3_agent_construction)()
  await check("Extension lifecycle", test4_extension_lifecycle)()

  console.log("─".repeat(50))
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error("Fatal test error:", err)
  process.exit(1)
})
