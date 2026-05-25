# DataWhale 项目结构分析报告

> 生成日期：2026-05-25 | 分析范围：全部 packages、docs、tests

---

## SUMMARY

DataWhale（v0.1.0 / 实际 v0.3.0）是一个 **AI-native 数据分析 Agent**，采用 Bun + TypeScript 的 7 包 monorepo 架构。项目已实现事件驱动的 Agent 引擎、13 个内置工具（SQL/Python/Web 搜索/数据加载/自扩展）、以及四层数据持久化（Session/Trace/Knowledge/Skill）。支持 CLI 终端交互和 Web（Next.js + Hono/SSE）两种界面模式。

**核心亮点**：事件驱动架构完整、流式思考展示已实现、DeepSeek V4 缓存策略已优化、Query/Turn/Span 新数据模型已启动。

**核心问题**：新旧数据模型双轨运行导致存储碎片化、多个 sql.js 实例竞争同一数据库文件的风险、CLI 入口和 Web 前端模块过大（均为 500+ 行单文件）、知识提取逻辑在 CLI 和 app-server 中重复实现。

---

## CHANGES

### 需要立即处理的问题

| 优先级 | 问题 | 影响范围 | 建议行动 |
|--------|------|---------|---------|
| 🔴 高 | SessionStore 和 QueryStore 共享 `sessions.db` 但独立管理 sql.js 实例 | agent, app-server, cli | 创建统一的 DBConnectionManager 单例，确保同一文件只有一个 sql.js 实例 |
| 🔴 高 | 新旧数据模型双轨：SessionStore 用 messages 表 / QueryStore 用 queries 表，前端从 messages 读取 | 前后端数据一致性 | 决定主模型（推荐 Query/Span），迁移 SessionStore 或废弃旧 messages 表 |
| 🔴 高 | 知识提取逻辑完全重复：CLI（`extractKnowledge`）和 app-server（SSE 内联）各实现一遍 | agent, cli, app-server | 提取为 `@datawhale/agent` 的共享方法 `extractAndStoreKnowledge` |
| 🟡 中 | `cli/src/index.ts` 932 行，职责过多（参数解析/环境/Agent 构建/知识提取/交互） | CLI 可维护性 | 拆分为 cli/config.ts + cli/agent-builder.ts + cli/interactive.ts |
| 🟡 中 | `web/app/page.tsx` 504 行单文件，包含全量路由+状态+SSE+样式 | Web 可维护性 | 拆分为 ChatArea / SessionSidebar / SSEStreamParser 等组件 |
| 🟡 中 | 查询缓存（DuckDB）60 秒 TTL 无数据变更感知 | tools/duckdb | load_csv/load_json 后清空缓存 |
| 🟡 中 | 自扩展安全仅靠正则黑名单（可绕过 `eval("ev"+"al")`） | tools/self-extend | 改用 AST 级别安全分析 或 仅允许在受限 E2B 沙箱中运行 |
| 🟢 低 | E2B 沙箱 Pause 14 天过期 | tools/external-tools | 已记录 S3 兜底方案，需实现自动重建 |
| 🟢 低 | app-server 配置 PUT 端点无 size limit | app-server | 添加 body size 限制和字段白名单 |
| 🟢 低 | 缺少 CI/CD 和完整测试套件 | 全局 | 添加 GitHub Actions + vitest 替换手写断言 |

### 架构优化建议（非紧急）

1. **统一数据库连接池**：当前 5 个 Store 各维护自己的 sql.js 实例，建议引入 DatabaseManager 单例
2. **引入依赖注入**：Store 实例在 CLI/app-server 中各自 new，建议通过工厂函数或 context 传递
3. **类型提取为独立包**：`@datawhale/agent` 导出的类型（AgentTool, AgentEvent, Span, Query 等）被 4 个包依赖，建议提取为 `@datawhale/types`
4. **Web 前端引入状态管理库**：当前全用 useState/useRef/useMemo，复杂交互下状态散落

---

## EVIDENCE

### 1. 架构全貌

```
DataWhale Monorepo（Bun workspace）
├── @datawhale/ai          → LLM Provider 抽象（DeepSeek/Anthropic/OpenAI）
│   └── 3 文件 / 600 行：index.ts + openai-compatible.ts + anthropic.ts
├── @datawhale/agent       → Agent 引擎 + 5 个 Store
│   └── 7 文件 / 1600 行：index.ts(690行) + session-store.ts + trace-store.ts
│       + knowledge-store.ts + skill-store.ts + query-store.ts + query-types.ts
├── @datawhale/tools       → 4 组内置工具
│   └── duckdb.ts(294行) + data-io.ts(415行) + external-tools.ts(458行) + self-extend.ts(211行)
├── @datawhale/extensions  → 扩展系统
│   └── index.ts(268行) — ExtensionRegistry + loadExtension
├── @datawhale/cli         → 终端入口
│   └── index.ts(932行) + visual.ts(89行) + 3 测试文件
├── @datawhale/app-server  → Web 服务端
│   └── index.ts(366行) — Hono + SSE + REST API
└── @datawhale/web         → Next.js 前端
    └── page.tsx(504行) + layout.tsx + dashboard/page.tsx + settings/page.tsx
```

### 2. 数据模型双轨（CONCEPT_MODEL.md 中已明确诊断）

旧模型（仍在使用）:
```typescript
// SessionStore 中的 messages 表
{ role: "user" | "assistant" | "tool_result", content, thinking, meta }
// 所有消息扁平存储，无 Turn/Span 概念
```

新模型（已实现但未全面接入）:
```typescript
// QueryStore 中的 queries 表
{ id, session_id, user_content, spans_json, model, usage_json }
// Span = ThinkingSpan | ToolCallSpan | TextSpan
```

**现状**：app-server 同时调用 `sessionStore.saveMessages()`（旧）和 `queryStore.saveQuery()`（新），导致同一会话数据写入两个位置。Web 前端仅从旧 messages 表读取。

### 3. sql.js 实例竞争（关键文件证据）

5 个 Store 各自调用 `initSqlJs()` → `new SQL.Database()`:

- `SessionStore` → `sessions.db` (`~/.datawhale/sessions.db`)
- `QueryStore` → `sessions.db`（同一文件！）
- `TraceStore` → `traces.db`
- `KnowledgeStore` → `knowledge.db`

SessionStore 和 QueryStore 写入同一文件但使用不同的 sql.js 实例。每次 `save()` 用 `fs.writeFileSync` 全量覆盖，后写者覆盖先写者。

### 4. 重复的知识提取逻辑

CLI 中的 `extractKnowledge`（packages/cli/src/index.ts:207-300，约 95 行）:
```typescript
// 构建会话摘要 → 调用 deepseek-flash → 解析 JSON → knowledgeStore.add()
```

app-server 中内联的实现（packages/app-server/src/index.ts:158-190，约 33 行）:
```typescript
// 完全相同的逻辑，不同的代码
```

唯一差异：CLI 版本有更完善的 JSON 解析容错（处理 markdown 代码块和单对象格式），app-server 版本较简单。

### 5. 文件大小指标

| 文件 | 行数 | 职责数 |
|------|------|--------|
| cli/src/index.ts | 932 | 6+ (参数/环境/注册/Agent/知识/交互) |
| agent/src/index.ts | 690 | 3 (类型/事件循环/工具执行) |
| web/app/page.tsx | 504 | 5+ (路由/状态/SSE/样式/上传) |
| tools/data-io.ts | 415 | 4 (CSV 解析/JSON 解析/类型推断/加载) |
| tools/external-tools.ts | 458 | 3 (搜索/沙箱/文件下载) |

---

## RISKS

| 风险 | 严重度 | 触发条件 | 影响 |
|------|--------|----------|------|
| **数据损坏**：SessionStore 和 QueryStore 同时写入 sessions.db | 🔴 高 | 每次 Web 聊天（SSE 回调中两者同时写） | 会话数据静默丢失或 message/queries 不匹配 |
| **内存泄漏**：5 个 sql.js 实例常驻内存 | 🟡 中 | 长时间运行（Web 服务模式） | 随会话数增加，内存线性增长 |
| **缓存毒化**：DuckDB 查询缓存不感知数据变更 | 🟡 中 | load_csv 后紧接着 query | 返回旧数据（0 行结果或过时 schema） |
| **安全绕过**：自扩展正则黑名单可被拼接绕过 | 🟡 中 | 恶意或幻觉代码生成 | 执行意外代码（但当前仅限于 TypeScript 工具声明，无直接 shell 访问） |
| **会话孤岛**：Web 端会话通过 SSE 聊天创建，CLI 端独立创建，两者不共享实时状态 | 🟢 低 | 同时使用 CLI 和 Web | 同一会话两个入口写入可能导致覆盖 |
| **配置注入**：app-server `PUT /api/config` 接受任意 key-value 写入 | 🟢 低 | 恶意请求 | 可注入任意 JSON key，但仅写入用户本地 config.json |

---

## BLOCKERS

**当前无阻塞 v0.3.0 核心运行的问题**（Agent 引擎 + 13 工具 + CLI + Web 可正常运作）。

但上述三个 🔴 P0 风险（数据库双写覆盖、新旧模型双轨、知识提取重复）**阻断新功能开发**。详见 PHASE3_PLAN.md § Phase 3.5：P0 修复必须在可视化/知识积累/自扩展之前完成。

以下为 P0 修复完成后的高价值功能（非当前 blocker）：

1. **可视化图表生成**（PHASE3_PLAN 标记 ⭐⭐⭐⭐, 0.5天）—— ASCII 表格/sparkline 已有 `cli/src/visual.ts` 实现但可能未充分接入
2. **知识积累引擎升级**（⭐⭐⭐⭐⭐, 3天）—— 当前基于 SQL LIKE 关键词匹配，计划升级到 LanceDB 向量搜索
3. **模型路由策略**—— AgentConfig 中有 `modelRouter` 钩子但当前未使用，所有请求由单一模型处理
4. **Web 端的仪表盘和设置页面**已创建文件但内容待完善
