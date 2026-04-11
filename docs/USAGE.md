# 使用说明

## 环境要求

- **Node.js**：20+
- **npm**：9+
- **SILICONFLOW_API_KEY**：在 [siliconflow.cn](https://www.siliconflow.cn) 获取
- **lark-cli**：飞书 CLI 工具（部署时自动安装）

## 安装步骤

```bash
# 1. 克隆仓库
git clone <repo-url>
cd paper-tracker-app

# 2. 配置环境变量
cp config/.env.cn.example .env
# 编辑 .env，填入 SILICONFLOW_API_KEY、LARK_APP_ID、LARK_APP_SECRET

# 3. 部署（安装依赖 + 构建 + lark-cli 授权）
./deploy.sh
```

## 日常运行

### 方式一：直接运行（推荐）

```bash
./push.sh
```

### 方式二：Dry-run（仅生成 md/json，跳过飞书发布）

```bash
./push.sh --dry-run
# 或
npm run push:dry-run
```

> 适用于：调试采集逻辑、预览日报内容、验证关键词过滤，无需飞书授权即可运行。

### 方式二：调试模式（查看完整日志）

```bash
npm run runner:once
```

### 方式三：定时任务（每日自动）

```bash
# 安装 macOS launchd / Windows Task Scheduler / Linux crontab
npm run runner:schedule:install

# 查看已安装的调度任务
npm run runner:schedule:print
```

## 运行日志解读

```
workflow.fetch.start              # 开始抓取
workflow.fetch.filter.budget      # LLM 过滤预算
workflow.fetch.rss.start          # Nature RSS 开始
workflow.fetch.rss.done           # Nature RSS 完成
workflow.fetch.openalex.start    # OpenAlex 开始
workflow.fetch.openalex.done     # OpenAlex 完成
workflow.fetch.done               # 抓取完成，返回论文数
workflow.enrich.concurrency      # enrich 并发数
workflow.enrich.paper             # 正在增强第 N 篇
workflow.enrich.done              # 增强完成
workflow.publish.start           # 开始发布
workflow.publish.done            # 发布完成
```

**`papers=0` 告警**：未获取到任何论文，飞书收到告警通知，日报终止推送。

## 输出产物

| 文件 | 说明 |
|------|------|
| `data/feishu-publisher/YYYY-MM-DD/*.md` | 日报 Markdown |
| `data/feishu-publisher/YYYY-MM-DD/*.json` | 论文记录 JSON |
| `data/feishu-publisher/YYYY-MM-DD/*-papers.json` | 完整论文数据（含 enrichment）|
| `data/feishu-publisher/latest.json` | 最近一次运行的索引 |
| `data/ts-runner/state.json` | 最近一次运行状态 |
| `data/ts-runner/logs/*.log` | 结构化日志 |

## 配置指南

### 添加新期刊（以 Nature 子刊为例）

在 `config/journals.json` 中添加：

```json
{
  "name": "Nature Water",
  "source_group": "Nature",
  "issn": "2095-5943",
  "publisher_strategy": "nature-rss",
  "rss_feeds": ["https://www.nature.com/natwater.rss"]
}
```

**Nature 系列**：`publisher_strategy = "nature-rss"`，需提供 RSS feed URL。

**Science / PNAS / Joule / EES 等**：`publisher_strategy = "openalex"`，只需提供 ISSN，RSSHub 不可用时使用 OpenAlex API。

### 调整分类关键词

编辑 `config/classification.json`，在对应 `subdomain.keywords` 中添加或删除关键词：

```json
{
  "name": "能源",
  "subdomains": [{
    "name": "储能与电池",
    "keywords": ["battery", "energy storage", "solid-state battery"]
  }]
}
```

### 调整 OpenAlex 搜索关键词

编辑 `config/config.json`：

```json
{
  "sources": {
    "openalex_queries": ["energy", "climate", "carbon", "water", "emission"]
  }
}
```

### 调整 LLM 过滤预算

```json
{
  "ai": {
    "filter": {
      "max_checks_per_run": 10
    }
  }
}
```

### 调整 enrich 并发数

```json
{
  "ai": {
    "enrich": {
      "concurrency": 5
    }
  }
}
```

并发数越高，LLM 调用越快，但需注意 API 速率限制。

## 常见问题

### 1. LLM 翻译失败（`translation_required_failed`）

- 检查 `SILICONFLOW_API_KEY` 是否正确
- 检查网络是否能访问 `https://api.siliconflow.cn`
- 检查模型名称是否正确（如 `deepseek-ai/DeepSeek-V3.2`）

```bash
npm run runner:llm-check
```

### 2. 飞书文档创建失败

- 检查 `lark-cli` 是否已登录：`lark-cli auth status`
- 重新授权：`./deploy.sh`
- 检查机器人是否有文档写入权限

### 3. Science / PNAS 论文未抓到

- 确认 `config/journals.json` 中对应期刊的 `publisher_strategy` 为 `"openalex"`
- 确认 `openalex_queries` 包含相关关键词
- 检查 `https://api.openalex.org` 是否可访问

### 4. 作者信息为空

Nature 文章的作者信息依赖页面 JSON-LD 解析：
- 检查文章页面是否有 `<script type="application/ld+json">`
- 确认网络可访问 `nature.com` 文章页

### 5. 日报为空

- 检查 `data/ts-runner/logs/*.log` 中的 `workflow.fetch.done` 事件
- 确认论文窗口时间（默认昨天 08:00 之后）
- 确认关键词匹配（标题/摘要/期刊名）

### 6. Author Correction / Retraction 论文未出现在日报中

这是预期行为。系统会自动排除以下类型的论文，不消耗 LLM 预算：
- 标题含 "Author Correction"、"Publisher Correction"、"Correction"、"Retraction"
- 标题含 "News & Views"、"Research Briefing"、"Briefing Chat"

如需临时关闭此行为，修改 `src/utils.ts` 中 `shouldSkipLlmRescueByTitle` 函数。

## 开发命令

```bash
npm run build          # 编译 TypeScript
npm test               # 运行测试
npm run push           # 正式推送（飞书发布）
npm run push:dry-run   # Dry-run（仅生成 md/json）
npm run runner:once     # 单次运行（调试）
npm run runner:llm-check  # LLM 连通性检查
```
