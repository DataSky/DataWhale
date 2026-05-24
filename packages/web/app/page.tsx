"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import dynamic from "next/dynamic"

const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false })
const rehypeHighlightPromise = import("rehype-highlight").then(m => m.default)

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

// ─── API ─────────────────────────────────────────────────────────────────────

const API = ""

async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(`${API}${url}`, init)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [rehypeHighlight, setRehypeHighlight] = useState<any>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [feedbacks, setFeedbacks] = useState<Record<string, "up" | "down">>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load rehype-highlight on client
  useEffect(() => { rehypeHighlightPromise.then(setRehypeHighlight) }, [])

  // Load sessions
  const loadSessions = useCallback(async () => {
    try { setSessions(await fetchJSON("/api/sessions")) } catch {}
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, streamingText, streamingThinking, toolCalls])

  // Select session
  const selectSession = useCallback(async (id: string) => {
    setActiveSessionId(id)
    setMessages([])
    try {
      const data = await fetchJSON(`/api/sessions/${id}`)
      if (data.messages) {
        setMessages(data.messages.map((m: any, i: number) => ({
          id: `msg_${i}`,
          role: m.role === "user" ? "user" : "assistant",
          content: typeof m.content === "string" ? m.content : "",
          timestamp: m.timestamp || Date.now(),
        })))
      }
    } catch {}
  }, [])

  // Delete session
  const deleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try { await fetchJSON(`/api/sessions/${id}`, { method: "DELETE" }) } catch {}
    if (activeSessionId === id) { setActiveSessionId(null); setMessages([]) }
    loadSessions()
  }, [activeSessionId, loadSessions])

  // Rename
  const startRename = useCallback((id: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation(); setRenamingId(id); setRenameTitle(title)
  }, [])
  const submitRename = useCallback(async () => {
    if (!renamingId) return
    try { await fetchJSON(`/api/sessions/${renamingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: renameTitle }) }) } catch {}
    setRenamingId(null); loadSessions()
  }, [renamingId, renameTitle, loadSessions])

  // Copy
  const copyMessage = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    }).catch(() => {})
  }, [])

  // Regenerate
  const regenerate = useCallback(async () => {
    const lastUserIdx = [...messages].reverse().findIndex(m => m.role === "user")
    if (lastUserIdx === -1) return
    const userMsg = messages[messages.length - 1 - lastUserIdx]
    const msgs = messages.slice(0, messages.length - 1 - lastUserIdx)
    setMessages(msgs)
    setInput(userMsg.content)
    setTimeout(() => send(userMsg.content), 100)
  }, [messages])

  // Send
  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText || input).trim()
    if (!text || streaming) return
    setInput("")
    setEditingMsgId(null)

    const userMsg: Message = { id: `msg_${Date.now()}`, role: "user", content: text, timestamp: Date.now() }
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
      let buffer = "", thinking = "", content = ""
      let calls: ToolCallState[] = []
      let newSessionId = activeSessionId

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n\n")
        buffer = parts.pop() || ""
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue
            try {
              const ev = JSON.parse(line.slice(6))
              switch (ev.type) {
                case "message_update":
                  content += ev.delta; setStreamingText(content); break
                case "reasoning_update":
                  thinking += ev.delta; setStreamingThinking(thinking); break
                case "tool_call_start":
                  calls = [...calls, { id: ev.toolCallId, name: ev.toolName, status: "running" }]; setToolCalls([...calls]); break
                case "tool_call_end":
                  calls = calls.map(c => c.id === ev.toolCallId ? { ...c, status: ev.isError ? "error" as const : "done" as const, preview: ev.content } : c); setToolCalls([...calls]); break
                case "agent_end":
                  newSessionId = ev.sessionId || newSessionId; break
              }
            } catch {}
          }
        }
      }

      setMessages([...newMessages, {
        id: `msg_${Date.now()}`, role: "assistant", content,
        thinking: thinking || undefined,
        toolCalls: calls.length > 0 ? calls : undefined,
        timestamp: Date.now(),
      }])
      setStreamingText(""); setStreamingThinking("")
      if (newSessionId) setActiveSessionId(newSessionId)
      loadSessions()
    } catch (err: any) {
      setMessages([...newMessages, { id: `msg_${Date.now()}`, role: "assistant", content: `❌ ${err.message}`, timestamp: Date.now() }])
    } finally {
      setStreaming(false)
    }
  }, [input, streaming, messages, activeSessionId, loadSessions])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() }
  }

  const newSession = () => { setActiveSessionId(null); setMessages([]); inputRef.current?.focus() }

  // Edit message
  const startEdit = (msg: Message) => {
    setEditingMsgId(msg.id)
    setEditText(msg.content)
  }
  const submitEdit = () => {
    const text = editText.trim()
    if (!text) return
    const idx = messages.findIndex(m => m.id === editingMsgId)
    if (idx === -1) return
    const updated = [...messages]
    updated[idx] = { ...updated[idx], content: text }
    // Remove all messages after the edited one and resend
    setMessages(updated.slice(0, idx + 1))
    setEditingMsgId(null)
    setTimeout(() => send(text), 100)
  }

  return (
    <div className="flex h-screen">
      {/* ── Sidebar ──────────────────────────────────────── */}
      <aside className="w-64 bg-bg-secondary border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border">
          <button onClick={newSession} className="w-full py-2 px-4 bg-accent text-white rounded-lg font-medium hover:bg-accent-hover transition-colors text-sm">
            + New Analysis
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessions.map(s => (
            <div key={s.id}
              onClick={() => selectSession(s.id)}
              className={`group w-full text-left px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${
                s.id === activeSessionId ? "bg-accent-muted text-text-primary" : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              {renamingId === s.id ? (
                <input value={renameTitle} onChange={e => setRenameTitle(e.target.value)} onBlur={submitRename}
                  onKeyDown={e => e.key === "Enter" && submitRename()}
                  className="w-full bg-bg-tertiary border border-accent rounded px-1.5 py-0.5 text-xs text-text-primary outline-none"
                  autoFocus onClick={e => e.stopPropagation()} />
              ) : (
                <>
                  <div className="truncate font-medium">{s.title || "Untitled"}</div>
                  <div className="text-xs text-text-muted mt-0.5 flex items-center justify-between">
                    <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                    <span className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
                      <button onClick={(e) => startRename(s.id, s.title, e)} title="Rename" className="hover:text-text-primary">✎</button>
                      <button onClick={(e) => deleteSession(s.id, e)} title="Delete" className="hover:text-error">✕</button>
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
          {sessions.length === 0 && <p className="text-text-muted text-sm text-center py-8">No sessions</p>}
        </div>
      </aside>

      {/* ── Main Chat ────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center px-4 shrink-0 gap-3">
          <h1 className="text-sm font-semibold text-text-secondary">🦈 DataWhale</h1>
          {activeSessionId && (
            <span className="text-xs text-text-muted truncate">
              {sessions.find(s => s.id === activeSessionId)?.title || activeSessionId.slice(0, 12)}
            </span>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {/* Welcome */}
          {messages.length === 0 && !streaming && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <div className="text-4xl mb-4">🦈</div>
                <h2 className="text-xl font-semibold mb-2 text-text-primary">DataWhale</h2>
                <p className="text-text-secondary text-sm">Ask questions about your data. Load CSV/JSON files, run SQL queries, create charts, and discover insights.</p>
                <div className="mt-6 flex flex-wrap gap-2 justify-center">
                  {["Analyze sales by region", "Find trends over time", "Check data quality", "Create a bar chart"].map(s => (
                    <button key={s} onClick={() => { setInput(s); inputRef.current?.focus() }} className="px-3 py-1.5 text-xs rounded-full bg-bg-tertiary text-text-secondary hover:bg-bg-hover transition-colors">{s}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, idx) => (
            <div key={msg.id} className={`msg-enter flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] min-w-0 ${msg.role === "user" ? "bg-accent-muted text-text-primary rounded-2xl rounded-br-md px-4 py-2.5" : ""}`}>
                
                {/* ── Edit mode ── */}
                {editingMsgId === msg.id ? (
                  <div className="flex gap-2">
                    <textarea value={editText} onChange={e => setEditText(e.target.value)}
                      className="flex-1 bg-bg-tertiary border border-accent rounded px-3 py-2 text-sm text-text-primary outline-none resize-none" rows={2} autoFocus />
                    <button onClick={submitEdit} className="px-3 py-1 bg-accent text-white rounded text-xs">Send</button>
                    <button onClick={() => setEditingMsgId(null)} className="px-3 py-1 bg-bg-tertiary text-text-secondary rounded text-xs">Cancel</button>
                  </div>
                ) : (
                  <>
                    {/* ── Thinking ── */}
                    {msg.thinking && (
                      <details className="mb-2 group" open={!!expandedThinking[msg.id]}>
                        <summary className="text-xs text-text-muted hover:text-text-secondary cursor-pointer select-none flex items-center gap-1.5" onClick={(e) => {
                          e.preventDefault()
                          setExpandedThinking(p => ({ ...p, [msg.id]: !p[msg.id] }))
                        }}>
                          <span className="text-[10px]">{expandedThinking[msg.id] ? "▾" : "▸"}</span>
                          <span>Thought for {(msg.thinking.length / 4).toFixed(0)}s</span>
                        </summary>
                        <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border leading-relaxed">
                          {msg.thinking}
                        </div>
                      </details>
                    )}

                    {/* ── Tool calls ── */}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mb-3 space-y-1">
                        {msg.toolCalls.map(tc => (
                          <div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50">
                            <span className={tc.status === "done" ? "text-success" : tc.status === "error" ? "text-error" : "text-warning"}>
                              {tc.status === "running" ? "⏳" : tc.status === "done" ? "✓" : "✗"}
                            </span>
                            <span className="text-text-secondary font-medium">{tc.name}</span>
                            {tc.preview && <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* ── Content ── */}
                    {msg.content && (
                      <div className="prose prose-sm max-w-none text-sm leading-relaxed">
                        <ReactMarkdown rehypePlugins={rehypeHighlight ? [rehypeHighlight] : []}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}

                    {/* ── Action bar ── */}
                    <div className={`mt-1.5 flex items-center gap-2 text-xs ${msg.role === "assistant" ? "" : "justify-end"}`}>
                      <span className="text-text-muted/60">{formatTime(msg.timestamp)}</span>
                      {msg.role === "assistant" && msg.content && (
                        <>
                          <button onClick={() => copyMessage(msg.content, msg.id)}
                            className="text-text-muted hover:text-text-secondary transition-colors">
                            {copiedId === msg.id ? "✓ Copied" : "📋"}
                          </button>
                          <button onClick={() => setFeedbacks(p => ({ ...p, [msg.id]: p[msg.id] === "up" ? undefined as any : "up" }))}
                            className={`transition-colors ${feedbacks[msg.id] === "up" ? "text-success" : "text-text-muted hover:text-success"}`}>👍</button>
                          <button onClick={() => setFeedbacks(p => ({ ...p, [msg.id]: p[msg.id] === "down" ? undefined as any : "down" }))}
                            className={`transition-colors ${feedbacks[msg.id] === "down" ? "text-error" : "text-text-muted hover:text-error"}`}>👎</button>
                          {idx === messages.length - 1 && (
                            <button onClick={regenerate} className="text-text-muted hover:text-text-secondary transition-colors">🔄</button>
                          )}
                        </>
                      )}
                      {msg.role === "user" && (
                        <button onClick={() => startEdit(msg)} className="text-text-muted hover:text-text-secondary transition-colors">✏️</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}

          {/* ── Streaming block ── */}
          {streaming && (
            <div className="msg-enter flex justify-start">
              <div className="max-w-[85%] min-w-0 space-y-2">
                {streamingThinking && (
                  <details open className="group">
                    <summary className="text-xs text-text-muted cursor-pointer select-none flex items-center gap-1.5">
                      <span className="text-[10px]">▾</span><span>Thinking…</span>
                    </summary>
                    <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border leading-relaxed">
                      {streamingThinking}
                    </div>
                  </details>
                )}
                {toolCalls.map(tc => (
                  <div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50">
                    <span className={tc.status === "done" ? "text-success" : "text-warning"}>
                      {tc.status === "running" ? "⏳" : "✓"}
                    </span>
                    <span className="text-text-secondary font-medium">{tc.name}</span>
                    {tc.preview && <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>}
                  </div>
                ))}
                {streamingText && (
                  <div className="text-sm leading-relaxed text-text-primary">
                    <ReactMarkdown rehypePlugins={rehypeHighlight ? [rehypeHighlight] : []}>
                      {streamingText}
                    </ReactMarkdown>
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

        {/* ── Input ── */}
        <div className="p-4 border-t border-border shrink-0">
          <div className="flex gap-2 max-w-3xl mx-auto">
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} placeholder="Ask about your data..." rows={3}
              className="flex-1 bg-bg-secondary border border-border rounded-xl px-4 py-3 text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent transition-colors min-h-[44px]"
              disabled={streaming} />
            <button onClick={() => send()} disabled={!input.trim() || streaming}
              className="px-6 py-3 bg-accent text-white rounded-xl font-medium text-sm hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0 self-end">
              {streaming ? "···" : "Send"}
            </button>
          </div>
          <p className="text-xs text-text-muted text-center mt-2">Enter to send · Shift+Enter for new line</p>
        </div>
      </main>
    </div>
  )
}
