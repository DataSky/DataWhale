# E2B 沙箱 S3 持久化方案（备用）

> 当前 DataWhale 使用 Pause/Resume 作为主方案。S3 挂载作为长期持久化的兜底方案，当遇到以下情况时启用：
> - 沙箱 pause 超过 14 天被 E2B 清理
> - 需要跨多个沙箱/进程共享数据
> - 生产环境需要永久性文件存储

---

## 方案概述

在 E2B 沙箱内通过 s3fs（FUSE）挂载 AWS S3 bucket，使沙箱内 `/mnt/s3` 目录的所有读写操作直接持久化到 S3。

```
DataWhale CLI
    │
    ├── 首次: Sandbox.create() + 安装 s3fs + mount S3
    │
    ├── 每次 execute_python:
    │   ├── 代码操作 /mnt/s3/  →  自动同步到 S3 ✅
    │   └── matplotlib.savefig('/mnt/s3/plots/result.png')  → 永久保存 ✅
    │
    └── 退出: sandbox.kill()（数据已在 S3，无需 pause）
```

## 前置条件

1. AWS 账号 + S3 bucket
2. IAM 用户（Access Key + Secret Key），权限：`s3:GetObject`, `s3:PutObject`, `s3:ListBucket`
3. E2B API key（已有）

## 实现步骤

### Step 1：初始化时挂载 S3

在 `getSandbox()` 中，首次创建沙箱后自动执行挂载脚本：

```typescript
async function mountS3(sandbox: any): Promise<void> {
  const bucket = process.env.S3_BUCKET || ""
  const region = process.env.S3_REGION || "us-east-1"
  const accessKey = process.env.S3_ACCESS_KEY || ""
  const secretKey = process.env.S3_SECRET_KEY || ""

  if (!bucket) return // S3 not configured, skip

  // Install s3fs
  await sandbox.runCode("apt-get update -qq && apt-get install -y -qq s3fs", { timeoutMs: 60000 })

  // Write credentials
  await sandbox.files.write(
    "/root/.passwd-s3fs",
    `${accessKey}:${secretKey}`
  )
  await sandbox.runCode("chmod 600 /root/.passwd-s3fs")

  // Create mount point and mount
  await sandbox.runCode("mkdir -p /mnt/s3")
  const mountCmd = `s3fs ${bucket} /mnt/s3 -o passwd_file=/root/.passwd-s3fs -o url=https://s3.${region}.amazonaws.com -o allow_other -o use_cache=/tmp/s3cache`
  await sandbox.runCode(mountCmd, { timeoutMs: 15000 })
}
```

### Step 2：.env 配置

```bash
# S3 持久化（可选）
S3_BUCKET=datawhale-sandbox
S3_REGION=us-east-1
S3_ACCESS_KEY=AKIAXXX
S3_SECRET_KEY=xxx
```

### Step 3：代码中使用

Agent 执行 Python 时，只需将文件写入 `/mnt/s3/` 路径：

```python
import matplotlib.pyplot as plt
import pandas as pd

# 分析数据...
df = pd.DataFrame(...)
df.to_csv('/mnt/s3/results.csv', index=False)

# 生成图表
plt.plot(...)
plt.savefig('/mnt/s3/plots/revenue_trend.png')
```

文件自动持久化到 S3，下次新沙箱挂载同一 bucket 即可读取。

## 备选方案

### goofys（更高性能）

```bash
# 下载 goofys 二进制
wget -q https://github.com/kahing/goofys/releases/latest/download/goofys -O /usr/local/bin/goofys
chmod +x /usr/local/bin/goofys

# 挂载（自动从环境变量读取 AWS 凭证）
export AWS_ACCESS_KEY_ID=xxx
export AWS_SECRET_ACCESS_KEY=xxx
goofys my-bucket /mnt/s3 -o allow_other
```

### rclone mount（最灵活）

支持 40+ 存储后端，不仅是 S3：

```bash
curl https://rclone.org/install.sh | bash
rclone config  # 交互式配置
rclone mount s3remote:bucket /mnt/s3 --daemon
```

### Pre-signed URL（零挂载）

适合一次性文件传输，不需要 FUSE：

```bash
# 生成预签名 URL（沙箱外）
aws s3 presign s3://bucket/key --expires-in 3600

# 沙箱内直接下载
curl -o /tmp/data.csv "https://presigned-url..."
```

## 安全建议

1. **不要硬编码** Access Key/Secret Key —— 通过环境变量注入
2. **最小权限原则** —— IAM 用户只给 `s3:GetObject` + `s3:PutObject` + `s3:ListBucket`
3. **Bucket 策略** —— 限制 IP 范围或要求 HTTPS
4. **凭证轮换** —— 定期更换 Access Key

## 与 Pause/Resume 的对比

| 维度 | Pause/Resume | S3 挂载 |
|------|-------------|---------|
| 持久化时间 | 最长 14 天 | 永久 |
| 恢复内容 | 文件 + 内存 + 进程 | 仅文件 |
| 恢复速度 | ~1s/GB | 即时 |
| 跨沙箱共享 | ❌ | ✅ |
| 运维成本 | 零 | 需要 AWS 账号 |
| 适用场景 | 日常会话恢复 | 长期归档 / 多沙箱协作 |

---

*本文档记录于 2026-05-24。当前 DataWhale 默认使用 Pause/Resume，S3 方案作为进阶选项。*
