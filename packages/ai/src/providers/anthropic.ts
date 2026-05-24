/**
 * Anthropic Messages API provider implementation.
 * 
 * Uses native fetch (Bun) with streaming support.
 * API docs: https://docs.anthropic.com/en/api/messages
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

export class AnthropicProvider implements Provider {
  readonly name = "anthropic"

  private apiKey: string
  private baseUrl: string

  constructor(apiKey?: string, baseUrl = "https://api.anthropic.com/v1") {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || ""
    this.baseUrl = baseUrl
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const body = this.buildRequestBody(options)
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Anthropic API error ${response.status}: ${err}`)
    }

    const data = await response.json()
    return this.parseResponse(data)
  }

  async *chatStream(options: ChatOptions): AsyncIterableIterator<StreamEvent> {
    const body = this.buildRequestBody(options)
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...body, stream: true }),
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const err = await response.text()
      yield { type: "error", message: `Anthropic API error ${response.status}: ${err}` }
      return
    }

    if (!response.body) {
      yield { type: "error", message: "No response body" }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    let currentToolId = ""
    let currentToolName = ""
    let currentToolArgs = ""

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
          if (jsonStr === "[DONE]") {
            yield {
              type: "finish",
              finishReason: "stop",
            }
            return
          }

          try {
            const event = JSON.parse(jsonStr)

            switch (event.type) {
              case "message_start":
                // Initial event, we can track usage here
                break

              case "content_block_start":
                if (event.content_block?.type === "text") {
                  // text block starting
                } else if (event.content_block?.type === "tool_use") {
                  currentToolId = event.content_block.id
                  currentToolName = event.content_block.name
                  currentToolArgs = ""
                  yield {
                    type: "tool_call_start",
                    id: currentToolId,
                    name: currentToolName,
                  }
                }
                break

              case "content_block_delta":
                if (event.delta?.type === "text_delta") {
                  yield {
                    type: "text_delta",
                    text: event.delta.text,
                  }
                } else if (event.delta?.type === "input_json_delta") {
                  currentToolArgs += event.delta.partial_json
                  yield {
                    type: "tool_call_delta",
                    id: currentToolId,
                    arguments: event.delta.partial_json,
                  }
                }
                break

              case "content_block_stop":
                if (currentToolId) {
                  yield {
                    type: "tool_call_end",
                    id: currentToolId,
                    name: currentToolName,
                    arguments: currentToolArgs,
                  }
                  currentToolId = ""
                  currentToolName = ""
                  currentToolArgs = ""
                }
                break

              case "message_delta":
                yield {
                  type: "finish",
                  finishReason: event.delta?.stop_reason || "stop",
                  usage: event.usage
                    ? {
                        inputTokens: event.usage.input_tokens,
                        outputTokens: event.usage.output_tokens,
                      }
                    : undefined,
                }
                break

              case "error":
                yield {
                  type: "error",
                  message: event.error?.message || "Unknown Anthropic error",
                }
                return
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    }
  }

  private buildRequestBody(options: ChatOptions) {
    const systemMessages: string[] = []
    const chatMessages: Array<{ role: string; content: unknown }> = []

    for (const msg of options.messages) {
      if (msg.role === "system") {
        systemMessages.push(
          typeof msg.content === "string" ? msg.content : this.extractText(msg.content)
        )
      } else {
        chatMessages.push(this.convertMessage(msg))
      }
    }

    const body: Record<string, unknown> = {
      model: options.model.model,
      max_tokens: options.model.maxTokens || 4096,
      messages: chatMessages,
    }

    if (systemMessages.length > 0) {
      body.system = systemMessages.join("\n\n")
    }

    if (options.model.temperature !== undefined) {
      body.temperature = options.model.temperature
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(convertTool)
    }

    // Thinking configuration
    if (options.model.thinking === "high") {
      body.thinking = { type: "enabled", budget_tokens: 4096 }
    } else if (options.model.thinking === "medium") {
      body.thinking = { type: "enabled", budget_tokens: 2048 }
    } else if (options.model.thinking === "low") {
      body.thinking = { type: "enabled", budget_tokens: 1024 }
    }

    return body
  }

  private convertMessage(msg: Message): { role: string; content: unknown } {
    if (msg.role === "tool") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
          : String(msg.content)
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.toolCallId || "",
          content: text,
        }],
      }
    }

    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content }
    }

    const blocks: Array<Record<string, unknown>> = []
    const toolResults: Array<Record<string, unknown>> = []

    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text })
      } else if (part.type === "tool_call") {
        blocks.push({
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: JSON.parse(part.arguments),
        })
      } else if (part.type === "tool_result") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: part.content,
          is_error: part.isError || false,
        })
      }
    }

    if (msg.role === "user" && toolResults.length > 0) {
      return { role: "user", content: toolResults }
    }

    return { role: msg.role, content: blocks }
  }

  private parseResponse(data: Record<string, unknown>): ChatResult {
    const content: MessagePart[] = []
    let finishReason: ChatResult["finishReason"] = "stop"

    const stopReason = data.stop_reason as string
    if (stopReason === "tool_use") finishReason = "tool_calls"
    else if (stopReason === "max_tokens") finishReason = "length"

    for (const block of (data.content as Array<Record<string, unknown>>) || []) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text as string })
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_call",
          id: block.id as string,
          name: block.name as string,
          arguments: JSON.stringify(block.input),
        })
      }
    }

    const usage = data.usage as Record<string, number> | undefined
    return {
      content,
      finishReason,
      usage: usage
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : undefined,
    }
  }

  private extractText(parts: MessagePart[]): string {
    return parts.filter((p) => p.type === "text").map((p) => (p as TextPart).text).join("\n")
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function convertTool(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: tool.parameters.properties || {},
      required: tool.parameters.required || [],
    },
  }
}

// Need TextPart for extractText
import type { TextPart } from "../index.js"
