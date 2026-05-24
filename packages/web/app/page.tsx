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

interface Msg { id: string; role: "user" | "assistant"; content: string; thinking?: string; tools?: ToolCall[]; ts: number }
interface ToolCall { id: string; name: string; status: "running" | "done" | "error"; preview?: string }

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
  const [searchQuery, setSearchQuery] = useState("")
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; path: string; size: number }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [selectedModel, setSelectedModel] = useState("deepseek")
  const [theme, setTheme] = useState<"dark" | "light">("dark")
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  // Theme
  useEffect(() => { document.documentElement.classList.toggle("light", theme === "light") }, [theme])

  const loadSessions = useCallback(async () => { try { setSessions(await fetchJSON("/api/sessions")) } catch {} }, [])
  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }) }, [messages, streamText, streamThinking, streamTools])

  const filteredSessions = useMemo(() =>
    searchQuery ? sessions.filter((s: any) => s.title?.toLowerCase().includes(searchQuery.toLowerCase())) : sessions,
    [sessions, searchQuery]
  )

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id)
    try {
      const data = await fetchJSON(`/api/sessions/${id}`)
      if (data.messages) setMessages(data.messages.filter((m: any) => m.role !== "tool_result").map((m: any, i: number) => ({
        id: `m${i}`, role: m.role === "user" ? "user" : "assistant",
        content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text || "").join("\n") : "",
        ts: m.timestamp || 0,
      })))
    } catch {}
  }, [])

  const deleteSession = useCallback(async (id: string) => {
    try { await fetchJSON(`/api/sessions/${id}`, { method: "DELETE" }) } catch {}
    if (activeId === id) { setActiveId(null); setMessages([]) }
    setMenuOpen(null); loadSessions()
  }, [activeId, loadSessions])

  const exportSession = useCallback(async (id: string) => {
    const res = await fetch(`${API}/api/sessions/${id}/export`); const blob = await res.blob()
    const url = URL.createObjectURL(blob); const a = document.createElement("a")
    a.href = url; a.download = `session-${id.slice(0, 8)}.md`; a.click(); URL.revokeObjectURL(url)
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

  const regenerate = useCallback(() => {
    const idx = [...messages].reverse().findIndex(m => m.role === "user")
    if (idx === -1) return
    const um = messages[messages.length - 1 - idx]
    setMessages(messages.slice(0, messages.length - 1 - idx))
    setInput(um.content); setTimeout(() => _send(um.content), 100)
  }, [messages])

  const handleFileUpload = useCallback(async (f: File) => {
    const fd = new FormData(); fd.append("file", f)
    try { const data = await (await fetch(`${API}/api/upload`, { method: "POST", body: fd })).json(); setUploadedFiles(p => [...p.filter(x => x.name !== data.name), data]) } catch {}
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    for (const f of Array.from(e.dataTransfer.files)) { if (f.name.endsWith(".csv") || f.name.endsWith(".json")) handleFileUpload(f) }
  }, [handleFileUpload])

  const _send = useCallback(async (overrideText?: string) => {
    const text = (overrideText || input).trim(); if (!text || streaming) return
    setInput(""); setEditingMsgId(null)
    const userMsg: Msg = { id: `m${Date.now()}`, role: "user", content: text, ts: Date.now() }
    const newMsgs = [...messages, userMsg]; setMessages(newMsgs)
    setStreaming(true); setStreamText(""); setStreamThinking(""); setStreamTools([])

    try {
      const res = await fetch(`${API}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, sessionId: activeIdRef.current || undefined, model: selectedModel, files: uploadedFiles.map(f => f.path) }) })
      if (!res.ok || !res.body) throw new Error("Connection failed")
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      let buffer = "", thinking = "", content = ""; let tools: ToolCall[] = []; let newSid = activeIdRef.current
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true }); const parts = buffer.split("\n\n"); buffer = parts.pop() || ""
        for (const part of parts) for (const line of part.split("\n")) {
          if (!line.startsWith("data: ")) continue
          try { const ev = JSON.parse(line.slice(6))
            if (ev.type === "message_update") { content += ev.delta; setStreamText(content) }
            else if (ev.type === "reasoning_update") { thinking += ev.delta; setStreamThinking(thinking) }
            else if (ev.type === "tool_call_start") { tools = [...tools, { id: ev.toolCallId, name: ev.toolName, status: "running" }]; setStreamTools([...tools]) }
            else if (ev.type === "tool_call_end") { tools = tools.map(t => t.id === ev.toolCallId ? { ...t, status: ev.isError ? "error" as const : "done" as const, preview: ev.content } : t); setStreamTools([...tools]) }
            else if (ev.type === "agent_end") { if (ev.sessionId) newSid = ev.sessionId }
          } catch {}
        }
      }
      setMessages([...newMsgs, { id: `m${Date.now()}`, role: "assistant", content, thinking: thinking || undefined, tools: tools.length > 0 ? tools : undefined, ts: Date.now() }])
      setStreamText(""); setStreamThinking(""); setStreamTools([]); setStreaming(false)
      if (newSid) setActiveId(newSid); loadSessions()
    } catch (err: any) { setMessages([...newMsgs, { id: `m${Date.now()}`, role: "assistant", content: "Error: " + err.message, ts: Date.now() }]); setStreaming(false) }
  }, [input, streaming, messages, selectedModel, uploadedFiles, loadSessions])

  const send = useCallback(() => _send(), [_send])
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }
  const newSession = () => { setActiveId(null); setMessages([]); inputRef.current?.focus() }
  const startEdit = (msg: Msg) => { setEditingMsgId(msg.id); setEditText(msg.content) }
  const submitEdit = () => {
    const text = editText.trim(); if (!text) return
    const idx = messages.findIndex(m => m.id === editingMsgId); if (idx === -1) return
    setMessages(messages.slice(0, idx + 1).map((m, i) => i === idx ? { ...m, content: text } : m))
    setEditingMsgId(null); setTimeout(() => _send(text), 100)
  }

  return (
    <div className="flex h-screen bg-bg-primary text-text-primary" style={{ fontFamily: "system-ui, sans-serif" }} onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={e => { e.preventDefault(); setDragOver(false) }} onDrop={handleDrop}>
      {/* Sidebar */}
      {sidebarOpen && (
      <aside className="w-60 bg-bg-secondary border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border space-y-2">
          <button onClick={newSession} className="w-full py-2 px-4 bg-accent text-white rounded-lg font-medium text-sm hover:bg-accent-hover transition-colors">+ New</button>
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search…" className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent" />
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {filteredSessions.map(s => (
            <div key={s.id} onClick={() => selectSession(s.id)} className={`group w-full text-left px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors relative ${s.id === activeId ? "bg-accent-muted text-text-primary" : "text-text-secondary hover:bg-bg-hover"}`}>
              {renamingId === s.id ? (
                <input value={renameTitle} onChange={e => setRenameTitle(e.target.value)} onBlur={submitRename} onKeyDown={e => e.key === "Enter" && submitRename()} className="w-full bg-bg-tertiary border border-accent rounded px-1.5 py-0.5 text-xs outline-none" autoFocus onClick={e => e.stopPropagation()} />
              ) : (
                <>
                  <div className="truncate font-medium">{s.title || "Untitled"}</div>
                  <div className="text-xs text-text-muted mt-0.5 flex justify-between">
                    <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                    <span className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity relative">
                      <button onClick={e => { e.stopPropagation(); setMenuOpen(menuOpen === s.id ? null : s.id) }} className="hover:text-text-primary">⋯</button>
                      {menuOpen === s.id && (
                        <div className="absolute right-0 top-5 bg-bg-tertiary border border-border rounded-lg shadow-lg py-1 z-50 min-w-[100px]" onClick={e => e.stopPropagation()}>
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
        </div>
        {uploadedFiles.length > 0 && (
          <div className="border-t border-border p-3"><p className="text-xs text-text-muted mb-1 font-medium">📁 Files</p>
            {uploadedFiles.map(f => <div key={f.name} className="text-xs text-text-secondary truncate py-0.5">{f.name}</div>)}
          </div>
        )}
      </aside>
      )}

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-text-muted hover:text-text-secondary text-sm">☰</button>
          <h1 className="text-sm font-semibold text-text-secondary">🦈 DataWhale</h1>
          <div className="flex-1" />
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} className="bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-xs text-text-primary outline-none">
            <option value="deepseek">DeepSeek V4 Pro</option>
            <option value="deepseek-flash">DeepSeek V4 Flash</option>
          </select>
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} className="text-text-muted hover:text-text-secondary text-sm">{theme === "dark" ? "☀️" : "🌙"}</button>
        </header>

        {dragOver && <div className="absolute inset-0 z-50 bg-accent/10 border-2 border-dashed border-accent rounded-xl flex items-center justify-center"><p className="text-accent text-lg font-medium">Drop CSV/JSON files here</p></div>}

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {messages.length === 0 && !streaming && (
            <div className="flex items-center justify-center h-full"><div className="text-center"><div className="text-4xl mb-4">🦈</div><p className="text-text-secondary text-sm">Ask questions about your data.</p></div></div>
          )}

          {messages.map((msg, idx) => (
            <div key={msg.id} className={`msg-enter flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] min-w-0 ${msg.role === "user" ? "bg-accent-muted text-white rounded-2xl rounded-br-md px-4 py-2.5" : ""}`}>
                {editingMsgId === msg.id ? (
                  <div className="flex gap-2"><textarea value={editText} onChange={e => setEditText(e.target.value)} className="flex-1 bg-bg-tertiary border border-accent rounded px-3 py-2 text-sm outline-none resize-none" rows={2} autoFocus /><button onClick={submitEdit} className="px-3 py-1 bg-accent text-white rounded text-xs">Send</button><button onClick={() => setEditingMsgId(null)} className="px-3 py-1 bg-bg-tertiary text-text-secondary rounded text-xs">Cancel</button></div>
                ) : (
                  <>
                    {msg.thinking && (
                      <details className="mb-2" open={!!expandedThinking[msg.id]}>
                        <summary className="text-xs text-text-muted hover:text-text-secondary cursor-pointer select-none flex items-center gap-1.5" onClick={e => { e.preventDefault(); setExpandedThinking(p => ({ ...p, [msg.id]: !p[msg.id] })) }}>
                          <span className="text-[10px]">{expandedThinking[msg.id] ? "▾" : "▸"}</span><span>Thought for {(msg.thinking.length / 4).toFixed(0)}s</span>
                        </summary>
                        <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border">{msg.thinking}</div>
                      </details>
                    )}
                    {msg.tools && msg.tools.length > 0 && (
                      <div className="mb-3 space-y-1">{msg.tools.map(tc => (
                        <div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50">
                          <span className={tc.status === "done" ? "text-success" : tc.status === "error" ? "text-error" : "text-warning"}>{tc.status === "running" ? "⏳" : tc.status === "done" ? "✓" : "✗"}</span>
                          <span className="text-text-secondary font-medium">{tc.name}</span>
                          {tc.preview && <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>}
                        </div>
                      ))}</div>
                    )}
                    {msg.content && <div className="text-sm leading-relaxed"><ReactMarkdown>{msg.content}</ReactMarkdown></div>}
                    <div className={`mt-1.5 flex items-center gap-2 text-xs ${msg.role === "assistant" ? "" : "justify-end"}`}>
                      <span className="text-text-muted/60">{new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      {msg.role === "assistant" && msg.content && (<>
                        <button onClick={() => copyMessage(msg.content, msg.id)} className="text-text-muted hover:text-text-secondary">{copiedId === msg.id ? "✓" : "📋"}</button>
                        {idx === messages.length - 1 && <button onClick={regenerate} className="text-text-muted hover:text-text-secondary">🔄</button>}
                      </>)}
                      {msg.role === "user" && <button onClick={() => startEdit(msg)} className="text-text-muted hover:text-text-secondary">✏️</button>}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}

          {streaming && (
            <div className="msg-enter flex justify-start"><div className="max-w-[85%] min-w-0 space-y-2">
              {streamThinking && (<details open><summary className="text-xs text-text-muted cursor-pointer select-none flex items-center gap-1.5"><span className="text-[10px]">▾</span><span>Thinking…</span></summary><div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border">{streamThinking}</div></details>)}
              {streamTools.map(tc => (<div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50"><span className={tc.status === "done" ? "text-success" : "text-warning"}>{tc.status === "running" ? "⏳" : "✓"}</span><span className="text-text-secondary font-medium">{tc.name}</span>{tc.preview && <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span>}</div>))}
              {streamText && <div className="text-sm leading-relaxed"><ReactMarkdown>{streamText}</ReactMarkdown><span className="typing-cursor" /></div>}
              {!streamText && !streamThinking && streamTools.length === 0 && <div className="flex gap-1.5 py-2"><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} /></div>}
            </div></div>
          )}
        </div>

        <div className="p-4 border-t border-border">
          <div className="flex gap-2 max-w-3xl mx-auto">
            <input ref={fileInputRef} type="file" accept=".csv,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f) }} />
            <button onClick={() => fileInputRef.current?.click()} className="px-3 py-3 bg-bg-secondary border border-border rounded-xl text-text-muted hover:text-text-secondary hover:border-accent transition-colors shrink-0" title="Attach CSV/JSON">📎</button>
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="Ask about your data..." rows={3}
              className="flex-1 bg-bg-secondary border border-border rounded-xl px-4 py-3 text-sm placeholder:text-text-muted resize-none outline-none focus:border-accent transition-colors min-h-[44px]" disabled={streaming} />
            <button onClick={send} disabled={!input.trim() || streaming} className="px-6 py-3 bg-accent text-white rounded-xl font-medium text-sm hover:bg-accent-hover disabled:opacity-40 transition-all shrink-0 self-end">{streaming ? "…" : "Send"}</button>
          </div>
          <p className="text-xs text-text-muted text-center mt-2">Enter to send · Drag files to upload</p>
        </div>
      </main>
    </div>
  )
}
