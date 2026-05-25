/**
 * @datawhale/tools — Tool registry and built-in tools
 * 
 * Provides:
 * - Tool registry for managing discoverable tools
 * - Built-in DuckDB tools (list_tables, describe_table, query, get_sample)
 * - Utility for creating tools from functions
 */

import type { AgentTool } from "@datawhale/agent"

// ─── Tool Registry ────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, AgentTool> = new Map()

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  list(): AgentTool[] {
    return [...this.tools.values()]
  }

  /** Get all tools matching a category pattern */
  listByCategory(category: string): AgentTool[] {
    return this.list().filter((t) => {
      const cat = (t as any).category
      return cat === category
    })
  }

  /** Remove all tools */
  clear(): void {
    this.tools.clear()
  }
}

// ─── Tool Builder ─────────────────────────────────────────────────────────────

export interface ToolBuilderConfig {
  name: string
  description: string
  parameters: Record<string, unknown>
  executionMode?: "sequential" | "parallel"
  execute: AgentTool["execute"]
}

export function defineTool(config: ToolBuilderConfig): AgentTool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    executionMode: config.executionMode,
    execute: config.execute,
  }
}

// ─── DuckDB Tools ─────────────────────────────────────────────────────────────

import { DuckDBTools } from "./builtin/duckdb.js"
import { DataIOTools } from "./builtin/data-io.js"
import { ExternalTools, setSessionContext, setArtifactEmitter } from "./builtin/external-tools.js"
import { SelfExtendTools } from "./builtin/self-extend.js"

export { DuckDBTools, DataIOTools, ExternalTools, SelfExtendTools, setSessionContext, setArtifactEmitter }
export type { AgentTool }
