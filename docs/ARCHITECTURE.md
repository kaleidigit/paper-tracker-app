# 系统架构文档

## 1. 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     定时触发（每日 08:30）                     │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  fetchPapers()                                              │
│  ├── NatureParser.collect()     Nature 系列 RSS + 页面 JSON-LD │
│  │   └── ArticlePageParser      通用 HTML 页面解析器          │
│  └── OpenAlexParser.collect()   Science / PNAS / Joule / EES  │
│       └── fetchJson (3 retries)  重试 3 次，指数退避           │
│  ├── 去重（DOI > URL > 期刊+标题）                          │
│  └── 去重后按发布日期倒序                                    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  enrichPapers() —— p-limit 并发（默认 3）                    │
│  ├── translatePaperFields()  LLM 翻译（title_zh + abstract_zh）│
│  └── classifyPaper()         LLM 分类（domain / subdomain）  │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  publishDigest()                                          │
│  ├── 本地文件落盘（.md / .json / -papers.json）              │
│  ├── lark-cli docs +create  创建飞书文档                   │
│  └── lark-cli im +messages-send  发送通知                   │
└─────────────────────────────────────────────────────────────┘
```

## 2. 数据流

```
期刊 RSS / OpenAlex API
        │
        ▼
┌──────────────────┐    ┌───────────────────┐    ┌──────────────────┐
│  Nature RSS Feed │    │  OpenAlex API     │    │  LLM 二次筛选     │
│  (nature.com)     │    │  (Science/PNAS等) │    │  (filterBudget)   │
└────────┬─────────┘    └────────┬──────────┘    └──────────────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
          ┌──────────────────────┐
          │  buildPaper()        │
          │  统一 Paper 数据结构   │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  enrichPapers()      │
          │  翻译 + 分类         │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  publishDigest()     │
          │  飞书文档 + 通知     │
          └──────────────────────┘
```

## 3. 采集器详解

### 3.1 NatureParser（Nature 系列）

**策略**：`publisher_strategy: "nature-rss"`

**流程**：
1. 读取 `journals.json`，筛选所有 `publisher_strategy === "nature-rss"` 的期刊 RSS feed
2. 解析 XML，获取标题、摘要、发布日期
3. 时间窗口过滤（默认：昨天 08:00 之后）
4. 关键词匹配或 LLM 二次筛选
5. **抓取文章页面** → `ArticlePageParser` 解析 JSON-LD / HTML meta，提取作者、单位、摘要、发表类型、主图
6. 调用 `buildPaper()` 构建统一 Paper 对象

**元数据解析优先级**：
```
JSON-LD (ScholarlyArticle)  >  HTML meta 标签  >  RSS 原始字段
```

### 3.2 OpenAlexParser（Science / PNAS 等）

**策略**：`publisher_strategy: "openalex"`

**流程**：
1. 读取 `journals.json`，筛选所有 `publisher_strategy === "openalex"` 的期刊，按 ISSN 分组
2. 构建 OpenAlex API 请求：`filter=from_publication_date:YYYY-MM-DD,type:article,primary_location.source.issn:ISSN1|ISSN2|...`
3. 按 `openalex_queries` 关键词列表逐一查询（默认：energy, climate 等）
4. **最多 25 篇/页**，带重试（3 次，指数退避 500ms）
5. 解析 `authorships[]` 提取作者 + 单位，`abstract_inverted_index` 还原摘要
6. 调用 `buildPaper()` 构建统一 Paper 对象

**OpenAlex 优势**：
- 完整作者列表（含多位合作者）
- 作者所属机构
- 结构化摘要（`abstract_inverted_index`）
- 免费公开 API，无需认证

### 3.3 ArticlePageParser（通用页面解析器）

**支持出版社**：Nature / Science / PNAS / Cell / RSC 等主流期刊

**解析方法**（按优先级）：
1. **JSON-LD**（`<script type="application/ld+json">`）
   - `@type` 为 `Article` / `ScholarlyArticle` 时提取
   - `author[].name` → 作者列表
   - `author[].affiliation[].name` → 单位列表
   - `description` → 摘要
   - `articleSection` → 发表类型
   - `image.url` → 主图
2. **HTML meta 标签**（回退）
   - `citation_author` → 作者
   - `citation_author_institution` → 单位
   - `og:image` / `twitter:image` → 主图
   - `citation_article_type` → 发表类型

## 4. 配置说明

### 4.1 journals.json

```jsonc
{
  "name": "Nature Energy",
  "source_group": "Nature",
  "issn": "2058-7546",
  "publisher_strategy": "nature-rss",   // nature-rss | openalex
  "rss_feeds": ["https://www.nature.com/nenergy.rss"]  // 仅 nature-rss 需要
}
```

**publisher_strategy**：
- `nature-rss`：Nature 系列，使用 RSS + 页面抓取
- `openalex`：Science / PNAS / Joule 等，使用 OpenAlex API

### 4.2 classification.json

三级分类体系：`domain → subdomain → keywords`

```json
{
  "domains": [{
    "name": "能源",
    "subdomains": [{
      "name": "储能与电池",
      "keywords": ["battery", "energy storage", "lithium-ion"]
    }]
  }]
}
```

关键词用于**规则分类**（heuristic），优先于 LLM 分类结果。

### 4.3 config.json 关键字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `ai.filter.max_checks_per_run` | 20 | LLM 二次筛选预算上限 |
| `ai.enrich.concurrency` | 3 | enrichPapers 并发数 |
| `pipeline.paper_window.hour` | 8 | 论文窗口起始小时（本地时间） |
| `sources.openalex_queries` | `["energy","climate"]` | OpenAlex 搜索关键词 |

## 5. LLM 过滤机制（filterBudget）

三个采集器**共享同一个预算池**：

```
filterBudget = { remaining: 20 }

NatureParser        消耗 1 次
OpenAlexParser       消耗 1 次
...
remaining = 0 时    跳过所有 LLM 过滤
```

**适用场景**：论文标题/摘要不含关键词，但 LLM 判断属于能源/气候领域。

**自动跳过类型**：以下标题模式的论文在采集阶段直接排除，不消耗 LLM 预算，也不进入日报：
- Author Correction / Publisher Correction / Correction
- Retraction
- Briefing Chat / Research Briefing / News & Views
- Career Column / Podcast

判断函数为 `shouldSkipLlmRescueByTitle()`（`src/utils.ts`），在 `matchesKeywords` 检查**之前**独立执行，且在 `enrichPapers` 中有第二层防御。

## 6. 文件组织

```
src/
├── modules.ts          # LLM 翻译/分类/筛选，发布入口，workflow 编排
├── utils.ts           # 共享工具函数（normalizeText / dedupeStrings 等）
├── parsers/           # 采集器模块
│   ├── types.ts       # ArticleMeta / JournalEntry / FilterBudget
│   ├── article-parser.ts   # 通用文章页面解析器
│   ├── nature-parser.ts    # Nature 系列采集器
│   └── openalex-parser.ts  # OpenAlex API 采集器
└── workflow.ts        # runWorkflow 编排（fetch → enrich → publish）
```

**模块依赖关系**：
```
modules.ts  ──import──▶  utils.ts
       └──import──▶  NatureParser  ──import──▶  ArticlePageParser
                └──import──▶  OpenAlexParser
                                   └──import──▶  utils.ts

parsers ──import──▶  modules.ts (loadTaxonomy, llmFilter)
                └──import──▶  utils.ts
```
