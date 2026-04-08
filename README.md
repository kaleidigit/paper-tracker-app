# 每日顶刊环境/能源论文追踪（纯 TypeScript 版）

本项目是一个本地部署的论文情报系统：每天自动抓取论文，进行 AI 翻译与增强，生成结构化结果并推送到飞书。

核心能力：

- 抓取：RSS + OpenAlex
- 处理：关键词筛选 + AI 复筛 + AI 翻译 + AI 增强
- 推送：飞书文档 + 群通知
- 调度：`run-once` + 系统计划任务（非执行时段零常驻内存）
- 保护：`papers=0` 自动失败并告警，阻止空日报误推送

## 1. 部署教程

### 1.1 环境要求

- Node.js 20+
- npm 9+
- 本机可访问 OpenAlex、AI Provider、飞书 API
- 本机已安装并可使用 `lark-cli`

### 1.2 初始化

```bash
cp .env.cn.example .env
npm install
npm run build
```

### 1.3 配置密钥

编辑 `.env`：

```env
SILICONFLOW_API_KEY=sk-xxx
OPENAI_API_KEY=
OPENAI_COMPATIBLE_API_KEY=
```

编辑 `config.json`：

- `pipeline.paper_window`: 抓取窗口（默认昨日上午 08:00 起）
- `ai.base_url / ai.model`: AI 接口与模型
- `feishu.notify_*`: 正常推送通知
- `feishu.alert_*`: 空数据/失败告警

## 2. 使用教程

### 2.1 执行一次全流程

```bash
npm run runner:once
```

或一键脚本（Unix）：

```bash
bash scripts/run_full_push.sh
# 或
npm run runner:full
```

### 2.2 LLM 翻译连通性自检

```bash
npm run runner:llm-check
```

若返回 `401` 或 `Invalid token`，请检查：

- `.env` 中 `SILICONFLOW_API_KEY` 是否有效
- `config.json -> ai.translation.api_key_env` 是否指向正确环境变量
- `config.json -> ai.base_url` 与 `ai.translation.model` 是否可用

### 2.3 启用每日自动执行

查看计划任务命令：

```bash
npm run runner:schedule:print
```

自动安装：

```bash
npm run runner:schedule:install
```

## 3. 运行结果检查

运行后重点检查：

- `data/ts-runner/state.json`: 最近一次状态（成功/失败）
- `data/ts-runner/logs/*.log`: 结构化运行日志
- `data/feishu-publisher/latest.json`: 最新推送文件路径
- `data/feishu-publisher/*-papers.json`: 论文结构化数据

当 `papers=0` 时系统行为：

- 立即终止增强与发布
- 标记本次运行失败
- 通过 `feishu.alert_cmd` 发送告警：`未获取到任何论文数据`

## 4. 结构化字段说明

每篇论文核心字段包括：

- `title_en` / `title_zh`
- `abstract_original` / `abstract_zh`
- `publication_type`
- `classification.domain/subdomain/tags`
- `summary_zh` / `novelty_points` / `main_content`

`publication_type` 来源优先级：

1. RSS 原始字段（若提供）
2. DOI 查询 OpenAlex `type`
3. 文章页元标签 `citation_article_type` 兜底

## 5. 测试与验证

```bash
npm test
```

建议每次配置变更后执行：

1. `npm run build`
2. `npm test`
3. `npm run runner:once`

## 6. 数据库升级脚本

如果你接入关系型数据库，请执行：

- [001_add_publication_type_and_bilingual.sql](migrations/001_add_publication_type_and_bilingual.sql)

## 7. 相关文档

- [功能增强实施计划](docs/IMPLEMENTATION_PLAN.md)
- [技术细节总览](docs/TECHNICAL_DETAILS.md)
- [TypeScript 跨平台调度与运维](docs/TYPESCRIPT_CROSS_PLATFORM_RUNNER.md)
- [飞书命令模板说明](docs/feishu-command-templates.md)
- [协作约束](AGENTS.md)
