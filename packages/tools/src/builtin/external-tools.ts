/**
 * External service tools — Tavily Web Search + E2B Code Sandbox
 * 
 * Provides AgentTools for:
 * - web_search: Tavily search API for real-time web knowledge
 * - execute_python: E2B sandbox for safe Python execution
 */

import type { AgentTool } from "@datawhale/agent"

// ─── Session context (set by CLI before agent runs) ──────────────────────────

let _sessionId = "default"

export function setSessionContext(sessionId: string): void {
  if (_sessionId !== sessionId) {
    _sessionId = sessionId
    _workspaceInitialized = false  // new session → re-init workspace
  }
}

// ─── Artifact emitter (set by app-server so tools can emit artifact events) ──

type ArtifactEmitter = (event: {
  type: string
  artifactId: string
  artifactType?: string
  title?: string
  delta?: string
}) => void

let _emitArtifact: ArtifactEmitter | null = null

export function setArtifactEmitter(emitter: ArtifactEmitter): void {
  _emitArtifact = emitter
}

// ─── Tavily Web Search ────────────────────────────────────────────────────────

const webSearchTool: AgentTool = {
  name: "web_search",
  description:
    "Search the web for current information using Tavily. Returns structured results with titles, URLs, and content snippets. Use this for facts, news, or knowledge beyond your training data. Always cite sources (URL + title) when using results.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Be specific and use keywords for best results.",
      },
      max_results: {
        type: "number",
        description: "Number of results to return (default: 5, max: 10)",
      },
      search_depth: {
        type: "string",
        description: "Search depth: 'basic' (faster) or 'advanced' (deeper, more content)",
      },
    },
    required: ["query"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const apiKey = process.env.TAVILY_API_KEY || ""
    if (!apiKey) throw new Error("TAVILY_API_KEY not configured. Add it to .env file.")

    const query = params.query as string
    const maxResults = Math.min((params.max_results as number) || 5, 10)
    const searchDepth = (params.search_depth as string) || "basic"

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
        include_images: false,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Tavily search failed (${response.status}): ${err}`)
    }

    const data = (await response.json()) as any
    const answer = data.answer as string | undefined
    const results = (data.results || []) as Array<{
      title: string; url: string; content: string; score: number
    }>

    let output = `Search results for: "${query}"\n`
    if (answer) {
      output += `\nAnswer: ${answer}\n`
    }
    output += `\nFound ${results.length} result(s):\n\n`

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      output += `${i + 1}. ${r.title}\n`
      output += `   URL: ${r.url}\n`
      output += `   ${r.content.slice(0, 300)}${r.content.length > 300 ? "..." : ""}\n\n`
    }

    return {
      content: output,
      details: { query, resultCount: results.length, hasAnswer: !!answer },
    }
  },
}

// ─── E2B Code Sandbox ─────────────────────────────────────────────────────────

let _sandbox: any = null
let _sandboxPromise: Promise<any> | null = null
let _sandboxCreatedAt = 0
let _sandboxId: string | null = null
const SANDBOX_MAX_AGE_MS = 25 * 60 * 1000 // 25 min (E2B default timeout is 30min)
const STATE_FILE = `${process.env.HOME || "~"}/.datawhale/sandbox-state.json`

// ─── Session workspace (per-session isolation in sandbox) ─────────────────────
// Structure: /data_agent/sessions/{sessionId}/outputs/generated/
const SANDBOX_BASE = "/data_agent"
let _workspaceInitialized = false

function workspaceDir(): string {
  return `${SANDBOX_BASE}/sessions/${_sessionId}`
}
function outputDir(): string {
  return `${workspaceDir()}/outputs/generated`
}
function uploadDir(): string {
  return `${workspaceDir()}/upload`
}
function tempDir(): string {
  return `${workspaceDir()}/temp`
}

async function ensureSessionWorkspace(sandbox: any): Promise<void> {
  if (_workspaceInitialized) return
  const code = `
import os
base = "${SANDBOX_BASE}"
dirs = [
    "${outputDir()}",
    "${uploadDir()}",
    "${tempDir()}",
]
for d in dirs:
    os.makedirs(d, exist_ok=True)
# Create a symlink for backward compatibility so /tmp/agent_output points to the session dir
link_path = "/tmp/agent_output"
if not os.path.exists(link_path):
    try:
        os.symlink("${outputDir()}", link_path)
    except:
        pass  # symlink may already exist or not supported
print("workspace ready: " + "${outputDir()}")
`
  try {
    const r = await sandbox.runCode(code, { timeoutMs: 5000 })
    _workspaceInitialized = true
  } catch (e) {
    // Non-fatal — workspace creation failed but sandbox still usable
  }
}

/** Reset workspace flag when session changes */
export function resetWorkspace(): void {
  _workspaceInitialized = false
}

// Load saved sandboxId from disk
async function loadSavedSandboxId(): Promise<string | null> {
  try {
    const fs = await import("node:fs")
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))
      return data.sandboxId || null
    }
  } catch {}
  return null
}

async function saveSandboxId(id: string): Promise<void> {
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const dir = path.dirname(STATE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sandboxId: id, savedAt: Date.now() }))
  } catch {}
}

async function clearSandboxId(): Promise<void> {
  try {
    const fs = await import("node:fs")
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
  } catch {}
}

async function getSandbox(): Promise<any> {
  const now = Date.now()

  // Check existing in-memory sandbox
  if (_sandbox && (now - _sandboxCreatedAt) < SANDBOX_MAX_AGE_MS) {
    try {
      await _sandbox.runCode("1+1", { timeoutMs: 5000 })
      return _sandbox
    } catch {
      // Sandbox died or expired — clear and recreate below
      _sandbox = null
      _sandboxPromise = null
      await clearSandboxId()
    }
  }

  if (_sandboxPromise) return _sandboxPromise

  _sandboxPromise = (async () => {
    const { Sandbox } = await import("@e2b/code-interpreter")
    const apiKey = process.env.E2B_API_KEY || ""
    if (!apiKey) throw new Error("E2B_API_KEY not configured.")

    // Try to resume a paused sandbox from a previous session
    const savedId = await loadSavedSandboxId()
    if (savedId && !_sandbox) {
      try {
        _sandbox = await Sandbox.connect(savedId)
        _sandboxId = savedId
        _sandboxCreatedAt = Date.now()
        // Quick health check
        await _sandbox.runCode("1+1")
        // Ensure workspace is ready (may have been created by previous session)
        await ensureSessionWorkspace(_sandbox)
        return _sandbox
      } catch {
        // Resume failed — saved sandbox expired or killed, create new
        await clearSandboxId()
      }
    }

    // Create new sandbox
    _sandbox = await Sandbox.create({ apiKey, timeoutMs: 1800_000 })
    _sandboxId = _sandbox.sandboxId
    _sandboxCreatedAt = Date.now()

    // Auto-mount OSS if configured
    await mountOSSInit(_sandbox)

    // Initialize session workspace directory structure
    await ensureSessionWorkspace(_sandbox)

    // Persist the sandboxId for future sessions
    await saveSandboxId(_sandboxId)

    return _sandbox
  })()

  return _sandboxPromise
}

/** Pause sandbox (preserves files + memory for later resume) */
export async function pauseSandbox(): Promise<void> {
  if (_sandbox && _sandboxId) {
    try {
      await _sandbox.betaPause()
      await saveSandboxId(_sandboxId)
    } catch {
      // Fallback: just kill
      try { await _sandbox.kill() } catch {}
      await clearSandboxId()
    }
    _sandbox = null
    _sandboxPromise = null
  }
}

/** Kill sandbox (destroy everything — for explicit cleanup) */
export async function closeSandbox(): Promise<void> {
  if (_sandbox) {
    try { await _sandbox.kill() } catch {}
    _sandbox = null
    _sandboxPromise = null
    _sandboxCreatedAt = 0
    _sandboxId = null
  }
  await clearSandboxId()
}

const sandboxExecTool: AgentTool = {
  name: "sandbox_exec",
  description:
    "Execute code in a secure cloud sandbox (E2B). 🔴 FATAL: Never embed raw HTML strings in the code parameter — " +
    "quotes/newlines in HTML break JSON → 'Failed to parse tool arguments'. Build HTML with Python string concatenation.\n" +
    "• python (default): Python 3 with pandas, numpy, matplotlib, scipy, scikit-learn.\n" +
    "• bash: Shell commands — use only for simple one-liners (heredoc/multiline may fail with 422).\n" +
    "CWD = session output dir — relative paths auto-resolve. Sandbox persists 30min. " +
    "For matplotlib, use plt.savefig('plot.png'). " +
    "⚠️ HTML: ONE call to generate entire HTML. Build in Python variables, write once with open('f','w'). " +
    "NEVER split across calls (open('f','w') clears file each time). " +
    "ECharts CDN: cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js",
  parameters: {
    type: "object",
    properties: {
      execution_type: {
        type: "string",
        description: "Execution mode: 'python' (default) or 'bash' (shell commands)",
        enum: ["python", "bash"],
      },
      code: {
        type: "string",
        description: "Code to execute. Python: source code (use print() for output). Bash: shell command.",
      },
      timeout: {
        type: "number",
        description: "Execution timeout in seconds (default: 60, max: 300)",
      },
      install_packages: {
        type: "string",
        description: "(python only) Comma-separated pip packages to install before running (e.g., 'seaborn,scipy')",
      },
    },
    required: ["code"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const execType = (params.execution_type as string) || "python"
    const code = params.code as string
    const timeout = Math.min((params.timeout as number) || 60, 300)

    let sandbox = await getSandbox()

    // Ensure workspace is ready for this session
    await ensureSessionWorkspace(sandbox)

    // ── Retry wrapper: if sandbox dies mid-execution, reconnect once ──
    const executeWithRetry = async (fn: (sb: any) => Promise<any>) => {
      try {
        return await fn(sandbox)
      } catch (e: any) {
        // Sandbox connection lost — invalidate and recreate
        _sandbox = null
        _sandboxPromise = null
        try { sandbox = await getSandbox() } catch {
          throw e  // re-connection failed, surface original error
        }
        await ensureSessionWorkspace(sandbox)
        return await fn(sandbox)  // retry once
      }
    }
    if (execType === "bash") {
      try {
        const result = await sandbox.commands.run(code, {
          timeoutMs: timeout * 1000,
          onStdout: () => {},
          onStderr: () => {},
        })
        const stdout = result?.stdout || ""
        const stderr = result?.stderr || ""
        const exitCode = result?.exitCode
        let output = ""
        if (stdout.trim()) output += `stdout:\n${stdout.trim()}\n`
        if (stderr.trim()) output += `stderr:\n${stderr.trim()}\n`
        if (exitCode !== 0) output += `exit code: ${exitCode}\n`
        if (!output) output = "(no output)"
        return { content: output, details: { executionType: "bash", exitCode } }
      } catch (e: any) {
        return { content: `bash error: ${e?.message || e}`, details: { executionType: "bash", error: e?.message } }
      }
    }

    // ── Python mode: existing logic ──

    // Clean up old session files (older than this session: files with timestamps
    // before session start are from previous sessions sharing the same sandbox)
    const NOW = Date.now()
    try {
      await sandbox.runCode(
        `import os, time, shutil
now = time.time()
# Clean /tmp (backward compat)
for f in os.listdir('/tmp'):
    fp = f'/tmp/{f}'
    if os.path.isfile(fp) and not f.startswith('systemd') and not f.startswith('.'):
        if now - os.path.getmtime(fp) > 1800:
            try: os.remove(fp)
            except: pass
# Clean other session dirs older than 30 min
base = '${SANDBOX_BASE}/sessions'
if os.path.exists(base):
    for sd in os.listdir(base):
        sp = os.path.join(base, sd)
        if os.path.isdir(sp) and sd != '${_sessionId}':
            try:
                st = os.stat(sp)
                if now - st.st_mtime > 1800:
                    shutil.rmtree(sp, ignore_errors=True)
            except: pass
`, { timeoutMs: 5000 })
    } catch {}

    // Snapshot existing files (path→size) before execution — only export new or changed files
    let preSnapshot: Record<string, number> = {}
    try {
      const snapshotCode = `
import os, json
files = {}
for d in ["${outputDir()}", "/tmp"]:
    try:
        for f in os.listdir(d):
            fp = os.path.join(d, f)
            if os.path.isfile(fp) and not f.startswith('systemd') and not f.startswith('.'):
                files[fp] = os.path.getsize(fp)
    except: pass
print(json.dumps(files))
`
      const snapResult = await sandbox.runCode(snapshotCode, { timeoutMs: 5000 })
      preSnapshot = JSON.parse(((snapResult.logs?.stdout || []) as string[]).join("").trim() || "{}")
    } catch {}

    // Cd to session output directory so relative paths work naturally
    try {
      await sandbox.runCode(`import os; os.chdir("${outputDir()}")`, { timeoutMs: 2000 })
    } catch {}

    // Install packages if needed
    const installPkgs = (params.install_packages as string) || ""
    if (installPkgs) {
      const pkgs = installPkgs.split(",").map((p) => p.trim()).filter(Boolean)
      if (pkgs.length > 0) {
        await sandbox.runCode(`!pip install -q ${pkgs.join(" ")}`, { timeoutMs: 60000 })
      }
    }

    // Run the code (with automatic retry on connection loss)
    const execution = await executeWithRetry((sb: any) => sb.runCode(code, {
      timeoutMs: timeout * 1000,
      onStdout: () => {},
      onStderr: () => {},
    }))

    const stdout = (execution.logs?.stdout || []).join("") || ""
    const stderr = (execution.logs?.stderr || []).join("") || ""
    const error = execution.error?.value || ""

    let output = ""
    if (stdout.trim()) output += `stdout:\n${stdout.trim()}\n`
    if (stderr.trim()) output += `stderr:\n${stderr.trim()}\n`
    if (error) output += `error:\n${error}\n`
    if (!output) output = "(no output)"

    // ── Export generated files from sandbox to local ─────────────────────
    const savedFiles: string[] = []
    const baseDir = `${process.env.HOME || "~"}/.datawhale/plots`
    const exportDir = `${baseDir}/${_sessionId}`
    const ts = Date.now()

    try {
      const fs = await import("node:fs")
      const pathMod = await import("node:path")
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true })

      // Scan session workspace directory (primary) + /tmp (backward compat)
      // Export only new files OR files whose size changed (content was modified)
      // preSnapshot maps path → size; if a file existed before with same size, skip it.
      const scanPaths = [
        { sandboxDir: outputDir(), source: "workspace" },
        { sandboxDir: "/tmp", source: "tmp" },
      ]

      let fileIndex = 0
      for (const sp of scanPaths) {
        try {
          const lsCode = `import os, json; d="${sp.sandboxDir}"; files=[]; 
[files.append((f, os.path.getsize(os.path.join(d,f)))) for f in sorted(os.listdir(d)) if os.path.isfile(os.path.join(d,f)) and not f.startswith('systemd') and not f.startswith('.') and not f.startswith('tmp')];
print(json.dumps(files))`
          const lsResult = await sandbox.runCode(lsCode, { timeoutMs: 5000 })
          const raw = ((lsResult.logs?.stdout || []) as string[]).join("").trim()
          let fileEntries: Array<[string, number]> = []
          try { fileEntries = JSON.parse(raw) } catch {}

          for (const [fname, currentSize] of fileEntries) {
            const sandboxPath = `${sp.sandboxDir}/${fname}`
            // Skip files that existed unchanged (same path AND same size as before)
            if (preSnapshot[sandboxPath] !== undefined && preSnapshot[sandboxPath] === currentSize) continue
            try {
              const localName = `${ts}_${fileIndex + 1}_${fname}`
              fileIndex++
              const localPath = pathMod.join(exportDir, localName)
              const bytes = await sandbox.files.read(sandboxPath, { format: "bytes" })
              fs.writeFileSync(localPath, Buffer.from(bytes))
              savedFiles.push(localPath)
            } catch {}
          }
        } catch {}
      }
    } catch {}

    const details: Record<string, unknown> = {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      error: error || undefined,
      savedFiles: savedFiles.length > 0 ? savedFiles : undefined,
    }

    // Truncate long output
    const maxLen = 4000
    if (output.length > maxLen) {
      output = output.slice(0, maxLen) + `\n... (truncated, ${output.length} chars total)`
    }

    if (savedFiles.length > 0) {
      const imageExts = /\.(png|jpe?g|gif|svg|webp)$/i
      const htmlExt = /\.html?$/i
      const imageFiles = savedFiles.filter(f => imageExts.test(f))
      const htmlFiles = savedFiles.filter(f => htmlExt.test(f))
      const otherFiles = savedFiles.filter(f => !imageExts.test(f) && !htmlExt.test(f))
      output += "\n"
      for (const f of imageFiles) {
        const name = f.split("/").pop()!
        output += `\n![${name}](/api/files/${_sessionId}/${name})`
      }
      // Emit artifact events for .html files so frontend renders them inline
      const htmlArtifacts: Array<{ id: string; title: string; fileUrl: string }> = []
      for (const f of htmlFiles) {
        const name = f.split("/").pop()!
        const fileUrl = `/api/files/${_sessionId}/${name}`
        output += `\n📄 [${name}](${fileUrl}) (HTML artifact — rendered inline)`
        const artId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        htmlArtifacts.push({ id: artId, title: name, fileUrl })
        if (_emitArtifact) {
          _emitArtifact({ type: "artifact_start", artifactId: artId, artifactType: "html", title: name, fileUrl })
          _emitArtifact({ type: "artifact_end", artifactId: artId })
        }
      }
      if (htmlArtifacts.length > 0) {
        (details as any).htmlArtifacts = htmlArtifacts
      }
      if (otherFiles.length > 0) {
        output += `\n\n📄 ${otherFiles.length} data file(s) saved (use /api/files/ links to re-read):`
        for (const f of otherFiles) {
          const name = f.split("/").pop()!
          output += `\n  → [${name}](/api/files/${_sessionId}/${name})`
        }
      }
    }

    // Warn if stdout mentions HTML/dashboard/report but no .html files were exported
    const stdoutLower = stdout.toLowerCase()
    if ((stdoutLower.includes("html") || stdoutLower.includes("dashboard") || stdoutLower.includes("report"))
        && !savedFiles.some(f => /\.html?$/i.test(f))) {
      output += `\n⚠️ HTML file mentioned in output but not found in /tmp/. Ensure files are saved to /tmp/ directory.`
    }

    // Sandbox workspace file index — show session directory structure
    try {
      const sandbox = await getSandbox()
      const lsCode = `
import os
out_dir = "${outputDir()}"
tmp_dir = "/tmp"
lines = []
# Session workspace
if os.path.exists(out_dir):
    for f in sorted(os.listdir(out_dir)):
        fp = os.path.join(out_dir, f)
        if os.path.isfile(fp):
            sz = os.path.getsize(fp)
            lines.append(f"workspace/{f} ({sz} bytes)")
# /tmp (backward compat, exclude system files)
for f in sorted(os.listdir(tmp_dir)):
    fp = os.path.join(tmp_dir, f)
    if os.path.isfile(fp) and not f.startswith('systemd') and not f.startswith('.'):
        sz = os.path.getsize(fp)
        lines.append(f"/tmp/{f} ({sz} bytes)")
for l in lines[:15]:
    print(l)
if len(lines) > 15:
    print(f"... and {len(lines)-15} more")
`
      const lsResult = await sandbox.runCode(lsCode, { timeoutMs: 5000 })
      const stdout = ((lsResult.logs?.stdout || []) as string[]).join("").trim()
      if (stdout) {
        const lines = stdout.split("\n").filter(Boolean)
        output += `\n📁 Sandbox workspace files (${lines.length}):\n`
        for (const line of lines) output += `  → ${line}\n`
      }
    } catch {}

    return { content: output, details }
  },
}

// ─── Sandbox File Download Tool ─────────────────────────────────────────────

const sandboxDownloadTool: AgentTool = {
  name: "sandbox_download",
  description:
    "Download a file from the sandbox session workspace. Use this when Python generated CSV, JSON, Excel, or other data files. Files are saved to ~/.datawhale/plots/{session}/.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file in the sandbox. Relative paths resolve to your session output directory (e.g., 'results.csv' or 'report.html'). Absolute paths also work (e.g., '/tmp/data.csv').",
      },
    },
    required: ["path"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    let filePath = params.path as string
    // Resolve relative paths to session output directory
    if (!filePath.startsWith("/")) {
      filePath = `${outputDir()}/${filePath}`
    }
    const sb = await getSandbox()

    // Read as bytes — works for all file types
    const bytes = await sb.files.read(filePath, { format: "bytes" })
    const size = bytes.byteLength

    // Save locally
    const fs = await import("node:fs")
    const pathMod = await import("node:path")
    const exportDir = `${process.env.HOME || "~"}/.datawhale/plots`
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true })

    const filename = pathMod.basename(filePath)
    const localPath = pathMod.join(exportDir, filename)
    fs.writeFileSync(localPath, Buffer.from(bytes))

    return {
      content: `Downloaded ${filePath} → ${localPath} (${size} bytes)`,
      details: { sandboxPath: filePath, localPath, size },
    }
  },
}

// ─── Read Local File Tool ────────────────────────────────────────────────────

const readLocalFileTool: AgentTool = {
  name: "read_local_file",
  description:
    "Read a previously-exported file from the local plots directory (~/.datawhale/plots/). " +
    "Use this when you need to re-read a file that was generated in a previous sandbox_exec call " +
    "(e.g., report.md, results.csv). The sessionId is automatically provided. " +
    "All files exported by sandbox_exec are stored under ~/.datawhale/plots/{sessionId}/.",
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description: "Filename to read (e.g., '1779722706025_2_report.md'). Use sandbox_list to find exact names.",
      },
    },
    required: ["filename"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const filename = params.filename as string
    const fs = await import("node:fs")
    const pathMod = await import("node:path")
    const baseDir = `${process.env.HOME || "~"}/.datawhale/plots`
    const filePath = pathMod.join(baseDir, _sessionId || "", filename)

    if (!fs.existsSync(filePath)) {
      // List available files for the session to help the agent
      const dir = pathMod.join(baseDir, _sessionId || "")
      let listing = ""
      try {
        const files = fs.readdirSync(dir)
        listing = "\nAvailable files: " + files.join(", ")
      } catch {}
      return {
        content: `File not found: ${filePath}${listing}`,
        details: { error: "not_found" },
      }
    }

    const content = fs.readFileSync(filePath, "utf-8")
    const stat = fs.statSync(filePath)
    const maxLen = 8000
    const truncated = content.length > maxLen
    const text = truncated ? content.slice(0, maxLen) + `\n... (truncated, ${content.length} chars total)` : content

    return {
      content: `📄 ${filename} (${stat.size} bytes):\n\n${text}`,
      details: { path: filePath, size: stat.size, truncated },
    }
  },
}

// ─── OSS Mount (Aliyun / S3-compatible) ────────────────────────────────────

async function mountOSSInit(sandbox: any): Promise<void> {
  const bucket = process.env.OSS_BUCKET
  const endpoint = process.env.OSS_ENDPOINT
  const accessKey = process.env.OSS_ACCESS_KEY
  const secretKey = process.env.OSS_SECRET_KEY
  if (!bucket || !accessKey) return

  try {
    // Install s3fs via commands.run (system shell, not Python)
    await sandbox.commands.run("apt-get update -qq && apt-get install -y -qq s3fs", { timeoutMs: 120000 })
  } catch {
    // s3fs may already be installed or installation failed — continue anyway
  }

  try {
    // Write credentials
    await sandbox.files.write("/root/.passwd-s3fs", `${accessKey}:${secretKey}`)
    await sandbox.commands.run("chmod 600 /root/.passwd-s3fs && mkdir -p /mnt/oss", { timeoutMs: 5000 })

    const url = endpoint || "https://oss-cn-beijing.aliyuncs.com"
    // Mount OSS via s3fs (using endpoint for Aliyun OSS compatibility)
    await sandbox.commands.run(
      `s3fs ${bucket} /mnt/oss -o passwd_file=/root/.passwd-s3fs -o url=${url} -o allow_other -o use_path_request_style`,
      { timeoutMs: 15000 }
    )
  } catch (e: any) {
    // OSS mount failed — non-blocking, log quietly
  }
}

const mountOSSTool: AgentTool = {
  name: "sandbox_mount_oss",
  description:
    "Mount Aliyun OSS bucket to the sandbox session directory for persistent storage. " +
    "Data written to the oss mount is persisted and shared between sessions. " +
    "The mount path is available in your session workspace.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  executionMode: "sequential",
  execute: async () => {
    const sb = await getSandbox()
    try {
      const result = await sb.commands.run("mount | grep oss || echo 'not-mounted'", { timeoutMs: 5000 })
      const stdout = (result?.stdout || "").trim()
      if (stdout && !stdout.includes("not-mounted")) {
        return { content: `OSS already mounted:\n${stdout.slice(0, 300)}` }
      }
      // Not mounted — try again
      await mountOSSInit(sb)
      const result2 = await sb.commands.run("mount | grep oss || echo 'not-mounted'", { timeoutMs: 5000 })
      const stdout2 = (result2?.stdout || "").trim()
      if (stdout2 && !stdout2.includes("not-mounted")) {
        return { content: `OSS mounted successfully:\n${stdout2.slice(0, 300)}` }
      }
      return { content: "OSS mount attempted. Check /mnt/oss/ and run sandbox_mount_oss again if needed." }
    } catch (e: any) {
      return { content: `OSS mount error: ${e?.message?.slice(0, 200) || e}` }
    }
  },
}

// ─── List Workspace Files ───────────────────────────────────────────────────

const listWorkspaceFilesTool: AgentTool = {
  name: "list_workspace_files",
  description:
    "List files in the session workspace. Your output files (HTML, CSV, images etc.) are in the session directory " +
    "which is also your current working directory. Use to discover files from previous sandbox_exec runs.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Optional filename filter, e.g. '.csv' for only CSV files",
      },
    },
    required: [],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const pattern = (params.pattern as string) || ""
    try {
      const sb = await getSandbox()
      const code = `
import os
base = "${outputDir()}"
tmp = "/tmp"
results = []
for d, label in [(base, "workspace"), (tmp, "/tmp")]:
    try:
        for f in sorted(os.listdir(d)):
            fp = os.path.join(d, f)
            if os.path.isfile(fp) and not f.startswith('systemd') and not f.startswith('.') and not f.startswith('tmp'):
                ${pattern ? `if "${pattern}".lower() in f.lower():` : ""}
                sz = os.path.getsize(fp)
                results.append(f"{label}/{f} ({sz} bytes)")
    except: pass
for r in results[:25]:
    print(r)
if len(results) > 25:
    print(f"... and {len(results)-25} more")
`
      const lsResult = await sb.runCode(code, { timeoutMs: 5000 })
      const stdout = ((lsResult.logs?.stdout || []) as string[]).join("").trim()
      if (!stdout) return { content: "No files found in session workspace." }
      const lines = stdout.split("\n").filter(Boolean)
      let output = `${pattern ? "Matching" : "Session workspace"} files:\n`
      for (const line of lines) output += `  → ${line}\n`
      output += `\nYour working directory is the session output dir. Use relative paths: open("filename.html","w")`
      return { content: output }
    } catch (e: any) {
      return { content: `Failed to list sandbox files: ${e?.message || e}` }
    }
  },
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const ExternalTools = {
  all: [webSearchTool, sandboxExecTool, sandboxDownloadTool, readLocalFileTool, mountOSSTool] as AgentTool[],
  webSearch: webSearchTool,
  sandboxExec: sandboxExecTool,
  executePython: sandboxExecTool,  // backward compat alias
  listWorkspaceFiles: listWorkspaceFilesTool,
  sandboxDownload: sandboxDownloadTool,
  readLocalFile: readLocalFileTool,
  closeSandbox,
  pauseSandbox,
  getSandbox,
}