# DataWhale 上下文管理 & 数据卸载 & 沙箱持久化 — 系统方案

> 2026-05-25 | 参考 OmniData Instance/Context/Compression 设计 + Claude Code / OpenCode 架构

---

## 一、问题全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                     DataWhale 上下文爆炸路径                       │
│                                                                  │
│  SQL Query ──→ 5000行结果 ──→ tool output ──→ LLM Context       │
│  Web Search ──→ 10篇长文 ──→ tool output ──→ LLM Context        │
│  Python Exec ──→ 图表+数据 ──→ tool output ──→ LLM Context      │
│  多轮对话 ──→ 每条消息累积 ──→ 全部注入 ──→ LLM Context         │
│                                                                  │
│  结果: Context 爆炸 → Token超限 → API 500 → Agent 崩溃           │
│        或: 截断丢失信息 → Agent 错误归因 → 幻觉链                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、总架构：三层卸载模型

```
┌──────────────────────────────────────────────────────────────┐
│                    第一层：LLM Context（最小、最精华）           │
│                    ~10K tokens max                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ System Prompt │ 摘要 │ 当前Turn │ 最近2轮关键信息        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           ▲                                   │
│                   压缩/摘要/截断                                │
│                           │                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │             第二层：Agent State（结构化内存）               │ │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐               │ │
│  │  │ Schema   │ │ Domain   │ │ Query       │               │ │
│  │  │ Registry │ │ Knowledge │ │ History     │               │ │
│  │  └──────────┘ └──────────┘ └────────────┘               │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           ▲                                   │
│                    提取/缓存                                   │
│                           │                                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │            第三层：E2B Sandbox（外部存储，无限制）           │ │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐               │ │
│  │  │ /tmp/    │ │ /mnt/oss/│ │ 完整数据集  │               │ │
│  │  │ CSV/JSON │ │ (持久)   │ │ 图片/图表  │               │ │
│  │  └──────────┘ └──────────┘ └────────────┘               │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、第一层：LLM Context 管理策略

### 3.1 分层截断策略（已实现 + 待优化）

| 工具 | 当前截断 | 优化后 | 原理 |
|------|---------|--------|------|
| query | 6000字符 + 1000行 | **按行边界截断** + 保留分布特征 | 不切断表格行；附带 rowCount/colStats |
| execute_python | 4000字符 | **stdout优先** → stderr摘要 | stdout比stderr更有信息量 |
| web_search | 每条300字符预览 | **保留title+URL**，正文300字摘要 | URL是追溯完整信息的锚点 |
| summarize_table | 列统计 | **增加分布直方图**(ASCII) | 让 LLM 看到数据形状 |

### 3.2 上下文压缩策略（新设计）

借鉴 OmniData 的 "压缩 Agent" 设计：

```
每 N 轮后触发压缩:
  完整历史 → LLM (低token模式) → 结构化摘要

摘要格式:
  <turn_summary>
    <user_intent>用户想了解华东区销售额趋势</user_intent>
    <actions>query(sales WHERE region='East'), execute_python(趋势图)</actions>
    <findings>华东区Q2销售额增长23%，主要由Widget A驱动</findings>
    <data_schema>sales表: region(4值), amount(FLOAT), date(DATE)</data_schema>
  </turn_summary>
```

**实施阶段**：
- Phase 1（本周）：简单摘要 —— 保留 user message + 第一句 assistant response
- Phase 2：LLM 压缩 —— 用 DeepSeek-Flash 生成结构化摘要
- Phase 3：智能压缩 —— 保留 schema/discoveries，丢弃冗余 tool output

### 3.3 优先级注入模型

```
Context 优先级:
  P0 (必须保留): 当前用户消息 + system prompt
  P1 (高价值): 上一轮的 assistant 结论 + 数据 schema
  P2 (参考): 前两轮的 tool 调用摘要
  P3 (可丢弃): 完整的 tool output (数据已在沙箱)
  P4 (噪音): 失败重试的中间结果
```

---

## 四、第二层：Agent State 知识缓存

### 4.1 Schema Registry（数据字典缓存）

**问题**：用户第1轮说"region 列有4个值"，5轮后 Agent 已遗忘。

**设计**：
```typescript
interface SchemaEntry {
  table: string
  columns: { name: string; type: string; distinctValues?: string[] }[]
  rowCount: number
  lastSeen: number
}
```

**自动采集**：每次 `describe_table` + `get_sample` 后自动缓存到 KnowledgeStore。

| LLM Context | Schema Registry |
|-------------|-----------------|
| 截断后不可见 | 持久化、跨轮可查 |
| 占用 token | 零 token（不在 context 中） |

### 4.2 发现-验证循环

```
Turn N:   Agent 发现 schema → 缓存
Turn N+1: Agent 询问"华南区" → 查 Registry → region无"华南" 
          → 直接纠正用户: "region只有East/West/North/South，您说的华南区是指South吗？"
          而不是: query → 空结果 → 困惑
```

---

## 五、第三层：E2B 沙箱数据持久化

### 5.1 沙箱生命周期管理

```
┌────────────┐     ┌────────────┐     ┌────────────┐
│ Create     │────→│ Pause      │────→│ Resume     │
│ (首次调用)  │     │ (会话结束)  │     │ (下次会话)  │
│ 冷启动 3-5s│     │ 文件保留    │     │ 毫秒级恢复  │
└────────────┘     └────────────┘     └────────────┘
                         │
                   30min 后自动销毁
                         │
                   需要长期保存 → /mnt/oss/
```

### 5.2 文件自动索引

**问题**：Agent 把完整数据写入沙箱后，几轮后忘记沙箱中有文件。

**设计**：每次 `execute_python` 结束后，自动扫描 `/tmp/` 新增文件，写入文件索引。

```typescript
interface SandboxFileIndex {
  sessionId: string
  files: { path: string; size: number; createdAt: number; source: string }[]
}
```

**Agent 行为**：
- `list_workspace_files` → 列出可用文件
- `execute_python` 中 `pd.read_csv('/tmp/data.csv')` → 直接访问
- 不需要重新 query → 节省 token

### 5.3 OSS 持久层（长期存储）

| 存储层 | 生命周期 | 用途 |
|--------|---------|------|
| /tmp/ | 单次会话（可 Pause/Resume） | 临时数据分析 |
| /mnt/oss/ | 永久（S3兼容存储） | 跨会话共享、大文件 |

---

## 六、工具卸载策略矩阵

### 6.1 各工具卸载配置总表

| 工具 | 输出截断 | 完整数据去向 | Agent 如何访问完整数据 | 截断信号 |
|------|---------|-------------|----------------------|---------|
| query | 6K字符 + 1K行 | 写入沙箱 /tmp/query_{ts}.csv | execute_python 读取 | `[不完整: N行, 仅展M行, 完整数据在沙箱]` |
| web_search | 300字/条 | details.result[] 完整保留 | 前端 tool detail 展开 | `[N条结果, 点击展开详情]` |
| execute_python | 4K字符 | stdout→截断; stderr→摘要; 文件→导出 | list_workspace_files | `[不完整: N chars total]` |
| summarize_table | 列统计 | details 中有完整统计数据 | — | 无截断（本身就是摘要） |
| list_tables | 表名列表 | details 中有完整表名 | — | 无截断 |
| describe_table | schema | details 中有完整列信息 | Schema Registry 缓存 | 无截断 |

### 6.2 Agent 的判断链（提示词层面）

```
大数据量分析判断流程:
1. query → 看返回行数
2. 如果 rowCount > 100:
   a. 先用 summarize_table 获取统计摘要
   b. 把完整数据写入沙箱: execute_python(code="...df.to_csv('/tmp/data.csv')...")
   c. 在沙箱中用 Python 分析: execute_python(code="pd.read_csv('/tmp/data.csv')...")
   d. 只把结论返回给用户
3. 如果需要多次分析同一数据:
   a. 先用 list_workspace_files 检查沙箱中是否已有数据
   b. 直接复用，不重新 query
```

---

## 七、实施路线图

### Phase 1：截断信号（P0，本周）

- [x] query 截断标注 `[不完整: N行/展M行]`
- [x] execute_python 截断标注 `[不完整: N chars]`
- [x] web_search 每条 300 字符预览
- [ ] summarize_table 增加分布直方图（ASCII）

### Phase 2：沙箱工具链（P1，本周）

- [x] list_workspace_files 工具
- [ ] execute_python 自动写入沙箱文件索引
- [ ] 系统提示词增加「沙箱文件复用」指引

### Phase 3：知识缓存（P2，下周）

- [ ] Schema Registry 自动采集（describe_table 后缓存）
- [ ] 发现-验证循环（查询前先查 Registry）
- [ ] LLM 上下文压缩器（OmniData 风格）

### Phase 4：OSS 持久层（远期）

- [ ] OSS 挂载自动化（s3fs 预装 template）
- [ ] 跨会话文件共享（同一用户不同会话可访问 OSS 文件）
- [ ] 文件版本管理

---

## 八、与 OmniData 的对齐

| OmniData 设计 | DataWhale 对应 | 状态 |
|--------------|---------------|------|
| Instance Context (工作区隔离) | sessionId + `~/.datawhale/plots/{sessionId}/` 目录隔离 | ✅ |
| 压缩 Agent (上下文压缩) | 待实现（Phase 3） | 📋 |
| Token 计数 & 限制 | TraceStore.tokenUsage | ⚠️ 记录但未用于限制 |
| LIMIT + 采样 | query LIMIT 1000 | ✅ |
| 多 Agent 上下文传递 | 未设计 | — |
| 实例注册 + 生命周期 | SessionStore CRUD | ✅ |

---

*本方案覆盖三层卸载模型、四种工具策略、四阶段实施路线。确认后从 Phase 1 剩余任务开始。*
