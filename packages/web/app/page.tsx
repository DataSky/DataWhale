"use client"

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import dynamic from "next/dynamic"

const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false })
const rehypeHighlightPromise = import("rehype-highlight").then(m => m.default)

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string; role: "user" | "assistant"; content: string
  thinking?: string; toolCalls?: ToolCallState[]; timestamp: number
}
interface ToolCallState {
  id: string; name: string; status: "running" | "done" | "error"; preview?: string
}
interface SessionMeta {
  id: string; title: string; model: string; messageCount: number; createdAt: number
}

// ─── API ─────────────────────────────────────────────────────────────────────

const API = ""
async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(`${API}${url}`, init)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}
function formatTime(ts: number) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }

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
  const [searchQuery, setSearchQuery] = useState("")
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; path: string; size: number }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState("deepseek")
  const [theme, setTheme] = useState<"dark" | "light">("dark")
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { rehypeHighlightPromise.then(setRehypeHighlight) }, [])

  const loadSessions = useCallback(async () => {
    try { setSessions(await fetchJSON("/api/sessions")) } catch {}
  }, [])
  useEffect(() => { loadSessions() }, [loadSessions])

  // Theme
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light")
  }, [theme])

  const filteredSessions = useMemo(() =>
    searchQuery ? sessions.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase())) : sessions,
    [sessions, searchQuery]
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, streamingText, streamingThinking, toolCalls])

  const selectSession = useCallback(async (id: string) => {
    setActiveSessionId(id); setMessages([])
    try {
      const data = await fetchJSON(`/api/sessions/${id}`)
      if (data.messages) setMessages(data.messages.map((m: any, i: number) => ({
        id: `msg_${i}`, role: m.role === "user" ? "user" : "assistant",
        content: typeof m.content === "string" ? m.content : "", timestamp: m.timestamp || Date.now(),
      })))
    } catch {}
  }, [])

  const deleteSession = useCallback(async (id: string) => {
    try { await fetchJSON(`/api/sessions/${id}`, { method: "DELETE" }) } catch {}
    if (activeSessionId === id) { setActiveSessionId(null); setMessages([]) }
    setMenuOpen(null); loadSessions()
  }, [activeSessionId, loadSessions])

  const exportSession = useCallback(async (id: string) => {
    const res = await fetch(`${API}/api/sessions/${id}/export`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a"); a.href = url; a.download = `session-${id.slice(0, 8)}.md`; a.click()
    URL.revokeObjectURL(url)
    setMenuOpen(null)
  }, [])

  const startRename = useCallback((id: string, title: string) => { setRenamingId(id); setRenameTitle(title); setMenuOpen(null) }, [])
  const submitRename = useCallback(async () => {
    if (!renamingId) return
    try { await fetchJSON(`/api/sessions/${renamingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: renameTitle }) }) } catch {}
    setRenamingId(null); loadSessions()
  }, [renamingId, renameTitle, loadSessions])

  const copyMessage = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000) }).catch(() => {})
  }, [])

  const regenerate = useCallback(async () => {
    const lastUserIdx = [...messages].reverse().findIndex(m => m.role === "user")
    if (lastUserIdx === -1) return
    const userMsg = messages[messages.length - 1 - lastUserIdx]
    setMessages(messages.slice(0, messages.length - 1 - lastUserIdx))
    setInput(userMsg.content)
    setTimeout(() => _send(userMsg.content), 100)
  }, [messages])

  const handleFileUpload = useCallback(async (f: File) => {
    const formData = new FormData(); formData.append("file", f)
    try {
      const res = await fetch(`${API}/api/upload`, { method: "POST", body: formData })
      const data = await res.json()
      setUploadedFiles(p => [...p.filter(x => x.name !== data.name), data])
    } catch {}
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.name.endsWith(".csv") || file.name.endsWith(".json")) handleFileUpload(file)
    }
  }, [handleFileUpload])

  const _send = useCallback(async (overrideText?: string) => {
    const text = (overrideText || input).trim()
    if (!text || streaming) return
    setInput(""); setEditingMsgId(null)
    const userMsg: Message = { id: `msg_${Date.now()}`, role: "user", content: text, timestamp: Date.now() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages); setStreaming(true); setStreamingText(""); setStreamingThinking(""); setToolCalls([])

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, sessionId: activeSessionId || undefined, model: selectedModel, files: uploadedFiles.map(f => f.path) }),
      })
      if (!res.ok || !res.body) throw new Error("Connection failed")
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      let buffer = "", thinking = "", content = ""; let calls: ToolCallState[] = []; let newSessionId = activeSessionId
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (const part of buffer.split("\n\n")) {
          buffer = (buffer.split("\n\n").pop() || "")
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue
            try { const ev = JSON.parse(line.slice(6))
              if (ev.type === "message_update") { content += ev.delta; setStreamingText(content) }
              else if (ev.type === "reasoning_update") { thinking += ev.delta; setStreamingThinking(thinking) }
              else if (ev.type === "tool_call_start") { calls = [...calls, { id: ev.toolCallId, name: ev.toolName, status: "running" }]; setToolCalls([...calls]) }
              else if (ev.type === "tool_call_end") { calls = calls.map(c => c.id === ev.toolCallId ? { ...c, status: ev.isError ? "error" as const : "done" as const, preview: ev.content } : c); setToolCalls([...calls]) }
              else if (ev.type === "agent_end") { newSessionId = ev.sessionId || newSessionId }
            } catch {}
          }
        }
      }
      setMessages([...newMessages, { id: `msg_${Date.now()}`, role: "assistant", content, thinking: thinking || undefined, toolCalls: calls.length > 0 ? calls : undefined, timestamp: Date.now() }])
      setStreamingText(""); setStreamingThinking("")
      if (newSessionId) setActiveSessionId(newSessionId)
      loadSessions()
    } catch (err: any) {
      setMessages([...newMessages, { id: `msg_${Date.now()}`, role: "assistant", content: `❌ ${err.message}`, timestamp: Date.now() }])
    } finally { setStreaming(false) }
  }, [input, streaming, messages, activeSessionId, loadSessions, uploadedFiles])

  const send = useCallback(() => _send(), [_send])
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }
  const newSession = () => { setActiveSessionId(null); setMessages([]); inputRef.current?.focus() }
  const startEdit = (msg: Message) => { setEditingMsgId(msg.id); setEditText(msg.content) }
  const submitEdit = () => {
    const text = editText.trim(); if (!text) return
    const idx = messages.findIndex(m => m.id === editingMsgId); if (idx === -1) return
    const updated = [...messages]; updated[idx] = { ...updated[idx], content: text }
    setMessages(updated.slice(0, idx + 1)); setEditingMsgId(null)
    setTimeout(() => _send(text), 100)
  }

  return (
    <div className="flex h-screen" onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={e => { e.preventDefault(); setDragOver(false) }} onDrop={handleDrop}>
      {/* ── Sidebar ──────────────────────────────────────── */}
      {sidebarOpen && (
      <aside className="w-64 bg-bg-secondary border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border space-y-2">
          <button onClick={newSession} className="w-full py-2 px-4 bg-accent text-white rounded-lg font-medium hover:bg-accent-hover transition-colors text-sm">+ New Analysis</button>
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search sessions..."
            className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent transition-colors" />
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {filteredSessions.map(s => (
            <div key={s.id} onClick={() => selectSession(s.id)}
              className={`group w-full text-left px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors relative ${
                s.id === activeSessionId ? "bg-accent-muted text-text-primary" : "text-text-secondary hover:bg-bg-hover"}`}>
              {renamingId === s.id ? (
                <input value={renameTitle} onChange={e => setRenameTitle(e.target.value)} onBlur={submitRename}
                  onKeyDown={e => e.key === "Enter" && submitRename()}
                  className="w-full bg-bg-tertiary border border-accent rounded px-1.5 py-0.5 text-xs text-text-primary outline-none" autoFocus onClick={e => e.stopPropagation()} />
              ) : (
                <>
                  <div className="truncate font-medium">{s.title || "Untitled"}</div>
                  <div className="text-xs text-text-muted mt-0.5 flex items-center justify-between">
                    <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                    <span className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity relative">
                      <button onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === s.id ? null : s.id) }} className="hover:text-text-primary">⋯</button>
                      {menuOpen === s.id && (
                        <div className="absolute right-0 top-5 bg-bg-tertiary border border-border rounded-lg shadow-lg py-1 z-50 min-w-[120px]" onClick={e => e.stopPropagation()}>
                          <button onClick={() => startRename(s.id, s.title)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover">✎ Rename</button>
                          <button onClick={() => exportSession(s.id)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover">📥 Export .md</button>
                          <button onClick={() => deleteSession(s.id)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover text-error">✕ Delete</button>
                        </div>
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
          {filteredSessions.length === 0 && <p className="text-text-muted text-sm text-center py-8">{searchQuery ? "No matches" : "No sessions"}</p>}
        </div>
        {/* Uploaded files */}
        {uploadedFiles.length > 0 && (
          <div className="border-t border-border p-3">
            <p className="text-xs text-text-muted mb-1.5 font-medium">📁 Files</p>
            {uploadedFiles.map(f => (
              <div key={f.name} className="text-xs text-text-secondary truncate py-0.5">{f.name} <span className="text-text-muted">({(f.size / 1024).toFixed(1)}KB)</span></div>
            ))}
          </div>
        )}
      </aside>
      )}

      {/* ── Main Chat ────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center px-4 shrink-0 gap-3">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-text-muted hover:text-text-secondary text-sm">☰</button>
          <h1 className="text-sm font-semibold text-text-secondary">🦈 DataWhale</h1>
          {activeSessionId && <span className="text-xs text-text-muted truncate">{sessions.find(s => s.id === activeSessionId)?.title || activeSessionId.slice(0, 12)}</span>}
          <div className="flex-1" />
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}
            className="bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-xs text-text-primary outline-none">
            <option value="deepseek">DeepSeek V4 Pro</option>
            <option value="deepseek-flash">DeepSeek V4 Flash</option>
          </select>
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} className="text-text-muted hover:text-text-secondary text-sm">{theme === "dark" ? "☀️" : "🌙"}</button>
        </header>

        {/* Drag overlay */}
        {dragOver && <div className="absolute inset-0 z-50 bg-accent/10 border-2 border-dashed border-accent rounded-xl flex items-center justify-center"><p className="text-accent text-lg font-medium">Drop CSV/JSON files here</p></div>}

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
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

          {messages.map((msg, idx) => (
            <div key={msg.id} className={`msg-enter flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] min-w-0 ${msg.role === "user" ? "bg-accent-muted text-text-primary rounded-2xl rounded-br-md px-4 py-2.5" : ""}`}>
                {editingMsgId === msg.id ? (
                  <div className="flex gap-2"><textarea value={editText} onChange={e => setEditText(e.target.value)} className="flex-1 bg-bg-tertiary border border-accent rounded px-3 py-2 text-sm text-text-primary outline-none resize-none" rows={2} autoFocus /><button onClick={submitEdit} className="px-3 py-1 bg-accent text-white rounded text-xs">Send</button><button onClick={() => setEditingMsgId(null)} className="px-3 py-1 bg-bg-tertiary text-text-secondary rounded text-xs">Cancel</button></div>
                ) : (
                  <>
                    {msg.thinking && (
                      <details className="mb-2 group" open={!!expandedThinking[msg.id]}>
                        <summary className="text-xs text-text-muted hover:text-text-secondary cursor-pointer select-none flex items-center gap-1.5" onClick={(e) => { e.preventDefault(); setExpandedThinking(p => ({ ...p, [msg.id]: !p[msg.id] })) }}>
                          <span className="text-[10px]">{expandedThinking[msg.id] ? "▾" : "▸"}</span><span>Thought for {(msg.thinking.length / 4).toFixed(0)}s</span>
                        </summary>
                        <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border leading-relaxed">{msg.thinking}</div>
                      </details>
                    )}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mb-3 space-y-1">
                        {msg.toolCalls.map(tc => (
                          <div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50">
                            <span className={tc.status === "done" ? "text-success" : tc.status === "error" ? "text-error" : "text-warning"}>{tc.status === "running" ? "⏳" : tc.status === "done" ? "✓" : "✗"}</span>
                            <span className="text-text-secondary font-medium">{tc.name}</span>
                            {tc.preview && <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.content && (
                      <div className="prose prose-sm max-w-none text-sm leading-relaxed">
                        <ReactMarkdown rehypePlugins={rehypeHighlight ? [rehypeHighlight] : []}>{msg.content}</ReactMarkdown>
                      </div>
                    )}
                    <div className={`mt-1.5 flex items-center gap-2 text-xs ${msg.role === "assistant" ? "" : "justify-end"}`}>
                      <span className="text-text-muted/60">{formatTime(msg.timestamp)}</span>
                      {msg.role === "assistant" && msg.content && (<>
                        <button onClick={() => copyMessage(msg.content, msg.id)} className="text-text-muted hover:text-text-secondary transition-colors">{copiedId === msg.id ? "✓ Copied" : "📋"}</button>
                        <button onClick={() => setFeedbacks(p => ({ ...p, [msg.id]: p[msg.id] === "up" ? undefined as any : "up" }))} className={`transition-colors ${feedbacks[msg.id] === "up" ? "text-success" : "text-text-muted hover:text-success"}`}>👍</button>
                        <button onClick={() => setFeedbacks(p => ({ ...p, [msg.id]: p[msg.id] === "down" ? undefined as any : "down" }))} className={`transition-colors ${feedbacks[msg.id] === "down" ? "text-error" : "text-text-muted hover:text-error"}`}>👎</button>
                        {idx === messages.length - 1 && <button onClick={regenerate} className="text-text-muted hover:text-text-secondary transition-colors">🔄</button>}
                      </>)}
                      {msg.role === "user" && <button onClick={() => startEdit(msg)} className="text-text-muted hover:text-text-secondary transition-colors">✏️</button>}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}

          {streaming && (
            <div className="msg-enter flex justify-start"><div className="max-w-[85%] min-w-0 space-y-2">
              {streamingThinking && (<details open className="group"><summary className="text-xs text-text-muted cursor-pointer select-none flex items-center gap-1.5"><span className="text-[10px]">▾</span><span>Thinking…</span></summary><div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border leading-relaxed">{streamingThinking}</div></details>)}
              {toolCalls.map(tc => (<div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50"><span className={tc.status === "done" ? "text-success" : "text-warning"}>{tc.status === "running" ? "⏳" : "✓"}</span><span className="text-text-secondary font-medium">{tc.name}</span>{tc.preview && <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>}</div>))}
              {streamingText && (<div className="text-sm leading-relaxed text-text-primary"><ReactMarkdown rehypePlugins={rehypeHighlight ? [rehypeHighlight] : []}>{streamingText}</ReactMarkdown><span className="typing-cursor" /></div>)}
              {!streamingText && !streamingThinking && toolCalls.length === 0 && (<div className="flex gap-1.5 py-2"><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} /></div>)}
            </div></div>
          )}
        </div>

        <div className="p-4 border-t border-border shrink-0">
          <div className="flex gap-2 max-w-3xl mx-auto">
            <input ref={fileInputRef} type="file" accept=".csv,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f) }} />
            <button onClick={() => fileInputRef.current?.click()} className="px-3 py-3 bg-bg-secondary border border-border rounded-xl text-text-muted hover:text-text-secondary hover:border-accent transition-colors shrink-0" title="Attach CSV/JSON">📎</button>
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Ask about your data..." rows={3}
              className="flex-1 bg-bg-secondary border border-border rounded-xl px-4 py-3 text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent transition-colors min-h-[44px]"
              disabled={streaming} />
            <button onClick={send} disabled={!input.trim() || streaming}
              className="px-6 py-3 bg-accent text-white rounded-xl font-medium text-sm hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0 self-end">{streaming ? "···" : "Send"}</button>
          </div>
          <p className="text-xs text-text-muted text-center mt-2">Enter to send · Shift+Enter for new line · Drag files to upload</p>
        </div>
      </main>
    </div>
  )
}
