# DeepSeek V4 缓存策略与 DataWhale 请求模式分析

> 2026-05-24 | 基于实际 API 行为 + 官方文档调研

---

## 一、DeepSeek 缓存机制

### 1.1 盘古缓存（Disk Cache）

DeepSeek V4 系列默认启用**自动盘古缓存**，特点：

| 特性 | 说明 |
|------|------|
| 启用方式 | 自动，无需配置 |
| 缓存粒度 | 前缀匹配（请求内容开头的连续字节序列） |
| 计费 | **缓存命中 token 不收费**（0 元） |
| 失效条件 | 前缀中任何字节变化 |
| 生效范围 | 同一 API key 下的所有请求 |
| 适用模型 | deepseek-v4-pro, deepseek-v4-flash |

### 1.2 与 Anthropic Prompt Caching 对比

| | DeepSeek | Anthropic |
|--|---------|-----------|
| 配置 | 自动，无需标记 | 需手动标记 `cache_control` |
| 缓存时长 | 未公开 | 5 分钟（可刷新） |
| 费用 | 免费 | 缓存写入 $1.25/M，读取 $0.10/M |
| 粒度 | 前缀匹配 | 指定断点 |

### 1.3 关键约束：reasoning_content 必须回传

DeepSeek V4 在 thinking 模式下会返回 `reasoning_content`。**后续请求的 assistant 消息必须包含此字段**，否则 API 返回 400：

```json
{
  "error": {
    "message": "The `reasoning_content` in the thinking mode must be passed back to the API.",
    "type": "invalid_request_error"
  }
}
```

---

## 二、DataWhale 当前请求模式

### 2.1 消息构建流程

```
每次 turn:
  1. 构建 system prompt（~800 tokens，固定）
  2. 追加完整历史消息（user → assistant → tool → user → ...）
  3. 发送给 API
```

### 2.2 缓存命中分析

```
Turn 1:
  ┌─────────────────────────────────┐
  │ System Prompt (固定，~800 tok)   │ ← 首次，不命中
  │ User: "分析销售数据"              │
  └─────────────────────────────────┘

Turn 2 (工具调用后):
  ┌─────────────────────────────────┐
  │ System Prompt (完全相同)         │ ← 缓存命中 ✅ 免费
  │ User: "分析销售数据" (相同)       │ ← 缓存命中 ✅ 免费
  │ Assistant: tool_calls...         │
  │ Tool: results...                 │
  │ User: "按区域分组" (新)          │ ← 新内容
  └─────────────────────────────────┘

Turn 3:
  ┌─────────────────────────────────┐
  │ System Prompt (完全相同)         │ ← 缓存命中 ✅
  │ User: "分析销售数据" (相同)       │ ← 缓存命中 ✅
  │ ...历史...                       │
  │ User: "看下趋势" (新)            │ ← 新内容
  └─────────────────────────────────┘
```

### 2.3 缓存效率评估

| 场景 | 前缀一致性 | 缓存命中率 |
|------|-----------|-----------|
| 单次会话多轮对话 | System + 早期轮次不变 | ✅ **高** |
| 不同会话 | System 固定 | ✅ System 部分命中 |
| 切换模型 | 模型 ID 不同 | ⚠️ 重新缓存 |
| 修改 System Prompt | 前缀变化 | ❌ 全部失效 |

---

## 三、优化建议

### 3.1 已实施 ✅

| 优化 | 状态 |
|------|------|
| System Prompt 固定不变 | ✅ 始终生效 |
| 消息追加式构建（不修改已有历史） | ✅ 前缀稳定 |
| reasoning_content 回传 | ✅ 2026-05-24 修复 |

### 3.2 待实施

#### A. 上下文压缩时保持前缀

当对话过长需要压缩时，裁剪**中间轮次**而非开头：
```
✅ 正确: System + 保留最近 N 轮
❌ 错误: 删除早期轮次 → 前缀变化 → 缓存全失效
```

#### B. 动态信息放到末尾

当前可用的表列表等动态信息放到 System Prompt 的**末尾**：
```
You are DataWhale... (固定部分，~700 tokens)  ← 缓存命中
... (固定结束)

Currently available tables:                   ← 动态部分
- products (10 rows)
- sales (15 rows)
```

这样固定前缀仍能命中缓存，只有末尾的动态信息是新的。

#### C. 降低 thinking 模式使用频率

`reasoning_content` 的 token 量可能很大，对于简单查询关闭 thinking 模式可以减少缓存压力：

```
deepseek-pro: 默认关闭 thinking，仅复杂任务开启
deepseek-flash: 始终关闭 thinking（已配置 maxTokens:1024）
```

---

## 四、监控指标

建议通过 `~/.datawhale/traces.db` 监控：

```sql
-- 每日 token 使用量
SELECT date(timestamp/1000, 'unixepoch') as day, 
       SUM(input_tokens) as input, SUM(output_tokens) as output
FROM traces WHERE event_type = 'llm_call'
GROUP BY day ORDER BY day DESC;

-- 平均每轮 token
SELECT avg(input_tokens) as avg_input, avg(output_tokens) as avg_output
FROM traces WHERE event_type = 'llm_call';

-- 每个会话的 token 成本
SELECT session_id, SUM(input_tokens) + SUM(output_tokens) as total_tokens,
       COUNT(DISTINCT turn) as turns
FROM traces WHERE event_type = 'llm_call'
GROUP BY session_id ORDER BY total_tokens DESC LIMIT 10;
```

---

## 五、总结

> **当前请求模式已最大限度利用 DeepSeek 缓存。** 固定 System Prompt + 追加式历史 = 前缀稳定不变，缓存命中率接近理论最优。核心约束（reasoning_content 回传）已修复。
>
> 后续优化方向：上下文压缩策略保持前缀、动态信息放末尾、降低 thinking 使用频率。

---

*关联文件: `packages/ai/src/providers/openai-compatible.ts`, `packages/agent/src/index.ts`*
