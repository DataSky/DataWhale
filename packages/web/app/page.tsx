"use client"

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { marked } from "marked"

function MarkdownView({ content }: { content: string }) {
  const html = marked.parse(content || "") as string
  return <div className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
}

const API = ""
async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(`${API}${url}`, init)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

interface Msg { id: string; role: string; content: string; thinking?: string; tools?: any[]; ts: number }

export default function Home() {
  const [sessions, setSessions] = useState<any[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState("")
  const [streamThinking, setStreamThinking] = useState("")
  const [streamTools, setStreamTools] = useState<any[]>([])
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState("")
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [selectedModel, setSelectedModel] = useState("deepseek")
  const [theme, setTheme] = useState("dark")
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeIdRef = useRef<string | null>(null)

  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => {
    try { document.documentElement.className = theme === "light" ? "light" : "" } catch {}
  }, [theme])

  const loadSessions = useCallback(async () => { try { setSessions(await fetchJSON("/api/sessions")) } catch {} }, [])
  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => {
    try { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }) } catch {}
  }, [messages, streamText, streamThinking, streamTools])

  const filteredSessions = useMemo(() =>
    searchQuery ? sessions.filter((s) => (s.title || "").toLowerCase().includes(searchQuery.toLowerCase())) : sessions,
    [sessions, searchQuery]
  )

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id)
    try {
      const data = await fetchJSON(`/api/sessions/${id}`)
      if (data.messages) {
        setMessages(data.messages.filter(function(m: any) { return m.role !== "tool_result" }).map(function(m: any, i: number) {
          var c = typeof m.content === "string" ? m.content : ""
          var tools: any[] | undefined
          if (m.meta && m.meta.toolCalls) {
            tools = m.meta.toolCalls.map(function(tc: any) { return { id: tc.id || "", name: tc.name || "unknown", status: "done", preview: tc.arguments ? tc.arguments.slice(0, 80) : "" } })
          }
          return { id: "m" + i, role: m.role === "user" ? "user" : "assistant", content: c, thinking: m.thinking || undefined, tools: tools, ts: m.timestamp || 0 }
        }))
      }
    } catch {}
  }, [])

  const deleteSession = useCallback(async (id: string) => {
    try { await fetchJSON("/api/sessions/" + id, { method: "DELETE" }) } catch {}
    if (activeId === id) { setActiveId(null); setMessages([]) }
    setMenuOpen(null); loadSessions()
  }, [activeId, loadSessions])

  const exportSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(API + "/api/sessions/" + id + "/export")
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a"); a.href = url; a.download = "session-" + id.slice(0, 8) + ".md"; a.click()
      URL.revokeObjectURL(url)
    } catch {}
    setMenuOpen(null)
  }, [])

  const startRename = useCallback((id: string, title: string) => { setRenamingId(id); setRenameTitle(title); setMenuOpen(null) }, [])
  const submitRename = useCallback(async () => {
    if (!renamingId) return
    try { await fetchJSON("/api/sessions/" + renamingId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: renameTitle }) }) } catch {}
    setRenamingId(null); loadSessions()
  }, [renamingId, renameTitle, loadSessions])

  const copyMessage = useCallback((text: string, id: string) => {
    try { navigator.clipboard.writeText(text).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000) }) } catch {}
  }, [])

  const regenerate = useCallback(() => {
    const idx = [...messages].reverse().findIndex(function(m) { return m.role === "user" })
    if (idx === -1) return
    const um = messages[messages.length - 1 - idx]
    setMessages(messages.slice(0, messages.length - 1 - idx))
    setInput(um.content); setTimeout(function() { _send(um.content) }, 100)
  }, [messages])

  const handleFileUpload = useCallback(async (f: File) => {
    const fd = new FormData(); fd.append("file", f)
    try { const data = await (await fetch(API + "/api/upload", { method: "POST", body: fd })).json(); setUploadedFiles(function(p) { return [...p.filter(function(x) { return x.name !== data.name }), data] }) } catch {}
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    var files = Array.from(e.dataTransfer.files)
    for (var i = 0; i < files.length; i++) { if (files[i].name.endsWith(".csv") || files[i].name.endsWith(".json")) handleFileUpload(files[i]) }
  }, [handleFileUpload])

  const _send = useCallback(async (overrideText?: string) => {
    const text = (overrideText || input).trim(); if (!text || streaming) return
    setInput(""); setEditingMsgId(null)
    const userMsg: Msg = { id: "m" + Date.now(), role: "user", content: text, ts: Date.now() }
    const newMsgs = [...messages, userMsg]; setMessages(newMsgs)
    setStreaming(true); setStreamText(""); setStreamThinking(""); setStreamTools([])

    try {
      const res = await fetch(API + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, sessionId: activeIdRef.current || undefined, model: selectedModel, files: uploadedFiles.map(function(f) { return f.path }) }) })
      if (!res.ok || !res.body) throw new Error("Connection failed")
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      var buf = "", thinking = "", content = ""; var tools: any[] = []; var newSid = activeIdRef.current
      while (true) {
        const nxt = await reader.read(); if (nxt.done) break
        buf += decoder.decode(nxt.value, { stream: true })
        var parts = buf.split("\n\n"); buf = parts.pop() || ""
        for (var pi = 0; pi < parts.length; pi++) {
          var lines = parts[pi].split("\n")
          for (var li = 0; li < lines.length; li++) {
            var line = lines[li]; if (!line.startsWith("data: ")) continue
            try {
              var ev = JSON.parse(line.slice(6))
              if (ev.type === "message_update") { content += ev.delta; setStreamText(content) }
              else if (ev.type === "reasoning_update") { thinking += ev.delta; setStreamThinking(thinking) }
              else if (ev.type === "tool_call_start") { tools = [...tools, { id: ev.toolCallId, name: ev.toolName, status: "running" }]; setStreamTools([...tools]) }
              else if (ev.type === "tool_call_end") { tools = tools.map(function(t) { return t.id === ev.toolCallId ? { ...t, status: ev.isError ? "error" : "done", preview: ev.content } : t }); setStreamTools([...tools]) }
              else if (ev.type === "agent_end") { if (ev.sessionId) newSid = ev.sessionId }
            } catch {}
          }
        }
      }
      setMessages([...newMsgs, { id: "m" + Date.now(), role: "assistant", content, thinking: thinking || undefined, tools: tools.length > 0 ? tools : undefined, ts: Date.now() }])
      setStreamText(""); setStreamThinking(""); setStreamTools([]); setStreaming(false)
      if (newSid) setActiveId(newSid); loadSessions()
    } catch (err: any) { setMessages([...newMsgs, { id: "m" + Date.now(), role: "assistant", content: "Error: " + (err.message || "unknown"), ts: Date.now() }]); setStreaming(false) }
  }, [input, streaming, messages, selectedModel, uploadedFiles, loadSessions])

  const send = useCallback(function() { _send() }, [_send])
  const newSession = function() { setActiveId(null); setMessages([]); try { inputRef.current?.focus() } catch {} }
  const startEdit = function(msg: Msg) { setEditingMsgId(msg.id); setEditText(msg.content) }
  const submitEdit = function() {
    var text = editText.trim(); if (!text) return
    var idx = messages.findIndex(function(m) { return m.id === editingMsgId }); if (idx === -1) return
    setMessages(messages.slice(0, idx + 1).map(function(m, i) { return i === idx ? { ...m, content: text } : m }))
    setEditingMsgId(null); setTimeout(function() { _send(text) }, 100)
  }

  const handleKeyDown = function(e: React.KeyboardEvent) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }
  const toggleMenu = function(id: string, e: React.MouseEvent) { e.stopPropagation(); setMenuOpen(menuOpen === id ? null : id) }
  const formatTime = function(ts: number) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }

  return (
    <div className="flex h-screen bg-bg-primary text-text-primary" style={{ fontFamily: "system-ui, sans-serif" }}
      onDragOver={function(e) { e.preventDefault(); setDragOver(true) }}
      onDragLeave={function(e) { e.preventDefault(); setDragOver(false) }}
      onDrop={handleDrop}>

      {/* Sidebar */}
      {sidebarOpen ? (
        <aside className="w-60 bg-bg-secondary border-r border-border flex flex-col shrink-0">
          <div className="p-3 border-b border-border space-y-2">
            <button onClick={newSession} className="w-full py-2 px-4 bg-accent text-white rounded-lg font-medium text-sm hover:bg-accent-hover transition-colors">+ New</button>
            <input value={searchQuery} onChange={function(e) { setSearchQuery(e.target.value) }} placeholder="Search sessions..."
              className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent" />
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filteredSessions.map(function(s) {
              return (
                <div key={s.id} onClick={function() { selectSession(s.id) }}
                  className={"group w-full text-left px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors relative " + (s.id === activeId ? "bg-accent-muted text-text-primary" : "text-text-secondary hover:bg-bg-hover")}>
                  {renamingId === s.id ? (
                    <input value={renameTitle} onChange={function(e) { setRenameTitle(e.target.value) }} onBlur={submitRename}
                      onKeyDown={function(e) { if (e.key === "Enter") submitRename() }}
                      className="w-full bg-bg-tertiary border border-accent rounded px-1.5 py-0.5 text-xs outline-none" autoFocus
                      onClick={function(e) { e.stopPropagation() }} />
                  ) : (
                    <div>
                      <div className="truncate font-medium">{s.title || "Untitled"}</div>
                      <div className="text-xs text-text-muted mt-0.5 flex justify-between">
                        <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                        <span className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity relative">
                          <button onClick={function(e) { toggleMenu(s.id, e) }} className="hover:text-text-primary">⋯</button>
                          {menuOpen === s.id ? (
                            <div className="absolute right-0 top-5 bg-bg-tertiary border border-border rounded-lg shadow-lg py-1 z-50 min-w-[100px]" onClick={function(e) { e.stopPropagation() }}>
                              <button onClick={function() { startRename(s.id, s.title) }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover">✎ Rename</button>
                              <button onClick={function() { exportSession(s.id) }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover">📥 Export</button>
                              <button onClick={function() { deleteSession(s.id) }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover text-error">✕ Delete</button>
                            </div>
                          ) : null}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {uploadedFiles.length > 0 ? (
            <div className="border-t border-border p-3">
              <p className="text-xs text-text-muted mb-1 font-medium">📁 Files</p>
              {uploadedFiles.map(function(f) { return <div key={f.name} className="text-xs text-text-secondary truncate py-0.5">{f.name}</div> })}
            </div>
          ) : null}
        </aside>
      ) : null}

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
          <button onClick={function() { setSidebarOpen(!sidebarOpen) }} className="text-text-muted hover:text-text-secondary text-sm">☰</button>
          <h1 className="text-sm font-semibold text-text-secondary">🦈 DataWhale</h1>
          <div className="flex-1" />
          <select value={selectedModel} onChange={function(e) { setSelectedModel(e.target.value) }} className="bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-xs text-text-primary outline-none">
            <option value="deepseek">DeepSeek V4 Pro</option>
            <option value="deepseek-flash">DeepSeek V4 Flash</option>
          </select>
          <button onClick={function() { setTheme(theme === "dark" ? "light" : "dark") }} className="text-text-muted hover:text-text-secondary text-sm">{theme === "dark" ? "☀️" : "🌙"}</button>
        </header>

        {/* Drag overlay */}
        {dragOver ? <div className="absolute inset-0 z-50 bg-accent/10 border-2 border-dashed border-accent rounded-xl flex items-center justify-center"><p className="text-accent text-lg font-medium">Drop CSV/JSON files here</p></div> : null}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {messages.length === 0 && !streaming ? (
            <div className="flex items-center justify-center h-full"><div className="text-center"><div className="text-4xl mb-4">🦈</div><p className="text-text-secondary text-sm">Ask questions about your data.</p></div></div>
          ) : null}

          {messages.map(function(msg, idx) {
            return (
              <div key={msg.id} className={"msg-enter flex " + (msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className={"max-w-[85%] min-w-0 " + (msg.role === "user" ? "bg-accent-muted text-white rounded-2xl rounded-br-md px-4 py-2.5" : "")}>
                  {editingMsgId === msg.id ? (
                    <div className="flex gap-2">
                      <textarea value={editText} onChange={function(e) { setEditText(e.target.value) }} className="flex-1 bg-bg-tertiary border border-accent rounded px-3 py-2 text-sm outline-none resize-none" rows={2} autoFocus />
                      <button onClick={submitEdit} className="px-3 py-1 bg-accent text-white rounded text-xs">Send</button>
                      <button onClick={function() { setEditingMsgId(null) }} className="px-3 py-1 bg-bg-tertiary text-text-secondary rounded text-xs">Cancel</button>
                    </div>
                  ) : (
                    <div>
                      {/* Thinking */}
                      {msg.thinking ? (
                        <details className="mb-2" open={!!expandedThinking[msg.id]}>
                          <summary className="text-xs text-text-muted hover:text-text-secondary cursor-pointer select-none flex items-center gap-1.5"
                            onClick={function(e) { e.preventDefault(); setExpandedThinking(function(p) { var n: Record<string,boolean> = {}; Object.assign(n, p); n[msg.id] = !p[msg.id]; return n }) }}>
                            <span className="text-[10px]">{expandedThinking[msg.id] ? "▾" : "▸"}</span>
                            <span>Thought for {Math.round(msg.thinking.length / 4)}s</span>
                          </summary>
                          <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border">{msg.thinking}</div>
                        </details>
                      ) : null}
                      {/* Tool calls */}
                      {msg.tools && msg.tools.length > 0 ? (
                        <div className="mb-3 space-y-1">
                          {msg.tools.map(function(tc) { return (
                            <div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50">
                              <span className={tc.status === "done" ? "text-success" : tc.status === "error" ? "text-error" : "text-warning"}>{tc.status === "running" ? "⏳" : tc.status === "done" ? "✓" : "✗"}</span>
                              <span className="text-text-secondary font-medium">{tc.name}</span>
                              {tc.preview ? <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span> : null}
                            </div>
                          )})}
                        </div>
                      ) : null}
                      {/* Content */}
                      {msg.content ? <MarkdownView content={msg.content} /> : null}
                      {/* Action bar */}
                      <div className={"mt-1.5 flex items-center gap-2 text-xs " + (msg.role === "assistant" ? "" : "justify-end")}>
                        <span className="text-text-muted/60">{formatTime(msg.ts)}</span>
                        {msg.role === "assistant" && msg.content ? (
                          <span>
                            <button onClick={function() { copyMessage(msg.content, msg.id) }} className="text-text-muted hover:text-text-secondary">{copiedId === msg.id ? "✓" : "📋"}</button>
                            {idx === messages.length - 1 ? <button onClick={regenerate} className="text-text-muted hover:text-text-secondary ml-1">🔄</button> : null}
                          </span>
                        ) : null}
                        {msg.role === "user" ? <button onClick={function() { startEdit(msg) }} className="text-text-muted hover:text-text-secondary">✏️</button> : null}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Streaming */}
          {streaming ? (
            <div className="msg-enter flex justify-start"><div className="max-w-[85%] min-w-0 space-y-2">
              {streamThinking ? (
                <details open><summary className="text-xs text-text-muted cursor-pointer select-none flex items-center gap-1.5"><span className="text-[10px]">▾</span><span>Thinking…</span></summary>
                  <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border">{streamThinking}</div>
                </details>
              ) : null}
              {streamTools.map(function(tc) { return (
                <div key={tc.id} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50">
                  <span className={tc.status === "done" ? "text-success" : "text-warning"}>{tc.status === "running" ? "⏳" : "✓"}</span>
                  <span className="text-text-secondary font-medium">{tc.name}</span>
                  {tc.preview ? <span className="text-text-muted truncate flex-1">{tc.preview.slice(0, 80)}</span> : null}
                </div>
              )})}
              {streamText ? <div><MarkdownView content={streamText} /><span className="typing-cursor" /></div> : null}
              {!streamText && !streamThinking && streamTools.length === 0 ? (
                <div className="flex gap-1.5 py-2"><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} /></div>
              ) : null}
            </div></div>
          ) : null}
        </div>

        {/* Input */}
        <div className="p-4 border-t border-border">
          <div className="flex gap-2 max-w-3xl mx-auto">
            <input ref={fileInputRef} type="file" accept=".csv,.json" className="hidden"
              onChange={function(e) { var f = e.target.files?.[0]; if (f) handleFileUpload(f) }} />
            <button onClick={function() { fileInputRef.current?.click() }} className="px-3 py-3 bg-bg-secondary border border-border rounded-xl text-text-muted hover:text-text-secondary hover:border-accent transition-colors shrink-0" title="Attach CSV/JSON">📎</button>
            <textarea ref={inputRef} value={input} onChange={function(e) { setInput(e.target.value) }} onKeyDown={handleKeyDown}
              placeholder="Ask about your data..." rows={3}
              className="flex-1 bg-bg-secondary border border-border rounded-xl px-4 py-3 text-sm placeholder:text-text-muted resize-none outline-none focus:border-accent transition-colors min-h-[44px]"
              disabled={streaming} />
            <button onClick={send} disabled={!input.trim() || streaming}
              className="px-6 py-3 bg-accent text-white rounded-xl font-medium text-sm hover:bg-accent-hover disabled:opacity-40 transition-all shrink-0 self-end">
              {streaming ? "…" : "Send"}
            </button>
          </div>
          <p className="text-xs text-text-muted text-center mt-2">Enter to send · Drag files to upload</p>
        </div>
      </main>
    </div>
  )
}
