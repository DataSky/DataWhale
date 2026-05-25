/**
 * @datawhale/agent — Query / Turn / Span 类型定义
 * 
 * Session → Query → Turn → Span 四级模型
 * 来自 docs/CONCEPT_MODEL.md
 */

// ─── Span — 原子操作片段 ──────────────────────────────────────────────────

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

// ─── Turn — Agent 一轮完整执行（LLM → 工具 → 结果） ──────────────────────

export interface Turn {
  spans: Span[]
  startedAt: number
  completedAt?: number
}

// ─── Query — 用户一次提问 + Agent 完整回复 ────────────────────────────────

export interface Query {
  id: string
  sessionId: string
  userContent: string
  turns: Turn[]
  model: string
  usage?: { inputTokens: number; outputTokens: number }
  createdAt: number
}

// ─── Helper ────────────────────────────────────────────────────────────────

export function makeQuery(opts: {
  sessionId: string
  userContent: string
  turns?: Turn[]
  model?: string
  usage?: { inputTokens: number; outputTokens: number }
}): Query {
  return {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: opts.sessionId,
    userContent: opts.userContent,
    turns: opts.turns || [],
    model: opts.model || "unknown",
    usage: opts.usage,
    createdAt: Date.now(),
  }
}

/** Create a Turn from spans */
export function makeTurn(spans: Span[]): Turn {
  return {
    spans,
    startedAt: spans.length > 0 ? spans[0].startedAt : Date.now(),
    completedAt: spans.length > 0 ? spans[spans.length - 1].completedAt || Date.now() : Date.now(),
  }
}
