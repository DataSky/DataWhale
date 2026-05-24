# DataWhale 项目进展与行动方案

> 2026-05-24 | v0.3.0 | 实时更新

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

## 三、未完成计划

| 功能 | 优先级 | 估时 | 状态 |
|------|--------|------|------|
| **可视化**（ASCII 表格/sparkline） | ⭐⭐⭐⭐ | 0.5天 | ❌ |
| **知识积累引擎**（LanceDB + 语义搜索） | ⭐⭐⭐⭐⭐ | 3天 | ❌ |
| **自扩展**（Agent 写 Extension） | ⭐⭐⭐⭐ | 3天 | ❌ |
| 多数据源连接器 | ⭐⭐ | 2天 | ❌ |
| Web UI | ⭐ | 5天 | ❌ |

---

## 四、推荐下一步

```
1. 可视化 (0.5天)  ██████████  查询结果变表格/图表，体验质变
2. 知识积累 (3天)   ██████████  核心差异化——越用越聪明
3. 自扩展 (3天)     ██████      Agent 写 Extension
```

**可视化优先**：当前所有能力就绪（搜索、Python、数据接入），但结果仍是纯文本。加 ASCII 表格 + sparkline 只需半天，分析结果可读性跃升。

---

## 五、当前风险

| 风险 | 缓解 |
|------|------|
| E2B Pause 14天过期 | 自动重建 + S3 兜底方案已记录 |
| DeepSeek deepseek-chat 7/24 弃用 | ✅ 已迁移到 V4 系列 |
| Bun Worker 限制 | ✅ 已切换到 sql.js |

---

## 六、文件结构

```
DataWhale/
├── dw                          # CLI 启动脚本
├── .env / .env.example         # API Keys
├── package.json / tsconfig.json
├── README.md                   # 使用文档
├── DESIGN_ANALYSIS.md          # 设计分析
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
    ├── agent/src/              # Agent + SessionStore + TraceStore
    ├── tools/src/builtin/      # duckdb / data-io / external-tools
    ├── extensions/src/         # Extension 系统
    └── cli/src/ / test/        # CLI + 测试
```

---

*最后更新: 2026-05-24 16:45 CST*
