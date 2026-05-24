/**
 * Self-extending tools — Agent can create its own tools
 * 
 * Implements the "Agent writes Extension" loop:
 * 1. Agent generates TypeScript Extension code
 * 2. Code is validated and written to ~/.datawhale/extensions/
 * 3. Extension is dynamically loaded and activated
 * 4. Agent's tool list is updated to include the new tool
 */

import type { AgentTool } from "@datawhale/agent"
import { ExtensionRegistry, loadExtension } from "@datawhale/extensions"

// ─── Security validation ────────────────────────────────────────────────────

const FORBIDDEN_PATTERNS = [
  /child_process/,
  /process\.exit/,
  /process\.kill/,
  /fs\.(writeFile|unlink|rmdir|rm|mkdir|chmod|chown|rename|symlink|truncate)/,
  /fs\.(createWriteStream|createReadStream|open|readdir)/,
  /eval\s*\(/,
  /Function\s*\(/,
  /new\s+Function/,
  /WebSocket/,
  /XMLHttpRequest/,
]

function validateCode(code: string): string | null {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return `Forbidden pattern detected: ${pattern.source}`
    }
  }
  return null
}

// ─── Registry reference (set by CLI) ──────────────────────────────────────

let _extensionRegistry: ExtensionRegistry | null = null
let _agentSetTools: ((tools: AgentTool[]) => void) | null = null

export function setSelfExtendContext(
  registry: ExtensionRegistry,
  setTools: (tools: AgentTool[]) => void
): void {
  _extensionRegistry = registry
  _agentSetTools = setTools
}

// ─── create_extension tool ──────────────────────────────────────────────────

const createExtensionTool: AgentTool = {
  name: "create_extension",
  description:
    "Create a new DataWhale Extension (tool) from TypeScript code. Extensions add new capabilities to DataWhale. After creation, the extension is automatically loaded and available for use. Use this when the user asks for a new tool, or when you identify a reusable capability that would help in future sessions.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique extension id (e.g. 'anomaly-detector', 'data-formatter'). Lowercase, hyphens only.",
      },
      description: {
        type: "string",
        description: "Human-readable description of the extension.",
      },
      tool_name: {
        type: "string",
        description: "Name of the main AgentTool this extension provides (e.g. 'detect_anomalies').",
      },
      tool_description: {
        type: "string",
        description: "What the tool does, when to use it, and what parameters it needs.",
      },
      code: {
        type: "string",
        description:
          `Complete TypeScript source code for the extension. Must export a default object with:
manifest: { id: string, name: string, version: string }
tools: Array of { name, description, parameters (JSON Schema), executionMode: "sequential", execute: async (id, params) => { content: string } }

IMPORTANT: execute() must return { content: "result string" }, not a plain string.
Do NOT import anything. The code runs in a restricted environment.
Example:
export default {
  manifest: { id: "my-tool", name: "My Tool", version: "1.0.0" },
  tools: [{
    name: "my_tool",
    description: "Does something useful",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    executionMode: "sequential",
    execute: async (id: string, params: Record<string, unknown>) => {
      return { content: "Result: " + params.input }
    }
  }]
}`,
      },
    },
    required: ["name", "description", "tool_name", "tool_description", "code"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const name = (params.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const code = params.code as string

    // Security check
    const violation = validateCode(code)
    if (violation) {
      return { content: `❌ Security check failed: ${violation}. Remove the forbidden API and try again.` }
    }

    // Check extension registry is available
    if (!_extensionRegistry || !_agentSetTools) {
      return { content: "⚠️ Extension system not initialized. Cannot create extensions in this session." }
    }

    try {
      // Write extension file
      const extDir = `${process.env.HOME || "~"}/.datawhale/extensions`
      const fs = await import("node:fs")
      const path = await import("node:path")
      if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true })

      const filePath = path.join(extDir, `${name}.ts`)
      fs.writeFileSync(filePath, code, "utf-8")

      // Try to load it via the extension system
      const ext = await loadExtension({ path: filePath })

      // Register and activate
      _extensionRegistry.register(ext)
      await _extensionRegistry.activateAll()

      // Update agent's tools
      const allTools = _extensionRegistry.getTools()
      _agentSetTools(allTools)

      return {
        content: `✅ Extension "${name}" created and activated!\n\n` +
          `File: ${filePath}\n` +
          `Tool: ${params.tool_name}\n` +
          `Status: Loaded and ready to use. Call ${params.tool_name} in your next step.`,
      }
    } catch (err: any) {
      return {
        content: `❌ Failed to load extension: ${err.message}\n\n` +
          `The code was saved but may have errors. Check:\n` +
          `- Are all imports valid?\n` +
          `- Does the AgentTool implement the correct interface?\n` +
          `- Is the Extension default export correct?`,
        details: { error: err.message },
      }
    }
  },
}

// ─── list_extensions tool ──────────────────────────────────────────────────

const listExtensionsTool: AgentTool = {
  name: "list_extensions",
  description: "List all currently loaded extensions and their tools. Use this to discover what custom capabilities are available.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  executionMode: "sequential",
  execute: async () => {
    if (!_extensionRegistry) {
      return { content: "No extensions loaded (extension system not initialized)." }
    }

    const ids = _extensionRegistry.listIds()
    if (ids.length === 0) {
      return { content: "No extensions loaded. Use create_extension to add new capabilities." }
    }

    const tools = _extensionRegistry.getTools()
    let output = `Loaded ${ids.length} extension(s):\n`
    for (const id of ids) {
      const extTools = tools.filter(() => true) // would need individual ext tool listing
      const builtinNames = ["list_tables", "describe_table", "query", "get_sample", "load_csv", "load_json", "summarize_table", "web_search", "execute_python", "sandbox_download"]
      const customTools = tools.filter((t) => !builtinNames.includes(t.name))
      output += `\n  ${id}` + (customTools.length > 0 ? ` (tools: ${customTools.map(t => t.name).join(", ")})` : "")
    }

    // Also check filesystem for saved extensions
    const extDir = `${process.env.HOME || "~"}/.datawhale/extensions`
    try {
      const fs = await import("node:fs")
      if (fs.existsSync(extDir)) {
        const files = fs.readdirSync(extDir).filter((f) => f.endsWith(".ts"))
        if (files.length > 0) {
          output += `\n\nSaved extension files (load on next restart): ${files.join(", ")}`
        }
      }
    } catch {}

    return { content: output }
  },
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const SelfExtendTools = {
  all: [createExtensionTool, listExtensionsTool] as AgentTool[],
  createExtension: createExtensionTool,
  listExtensions: listExtensionsTool,
  setSelfExtendContext,
}
