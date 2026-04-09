# 论文追踪系统知识库

本项目将顶刊环境/能源论文自动处理为结构化 JSON，完成 AI 翻译与增强后推送到飞书。

## 项目总览
- 架构：`retrieval -> runner -> publisher` 三段式，本地单进程编排（`run-once` + 系统计划任务）。
- 依赖：Node.js 20+、npm 9+、OpenAlex、OpenAI-compatible API、飞书开放平台、`lark-cli`。
- 配置：业务配置集中在 `config/config.json`，密钥仅放 `.env`。
- 数据：结构化 JSON 是核心产物，Markdown/飞书文档/多维表格是展示层。
- 可靠性：`papers=0` 直接失败并触发告警，阻断空日报发布。

## 架构与依赖关系
### 模块职责
- `retrieval`：RSS + OpenAlex 抓取与标准化，输出原始论文 JSON。
- `runner`：关键词筛选、LLM 复筛、翻译、增强、调度与状态管理。
- `publisher`：将增强结果投递到飞书文档、消息与（可选）多维表格。

### 关键依赖
- 数据源：期刊 RSS、OpenAlex（DOI/type 补全）。
- AI：OpenAI-compatible 接口（默认硅基流动，可切换）。
- 投递：`lark-cli`（本机执行模式）与飞书 API。
- 本地文件：`data/ts-runner/*`（状态/日志/指标）、`data/feishu-publisher/*`（投递产物）。

## 标准数据模型
- 基础字段：`title_en`、`title_zh`、`authors`、`journal`、`published_date`、`doi`、`url`。
- 扩展字段：`author_affiliations`、`image_url`（主图链接）。
- 摘要字段：`abstract_original`、`abstract_zh`。
- 增强字段：`summary_zh`、`novelty_points`、`main_content`。
- 分类字段：`classification.domain`、`classification.subdomain`、`classification.tags`。
- 类型字段：`publication_type`（RSS -> OpenAlex -> HTML meta 兜底回填）。

默认运行策略（LLM 仅做必要任务）：
- `ai.filter.enabled=true`：LLM 负责判断论文是否保留。
- `ai.enrich.enabled=true`：LLM 仅负责领域分类（`classification`），不生成长文本。
- `ai.translation.enabled=true`：LLM 仅负责 `title_zh` 与 `abstract_zh` 翻译。
- `summary_zh`、`novelty_points`、`main_content` 默认清空，不再生成。
- 翻译 prompt 在 `config/config.json -> ai.prompts.translation_system / translation_user_template` 中可直接修改。

## 首次部署
### 一键部署（仅部署）

```bash
curl -sSL https://raw.githubusercontent.com/<repo>/main/deploy.sh | bash
```

本脚本默认完成：依赖安装、构建、`lark-cli` 初始化与登录。  
不会执行论文抓取与推送。

### 本地仓库部署

```bash
cp config/.env.cn.example .env
./deploy.sh
```

### 日常推送（仅推送）

部署完成后，每次只需执行：

```bash
./scripts/push.sh
```

说明：
- 默认可直接执行 `push.sh`，不会强制要求每次重新扫码授权。
- 若你确实依赖 user 身份接口，可设置 `PUSH_REQUIRE_LARK_AUTH=1` 强制校验登录态。
- 一般情况下（`--as bot` 推送）只要 `config/.env` 与飞书应用配置正确即可日常自动运行。

### 故障复现与根因（`keychain not initialized`）
- 触发条件：首次安装、`~/.lark-cli/keychain.json` 不存在、无图形界面终端、CI 新环境。
- 典型现象：任意需要 user 身份的命令先读取 keychain，未初始化时直接报错。
- 复现步骤：

```bash
rm -rf ~/.lark-cli
lark-cli auth status
```

- 典型报错（示例）：

```json
{
  "ok": false,
  "error": {
    "type": "auth",
    "message": "keychain not initialized"
  }
}
```

- 根因：新机器上 `lark-cli` 配置与设备授权状态为空，命令执行路径未自动完成 `config init + auth login`。

### 部署脚本的自动修复逻辑
- 检测：若 `~/.lark-cli/keychain.json` 缺失，或命令输出包含 `keychain not initialized`。
- 初始化：优先执行 `lark-cli config init --non-interactive`，不支持时自动回退到 `--app-id/--app-secret-stdin`。
- 授权：优先执行 `lark-cli auth login --no-wait` 设备码轮询，若版本不支持再回退 `--qr-console`。
- 权限收敛：默认仅申请 `im,docs,base` 三类域权限（群消息、在线文档、多维表格）。
- 导出：解析授权链接并输出 `LARK_AUTH_URL=<url>`，可被 CI 日志或外部脚本捕获。
- 保障：默认超时 `300s`、可重试，单次轮询调用有独立超时保护，最终未获得合法 token 返回非零状态码。
- 判定：兼容 `auth status` 返回 `"ok": true` 或 `"tokenStatus": "valid"` 两种成功格式。

### 无图形界面授权
- 场景 A（本地有浏览器）：直接点击终端输出链接，或复制 `LARK_AUTH_URL` 到浏览器打开并扫码。
- 场景 B（远程 SSH）：在远端执行脚本，复制 `LARK_AUTH_URL`，到本地浏览器打开后扫码授权。
- 场景 C（CI/CD 暂停人工扫码）：执行 `./deploy.sh --manual-auth` 打印链接并暂停，扫码后继续 `./deploy.sh`。

### 一键复制命令块

```bash
# 部署（自动登录模式，默认）
./deploy.sh --auth-timeout 300 --auth-retries 2

# 部署（手动授权，仅输出 URL）
./deploy.sh --manual-auth

# 部署（自定义授权域）
./deploy.sh --auth-domains im,docs,base

# 部署（认证轮询参数）
./deploy.sh --auth-poll-interval 1 --auth-single-poll-timeout 8

# 推送（抓取+增强+发布）
./scripts/push.sh
```

### 二维码/链接输出示例

```text
[deploy] lark auth bootstrap attempt 1/2
LARK_AUTH_URL=https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=...&user_code=...
[deploy] 等待扫码授权中，剩余 300s...
[deploy] manual mode finished. 请扫码授权后再次执行 ./deploy.sh 完成后续部署。
```

## 日常运行与验证
### 常用命令

```bash
npm run push
npm run runner:llm-check
npm run runner:schedule:print
npm run runner:schedule:install
npm test
```

### 运行可观测性与防卡住
- 终端会输出阶段日志：`workflow.fetch.*`、`workflow.enrich.*`、`workflow.publish.*`。
- 当看到持续停留在 `workflow.fetch.filter.start`，说明在执行 LLM 复筛，不是进程卡死。
- 可通过 `config/config.json -> ai.filter.max_checks_per_run` 限制单次运行的 LLM 复筛次数（默认 `8`），缩短总耗时。

### Nature 作者信息抓取
- 对 `nature.com/articles/*` 链接，会在入库时额外抓取论文页，优先解析 `Author information` 区域与 `citation_author/citation_author_institution` 元标签。
- 当页面未提供完整字段时，才回退 RSS 原始作者与机构信息。

### 运行结果检查
- `data/ts-runner/state.json`：最近一次状态。
- `data/ts-runner/logs/*.log`：结构化日志。
- `data/ts-runner/metrics.json`：累计指标。
- `data/feishu-publisher/YYYY-MM-DD/`：当日推送文件目录（markdown/json/papers）。
- `data/feishu-publisher/latest.json`：最近一次投递索引。

## CI 与验收
- CI 默认执行构建、测试与 markdownlint。
- CI 新增 `markdownlint`：文档 PR 需通过格式校验。
- 验收建议：在 Ubuntu 22.04、macOS 13、Alpine 3.18 分别执行一键部署命令并保留日志归档。

## 文件树与职责

```text
paper-tracker-app/
├── .github/
│   └── workflows/
│       └── ci.yml                        # 构建、测试与文档校验
├── .gitignore                     # Git 忽略规则
├── .markdownlint-cli2.jsonc       # markdownlint 配置
├── AGENTS.md                      # 协作约束与架构原则
├── README.md                      # 统一知识库与部署入口（本文件）
├── config/
│   ├── .env.cn.example            # 中文环境变量模板
│   ├── .env.example               # 通用环境变量模板
│   ├── classification.json        # 领域树配置（domain/subdomain/tags）
│   ├── config.json                # 统一业务配置（调度、AI、飞书命令等）
│   └── journals.json              # 期刊源、RSS、ISSN 等配置
├── deploy.sh                      # 一键部署主脚本（含 lark 自动修复）
├── docs/
│   └── feishu-command-templates.md # 飞书模块专属参数
├── migrations/
│   └── 001_add_publication_type_and_bilingual.sql  # 数据库兼容升级脚本
├── package-lock.json              # npm 依赖锁定
├── package.json                   # Node 脚本入口与依赖声明
├── scripts/
│   └── push.sh                    # 日常推送脚本（仅执行推送）
├── src/
│   ├── cli.ts                     # CLI 主入口（run-once/daemon/schedule）
│   ├── command.ts                 # 子命令执行与超时控制
│   ├── config.ts                  # 配置加载与校验
│   ├── llm-check.ts               # 翻译链路连通性检查
│   ├── logger.ts                  # 结构化日志
│   ├── modules.ts                 # 抓取/筛选/翻译/增强/发布模块实现
│   ├── schedule-install.ts        # 系统计划任务安装逻辑
│   ├── scheduler.ts               # 调度窗口与触发逻辑
│   ├── storage.ts                 # 本地文件落盘与读取
│   ├── types.ts                   # 核心类型定义（Paper 等）
│   └── workflow.ts                # 检索->处理->推送编排主流程
├── tests/
│   ├── command.test.ts            # 命令执行相关单元测试
│   ├── scheduler.test.ts          # 调度逻辑测试
│   └── workflow.integration.test.ts # 全链路集成测试（mock fetch）
├── tsconfig.build.json            # 构建专用 TS 配置
├── tsconfig.json                  # TS 开发配置
└── vitest.config.ts               # 测试框架配置
```

## 目录结构规范
- `config/`：项目业务配置与模板配置文件，所有人工常改业务参数统一放这里。
- `docs/`：说明文档与模块级手册；根目录只保留总入口 `README.md` 与协作约束 `AGENTS.md`。
- `scripts/`：仅保留可长期复用的运维脚本（当前为 `push.sh`）。
- `src/`：运行时代码；`tests/`：测试代码；`migrations/`：数据库升级脚本。
- 根目录仅保留工程入口文件（`package.json`、`deploy.sh`、TypeScript 工具链配置等）。

## 文档索引
- 协作规范与优先级：[AGENTS.md](AGENTS.md)
- 飞书命令模板专属参数：[docs/feishu-command-templates.md](docs/feishu-command-templates.md)
