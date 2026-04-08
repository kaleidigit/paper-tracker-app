# 功能增强实施计划

本文档对应以下目标：

1. `papers=0` 保护机制与告警
2. 抓取时间窗口固定为“昨日上午 08:00 及之后”
3. 集成 AI 翻译（标题与摘要）
4. 扩展论文类型字段 `publication_type`
5. 提供数据库结构更新脚本、API 调整说明、测试方案

## 1. 代码改造方案

### 1.1 空数据保护与告警

- 改造 `src/workflow.ts`
  - 在 `fetchPapers()` 后新增前置判断：`papers.length === 0` 时抛出 `EmptyPapersError`
  - 终止后续增强与推送
- 改造 `src/cli.ts`
  - 捕获 `EmptyPapersError`，将运行状态标记失败
  - 调用告警发送逻辑（复用 `feishu.alert_cmd` 或 `feishu.notify_cmd`）
  - 告警文本固定包含：`未获取到任何论文数据`

### 1.2 抓取窗口修正

- 改造 `src/modules.ts`
  - 新增严格窗口函数 `strictWindowStartAt()`，固定语义：
    - 以上海时区为默认
    - 起点 = 昨日 08:00
  - RSS 与 OpenAlex 都统一按该窗口过滤
  - 去除历史范围回退到过老日期的行为，避免抓取历史全集

### 1.3 AI 翻译链路

- 改造 `src/modules.ts`
  - 新增 `translatePaperFields()`：
    - 输入：`title_en`、`abstract_original`
    - 输出：`title_zh`、`abstract_zh`
  - 翻译调用与增强调用解耦
  - 翻译失败时回退为空字符串并记录 `translation_error`

### 1.4 论文类型字段

- 改造 `src/types.ts`
  - 在 `Paper` 增加 `publication_type?: string`
- 改造 `src/modules.ts`
  - RSS 来源提取：`dc:type` / `prism:publicationType` / `prism:section` / `category`
  - OpenAlex 提取：`type`
  - 输出统一标准化为小写（article/review/letter/editorial 等）
- 改造 `src/workflow.ts`
  - markdown 与 records 增加展示字段 `publication_type`

## 2. 数据库结构更新脚本

新增脚本：`migrations/001_add_publication_type_and_bilingual.sql`

- `publication_type` 字段
- `title_zh`、`abstract_zh` 字段（若旧表尚无）
- 建议索引：
  - `idx_papers_published_date`
  - `idx_papers_publication_type`

说明：当前系统默认落盘 JSON，不强依赖数据库；该脚本用于后续接入关系型存储时的兼容升级。

## 3. API/接口调整说明

### 3.1 输出结构新增字段

- `papers[].publication_type`
- `papers[].translation_error`（可选）

### 3.2 失败语义调整

- 当 `papers=0`：
  - 工作流返回失败
  - 不触发日报发布
  - 触发告警发送

## 4. 测试方案

### 4.1 单元测试

- 空数据保护：
  - 模拟 `fetchPapers()` 返回空数组
  - 断言抛出 `EmptyPapersError`
- 翻译函数：
  - 模拟 AI 成功/失败场景
  - 断言中英文字段与错误回退
- 类型提取：
  - RSS 与 OpenAlex 输入样例覆盖 article/review/unknown

### 4.2 集成测试

- 全链路（mock fetch）：
  - 检索 -> 翻译 -> 增强 -> 推送
  - 断言 `publication_type` 与中英文字段都存在
- 空数据场景：
  - 断言未触发 publish
  - 断言触发告警命令

## 5. 发布与回归验证

1. `npm run build`
2. `npm test`
3. `npm run runner:once`
4. 检查：
   - `data/ts-runner/state.json`
   - `data/ts-runner/logs/*.log`
   - `data/feishu-publisher/latest.json`
