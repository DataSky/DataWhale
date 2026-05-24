"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import ReactMarkdown from "react-markdown"

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  thinking?: string
  toolCalls?: ToolCallState[]
  timestamp: number
}

interface ToolCallState {
  id: string
  name: string
  status: "running" | "done" | "error"
  preview?: string
}

interface SessionMeta {
  id: string
  title: string
  model: string
  messageCount: number
  createdAt: number
}

// ─── API helpers ─────────────────────────────────────────────────────────────

const API = process.env.NODE_ENV === "development" ? "http://localhost:3000" : ""

async function loadSessions(): Promise<SessionMeta[]> {
  const res = await fetch(`${API}/api/sessions`)
  return res.json()
}

async function loadSession(id: string): Promise<{ messages: any[] }> {
  const res = await fetch(`${API}/api/sessions/${id}`)
  return res.json()
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function Home() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState("")
  const [streamingThinking, setStreamingThinking] = useState("")
  const [showThinking, setShowThinking] = useState<Record<string, boolean>>({})
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load sessions on mount
  useEffect(() => {
    loadSessions().then(setSessions).catch(console.error)
  }, [])

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, streamingText, streamingThinking])

  // Load session messages
  const selectSession = useCallback(async (id: string) => {
    setActiveSessionId(id)
    setMessages([])
    setStreamingText("")
    setStreamingThinking("")
    try {
      const data = await loadSession(id)
      if (data.messages) {
        const msgs: Message[] = data.messages.map((m: any, i: number) => ({
          id: `msg_${i}`,
          role: m.role === "user" ? "user" : "assistant",
          content: typeof m.content === "string" ? m.content : "",
          timestamp: m.timestamp || Date.now(),
        }))
        setMessages(msgs)
      }
    } catch {}
  }, [])

  // Send message
  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput("")

    const userMsg: Message = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setStreaming(true)
    setStreamingText("")
    setStreamingThinking("")
    setToolCalls([])

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, sessionId: activeSessionId || undefined }),
      })

      if (!res.ok || !res.body) throw new Error("Connection failed")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let thinking = ""
      let content = ""
      let newCalls: ToolCallState[] = []
      let sessionIdFromServer = activeSessionId

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events
        const parts = buffer.split("\n\n")
        buffer = parts.pop() || ""

        for (const part of parts) {
          const lines = part.split("\n")
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            try {
              const event = JSON.parse(line.slice(6))
              switch (event.type) {
                case "message_update":
                  content += event.delta
                  setStreamingText(content)
                  break
                case "reasoning_update":
                  thinking += event.delta
                  setStreamingThinking(thinking)
                  break
                case "tool_call_start":
                  newCalls = [...newCalls, { id: event.toolCallId, name: event.toolName, status: "running" }]
                  setToolCalls([...newCalls])
                  break
                case "tool_call_end":
                  newCalls = newCalls.map((tc) =>
                    tc.id === event.toolCallId
                      ? { ...tc, status: event.isError ? "error" as const : "done" as const, preview: event.content }
                      : tc
                  )
                  setToolCalls([...newCalls])
                  break
                case "agent_end":
                  // Finalize
                  if (!activeSessionId && event.sessionId) {
                    sessionIdFromServer = event.sessionId
                  }
                  break
              }
            } catch {}
          }
        }
      }

      // Add assistant message to list
      const assistantMsg: Message = {
        id: `msg_${Date.now()}`,
        role: "assistant",
        content,
        thinking: thinking || undefined,
        toolCalls: newCalls.length > 0 ? newCalls : undefined,
        timestamp: Date.now(),
      }
      const finalMessages = [...newMessages, assistantMsg]
      setMessages(finalMessages)
      setStreamingText("")
      setStreamingThinking("")

      // Update session list
      if (sessionIdFromServer) {
        setActiveSessionId(sessionIdFromServer)
      }
      loadSessions().then(setSessions).catch(() => {})

    } catch (err: any) {
      const errorMsg: Message = {
        id: `msg_${Date.now()}`,
        role: "assistant",
        content: `❌ Error: ${err.message}`,
        timestamp: Date.now(),
      }
      setMessages([...newMessages, errorMsg])
    } finally {
      setStreaming(false)
    }
  }, [input, streaming, messages, activeSessionId])

  // Keyboard shortcut
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // New session
  const newSession = () => {
    setActiveSessionId(null)
    setMessages([])
    setStreamingText("")
    setStreamingThinking("")
    inputRef.current?.focus()
  }

  return (
    <div className="flex h-screen">
      {/* ── Sidebar ──────────────────────────────────────────── */}
      <aside className="w-64 bg-bg-secondary border-r border-border flex flex-col shrink-0">
        <div className="p-4 border-b border-border">
          <button
            onClick={newSession}
            className="w-full py-2 px-4 bg-accent text-white rounded-lg font-medium hover:bg-accent-hover transition-colors text-sm"
          >
            + New Analysis
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => selectSession(s.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                s.id === activeSessionId
                  ? "bg-accent-muted text-text-primary"
                  : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <div className="truncate font-medium">{s.title || "Untitled"}</div>
              <div className="text-xs text-text-muted mt-0.5">
                {new Date(s.createdAt).toLocaleDateString()} · {s.messageCount} msgs
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="text-text-muted text-sm text-center py-8">No sessions yet</p>
          )}
        </div>
      </aside>

      {/* ── Main Chat ────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 border-b border-border flex items-center px-4 shrink-0">
          <h1 className="text-sm font-semibold text-text-secondary">🦈 DataWhale</h1>
          {activeSessionId && (
            <span className="ml-3 text-xs text-text-muted truncate">
              {sessions.find((s) => s.id === activeSessionId)?.title || activeSessionId.slice(0, 12)}
            </span>
          )}
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {messages.length === 0 && !streaming && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <div className="text-4xl mb-4">🦈</div>
                <h2 className="text-xl font-semibold mb-2 text-text-primary">DataWhale</h2>
                <p className="text-text-secondary text-sm">
                  Ask questions about your data. Load CSV/JSON files, run SQL queries, create charts, 
                  and discover insights — all through natural conversation.
                </p>
                <div className="mt-6 flex flex-wrap gap-2 justify-center">
                  {["Analyze sales by region", "Find trends over time", "Check data quality", "Create a bar chart"].map((s) => (
                    <button
                      key={s}
                      onClick={() => { setInput(s); inputRef.current?.focus() }}
                      className="px-3 py-1.5 text-xs rounded-full bg-bg-tertiary text-text-secondary hover:bg-bg-hover transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`msg-enter flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] ${
                msg.role === "user"
                  ? "bg-accent-muted text-text-primary rounded-2xl rounded-br-md px-4 py-2.5"
                  : "text-text-primary"
              }`}>
                {/* Thinking block */}
                {msg.thinking && (
                  <div className="mb-2">
                    <button
                      onClick={() => setShowThinking((p) => ({ ...p, [msg.id]: !p[msg.id] }))}
                      className="text-xs text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
                    >
                      <span>{showThinking[msg.id] ? "▾" : "▸"}</span>
                      Thought for {Math.round(msg.thinking.length / 4)} sec
                    </button>
                    {showThinking[msg.id] && (
                      <div className="mt-1 p-2 rounded bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-40 overflow-y-auto border border-border">
                        {msg.thinking}
                      </div>
                    )}
                  </div>
                )}

                {/* Tool calls */}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="mb-3 space-y-1">
                    {msg.toolCalls.map((tc) => (
                      <div key={tc.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-bg-secondary border border-border">
                        <span className={
                          tc.status === "done" ? "text-success" :
                          tc.status === "error" ? "text-error" : "text-warning"
                        }>
                          {tc.status === "running" ? "⏳" : tc.status === "done" ? "✓" : "✗"}
                        </span>
                        <span className="text-text-secondary font-medium">{tc.name}</span>
                        {tc.preview && (
                          <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Content */}
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          ))}

          {/* Streaming message */}
          {streaming && (
            <div className="msg-enter flex justify-start">
              <div className="max-w-[85%]">
                {/* Tool calls in progress */}
                {toolCalls.length > 0 && (
                  <div className="mb-3 space-y-1">
                    {toolCalls.map((tc) => (
                      <div key={tc.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-bg-secondary border border-border">
                        <span className={tc.status === "done" ? "text-success" : "text-warning"}>
                          {tc.status === "running" ? "⏳" : "✓"}
                        </span>
                        <span className="text-text-secondary font-medium">{tc.name}</span>
                        {tc.preview && (
                          <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Streaming thinking */}
                {streamingThinking && (
                  <div className="mb-2 text-xs text-text-muted whitespace-pre-wrap opacity-70 max-h-24 overflow-y-auto">
                    {streamingThinking}
                  </div>
                )}

                {/* Streaming text */}
                {streamingText && (
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown>{streamingText}</ReactMarkdown>
                    <span className="typing-cursor" />
                  </div>
                )}
                {!streamingText && !streamingThinking && toolCalls.length === 0 && (
                  <div className="flex gap-1.5 py-2">
                    <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="p-4 border-t border-border shrink-0">
          <div className="flex gap-2 max-w-3xl mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your data..."
              rows={1}
              className="flex-1 bg-bg-secondary border border-border rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent transition-colors"
              disabled={streaming}
            />
            <button
              onClick={send}
              disabled={!input.trim() || streaming}
              className="px-5 py-2.5 bg-accent text-white rounded-xl font-medium text-sm hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0"
            >
              {streaming ? "···" : "Send"}
            </button>
          </div>
          <p className="text-xs text-text-muted text-center mt-2">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </main>
    </div>
  )
}
