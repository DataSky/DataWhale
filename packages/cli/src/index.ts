/**
 * DataWhale CLI — Interactive data agent terminal
 * 
 * Usage: bun run packages/cli/src/index.ts [options] [prompt]
 *        dw "analyze sales trends"
 *        dw --db ./mydb.duckdb "show me the schema"
 */

import { Agent, SessionStore } from "@datawhale/agent"
import type { SessionMeta } from "@datawhale/agent"
import { AnthropicProvider, OpenAICompatibleProvider, registerProvider, resolveModel } from "@datawhale/ai"
import { DuckDBTools, DataIOTools } from "@datawhale/tools"
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
                           Available: deepseek, deepseek-reasoner, sonnet, haiku, gpt4o, gpt4o-mini
  -l, --load <file>       Load CSV/JSON file into database (repeatable)
  -d, --db <path>         Database file path (default: :memory:)
  -s, --session <name>    Name this session for later resume
  -r, --resume [id]       Resume a session (default: last)
  --list-sessions         List saved sessions
  -e, --extension <path>  Load extension (repeatable)
  -v, --verbose           Show verbose output
  --max-turns <n>         Max agent turns (default: 30)
  -h, --help              Show this help

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

// ─── Main CLI ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load .env / config files before anything else
  loadEnvFiles()

  const args = process.argv.slice(2)
  const { config, prompt } = parseArgs(args)

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

  // ── Extensions, tools, agent ──────────────────────────────────────────────



  // Load extensions
  const extensionRegistry = new ExtensionRegistry(
    DEFAULT_SYSTEM_PROMPT,
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
  const allTools = [...DuckDBTools.all, ...DataIOTools.all, ...extensionTools]

  // Build system prompt
  const systemPrompt = extensionRegistry.getSystemPrompt()

  // Create agent
  const agent = new Agent({
    systemPrompt,
    model: config.model,
    tools: allTools,
    maxTurns: config.maxTurns,
    temperature: 0.7,
    maxTokens: 4096,
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

  // Subscribe to events for nice output
  let currentText = ""
  let lastEventWasTool = false
  agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_start":
        currentText = ""
        break

      case "message_update":
        // Text after tool output: insert blank line for visual separation
        if (currentText === "" && lastEventWasTool) {
          process.stdout.write("\n")
          lastEventWasTool = false
        }
        process.stdout.write(event.delta)
        currentText += event.delta
        break

      case "tool_call_start":
        if (!config.verbose) {
          process.stdout.write(`\n  🔍 ${event.toolName}...`)
        }
        break

      case "tool_call_end":
        lastEventWasTool = true
        if (!config.verbose) {
          if (event.result.isError) {
            process.stdout.write(` ❌ ${event.result.errorMessage?.slice(0, 60)}`)
          } else {
            const preview = event.result.result.content.slice(0, 100).replace(/\n/g, " ")
            process.stdout.write(` ✓ (${preview}...)`)
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
        if (event.state.status === "error") {
          process.stdout.write(`\n  ❌ Agent terminated with error: ${event.state.error}\n`)
        }
        // Auto-save session messages
        sessionStore.saveMessages(sessionId!, event.state.messages).catch(() => {})
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

const DEFAULT_SYSTEM_PROMPT = `You are DataWhale, an AI-native data analysis agent.

Your capabilities:
- Explore database schemas and understand data structures
- Write and execute SQL queries against DuckDB
- Analyze results and provide insights
- Generate data-driven narratives

Guidelines:
1. ALWAYS explore the schema first (use list_tables, describe_table, get_sample)
2. Before writing complex queries, validate your understanding with simple ones
3. Present results clearly with context and interpretation
4. When you find interesting patterns, explain why they matter
5. Be concise but thorough — quality over quantity
6. If you're unsure about something, verify with a query before stating it as fact
7. Use get_sample to understand actual data values before analysis

You are NOT a traditional BI tool. You are an intelligent agent that can:
- Discover data autonomously
- Form hypotheses and test them with queries
- Combine multiple queries to build a complete picture
- Explain findings in plain language`

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("❌ Fatal error:", err)
  process.exit(1)
})
