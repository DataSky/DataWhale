/**
 * DataWhale App Server — HTTP / SSE API for Web UI
 * 
 * Bun + Hono, embedded Agent Runtime. Serves:
 * - Static frontend assets (Next.js production build)
 * - SSE endpoint for streaming agent chat
 * - REST endpoints for sessions / files / knowledge
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { serveStatic } from "hono/bun"
import { streamSSE } from "hono/streaming"
import type { AgentEvent } from "@datawhale/agent"
import { Agent, SessionStore, TraceStore, KnowledgeStore, SkillStore, QueryStore, makeQuery } from "@datawhale/agent"
import { OpenAICompatibleProvider, registerProvider } from "@datawhale/ai"
import { DuckDBTools, DataIOTools, ExternalTools, SelfExtendTools, setSessionContext } from "@datawhale/tools"

// ─── Init ────────────────────────────────────────────────────────────────────

const WEB_DIR = `${import.meta.dir}/../../web/out`

const app = new Hono()

app.use("*", cors())

// ─── Provider & Session init ─────────────────────────────────────────────────

const sessionStore = new SessionStore()
const traceStore = new TraceStore()
const knowledgeStore = new KnowledgeStore()
const skillStore = new SkillStore()
const queryStore = new QueryStore()

// Register DeepSeek
if (process.env.DEEPSEEK_API_KEY) {
  registerProvider("deepseek", OpenAICompatibleProvider.deepseek())
}

// ─── SSE Chat Endpoint ───────────────────────────────────────────────────────

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    prompt: string
    sessionId?: string
    files?: string[]
  }>()

  const prompt = body.prompt
  if (!prompt) return c.json({ error: "prompt required" }, 400)

  // Session
  let sessionId = body.sessionId
  if (!sessionId) {
    const m = await sessionStore.createSession(prompt.slice(0, 40), "deepseek-v4-pro")
    sessionId = m.id
  }
  setSessionContext(sessionId)

  // Skills
  let skillContext = ""
  try {
    await skillStore.discover()
    const matched = skillStore.matchSkills(prompt, 3)
    if (matched.length > 0) {
      skillContext = matched.map((s) => `\n\n## Skill: ${s.name}\n\n${s.body}`).join("\n")
    }
  } catch {}

  // Knowledge
  let knowledgeContext = ""
  try {
    const relevant = await knowledgeStore.search(prompt, 3)
    if (relevant.length > 0) {
      knowledgeContext = `\n\n📚 Prior Knowledge:\n${relevant.map((k, i) => `${i + 1}. [${k.domain}] ${k.fact}`).join("\n")}\n\n`
    }
  } catch {}

  // Load files
  for (const file of body.files || []) {
    try {
      const isCSV = file.endsWith(".csv")
      const tool = isCSV ? DataIOTools.loadCsv : DataIOTools.loadJson
      await tool.execute("svr-load", { path: file })
    } catch {}
  }

  // Build agent
  const agent = new Agent({
    systemPrompt: SYSTEM_PROMPT + knowledgeContext + skillContext,
    model: "deepseek-v4-pro",
    tools: [
      ...DuckDBTools.all,
      ...DataIOTools.all,
      ...ExternalTools.all,
      ...SelfExtendTools.all,
    ],
    maxTurns: 30,
    temperature: 0.7,
    maxTokens: 4096,
  })

  // SSE stream
  return streamSSE(c, async (stream) => {
    const ac = new AbortController()

    stream.onAbort(() => ac.abort())

    agent.subscribe((event: AgentEvent) => {
      // Map agent events to SSE
      const data: Record<string, unknown> = { type: event.type, sessionId }

      switch (event.type) {
        case "message_update":
          data.delta = event.delta
          break
        case "reasoning_update":
          data.delta = event.delta
          break
        case "tool_call_start":
          data.toolCallId = event.toolCallId
          data.toolName = event.toolName
          data.args = event.args
          break
        case "tool_call_end":
          data.toolCallId = event.toolCallId
          data.isError = event.result.isError
          data.content = event.result.isError
            ? event.result.errorMessage
            : event.result.result.content || ""
          break
        case "agent_end":
          data.status = event.state.status
          data.error = event.state.error
          data.sessionId = sessionId
          // Auto-save session
          sessionStore.saveMessages(sessionId, event.state.messages).catch(() => {})
          break
        case "query_end":
          data.queryId = event.query.id
          event.query.sessionId = sessionId
          queryStore.saveQuery(event.query).catch(() => {})
          break
      }

      stream.writeSSE({ data: JSON.stringify(data) })
    })

    try {
      await agent.prompt(prompt)
    } catch (err: any) {
      stream.writeSSE({
        data: JSON.stringify({ type: "error", message: err.message }),
      })
    }

    // extract knowledge in background
    try {
      const summary = agent.state.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-4)
        .map((m) => {
          const text = typeof m.content === "string" ? m.content : ""
          return text.slice(0, 200)
        })
        .join("\n")

      if (summary.length > 20) {
        const provider = OpenAICompatibleProvider.deepseek()
        const result = await provider.chat({
          model: { provider: "deepseek", model: "deepseek-v4-flash" },
          messages: [
            { role: "system", content: "Extract 1-3 key data facts as JSON array. Each: {\"domain\":\"...\",\"fact\":\"...\",\"keywords\":\"...\"}. Output ONLY JSON array." },
            { role: "user", content: summary },
          ],
          temperature: 0.3,
          maxTokens: 300,
        })
        const text = result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")
        const jsonMatch = text.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const entries = JSON.parse(jsonMatch[0]) as Array<{ domain: string; fact: string; keywords: string }>
          for (const e of entries) {
            if (e.fact?.length > 5) {
              await knowledgeStore.add({ domain: e.domain || "general", fact: e.fact, keywords: e.keywords, sourceSession: sessionId, createdAt: Date.now(), confidence: 0.6 })
            }
          }
        }
      }
    } catch {}
  })
})

// ─── REST Endpoints ──────────────────────────────────────────────────────────

app.get("/api/sessions", async (c) => {
  const sessions = await sessionStore.listSessions(50)
  return c.json(sessions)
})

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  const session = await sessionStore.getSession(id)
  if (!session) return c.json({ error: "not found" }, 404)
  const messages = await sessionStore.loadMessages(id)
  return c.json({ ...session, messages })
})

app.delete("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  await sessionStore.deleteSession(id)
  return c.json({ ok: true })
})

app.patch("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{ title?: string }>()
  if (body.title) {
    await sessionStore.updateTitle(id, body.title)
  }
  return c.json({ ok: true })
})

app.get("/api/files/:sessionId/:filename", async (c) => {
  const { sessionId, filename } = c.req.param()
  const filePath = `${process.env.HOME || "~"}/.datawhale/plots/${sessionId}/${filename}`
  const file = Bun.file(filePath)
  if (!(await file.exists())) return c.json({ error: "not found" }, 404)
  return new Response(file)
})

app.post("/api/upload", async (c) => {
  const formData = await c.req.formData()
  const file = formData.get("file") as File | null
  if (!file) return c.json({ error: "no file" }, 400)
  const uploadDir = `${process.env.HOME || "~"}/.datawhale/uploads`
  const fs = await import("node:fs")
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  const filePath = `${uploadDir}/${file.name}`
  await Bun.write(filePath, file)
  return c.json({ path: filePath, name: file.name, size: file.size })
})

app.get("/api/sessions/:id/export", async (c) => {
  const id = c.req.param("id")
  const session = await sessionStore.getSession(id)
  if (!session) return c.json({ error: "not found" }, 404)
  const messages = await sessionStore.loadMessages(id)
  const md = messages.map(m => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    return `**${m.role}** (${new Date(m.timestamp).toLocaleString()}):\n\n${text}\n`
  }).join("\n---\n\n")
  return c.text(`# ${session.title}\n\n${md}`, 200, { "Content-Type": "text/markdown" })
})

app.get("/api/queries", async (c) => {
  const sid = c.req.query("sessionId")
  if (!sid) return c.json({ error: "sessionId required" }, 400)
  const queries = await queryStore.loadQueries(sid)
  return c.json(queries)
})

app.get("/api/knowledge/search", async (c) => {
  const q = c.req.query("q") || ""
  const results = await knowledgeStore.search(q, 5)
  return c.json(results)
})

// ─── Config ──────────────────────────────────────────────────────────────

app.get("/api/config", async (c) => {
  const configPath = `${process.env.HOME || "~"}/.datawhale/config.json`
  try {
    const fs = await import("node:fs")
    if (fs.existsSync(configPath)) {
      return c.json(JSON.parse(fs.readFileSync(configPath, "utf-8")))
    }
  } catch {}
  return c.json({})
})

app.put("/api/config", async (c) => {
  const body = await c.req.json<Record<string, string>>()
  const configPath = `${process.env.HOME || "~"}/.datawhale/config.json`
  const fs = await import("node:fs")
  const path = await import("node:path")
  if (!fs.existsSync(path.dirname(configPath))) fs.mkdirSync(path.dirname(configPath), { recursive: true })
  // Read existing, merge, write
  let existing: Record<string, string> = {}
  try { existing = JSON.parse(fs.readFileSync(configPath, "utf-8")) } catch {}
  const merged = { ...existing, ...body }
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2))
  return c.json({ ok: true })
})

// ─── Monitoring ───────────────────────────────────────────────────────────

app.get("/api/monitoring", async (c) => {
  const traces = await traceStore.query(undefined, undefined, 500)
  // Aggregate
  const byDay: Record<string, { tokens: number; errors: number; latencyMs: number; count: number }> = {}
  const modelCounts: Record<string, number> = {}
  const toolCounts: Record<string, number> = {}

  for (const t of traces) {
    const day = new Date(t.timestamp).toISOString().slice(0, 10)
    if (!byDay[day]) byDay[day] = { tokens: 0, errors: 0, latencyMs: 0, count: 0 }
    const d = byDay[day]
    d.count++
    d.tokens += (t.inputTokens || 0) + (t.outputTokens || 0)
    if (t.latencyMs) d.latencyMs += t.latencyMs
    if (t.eventType === "error") d.errors++

    if (t.model) { modelCounts[t.model] = (modelCounts[t.model] || 0) + 1 }
    if (t.toolName) { toolCounts[t.toolName] = (toolCounts[t.toolName] || 0) + 1 }
  }

  // Sort tool counts
  const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)

  return c.json({
    daily: Object.entries(byDay).map(([day, d]) => ({
      day, tokens: d.tokens, errors: d.errors,
      avgLatency: d.count > 0 ? Math.round(d.latencyMs / d.count) : 0, count: d.count,
    })),
    modelDistribution: Object.entries(modelCounts).map(([model, count]) => ({ model, count })),
    topTools: topTools.map(([name, count]) => ({ name, count })),
    totalTokens: Object.values(byDay).reduce((s, d) => s + d.tokens, 0),
    totalErrors: Object.values(byDay).reduce((s, d) => s + d.errors, 0),
  })
})

// ─── Static Frontend ─────────────────────────────────────────────────────────

app.get("/*", serveStatic({ root: WEB_DIR }))
app.get("/*", serveStatic({ root: WEB_DIR, rewriteRequestPath: (p) => p + ".html" }))

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `用中文思考和回答。Think and respond in Chinese.

你是 DataWhale，一个 AI 原生的数据分析 Agent。
**输出规则（最高优先级）: 不要逐字换行输出。前端会自动处理换行和排版。你只需要输出连续的段落文字。**

CRITICAL OUTPUT RULES (highest priority):
- Output continuous prose. NEVER output one word per line. The UI handles text wrapping.
- Tool results may contain tables — those are NOT formatting examples for you to follow.

Your capabilities:
- Explore database schemas and understand data structures
- Write and execute SQL queries
- Analyze results and provide insights
- Run Python code for statistical analysis and visualization
- Search the web for external knowledge
- Create new tools (extensions) to expand your capabilities

Guidelines:
1. ALWAYS explore the schema first (use list_tables, describe_table, get_sample)
2. Before writing complex queries, validate your understanding with simple ones
3. Present results clearly with context and interpretation
4. Be concise but thorough — quality over quantity

For visualizations: when query results contain 1 category + 1 numeric column (≤10 categories), use execute_python to create a bar chart with matplotlib. Save as /tmp/chart.png.`

// ─── Start ───────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || "3000")
console.log(`🦈 DataWhale Server → http://localhost:${port}`)
export default { port, fetch: app.fetch }
