# AGENTS.md

本文件定义后续在本仓库中进行协作开发时，人类与 AI agent 的共同约束。目标不是只让代码“能跑”，而是让这套系统长期保持：

- 可维护
- 可扩展
- 配置集中
- 中国大陆可用
- 适合持续 vibe coding

## 1. 项目一句话定义

这是一个“将顶刊环境与能源论文自动处理为结构化 JSON，并通过 AI 增强后推送到飞书”的本地部署系统。

当前实现状态（最小更新）：

- 已完成去 Python 化与去 Docker 化
- 当前运行形态为 Node.js/TypeScript 单进程编排（`run-once` + 系统计划任务）

## 2. 当前最高优先级

后续所有改动的优先级如下：

1. 配置集中化
2. 结构化结果标准化
3. OpenAI 接口统一化
4. 工作流正确性
5. 中国大陆部署稳定性
6. 可维护性
7. 功能扩展

如果某个改动会让系统更“炫”，但更难维护，应优先放弃。

## 3. 必须遵守的核心原则

### 3.1 AI 调用原则

- 一律按 `OpenAI-compatible API` 设计
- 默认供应商是硅基流动
- 但必须允许切换其他兼容供应商
- 不要把某一家 AI 平台硬编码到核心逻辑里

### 3.2 配置原则

- 所有非敏感、人工常改的配置统一放到 `config/config.json`
- 所有密钥、token、密码保留在 `.env`
- 不要继续增加分散在多处的业务配置

### 3.3 数据原则

- 系统核心产物是结构化 JSON
- Markdown、飞书文档、多维表格都只是展示层
- 如果 JSON 结构没有定义清楚，不要先做展示层优化

### 3.4 工作流原则

- 推送必须基于 AI 处理后的结果
- 不允许末端直接推送原始抓取结果冒充最终结果
- 工作流可以复杂，但数据流必须清晰

### 3.5 分类原则

- 分类体系必须配置化
- 一级领域、二级子领域、多标签应同时考虑
- 不要把领域树硬编码在函数里

## 4. 后续目标数据模型

每篇论文的目标结果至少应包含：

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

如果某次代码改动会破坏这个模型，必须明确说明。

## 5. 配置目标

后续默认应引入并维护：

- [config/config.json](/Users/kaleid/Documents/paper-tracker-app/config/config.json)

未来应由它统一管理：

- 期刊列表
- RSS 源
- ISSN
- 查询词
- 日期窗口
- 推送时间
- AI provider/base_url/model
- 提示词模板
- 领域分类树
- 飞书推送目标

## 6. 服务边界

### 6.1 `retrieval`（原 `paper-hub` 职责）

- 负责抓取和标准化
- 负责输出原始标准 JSON
- 不负责飞书展示层
- 不应耦合某个 AI 供应商

### 6.2 `runner`（原 `pipeline-runner` 职责）

- 负责调度和编排
- 负责调用 AI
- 负责把原始 JSON 转成增强 JSON
- 负责日报聚合
- 默认推荐 `run-once`，由系统计划任务触发；`daemon` 仅保留兼容模式

### 6.3 `publisher`（原 `feishu-publisher` 职责）

- 负责把增强后的结果写入飞书
- 只处理展示与投递
- 不应承载复杂分类逻辑或论文清洗逻辑

## 7. 文档优先级

只要下面内容发生变化，就必须同步修改文档：

- 配置结构
- JSON schema
- AI 接口调用方式
- 工作流数据流
- 推送逻辑

默认需要同步检查的文件：

- [README.md](/Users/kaleid/Documents/paper-tracker-app/README.md)
- [AGENTS.md](/Users/kaleid/Documents/paper-tracker-app/AGENTS.md)

## 8. 开发顺序约束

除非用户明确要求跳过，否则后续改造应优先按这个顺序推进：

1. 先改文档
2. 再确定配置模型
3. 再改代码
4. 最后联调与测试

不要反过来做。

## 9. 具体编码偏好

### 9.1 优先做

- 小步改造
- 配置驱动
- 字段命名稳定
- 输出结构明确
- 保留向后兼容路径

### 9.2 避免做

- 把配置散落在 `.env`、代码常量和编排脚本里
- 用硬编码 if/else 堆出领域分类
- 先改展示再补数据结构
- 在没有 schema 的前提下反复调整推送格式

## 10. 测试要求

未来每次代码改动后，至少要考虑这几类验证：

1. 配置加载是否正确
2. 原始论文 JSON 是否完整
3. AI 增强 JSON 是否符合 schema
4. runner 末端是否推送的是增强结果
5. 飞书发布是否保留结构化字段

至少要做本地模块测试或 mock 测试。

## 11. 推荐后续任务拆分

后续更适合按下面方式拆任务：

1. 新增 `config.json` 模型
2. 把 `.env` 缩减为密钥配置
3. 定义标准论文 JSON schema
4. 重构 `paper-hub`
5. 重构 `pipeline-runner`
6. 重构 `feishu-publisher`
7. 再做整体联调

## 12. 面向 vibe coding 的协作习惯

为了让后续协作顺畅，agent 在每次较大改动前应先明确这四点：

1. 这次改的是文档、配置、代码，还是调度编排
2. 这次改动会不会影响 JSON schema
3. 这次改动会不会影响 `config/config.json`
4. 这次改动后要怎么验证

如果这四点说不清，不应该直接开始大改。

## 13. 一句话约束

后续所有开发都应围绕这句话展开：

“把顶刊论文稳定转成可维护的 AI 增强 JSON，并通过统一配置驱动的工作流推送出去。”
