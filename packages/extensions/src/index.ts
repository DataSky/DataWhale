/**
 * @datawhale/extensions — Extension system for DataWhale
 * 
 * Supports:
 * - Dynamic ESM module loading (local files, npm packages, git repos)
 * - Lifecycle hooks (onLoad, onUnload, beforeTurn, afterTurn)
 * - Extension manifest with tools, prompts, and config
 */

import type { AgentTool } from "@datawhale/agent"

// ─── Extension Manifest ───────────────────────────────────────────────────────

export interface ExtensionManifest {
  /** Unique extension id */
  id: string
  /** Display name */
  name: string
  /** Version */
  version: string
  /** Description */
  description?: string
  /** Author */
  author?: string
  /** Minimum DataWhale version required */
  minVersion?: string
}

export interface ExtensionHooks {
  /** Called when extension is loaded */
  onLoad?: (ctx: ExtensionContext) => void | Promise<void>
  /** Called when extension is unloaded */
  onUnload?: (ctx: ExtensionContext) => void | Promise<void>
  /** Called before each agent turn */
  beforeTurn?: (ctx: ExtensionContext) => void | Promise<void>
  /** Called after each agent turn */
  afterTurn?: (ctx: ExtensionContext) => void | Promise<void>
}

export interface ExtensionAPI {
  /** Register a tool */
  registerTool(tool: AgentTool): void
  /** Unregister a tool */
  unregisterTool(name: string): void
  /** Get the current agent system prompt */
  getSystemPrompt(): string
  /** Append to the system prompt */
  appendSystemPrompt(text: string): void
  /** Log a message */
  log(level: "info" | "warn" | "error", message: string): void
}

export interface ExtensionContext {
  api: ExtensionAPI
  manifest: ExtensionManifest
}

export interface Extension {
  manifest: ExtensionManifest
  hooks?: ExtensionHooks
  /** Tools provided by this extension */
  tools?: AgentTool[]
  /** System prompt additions */
  promptAdditions?: string[]
  /** Called to get extension setup */
  setup?: (api: ExtensionAPI) => void | Promise<void>
}

// ─── Extension Registry ───────────────────────────────────────────────────────

export class ExtensionRegistry {
  private extensions: Map<string, Extension> = new Map()
  private activeHooks: Map<string, ExtensionHooks> = new Map()
  private tools: Map<string, AgentTool> = new Map()
  private promptAdditions: string[] = []
  private baseSystemPrompt: string = ""
  private logFn: (level: string, message: string) => void

  constructor(baseSystemPrompt: string, logFn?: (level: string, message: string) => void) {
    this.baseSystemPrompt = baseSystemPrompt
    this.logFn = logFn || (() => {})
  }

  /** Register an extension */
  register(ext: Extension): void {
    if (this.extensions.has(ext.manifest.id)) {
      throw new Error(`Extension "${ext.manifest.id}" is already registered`)
    }

    this.extensions.set(ext.manifest.id, ext)
    this.activeHooks.set(ext.manifest.id, ext.hooks || {})

    // Register tools
    if (ext.tools) {
      for (const tool of ext.tools) {
        this.tools.set(tool.name, tool)
      }
    }

    // Collect prompt additions
    if (ext.promptAdditions) {
      this.promptAdditions.push(...ext.promptAdditions)
    }

    this.logFn("info", `Extension "${ext.manifest.name}" registered`)
  }

  /** Unregister an extension */
  unregister(id: string): void {
    const ext = this.extensions.get(id)
    if (!ext) return

    // Remove tools
    if (ext.tools) {
      for (const tool of ext.tools) {
        this.tools.delete(tool.name)
      }
    }

    this.extensions.delete(id)
    this.activeHooks.delete(id)
    this.logFn("info", `Extension "${id}" unregistered`)
  }

  /** Load and activate all registered extensions */
  async activateAll(): Promise<void> {
    for (const [id, ext] of this.extensions) {
      const ctx = this.createContext(ext.manifest)

      if (ext.setup) {
        await ext.setup(ctx.api)
      }

      const hooks = this.activeHooks.get(id)
      if (hooks?.onLoad) {
        await hooks.onLoad(ctx)
      }

      this.logFn("info", `Extension "${id}" activated`)
    }
  }

  /** Deactivate all extensions */
  async deactivateAll(): Promise<void> {
    for (const [id, ext] of this.extensions) {
      const ctx = this.createContext(ext.manifest)
      const hooks = this.activeHooks.get(id)
      if (hooks?.onUnload) {
        await hooks.onUnload(ctx)
      }
    }
  }

  /** Run beforeTurn hooks for all extensions */
  async runBeforeTurnHooks(): Promise<void> {
    for (const [id, ext] of this.extensions) {
      const hooks = this.activeHooks.get(id)
      if (hooks?.beforeTurn) {
        const ctx = this.createContext(ext.manifest)
        await hooks.beforeTurn(ctx)
      }
    }
  }

  /** Run afterTurn hooks for all extensions */
  async runAfterTurnHooks(): Promise<void> {
    for (const [id, ext] of this.extensions) {
      const hooks = this.activeHooks.get(id)
      if (hooks?.afterTurn) {
        const ctx = this.createContext(ext.manifest)
        await hooks.afterTurn(ctx)
      }
    }
  }

  /** Get all tools from extensions */
  getTools(): AgentTool[] {
    return [...this.tools.values()]
  }

  /** Get the complete system prompt with extension additions */
  getSystemPrompt(): string {
    if (this.promptAdditions.length === 0) return this.baseSystemPrompt
    return this.baseSystemPrompt + "\n\n" + this.promptAdditions.join("\n\n")
  }

  /** Update the base system prompt */
  setBaseSystemPrompt(prompt: string): void {
    this.baseSystemPrompt = prompt
  }

  /** List registered extension ids */
  listIds(): string[] {
    return [...this.extensions.keys()]
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private createContext(manifest: ExtensionManifest): ExtensionContext {
    return {
      manifest,
      api: {
        registerTool: (tool: AgentTool) => {
          this.tools.set(tool.name, tool)
        },
        unregisterTool: (name: string) => {
          this.tools.delete(name)
        },
        getSystemPrompt: () => this.baseSystemPrompt,
        appendSystemPrompt: (text: string) => {
          this.promptAdditions.push(text)
        },
        log: (level, message) => {
          this.logFn(level, `[${manifest.id}] ${message}`)
        },
      },
    }
  }
}

// ─── Dynamic Extension Loader ─────────────────────────────────────────────────

export interface LoadOptions {
  /** File path (relative or absolute) */
  path?: string
  /** npm package name */
  package?: string
  /** Git repository URL */
  git?: string
  /** Inline extension definition */
  inline?: Extension
}

export async function loadExtension(options: LoadOptions): Promise<Extension> {
  if (options.inline) {
    return options.inline
  }

  if (options.path) {
    const path = options.path.startsWith("/") || options.path.startsWith(".")
      ? options.path
      : `./${options.path}`

    const mod = await import(path)
    if (typeof mod.default === "object") {
      return mod.default as Extension
    }
    if (mod.manifest) {
      return mod as Extension
    }
    throw new Error(`Extension at "${path}" does not export a valid extension`)
  }

  if (options.package) {
    // Load from npm package
    const mod = await import(options.package)
    if (typeof mod.default === "object") {
      return mod.default as Extension
    }
    throw new Error(`Package "${options.package}" does not export a valid extension`)
  }

  throw new Error("No valid extension source provided")
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { AgentTool }
