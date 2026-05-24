/**
 * OpenAI-compatible API provider (DeepSeek, OpenAI, and any OpenAI-compatible endpoint).
 * 
 * DeepSeek API: https://api.deepseek.com/v1
 * Uses the standard OpenAI chat completions format with streaming.
 */

import type {
  Provider,
  ChatOptions,
  ChatResult,
  StreamEvent,
  Message,
  ToolDef,
  MessagePart,
} from "../index.js"

type OpenAIConfig = {
  apiKey?: string
  baseUrl?: string
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string
  private apiKey: string
  private baseUrl: string

  constructor(name: string, config: OpenAIConfig = {}) {
    this.name = name
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || ""
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1"
  }

  static deepseek(apiKey?: string): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider("deepseek", {
      apiKey: apiKey || process.env.DEEPSEEK_API_KEY || "",
      baseUrl: "https://api.deepseek.com/v1",
    })
  }

  static openai(apiKey?: string): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider("openai", {
      apiKey: apiKey || process.env.OPENAI_API_KEY || "",
    })
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const body = this.buildRequestBody(options, false)
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`${this.name} API error ${response.status}: ${err}`)
    }

    const data = await response.json()
    return this.parseResponse(data)
  }

  async *chatStream(options: ChatOptions): AsyncIterableIterator<StreamEvent> {
    const body = this.buildRequestBody(options, true)

    // Retry logic for transient server errors
    const maxRetries = 3
    let lastError = ""
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000)
        await new Promise((r) => setTimeout(r, delay))
      }

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: options.abortSignal,
        })

        if (!response.ok) {
          const err = await response.text()
          // Only retry on server errors (5xx), not client errors (4xx)
          if (response.status >= 500 && attempt < maxRetries - 1) {
            lastError = `${this.name} API error ${response.status}: ${err}`
            continue
          }
          yield { type: "error", message: `${this.name} API error ${response.status}: ${err}` }
          return
        }

        if (!response.body) {
          yield { type: "error", message: "No response body" }
          return
        }

        yield* this.processStream(response.body)
        return // success
      } catch (err: any) {
        if (err?.name === "AbortError") {
          yield { type: "error", message: "Request aborted" }
          return
        }
        if (attempt < maxRetries - 1) {
          lastError = err.message || String(err)
          continue
        }
        yield { type: "error", message: `Stream error after ${maxRetries} retries: ${err.message || err}` }
        return
      }
    }
    yield { type: "error", message: `Failed after ${maxRetries} retries: ${lastError}` }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  private async *processStream(body: ReadableStream<Uint8Array>): AsyncIterableIterator<StreamEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    const currentToolCalls: Map<number, { id: string; name: string; args: string }> = new Map()
    let finishReason = "stop"
    let inputTokens = 0
    let outputTokens = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith("data: ")) continue

          const jsonStr = trimmed.slice(6)
          if (jsonStr === "[DONE]") break

          try {
            const event = JSON.parse(jsonStr)
            const choice = event.choices?.[0]
            if (!choice) continue

            const delta = choice.delta

            if (delta?.content) {
              yield { type: "text_delta", text: delta.content }
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index
                if (!currentToolCalls.has(idx)) {
                  currentToolCalls.set(idx, {
                    id: tc.id || `call_${idx}`,
                    name: tc.function?.name || "",
                    args: "",
                  })
                  yield {
                    type: "tool_call_start",
                    id: currentToolCalls.get(idx)!.id,
                    name: currentToolCalls.get(idx)!.name,
                  }
                }
                const current = currentToolCalls.get(idx)!
                if (tc.function?.arguments) {
                  current.args += tc.function.arguments
                  yield { type: "tool_call_delta", id: current.id, arguments: tc.function.arguments }
                }
              }
            }

            if (choice.finish_reason) finishReason = choice.finish_reason
            if (event.usage) {
              inputTokens = event.usage.prompt_tokens || 0
              outputTokens = event.usage.completion_tokens || 0
            }
          } catch {
            // skip unparseable
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    for (const [, tc] of currentToolCalls) {
      if (tc.name) {
        yield { type: "tool_call_end", id: tc.id, name: tc.name, arguments: tc.args }
      }
    }

    yield {
      type: "finish",
      finishReason,
      usage: inputTokens > 0 ? { inputTokens, outputTokens } : undefined,
    }
  }

  private buildRequestBody(options: ChatOptions, stream: boolean) {
    const messages: Array<{ role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }> = []

    for (const msg of options.messages) {
      messages.push(this.convertMessage(msg))
    }

    const body: Record<string, unknown> = {
      model: options.model.model,
      messages,
      stream,
      max_tokens: options.model.maxTokens || 4096,
    }

    if (options.model.temperature !== undefined) {
      body.temperature = options.model.temperature
    }

    if (options.model.topP !== undefined) {
      body.top_p = options.model.topP
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    // DeepSeek supports thinking via extra_body or specific params
    // For now we don't pass it; DeepSeek models reason internally

    return body
  }

  private convertMessage(msg: Message): {
    role: string
    content: unknown
    tool_calls?: unknown
    tool_call_id?: string
  } {
    // Handle tool result messages
    if (msg.role === "tool") {
      const parts = Array.isArray(msg.content) ? msg.content : []
      const text = typeof msg.content === "string"
        ? msg.content
        : parts.map((p: any) => p.type === "text" ? p.text : p.content || "").join("\n")
      return {
        role: "tool",
        tool_call_id: msg.toolCallId || "",
        content: text,
      }
    }

    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content }
    }

    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    const toolResults: Array<Record<string, unknown>> = []

    for (const part of msg.content) {
      if (part.type === "text") {
        textParts.push(part.text)
      } else if (part.type === "tool_call") {
        toolCalls.push({
          id: part.id,
          type: "function",
          function: {
            name: part.name,
            arguments: part.arguments,
          },
        })
      } else if (part.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          content: part.content,
        })
      }
    }

    if (msg.role === "tool_result") {
      // For tool_result role, return as tool message
      if (toolResults.length > 0) {
        return toolResults[0] as any
      }
      return { role: "tool", content: textParts.join("\n") }
    }

    if (msg.role === "assistant" && toolCalls.length > 0) {
      return {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
        tool_calls: toolCalls,
      }
    }

    return { role: msg.role, content: textParts.join("\n") }
  }

  private parseResponse(data: Record<string, unknown>): ChatResult {
    const choice = (data.choices as Array<Record<string, unknown>>)?.[0]
    const message = choice?.message as Record<string, unknown> | undefined
    const content: MessagePart[] = []

    // Text content
    if (message?.content && typeof message.content === "string") {
      content.push({ type: "text", text: message.content })
    }

    // Tool calls
    const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown>
        content.push({
          type: "tool_call",
          id: tc.id as string,
          name: fn?.name as string,
          arguments: (fn?.arguments as string) || "{}",
        })
      }
    }

    let finishReason: ChatResult["finishReason"] = "stop"
    const fr = choice?.finish_reason as string
    if (fr === "tool_calls") finishReason = "tool_calls"
    else if (fr === "length") finishReason = "length"

    const usage = data.usage as Record<string, number> | undefined
    return {
      content,
      finishReason,
      usage: usage
        ? { inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 }
        : undefined,
    }
  }
}
