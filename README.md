# 🦈 DataWhale

> AI-native data agent — 把数据交给 Agent，而非把 Agent 嵌入数据工具。

---

## 快速开始

```bash
# 1. 配置 API Key（三选一，推荐方式一）
cp .env.example .env && vim .env    # 方式一：项目 .env 文件（推荐）
export DEEPSEEK_API_KEY=sk-...      # 方式二：环境变量（临时）
mkdir -p ~/.datawhale               # 方式三：全局配置
echo '{"DEEPSEEK_API_KEY":"sk-..."}' > ~/.datawhale/config.json

# 2. 直接使用（无需每次 export！）
./dw "探索数据库结构"
```


## 安装（可选）

```bash
# 添加到 PATH，全局使用
echo 'export PATH="$HOME/path/to/DataWhale:$PATH"' >> ~/.zshrc
# 然后直接: dw "问题"
```

## 命令参考

```
./dw [选项] [提示词]

选项:
  -m, --model <模型>    模型别名 (默认: deepseek)
                         可选: deepseek, deepseek-reasoner, sonnet, haiku, gpt4o
  -v, --verbose         显示详细工具调用信息
  --max-turns <n>       最大 Agent 轮次 (默认: 30)
  -h, --help            显示帮助

环境变量:
  DEEPSEEK_API_KEY      DeepSeek API key（默认模型需要）
  ANTHROPIC_API_KEY     Anthropic API key（-m sonnet 时需要）
  OPENAI_API_KEY        OpenAI API key（-m gpt4o 时需要）
  DW_MODEL              默认模型 (默认: deepseek)
```

## 示例

```bash
# 使用 DeepSeek（默认）
./dw "分析 sales 表中各区域的销售额排名"

# 使用 DeepSeek R1 深度推理
./dw -m deepseek-reasoner "复杂的多维归因分析"

# 使用 Claude
export ANTHROPIC_API_KEY=sk-ant-...
./dw -m sonnet "生成数据洞察报告"

# 显示工具调用细节
./dw -v "这个数据库有什么特点？"

# 直接看帮助
./dw --help
```

## 项目结构

```
DataWhale/
├── dw                          # CLI 启动脚本
├── packages/
│   ├── ai/                     # AI Provider 抽象层
│   │   └── src/
│   │       ├── index.ts        # 统一 API、模型别名、provider 注册
│   │       └── providers/
│   │           ├── anthropic.ts        # Anthropic Messages API
│   │           └── openai-compatible.ts # DeepSeek/OpenAI (通用)
│   ├── agent/                  # Agent Runtime
│   │   └── src/index.ts        # 事件驱动循环、工具调用、状态管理
│   ├── tools/                  # Tool 系统
│   │   └── src/
│   │       ├── index.ts        # ToolRegistry、defineTool
│   │       └── builtin/
│   │           └── duckdb.ts   # DuckDB 查询/探索/采样
│   ├── extensions/             # 扩展系统
│   │   └── src/index.ts        # 动态加载、生命周期钩子
│   └── cli/                    # 命令行界面
│       ├── src/index.ts        # 交互式/非交互式终端
│       └── test/
│           ├── e2e.ts          # 单元/集成测试
│           └── integration.ts  # Agent 循环验证
└── DESIGN_ANALYSIS.md          # 设计分析文档
```

## 开发

```bash
# 安装依赖
cd DataWhale && bun install

# 运行测试
bun packages/cli/test/e2e.ts

# Agent 循环集成测试（需 API key）
export DEEPSEEK_API_KEY=sk-xxx
bun packages/cli/test/integration.ts
```

## 设计理念

DataWhale 不是一个"更强的 BI 工具"，而是一次范式转移：

| 传统 BI | DataWhale |
|---------|-----------|
| 对话驱动（人主导每一步） | 意图驱动（Agent 自治） |
| 固定角色 Agent | 能力组合 + 动态实例化 |
| SQL → 传统引擎 | 多策略并行探索 |
| Session 级状态 | 跨会话知识积累 |
| 插件注册 | 自扩展架构 |
| 单模型 | 多模型动态路由 |

详见 [DESIGN_ANALYSIS.md](./DESIGN_ANALYSIS.md)

## 已知限制

- **DuckDB WASM**: Worker 线程在 Bun 中有兼容性问题，需 Node.js 或预配置环境
- **文件数据库**: 当前仅支持内存数据库，文件持久化待后续版本
- **模型**: 默认使用 DeepSeek，需自行申请 API key

## License

MIT
