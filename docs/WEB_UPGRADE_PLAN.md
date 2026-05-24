# DataWhale Web UI 完整升级方案

> 版本: 2.0 | 2026-05-24 | 参照 Claude / ChatGPT / Cursor 交互标准

---

## 一、设计原则

```
┌─────────────────────────────────────────────────────────────┐
│                     DataWhale Web 体验目标                    │
│                                                              │
│  不是 CLI 的可视化替代品，而是数据探索的「思考空间」           │
│                                                              │
│  三个核心体验:                                                │
│  1. 沉浸式对话 — Agent 的思考、行动、洞察自然流动             │
│  2. 可视化洞察 — 图表、表格、代码在对话中生长                  │
│  3. 持久化工作台 — 会话、文件、知识构成个人数据资产            │
└─────────────────────────────────────────────────────────────┘
```

| 原则 | 说明 |
|------|------|
| **流式自然** | Agent 思考→行动→结果形成自然叙事流，不做机械分区 |
| **渐进呈现** | 先给结论，细节可展开。不一次性倾倒信息 |
| **上下文保持** | 切换会话不丢失上下文，所有历史可回溯 |
| **即时反馈** | 每次操作 <200ms 内给出响应，长任务有进度 |
| **零学习成本** | 新用户第一次使用就能完成一次完整分析 |

---

## 二、信息架构

```
App
├── Header
│   ├── Logo + 产品名
│   ├── 当前会话标题（可编辑）
│   ├── ModelSelector（下拉）
│   └── ThemeToggle（暗/亮）
│
├── Sidebar（可折叠）
│   ├── NewSession 按钮
│   ├── SessionList（搜索框 + 列表）
│   │   ├── SessionItem（标题、日期、消息数）
│   │   ├── 右键菜单（重命名/删除/导出/复制链接）
│   │   └── 拖拽排序 / 置顶
│   ├── 分隔线
│   └── 底部操作栏
│       ├── Settings（设置入口）
│       └── 数据目录（已上传文件列表）
│
├── Main Chat Area
│   ├── WelcomeScreen（空状态）
│   │   ├── 欢迎语 + 快速开始建议
│   │   ├── 拖拽上传区
│   │   └── 示例问题列表
│   │
│   ├── MessageList
│   │   └── MessageBubble
│   │       ├── [role=user]
│   │       │   ├── 用户头像/标识
│   │       │   ├── 文本内容
│   │       │   └── 操作栏（编辑/删除）
│   │       │
│   │       └── [role=assistant]
│   │           ├── ThinkingBlock（默认折叠）
│   │           │   ├── 折叠摘要："Thought for 3s"
│   │           │   └── 展开内容（流式时自动展开）
│   │           │
│   │           ├── ToolCallCards（内联于 thinking 和 content 之间）
│   │           │   ├── 状态图标（⏳/✓/✗）
│   │           │   ├── 工具名称
│   │           │   ├── 参数摘要（截断，可展开）
│   │           │   └── 结果预览（成功）/ 错误信息（失败）
│   │           │
│   │           ├── ContentBlock（markdown 渲染）
│   │           │   ├── 富文本（标题、列表、加粗、斜体）
│   │           │   ├── 代码块（语法高亮 + 复制按钮）
│   │           │   ├── 表格（排序、横向滚动）
│   │           │   ├── ChartCard（ECharts 图表嵌入）
│   │           │   ├── ImagePreview（图片预览 + 下载）
│   │           │   └── SourceCitation（Web 搜索来源引用）
│   │           │
│   │           └── ActionBar
│   │               ├── Copy 按钮
│   │               ├── Regenerate 按钮
│   │               ├── ThumbsUp / ThumbsDown
│   │               └── 时间戳
│   │
│   └── StreamingBlock（流式接收中）
│       ├── Thinking（自动展开，实时追加）
│       ├── ToolCallCards（实时状态更新）
│       └── Content（逐字流式 + 打字光标）
│
├── InputArea
│   ├── FileDropZone（拖拽上传区，覆盖整个输入框）
│   ├── TextArea（多行，自动增高）
│   ├── SendButton（⌘Enter）
│   ├── 快捷工具栏
│   │   ├── AttachFile 按钮（选择 CSV/JSON）
│   │   ├── ModelQuickSwitch（快速切换模型）
│   │   └── 字符计数 / Token 估算
│   └── 底部提示："Enter 发送 · Shift+Enter 换行 · 拖拽文件上传"
│
└── CommandPalette（⌘K 全局搜索/命令）
    ├── 会话搜索（快速切换）
    ├── 命令列表（新建会话、导出、设置）
    └── 文档搜索（知识库检索）
```

---

## 三、功能全景矩阵

### A. 会话系统

| 功能 | 交互方式 | 后端 |
|------|---------|------|
| 新建会话 | 按钮 / ⌘N | POST /api/sessions |
| 切换会话 | 侧边栏点击 / ⌘K | GET /api/sessions/:id |
| 重命名 | 双击标题 / 右键菜单 | PATCH /api/sessions/:id |
| 删除 | 右键菜单 / ⌫ 键 | DELETE /api/sessions/:id |
| 搜索会话 | 侧边栏搜索框 | GET /api/sessions?q= |
| 置顶 | 右键菜单 | PATCH /api/sessions/:id { pinned } |
| 导出 | 右键菜单 → Markdown/PDF/HTML | GET /api/sessions/:id/export |

### B. 消息系统

| 功能 | 交互方式 |
|------|---------|
| 流式输出 | SSE → React state → 逐字渲染 |
| Markdown 渲染 | react-markdown + 自定义组件 |
| 代码高亮 | rehype-highlight / shiki |
| 表格渲染 | 自定义 Table 组件（排序、滚动） |
| 复制 | 每条消息 hover 显示 Copy 按钮 |
| 重新生成 | 按钮 → 删除最后一条 assistant 消息 → 重新发送 |
| 编辑用户消息 | 点击编辑 → 修改 → 重新发送（新分支） |
| 反馈 | 👍/👎 → POST /api/feedback |
| 时间戳 | hover 消息显示精确时间 |

### C. 思考与工具

| 功能 | 交互方式 |
|------|---------|
| 思考流式 | real-time 展开面板，逐字追加 |
| 思考折叠 | 完成后默认折叠，显示 "Thought for Ns" |
| 工具调用卡片 | ⏳ running → ✓ done / ✗ error |
| 工具参数 | 可点击展开查看完整参数 |
| 工具结果 | 成功显示预览，失败显示错误详情 + 重试 |
| 工具链时序 | 多工具调用按时间顺序纵向排列 |

### D. 文件系统

| 功能 | 交互方式 | 后端 |
|------|---------|------|
| 拖拽上传 | DropZone → 自动识别 CSV/JSON | POST /api/upload |
| 文件列表 | 侧边栏底部数据目录 | GET /api/files |
| 文件预览 | 点击文件 → 弹窗预览前 20 行 | GET /api/files/:id/preview |
| 文件删除 | 右键菜单 | DELETE /api/files/:id |
| 图表下载 | 图片卡片 → 下载按钮 | GET /api/files/:sessionId/:name |

### E. 可视化

| 功能 | 交互方式 |
|------|---------|
| 图表嵌入 | ChartCard 内联于对话流中 |
| 图表交互 | ECharts 交互（缩放、hover 提示） |
| 图表下载 | PNG / SVG 导出 |
| 表格交互 | 排序、筛选、分页、CSV 导出 |

### F. 系统功能

| 功能 | 交互方式 |
|------|---------|
| 模型选择 | Header 下拉 / 输入框快捷切换 |
| 主题切换 | Header 按钮 / ⌘⇧T |
| 命令面板 | ⌘K → 搜索/命令 |
| 快捷键 | 全局快捷键表 |
| 响应式 | 移动端侧边栏折叠、触摸优化 |
| 错误恢复 | 网络断开重连、500 重试、fallback UI |

### G. 设置与配置

Settings 页面（`/settings` 路由或侧边栏入口）：

| 功能 | 交互方式 | 存储 |
|------|---------|------|
| **API Key 管理** | 输入框 + 显示/隐藏切换 + 验证按钮 | `~/.datawhale/config.json` |
| DeepSeek API Key | 输入 + 测试连接按钮 | 同上 |
| Anthropic API Key | 输入（可选） | 同上 |
| OpenAI API Key | 输入（可选） | 同上 |
| Tavily API Key | 输入（可选） | 同上 |
| E2B API Key | 输入（可选） | 同上 |
| **数据源配置** | 连接器列表 + 添加/编辑/删除 | `~/.datawhale/datasources.json` |
| CSV/JSON 文件 | 文件路径 + 自动发现 | 本地文件系统 |
| PostgreSQL | Host/Port/DB/User/Password + 测试连接 | 同上 |
| MySQL | Host/Port/DB/User/Password + 测试连接 | 同上 |
| SQLite 文件 | 文件路径选择器 | 本地文件系统 |
| REST API | URL + Headers + 认证配置 | 同上 |
| **偏好设置** | 开关/下拉 | localStorage |
| 默认模型 | 下拉选择 | localStorage |
| 语言 | zh-CN / en-US | localStorage |
| 每页消息数 | 数字输入 | localStorage |

### H. 监控与分析

Dashboard 页面（`/dashboard` 路由）：

| 功能 | 指标 | 数据来源 |
|------|------|---------|
| **请求趋势** | 日/周/月请求量折线图 | TraceStore 聚合查询 |
| **Token 消耗** | 输入/输出 Token 堆叠面积图 | TraceStore `input_tokens` + `output_tokens` |
| **模型分布** | 各模型使用占比饼图 | TraceStore `model` 字段 |
| **延迟分布** | P50/P95/P99 延迟折线图 | TraceStore `latency_ms` |
| **工具调用排行** | Top 10 工具柱状图 | TraceStore `tool_name` |
| **错误率** | 错误占比趋势 + 错误类型分布 | TraceStore `event_type = 'error'` |
| **会话活跃度** | 日活跃会话数 | SessionStore + TraceStore |
| **知识积累** | 知识条目增长曲线 | KnowledgeStore `count()` |
| **成本估算** | 基于 Token 的日/月费用（× DeepSeek 定价） | 计算字段 |
| **数据导出** | CSV/JSON 导出监控数据 | API |

---

## 四、组件树

```
App
├── Providers（ThemeProvider, SessionProvider, CommandPaletteProvider）
├── Layout
│   ├── Header
│   │   ├── Logo
│   │   ├── SessionTitle（可编辑）
│   │   ├── ModelSelector（Dropdown）
│   │   └── ThemeToggle
│   │
│   ├── Sidebar
│   │   ├── SidebarToggle（折叠按钮）
│   │   ├── NewSessionButton
│   │   ├── SessionSearch（Input）
│   │   ├── SessionList
│   │   │   └── SessionItem × N
│   │   ├── Divider
│   │   └── FileList（数据目录）
│   │   ├── NavItem: Dashboard（📊）
│   │   └── NavItem: Settings（⚙️）
│   │
│   │   ├── WelcomeScreen（条件渲染）
│   │   │   ├── Heading + Description
│   │   │   ├── FileDropZone
│   │   │   └── ExamplePrompts
│   │   │
│   │   ├── MessageList
│   │   │   └── MessageBubble × N
│   │   │       ├── UserMessage
│   │   │       │   ├── Content
│   │   │       │   └── EditButton
│   │   │       │
│   │   │       └── AssistantMessage
│   │   │           ├── ThinkingBlock（details/summary）
│   │   │           ├── ToolCallCard × N
│   │   │           ├── ContentBlock（ReactMarkdown）
│   │   │           │   ├── CodeBlock（highlight.js）
│   │   │           │   ├── TableBlock（sortable）
│   │   │           │   ├── ChartCard（ECharts）
│   │   │           │   ├── ImagePreview（lightbox）
│   │   │           │   └── SourceCitation
│   │   │           └── ActionBar
│   │   │               ├── CopyButton
│   │   │               ├── RegenerateButton
│   │   │               ├── ThumbsUp / ThumbsDown
│   │   │               └── Timestamp
│   │   │
│   │   └── StreamingBlock（条件渲染）
│   │       ├── ThinkingPanel（auto-open）
│   │       ├── ToolCallCards（实时）
│   │       ├── StreamingContent
│   │       └── TypingCursor
│   │
│   └── InputArea
│       ├── FileDropZone（overlay）
│       ├── TextArea（auto-grow）
│       ├── QuickToolbar
│       │   ├── AttachFileButton
│       │   └── ModelQuickSwitch
│       └── SendButton
│
└── CommandPalette（overlay, ⌘K 触发）
    ├── SearchInput
    ├── SessionResults
    ├── CommandResults
    └── KnowledgeResults
```

---

## 五、状态管理（Zustand）

```typescript
interface AppState {
  // 会话
  sessions: SessionMeta[]
  activeSessionId: string | null
  messages: Message[]
  
  // Agent 实时状态
  streaming: boolean
  streamThinking: string          // 流式思考文本
  streamContent: string           // 流式正文
  streamToolCalls: ToolCallState[] // 进行中的工具调用
  
  // UI 状态
  sidebarOpen: boolean
  theme: "dark" | "light" | "system"
  commandPaletteOpen: boolean
  selectedModel: string
  
  // 文件
  uploadedFiles: FileInfo[]
  
  // Actions
  newSession: () => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  sendMessage: (text: string) => Promise<void>
  regenerate: (messageId: string) => Promise<void>
  toggleSidebar: () => void
  toggleTheme: () => void
}
```

---

## 六、技术选型

| 层 | 技术 | 原因 |
|----|------|------|
| 框架 | Next.js 15 (App Router) | 已有 |
| 样式 | Tailwind CSS v3 + CSS Modules | 已有，成熟稳定 |
| UI 组件 | Radix UI（Dialog/DropdownMenu/Tooltip） | 无样式，完全可控，无障碍 |
| 图表 | ECharts（按需加载） | 中文生态好，功能全 |
| 代码高亮 | rehype-highlight + highlight.js | 轻量，SSR 友好 |
| 状态管理 | Zustand | 轻量，适合中等复杂度 |
| 拖拽上传 | react-dropzone | 成熟，API 简洁 |
| 快捷键 | @radix-ui/react-use-keys | 声明式，无障碍 |
| Markdown | react-markdown + remark-gfm | 已有 |

---

## 七、实施路线图

### Phase W2（1 周）：沉浸式对话

**目标**：消息系统达到生产级，思考/工具/正文形成自然流。

| 交付 | 估时 |
|------|------|
| 代码高亮（rehype-highlight + 暗色主题） | 1h |
| 重新生成按钮 + 逻辑 | 1h |
| 消息反馈（👍/👎 按钮） | 1h |
| 消息时间戳 | 0.5h |
| 编辑用户消息 → 重新发送 | 1h |
| 流式块优化（平滑过渡、光标效果） | 1h |

### Phase W3（1 周）：会话与文件工作台

**目标**：会话成为可管理的持久资产，文件拖拽上传打通。

| 交付 | 估时 |
|------|------|
| 会话搜索框 | 1h |
| 会话右键菜单（重命名/删除/导出） | 1.5h |
| 会话导出（Markdown / 复制全部） | 1h |
| 文件拖拽上传（DropZone + Upload API） | 2h |
| 文件列表面板（侧边栏底部） | 1h |
| 图表/图片卡片渲染 | 1.5h |

### Phase W4（1 周）：系统打磨

**目标**：模型切换、主题切换、命令面板、响应式。

| 交付 | 估时 |
|------|------|
| 模型选择器下拉（Header） | 1h |
| 暗/亮主题切换 + 亮色主题变量 | 2h |
| 命令面板 ⌘K（会话搜索 + 快速操作） | 2h |
| 侧边栏折叠 + 移动端适配 | 2h |
| 快捷键系统 | 1h |
| 错误恢复 UI（断网提示、重试） | 1h |

### Phase W5（1 周）：设置与监控

**目标**：API Key 配置、数据源管理、用量监控仪表盘。

| 交付 | 估时 |
|------|------|
| Settings 页面 — API Key 管理（表单 + 验证 + 安全存储） | 2h |
| Settings 页面 — 数据源配置（连接器 CRUD + 测试连接） | 2h |
| Dashboard 页面 — 请求趋势 + Token 消耗图表 | 2h |
| Dashboard 页面 — 工具调用排行 + 错误率 | 1.5h |
| Dashboard 页面 — 成本估算 + 数据导出 | 1h |
| 后端聚合 API（TraceStore 统计查询） | 1.5h |

### 主题系统深化

| 交付 | 说明 |
|------|------|
| 亮色主题变量 | `bg-primary: #ffffff`, `text-primary: #1a1a2e` 等全套色彩映射 |
| 自动跟随系统 | `prefers-color-scheme` 媒体查询 |
| 平滑过渡 | CSS transition 0.3s 切换动画 |
| 代码高亮双主题 | highlight.js 暗色（atom-one-dark）/ 亮色（github）切换 |

---

*本方案覆盖完整信息架构、组件树、状态管理、8 类功能矩阵、技术选型、四阶段实施路线。确认后从 Phase W2 开始。*
