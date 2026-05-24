/**
 * @datawhale/ai — Unified multi-provider LLM API
 */

export interface ModelConfig {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  thinking?: "auto" | "low" | "medium" | "high" | "off"
}

export interface TextPart { type: "text"; text: string }
export interface ToolCallPart { type: "tool_call"; id: string; name: string; arguments: string }
export interface ToolResultPart { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
export type MessagePart = TextPart | ToolCallPart | ToolResultPart

export interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | MessagePart[]
  toolCallId?: string
  reasoningContent?: string
}

export interface ChatOptions {
  model: ModelConfig
  messages: Message[]
  tools?: ToolDef[]
  abortSignal?: AbortSignal
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatResult {
  content: MessagePart[]
  finishReason: "stop" | "tool_calls" | "length" | "error"
  usage?: { inputTokens: number; outputTokens: number }
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string; name: string; arguments: string }
  | { type: "finish"; finishReason: string; usage?: { inputTokens: number; outputTokens: number }; reasoningContent?: string }
  | { type: "error"; message: string }

// ─── Model Registry ───────────────────────────────────────────────────────────

const MODEL_ALIASES: Record<string, ModelConfig> = {
  // DeepSeek V4 (replaces deepseek-chat + deepseek-reasoner after 2026/07/24)
  "deepseek":       { provider: "deepseek", model: "deepseek-v4-pro" },
  "deepseek-pro":   { provider: "deepseek", model: "deepseek-v4-pro" },
  "deepseek-flash": { provider: "deepseek", model: "deepseek-v4-flash", maxTokens: 1024, temperature: 0.3 },
  "deepseek-reasoner": { provider: "deepseek", model: "deepseek-v4-flash" },
  // Anthropic
  "sonnet":      { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  "sonnet:low":  { provider: "anthropic", model: "claude-sonnet-4-20250514", thinking: "low" },
  "sonnet:high": { provider: "anthropic", model: "claude-sonnet-4-20250514", thinking: "high" },
  "haiku":       { provider: "anthropic", model: "claude-3-5-haiku-20241022" },
  // OpenAI
  "gpt4o":      { provider: "openai", model: "gpt-4o" },
  "gpt4o-mini": { provider: "openai", model: "gpt-4o-mini" },
  // Default
  "default": { provider: "deepseek", model: "deepseek-v4-flash" },
}

// ─── Provider Interface ──────────────────────────────────────────────────────

export interface Provider {
  readonly name: string
  chat(options: ChatOptions): Promise<ChatResult>
  chatStream(options: ChatOptions): AsyncIterableIterator<StreamEvent>
}

const providers = new Map<string, Provider>()

export function registerProvider(name: string, provider: Provider): void {
  providers.set(name, provider)
}

export function getProvider(name: string): Provider | undefined {
  return providers.get(name)
}

// ─── Model Resolution ────────────────────────────────────────────────────────

export function resolveModel(modelOrAlias: string, overrides?: Partial<ModelConfig>): ModelConfig {
  const resolved = MODEL_ALIASES[modelOrAlias]
  if (resolved) return { ...resolved, ...overrides }
  const slashIdx = modelOrAlias.indexOf("/")
  if (slashIdx > 0) {
    return { provider: modelOrAlias.slice(0, slashIdx), model: modelOrAlias.slice(slashIdx + 1), ...overrides }
  }
  return { provider: "deepseek", model: modelOrAlias, ...overrides }
}

// ─── Chat Client ──────────────────────────────────────────────────────────────

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const provider = providers.get(options.model.provider)
  if (!provider) throw new Error(`Unknown provider "${options.model.provider}"`)
  return provider.chat(options)
}

export async function* chatStream(options: ChatOptions): AsyncIterableIterator<StreamEvent> {
  const provider = providers.get(options.model.provider)
  if (!provider) throw new Error(`Unknown provider "${options.model.provider}"`)
  yield* provider.chatStream(options)
}

export { MODEL_ALIASES }
export { AnthropicProvider } from "./providers/anthropic.js"
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js"
