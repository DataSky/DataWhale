# DataWhale 项目进展与行动方案

> 2026-05-25 | v0.3.0 | 实时更新

---

## 一、已完成模块

### Phase 1 ✅ — Core Agent + Simple Data

| 模块 | 说明 |
|------|------|
| Monorepo 骨架 | 5 包 workspace、Bun/TypeScript |
| AI Provider 层 | 统一 API + DeepSeek V4 / Anthropic / OpenAI |
| Agent Runtime | 事件驱动循环 + 工具调用 + 并行/串行 + 模型路由 |
| SQLite 工具 | list_tables / describe_table / query / get_sample |
| Extension 系统 | ESM 动态加载 + 生命周期钩子 |
| CLI 交互 | 交互/非交互模式 + 流式输出 |
| 启动脚本 | `./dw` 一键启动，`.env` 自动加载 |

### Phase 2 ✅ — 数据接入 + 会话持久化

| 模块 | 说明 |
|------|------|
| CSV 加载 | load_csv：自动类型推断 + 批量导入 |
| JSON 加载 | load_json：数组 + NDJSON 双模式 |
| 数据摘要 | summarize_table：列级统计 |
| 会话持久化 | SessionStore → `~/.datawhale/sessions.db` |
| CLI 增强 | `--load` / `--resume` / `--session` / `--list-sessions` |

### Phase 3 ✅ — 外部能力 + 观测性

| 模块 | 说明 |
|------|------|
| Tavily 搜索 | web_search：结构化结果 + 引用来源 |
| E2B 沙箱 | execute_python：Python 执行 + 文件自动导出 |
| 沙箱持久化 | Pause/Resume：退出自动暂停，重启毫秒恢复 |
| 文件导出 | 自动扫描 /tmp/ → 统一 bytes 读取 → 本地 |
| S3 方案文档 | s3fs/goofys/rclone 方案记录 |
| DeepSeek V4 迁移 | 模型 ID 更新 + reasoning_content 回传 |
| 模型路由 | DeepSeek 内部二档：pro(默认) / flash(简单) |
| 思考过程展示 | 灰色实时流式 + 结束一行浅灰汇总 |
| 换行优化 | 移除复杂状态机，简洁规则 |
| Trace 系统 | TraceStore → `~/.datawhale/traces.db` |
| 缓存策略文档 | DeepSeek 盘古缓存分析 + 优化建议 |

---

## 二、当前工具面板

```
┌───────────────────────────────────────────────────────────────┐
│  DataWhale Agent Tools (v0.3.0)                               │
│                                                                │
│  数据库    list_tables  describe_table  query  get_sample      │
│  数据接入  load_csv  load_json                                 │
│  统计      summarize_table                                     │
│  搜索      web_search (Tavily)                                 │
│  代码      execute_python (E2B)                                │
│  文件      sandbox_download                                    │
│  扩展      (Extension 系统)                                    │
│  观测      TraceStore (自动记录所有交互)                        │
└───────────────────────────────────────────────────────────────┘
```

---

## 三、进行中：Phase 3.5 — 架构修复（P0）

> **阻断说明**：以下三个问题是 2026-05-25 代码审计中发现的 P0 级架构风险。在新功能开发之前必须先修复，否则新功能会放大现有数据一致性问题。

| # | 问题 | 影响范围 | 估时 | 状态 |
|---|------|---------|------|------|
| **P0-1** | 数据库双写覆盖：SessionStore 和 QueryStore 共享 `sessions.db` 但各维护独立 sql.js 实例，`fs.writeFileSync` 全量覆盖导致后写者覆盖先写者 | agent, app-server, cli | 1天 | ❌ |
| **P0-2** | 新旧模型双轨：SessionStore 用旧 `messages` 表 / QueryStore 用新 `queries` 表，前端仅读旧表，两套数据可能不一致 | 前后端数据 | 1.5天 | ❌ |
| **P0-3** | 知识提取逻辑重复：CLI（`extractKnowledge` ~95行）和 app-server（SSE 内联 ~33行）各实现一遍，代码重复且行为不一致 | agent, cli, app-server | 0.5天 | ❌ |

**修复顺序**：P0-1 → P0-2 → P0-3（按依赖关系排序）

- **P0-1** 创建统一的 `DBConnectionManager` 单例，确保同一 db 文件只有一个 sql.js 实例
- **P0-2** 在 P0-1 基础上统一数据模型为新 Query/Span 模型，迁移旧 messages 或废弃旧表，前端接入新模型
- **P0-3** 在 P0-1/P0-2 稳定后将知识提取逻辑提取为 `@datawhale/agent` 的共享方法

> **合计 P0 修复估时：3 天**

---

## 四、未完成计划

> 以下功能在 P0 修复完成后按优先级执行。

| 功能 | 优先级 | 估时 | 状态 |
|------|--------|------|------|
| **可视化**（ASCII 表格/sparkline） | ⭐⭐⭐⭐ | 0.5天 | ❌ |
| **知识积累引擎**（LanceDB + 语义搜索） | ⭐⭐⭐⭐⭐ | 3天 | ❌ |
| **自扩展**（Agent 写 Extension） | ⭐⭐⭐⭐ | 3天 | ❌ |
| 多数据源连接器 | ⭐⭐ | 2天 | ❌ |
| Web UI | ⭐ | 5天 | ❌ |

---

## 五、推荐执行顺序

```
1. P0 架构修复 (3天)  ██████████  数据库安全 + 数据模型统一 → 新功能的基石
2. 可视化 (0.5天)      ██████      查询结果变表格/图表，体验质变
3. 知识积累 (3天)      ██████████  核心差异化——越用越聪明
4. 自扩展 (3天)        ██████      Agent 写 Extension
```

**架构修复优先**：Phase 3.5 的三个 P0 问题直接威胁数据完整性。在新功能叠加之前修复它们，避免"在裂缝上盖楼"。P0-1（数据库双写覆盖）是最紧迫的——每次 Web 聊天都在触发这个竞争条件。

---

## 六、当前风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| SessionStore/QueryStore 双写覆盖 | 🔴 P0 | Phase 3.5 P0-1：DBConnectionManager 单例 |
| 新旧数据模型不一致 | 🔴 P0 | Phase 3.5 P0-2：统一为 Query/Span 模型 |
| 知识提取逻辑重复 | 🔴 P0 | Phase 3.5 P0-3：提取共享方法 |
| E2B Pause 14天过期 | 🟡 | 自动重建 + S3 兜底方案已记录 |
| DuckDB 查询缓存在数据变更后毒化 | 🟡 | load_csv/load_json 后清空缓存 |
| Bun Worker 限制 | 🟢 | ✅ 已切换到 sql.js |

---

## 七、文件结构

```
DataWhale/
├── dw                          # CLI 启动脚本
├── .env / .env.example         # API Keys
├── package.json / tsconfig.json
├── README.md                   # 使用文档
├── DESIGN_ANALYSIS.md          # 设计分析
├── PROJECT_ANALYSIS_REPORT.md  # 代码审计报告
├── PHASE3_PLAN.md              # 本文档
├── docs/
│   ├── S3_PERSISTENCE.md
│   ├── VISUALIZATION_KNOWLEDGE_ROUTING_RESEARCH.md
│   └── DEEPSEEK_CACHE_STRATEGY.md
├── test/fixtures/              # 测试数据
│   ├── products.csv
│   └── sales.csv
└── packages/
    ├── ai/src/                 # Provider 抽象
    ├── agent/src/              # Agent + SessionStore + TraceStore + QueryStore
    ├── tools/src/builtin/      # duckdb / data-io / external-tools / self-extend
    ├── extensions/src/         # Extension 系统
    ├── app-server/src/         # Web 服务端 (Hono + SSE)
    ├── web/app/                # Next.js 前端
    └── cli/src/ / test/        # CLI + 测试
```

---

*最后更新: 2026-05-25 12:00 CST*
