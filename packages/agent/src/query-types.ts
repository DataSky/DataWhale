/**
 * @datawhale/agent — Span & Query types
 * 
 * Session → Query → Turn → Span 四级模型
 * 定义来自 docs/CONCEPT_MODEL.md
 */

// ─── Span Types ──────────────────────────────────────────────────────────

export type Span = ThinkingSpan | ToolCallSpan | TextSpan

export interface ThinkingSpan {
  type: "thinking"
  content: string
  startedAt: number
  completedAt?: number
}

export interface ToolCallSpan {
  type: "tool_call"
  id: string
  name: string
  arguments: string
  result?: string
  isError: boolean
  startedAt: number
  completedAt?: number
}

export interface TextSpan {
  type: "text"
  content: string
  startedAt: number
  completedAt?: number
}

// ─── Query Types ─────────────────────────────────────────────────────────

export interface Query {
  id: string
  sessionId: string
  userContent: string
  spans: Span[]
  model: string
  usage?: { inputTokens: number; outputTokens: number }
  createdAt: number
}

// ─── Helper: build a Query from collected spans ──────────────────────────

export function makeQuery(opts: {
  sessionId: string
  userContent: string
  spans: Span[]
  model?: string
  usage?: { inputTokens: number; outputTokens: number }
}): Query {
  return {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sessionId: opts.sessionId,
    userContent: opts.userContent,
    spans: opts.spans,
    model: opts.model || "unknown",
    usage: opts.usage,
    createdAt: Date.now(),
  }
}
