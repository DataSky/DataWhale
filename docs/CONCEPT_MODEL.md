# DataWhale 核心概念模型与架构方案

> 2026-05-25 | 系统调研 OpenCode / Claude Code / CodeWhale 架构后输出

---

## 一、核心概念定义

### 层级关系

```
Session（会话）
 └── Query（用户提问）── 1:1 映射一次用户输入
      └── Turn（轮次）── Agent 的一次 LLM 调用 + 工具执行
           └── Span（片段）── Turn 内的一个原子操作
                ├── Thinking Span（思考片段）
                ├── ToolCall Span（工具调用片段）
                └── Text Span（文本输出片段）
```

### 概念详解

| 概念 | 定义 | 类比（OpenCode） | 类比（Claude Code） |
|------|------|-----------------|-------------------|
| **Session** | 用户与 Agent 的一次完整对话生命周期 | `Session` | Conversation |
| **Query** | 用户发起的一次提问/指令，触发 Agent 执行 | `UserMessage` → Agent Loop | User turn |
| **Turn** | Agent 的一轮完整执行：LLM 推理 → 工具调用 → 结果处理 | `AgentTurn` | Assistant turn |
| **Span** | Turn 内的最小可追踪单元，有独立的开始/结束时间 | `Span`（OpenTelemetry 概念） | Step |
| **Trace** | 完整执行链路日志，包含所有 Span | `Trace` | Trace |
| **Tool** | Agent 可调用的能力单元 | `ToolDef` / `AgentTool` | Tool |
| **UserMessage** | 用户输入的内容载体 | `UserMessage` | Human message |
| **AssistantMessage** | Agent 输出的内容载体，可包含多个 Span | `AssistantMessage` | AI message |
| **ActionBar** | UI 操作区域，不属于数据模型 | — | — |
| **Result** | 工具执行或 Turn 完成的产出 | `ToolResult` | Result |

---

## 二、三个项目的设计分析

### 2.1 OpenCode（anomalyco/opencode）

**会话模型**：
```
Session
 ├── messages: Message[]
 │    ├── role: "user" | "assistant" | "system"
 │    ├── content: string | ContentBlock[]
 │    │    ├── TextBlock { type: "text", text: string }
 │    │    ├── ThinkingBlock { type: "thinking", thinking: string }
 │    │    └── ToolUseBlock { type: "tool_use", id, name, input }
 │    └── metadata: { turn, timestamp, model, usage }
 └── metadata: { title, createdAt, model }
```

**关键设计**：
- **ContentBlock 数组**：一条 assistant 消息可包含多个 block（thinking → tool_use → text → tool_use → text），自然形成交错
- **单条消息 = 一个 Turn**：assistant 消息本身就是 Turn 的完整记录
- **Tool Result 是独立消息**：role="user" + tool_result content block（为了兼容 OpenAI API）

**前端渲染**：ContentBlock 数组按顺序渲染，thinking 折叠、tool_use 卡片、text 正文。

**启示**：一条 assistant 消息应该是**完整的 Turn 记录**，包含 thinking + tool_calls + 最终文本。这是最自然的模型。

### 2.2 Claude Code（Anthropic）

**会话模型**：
```
Conversation
 ├── turns: Turn[]
 │    ├── user: UserMessage
 │    └── assistant: AssistantTurn
 │         ├── reasoning: string (optional)
 │         ├── tool_uses: ToolUse[]
 │         │    ├── id, name, input
 │         │    └── result: ToolResult
 │         └── content: TextBlock[]
 └── metadata
```

**关键设计**：
- **Turn 是顶层概念**：一次用户输入 → 一次完整回复
- **Tool Result 内联在 ToolUse 中**：不需要单独的 tool_result 消息
- **Thinking 独立于 content**：reasoning 和正文分离

**前端渲染**：
- Turn 整体包裹在背景容器中
- 用户消息在容器内右对齐
- 助手内容：reasoning 折叠 → tool 卡片 → 正文
- 每条 Turn 一个操作栏（复制、重新生成）

**启示**：Turn 是前端渲染的**自然分组单位**，用户消息属于 Turn 的一部分而非独立气泡。

### 2.3 CodeWhale（DeepSeek）

**会话模型**（从回调事件和状态推断）：
```
Session
 ├── turns: Turn[]
 │    ├── userInput: string
 │    ├── status: "thinking" | "acting" | "done"
 │    ├── messages: AgentMessage[]
 │    │    ├── role: "user" | "assistant" | "tool_result"
 │    │    ├── content: string | MessagePart[]
 │    │    ├── thinking?: string
 │    │    └── meta?: { toolCalls, reasoningContent }
 │    └── trace: Span[]
 └── metadata
```

**关键设计**：
- 事件驱动（AgentEvent），丰富的状态流
- thinking 存储在 meta 或独立字段
- tool_call 作为 content 的 part 类型

---

## 三、DataWhale 当前模型的问题

| 问题 | 根因 | 影响 |
|------|------|------|
| **消息扁平化** | 所有消息（user/assistant/tool_result）存放在一个 messages 数组中 | 渲染时需要推断分组，导致错乱 |
| **没有 Turn 概念** | assistant 消息和 tool_result 消息混在一起 | 无法确定"一条回复"的边界 |
| **content 数组 vs 字符串不一致** | 流式是字符串，存储后可能是数组 | 渲染格式差异 |
| **thinking 存储位置混乱** | 在 meta.reasoningContent 和 thinking 字段间摇摆 | 历史对话丢失 thinking |
| **tool 结果分离** | tool 结果存在独立的 tool_result 消息中 | 前后端需要额外关联逻辑 |
| **缺少 Span 抽象** | thinking/tool/text 没有统一的"片段"概念 | 前后端各自处理，风格不统一 |
| **UI 渲染和存储模型不匹配** | 前端需要 turn 分组，但后端没有 | 用索引位置 hack，脆弱 |
| **时间戳混乱** | 每个消息独立时间戳 | 一个 turn 显示多个时间 |

---

## 四、推荐方案：统一到 OpenCode/Claude 风格

### 4.1 新的数据模型

```typescript
// ── Session ──
interface Session {
  id: string
  title: string
  model: string
  queries: Query[]       // 替代扁平的 messages[]
  createdAt: number
  updatedAt: number
}

// ── Query = 一次用户提问 + Agent 完整回复 ──
interface Query {
  id: string
  userMessage: UserMessage
  assistantTurn: AssistantTurn  // 一个 Query 只有一个 Turn（简化）
                        // 或 turns: AssistantTurn[]（多轮 ReAct 时每个内部 Turn）
  createdAt: number
}

// ── UserMessage ──
interface UserMessage {
  content: string
  timestamp: number
}

// ── AssistantTurn = Agent 的完整响应 ──
interface AssistantTurn {
  spans: Span[]          // 按时间顺序排列的片段
  model: string
  usage?: { inputTokens: number; outputTokens: number }
  timestamp: number
}

// ── Span = 原子操作片段 ──
type Span = ThinkingSpan | ToolCallSpan | TextSpan

interface ThinkingSpan {
  type: "thinking"
  content: string        // 完整思考内容
  timestamp: number
}

interface ToolCallSpan {
  type: "tool_call"
  id: string
  name: string
  arguments: string
  result?: string        // 工具执行结果（内联！不存为独立消息）
  isError: boolean
  startedAt: number
  completedAt?: number
}

interface TextSpan {
  type: "text"
  content: string        // 文本内容
  timestamp: number
}
```

### 4.2 存储实现

**SQLite Schema**：
```sql
CREATE TABLE queries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_content TEXT NOT NULL,
  turn_spans TEXT NOT NULL,  -- JSON: Span[]
  model TEXT,
  usage_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

Query 的 `turn_spans` 列直接存储完整的 Span[] JSON。一条 Query 对应一个数据库行（不再拆成多条 messages）。

### 4.3 前端渲染模型

```
Query 块（背景容器）
 ├── UserMessage 气泡（右对齐，蓝紫色）
 │    └── 时间 + ✏️ 编辑（气泡下方）
 └── AssistantTurn 容器（左对齐，灰色背景）
      └── spans[] 按顺序渲染：
           ├── ThinkingSpan → 折叠面板 "Thought for Ns"
           ├── ToolCallSpan → ⏳/✓/✗ 卡片，可展开查看结果
           ├── TextSpan → Markdown 渲染
           ├── ThinkingSpan → ...
           └── TextSpan → 最终回复
      └── ActionBar（只在 Turn 末尾，仅一个）
           ├── 时间戳
           ├── 📋 复制
           └── 🔄 重新生成
```

### 4.4 迁移路径（Phase A）

**Phase A1：后端模型重构**（不动前端）
1. 新增 `queries` 表
2. 添加迁移：从 `messages` 表构建 `queries`
3. 新增 `POST /api/chat` 返回 Query 格式
4. 保留旧 API 兼容

**Phase A2：前端匹配新模型**
1. 从 `Query[]` 渲染
2. 移除 messages 推断逻辑
3. 统一 action bar

**Phase A3：清理**
1. 删除旧的 `messages` 表
2. 移除兼容代码

---

## 五、对比总结

| 维度 | 当前模型 | 新模型 |
|------|---------|--------|
| 消息组织 | 扁平 messages[] | queries[].turn.spans[] |
| 分组方式 | 前端推断（hack） | 后端直接给出 Query |
| tool 结果 | 独立 tool_result 消息 | 内联在 ToolCallSpan |
| thinking | meta 字段 | ThinkingSpan |
| 时间戳 | 每个消息独立 | Query 级别一个（+ Span 级别可选） |
| 渲染逻辑 | 排序 + 位置推断 | 简单遍历 spans[] |
| 扩展性 | 新增字段需改多处 | 新增 Span 类型即可 |

---

*建议：采纳此方案，分 Phase A1-A3 渐进迁移。核心改动集中在后端 Query/Turn/Span 模型和前端 spans[] 渲染循环。*
