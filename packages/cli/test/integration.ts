/**
 * DeepSeek Agent loop integration test
 * Run: DEEPSEEK_API_KEY=sk-xxx bun test/integration.ts
 */

import { Agent } from "@datawhale/agent"
import { OpenAICompatibleProvider, registerProvider } from "@datawhale/ai"
import type { AgentEvent, AgentTool } from "@datawhale/agent"

registerProvider("deepseek", OpenAICompatibleProvider.deepseek())

// Calculator tool
const calcTool: AgentTool = {
  name: "calculate",
  description: "Perform a mathematical calculation. Use this for any math.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: 'Math expression to evaluate, e.g. "2 + 2 * 3"',
      },
    },
    required: ["expression"],
  },
  executionMode: "sequential",
  execute: async (_id, params) => {
    const expr = params.expression as string
    try {
      const result = eval(expr)
      return { content: `Result: ${expr} = ${result}` }
    } catch (e) {
      return { content: `Error evaluating "${expr}"`, details: { isError: true } }
    }
  },
}

async function main() {
  const agent = new Agent({
    systemPrompt:
      "You are a helpful assistant with a calculate tool. Always use the tool for any math calculation. Reply concisely.",
    model: "deepseek",
    tools: [calcTool],
    maxTurns: 5,
    temperature: 0.1,
  })

  let text = ""
  agent.subscribe((e: AgentEvent) => {
    if (e.type === "message_update") {
      text += e.delta
      process.stdout.write(e.delta)
    } else if (e.type === "tool_call_start") {
      process.stdout.write(`\n[TOOL: ${e.toolName}]`)
    } else if (e.type === "tool_call_end") {
      process.stdout.write(e.result.isError ? " FAIL" : " OK")
      process.stdout.write("\n")
    }
  })

  console.log("Q: What is 123 * 456 + 789?\n")

  const state = await agent.prompt("What is 123 * 456 + 789?")
  console.log("\n---")
  console.log("Turns:", state.turnCount)
  console.log("Status:", state.status)

  if (state.status === "done" && text.includes("56877")) {
    console.log("PASS: Agent correctly used tool and got right answer")
    process.exit(0)
  } else if (state.status === "done") {
    console.log("PARTIAL: Agent completed but answer may be wrong")
    process.exit(0)
  } else {
    console.log("FAIL: Agent did not complete successfully")
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
