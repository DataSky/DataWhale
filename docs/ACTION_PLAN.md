# DataWhale 系统行动规划 v3.0

> 2026-05-25 | 基于 CONTEXT_OFFLOAD_STRATEGY.md + 当前待办

---

## 一、当前基线

### 已完成 ✅

| 模块 | 内容 |
|------|------|
| 上下文截断 | query(6K)/execute_python(4K)/web_search(300字条) + 不完整信号 |
| 历史注入 | slice(-20) 防 context 爆炸 |
| compressToolContent | Agent 层压缩工具输出换行 |
| 沙箱 Pause/Resume | 跨会话保持沙箱存活 |
| 图片导出 | /tmp/ → ~/.datawhale/plots/ + API |
| Query/Turn/Span | 四级模型已落地 + /api/queries |
| 多轮 sessionId | 首个 SSE 事件即获取 |
| 系统提示词 | 结构化 XML 标签 + 日期注入 + 沙箱卸载指引 |

### 待修复 ⚠️

| # | 问题 | 影响 | 优先级 |
|---|------|------|--------|
| B1 | agent_end 未出现在 SSE | 前端依赖 agent_start 取 sessionId（workaround） | P1 |
| B2 | 服务偶发崩溃（API 超时/工具死循环） | 用户体验差 | P1 |
| B3 | 图片引用偶尔用本地路径 | LLM 偶尔忽略 /api/files/ URL | P2 |
| B4 | 前端刷新偶发会话分裂 | React state 竞态 | P2 |

---

## 二、行动路线图（4 个 Phase，12 个任务）

```
Week 1 ─────────────── Week 2 ─────────────── Week 3+
Phase 1: 截断完善    Phase 2: 沙箱工具链    Phase 3-4: 知识+持久
  T1.1 ✓              T2.1 修复list_files    T3.1 Schema Registry
  T1.2 分布直方图       T2.2 文件自动索引      T3.2 发现-验证循环
  T1.3 按行边界截断     T2.3 提示词沙箱指引    T4.1 OSS 自动化
                       T2.4 沙箱清理策略
```

---

## 三、Phase 1：截断完善（本周剩余）

### T1.2 — summarize_table 增加 ASCII 分布直方图

**目标**：让 LLM 不用看原始数据就能感知数据分布形状

**实现**：在 `summarize_table` 的数值列输出中添加 ASCII sparkline

```
示例输出:
  price 列:
    count: 500  min: 9.99  max: 499.99  mean: 87.32
    分布: ▁▂▃▅▆▇▇▅▃▂▁ (10-bin histogram)
```

**改动文件**：`packages/tools/src/builtin/data-io.ts`
**估时**：1h
**验证**：加载 CSV → summarize_table → 检查输出含 ASCII 图

### T1.3 — 按行边界截断

**目标**：避免截断时切断表格行的中间

**当前问题**：`output.slice(0, 6000)` 可能在行中间切断

**实现**：
```typescript
if (output.length > maxLen) {
  const cutPoint = output.lastIndexOf('\n', maxLen)
  output = output.slice(0, cutPoint > 0 ? cutPoint : maxLen)
       + `\n... [不完整: ${rows.length}行, 仅展示前 ${displayRows.length} 行]`
}
```

**改动文件**：`packages/tools/src/builtin/duckdb.ts`
**估时**：0.5h
**验证**：大查询 → 检查截断位置在行边界

---

## 四、Phase 2：沙箱工具链

### T2.1 — 修复 list_workspace_files 工具

**问题**：Python 字符串转义导致编译失败

**实现**：重新编写 `listWorkspaceFilesTool`，使用正确的 TypeScript 字符串转义

**改动文件**：`packages/tools/src/builtin/external-tools.ts`
**估时**：0.5h
**验证**：`bun -e` 测试 → Agent 可调用 → 返回文件列表

### T2.2 — execute_python 后自动文件索引

**目标**：Agent 不需要手动调用 list_workspace_files；每次 Python 执行后，新生成的文件自动出现在上下文中

**实现**：在 `execute_python` 的 savedFiles 处理中，将新文件列表追加到输出末尾

```
当前输出:
  stdout: ...
  [Saved: chart.png, data.csv]

优化后:
  stdout: ...
  📁 Sandbox files (available for next analysis):
    → /tmp/chart.png (15KB)
    → /tmp/data.csv (230KB)
  Use execute_python with pd.read_csv('/tmp/data.csv') to access.
```

改动很小——只需更新 savedFiles 输出格式，不需要新工具。

**改动文件**：`packages/tools/src/builtin/external-tools.ts`
**估时**：0.5h
**验证**：执行 Python 生成文件 → 检查输出含文件路径提示

### T2.3 — 系统提示词沙箱复用指引

**目标**：Agent 在分析大数据时自动使用沙箱卸载策略

**实现**：在系统提示词的 `<offload>` 段增加：
```xml
<offload_rules>
当 query 返回超过 100 行时:
1. 不要把所有行都放进回复。给出摘要。
2. 需要深入分析时: execute_python 中 pd.read_csv 直接读数据
3. 分析完成后只返回结论，不返回原始数据
</offload_rules>
```

**改动文件**：`packages/cli/src/index.ts`（buildSystemPrompt）
**估时**：0.5h
**验证**：发送大查询 → Agent 自动使用 summarize_table + execute_python

### T2.4 — 沙箱清理策略

**问题**：旧会话的沙箱文件累积，导致 list_workspace_files 返回大量旧文件

**实现**：每次 `execute_python` 执行前，清理 `/tmp/` 中超过 30 分钟的旧文件

**改动文件**：`packages/tools/src/builtin/external-tools.ts`
**估时**：0.5h
**验证**：多次执行 Python → 检查旧文件被清理

---

## 五、Phase 3：知识缓存（下周）

### T3.1 — Schema Registry 自动采集

**设计**：每次 `describe_table` 执行后，自动缓存 schema 到 KnowledgeStore

```typescript
// 在 describeTableTool.execute 最后添加:
await knowledgeStore.add({
  domain: `schema:${tableName}`,
  fact: `${tableName} has columns: ${cols.map(c => `${c.name}(${c.type})`).join(', ')}`,
  keywords: `${tableName},schema,columns`,
  sourceSession: _sessionId,
  createdAt: Date.now(),
  confidence: 0.9,
})
```

**改动文件**：`packages/tools/src/builtin/duckdb.ts` + `packages/agent/src/knowledge-store.ts`
**估时**：2h
**验证**：describe table → 检查 knowledge.db 有 schema 条目

### T3.2 — 发现-验证循环

**设计**：Agent 在回答用户问题前，先查 KnowledgeStore 中是否有相关 schema 或值域信息

**实现**：在 app-server 的 knowledge 检索中，增加 schema 领域的权重

**改动文件**：`packages/app-server/src/index.ts`
**估时**：1.5h
**验证**：第一轮 describe → 第三轮问"华南区" → Agent 自动纠正值域

---

## 六、Bug 修复（穿插进行）

### B1 — agent_end 缺失

**根因**：Hono streamSSE 在 prompt() 返回后立即关闭，agent_end 的 writeSSE 可能被跳过

**修复**：在 prompt() 返回前加 `await new Promise(r => setTimeout(r, 100))` 确保最后一个事件被 flush

**改动文件**：`packages/app-server/src/index.ts`
**估时**：1h

### B2 — 服务偶发崩溃

**根因**：长时间的工具调用（web_search + execute_python）导致 Bun HTTP 超时

**修复**：
- app-server: 增加 `idleTimeout` 到 600s
- 工具调用: 增加超时处理和重试

**改动文件**：`packages/cli/src/index.ts` + `external-tools.ts`
**估时**：1h

---

## 七、执行顺序（按依赖关系）

```
Day 1 (今天)
├── T1.2 summarize_table ASCII 分布直方图 (1h)
├── T1.3 按行边界截断 (0.5h)
└── T2.1 修复 list_workspace_files (0.5h)

Day 2
├── T2.2 文件自动索引 (0.5h)
├── T2.3 提示词沙箱指引 (0.5h)
├── T2.4 沙箱清理 (0.5h)
└── B1 agent_end 修复 (1h)

Day 3
├── B2 服务稳定性 (1h)
├── T3.1 Schema Registry (2h)
└── T3.2 发现-验证循环 (1.5h)
```

---

## 八、每步验证标准

| 任务 | 验证方式 |
|------|---------|
| T1.2 | `summarize_table` 输出含 `▁▂▃▅` ASCII 分布 |
| T1.3 | 大查询截断在 `\n` 边界 |
| T2.1 | `list_workspace_files` 编译通过 + 可调用 |
| T2.2 | Python 执行后输出含 "📁 Sandbox files" |
| T2.3 | Agent 对大查询自动用 summarize + execute_python |
| T2.4 | 旧 /tmp/ 文件被自动清理 |
| T3.1 | knowledge.db 有 schema 条目 |
| T3.2 | Agent 第三轮自动纠正错误的列值 |
| B1 | SSE 含 agent_end 事件 |
| B2 | 连续 5 轮工具调用不崩溃 |

---

*所有任务估时合计约 10h，分 3 天执行。每一天结束时有可验证的交付。*
