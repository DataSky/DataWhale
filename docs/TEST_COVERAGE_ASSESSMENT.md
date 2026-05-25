# DataWhale 测试完备度评估报告

> 2026-05-25 | 系统性审计现有测试覆盖 + 缺口识别 + 补全计划

---

## 一、现有测试资产

| 文件 | 行数 | 类型 | 内容 |
|------|------|------|------|
| `packages/cli/test/e2e.ts` | 75 | E2E | 5 项：静态页面、sessions API、SSE 聊天、会话读取、会话删除 |
| `packages/agent/test/query-model.test.ts` | 128 | 单元 | 6 项：makeQuery/Turn、Span 类型、QueryStore CRUD、多 Query、API 集成 |
| `packages/agent/test/query-architecture.test.ts` | 307 | 单元 | 6 项：同上 + 空 spans 边界（旧版本，query-model.test.ts 已替代） |
| `packages/cli/test/integration.ts` | 83 | 集成 | 1 项：Agent 循环 + DeepSeek 工具调用 |
| `packages/cli/test/e2e-full.ts` | 177 | E2E | 4 项：SSE 流解析、会话 CRUD、内容格式、边界 |
| `test/regression.sh` | 72 | 回归 | 13 个端点静态检查 |

**总计**：6 个测试文件，约 35 个测试用例，覆盖 4 种测试类型。

---

## 二、功能 × 测试覆盖矩阵

| 功能模块 | 已有测试 | 缺口级别 | 风险说明 |
|---------|---------|---------|---------|
| **CLI 交互** | ❌ 无 | 🔴 严重 | 交互模式、非交互模式、工具调用展示、错误展示均无自动测试 |
| **Web 会话管理** | ✅ E2E 3项 | 🟢 可接受 | CRUD + 列表已有覆盖 |
| **SSE 流式推送** | ✅ E2E 1项 | 🟡 不足 | 只测了"回复 OK"，未测多轮工具调用、思考过程、长文本 |
| **多轮对话** | ❌ 无 | 🔴 严重 | 两轮追问、跨会话记忆、sessionId 连续性均无测试 |
| **Agent 工具调用链** | ✅ 集成 1项 | 🟡 不足 | 只测了 calculate 工具单轮，未测：web_search / execute_python / DuckDB 多工具组合 |
| **数据加载 (CSV/JSON)** | ❌ 无 | 🔴 严重 | load_csv/load_json 均无自动测试 |
| **数据库工具 (DuckDB)** | ✅ 单元 1项 | 🟡 不足 | 只测了 QueryStore CRUD，未测 list_tables/describe_table/query/get_sample 的逻辑正确性 |
| **知识积累 (KnowledgeStore)** | ❌ 无 | 🔴 严重 | add/search/listRecent 均无单元测试 |
| **SessionStore** | ❌ 无 | 🔴 严重 | 创建/保存/加载/删除消息、迁移脚本均无测试 |
| **TraceStore** | ❌ 无 | 🟠 高 | 事件记录/查询/统计均无测试 |
| **Skill 系统** | ❌ 无 | 🟡 中 | 发现/匹配/注入均无测试 |
| **外部工具 (Tavily/E2B)** | ❌ 无 | 🟡 中 | web_search / execute_python 无单元测试（但需要 API key） |
| **图片导出** | ❌ 无 | 🟡 中 | /api/files 端点 + 本地文件写入无测试 |
| **错误恢复** | ❌ 无 | 🔴 严重 | 网络断开、API 500、工具超时、空数据库等场景均无测试 |
| **上下文截断** | ❌ 无 | 🟡 中 | query/execute_python/web_search 的截断行为无验证 |
| **模型路由** | ❌ 无 | 🟡 中 | Turn1=pro / 简单后续=flash 的切换无测试 |
| **思考过程展示** | ❌ 无 | 🟡 中 | reasoning_update 事件处理 + 折叠/展开无测试 |
| **Web 前端** | ❌ 无 | 🔴 严重 | 零前端测试（无 jest/playwright/cypress） |

---

## 三、缺口统计

| 级别 | 数量 | 影响 |
|------|------|------|
| 🔴 严重（无任何覆盖） | **8 项** | CLI交互、多轮对话、数据加载、知识库、SessionStore、错误恢复、Web前端、上下文截断验证 |
| 🟠 高（仅单条覆盖） | **1 项** | TraceStore |
| 🟡 不足（需补充） | **8 项** | SSE多轮、Agent多工具、DuckDB工具、外部工具、图片导出、模型路由、思考展示、Skill系统 |
| 🟢 可接受 | **1 项** | Web会话管理 |

**总结**：17 个功能模块中，仅 1 个达到可接受覆盖率。**覆盖率 ~6%**。

---

## 四、风险排序（按"使用中触发概率 × 影响面"）

| 排名 | 缺口 | 场景 | 出现问题概率 | 影响面 |
|------|------|------|-------------|--------|
| **#1** | 多轮对话 | 用户连续问 2+ 轮 | 极高（每次使用） | 数据全丢 |
| **#2** | 数据加载 | 用户上传 CSV/JSON | 极高（首次使用） | 无法开始 |
| **#3** | 错误恢复 | API 500 / 网络断开 | 中（偶发） | 会话中断 |
| **#4** | CLI 交互 | 终端用户操作 | 极高（每次使用） | 体验崩溃 |
| **#5** | 知识库 | 跨会话记忆 | 中（多会话时） | 重复劳动 |
| **#6** | SessionStore | 消息持久化 | 极高（每次使用） | 会话丢失 |
| **#7** | Web 前端 | 浏览器用户操作 | 高（每次使用） | 页面崩溃 |
| **#8** | 上下文截断验证 | 大数据查询 | 中（大数据时） | 信息丢失 |

---

## 五、补全计划（按优先级）

### P0 — 必须立即补充（本周，~4h）

| 测试 | 文件 | 内容 | 估时 |
|------|------|------|------|
| SessionStore CRUD | `packages/agent/test/session-store.test.ts` | createSession / saveMessages / loadMessages / deleteSession / updateTitle | 1h |
| KnowledgeStore CRUD | `packages/agent/test/knowledge-store.test.ts` | add / search / listRecent / count / 去重 | 0.5h |
| 多轮对话 E2E | `packages/cli/test/e2e.ts` 追加 | 同一 sessionId 两次 POST /api/chat，验证消息数增长 | 0.5h |
| 数据加载 | `packages/tools/test/data-io.test.ts` | load_csv → 检查表名/行数/列名 + load_json | 1h |
| 错误恢复 | `packages/agent/test/error-handling.test.ts` | 工具抛出异常不崩溃、API 返回 500 有重试 | 1h |

### P1 — 本周内补充（~3h）

| 测试 | 内容 | 估时 |
|------|------|------|
| DuckDB 工具单元测试 | list_tables / describe_table / query / get_sample 逻辑验证 | 1h |
| TraceStore 单元测试 | record / query / sessionStats | 0.5h |
| 上下文截断验证 | query 输出 > 6000 字符时验证截断信号 | 0.5h |
| 图片导出 E2E | execute_python 生成图表 → 检查 /api/files 可访问 | 1h |

### P2 — 后续补充（远期）

| 测试 | 内容 |
|------|------|
| Web 前端组件测试 | jest + testing-library，消息渲染/思考折叠/工具卡片 |
| Web 前端 E2E | playwright，完整用户旅程（注册→上传→提问→看结果） |
| CLI 交互测试 | expect/pexpect 自动化，验证 tool_call 展示格式 |
| 模型路由测试 | 验证 Turn1=pro / 简单=flash |
| Skill 系统测试 | 技能发现/匹配/注入 |

---

## 六、今天立即执行（P0 5 项）

执行顺序：SessionStore → KnowledgeStore → 多轮对话 → 数据加载 → 错误恢复。

每完成一项立刻运行验证，全部通过后 push。

---

*评估完成。覆盖率 ~6%，严重缺口 8 项。*
