/**
 * DataWhale CLI — Interactive data agent terminal
 * 
 * Usage: bun run packages/cli/src/index.ts [options] [prompt]
 *        dw "analyze sales trends"
 *        dw --db ./mydb.duckdb "show me the schema"
 */

import { Agent, SessionStore, TraceStore, KnowledgeStore, SkillStore } from "@datawhale/agent"
import type { SessionMeta, TraceRecord, KnowledgeEntry } from "@datawhale/agent"
import { AnthropicProvider, OpenAICompatibleProvider, registerProvider, resolveModel, getProvider } from "@datawhale/ai"
import { DuckDBTools, DataIOTools, ExternalTools, SelfExtendTools, setSessionContext } from "@datawhale/tools"
import { ExtensionRegistry, loadExtension } from "@datawhale/extensions"
import type { AgentTool, AgentEvent } from "@datawhale/agent"
import type { Extension } from "@datawhale/extensions"

// ─── Configuration ────────────────────────────────────────────────────────────

interface CLIConfig {
  model: string
  dbPath: string
  extensions: string[]
  verbose: boolean
  maxTurns: number
  loadFiles: string[]
  resumeSession: string | null
  sessionName: string | null
  listSessions: boolean
  serveMode: boolean
  servePort: number
}

function parseArgs(args: string[]): { config: CLIConfig; prompt?: string } {
  const config: CLIConfig = {
    model: process.env.DW_MODEL || "deepseek",
    dbPath: ":memory:",
    extensions: [],
    verbose: false,
    maxTurns: 30,
    loadFiles: [],
    resumeSession: null,
    sessionName: null,
    listSessions: false,
    serveMode: false,
    servePort: 3000,
  }

  let prompt: string | undefined
  let i = 0

  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
      case "--model":
      case "-m":
        config.model = args[++i] || config.model
        break
      case "--db":
      case "-d":
        config.dbPath = args[++i] || config.dbPath
        break
      case "--extension":
      case "-e":
        config.extensions.push(args[++i] || "")
        break
      case "--verbose":
      case "-v":
        config.verbose = true
        break
      case "--max-turns":
        config.maxTurns = parseInt(args[++i] || "30", 10)
        break
      case "--load":
      case "-l":
        config.loadFiles.push(args[++i] || "")
        break
      case "--resume":
      case "-r":
        config.resumeSession = args[++i] || "last"
        break
      case "--session":
      case "-s":
        config.sessionName = args[++i] || null
        break
      case "--list-sessions":
        config.listSessions = true
        break
      case "serve":
        config.serveMode = true
        break
      case "--port":
        config.servePort = parseInt(args[++i] || "3000", 10)
        break
      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
      default:
        if (!arg.startsWith("-")) {
          prompt = args.slice(i).join(" ")
          i = args.length
        }
        break
    }
    i++
  }

  return { config, prompt }
}

function printHelp(): void {
  console.log(`
🦈 DataWhale — AI-native data agent

Usage: dw [options] [prompt]

Options:
  -m, --model <model>     Model alias (default: deepseek)
                           Available: deepseek, deepseek-pro, deepseek-flash,
                           deepseek-reasoner, sonnet, haiku, gpt4o, gpt4o-mini
  -l, --load <file>       Load CSV/JSON file into database (repeatable)
  -d, --db <path>         Database file path (default: :memory:)
  -s, --session <name>    Name this session for later resume
  -r, --resume [id]       Resume a session (default: last)
  --list-sessions         List saved sessions
  -e, --extension <path>  Load extension (repeatable)
  -v, --verbose           Show verbose output
  --max-turns <n>         Max agent turns (default: 30)
  -h, --help              Show this help

  serve                   Start web server + browser UI
  --port <n>              Web server port (default: 3000)

Environment:
  DEEPSEEK_API_KEY        DeepSeek API key (required for default model)
  ANTHROPIC_API_KEY       Anthropic API key (for --model sonnet/haiku)
  OPENAI_API_KEY          OpenAI API key (for --model gpt4o)
  DW_MODEL                Default model alias

Examples:
  dw "analyze sales trends in the database"
  dw --db ./data.db "show me all tables and their row counts"
  dw -m gpt4o "what insights can you find?"
`)
}

// ─── Env Loader ───────────────────────────────────────────────────────────────

function loadEnvFiles(): void {
  // Priority: process env > .env (project) > ~/.datawhale/config.json (global)
  const fs = require("fs")
  const path = require("path")
  const os = require("os")

  const files: string[] = []

  // Global config
  const globalConfig = path.join(os.homedir(), ".datawhale", "config.json")
  if (fs.existsSync(globalConfig)) {
    files.push(globalConfig)
  }

  // Project .env
  const projectEnv = path.join(process.cwd(), ".env")
  if (fs.existsSync(projectEnv)) {
    files.push(projectEnv)
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf-8")
      if (file.endsWith(".json")) {
        const json = JSON.parse(content)
        for (const [k, v] of Object.entries(json)) {
          if (!process.env[k] && typeof v === "string") {
            process.env[k] = v
          }
        }
      } else {
        // .env format: KEY=VALUE (ignore comments and empty lines)
        for (const line of content.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith("#")) continue
          const eqIdx = trimmed.indexOf("=")
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim()
            let value = trimmed.slice(eqIdx + 1).trim()
            // Strip quotes
            if ((value.startsWith('"') && value.endsWith('"')) || 
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1)
            }
            if (!process.env[key]) {
              process.env[key] = value
            }
          }
        }
      }
    } catch {
      // Silently skip unreadable files
    }
  }
}

// ─── Knowledge Extraction ───────────────────────────────────────────────────

async function extractKnowledge(
  sessionId: string,
  messages: AgentMessage[],
  store: KnowledgeStore
): Promise<void> {
  // Only extract if there were actual user-assistant exchanges
  const userMsgs = messages.filter((m) => m.role === "user")
  const assistantMsgs = messages.filter((m) => m.role === "assistant")
  if (userMsgs.length === 0 || assistantMsgs.length === 0) return

  // Build a summary of the conversation
  const summary = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const text = typeof m.content === "string"
        ? m.content
        : (m.content as any[]).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ")
      return `[${m.role}]: ${text.slice(0, 300)}`
    })
    .join("\n")

  // Use the configured provider to extract knowledge
  if (!getProvider("deepseek")) {
    registerProvider("deepseek", OpenAICompatibleProvider.deepseek())
  }

  const provider = getProvider("deepseek")
  if (!provider) return

  try {
    const result = await provider.chat({
      model: resolveModel("deepseek-flash"),
      messages: [
        {
          role: "system",
          content: `CRITICAL: Output ONLY a JSON array, no other text, no markdown formatting, no explanations.

From the conversation below, extract 1-3 key facts about the data that would be valuable for future sessions. Focus on:
- Data schema (table names, column meanings, data types)
- Business semantics (what values mean, domain knowledge)
- Data quality observations (patterns, anomalies, edge cases)

Format: [{"domain":"...","fact":"...","keywords":"keyword1,keyword2"}]

Example response (this is the ONLY format you should output):
[{"domain":"sales","fact":"The region column contains values: East, West, North, South","keywords":"region,sales,geography"}]

DO NOT include any text before or after the JSON array.`,
        },
        { role: "user", content: summary },
      ],
      temperature: 0.3,
      maxTokens: 500,
    })

    const text = result.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("")
      .trim()

    // Try to parse JSON — handle multiple formats:
    // 1. Pure JSON array: [{...}]
    // 2. Single JSON object: {...}
    // 3. Markdown-wrapped: ```json [...] ```
    // 4. Text with embedded JSON
    let entries: Array<{ domain: string; fact: string; keywords: string }> = []

    // Strip markdown code fences
    const cleanText = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim()

    // Try array format
    const arrayMatch = cleanText.match(/^\s*\[([\s\S]*)\]\s*$/)
    if (arrayMatch) {
      try {
        entries = JSON.parse(arrayMatch[0])
      } catch {}
    }

    // Fallback: try single object
    if (entries.length === 0) {
      const objMatch = cleanText.match(/^\s*\{[\s\S]*\}\s*$/)
      if (objMatch) {
        try {
          const obj = JSON.parse(objMatch[0])
          entries = [obj]
        } catch {}
      }
    }

    // Fallback: find any JSON array anywhere in text
    if (entries.length === 0) {
      const anyMatch = cleanText.match(/\[[\s\S]*\]/)
      if (anyMatch) {
        try { entries = JSON.parse(anyMatch[0]) } catch {}
      }
    }

    if (entries.length === 0 && cleanText.length > 10) {
      console.error("[knowledge] could not parse JSON from:", cleanText.slice(0, 150))
    }

    for (const entry of entries) {
      if (entry.fact && entry.fact.length > 5) {
        await store.add({
          domain: entry.domain || "general",
          fact: entry.fact,
          keywords: entry.keywords || "",
          sourceSession: sessionId,
          createdAt: Date.now(),
          confidence: 0.6,
        })
      }
    }
  } catch (e: any) {
    // Knowledge extraction failure is non-blocking
    console.error("[knowledge] extraction failed:", e?.message?.slice(0, 100) || e)
  }
}

// ─── Main CLI ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load .env / config files before anything else
  loadEnvFiles()

  // ── Sandbox persistence ───────────────────────────────────────────────────
  // Auto-pause E2B sandbox on exit for session recovery
  process.on("exit", () => {
    ExternalTools.pauseSandbox?.().catch(() => {})
  })
  process.on("SIGINT", () => {
    ExternalTools.pauseSandbox?.().then(() => process.exit(0)).catch(() => process.exit(0))
  })

  const args = process.argv.slice(2)
  const { config, prompt } = parseArgs(args)

  // ── Serve mode ──────────────────────────────────────────────────────────
  if (config.serveMode) {
    process.env.PORT = String(config.servePort)
    console.log(`🦈 Starting DataWhale Web Server...`)
    const serverModule = await import("../../app-server/src/index.js")
    Bun.serve({ port: config.servePort, fetch: serverModule.default.fetch, idleTimeout: 255 })
    console.log(`   Web UI → http://localhost:${config.servePort}`)
    return
  }

  // Check API key for the configured model
  const resolvedModel = resolveModel(config.model)
  if (resolvedModel.provider === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    console.error("❌ DEEPSEEK_API_KEY environment variable is required")
    console.error("   Set it with: export DEEPSEEK_API_KEY=sk-...")
    console.error("   Get your key at: https://platform.deepseek.com/api_keys")
    console.error("   Or use --model sonnet for Anthropic, --model gpt4o for OpenAI")
    process.exit(1)
  }
  if (resolvedModel.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY environment variable is required")
    console.error("   Set it with: export ANTHROPIC_API_KEY=sk-ant-...")
    process.exit(1)
  }
  if (resolvedModel.provider === "openai" && !process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY environment variable is required")
    process.exit(1)
  }

  // Register providers
  if (process.env.DEEPSEEK_API_KEY) {
    registerProvider("deepseek", OpenAICompatibleProvider.deepseek())
  }
  if (process.env.ANTHROPIC_API_KEY) {
    registerProvider("anthropic", new AnthropicProvider())
  }
  if (process.env.OPENAI_API_KEY) {
    registerProvider("openai", OpenAICompatibleProvider.openai())
  }

  console.log(`🦈 DataWhale v0.1.0`)
  console.log(`   Model: ${config.model}`)
  console.log(`   Database: in-memory (SQLite via sql.js)`)
  if (config.dbPath !== ":memory:") {
    console.log(`   Note: file-based DB not yet supported in WASM mode`)
  }
  console.log()

  // ── Session management ─────────────────────────────────────────────────────
  const sessionStore = new SessionStore()
  const traceStore = new TraceStore()

  // --list-sessions
  if (config.listSessions) {
    const sessions = await sessionStore.listSessions(20)
    if (sessions.length === 0) {
      console.log("  No saved sessions found.\n")
    } else {
      console.log("  Saved sessions:\n")
      for (const s of sessions) {
        const d = new Date(s.createdAt).toISOString().slice(0, 10)
        console.log(`  ${s.id.slice(0, 12)}...  ${d}  ${s.model}  ${s.messageCount} msgs  "${s.title}"`)
      }
      console.log()
    }
    process.exit(0)
  }

  // --resume
  let sessionId: string | null = null
  if (config.resumeSession) {
    if (config.resumeSession === "last") {
      const sessions = await sessionStore.listSessions(1)
      if (sessions.length === 0) {
        console.log("  No previous sessions to resume.\n")
        config.resumeSession = null
      } else {
        sessionId = sessions[0].id
      }
    } else {
      const s = await sessionStore.getSession(config.resumeSession)
      if (s) {
        sessionId = s.id
      } else {
        // Try prefix match
        const sessions = await sessionStore.listSessions(100)
        const match = sessions.find((s) => s.id.startsWith(config.resumeSession!))
        if (match) sessionId = match.id
        else {
          console.log(`  Session "${config.resumeSession}" not found.\n`)
          config.resumeSession = null
        }
      }
    }
  }

  // Create new session
  if (!sessionId) {
    const title = config.sessionName || config.prompt?.slice(0, 40) || "interactive"
    const meta = await sessionStore.createSession(title, config.model)
    sessionId = meta.id
    console.log(`   Session: ${sessionId.slice(0, 16)}...`)
  } else {
    const meta = await sessionStore.getSession(sessionId)
    console.log(`   Resumed: ${meta?.title || sessionId.slice(0, 16)}`)
  }

  // Tell tools which session we're in (for file isolation)
  setSessionContext(sessionId!)

  // ── Data loading ──────────────────────────────────────────────────────────
  for (const file of config.loadFiles) {
    console.log(`   Loading: ${file}...`)
    try {
      // Smart path resolution: try given path, cwd-relative, and subdirectory search
      const fs = await import("node:fs")
      const path = await import("node:path")
      let resolvedPath = file
      if (!fs.existsSync(resolvedPath)) {
        resolvedPath = path.resolve(process.cwd(), file)
      }
      if (!fs.existsSync(resolvedPath)) {
        // Search in test/fixtures and current dir recursively (1 level)
        const searchDirs = [process.cwd(), path.join(process.cwd(), "test/fixtures")]
        for (const dir of searchDirs) {
          if (!fs.existsSync(dir)) continue
          for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry)
            if (entry === path.basename(file) && fs.statSync(full).isFile()) {
              resolvedPath = full
              break
            }
          }
          if (fs.existsSync(resolvedPath)) break
        }
      }

      const isCSV = resolvedPath.endsWith(".csv")
      const tool = isCSV ? DataIOTools.loadCsv : DataIOTools.loadJson
      const result = await tool.execute("cli-load", { path: resolvedPath })
      if (result.isError) {
        console.error(`   ❌ ${result.errorMessage}`)
      } else {
        const preview = result.content.split("\n").slice(0, 3).join("\n")
        console.log(`   ✓ ${preview}`)
      }
    } catch (err: any) {
      console.error(`   ❌ Failed to load ${file}: ${err.message}`)
    }
  }
  if (config.loadFiles.length > 0) console.log()

  // ── Knowledge retrieval ──────────────────────────────────────────────────
  const knowledgeStore = new KnowledgeStore()
  let knowledgeContext = ""
  const userPrompt = prompt || "interactive session"
  try {
    const relevant = await knowledgeStore.search(userPrompt, 3)
    if (relevant.length > 0) {
      knowledgeContext = `\n\n📚 **Prior Knowledge (from past sessions):**\n${relevant.map((k, i) => `${i + 1}. [${k.domain}] ${k.fact}`).join("\n")}\n\nUse this prior knowledge when relevant, but verify it against current data.`
      if (config.verbose) {
        console.log(`   📚 Loaded ${relevant.length} prior knowledge entries`)
      }
    }
  } catch {}

  // ── Skill matching ─────────────────────────────────────────────────────
  const skillStore = new SkillStore()
  let skillContext = ""
  try {
    await skillStore.discover()
    const matched = skillStore.matchSkills(userPrompt, 3)
    if (matched.length > 0) {
      skillContext = matched.map((s) =>
        `\n\n## Skill: ${s.name}\n\n${s.body}`
      ).join("\n")
      if (config.verbose) {
        console.log(`   🎯 Matched ${matched.length} skill(s): ${matched.map((s) => s.id).join(", ")}`)
      }
    }
  } catch {}

  // ── Extensions, tools, agent ──────────────────────────────────────────────



  // Load extensions
  const extensionRegistry = new ExtensionRegistry(
    buildSystemPrompt(),
    (level, msg) => {
      if (config.verbose || level === "error") {
        const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : "ℹ️"
        console.error(`  ${prefix} ${msg}`)
      }
    }
  )

  for (const extPath of config.extensions) {
    try {
      const ext = await loadExtension({ path: extPath })
      extensionRegistry.register(ext)
      console.log(`  🔌 Loaded extension: ${ext.manifest.name}`)
    } catch (err) {
      console.error(`  ❌ Failed to load extension "${extPath}": ${err}`)
    }
  }

  await extensionRegistry.activateAll()

  // Combine tools
  const extensionTools = extensionRegistry.getTools()
  const allTools = [...DuckDBTools.all, ...DataIOTools.all, ...ExternalTools.all, ...SelfExtendTools.all, ...extensionTools]

  // Build system prompt
  const systemPrompt = extensionRegistry.getSystemPrompt() + knowledgeContext + skillContext

  // Create agent
  const agent = new Agent({
    systemPrompt,
    model: config.model,
    tools: allTools,
    maxTurns: config.maxTurns,
    temperature: 0.7,
    maxTokens: 4096,
    // DeepSeek model router: simple tasks → flash, complex → pro
    modelRouter: (messages, turn) => {
      // Turn 1 always use the configured model (pro) to understand intent
      if (turn === 1) return config.model

      // Check if the last user message looks simple
      const userMessages = messages.filter((m) => m.role === "user")
      const lastUser = userMessages[userMessages.length - 1]
      if (lastUser) {
        const text = typeof lastUser.content === "string" ? lastUser.content : ""
        const isSimple =
          text.length < 80 &&
          !/(分析|趋势|归因|预测|建模|回归|异常|对比|降维|聚类|深度|explain|analyze|predict|compare|complex|deep)/i.test(text)
        if (isSimple) return "deepseek-flash"
      }

      return config.model
    },
    beforeToolCall: async (ctx) => {
      if (config.verbose) {
        console.error(`  🔧 Tool: ${ctx.toolName}(${JSON.stringify(ctx.args).slice(0, 80)})`)
      }
      await extensionRegistry.runBeforeTurnHooks()
    },
    afterToolCall: async (ctx) => {
      if (ctx.isError && config.verbose) {
        console.error(`  ❌ Tool error: ${ctx.errorMessage}`)
      }
      await extensionRegistry.runAfterTurnHooks()
    },
  })

  // Wire self-extending system
  SelfExtendTools.setSelfExtendContext(extensionRegistry, (newTools) => {
    const merged = [...DuckDBTools.all, ...DataIOTools.all, ...ExternalTools.all, ...SelfExtendTools.all, ...newTools]
    agent.setTools(merged)
  })

  // ── Trace recording ───────────────────────────────────────────────────────
  let traceStartMs = 0
  let currentTurnModel = config.model
  agent.subscribe((event: AgentEvent) => {
    const trace: TraceRecord = {
      traceId: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId: sessionId!,
      turn: 0,
      eventType: "user_msg",
      timestamp: Date.now(),
    }

    switch (event.type) {
      case "agent_start":
        trace.eventType = "session_start"
        traceStore.record(trace).catch(() => {})
        break

      case "turn_start":
        trace.turn = event.turn
        trace.eventType = "llm_call"
        trace.model = currentTurnModel
        traceStartMs = Date.now()
        traceStore.record(trace).catch(() => {})
        break

      case "tool_call_start":
        trace.turn = event.toolCallId ? 0 : 0 // filled by prev turn_start
        trace.eventType = "tool_call"
        trace.toolName = event.toolName
        trace.toolArgs = JSON.stringify(event.args).slice(0, 500)
        traceStore.record(trace).catch(() => {})
        break

      case "tool_call_end":
        trace.eventType = "tool_result"
        trace.toolName = event.result.toolName
        trace.toolIsError = event.result.isError
        trace.toolResultSummary = (event.result.isError ? event.result.errorMessage : event.result.result.content)?.slice(0, 500)
        trace.errorMessage = event.result.isError ? event.result.errorMessage : undefined
        traceStore.record(trace).catch(() => {})
        break

      case "turn_end":
        if (traceStartMs > 0) {
          trace.eventType = "llm_call"
          trace.latencyMs = Date.now() - traceStartMs
          // Update the llm_call record with latency
          traceStartMs = 0
        }
        break

      case "message_end":
        trace.eventType = "agent_response"
        traceStore.record(trace).catch(() => {})
        break

      case "error":
        trace.eventType = "error"
        trace.errorMessage = event.message
        traceStore.record(trace).catch(() => {})
        break

      case "agent_end":
        trace.eventType = "session_end"
        trace.metadata = { status: event.state.status, error: event.state.error }
        traceStore.record(trace).catch(() => {})
        break
    }
  })

  // Subscribe to events for nice output
  let currentText = ""
  let inReasoning = false
  let reasoningCharCount = 0
  agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_start":
        currentText = ""
        break

      case "message_update":
        // End reasoning block ONCE before showing final answer
        if (inReasoning) {
          process.stdout.write(`\x1b[0m\x1b[2m  ── thought for ${reasoningCharCount} chars ──\x1b[0m\n`)
          inReasoning = false
          reasoningCharCount = 0
        }
        process.stdout.write(event.delta)
        currentText += event.delta
        break

      case "reasoning_update":
        // Show reasoning in dim grey, stream in real-time
        // Only start reasoning block if no text output has begun yet
        if (!inReasoning && currentText === "") {
          process.stdout.write("\x1b[2m")
          inReasoning = true
        }
        if (inReasoning) {
          process.stdout.write(event.delta)
          reasoningCharCount += event.delta.length
        }
        break

      case "tool_call_start":
        // End reasoning before tool call
        if (inReasoning) {
          process.stdout.write(`\x1b[0m\x1b[2m  ── thought for ${reasoningCharCount} chars ──\x1b[0m\n`)
          inReasoning = false
          reasoningCharCount = 0
        }
        if (!config.verbose) {
          process.stdout.write(` → 🔍 ${event.toolName}`)
        }
        break

      case "tool_call_end":
        // End reasoning if still active
        if (inReasoning) {
          process.stdout.write(`\x1b[0m\x1b[2m  ── thought for ${reasoningCharCount} chars ──\x1b[0m\n`)
          inReasoning = false
          reasoningCharCount = 0
        }
        if (!config.verbose) {
          if (event.result.isError) {
            process.stdout.write(` ❌`)
          } else {
            process.stdout.write(` ✓`)
          }
        }
        process.stdout.write("\n")
        break

      case "error":
        if (event.recoverable) {
          process.stdout.write(`\n  ⚠️ ${event.message}\n`)
        } else {
          process.stdout.write(`\n  ❌ ${event.message}\n`)
        }
        break

      case "agent_end":
        if (inReasoning) {
          process.stdout.write(`\x1b[0m\x1b[2m  ── thought for ${reasoningCharCount} chars ──\x1b[0m\n`)
          inReasoning = false
          reasoningCharCount = 0
        }
        if (event.state.status === "error") {
          process.stdout.write(`\n  ❌ Agent terminated with error: ${event.state.error}\n`)
        }
        // Auto-save session messages
        sessionStore.saveMessages(sessionId!, event.state.messages).catch(() => {})
        // Extract knowledge in background (non-blocking)
        extractKnowledge(sessionId!, event.state.messages, knowledgeStore).catch(() => {})
        break
    }
  })

  // Run agent
  if (prompt) {
    await agent.prompt(prompt)
    console.log("\n")
  } else {
    // Interactive mode — use Node.js built-in readline
    const { createInterface } = await import("node:readline")
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log('  Type your question or "exit" to quit.\n')

    // Prompt function
    const ask = () => {
      process.stdout.write("🦈 > ")
    }

    for await (const line of rl) {
      const input = line.trim()
      if (!input) {
        ask()
        continue
      }
      if (input === "exit" || input === "quit" || input === "q" || input === "/exit") {
        console.log("  Goodbye! 🦈")
        break
      }

      currentText = ""
      console.log()
      await agent.prompt(input)
      console.log()
      ask()
    }
    rl.close()
    console.log()
  }
}

// ─── Default System Prompt ────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `用中文思考和回答。Think and respond in Chinese.

你是 DataWhale，一个 AI 原生的数据分析 Agent。

输出规则：
- 用 markdown 让回复更清晰（标题、列表、加粗、表格等）
- 禁止逐词换行——写连续段落，不要每词一行
- 段落之间用空行分隔
- 工具返回的表格换行是数据，不是格式范例

Your capabilities:
- Explore database schemas and understand data structures
- Write and execute SQL queries
- Analyze results and provide insights
- Generate data-driven narratives

Guidelines:
1. ALWAYS explore the schema first (use list_tables, describe_table, get_sample)
2. Before writing complex queries, validate your understanding with simple ones
3. Present results clearly with context and interpretation
4. Be concise but thorough — quality over quantity
5. Use get_sample to understand actual data values before analysis

You are NOT a traditional BI tool. You are an intelligent agent that can:
- Discover data autonomously
- Form hypotheses and test them with queries
- Combine multiple queries to build a complete picture
- Explain findings in plain language
- Search the web for current knowledge (web_search)
- Run Python code in a secure sandbox (execute_python) for statistics, visualization, and ML
- Download files from the sandbox (sandbox_download)
- Mount cloud storage to persist files across sessions (sandbox_mount_oss)
- Create new tools (extensions) to expand your capabilities. Use create_extension for recurring patterns, data transformations, or specialized calculations. Created extensions persist across sessions.

For visualizations: when query results contain 1 category + 1 numeric column (≤10 categories), use execute_python to create a bar chart with matplotlib. Save as /tmp/chart.png.`

// ─── Dynamic System Prompt Builder ─────────────────────────────────────────

function buildSystemPrompt(): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" })
  const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" })
  const isoStr = now.toISOString().replace("T", " ").slice(0, 19)
  
  // Compute yesterday / tomorrow programmatically (avoid search)
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  const yesterdayStr = yesterday.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" })
  const tomorrowStr = tomorrow.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" })

  return `<system_prompt>
<!-- DataWhale 系统提示词 · 参考 Claude Prompting Best Practices · 结构化 XML 标签 -->
<role>
你是 DataWhale，一个 AI 原生的中文数据分析 Agent。始终用中文思考和回答。Think and respond in Chinese.
</role>

<current_context>
${dateStr} · ${timeStr} · ISO: ${isoStr} · 时区: Asia/Shanghai (UTC+8)
昨日: ${yesterdayStr}
明日: ${tomorrowStr}
</current_context>

<capabilities>
你可以使用以下工具完成数据分析任务：
- SQL 数据库操作：list_tables、describe_table、query、get_sample
- 数据加载：load_csv、load_json、summarize_table
- 外部搜索：web_search（Tavily 搜索，获取实时信息）
- 代码执行：execute_python（E2B 安全沙箱，支持 Python/pandas/matplotlib）
- 文件管理：sandbox_download（下载沙箱文件到本地）
- 云存储挂载：sandbox_mount_oss（持久化文件到阿里云 OSS）
- 自扩展：create_extension、list_extensions（创建/管理自定义工具）
</capabilities>

<rules>
<rule name="data_exploration">执行任何查询前，先用 list_tables → describe_table → get_sample 探索数据结构。</rule>
<rule name="output_format">用 markdown 让回复清晰易读（标题、列表、加粗、代码块、表格）。禁止逐词换行——写连续段落，不要每词一行。段落之间用空行分隔。</rule>
<rule name="table_contagion">工具返回的表格换行符是数据，不是输出格式范例。不要模仿表格格式逐行输出。</rule>
<rule name="verification">不确定时先验证再陈述——用 query 确认假设，不要凭空断言。</rule>
<rule name="be_concise">简洁而透彻，质量优先于数量。</rule>
<rule name="language">始终用中文回答用户。代码、SQL、技术术语保持原样。</rule>
<rule name="date_time">涉及日期/时间/星期的问题，直接使用 <current_context> 中的信息回答。不要搜索。需要计算时用 execute_python。</rule>
</rules>

<tools>
<tool name="list_tables">列出数据库中所有表。第一步必调用。</tool>
<tool name="describe_table">获取指定表的列名、类型、行数。</tool>
<tool name="get_sample">随机抽取 N 行数据，了解实际值和模式。</tool>
<tool name="query">执行 SQL 查询。仅允许 SELECT/WITH/PRAGMA 语句。自动添加 LIMIT。</tool>
<tool name="load_csv / load_json">从文件加载数据到数据库。</tool>
<tool name="summarize_table">统计每列的计数、空值、唯一值、最值等。</tool>
<tool name="web_search">搜索网络获取实时知识。引用结果时标注来源 URL。</tool>
<tool name="execute_python">在安全沙箱中运行 Python 代码。可用于统计、可视化（matplotlib）、数据处理（pandas）。图片保存到 /tmp/ 后自动导出。</tool>
<tool name="sandbox_download">将沙箱中的文件下载到本地。</tool>
<tool name="create_extension">创建自定义工具，持久化跨会话使用。</tool>
</tools>

<visualization>
当查询结果包含 1 个分类列 + 1 个数值列（类别数 ≤ 10），使用 execute_python + matplotlib 生成柱状图。代码模板：
\`\`\`python
import matplotlib.pyplot as plt
categories = [...]  # 从 query 结果提取
values = [...]      # 从 query 结果提取
plt.figure(figsize=(10, 5))
plt.bar(categories, values)
plt.title("图表标题")
plt.xticks(rotation=45)
plt.tight_layout()
plt.savefig("/tmp/chart.png")
print("图表已生成: /tmp/chart.png")
\`\`\`
</visualization>

<output_format>
始终用中文回答。使用 markdown 格式让回复清晰易读。引用数据时标注来源（表名、SQL）。搜索引用时标注 URL。
</output_format>
</system_prompt>`
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("❌ Fatal error:", err)
  process.exit(1)
})
