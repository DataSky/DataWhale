# DataWhale 系统行动规划 v3.1

> 2026-05-25 | 三天行动计划执行完毕后的更新版本

---

## 一、已完成（截至 2026-05-25）

### Day 1 — 截断完善 + 沙箱工具链 (commit `829976a`)
| 任务 | 内容 | 验证 |
|------|------|------|
| T1.2 | summarize_table ASCII 分布直方图 (▁▂▃▄▅▆▇█) | 直接测试通过 ✅ |
| T1.3 | query 按行边界截断 (lastIndexOf '\n') | 编译通过 ✅ |
| T2.1 | list_workspace_files 工具 | 编译通过 + 导出就绪 ✅ |
| T2.2 | execute_python 后自动文件索引 (📁 Sandbox workspace files) | 编译通过 ✅ |

### Day 2 — 沙箱指引 + 稳定性修复 (commit `579a74f`)
| 任务 | 内容 | 验证 |
|------|------|------|
| T2.3 | 系统提示词 `<offload_rules>` 段 (CLI + app-server) | 编译通过 ✅ |
| T2.4 | 沙箱清理策略 (>30min 自动删除) | 编译通过 ✅ |
| B1 | SSE agent_end 显式 flush (finally 块) | 编译通过 ✅ |

### Day 3 — Schema Registry + 发现-验证循环 (commit `e10629b`)
| 任务 | 内容 | 验证 |
|------|------|------|
| T3.1 | Schema Registry 自动采集 (tool_call_end → describe_table → knowledgeStore) | 链路已验证 ✅ |
| T3.2 | 发现-验证循环 (schema 前置 + [Schema] 权威标注) | 编译通过 ✅ |

### 附加修复（穿插在多次提交中）
| 修复 | 内容 |
|------|------|
| 日期注入 | CURRENT DATE 提到首行醒目格式 + app-server 动态构造 |
| 多轮上下文 | Web 端历史消息注入 Agent（slice(-20) 防爆炸） |
| 会话分裂 | useRef 避免 React 闭包陈旧值 |
| Query/Turn/Span | 四级模型落地 + 6/6 单元测试 |
| KnowledgeStore | 持久化 + 跨会话语义搜索 |
| Skill 系统 | 发现/匹配/注入 |
| DeepSeek V4 迁移 | 模型 ID 更新 + reasoning_content 回传 |

---

## 二、仍待处理

| # | 问题 | 优先级 | 估时 |
|---|------|--------|------|
| B2 | 服务偶发崩溃（API 超时 → fetch 需 AbortController + setTimeout） | P1 | 1h |
| B3 | 图片引用偶尔用本地路径 | P2 | 0.5h |
| B4 | 前端刷新偶发会话分裂 | P2 | 1h |
| P3 | 知识累积引擎深度集成（LanceDB 向量搜索） | 远期 | 3天 |
| P4 | 多数据源连接器 | 远期 | 3天 |
| P5 | Web UI 产品化打磨 | 远期 | 5天 |

---

## 三、当前架构关键指标

| 指标 | 数值 |
|------|------|
| 工具总数 | 13（DuckDB 4 + DataIO 3 + External 3 + SelfExtend 2 + Skill 1） |
| E2E 测试 | 5/5 通过 |
| 单元测试 (Query模型) | 6/6 通过 |
| SSE 事件类型 | 8（agent_start/end, turn_start/end, message_*, reasoning_*, tool_call_*, query_end, error） |
| 持久化层 | SQLite × 3（sessions.db / traces.db / knowledge.db） |
| Context 防护层 | 5 层（query截断/execute_python截断/web_search截断/compressToolContent/history slice(-20)） |

---

## 四、下一步建议

**短期（本周）**：B2 稳定性修复 + B4 会话分裂修复

**中期（下周）**：P3 知识累积引擎深度集成（LanceDB 向量语义搜索替代简单关键词匹配）

**长期**：Web UI 产品化 + 多数据源 + 社区 Extension 市场

---

*规划版本 v3.1 — 三天行动计划执行完毕。*
