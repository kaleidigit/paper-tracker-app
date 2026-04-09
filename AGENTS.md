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

## 14. 当前标准 Workflow（必须对齐实现）

下面流程是当前项目的标准数据流，后续改动默认不能破坏：

1. 抓取基础信息（retrieval）
   - 从 RSS/OpenAlex 获取论文基础字段：`title_en`、`abstract_original`、`journal`、`published_date`、`doi`、`url`。
   - 同步抓取可直接获得的结构化字段：`authors`、`author_affiliations`、`image_url`、`publication_type`（若源可提供）。

2. 一次筛选：关键词命中
   - 使用 `config/config.json -> sources.keywords` 对标题+摘要+期刊进行规则筛选。
   - 命中则直接保留进入下一步。

3. 二次筛选：LLM 复筛（关键词未命中时）
   - 仅当关键词未命中时触发 LLM 二次判断 `keep/confidence/reason`。
   - 若 `keep=true` 且置信度满足阈值，论文保留；否则剔除。
   - 该步骤用于提升召回率，但必须受预算与超时控制。

4. 元数据补全（非 LLM）
   - 对缺失字段做确定性补全：`publication_type`、`image_url`、`author_affiliations`。
   - 优先顺序：源数据 > DOI/OpenAlex > 论文页面元标签（HTML meta）。

5. LLM 分类与翻译（仅三项核心任务）
   - LLM 负责：
     - 文献领域分类：`classification.domain/subdomain/tags`
     - 标题翻译：`title_zh`
     - 摘要翻译：`abstract_zh`
   - 不再要求 LLM 生成长文本解读，避免幻觉与高 token 消耗。

6. 结果标准化与发布
   - 生成结构化 `papers.json` 与展示层 `markdown/json`。
   - 发布到飞书（文档/消息/可选 Base）。
   - 推送产物按日期目录落盘：`data/feishu-publisher/YYYY-MM-DD/`。

7. 失败处理与可观测
   - 任一关键阶段失败应可感知（非零退出或结构化错误日志）。
   - 必须输出阶段日志：`workflow.fetch.*`、`workflow.enrich.*`、`workflow.publish.*`。

## 15. 下一阶段方向（出版社分治抓取）

下一步重构方向：对不同出版社/期刊源采用差异化抓取策略，以提升精度、容错与稳定性。

1. 按出版社建立抓取适配层（adapter）
   - 例如 `nature`、`science`、`pnas` 分别实现独立解析器。
   - 每个 adapter 明确字段优先级、页面结构规则和回退链路。

2. 统一标准输出，差异化输入解析
   - 不同源可以有不同抓取方式，但输出必须统一到标准 `Paper JSON`。
   - 禁止把源站特例扩散到核心 workflow 主干。

3. 强化容错与回退
   - 页面结构变化、字段缺失、反爬限流时，必须有降级策略（如回退 RSS、跳过可选字段、记录 warning）。
   - 对高价值字段（作者、单位、DOI、链接、主图）建立多来源兜底。

4. 质量与稳定性目标
   - 精准率优先于“看起来完整”。
   - 关键字段缺失率、抓取成功率、运行时长、失败重试率需可观测。
