"use client"

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import dynamic from "next/dynamic"

const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false })

const API = ""
async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(`${API}${url}`, init)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export default function Home() {
  const [sessions, setSessions] = useState<any[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const loadSessions = useCallback(async () => {
    try { setSessions(await fetchJSON("/api/sessions")) } catch {}
  }, [])
  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, streamText])

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id)
    try {
      const data = await fetchJSON(`/api/sessions/${id}`)
      if (data.messages) {
        setMessages(data.messages.filter((m: any) => m.role !== "tool_result").map((m: any, i: number) => ({
          id: `m${i}`, role: m.role === "user" ? "user" : "assistant",
          content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text || "").join("\n") : "",
          timestamp: m.timestamp || 0,
        })))
      }
    } catch {}
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput("")
    const userMsg = { id: `m${Date.now()}`, role: "user", content: text, timestamp: Date.now() }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setStreaming(true)
    setStreamText("")

    try {
      const res = await fetch(`${API}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, sessionId: activeId || undefined }) })
      if (!res.ok || !res.body) throw new Error("Connection failed")
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      let buffer = "", content = "", newSid = activeId
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n\n"); buffer = parts.pop() || ""
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue
            try { const ev = JSON.parse(line.slice(6)); if (ev.type === "message_update") { content += ev.delta; setStreamText(content) } else if (ev.type === "agent_end" && ev.sessionId) newSid = ev.sessionId } catch {}
          }
        }
      }
      setMessages([...newMsgs, { id: `m${Date.now()}`, role: "assistant", content, timestamp: Date.now() }])
      setStreamText(""); if (newSid) setActiveId(newSid); loadSessions()
    } catch (err: any) { setMessages([...newMsgs, { id: `m${Date.now()}`, role: "assistant", content: "Error: " + err.message, timestamp: Date.now() }]) }
    finally { setStreaming(false) }
  }, [input, streaming, messages, activeId, loadSessions])

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }
  const newSession = () => { setActiveId(null); setMessages([]); inputRef.current?.focus() }

  return (
    <div className="flex h-screen bg-bg-primary text-text-primary" style={{ fontFamily: "system-ui, sans-serif" }}>
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
          {messages.map(msg => (
            <div key={msg.id} className={`msg-enter flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${msg.role === "user" ? "bg-accent-muted text-white rounded-br-md" : "text-text-primary"}`}>
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            </div>
          ))}
          {streaming && streamText && (
            <div className="flex justify-start"><div className="max-w-[85%] text-sm leading-relaxed text-text-primary"><ReactMarkdown>{streamText}</ReactMarkdown><span className="typing-cursor" /></div></div>
          )}
          {streaming && !streamText && <div className="flex justify-start"><span className="text-accent text-sm">Thinking…</span></div>}
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
