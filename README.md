# 🦈 DataWhale

> **AI-native data agent** — 把数据交给 Agent，而非把 Agent 嵌入数据工具。

DataWhale 是一个意图驱动的智能数据代理。你告诉它"想做什么"，它自主决定如何探索数据、执行查询、编写代码、搜索外部知识，并从每次交互中持续学习和积累经验。

---

## 目录

- [快速开始](#快速开始)
- [能力全景](#能力全景)
- [核心架构](#核心架构)
- [工具面板](#工具面板)
- [扩展系统](#扩展系统)
- [知识积累引擎](#知识积累引擎)
- [Skill 系统](#skill-系统)
- [自扩展架构](#自扩展架构)
- [观测与追踪](#观测与追踪)
- [模型路由](#模型路由)
- [CLI 参考](#cli-参考)
- [项目结构](#项目结构)
- [设计理念](#设计理念)
- [开发指南](#开发指南)
- [路线图](#路线图)

---

## 快速开始

### 环境要求

- [Bun](https://bun.sh) ≥ 1.1
- DeepSeek API Key（[申请地址](https://platform.deepseek.com)）

### 安装

```bash
git clone https://github.com/DataSky/DataWhale.git
cd DataWhale
bun install
```

### 配置

```bash
# 推荐：项目 .env 文件
cp .env.example .env
# 编辑 .env，填入 API Key：
#   DEEPSEEK_API_KEY=sk-your-key-here
#   TAVILY_API_KEY=tvly-...        # 可选，启用 web_search
#   E2B_API_KEY=e2b-...            # 可选，启用 Python 沙箱

# 或：环境变量（临时）
export DEEPSEEK_API_KEY=sk-your-key-here
```

### 使用

```bash
# 交互式对话
./dw

# 单次分析（加载数据 + 提问）
./dw -l sales.csv "分析各区域销售额排名"

# 加载多个文件
./dw -l products.csv -l sales.csv "找出最畅销的产品类别"

# 指定模型
./dw -m deepseek-pro "复杂的多维归因分析"
./dw -m deepseek-flash "快速统计行数"
```

### Web 界面

```bash
# 一键启动 Web 服务 + 浏览器打开
./dw serve

# 自定义端口
./dw serve --port 8080

# 预加载数据
./dw serve -l sales.csv
```

> 启动后访问 `http://localhost:3000`，享受暗色主题对话界面、会话管理、图表可视化。

### 全局安装（可选）

```bash
echo 'export PATH="$HOME/path/to/DataWhale:$PATH"' >> ~/.zshrc
# 之后任何目录直接: dw "问题"
```

---

## 能力全景

```
┌──────────────────────────────────────────────────────────────────────┐
│                        DataWhale v0.3.0                               │
│                                                                       │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐ │
│  │ 数据库   │  │ 数据接入  │  │ 外部能力  │  │ 智能与记忆           │ │
│  │          │  │           │  │           │  │                      │ │
│  │ SQLite   │  │ CSV/JSON  │  │ Web 搜索  │  │ 知识积累引擎         │ │
│  │ 查询引擎 │  │ 类型推断  │  │ (Tavily)  │  │ (跨会话语义记忆)     │ │
│  │ 表格渲染 │  │ 批量导入  │  │ Python 沙箱│  │ Skill 系统           │ │
│  │ 统计摘要 │  │ Schema 探索│  │ (E2B)     │  │ (工作流注入)         │ │
│  └─────────┘  └──────────┘  │ 文件导出  │  │ 模型路由             │ │
│                              └───────────┘  │ (pro/flash 动态切换) │ │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  └──────────────────────┘ │
│  │ 扩展性  │  │ 观测性   │  │ 交互       │                          │
│  │          │  │           │  │           │                          │
│  │ Extension│  │ TraceStore│  │ CLI 终端   │                          │
│  │ 动态加载 │  │ 完整链路  │  │ 流式输出   │                          │
│  │ 自扩展   │  │ 延迟追踪  │  │ 思考过程   │                          │
│  │ Agent    │  │ Token 统计│  │ 会话管理   │                          │
│  │ 创造工具 │  │           │  │ -v 详细模式│                          │
│  └─────────┘  └──────────┘  └───────────┘                          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 核心架构

```
用户输入 → CLI → Agent Runtime → AI Provider (DeepSeek V4)
                    │    ↑
                    │    │ 事件流 (思考/消息/工具调用/结果)
                    ↓    │
              ┌─────┴────┴──────┐
              │  工具执行层      │
              │  · SQL 查询      │
              │  · Python 沙箱   │
              │  · Web 搜索      │
              │  · 数据加载      │
              │  · Extension 工具 │
              └─────────────────┘
                    │
          ┌─────────┼─────────┐
          ↓         ↓         ↓
    SessionStore  TraceStore  KnowledgeStore  SkillStore
    (会话持久化)   (追踪记录)  (知识积累)      (技能注入)
```

### 五层数据持久化

| 层 | 存储 | 用途 | 生命周期 |
|----|------|------|---------|
| **SessionStore** | `~/.datawhale/sessions.db` | 会话消息历史 | 跨会话 |
| **TraceStore** | `~/.datawhale/traces.db` | 每次交互的完整链路 | 永久保留 |
| **KnowledgeStore** | `~/.datawhale/knowledge.db` | 业务语义知识 | 永久积累 |
| **SkillStore** | `~/.datawhale/skills/` | 工作流指令注入 | 文件管理 |
| **Extension** | `~/.datawhale/extensions/` | 自定义工具代码 | 文件管理 |

---

## 工具面板

Agent 可调用的完整工具集（v0.3.0）：

### 数据库工具

| 工具 | 描述 |
|------|------|
| `list_tables` | 列出数据库中所有表 |
| `describe_table` | 查看表结构（列名、类型、约束） |
| `query` | 执行 SQL 查询（仅 SELECT，自动格式化表格） |
| `get_sample` | 随机采样 N 行数据 |

### 数据接入

| 工具 | 描述 |
|------|------|
| `load_csv` | 加载 CSV 文件（自动类型推断 + 批量导入） |
| `load_json` | 加载 JSON / NDJSON 文件 |
| `summarize_table` | 列级统计摘要（计数、去重、空值、范围等） |

### 外部能力

| 工具 | 描述 |
|------|------|
| `web_search` | Tavily 搜索 API，获取结构化网页结果 |
| `execute_python` | E2B 云端 Python 沙箱（pandas/matplotlib/scipy 等） |
| `sandbox_download` | 从沙箱下载文件到本地 `~/.datawhale/plots/` |

### 自扩展

| 工具 | 描述 |
|------|------|
| `create_extension` | Agent 生成 TypeScript Extension 代码并动态加载 |
| `list_extensions` | 列出已加载和已保存的扩展 |

---

## 扩展系统

DataWhale 支持三种扩展机制，按层次递进：

| 层次 | 机制 | 格式 | 示例 |
|------|------|------|------|
| **指令层** | Skill | `SKILL.md` (YAML + Markdown) | 教 Agent "如何做数据质量检查" |
| **代码层** | Extension | TypeScript (AgentTool 接口) | 新增 `detect_anomalies` 可执行工具 |
| **服务层** | MCP Server | 进程 (stdio/HTTP) | 连接 PostgreSQL / REST API |

### Extension 示例

```typescript
// ~/.datawhale/extensions/my-tool.ts
export default {
  manifest: { id: "my-tool", name: "My Tool", version: "1.0.0" },
  tools: [{
    name: "my_tool",
    description: "Does something useful",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"]
    },
    executionMode: "sequential",
    execute: async (_id, params) => {
      return { content: `Result: ${params.input}` }
    }
  }]
}
```

Extension 在 Agent 创建后立即可用，下次启动自动加载。

---

## 知识积累引擎

DataWhale 的核心差异化能力：**越用越聪明**。

```
Session N     → agent_end → LLM 提取知识 → 存入 KnowledgeStore
Session N+1   → 检索 KnowledgeStore → 匹配关键词 → 注入 System Prompt → Agent 引用
```

### 工作原理

1. **会话结束时**：LLM（flash 模型）自动从对话中提取关键事实
   - 数据 schema（表名、列含义、类型）
   - 业务语义（枚举值含义、领域知识）
   - 数据质量观察（模式、异常、边界情况）
2. **新会话开始时**：根据用户提问自动检索相关知识
3. **注入 System Prompt**：Agent 在探索数据前已了解"这个表有哪几列、region 列是枚举值"

### 示例

```
Session 1: "sales 表有哪些列？" → 提取知识: "sales 表有 id, product_id, amount, region, sale_date"
Session 2: "分析销售额" → 检索到知识 → Agent 直接知道表结构，跳过探索步骤
```

---

## Skill 系统

Skill 是**工作流指令**——教 Agent 如何完成特定类型的任务。与 Extension（可执行代码）互补。

### Skill 格式

```markdown
---
name: data-quality-checker
description: Check data quality when exploring a new dataset.
---

# Data Quality Checker

When the user asks to validate a dataset:

1. Use `describe_table` to understand schema
2. Query missing values per column
3. Check for duplicate rows
4. Use `execute_python` for outlier detection (IQR method)
5. Present findings with severity levels
```

### 工作流

```
用户输入 → SkillStore 匹配 → 匹配的 Skill body 注入 System Prompt → Agent 遵循指令
```

### 内置 Skills

| Skill | 触发条件 |
|-------|---------|
| `skill-creator` | 用户想创建、管理、或诊断 Skill |
| `data-quality-checker` | 用户提到数据质量、缺失值、异常值 |

### 安装路径

- 用户级：`~/.datawhale/skills/<name>/SKILL.md`
- 项目级：`<project>/.datawhale/skills/<name>/SKILL.md`

使用 `./dw -v "prompt"` 可查看匹配的 Skill 列表。

---

## 自扩展架构

Agent 不仅能使用工具，**还能为自己创造工具**。

```
用户: "帮我写一个自动检测异常值的工具"
  → Agent 生成 TypeScript Extension 代码
  → 安全校验（禁止 fs/网络/进程操作）
  → 写入 ~/.datawhale/extensions/
  → 动态加载 + 激活
  → 立即调用新工具
  → 下次启动自动可用
```

### 安全边界

Extension 代码受以下限制：

- 禁止 `fs` 文件系统写入（除通过 create_extension 的受控路径）
- 禁止 `child_process` / `process.exit` / `process.kill`
- 禁止 `eval` / `Function` 构造器
- 禁止 `fetch` / `WebSocket` / `XMLHttpRequest`
- 仅允许纯函数、数学运算、数据处理

---

## 观测与追踪

每次 Agent 交互都记录完整链路到 `~/.datawhale/traces.db`：

```sql
-- 查看最近 10 条交互
SELECT event_type, tool_name, latency_ms, input_tokens, output_tokens
FROM traces ORDER BY id DESC LIMIT 10;
```

### 记录内容

| 字段 | 说明 |
|------|------|
| `event_type` | `user_msg` / `llm_call` / `tool_call` / `tool_result` / `error` / `session_start` / `session_end` |
| `model` | 使用的模型 ID |
| `latency_ms` | 延迟（毫秒） |
| `input_tokens` / `output_tokens` | Token 用量 |
| `tool_name` / `tool_args` / `tool_result_summary` | 工具调用详情 |
| `error_message` | 错误信息 |
| `content_preview` | 输出内容摘要 |

---

## 模型路由

DataWhale 内置 DeepSeek 两档动态路由，在成本和能力间自动平衡：

| 轮次 | 条件 | 模型 | 说明 |
|------|------|------|------|
| Turn 1 | 始终 | `deepseek-v4-pro` | 首轮需要理解意图，用最强模型 |
| Turn N | 消息 ≤ 80 字符 + 非分析关键词 | `deepseek-v4-flash` | 简单后续走经济模型 |
| Turn N | 消息 > 80 字符或含分析关键词 | `deepseek-v4-pro` | 复杂分析走强模型 |

支持的所有模型别名：

| 别名 | 模型 | 说明 |
|------|------|------|
| `deepseek` | `deepseek-v4-pro` | 默认，最强推理 |
| `deepseek-pro` | `deepseek-v4-pro` | 同上 |
| `deepseek-flash` | `deepseek-v4-flash` | 经济快速 |
| `deepseek-reasoner` | `deepseek-v4-flash` | 推理模式（兼容旧名） |
| `sonnet` | `claude-sonnet-4-20250514` | Anthropic |
| `haiku` | `claude-3-5-haiku-20241022` | Anthropic 快速 |
| `gpt4o` | `gpt-4o` | OpenAI |
| `gpt4o-mini` | `gpt-4o-mini` | OpenAI 快速 |

---

## CLI 参考

```
🦈 DataWhale — AI-native data agent

用法: dw [选项] [提示词]

选项:
  -m, --model <模型>     模型别名（默认: deepseek）
                          可选: deepseek, deepseek-pro, deepseek-flash,
                          deepseek-reasoner, sonnet, haiku, gpt4o, gpt4o-mini
  -l, --load <文件>       加载 CSV/JSON 文件到数据库（可重复）
  -d, --db <路径>         数据库文件路径（默认: :memory:）
  -s, --session <名称>    命名此会话，便于后续恢复
  --resume <id>           恢复之前的会话（id 或 "last"）
  --list-sessions         列出所有已保存的会话
  -v, --verbose           详细模式：显示工具调用细节 + 完整思考过程 + Skill 匹配信息
  --max-turns <n>         最大 Agent 轮次（默认: 30）
  -h, --help              显示帮助

  serve                   启动 Web 服务 + 浏览器界面
  --port <n>              Web 服务端口（默认: 3000）

环境变量:
  DEEPSEEK_API_KEY        DeepSeek API Key（必需）
  ANTHROPIC_API_KEY       Anthropic API Key（使用 Claude 时）
  OPENAI_API_KEY          OpenAI API Key（使用 GPT 时）
  TAVILY_API_KEY          Tavily 搜索 API Key（启用 web_search）
  E2B_API_KEY             E2B 沙箱 API Key（启用 execute_python）
  DW_MODEL                默认模型别名

文件:
  ~/.datawhale/sessions.db    会话持久化
  ~/.datawhale/traces.db      交互追踪
  ~/.datawhale/knowledge.db   知识积累
  ~/.datawhale/plots/         文件导出（按 sessionId 子目录隔离）
  ~/.datawhale/skills/        用户级 Skill
  ~/.datawhale/extensions/    用户级 Extension
```

### 常用示例

```bash
# 基础分析
./dw -l sales.csv "各区域销售额排名"

# 多文件联合分析
./dw -l products.csv -l sales.csv "找出平均售价最高的产品类别"

# 恢复上次会话
./dw --resume last "继续刚才的分析"

# 查看已保存的会话
./dw --list-sessions

# 详细模式（查看工具调用、Skill 匹配）
./dw -v -l sales.csv "检查数据质量"

# 交互模式
./dw
```

---

## 项目结构

```
DataWhale/
├── dw                              # CLI 启动脚本
├── .env / .env.example             # API Keys 配置
├── package.json                    # Monorepo 根配置
├── tsconfig.json
├── README.md                       # 本文档
├── DESIGN_ANALYSIS.md              # 设计分析与竞品对比
├── PHASE3_PLAN.md                  # 项目进展与路线图
├── docs/
│   ├── S3_PERSISTENCE.md           # S3/OSS 持久化方案
│   ├── VISUALIZATION_KNOWLEDGE_ROUTING_RESEARCH.md  # 可视化/知识/路由调研
│   └── DEEPSEEK_CACHE_STRATEGY.md  # DeepSeek 缓存策略
├── test/fixtures/
│   ├── products.csv                # 测试数据
│   └── sales.csv                   # 测试数据
└── packages/
    ├── ai/src/                     # AI Provider 抽象层
    │   ├── index.ts                # 统一 API、模型别名、Provider 注册
    │   └── providers/
    │       ├── openai-compatible.ts # DeepSeek / OpenAI（含 5xx 重试）
    │       └── anthropic.ts        # Anthropic Messages API
    ├── agent/src/                  # Agent Runtime
    │   ├── index.ts                # 事件驱动循环 + 工具调用 + 状态机
    │   ├── session-store.ts        # 会话持久化
    │   ├── trace-store.ts          # 交互追踪
    │   ├── knowledge-store.ts      # 知识积累引擎
    │   └── skill-store.ts          # Skill 发现/匹配/加载
    ├── tools/src/builtin/          # 内置工具
    │   ├── duckdb.ts               # SQLite 查询/探索/采样 + ASCII 表格
    │   ├── data-io.ts              # CSV/JSON 加载 + 数据摘要
    │   ├── external-tools.ts       # Tavily 搜索 + E2B 沙箱 + 文件导出
    │   └── self-extend.ts          # 自扩展系统（create/list extensions）
    ├── extensions/src/             # Extension 系统
    │   └── index.ts                # 动态加载 + 生命周期钩子
    ├── app-server/src/             # Web 后端（Hono HTTP/SSE）
    │   └── index.ts                # API 路由 + Agent 集成
    ├── web/                        # Web 前端（Next.js）
    │   ├── app/
    │   │   ├── layout.tsx          # 全局布局（暗色主题）
    │   │   ├── page.tsx            # 主页面（对话界面）
    │   │   └── globals.css         # Tailwind + 主题变量
    │   └── next.config.ts
    └── cli/                        # 命令行界面
        ├── src/
        │   ├── index.ts            # 交互/非交互 CLI + ./dw serve
        │   └── visual.ts           # ASCII 可视化工具（sparkline/barChart）
        └── test/
            ├── e2e.ts              # 端到端离线测试
            └── integration.ts      # Agent 循环集成测试
```

---

## 设计理念

DataWhale 不是一个"更强的 BI 工具"，而是一次范式转移——**从对话驱动到意图驱动**。

| 传统 BI / 数据分析工具 | DataWhale |
|-------------------------|-----------|
| 人主导每一步：选表→写SQL→看结果→再写SQL | 意图驱动：说"想了解什么"，Agent 自治探索 |
| 固定工具集，升级需等产品迭代 | 自扩展架构：Agent 自己写工具 |
| 每次分析从零开始，重复解释数据含义 | 知识积累引擎：越用越聪明 |
| 单一模型，简单任务也消耗大量 Token | 多模型动态路由：复杂用 pro，简单用 flash |
| Session 级状态，关了重来 | 跨会话持久化：知识 + 会话 + Extension 全保留 |
| 纯文本结果，无工作流记忆 | Skill 系统：教 Agent 如何完成特定工作流 |
| 交互链路不可追溯 | TraceStore：完整链路记录 |

核心设计原则：

1. **意图驱动**：Agent 理解目标，自主规划执行路径，而非被动等指令
2. **AI Native**：从底层 Provider 到上层 Skill，每一层都为 LLM 而设计
3. **自进化**：知识积累 + 自扩展 + Skill 系统，形成正向飞轮
4. **可观测**：TraceStore 记录每一次交互，支持行为分析和强化学习

详见 [DESIGN_ANALYSIS.md](./DESIGN_ANALYSIS.md)

---

## 开发指南

### 环境

```bash
cd DataWhale
bun install
```

### 运行测试

```bash
# 离线端到端测试
bun packages/cli/test/e2e.ts

# Agent 循环集成测试（需 API Key）
export DEEPSEEK_API_KEY=sk-xxx
bun packages/cli/test/integration.ts
```

### 技术栈

- **Runtime**: Bun / TypeScript
- **数据库**: SQLite (via sql.js WASM)
- **AI Provider**: DeepSeek V4 (默认) / Anthropic / OpenAI
- **Python 沙箱**: E2B Code Interpreter
- **搜索**: Tavily Search API
- **持久化**: SQLite 多库（sessions / traces / knowledge）

### 添加新工具

1. 在 `packages/tools/src/builtin/` 创建新的工具文件
2. 实现 `AgentTool` 接口（`name`、`description`、`parameters`、`execute`）
3. 在 `packages/tools/src/index.ts` 中注册导出
4. 在 `packages/cli/src/index.ts` 的 `allTools` 数组中添加

---

## 路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | Core Agent + SQLite 工具 + CLI | ✅ 完成 |
| Phase 2 | 数据接入 + 会话持久化 | ✅ 完成 |
| Phase 3 | 外部能力 + 观测性 + 知识积累 + 自扩展 + Skill 系统 | ✅ 完成 |
| Phase 4 | 多数据源连接器 (PostgreSQL/MySQL) | 🔜 规划中 |
| Phase 5 | Web UI + API 服务 | 📋 远期 |

---

## License

MIT — 详见 [LICENSE](./LICENSE)
