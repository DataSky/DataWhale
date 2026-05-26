"use client"

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { marked } from "marked"

// Normalize "one-word-per-line" syndrome from DeepSeek V4 Chinese output.
// When >50% of lines are 1-2 chars, merge them back into continuous text.
function normalizeNewlines(text: string): string {
  const lines = text.split("\n")
  const nonEmpty = lines.filter(l => l.trim().length > 0)
  if (nonEmpty.length < 5) return text
  const singleChars = nonEmpty.filter(l => l.trim().length <= 2).length
  if (singleChars <= nonEmpty.length * 0.5) return text

  const merged: string[] = []
  let buf = ""
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      if (buf) { merged.push(buf); buf = "" }
      merged.push("")
    } else if (trimmed.length <= 2) {
      buf += trimmed
    } else {
      if (buf) { merged.push(buf); buf = "" }
      merged.push(line)
    }
  }
  if (buf) merged.push(buf)
  return merged.join("\n").replace(/\n{4,}/g, "\n\n\n")
}

function MarkdownView({ content }: { content: string }) {
  const normalized = normalizeNewlines(content || "")
  let html = ""
  try { html = marked.parse(normalized) as string } catch {}
  return <div className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
}

// ── Artifact Components ──────────────────────────────────────────────────────

interface ArtifactData {
  id: string
  type: string
  title?: string
  content: string       // inline HTML (legacy — all HTML now via execute_python)
  fileUrl?: string      // file path /api/files/... (from execute_python)
  streaming: boolean
}

function HtmlView({ artifact }: { artifact: ArtifactData }) {
  if (artifact.fileUrl) {
    return (
      <iframe
        src={artifact.fileUrl}
        sandbox="allow-scripts allow-same-origin"
        className="w-full h-full border-0 rounded-lg"
        style={{ minHeight: 300 }}
        title="HTML Artifact"
      />
    )
  }
  return (
    <iframe
      srcDoc={artifact.content || "<html><body></body></html>"}
      sandbox="allow-scripts"
      className="w-full h-full border-0 rounded-lg"
      style={{ minHeight: 300 }}
      title="HTML Artifact"
    />
  )
}

function ArtifactCard({ artifact, onFullscreen }: { artifact: ArtifactData; onFullscreen: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  if (collapsed) {
    return (
      <div className="flex items-center gap-2 p-2 bg-bg-secondary border border-border rounded-lg cursor-pointer"
        onClick={() => setCollapsed(false)}>
        <span className="text-sm">📄</span>
        <span className="text-xs text-text-secondary font-medium">{artifact.title || artifact.type}</span>
        <span className="text-xs text-text-muted ml-auto">▸ expand</span>
      </div>
    )
  }
  return (
    <div className="my-3 border border-border rounded-xl overflow-hidden bg-bg-secondary">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-tertiary/50">
        <span className="text-xs font-medium text-text-secondary">{artifact.title || artifact.type}</span>
        <div className="flex-1" />
        <button onClick={onFullscreen} className="text-xs text-text-muted hover:text-text-primary px-2 py-0.5 rounded" title="Fullscreen">⛶</button>
        <button onClick={() => {
          try {
            const blob = new Blob([artifact.content], { type: "text/html" })
            const url = URL.createObjectURL(blob)
            window.open(url, "_blank")
          } catch {}
        }} className="text-xs text-text-muted hover:text-text-primary px-2 py-0.5 rounded" title="Open in new tab">🔗</button>
        <button onClick={() => setCollapsed(true)} className="text-xs text-text-muted hover:text-text-primary px-2 py-0.5 rounded" title="Collapse">▾</button>
      </div>
      <div style={{ height: artifact.streaming ? 200 : 400 }}>
        {artifact.streaming ? (
          <div className="flex items-center justify-center h-full text-xs text-text-muted">
            <span>Generating…</span>
          </div>
        ) : (
          <HtmlView artifact={artifact} />
        )}
      </div>
    </div>
  )
}

// ── Agent Status Bar ────────────────────────────────────────────────────────

const PHASE_LABELS: Record<AgentPhase, string> = {
  thinking: "Thinking…",
  executing: "Executing tools…",
  generating: "Generating response…",
  done: "Done",
}

function AgentStatusBar({ phase, spinnerFrame, elapsed, turnCount, toolCount, streaming }: {
  phase: AgentPhase; spinnerFrame: number; elapsed: number; turnCount: number; toolCount: number; streaming: boolean
}) {
  const spinner = SPINNER_FRAMES[spinnerFrame]
  return (
    <div className="flex items-center gap-3 text-xs h-5">
      {streaming ? (
        <>
          <span className="text-accent font-mono w-4 text-center">{spinner}</span>
          <span className="text-text-secondary font-medium">{PHASE_LABELS[phase]}</span>
          <span className="text-text-muted/50">·</span>
          <span className="text-text-muted tabular-nums">{elapsed.toFixed(1)}s</span>
          {turnCount > 0 && <><span className="text-text-muted/50">·</span><span className="text-text-muted">Turn {turnCount}</span></>}
          {toolCount > 0 && <><span className="text-text-muted/50">·</span><span className="text-text-muted">{toolCount} tool{toolCount>1?'s':''}</span></>}
        </>
      ) : (
        <>
          <span className="text-text-muted/40 font-mono w-4 text-center">✓</span>
          <span className="text-text-muted/60">Ready</span>
          {turnCount > 0 && <><span className="text-text-muted/50">·</span><span className="text-text-muted/60">last: Turn {turnCount} in {elapsed.toFixed(1)}s</span></>}
        </>
      )}
    </div>
  )
}

const API = ""
async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(`${API}${url}`, init)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

interface Msg { id: string; role: string; content: string; thinking?: string; tools?: any[]; ts: number; artifacts?: ArtifactData[]; files?: { name: string; path: string; size: number }[] }

// Ordered stream items for correct interleaving of thinking/tools/text
interface StreamItem {
  id: string
  type: "thinking" | "tool" | "text" | "artifact"
  content: string
  toolName?: string
  toolStatus?: string
  toolStartedAt?: number   // timestamp when tool execution began (for elapsed display)
  artifactTitle?: string
  artifactType?: string
  artifactStreaming?: boolean
  artifactFileUrl?: string
}

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
type AgentPhase = "thinking" | "executing" | "generating" | "done"

export default function Home() {
  const [sessions, setSessions] = useState<any[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [streamItems, setStreamItems] = useState<StreamItem[]>([])
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState("")
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([])
  const removeUploadedFile = useCallback(function(name: string) {
    setUploadedFiles(function(p) { return p.filter(function(f) { return f.name !== name }) })
  }, [])
  const [dragOver, setDragOver] = useState(false)
  const [selectedModel, setSelectedModel] = useState("deepseek")
  const [theme, setTheme] = useState("dark")
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [fullscreenArtifact, setFullscreenArtifact] = useState<ArtifactData | null>(null)
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [agentPhase, setAgentPhase] = useState<AgentPhase>("thinking")
  const [turnCount, setTurnCount] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeIdRef = useRef<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const elapsedStartRef = useRef<number>(0)
  const toolStartRef = useRef<Record<string, number>>({})

  // Heartbeat timer: drives spinner animation + elapsed counter while streaming
  useEffect(() => {
    if (!streaming) { setSpinnerFrame(0); setElapsed(0); setAgentPhase("done"); setTurnCount(0); return }
    elapsedStartRef.current = Date.now()
    const timer = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length)
      setElapsed(Math.round((Date.now() - elapsedStartRef.current) / 100) / 10)
    }, 100)
    return () => clearInterval(timer)
  }, [streaming])

  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => {
    try { document.documentElement.className = theme === "light" ? "light" : "" } catch {}
  }, [theme])

  const loadSessions = useCallback(async () => { try { setSessions(await fetchJSON("/api/sessions")) } catch {} }, [])
  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => {
    try { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }) } catch {}
  }, [messages, streamItems])

  const filteredSessions = useMemo(() =>
    searchQuery ? sessions.filter((s) => (s.title || "").toLowerCase().includes(searchQuery.toLowerCase())) : sessions,
    [sessions, searchQuery]
  )

  const turns = useMemo(function() {
    var result: any[] = []
    var current: any = null
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i]
      if (m.role === "user") {
        if (current) result.push(current)
        current = { user: m, assistants: [] }
      } else if (current) {
        current.assistants.push(m)
      }
    }
    if (current) result.push(current)
    return result
  }, [messages])

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id)
    try {
      // Try new Query API first (Session → Query → Turn → Span)
      const queries = await fetchJSON(`/api/queries?sessionId=${id}`)
      if (queries && queries.length > 0) {
        const msgs: Msg[] = []
        for (const q of queries) {
          // User message per query
          msgs.push({ id: "uq" + q.id, role: "user", content: q.userContent || "", ts: q.createdAt || Date.now() })
          // Build assistant message from turns
          let thinking = ""
          let text = ""
          const tools: any[] = []
          for (const turn of q.turns || []) {
            for (const span of turn.spans || []) {
              if (span.type === "thinking") thinking += (thinking ? "\n" : "") + (span.content || "")
              else if (span.type === "text") text += (text ? "\n" : "") + (span.content || "")
              else if (span.type === "tool_call") {
                tools.push({ id: span.id, name: span.name, status: span.isError ? "error" : "done", preview: (span.result || "").slice(0, 80), detail: span.result || "" })
              }
            }
          }
          msgs.push({ id: "aq" + q.id, role: "assistant", content: text, thinking: thinking || undefined, tools: tools.length > 0 ? tools : undefined, ts: q.createdAt || Date.now() })
        }
        // Also load artifacts from messages API (artifacts are stored in message meta, not queries)
        try {
          const msgData = await fetchJSON(`/api/sessions/${id}`)
          if (msgData.messages) {
            // Collect artifacts from assistant messages in order
            const artList: ArtifactData[][] = []
            for (var mi = 0; mi < msgData.messages.length; mi++) {
              var rm = msgData.messages[mi]
              if (rm.role === "assistant" && rm.meta?.artifacts && Array.isArray(rm.meta.artifacts)) {
                artList.push(rm.meta.artifacts.map(function(a: any) {
                  return { id: a.id, type: a.type || "html", title: a.title, content: a.html || "", fileUrl: a.fileUrl || undefined, streaming: false }
                }))
              }
            }
            // Attach artifacts by order to assistant messages in msgs
            var artIdx = 0
            for (var mj = 0; mj < msgs.length && artIdx < artList.length; mj++) {
              if (msgs[mj].role === "assistant") {
                msgs[mj].artifacts = artList[artIdx]
                artIdx++
              }
            }
          }
        } catch {}
        setMessages(msgs)
        return
      }
    } catch {}
    // Fallback to old messages API
    try {
      const data = await fetchJSON(`/api/sessions/${id}`)
      if (data.messages) {
        // Filter out internal tool_result messages, keep user + assistant
        const raw = data.messages.filter(function(m: any) { return m.role === "user" || m.role === "assistant" })
        const msgs: Msg[] = []
        for (var i = 0; i < raw.length; i++) {
          var m = raw[i]
          var c = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter(function(p: any) { return p && p.type === "text" }).map(function(p: any) { return p.text || "" }).join("") : "")
          var tools: any[] | undefined
          if (m.meta && m.meta.toolCalls) {
            tools = m.meta.toolCalls.map(function(tc: any) {
              var full = tc.result || tc.arguments || ""
              return { id: tc.id || "", name: tc.name || "unknown", status: "done", preview: full.slice(0, 80), detail: full }
            })
          }
          // Restore artifacts from persisted meta
          var artifacts: ArtifactData[] | undefined
          if (m.meta && m.meta.artifacts && Array.isArray(m.meta.artifacts)) {
            artifacts = m.meta.artifacts.map(function(a: any) {
              return { id: a.id, type: a.type || "html", title: a.title, content: a.html || "", fileUrl: a.fileUrl || undefined, streaming: false }
            })
          }
          msgs.push({ id: "m" + i, role: m.role === "user" ? "user" : "assistant", content: c, thinking: m.thinking || undefined, tools: tools, artifacts: artifacts, ts: m.timestamp || 0 })
        }
        setMessages(msgs)
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
    const text = (overrideText || input).trim()
    // Allow sending with only files (no text) — but still need at least text or files
    if ((!text && uploadedFiles.length === 0) || streaming) return
    setInput(""); setEditingMsgId(null)
    // Snapshot uploaded files so they appear in the user message, then clear the input tray
    const attachedFiles = uploadedFiles.length > 0 ? uploadedFiles.map(function(f) { return { name: f.name, path: f.path, size: f.size } }) : undefined
    const userMsg: Msg = { id: "m" + Date.now(), role: "user", content: text, ts: Date.now(), files: attachedFiles }
    if (uploadedFiles.length > 0) setUploadedFiles([])
    const newMsgs = [...messages, userMsg]; setMessages(newMsgs)
    setStreaming(true); setStreamItems([])
    const ac = new AbortController(); abortControllerRef.current = ac

    try {
      const res = await fetch(API + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, sessionId: activeIdRef.current || undefined, model: selectedModel, files: uploadedFiles.map(function(f) { return f.path }) }), signal: ac.signal })
      if (!res.ok || !res.body) throw new Error("Connection failed")
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      var buf = "", thinking = "", content = ""; var tools: any[] = []; var newSid = activeIdRef.current
      var items: StreamItem[] = []
      // Map tool_call id → index for reliable lookup
      var toolIndexMap: Record<string, number> = {}
      function pushItem(item: StreamItem) { 
        if (item.type === "tool") toolIndexMap[item.id] = items.length
        items = [...items, item]; setStreamItems(items) 
      }
      function updateLastItem(updater: (it: StreamItem) => StreamItem) {
        if (items.length === 0) return
        var last = items[items.length - 1]
        items = [...items.slice(0, -1), updater(last)]
        setStreamItems(items)
      }

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
              // Update sessionId & immediately refresh sidebar so the new session
              // appears without waiting for the full response to complete.
              if (ev.sessionId && !newSid) {
                newSid = ev.sessionId; activeIdRef.current = ev.sessionId
                setActiveId(ev.sessionId); loadSessions()
              }
              if (ev.type === "message_update") {
                setAgentPhase("generating")
                content += ev.delta
                if (items.length > 0 && items[items.length - 1].type === "text") {
                  updateLastItem(function(it) { return { ...it, content: it.content + ev.delta } })
                } else {
                  pushItem({ id: "t" + Date.now(), type: "text", content: ev.delta })
                }
              }
              else if (ev.type === "reasoning_update") {
                setAgentPhase("thinking")
                thinking += ev.delta
                if (items.length > 0 && items[items.length - 1].type === "thinking") {
                  updateLastItem(function(it) { return { ...it, content: it.content + ev.delta } })
                } else {
                  pushItem({ id: "r" + Date.now(), type: "thinking", content: ev.delta })
                }
              }
              else if (ev.type === "tool_call_start") {
                setAgentPhase("executing")
                toolStartRef.current[ev.toolCallId] = Date.now()
                tools = [...tools, { id: ev.toolCallId, name: ev.toolName, status: "running" }]
                var existingIdx = toolIndexMap[ev.toolCallId]
                if (existingIdx !== undefined && existingIdx < items.length && items[existingIdx].id === ev.toolCallId) {
                  items = [...items.slice(0, existingIdx), { ...items[existingIdx], toolStatus: "running", toolStartedAt: Date.now() }, ...items.slice(existingIdx + 1)]
                  setStreamItems(items)
                } else {
                  pushItem({ id: ev.toolCallId, type: "tool", content: "", toolName: ev.toolName, toolStatus: "running", toolStartedAt: Date.now() })
                }
              }
              else if (ev.type === "tool_call_end") {
                tools = tools.map(function(t) { return t.id === ev.toolCallId ? { ...t, status: ev.isError ? "error" : "done", preview: ev.content } : t })
                var idx = toolIndexMap[ev.toolCallId]
                if (idx !== undefined && idx < items.length && items[idx].id === ev.toolCallId) {
                  items = [...items.slice(0, idx), { ...items[idx], toolStatus: ev.isError ? "error" : "done", content: ev.content || "" }, ...items.slice(idx + 1)]
                  setStreamItems(items)
                }
              }
              else if (ev.type === "artifact_start") {
                pushItem({ id: ev.artifactId, type: "artifact", content: "", artifactTitle: ev.title || ev.artifactType, artifactType: ev.artifactType, artifactStreaming: !ev.fileUrl, artifactFileUrl: ev.fileUrl })
              }
              else if (ev.type === "artifact_delta") {
                // Find the artifact item and append delta
                for (var ai = items.length - 1; ai >= 0; ai--) {
                  if (items[ai].id === ev.artifactId && items[ai].type === "artifact") {
                    items = [...items.slice(0, ai), { ...items[ai], content: items[ai].content + ev.delta }, ...items.slice(ai + 1)]
                    setStreamItems(items)
                    break
                  }
                }
              }
              else if (ev.type === "artifact_end") {
                for (var aj = items.length - 1; aj >= 0; aj--) {
                  if (items[aj].id === ev.artifactId && items[aj].type === "artifact") {
                    items = [...items.slice(0, aj), { ...items[aj], artifactStreaming: false }, ...items.slice(aj + 1)]
                    setStreamItems(items)
                    break
                  }
                }
              }
              else if (ev.type === "turn_start") { setTurnCount(ev.turn) }
              else if (ev.type === "agent_end") { if (ev.sessionId) { newSid = ev.sessionId; activeIdRef.current = ev.sessionId } }
            } catch {}
          }
        }
      }
      // Preserve completed artifacts from stream items into the assistant message
      var completedArtifacts: ArtifactData[] = []
      for (var si = 0; si < items.length; si++) {
        if (items[si].type === "artifact") {
          completedArtifacts.push({
            id: items[si].id, type: items[si].artifactType || "html",
            title: items[si].artifactTitle, content: items[si].content,
            fileUrl: items[si].artifactFileUrl,
            streaming: false,
          })
        }
      }
      setMessages([...newMsgs, { id: "m" + Date.now(), role: "assistant", content, thinking: thinking || undefined, tools: tools.length > 0 ? tools : undefined, ts: Date.now(), artifacts: completedArtifacts.length > 0 ? completedArtifacts : undefined }])
      setStreamItems([]); setStreaming(false); abortControllerRef.current = null
      if (newSid) setActiveId(newSid); loadSessions()
    } catch (err: any) {
      // Preserve any partial artifacts on error too
      var errArtifacts: ArtifactData[] = []
      for (var si2 = 0; si2 < items.length; si2++) {
        if (items[si2].type === "artifact") {
          errArtifacts.push({ id: items[si2].id, type: items[si2].artifactType || "html", title: items[si2].artifactTitle, content: items[si2].content, fileUrl: items[si2].artifactFileUrl, streaming: false })
        }
      }
      if (err.name === "AbortError") {
        setMessages([...newMsgs, { id: "m" + Date.now(), role: "assistant", content, thinking: thinking || undefined, tools: tools.length > 0 ? tools : undefined, ts: Date.now(), artifacts: errArtifacts.length > 0 ? errArtifacts : undefined }])
      } else {
        setMessages([...newMsgs, { id: "m" + Date.now(), role: "assistant", content: "Error: " + (err.message || "unknown"), ts: Date.now(), artifacts: errArtifacts.length > 0 ? errArtifacts : undefined }])
      }
      setStreamItems([]); setStreaming(false); abortControllerRef.current = null
    }
  }, [input, streaming, messages, selectedModel, uploadedFiles, loadSessions])

  const send = useCallback(function() { _send() }, [_send])
  const handleStop = useCallback(function() { abortControllerRef.current?.abort() }, [])
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
  const formatTime = function(ts: number) {
    var d = new Date(ts)
    var y = d.getFullYear()
    var m = ("0" + (d.getMonth() + 1)).slice(-2)
    var day = ("0" + d.getDate()).slice(-2)
    var h = ("0" + d.getHours()).slice(-2)
    var min = ("0" + d.getMinutes()).slice(-2)
    return y + "-" + m + "-" + day + " " + h + ":" + min
  }

  return (
    <div className="flex h-screen bg-bg-primary text-text-primary" style={{ fontFamily: "system-ui, sans-serif" }}
      onDragOver={function(e) { e.preventDefault(); setDragOver(true) }}
      onDragLeave={function(e) { e.preventDefault(); setDragOver(false) }}
      onDrop={handleDrop}>

      {/* Fullscreen artifact overlay */}
      {fullscreenArtifact ? (
        <div className="fixed inset-0 z-50 bg-bg-primary flex flex-col" onKeyDown={function(e) { if (e.key === "Escape") setFullscreenArtifact(null) }}>
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-secondary shrink-0">
            <span className="text-sm font-medium text-text-primary">{fullscreenArtifact.title || "Artifact"}</span>
            <div className="flex-1" />
            <button onClick={function() { try { const blob = new Blob([fullscreenArtifact.content], { type: "text/html" }); window.open(URL.createObjectURL(blob), "_blank") } catch {} }} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded">🔗 New Tab</button>
            <button onClick={function() { setFullscreenArtifact(null) }} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded">✕ Close</button>
          </div>
          <div className="flex-1">
            <HtmlView artifact={fullscreenArtifact} />
          </div>
        </div>
      ) : null}

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

          {turns.map(function(turn, ti) {
            return (
              <div key={turn.user?.id || 't' + ti} className="space-y-2">
                {/* User message */}
                {turn.user ? (
                  <div className="msg-enter flex flex-col items-end">
                    <div className="max-w-[85%] bg-accent-muted text-white rounded-2xl rounded-br-md px-4 py-2.5">
                      {editingMsgId === turn.user.id ? (
                        <div className="flex gap-2">
                          <textarea value={editText} onChange={function(e) { setEditText(e.target.value) }} className="flex-1 bg-bg-tertiary border border-accent rounded px-3 py-2 text-sm outline-none resize-none" rows={2} autoFocus />
                          <button onClick={submitEdit} className="px-3 py-1 bg-accent text-white rounded text-xs">Send</button>
                          <button onClick={function() { setEditingMsgId(null) }} className="px-3 py-1 bg-bg-tertiary text-text-secondary rounded text-xs">Cancel</button>
                        </div>
                      ) : (
                        <div>
                          <div className="text-sm leading-relaxed whitespace-pre-wrap">{turn.user.content}</div>
                          {turn.user.files && turn.user.files.length > 0 ? (
                            <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-white/10">
                              {turn.user.files.map(function(f) {
                                var isCsv = f.name.endsWith(".csv"), isJson = f.name.endsWith(".json")
                                var icon = isCsv ? "📊" : isJson ? "📋" : "📄"
                                return (
                                  <a key={f.name} href={`/api/uploads/${f.name}`} download
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-xs text-white/80 transition-colors no-underline">
                                    <span>{icon}</span>
                                    <span className="max-w-[120px] truncate">{f.name}</span>
                                    <span className="text-white/40">↓</span>
                                  </a>
                                )
                              })}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 text-xs mt-1">
                      <span className="text-text-muted/60">{formatTime(turn.user.ts)}</span>
                      <button onClick={function() { startEdit(turn.user) }} className="text-text-muted hover:text-text-secondary">✏️</button>
                    </div>
                  </div>
                ) : null}
                {/* Assistant group in turn */}
                {turn.assistants.length > 0 ? (
                  <div className="msg-enter max-w-[85%] bg-bg-secondary rounded-2xl rounded-bl-md px-4 py-3">
                    {turn.assistants.map(function(msg, ai) {
                      var isLastInTurn = ai === turn.assistants.length - 1
                      return (
                        <div key={msg.id}>
                          {/* Thinking */}
                          {msg.thinking ? (
                            expandedThinking[msg.id] ? (
                              <details className="mb-2" open>
                                <summary className="text-xs text-text-muted hover:text-text-secondary cursor-pointer select-none flex items-center gap-1.5"
                                  onClick={function(e) { e.preventDefault(); setExpandedThinking(function(p) { var n:{} = {}; Object.assign(n, p); n[msg.id] = false; return n }) }}>
                                  <span className="text-[10px]">▾</span><span>Thought for {Math.round(msg.thinking.length / 4)}s</span>
                                </summary>
                                <div className="mt-1.5 p-2.5 rounded-lg bg-bg-tertiary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border">{normalizeNewlines(msg.thinking || "")}</div>
                              </details>
                            ) : (
                              <details className="mb-2">
                                <summary className="text-xs text-text-muted hover:text-text-secondary cursor-pointer select-none flex items-center gap-1.5"
                                  onClick={function(e) { e.preventDefault(); setExpandedThinking(function(p) { var n:{} = {}; Object.assign(n, p); n[msg.id] = true; return n }) }}>
                                  <span className="text-[10px]">▸</span><span>Thought for {Math.round(msg.thinking.length / 4)}s</span>
                                </summary>
                                <div className="mt-1.5 p-2.5 rounded-lg bg-bg-tertiary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border">{normalizeNewlines(msg.thinking || "")}</div>
                              </details>
                            )
                          ) : null}
                          {/* Tool calls */}
                          {msg.tools && msg.tools.length > 0 ? (
                            <div className="mb-3 space-y-1">
                              {msg.tools.map(function(tc) {
                                var hasDetail = tc.detail && tc.detail.length > 10
                                return (
                                  <details key={tc.id} className="text-xs">
                                    <summary className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-tertiary/60 border border-border/50 cursor-pointer select-none hover:bg-bg-hover/50 transition-colors">
                                      <span className="text-success">✓</span><span className="text-text-secondary font-medium">{tc.name}</span>
                                      {tc.preview ? <span className="text-text-muted truncate flex-1">{tc.preview}</span> : null}
                                      {hasDetail ? <span className="text-text-muted ml-auto text-[10px]">▸</span> : null}
                                    </summary>
                                    {hasDetail && (
                                      <div className="mt-1 p-2.5 rounded-lg bg-bg-tertiary text-xs text-text-muted whitespace-pre-wrap max-h-96 overflow-y-auto border border-border leading-relaxed" style={{overflowY: 'scroll'}}>{tc.detail}</div>
                                    )}
                                  </details>
                                )
                              })}
                            </div>
                          ) : null}
                          {/* Content */}
                          {msg.content ? <MarkdownView content={msg.content} /> : null}
                          {/* Artifacts attached to this message */}
                          {msg.artifacts && msg.artifacts.length > 0 ? (
                            <div className="mt-3 space-y-2">
                              {msg.artifacts.map(function(a) {
                                return <ArtifactCard key={a.id} artifact={a} onFullscreen={function() { setFullscreenArtifact(a) }} />
                              })}
                            </div>
                          ) : null}
                          {/* Separator between ReAct steps */}
                          {!isLastInTurn ? <div className="border-t border-border my-3" /> : null}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
                {/* Turn action bar — outside gray bubble */}
                <div className="flex items-center gap-2 text-xs max-w-[85%]">
                  {turn.assistants.length > 0 ? (
                    <span>
                      <span className="text-text-muted/60">{formatTime(turn.assistants[turn.assistants.length - 1].ts)}</span>
                      {turn.assistants[turn.assistants.length - 1].content ? (
                        <span>
                          <button onClick={function() { copyMessage(turn.assistants[turn.assistants.length - 1].content, turn.assistants[turn.assistants.length - 1].id) }} className="text-text-muted hover:text-text-secondary ml-2">{copiedId === turn.assistants[turn.assistants.length - 1].id ? '✓' : '📋'}</button>
                          {ti === turns.length - 1 ? <button onClick={regenerate} className="text-text-muted hover:text-text-secondary ml-1">🔄</button> : null}
                          <button onClick={function() { copyMessage(activeId || "", "sid") }} className="text-text-muted hover:text-text-secondary ml-1" title="复制会话ID">{copiedId === "sid" ? "✓" : "🔗"}</button>
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}

          {/* Streaming */}
          {streaming ? (
            <div className="msg-enter flex justify-start"><div className="max-w-[85%] min-w-0 space-y-1.5">
              {streamItems.length === 0 ? (
                <div className="flex gap-1.5 py-2"><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} /><div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} /></div>
              ) : null}
              {streamItems.map(function(item) {
                if (item.type === "thinking") {
                  return (
                    <details key={item.id} open>
                      <summary className="text-xs text-text-muted cursor-pointer select-none flex items-center gap-1.5"><span className="text-[10px]">▾</span><span>Thinking…</span></summary>
                      <div className="mt-1.5 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto border border-border">{item.content}</div>
                    </details>
                  )
                }
                if (item.type === "artifact") {
                  var art: ArtifactData = { id: item.id, type: item.artifactType || "html", title: item.artifactTitle, content: item.content, fileUrl: item.artifactFileUrl, streaming: item.artifactStreaming || false }
                  return <ArtifactCard key={item.id} artifact={art} onFullscreen={function() { setFullscreenArtifact(art) }} />
                }
                if (item.type === "tool") {
                  var hasDetail = item.content && item.content.length > 10
                  var isExpanded = expandedTools[item.id] || false
                  // Calculate elapsed for running tools
                  var toolElapsed = ""
                  if (item.toolStatus === "running" && item.toolStartedAt) {
                    toolElapsed = ((Date.now() - item.toolStartedAt) / 1000).toFixed(1) + "s"
                  }
                  return (
                    <div key={item.id} className="text-xs">
                      <div 
                        className="flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-bg-secondary/60 border border-border/50 cursor-pointer select-none hover:bg-bg-hover/50 transition-colors"
                        onClick={function() { setExpandedTools(function(p) { var n: Record<string,boolean> = {}; Object.assign(n, p); n[item.id] = !p[item.id]; return n }) }}
                      >
                        <span className={item.toolStatus === "done" ? "text-success" : item.toolStatus === "error" ? "text-error" : "text-warning" + " shrink-0"}>
                          {item.toolStatus === "running" ? "⏳" : item.toolStatus === "done" ? "✓" : "✗"}
                        </span>
                        <span className="text-text-secondary font-medium shrink-0">{item.toolName}</span>
                        {item.toolStatus === "running" && toolElapsed ? <span className="text-text-muted/60 shrink-0">{toolElapsed}</span> : null}
                        {item.content && item.toolStatus === "done" ? <span className="text-text-muted truncate min-w-0">{item.content.slice(0, 80)}</span> : null}
                        {hasDetail && item.toolStatus === "done" ? <span className="text-text-muted shrink-0 ml-auto text-[10px]">{isExpanded ? "▾" : "▸"}</span> : null}
                      </div>
                      {hasDetail && isExpanded && (
                        <div className="mt-1 p-2.5 rounded-lg bg-bg-secondary text-xs text-text-muted whitespace-pre-wrap max-h-64 overflow-y-auto border border-border leading-relaxed" style={{maxHeight: "16rem", overflowY: "auto"}}>{item.content}</div>
                      )}
                    </div>
                  )
                }
                return <MarkdownView key={item.id} content={item.content} />
              })}
              {/* typing cursor on the last text item */}
              {streamItems.length > 0 && streamItems[streamItems.length - 1].type === "text" ? <span className="typing-cursor" /> : null}
            </div></div>
          ) : null}
        </div>

        {/* Agent Status Bar — fixed above input, never scrolls away */}
        <div className="border-t border-border px-4 py-1.5 bg-bg-secondary/90">
          <AgentStatusBar phase={agentPhase} spinnerFrame={spinnerFrame} elapsed={elapsed}
            turnCount={turnCount}
            toolCount={streamItems.filter(function(it) { return it.type === "tool" }).length}
            streaming={streaming} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-border">
          <div className="max-w-3xl mx-auto space-y-2">
            {/* File chips — show attached files as removable tags above the input */}
            {uploadedFiles.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {uploadedFiles.map(function(f) {
                  var isCsv = f.name.endsWith(".csv"), isJson = f.name.endsWith(".json")
                  var icon = isCsv ? "📊" : isJson ? "📋" : "📄"
                  return (
                    <div key={f.name} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-secondary border border-border/60 text-xs text-text-secondary group">
                      <span>{icon}</span>
                      <span className="max-w-[140px] truncate">{f.name}</span>
                      <button onClick={function() { removeUploadedFile(f.name) }}
                        className="ml-0.5 text-text-muted/50 hover:text-error transition-colors leading-none"
                        title="Remove file">×</button>
                    </div>
                  )
                })}
              </div>
            ) : null}

            {/* Input row */}
            <div className="relative">
              <textarea ref={inputRef} value={input} onChange={function(e) { setInput(e.target.value) }} onKeyDown={handleKeyDown}
                placeholder="Ask about your data..." rows={3}
                className="w-full bg-bg-secondary border border-border rounded-xl px-4 py-3 pr-24 text-sm placeholder:text-text-muted resize-none outline-none focus:border-accent transition-colors min-h-[44px]"
                disabled={streaming} />

              {/* Action buttons — bottom-right corner of textarea */}
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <input ref={fileInputRef} type="file" accept=".csv,.json" className="hidden"
                  onChange={function(e) { var f = e.target.files?.[0]; if (f) handleFileUpload(f) }} />
                <button onClick={function() { fileInputRef.current?.click() }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted/60 hover:text-accent hover:bg-accent/10 transition-colors"
                  title="Attach file (CSV/JSON)">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5.5 4.5c-.6.6-1 1.4-1 2.3v4.4a3 3 0 0 0 6 0V6.5a2 2 0 0 0-4 0v4a1 1 0 0 0 2 0V5" />
                  </svg>
                </button>
                {streaming ? (
                  <button onClick={handleStop}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-error/90 text-white hover:bg-error transition-colors"
                    title="Stop">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="1" width="10" height="10" rx="1" /></svg>
                  </button>
                ) : (
                  <button onClick={send} disabled={!input.trim() && uploadedFiles.length === 0}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                    title="Send (Enter)">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="8" y1="2" x2="8" y2="14" /><polyline points="4,6 8,2 12,6" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-text-muted text-center mt-2">Enter to send · Drag files to upload</p>
        </div>
      </main>
    </div>
  )
}
