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
  _sessionId = sessionId
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
      await _sandbox.runCode("1+1")
      return _sandbox
    } catch {
      _sandbox = null
      _sandboxPromise = null
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

const executePythonTool: AgentTool = {
  name: "execute_python",
  description:
    "Execute Python code in a secure cloud sandbox (E2B). Supports pandas, numpy, matplotlib, scipy, scikit-learn. " +
    "Generated images (PNG/JPEG from matplotlib etc.) are stored in the sandbox and reported. " +
    "The sandbox persists for 30 minutes — you can run multiple code cells and share data between them via the /tmp directory. " +
    "Always use print() for text output. For matplotlib plots, use plt.savefig('/tmp/plot.png') to save images. " +
    "⚠️ HTML OUTPUT: The system auto-detects .html files in /tmp/ (e.g., /tmp/dashboard.html) and renders them as interactive artifact cards " +
    "in the conversation. This supports ANY size HTML — no LLM token limits. Use this for complex dashboards, ECharts visualizations, " +
    "and data-rich reports. Always write HTML files to /tmp/ directory. " +
    "For persistent storage, write files to /mnt/oss/ (Aliyun OSS bucket — automatically mounted).",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "Python source code to execute. Always use print() for output you want to see.",
      },
      timeout: {
        type: "number",
        description: "Execution timeout in seconds (default: 60, max: 300)",
      },
      install_packages: {
        type: "string",
        description: "Comma-separated list of pip packages to install before running (optional, e.g. 'seaborn,scipy')",
      },
    },
    required: ["code"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const code = params.code as string
    const timeout = Math.min((params.timeout as number) || 60, 300)

    const sandbox = await getSandbox()

    // Clean up old sandbox files (> 30 min old) to prevent accumulation
    try {
      await sandbox.runCode(
        "import os, time; now=time.time(); [os.remove(f'/tmp/{f}') for f in os.listdir('/tmp') if os.path.isfile(f'/tmp/{f}') and now - os.path.getmtime(f'/tmp/{f}') > 1800 and not f.startswith('systemd') and not f.startswith('.')]",
        { timeoutMs: 5000 }
      )
    } catch {}

    // Install packages if needed
    const installPkgs = (params.install_packages as string) || ""
    if (installPkgs) {
      const pkgs = installPkgs.split(",").map((p) => p.trim()).filter(Boolean)
      if (pkgs.length > 0) {
        await sandbox.runCode(`!pip install -q ${pkgs.join(" ")}`, { timeoutMs: 60000 })
      }
    }

    // Run the code
    const execution = await sandbox.runCode(code, {
      timeoutMs: timeout * 1000,
      onStdout: () => {},
      onStderr: () => {},
    })

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
      // List all user files in /tmp (exclude system files)
      const lsResult = await sandbox.runCode(
        `import os; [print(f) for f in sorted(os.listdir('/tmp')) if os.path.isfile(f'/tmp/{f}') and not f.startswith('systemd') and not f.startswith('.') and not f.startswith('tmp')]`,
        { timeoutMs: 5000 }
      )
      const tmpList = ((lsResult.logs?.stdout || []) as string[])
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)

      if (tmpList.length > 0) {
        const fs = await import("node:fs")
        const pathMod = await import("node:path")
        if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true })

        for (let i = 0; i < tmpList.length; i++) {
          try {
            const fname = tmpList[i]
            const sandboxPath = `/tmp/${fname}`
            // Add timestamp prefix to avoid intra-session name collisions
            const localName = `${ts}_${i + 1}_${fname}`
            const localPath = pathMod.join(exportDir, localName)
            const bytes = await sandbox.files.read(sandboxPath, { format: "bytes" })
            fs.writeFileSync(localPath, Buffer.from(bytes))
            savedFiles.push(localPath)
          } catch {}
        }
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

    // Sandbox workspace file index
    try {
      const sandbox = await getSandbox()
      const lsResult = await sandbox.runCode(
        "import os; [print(f'{f} ({os.path.getsize(os.path.join(\"/tmp\",f))} bytes)') for f in sorted(os.listdir('/tmp')) if os.path.isfile(os.path.join('/tmp',f)) and not f.startswith('systemd') and not f.startswith('.')]",
        { timeoutMs: 5000 }
      )
      const stdout = ((lsResult.logs?.stdout || []) as string[]).join("").trim()
      if (stdout) {
        const lines = stdout.split("\n").filter(Boolean)
        output += `\n📁 Sandbox workspace files (${lines.length}):\n`
        for (const line of lines.slice(0, 10)) output += `  → /tmp/${line}\n`
        if (lines.length > 10) output += `  ... and ${lines.length - 10} more\n`
      }
    } catch {}

    return { content: output, details }
  },
}

// ─── Sandbox File Download Tool ─────────────────────────────────────────────

const sandboxDownloadTool: AgentTool = {
  name: "sandbox_download",
  description:
    "Download a file from the E2B sandbox to your local machine. Use this when Python generated CSV, JSON, Excel, or other data files that you want to access locally. Files are saved to ~/.datawhale/plots/.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Full path to the file in the sandbox (e.g., /tmp/results.csv)",
      },
    },
    required: ["path"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const filePath = params.path as string
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
    "Use this when you need to re-read a file that was generated in a previous execute_python call " +
    "(e.g., report.md, results.csv). The sessionId is automatically provided. " +
    "All files exported by execute_python are stored under ~/.datawhale/plots/{sessionId}/.",
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

// ─── Generate HTML Artifact Tool ─────────────────────────────────────────────

const generateHtmlTool: AgentTool = {
  name: "generate_html",
  description:
    "Generate a small interactive HTML artifact and stream it to the frontend. " +
    "The HTML will appear as an embedded card in the conversation that the user " +
    "can expand to fullscreen or open in a separate tab. " +
    "⚠️ TOKEN LIMIT: Only use this for HTML under ~2500 characters — the HTML is sent as a tool parameter " +
    "and limited by LLM output tokens. For larger HTML (dashboards, complex charts, data-heavy reports), " +
    "use execute_python to write the file to /tmp/xxx.html instead — it has no size limit and auto-renders. " +
    "Include complete <style> and <script> tags — the HTML runs in a sandboxed iframe. " +
    "For charts, prefer using ECharts (CDN: https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js).",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title for the artifact card (e.g., 'Sales Dashboard')",
      },
      html: {
        type: "string",
        description: "Complete HTML content (with <style> and <script> tags). Must be self-contained.",
      },
    },
    required: ["title", "html"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const title = params.title as string
    const html = params.html as string
    const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

    if (_emitArtifact) {
      _emitArtifact({ type: "artifact_start", artifactId, artifactType: "html", title })
      // Stream in chunks so the frontend can show progressive loading
      const chunkSize = 4096
      for (let i = 0; i < html.length; i += chunkSize) {
        _emitArtifact({ type: "artifact_delta", artifactId, delta: html.slice(i, i + chunkSize) })
      }
      _emitArtifact({ type: "artifact_end", artifactId })
    }

    return {
      content: `✅ HTML artifact "${title}" generated (${html.length} chars). The user can view, expand, or open it in a separate tab.`,
      details: { artifactId, title, artifactType: "html", artifactHtml: html, size: html.length },
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
    "Mount Aliyun OSS bucket to /mnt/oss in the sandbox. Data written to /mnt/oss is persisted to OSS. Use this for long-term file storage or sharing data between sessions.",
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
    "List files in the sandbox workspace (/tmp). Use to discover CSV/JSON/images from previous execute_python runs. Avoids redundant SQL queries — if full data is saved to sandbox, analyze it directly with execute_python instead of re-running queries.",
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
      const code = pattern
        ? "import os; [print(f + ' (' + str(os.path.getsize('/tmp/'+f)) + ' bytes)') for f in sorted(os.listdir('/tmp')) if os.path.isfile('/tmp/'+f) and '" + pattern + "' in f.lower() and not f.startswith('systemd') and not f.startswith('.')]"
        : "import os; [print(f + ' (' + str(os.path.getsize('/tmp/'+f)) + ' bytes)') for f in sorted(os.listdir('/tmp')) if os.path.isfile('/tmp/'+f) and not f.startswith('systemd') and not f.startswith('.')]"
      const lsResult = await sb.runCode(code, { timeoutMs: 5000 })
      const stdout = ((lsResult.logs?.stdout || []) as string[]).join("").trim()
      if (!stdout || stdout === "[]") return { content: "No files found in sandbox workspace (/tmp)." }
      const lines = stdout.split("\n").filter(Boolean)
      let output = `${pattern ? "Matching" : "Sandbox workspace"} files (${lines.length}):\n`
      for (const line of lines.slice(0, 20)) output += `  → /tmp/${line}\n`
      if (lines.length > 20) output += `  ... and ${lines.length - 20} more\n`
      output += `\nAccess with execute_python: pd.read_csv('/tmp/filename.csv')`
      return { content: output }
    } catch (e: any) {
      return { content: `Failed to list sandbox files: ${e?.message || e}` }
    }
  },
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const ExternalTools = {
  all: [webSearchTool, executePythonTool, sandboxDownloadTool, readLocalFileTool, generateHtmlTool, mountOSSTool] as AgentTool[],
  webSearch: webSearchTool,
  executePython: executePythonTool,
  listWorkspaceFiles: listWorkspaceFilesTool,
  sandboxDownload: sandboxDownloadTool,
  readLocalFile: readLocalFileTool,
  closeSandbox,
  pauseSandbox,
}