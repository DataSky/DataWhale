# DataWhale Web 产品技术方案

> 版本: 1.0 | 2026-05-24 | 基于 OmniData 参考 + 当前代码完成度

---

## 目录

1. [现状分析](#一现状分析)
2. [Web 产品定位](#二web-产品定位)
3. [交互范式设计](#三交互范式设计)
4. [可视化系统](#四可视化系统)
5. [技术架构](#五技术架构)
6. [前后端通信协议](#六前后端通信协议)
7. [组件树与页面路由](#七组件树与页面路由)
8. [与 CLI 的共存策略](#八与-cli-的共存策略)
9. [分阶段实施计划](#九分阶段实施计划)

---

## 一、现状分析

### 1.1 DataWhale 当前能力矩阵

| 层级 | 已完成 | 状态 |
|------|--------|------|
| **Agent 引擎** | 事件驱动循环、工具调用、模型路由、思考过程 | ✅ 生产级 |
| **工具系统** | 13 个工具（SQL/Python/搜索/数据加载/自扩展） | ✅ 完整 |
| **记忆系统** | KnowledgeStore、TraceStore、SessionStore、SkillStore | ✅ 四层记忆 |
| **扩展性** | Extension 动态加载、自扩展、Skill 系统 | ✅ 可自进化 |
| **交互界面** | CLI only（流式输出、交互式对话） | ⚠️ 局限 |
| **可视化** | ASCII 表格（CLI 内） | ⚠️ 无图表 |
| **Web 界面** | 无 | ❌ 缺失 |

### 1.2 CLI 的核心局限

| 局限 | 具体表现 | 用户影响 |
|------|---------|---------|
| **无图表** | 数据趋势、分布只能文字描述 | 分析结果不直观 |
| **无会话浏览** | 历史会话只能通过 `--list-sessions` + `--resume` | 切换上下文困难 |
| **无多面板** | 对话、数据、图表全在单一流中 | 信息密度低 |
| **无协作** | 无法分享分析结果 | 孤岛体验 |
| **终端依赖** | 非技术用户难以使用 | 用户群受限 |

### 1.3 OmniData 方案的借鉴要点

| OmniData 设计 | 可借鉴度 | DataWhale 适配 |
|---------------|---------|---------------|
| 对话式分析界面（左侧会话列表 + 右侧对话区 + 底部输入） | ⭐⭐⭐⭐⭐ | 直接采用作为主布局 |
| Agent 执行状态面板（✓ ⏳ ○ 步骤进度） | ⭐⭐⭐⭐⭐ | 已有事件系统，前端映射即可 |
| 图表自动推荐引擎 | ⭐⭐⭐ | 可简化为"Agent 选择图表类型" |
| 可视化嵌入对话流 | ⭐⭐⭐⭐⭐ | 核心差异——从文字升级到图表 |
| 多 Agent 协作面板 | ⭐⭐ | 当前单 Agent 即可覆盖，远期考虑 |
| ETL 连接器管理界面 | ⭐⭐ | 远期 |
| 多工作区 | ⭐⭐ | 远期 |
| 企业级权限体系 | ⭐ | DataWhale 定位个人/小团队，非企业 |

---

## 二、Web 产品定位

### 2.1 一句话定位

> **DataWhale Web = CLI 的对话能力 × 浏览器的可视化能力 × Agent 的智能记忆**

不是"给 CLI 套个网页"，而是**重新设计交互范式**——让 Agent 的分析结果以最直观的方式呈现。

### 2.2 与 CLI 的关系

```
              ┌──────────────────┐
              │   Agent Engine    │  ← 共享（同一套 Agent Runtime）
              └────────┬─────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
  ┌──────▼──────┐           ┌───────▼───────┐
  │  CLI 模式    │           │   Web 模式     │
  │  · 终端输出  │           │  · 浏览器渲染  │
  │  · 流式文本  │           │  · 图表/表格   │
  │  · 快速启动  │           │  · 会话管理    │
  │  · 脚本友好  │           │  · 可视化探索  │
  └─────────────┘           └───────────────┘
```

### 2.3 目标用户（Web 扩展）

| 用户类型 | CLI 覆盖 | Web 覆盖 | 新增价值 |
|---------|---------|---------|---------|
| 数据工程师（Power User） | ✅ 完全 | 可选 | 图表分享、报告导出 |
| 业务分析师 | ❌ 门槛高 | ✅ 主要 | 零命令操作 |
| 决策者 | ❌ 不可用 | ✅ 主要 | 一键洞察仪表盘 |
| 协作场景 | ❌ 不支持 | ✅ 新增 | 分享链接 |

---

## 三、交互范式设计

### 3.1 主界面布局

```
┌──────────────────────────────────────────────────────────────┐
│  🦈 DataWhale                              [会话] [设置] [?] │
├────────────┬─────────────────────────────────────────────────┤
│            │                                                  │
│  📊 会话1   │  ┌──────────────────────────────────────────┐  │
│    10分钟前 │  │                                          │  │
│  ───────── │  │  👤 帮我分析各区域的销售趋势                 │  │
│  📈 会话2   │  │                                          │  │
│    2小时前  │  │  🤖 好的，我来分析...                      │  │
│  ───────── │  │                                          │  │
│  📋 会话3   │  │  ┌─ Agent 进度 ─────────────────────┐    │  │
│    昨天    │  │  │ ✓ 加载数据 (sales.csv)             │    │  │
│            │  │  │ ✓ 探索 schema                     │    │  │
│            │  │  │ ⏳ 执行区域聚合查询                  │    │  │
│            │  │  │ ○ 生成图表                        │    │  │
│            │  │  └────────────────────────────────────┘   │  │
│            │  │                                          │  │
│ [+ 新会话] │  │  ┌─ 📊 区域销售趋势 ──────────────────┐    │  │
│            │  │  │        ╭──╮                         │    │  │
│            │  │  │   ╭───╯  ╰───╮                     │    │  │
│            │  │  │──╯            ╰───                   │    │  │
│            │  │  │ East West North South                │    │  │
│            │  │  └────────────────────────────────────┘   │  │
│            │  │                                          │  │
│            │  │  📋 关键发现:                              │  │
│            │  │  · East 占总量 29%，排名第一               │  │
│            │  │  · South 客单价最高 ($367)                 │  │
│            │  │  · North 有增长潜力                        │  │
│            │  │                                          │  │
├────────────┴─────────────────────────────────────────────────┤
│  💬 继续提问...                                    [发送 ⏎] │
│                                                              │
│  📎 拖拽 CSV/JSON 到此处上传    🔍 或从历史数据选择           │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 核心交互原则

| 原则 | 实现 |
|------|------|
| **即时反馈** | SSE 流式输出（复用现有事件系统）、进度条、骨架屏 |
| **渐进披露** | Agent 思考过程默认折叠、点击展开；图表可全屏 |
| **上下文保持** | 会话持久化（已有 SessionStore）、数据文件关联 |
| **智能建议** | Agent 完成分析后推荐后续问题（基于 KnowledgeStore） |
| **撤销/重做** | 每次工具调用可回退到之前状态 |

### 3.3 消息类型

对话流中的每条消息都有类型标记，前端据此选择渲染方式：

| 消息类型 | 渲染方式 | 数据来源 |
|---------|---------|---------|
| `text` | Markdown 渲染（表格、列表、加粗） | Agent `message_update` |
| `thinking` | 折叠面板（默认隐藏，可展开） | Agent `reasoning_update` |
| `tool_call` | 进度卡片（工具名 + 参数 + 状态） | Agent `tool_call_start/end` |
| `table` | 可排序列表格（虚拟滚动） | `query` 工具返回 |
| `chart` | ECharts/Recharts 图表 | `execute_python` 生成 |
| `image` | 图片预览 + 下载 | 文件导出 |
| `error` | 错误卡片（含重试按钮） | Agent `error` |
| `code` | 语法高亮代码块 | `execute_python` 代码 |

### 3.4 会话管理

| 操作 | 实现 |
|------|------|
| **新建会话** | 点击 "+" 或发送第一条消息 |
| **切换会话** | 左侧列表点击（已通过 SessionStore 持久化） |
| **重命名** | 双击会话标题编辑 |
| **删除** | 右键菜单 |
| **搜索** | 全文搜索所有会话内容 |
| **导出** | 会话导出为 Markdown / PDF / HTML |

---

## 四、可视化系统

### 4.1 图表生成流程

```
用户: "分析区域销售趋势"
  ↓
Agent 执行 SQL 查询 → 返回数据
  ↓
Agent 判断需要可视化 → 调用 execute_python
  ↓
Python (matplotlib) 生成图表 → 保存为 PNG
  ↓
文件自动导出到 ~/.datawhale/plots/{sessionId}/
  ↓
前端通过 API 拉取图片 → 嵌入对话流
```

### 4.2 图表自动推荐（简化版）

不实现 OmniData 的完整推荐引擎，而是让 Agent 根据数据特征自主选择：

Agent system prompt 中增加：

```
When query results have:
- 1 category + 1 numeric column with ≤ 10 categories → generate a bar chart
- 1 datetime + 1 numeric column → generate a line chart
- 2 numeric columns with many rows → generate a scatter plot
- 1 category column (no numeric) → generate a pie chart or frequency table

Use execute_python with matplotlib to create the chart.
Save as /tmp/chart.png — it will be automatically exported.
```

### 4.3 前端图表渲染

| 图表类型 | 渲染方案 | 库 |
|---------|---------|-----|
| 柱状图/折线图/散点图/饼图 | Agent 生成 PNG → 前端展示 | matplotlib（沙箱） |
| 交互式图表（筛选、缩放） | 前端接收原始数据 → 客户端渲染 | ECharts / Recharts |
| 大表格（>100 行） | 虚拟滚动 + 排序/筛选 | TanStack Table |

### 4.4 图表与文本的关系

```
┌──────────────────────────────────────────┐
│  🤖 Agent 回复                            │
│                                          │
│  East 区域表现最好，占总销售额的 29%。     │  ← 文字解释
│  下面是各区域的详细对比：                  │
│                                          │
│  ┌─ 📊 区域销售额对比 ─────────────┐     │  ← 嵌入图表
│  │     [bar chart]                  │     │
│  └──────────────────────────────────┘     │
│                                          │
│  值得注意：South 虽然订单量少，但客单价     │  ← 继续文字
│  最高 ($367)，可能代表高端市场。            │
└──────────────────────────────────────────┘
```

---

## 五、技术架构

### 5.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Next.js)                     │
│  ┌───────────┐ ┌───────────┐ ┌───────────────────────┐  │
│  │ 会话列表   │ │ 对话视图  │ │ 数据/图表面板          │  │
│  │ (React)   │ │ (React)   │ │ (ECharts / TanStack)  │  │
│  └───────────┘ └───────────┘ └───────────────────────┘  │
│                         │                                 │
│              SSE / HTTP / WebSocket                       │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────┼─────────────────────────────────┐
│                 Bun HTTP Server (app-server)               │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │                  API Routes (Hono)                    │  │
│  │  POST /api/chat     SSE 流式对话                      │  │
│  │  GET  /api/sessions 会话列表/详情                      │  │
│  │  GET  /api/files    文件下载（图表/数据）              │  │
│  │  POST /api/upload   文件上传（CSV/JSON）               │  │
│  │  GET  /api/knowledge 知识库查询                        │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │              Agent Runtime (复用现有)                  │  │
│  │  Agent → Tools → Provider → Memory                   │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 5.2 技术选型

| 层 | 技术 | 原因 |
|----|------|------|
| **前端框架** | Next.js 15 (App Router) | 已有 CodeWhale/web 参考，生态成熟 |
| **样式** | Tailwind CSS | 快速开发，暗色模式支持 |
| **图表** | ECharts（交互式）+ matplotlib（PNG） | ECharts 中文友好，功能全面 |
| **表格** | TanStack Table | 虚拟滚动、排序、筛选 |
| **状态管理** | Zustand | 轻量，适合中等复杂度 |
| **后端** | Bun + Hono | 与现有 Agent Runtime 同进程，零开销 |
| **通信** | SSE（Agent 流）+ HTTP（CRUD） | SSE 天然适合流式输出 |
| **会话存储** | 复用现有 SessionStore (SQLite) | 无需额外基础设施 |
| **文件服务** | 静态文件服务（~/.datawhale/plots/） | 直接读取本地文件 |

### 5.3 为什么不引入额外后端

DataWhale 的 Agent Runtime 已在 Bun 进程内运行。新增一个 Node.js/Express 后端会增加：
- 进程间通信开销
- 部署复杂度
- 状态同步问题

**方案**：在现有 CLI 包旁边新增 `packages/app-server/`，使用 Hono（Bun-native HTTP 框架）直接嵌入 Agent Runtime。前端通过 SSE 连接到同一进程。

### 5.4 目录结构（新增部分）

```
DataWhale/
├── packages/
│   ├── app-server/           # 新增：HTTP 服务层
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts      # Hono 服务入口
│   │       ├── routes/
│   │       │   ├── chat.ts   # POST /api/chat (SSE)
│   │       │   ├── sessions.ts
│   │       │   ├── files.ts
│   │       │   └── knowledge.ts
│   │       └── middleware/
│   │           └── agent.ts  # Agent 实例管理
│   └── web/                  # 新增：前端
│       ├── package.json
│       ├── next.config.ts
│       ├── app/
│       │   ├── layout.tsx    # 全局布局
│       │   ├── page.tsx      # 主页面
│       │   └── globals.css
│       └── components/
│           ├── chat/
│           │   ├── ChatView.tsx        # 对话视图
│           │   ├── MessageBubble.tsx   # 消息气泡
│           │   ├── ThinkingBlock.tsx   # 思考折叠面板
│           │   └── ChatInput.tsx       # 输入框
│           ├── session/
│           │   └── SessionList.tsx     # 会话列表
│           ├── viz/
│           │   ├── ChartCard.tsx       # 图表卡片
│           │   ├── TableView.tsx       # 表格视图
│           │   └── ImagePreview.tsx    # 图片预览
│           └── layout/
│               ├── Sidebar.tsx
│               └── Header.tsx
```

---

## 六、前后端通信协议

### 6.1 SSE 事件类型（复用 Agent 事件系统）

```
event: agent_start
data: {"sessionId":"sess_xxx","status":"thinking"}

event: reasoning_update
data: {"delta":"用户想要分析区域销售趋势..."}

event: message_update
data: {"delta":"好的，我来分析各区域的销售数据。"}

event: tool_call_start
data: {"toolCallId":"call_1","toolName":"list_tables","args":{}}

event: tool_call_progress
data: {"toolCallId":"call_1","content":"Found 2 tables..."}

event: tool_call_end
data: {"toolCallId":"call_1","result":{"content":"...","isError":false}}

event: chart_ready              ← 新增事件类型
data: {"url":"/api/files/sess_xxx/chart.png","type":"bar","title":"区域销售对比"}

event: agent_end
data: {"status":"done","turnCount":3}
```

### 6.2 REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/chat` | 发起对话（SSE 流），body: `{ prompt, sessionId?, files[] }` |
| `GET` | `/api/sessions` | 会话列表 |
| `GET` | `/api/sessions/:id` | 会话详情（含消息历史） |
| `DELETE` | `/api/sessions/:id` | 删除会话 |
| `POST` | `/api/upload` | 上传 CSV/JSON（multipart） |
| `GET` | `/api/files/:sessionId/:filename` | 下载导出的文件（图表/数据） |
| `GET` | `/api/knowledge/search?q=...` | 搜索知识库 |

### 6.3 会话恢复流程

```
1. 前端 GET /api/sessions → 显示会话列表
2. 用户点击某个会话 → GET /api/sessions/:id → 加载消息历史
3. 消息历史渲染为静态对话（已有的消息气泡）
4. 用户输入新消息 → POST /api/chat { sessionId } → Agent 在已有上下文上继续
5. 新的消息通过 SSE 增量追加到对话流中
```

---

## 七、组件树与页面路由

### 7.1 路由

```
/                    → 主页面（如果无活跃会话，显示欢迎页）
/session/[id]        → 特定会话（加载历史 + 继续对话）
```

### 7.2 主页面组件树

```
<Layout>
  <Header>
    <Logo />
    <NewSessionButton />
    <SettingsMenu />
  </Header>
  <div className="flex">
    <Sidebar>
      <SessionList />
      <UploadArea />
    </Sidebar>
    <main>
      <ChatView>
        <MessageBubble type="user" />
        <ThinkingBlock />         ← 默认折叠
        <MessageBubble type="assistant">
          <MarkdownRenderer />
          <ChartCard />           ← 嵌入图表
          <TableView />           ← 嵌入表格
          <ImagePreview />        ← 嵌入图片
        </MessageBubble>
      </ChatView>
      <ChatInput>
        <FileDropZone />
        <TextArea />
        <SendButton />
      </ChatInput>
    </main>
  </div>
</Layout>
```

### 7.3 状态管理（Zustand Store）

```typescript
interface AppState {
  // 会话
  sessions: SessionMeta[]
  activeSessionId: string | null
  messages: Message[]            // 当前会话的消息
  
  // Agent 状态
  agentStatus: "idle" | "thinking" | "acting" | "done" | "error"
  currentToolCalls: ToolCallState[]  // 进行中的工具调用
  streamingText: string              // 正在流式输出的文本
  
  // UI
  sidebarOpen: boolean
  showThinking: boolean              // 默认 false
}
```

---

## 八、与 CLI 的共存策略

### 8.1 双模架构

```
./dw "分析销售"          → CLI 模式（终端输出）

./dw serve               → 启动 HTTP 服务 + 打开浏览器
  → http://localhost:3000 → Web 模式
  → 同时 CLI 仍可独立使用
```

### 8.2 数据共享

CLI 和 Web 共享完全相同的持久化层：

```
~/.datawhale/
├── sessions.db      ← 共享：会话消息
├── traces.db        ← 共享：交互追踪
├── knowledge.db     ← 共享：知识积累
├── plots/           ← 共享：导出文件（Web 可直接读取）
├── skills/          ← 共享：Skill 定义
└── extensions/      ← 共享：Extension 代码
```

### 8.3 启动命令

```bash
# CLI 模式（默认）
./dw "hello"

# Web 模式
./dw serve              # 启动 HTTP 服务，默认端口 3000
./dw serve --port 8080  # 自定义端口
./dw serve --no-open    # 不自动打开浏览器

# Web 模式 + 数据预加载
./dw serve -l sales.csv
```

---

## 九、分阶段实施计划

### Phase W1：最小可行 Web（3 天）

**目标**：能用浏览器对话，看到流式输出，加载历史会话。

| 任务 | 估时 |
|------|------|
| 创建 `packages/app-server`（Hono + SSE） | 1 天 |
| 创建 `packages/web`（Next.js 脚手架） | 0.5 天 |
| ChatView + MessageBubble + 流式渲染 | 1 天 |
| SessionList + 切换/新建会话 | 0.5 天 |

**交付物**：浏览器中能像 CLI 一样对话，有会话列表。

### Phase W2：可视化（2 天）

| 任务 | 估时 |
|------|------|
| Agent 生成图表的 system prompt 增强 | 0.5 天 |
| 前端图表渲染（ECharts + PNG 预览） | 1 天 |
| 表格视图（TanStack Table 虚拟滚动） | 0.5 天 |

**交付物**：Agent 分析后对话中嵌入图表和格式化表格。

### Phase W3：体验打磨（2 天）

| 任务 | 估时 |
|------|------|
| 思考过程折叠面板 | 0.5 天 |
| 文件拖拽上传 | 0.5 天 |
| 暗色模式 | 0.5 天 |
| 移动端响应式 | 0.5 天 |

**交付物**：完整的 Web 体验，与 CLI 互补。

### Phase W4：高级功能（远期）

| 任务 | 估时 |
|------|------|
| 会话分享（生成链接） | 1 天 |
| 报告导出（Markdown/PDF） | 1 天 |
| 交互式图表（筛选/下钻） | 2 天 |
| 数据目录（连接器管理） | 3 天 |

---

## 十、风险与缓解

| 风险 | 缓解 |
|------|------|
| **SSE 断连** | 前端自动重连 + 断点续传（通过 sessionId 恢复） |
| **大文件上传** | 前端分片上传 + 进度条 |
| **图表生成慢** | Agent 优先返回文字结果，图表异步加载 |
| **Bun Hono 稳定性** | Hono 在 Bun 上已成熟，备选 Node.js + Express |
| **Next.js 与 Bun 后端跨域** | 开发时 Next.js dev server 代理到 Bun 后端 |

---

*本方案基于 DataWhale v0.3.0 代码完成度 + OmniData 设计参考。确认后开始 Phase W1。*
