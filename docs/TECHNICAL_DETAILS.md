# TECHNICAL DETAILS

本项目已重构为纯 TypeScript 架构，不再依赖 Python 或 Docker。

## 1. 模块职责（TypeScript）

- `src/modules.ts`
  - 拉取 RSS + OpenAlex
  - 关键词筛选 + LLM 复筛
  - 调用 OpenAI-compatible 接口做单篇增强
  - 执行飞书发布命令并落盘结果
- `src/workflow.ts`
  - 编排检索、处理、推送三阶段
  - 统一重试与失败隔离
- `src/cli.ts`
  - `run-once` 一次执行后退出
  - `daemon` 兼容模式
  - `schedule-print/install` 输出与安装系统计划任务

## 2. 运行方式

推荐生产模式：

1. `npm run build`
2. `npm run runner:schedule:install`
3. 系统计划任务每天触发 `run-once`

该模式确保非执行时段无常驻进程。

## 3. 配置与密钥

- `config.json`：业务配置（调度、抓取窗口、AI、飞书命令模板）
- `journals.json`：期刊源（RSS/ISSN）
- `classification.json`：领域树配置
- `.env`：仅放密钥（如 `SILICONFLOW_API_KEY`）

## 4. 数据模型

每篇论文目标字段：

- `title_en`
- `title_zh`
- `authors`
- `journal`
- `published_date`
- `doi`
- `url`
- `abstract_original`
- `abstract_zh`
- `summary_zh`
- `novelty_points`
- `main_content`
- `classification.domain`
- `classification.subdomain`
- `classification.tags`

## 5. 可观测性与状态

- 状态：`data/ts-runner/state.json`
- 指标：`data/ts-runner/metrics.json`
- 日志：`data/ts-runner/logs/*.log`
- 推送文件：`data/feishu-publisher/*.md|*.json`

## 6. 关键实现点

- 抓取窗口：`pipeline.paper_window`，支持 `since_yesterday_time`
- LLM 复筛：`ai.filter.enabled` 与 `ai.filter.min_confidence`
- Prompt 模板：支持 `{{taxonomy_json}}`, `{{paper_json}}`, `{{keywords_json}}`
- 推送命令：`feishu.doc_publish_cmd` / `feishu.base_publish_cmd` / `feishu.notify_cmd`

## 7. 测试

- 单元测试：调度判断、命令超时清理
- 集成测试：检索→增强→推送全链路（mock fetch）
