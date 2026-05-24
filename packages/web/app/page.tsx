"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import dynamic from "next/dynamic"

const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false })

const API = ""
async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(`${API}${url}`, init)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Msg { id: string; role: "user" | "assistant"; content: string; thinking?: string; tools?: ToolCall[]; ts: number }
interface ToolCall { id: string; name: string; status: "running" | "done" | "error"; preview?: string }
interface ToolCall { id: string; name: string; status: "running" | "done" | "error"; preview?: string }

// ─── Main ────────────────────────────────────────────────────────────────────

export default function Home() {
  const [sessions, setSessions] = useState<any[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState("")
  const [streamThinking, setStreamThinking] = useState("")
  const [streamTools, setStreamTools] = useState<ToolCall[]>([])
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeIdRef = useRef<string | null>(null)

  // Keep ref in sync with state
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  const loadSessions = useCallback(async () => {
    try { setSessions(await fetchJSON("/api/sessions")) } catch {}
  }, [])
  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, streamText, streamThinking, streamTools])

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id)
    try {
      const data = await fetchJSON(`/api/sessions/${id}`)
      if (data.messages) {
        setMessages(data.messages.filter((m: any) => m.role !== "tool_result").map((m: any, i: number) => ({
          id: `m${i}`, role: m.role === "user" ? "user" : "assistant",
          content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text || "").join("\n") : "",
          ts: m.timestamp || 0,
        })))
      }
    } catch {}
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput("")
    const userMsg: Msg = { id: `m${Date.now()}`, role: "user", content: text, ts: Date.now() }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setStreaming(true)
    setStreamText("")
    setStreamThinking("")
    setStreamTools([])

    try {
      const res = await fetch(`${API}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, sessionId: activeIdRef.current || undefined }) })
      if (!res.ok || !res.body) throw new Error("Connection failed")
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      let buffer = "", thinking = "", content = ""; let tools: ToolCall[] = []; let newSid = activeId

      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n\n"); buffer = parts.pop() || ""
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue
            try {
              const ev = JSON.parse(line.slice(6))
              if (ev.type === "message_update") { content += ev.delta; setStreamText(content) }
              else if (ev.type === "reasoning_update") { thinking += ev.delta; setStreamThinking(thinking) }
              else if (ev.type === "tool_call_start") { tools = [...tools, { id: ev.toolCallId, name: ev.toolName, status: "running" }]; setStreamTools([...tools]) }
              else if (ev.type === "tool_call_end") { tools = tools.map(t => t.id === ev.toolCallId ? { ...t, status: ev.isError ? "error" as const : "done" as const, preview: ev.content } : t); setStreamTools([...tools]) }
              else if (ev.type === "agent_end" && ev.sessionId) newSid = ev.sessionId
            } catch {}
          }
        }
      }

      // Atomic update — no intermediate blank state
      const finalMsg: Msg = { id: `m${Date.now()}`, role: "assistant", content, thinking: thinking || undefined, tools: tools.length > 0 ? tools : undefined, ts: Date.now() }
      setMessages([...newMsgs, finalMsg])
      setStreamText(""); setStreamThinking(""); setStreamTools([]); setStreaming(false)
      if (newSid) setActiveId(newSid)
      loadSessions()
    } catch (err: any) {
      setMessages([...newMsgs, { id: `m${Date.now()}`, role: "assistant", content: "Error: " + err.message, ts: Date.now() }])
      setStreaming(false)
    }
  }, [input, streaming, messages, loadSessions])

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }
  const newSession = () => { setActiveId(null); setMessages([]); inputRef.current?.focus() }

  return (
    <div className="flex h-screen bg-bg-primary text-text-primary" style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* Sidebar */}
      <aside className="w-60 bg-bg-secondary border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border">
          <button onClick={newSession} className="w-full py-2 px-4 bg-accent text-white rounded-lg font-medium text-sm hover:bg-accent-hover transition-colors">+ New</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessions.map(s => (
            <div key={s.id} onClick={() => selectSession(s.id)}
              className={`px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${s.id === activeId ? "bg-accent-muted text-text-primary" : "text-text-secondary hover:bg-bg-hover"}`}>
              <div className="truncate font-medium">{s.title || "Untitled"}</div>
              <div className="text-xs text-text-muted mt-0.5">{new Date(s.createdAt).toLocaleDateString()}</div>
            </div>
          ))}
          {sessions.length === 0 && <p className="text-text-muted text-sm text-center py-8">No sessions</p>}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center px-4">
          <h1 className="text-sm font-semibold text-text-secondary">🦈 DataWhale</h1>
        </header>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {messages.length === 0 && !streaming && (
            <div className="flex items-center justify-center h-full"><div className="text-center"><div className="text-4xl mb-4">🦈</div><p className="text-text-secondary text-sm">Ask questions about your data.</p></div></div>
          )}

          {/* Messages */}
          {messages.map(msg => (
            <div key={msg.id} className={`msg-enter flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] min-w-0 ${msg.role === "user" ? "bg-accent-muted text-white rounded-2xl rounded-br-md px-4 py-2.5" : ""}`}>
                {/* Thinking (collapsed) */}
                {msg.thinking && (
                  <details className="mb-2" open={!!expandedThinking[msg.id]}>
                    <summary className="text-xs text-text-muted hover:text-text-secondary cursor-pointer select-none flex items-center gap-1.5" onClick={e => { e.preventDefault(); setExpandedThinking(p => ({ ...p, [msg.id]: !p[msg.id] })) }}>
                      <span className="text-[10px]">{expandedThinking[msg.id] ? "▾" : "▸"}</span>
                      <span>Thought for {(msg.thinking.length / 4).toFixed(0)}s</span>
                    </summary>
                    <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border leading-relaxed">{msg.thinking}</div>
                  </details>
                )}
                {/* Tool calls (inline) */}
                {msg.tools && msg.tools.length > 0 && (
                  <div className="mb-3 space-y-1">
                    {msg.tools.map(tc => (
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
                {/* Content */}
                {msg.content && (
                  <div className="text-sm leading-relaxed">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Streaming block */}
          {streaming && (
            <div className="msg-enter flex justify-start">
              <div className="max-w-[85%] min-w-0 space-y-2">
                {/* Live thinking */}
                {streamThinking && (
                  <details open>
                    <summary className="text-xs text-text-muted cursor-pointer select-none flex items-center gap-1.5"><span className="text-[10px]">▾</span><span>Thinking…</span></summary>
                    <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border leading-relaxed">{streamThinking}</div>
                  </details>
                )}
                {/* Live tool calls */}
                {streamTools.map(tc => (
                  <div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50">
                    <span className={tc.status === "done" ? "text-success" : "text-warning"}>{tc.status === "running" ? "⏳" : "✓"}</span>
                    <span className="text-text-secondary font-medium">{tc.name}</span>
                    {tc.preview && <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>}
                  </div>
                ))}
                {/* Live text */}
                {streamText && (
                  <div className="text-sm leading-relaxed text-text-primary">
                    <ReactMarkdown>{streamText}</ReactMarkdown><span className="typing-cursor" />
                  </div>
                )}
                {!streamText && !streamThinking && streamTools.length === 0 && (
                  <div className="flex gap-1.5 py-2"><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} /></div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border">
          <div className="flex gap-2 max-w-3xl mx-auto">
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Ask about your data..." rows={3}
              className="flex-1 bg-bg-secondary border border-border rounded-xl px-4 py-3 text-sm placeholder:text-text-muted resize-none outline-none focus:border-accent transition-colors min-h-[44px]"
              disabled={streaming} />
            <button onClick={send} disabled={!input.trim() || streaming}
              className="px-6 py-3 bg-accent text-white rounded-xl font-medium text-sm hover:bg-accent-hover disabled:opacity-40 transition-all shrink-0 self-end">
              {streaming ? "…" : "Send"}
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
