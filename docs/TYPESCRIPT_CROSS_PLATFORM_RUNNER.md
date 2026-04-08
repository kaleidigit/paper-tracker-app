# TypeScript 跨平台调度与推送方案

本文档描述一个资源高效、跨平台、可观测的 TypeScript 运行层。当前项目已去 Python 化，目标是将“每日一次任务”改为“单次执行即退出”，避免常驻进程持续占用内存。

## 1. 设计目标

- 非执行时段零常驻内存：通过操作系统计划任务触发一次性进程。
- 跨平台：Windows、macOS、Linux 均可运行（只依赖 Node.js）。
- 模块化：文献检索、内容处理、消息推送可独立替换实现。
- 稳定性：超时控制、失败隔离、结构化日志、运行状态落盘。
- 配置集中：业务参数统一在 `config.json`，密钥保留在 `.env`。

## 2. 架构概览

### 2.1 运行模式

- `run-once`：执行一次完整流程，完成后进程退出。
- `daemon`：兼容模式，保留轻量定时循环（不推荐生产使用）。
- `schedule install`：输出并可执行当前平台的计划任务命令。

推荐生产模式：`schedule install` + `run-once`。

### 2.2 模块边界

- Retrieval（检索）：
  - 输入：配置中的窗口参数
  - 输出：标准论文 JSON 列表
- Processor（处理）：
  - 输入：标准论文 JSON
  - 输出：增强论文 JSON（保持目标 schema）
- Publisher（推送）：
  - 输入：标题、markdown、records、papers
  - 输出：发布结果（文档 URL、通知结果、错误信息）

### 2.3 插件类型

- `http`：调用现有 HTTP 服务（如 `paper-hub` / `feishu-publisher`）。
- `command`：调用任意本地命令（便于替换为纯 Node 或第三方服务）。

## 3. 关键配置

在 `config.json` 增加：

- `runtime`：
  - `mode`: `run-once` 或 `daemon`
  - `state_dir`: 状态文件目录
  - `logs_dir`: 日志目录
  - `temp_dir`: 临时目录
  - `command_timeout_ms`: 命令执行超时
  - `retry.max_attempts` / `retry.backoff_ms`
- `modules.retrieval` / `modules.processor` / `modules.publisher`：
  - `type`: `http` or `command`
  - `http.base_url`、`http.endpoints.*`
  - `command.exec`、`command.args`
- `pipeline.schedule`：
  - 仍保留 `hour`、`minute`、`timezone` 作为系统计划任务的触发时间来源。

## 4. 生命周期与资源管理

- 每次任务启动独立 Node 进程。
- 临时文件统一写入 `runtime.temp_dir`，结束后清理。
- 子进程执行带超时与中断处理，异常时主动 `SIGTERM`/`SIGKILL` 回收。
- 运行状态写入 `runtime/state.json`：
  - `last_run_key`
  - `last_success_at`
  - `last_error`
  - `last_duration_ms`

## 5. 可观测性

- 结构化日志（JSON line）输出到：
  - 控制台
  - `runtime/logs_dir/YYYY-MM-DD.log`
- 运行指标写入 `runtime/metrics.json`：
  - 累计运行次数
  - 成功/失败次数
  - 平均耗时
  - 最近一次错误

## 6. 跨平台部署

### 6.1 前置条件

- Node.js 20+
- 安装依赖：`npm install`
- 构建：`npm run build`

### 6.2 手动执行一次

```bash
npm run runner:once
```

### 6.3 生成计划任务命令

```bash
npm run runner:schedule:print
```

### 6.4 自动安装计划任务

```bash
npm run runner:schedule:install
```

不同平台对应：

- Linux：`crontab`
- macOS：`launchd` plist
- Windows：`schtasks`

## 7. 运维建议

- 推荐将执行时间设置在网络低峰时段，并预留 10-20 分钟窗口。
- 监控 `state.json` 与 `metrics.json` 是否持续更新。
- 若连续失败，优先排查：
  - AI 密钥是否过期
  - 飞书权限/可见范围
  - 网络访问 OpenAlex 与 OpenAI-compatible API 是否正常
- 每次修改 `config.json` 后执行一次 `run-once` 进行回归验证。

## 8. 当前实现说明

- Retrieval/Processor/Publisher 均由 TypeScript 原生实现。
- 推送通过本机 `lark-cli` 命令模板执行。
- 若需扩展新平台，仅需新增命令模板与配置字段，无需改调度主干。
