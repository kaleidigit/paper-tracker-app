# 每日顶刊环境/能源论文追踪（纯 TypeScript 版）

本项目已完成**完全去 Python 化**与**去 Docker 化**，仅依赖 Node.js 运行：

- 文献检索：RSS + OpenAlex（TypeScript 原生实现）
- AI 增强：OpenAI-compatible 接口（默认硅基流动）
- 飞书推送：本机 `lark-cli` 命令模板
- 调度执行：`run-once` + 系统计划任务（非执行时段零常驻内存）

## 1. 快速开始

```bash
cp .env.cn.example .env
npm install
npm run build
npm run runner:once
```

一键全流程推送（Unix 可执行脚本）：

```bash
bash scripts/run_full_push.sh
# 或
npm run runner:full
```

## 2. 计划任务（跨平台）

查看当前平台安装命令：

```bash
npm run runner:schedule:print
```

自动安装：

```bash
npm run runner:schedule:install
```

## 3. 关键配置

### 3.1 `.env`

```env
SILICONFLOW_API_KEY=sk-xxx
OPENAI_API_KEY=
OPENAI_COMPATIBLE_API_KEY=
```

### 3.2 `config.json`

重点字段：

- `pipeline.schedule.*`: 每日执行时间
- `pipeline.paper_window.*`: 抓取时间窗口
- `runtime.*`: 重试、日志、状态、临时目录配置
- `sources.*`: 期刊、关键词、OpenAlex 查询词
- `ai.*`: 模型、base_url、prompt、筛选参数
- `feishu.*`: 文档/通知命令模板与目标

## 4. 运维文件

- 运行状态：`data/ts-runner/state.json`
- 运行指标：`data/ts-runner/metrics.json`
- 结构化日志：`data/ts-runner/logs/*.log`
- 推送产物：`data/feishu-publisher/*.md|*.json`

## 5. 测试

```bash
npm test
```

## 6. 相关文档

- [技术细节总览](docs/TECHNICAL_DETAILS.md)
- [TypeScript 跨平台调度与运维](docs/TYPESCRIPT_CROSS_PLATFORM_RUNNER.md)
- [飞书命令模板说明](docs/feishu-command-templates.md)
- [协作约束](AGENTS.md)
