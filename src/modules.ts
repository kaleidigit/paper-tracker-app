import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { runShell } from "./command.js";
import { resolvePath } from "./config.js";
import type { AppConfig, JsonRecord, Paper, PublishPayload } from "./types.js";

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const item = normalizeText(value);
    if (!item || seen.has(item)) {
      return;
    }
    seen.add(item);
    result.push(item);
  });
  return result;
}

function parseDate(value: unknown): string {
  const input = normalizeText(value);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function parseDateTime(value: unknown): Date | null {
  const input = normalizeText(value);
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function itemKey(paper: Paper): string {
  return normalizeText(paper.doi) || normalizeText(paper.url) || `${normalizeText(paper.journal?.name)}::${paper.title_en}`;
}

function restoreAbstract(index: Record<string, number[]> | undefined): string {
  if (!index || typeof index !== "object") {
    return "";
  }
  const map: Record<number, string> = {};
  Object.entries(index).forEach(([word, offsets]) => {
    offsets.forEach((offset) => {
      map[offset] = word;
    });
  });
  return Object.keys(map)
    .map((key) => Number(key))
    .sort((a, b) => a - b)
    .map((offset) => map[offset])
    .join(" ");
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

async function loadJournals(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const journalFile = resolvePath(config.sources?.journals_file || "journals.json");
  const raw = await fs.readFile(journalFile, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function loadTaxonomy(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const file = resolvePath(config.classification?.file || "classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw) as { domains?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.domains) ? parsed.domains : [];
}

function heuristicClassification(text: string, taxonomy: Array<Record<string, unknown>>): Paper["classification"] {
  const lowered = text.toLowerCase();
  for (const domain of taxonomy) {
    const domainName = normalizeText(domain.name) || "未分类";
    const subdomains = toArray(domain.subdomains as Array<Record<string, unknown>> | undefined);
    for (const subdomain of subdomains) {
      const keywords = dedupeStrings(toArray(subdomain.keywords as string[] | undefined).map((k) => normalizeText(k).toLowerCase()));
      if (keywords.some((kw) => kw && lowered.includes(kw))) {
        return {
          domain: domainName,
          subdomain: normalizeText(subdomain.name) || "未分类",
          tags: keywords.slice(0, 3)
        };
      }
    }
  }
  return { domain: "未分类", subdomain: "未分类", tags: [] };
}

function matchesKeywords(config: AppConfig, title: string, abstract: string, journal: string): boolean {
  const keywords = toArray(config.sources?.keywords).map((item) => normalizeText(item).toLowerCase());
  const blob = `${title} ${abstract} ${journal}`.toLowerCase();
  return keywords.some((keyword) => keyword && blob.includes(keyword));
}

function paperWindowStart(config: AppConfig): Date {
  const timezone = config.pipeline?.paper_window?.timezone || config.app?.timezone || "Asia/Shanghai";
  const mode = normalizeText(config.pipeline?.paper_window?.mode) || "since_yesterday_time";
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  if (mode === "since_yesterday_time") {
    const start = new Date(now);
    start.setDate(now.getDate() - 1);
    start.setHours(config.pipeline?.paper_window?.hour ?? 8, config.pipeline?.paper_window?.minute ?? 0, 0, 0);
    return start;
  }
  const start = new Date(now);
  start.setDate(start.getDate() - (config.pipeline?.default_days ?? 2));
  return start;
}

async function fetchJson(url: string, timeoutMs: number): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as JsonRecord;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function aiApiKey(config: AppConfig): string {
  const env = config.ai?.api_key_env || "SILICONFLOW_API_KEY";
  const key = process.env[env] || process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "";
  if (!key) {
    throw new Error(`Missing AI API key in env ${env}`);
  }
  return key;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value), template);
}

async function chatJson(config: AppConfig, payload: JsonRecord): Promise<JsonRecord> {
  const baseUrl = normalizeText(config.ai?.base_url);
  if (!baseUrl) {
    throw new Error("Missing ai.base_url");
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiApiKey(config)}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`AI request failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as JsonRecord;
  const choices = toArray(json.choices as JsonRecord[] | undefined);
  const content = normalizeText(((choices[0] as JsonRecord | undefined)?.message as JsonRecord | undefined)?.content);
  return JSON.parse(content || "{}") as JsonRecord;
}

async function llmFilter(config: AppConfig, taxonomy: Array<Record<string, unknown>>, candidate: Paper): Promise<JsonRecord> {
  if (!config.ai?.filter?.enabled) {
    return { used: false, keep: false, confidence: 0 };
  }
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify(candidate),
    keywords_json: JSON.stringify(config.sources?.keywords || [])
  };
  const systemPrompt =
    renderTemplate(
      normalizeText(prompts.filter_system) ||
        "你是环境、能源与气候方向的论文筛选器。请只输出 JSON：keep, confidence, reason, suggested_domain, suggested_tags。",
      values
    ) || "";
  const userPrompt = renderTemplate(normalizeText(prompts.filter_user_template) || values.paper_json, values);
  const parsed = await chatJson(config, {
    model: config.ai?.filter?.model || config.ai?.model,
    temperature: config.ai?.filter?.temperature ?? 0,
    max_tokens: config.ai?.filter?.max_tokens ?? 500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });
  const confidence = Number(parsed.confidence ?? 0);
  const min = Number(config.ai?.filter?.min_confidence ?? 0.5);
  const keep = Boolean(parsed.keep) && confidence >= min;
  return { ...parsed, used: true, keep, confidence };
}

function buildPaper(input: {
  title: string;
  authors: string[];
  journal: string;
  sourceGroup: string;
  publishedDate: string;
  doi: string;
  url: string;
  abstractOriginal: string;
  sourceProvider: string;
  rawFeed: string;
  rawRecordId: string;
  taxonomy: Array<Record<string, unknown>>;
}): Paper {
  const titleEn = normalizeText(input.title);
  const abs = normalizeText(input.abstractOriginal);
  const cls = heuristicClassification(`${titleEn} ${abs} ${input.journal}`, input.taxonomy);
  return {
    id: normalizeText(input.doi) || normalizeText(input.url) || `${normalizeText(input.journal)}::${titleEn}`,
    title_en: titleEn,
    title_zh: "",
    authors: dedupeStrings(input.authors),
    journal: {
      name: normalizeText(input.journal),
      source_group: normalizeText(input.sourceGroup || input.journal)
    },
    published_date: input.publishedDate,
    doi: normalizeText(input.doi),
    url: normalizeText(input.url),
    abstract_original: abs,
    abstract_zh: "",
    summary_zh: "",
    novelty_points: [],
    main_content: [],
    classification: cls,
    source: {
      provider: input.sourceProvider,
      raw_feed: input.rawFeed,
      raw_record_id: input.rawRecordId
    }
  };
}

async function collectNature(config: AppConfig, taxonomy: Array<Record<string, unknown>>): Promise<Paper[]> {
  const journals = await loadJournals(config);
  const feeds = journals.flatMap((j) => toArray(j.rss_feeds as string[] | undefined));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const start = paperWindowStart(config);
  const papers: Paper[] = [];
  for (const feedUrl of feeds) {
    try {
      const xml = await fetchText(feedUrl, config.runtime.command_timeout_ms);
      const parsed = parser.parse(xml) as JsonRecord;
      const channel = parsed.rss ? (parsed.rss as JsonRecord).channel : parsed.feed;
      const items = toArray(((channel as JsonRecord).item || (channel as JsonRecord).entry) as JsonRecord[] | undefined);
      for (const item of items) {
        const title = normalizeText(item.title);
        const summary = normalizeText(item.description || item.summary);
        const journal = normalizeText(item["prism:publicationName"] || item.source || "Nature");
        const publishedDate = parseDate(item.pubDate || item.published || item.updated);
        const publishedAt = parseDateTime(item.pubDate || item.published || item.updated);
        if (publishedAt && publishedAt < start) {
          continue;
        }
        if (!matchesKeywords(config, title, summary, journal)) {
          const filterResult = await llmFilter(config, taxonomy, {
            title_en: title,
            journal: { name: journal },
            published_date: publishedDate,
            doi: normalizeText(item["dc:identifier"]),
            url: normalizeText(item.link),
            abstract_original: summary
          });
          if (!Boolean(filterResult.keep)) {
            continue;
          }
        }
        papers.push(
          buildPaper({
            title,
            authors: toArray(item.author as string[] | undefined),
            journal,
            sourceGroup: "Nature",
            publishedDate,
            doi: normalizeText(item["dc:identifier"]),
            url: normalizeText(item.link),
            abstractOriginal: summary,
            sourceProvider: "nature-rss",
            rawFeed: feedUrl,
            rawRecordId: normalizeText(item.guid || item.link),
            taxonomy
          })
        );
      }
    } catch {
      continue;
    }
  }
  return papers;
}

async function collectOpenalex(config: AppConfig, taxonomy: Array<Record<string, unknown>>): Promise<Paper[]> {
  const journals = await loadJournals(config);
  const issns = dedupeStrings(journals.map((j) => normalizeText(j.issn)).filter(Boolean));
  const queries = toArray(config.sources?.openalex_queries).length
    ? (config.sources?.openalex_queries as string[])
    : ["energy", "climate"];
  const startDate = paperWindowStart(config).toISOString().slice(0, 10);
  const select =
    "id,title,doi,publication_date,authorships,primary_location,abstract_inverted_index";
  const papers: Paper[] = [];
  const baseFilters = [`from_publication_date:${startDate}`, "type:article"];
  if (issns.length > 0) {
    baseFilters.push(`primary_location.source.issn:${issns.join("|")}`);
  }
  for (const query of queries) {
    const url =
      "https://api.openalex.org/works?per-page=25&sort=publication_date:desc" +
      `&filter=${encodeURIComponent(baseFilters.join(","))}` +
      `&search=${encodeURIComponent(query)}` +
      `&select=${encodeURIComponent(select)}`;
    try {
      const payload = await fetchJson(url, config.runtime.command_timeout_ms);
      const results = toArray(payload.results as JsonRecord[] | undefined);
      for (const item of results) {
        const source = (item.primary_location as JsonRecord | undefined)?.source as JsonRecord | undefined;
        const journal = normalizeText(source?.display_name);
        const title = normalizeText(item.title);
        const abstract = normalizeText(restoreAbstract(item.abstract_inverted_index as Record<string, number[]> | undefined));
        const publishedDate = parseDate(item.publication_date);
        if (!matchesKeywords(config, title, abstract, journal)) {
          const filterResult = await llmFilter(config, taxonomy, {
            title_en: title,
            journal: { name: journal },
            published_date: publishedDate,
            doi: normalizeText(item.doi),
            url: normalizeText(item.doi || item.id),
            abstract_original: abstract
          });
          if (!Boolean(filterResult.keep)) {
            continue;
          }
        }
        const authorships = toArray(item.authorships as JsonRecord[] | undefined);
        papers.push(
          buildPaper({
            title,
            authors: authorships.map((a) => normalizeText(((a.author as JsonRecord | undefined)?.display_name) || "")),
            journal: journal || "Unknown Journal",
            sourceGroup: normalizeText(source?.host_organization_name || journal),
            publishedDate,
            doi: normalizeText(item.doi),
            url: normalizeText(item.doi || item.id),
            abstractOriginal: abstract,
            sourceProvider: "openalex",
            rawFeed: "https://api.openalex.org/works",
            rawRecordId: normalizeText(item.id),
            taxonomy
          })
        );
      }
    } catch {
      continue;
    }
  }
  return papers;
}

export async function fetchPapers(config: AppConfig): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const papers = [...(await collectNature(config, taxonomy)), ...(await collectOpenalex(config, taxonomy))];
  const seen = new Set<string>();
  const ordered = papers.sort((a, b) => `${b.published_date}`.localeCompare(`${a.published_date}`));
  return ordered.filter((paper) => {
    const key = itemKey(paper);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function enrichOne(config: AppConfig, paper: Paper, taxonomy: Array<Record<string, unknown>>): Promise<Paper> {
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify({
      title_en: paper.title_en,
      authors: paper.authors || [],
      journal: paper.journal || {},
      published_date: paper.published_date || "",
      doi: paper.doi || "",
      url: paper.url || "",
      abstract_original: paper.abstract_original || "",
      classification_candidate: paper.classification || {}
    })
  };
  const systemPrompt =
    renderTemplate(
      normalizeText(prompts.enrich_system) ||
        "你是环境、能源领域的科研情报编辑。请严格输出 JSON，字段为 title_zh, abstract_zh, summary_zh, novelty_points, main_content, classification。",
      values
    ) || "";
  const userPrompt = renderTemplate(normalizeText(prompts.enrich_user_template) || values.paper_json, values);
  const parsed = await chatJson(config, {
    model: config.ai?.model,
    temperature: config.ai?.temperature ?? 0.2,
    max_tokens: config.ai?.max_tokens ?? 2000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });
  return {
    ...paper,
    title_zh: normalizeText(parsed.title_zh) || paper.title_zh || "",
    abstract_zh: normalizeText(parsed.abstract_zh),
    summary_zh: normalizeText(parsed.summary_zh),
    novelty_points: dedupeStrings(toArray(parsed.novelty_points as string[] | undefined)).slice(0, 3),
    main_content: dedupeStrings(toArray(parsed.main_content as string[] | undefined)).slice(0, 3),
    classification: {
      domain: normalizeText((parsed.classification as JsonRecord | undefined)?.domain) || paper.classification?.domain || "未分类",
      subdomain:
        normalizeText((parsed.classification as JsonRecord | undefined)?.subdomain) || paper.classification?.subdomain || "未分类",
      tags: dedupeStrings(
        toArray((parsed.classification as JsonRecord | undefined)?.tags as string[] | undefined).concat(
          toArray(paper.classification?.tags)
        )
      )
    }
  };
}

export async function enrichPapers(config: AppConfig, papers: Paper[]): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const output: Paper[] = [];
  for (const paper of papers) {
    try {
      output.push(await enrichOne(config, paper, taxonomy));
    } catch (error) {
      output.push({ ...paper, enrich_error: String(error) });
    }
  }
  return output;
}

function shellEscape(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractUrl(text: string): string {
  const match = text.match(/https?:\/\/[^\s"]+/);
  return match ? match[0] : "";
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  Object.entries(vars).forEach(([key, value]) => {
    result = result.replaceAll(`{${key}}`, value);
  });
  return result;
}

async function runTemplate(config: AppConfig, template: string, vars: Record<string, string>): Promise<JsonRecord> {
  const command = fillTemplate(template, vars);
  const result = await runShell(command, config.runtime.command_timeout_ms);
  return {
    command,
    returncode: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function publishDigest(config: AppConfig, payload: PublishPayload): Promise<JsonRecord> {
  const feishu = config.feishu || {};
  const dataDir = resolvePath(feishu.data_dir || "data/feishu-publisher");
  await fs.mkdir(dataDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const safeTitle = payload.title.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60);
  const base = path.join(dataDir, `${stamp}-${safeTitle}`);
  const markdownFile = `${base}.md`;
  const recordsFile = `${base}.json`;
  const papersFile = `${base}-papers.json`;
  await fs.writeFile(markdownFile, payload.markdown, "utf-8");
  await fs.writeFile(recordsFile, `${JSON.stringify(payload.records, null, 2)}\n`, "utf-8");
  await fs.writeFile(papersFile, `${JSON.stringify(payload.papers, null, 2)}\n`, "utf-8");

  const prefix = feishu.doc_title_prefix || "[每日论文追踪]";
  const docTitle = `${prefix} ${payload.title}`;
  const vars: Record<string, string> = {
    title: shellEscape(docTitle),
    markdown_file: shellEscape(markdownFile),
    records_file: shellEscape(recordsFile),
    papers_file: shellEscape(papersFile),
    notify_chat_id: shellEscape(normalizeText(feishu.notify_chat_id)),
    notify_user_id: shellEscape(normalizeText(feishu.notify_user_id)),
    notify_text: shellEscape(""),
    doc_url: shellEscape("")
  };
  const result: JsonRecord = {
    saved_markdown: markdownFile,
    saved_records: recordsFile,
    saved_papers: papersFile,
    execution_mode: normalizeText(feishu.execution_mode) || "host"
  };

  if (Boolean(feishu.doc_enabled) && normalizeText(feishu.doc_publish_cmd)) {
    const docRes = await runTemplate(config, normalizeText(feishu.doc_publish_cmd), vars);
    result.doc_publish = docRes;
    const url = extractUrl(normalizeText(docRes.stdout));
    if (url) {
      result.doc_url = url;
      vars.doc_url = shellEscape(url);
    }
  }
  if (Boolean(feishu.base_enabled) && normalizeText(feishu.base_publish_cmd)) {
    result.base_publish = await runTemplate(config, normalizeText(feishu.base_publish_cmd), vars);
  }
  if (Boolean(feishu.notify_enabled) && normalizeText(feishu.notify_cmd)) {
    const textTpl =
      normalizeText(feishu.notify_message_template) || "论文日报已生成：{title}\n文档链接：{doc_url}";
    const notifyText = textTpl
      .replaceAll("{title}", docTitle)
      .replaceAll("{doc_url}", String(result.doc_url || ""))
      .replaceAll("{markdown_file}", markdownFile)
      .replaceAll("{records_file}", recordsFile)
      .replaceAll("{papers_file}", papersFile);
    vars.notify_text = shellEscape(notifyText);
    const userIds = toArray(feishu.notify_user_ids);
    if (userIds.length > 0) {
      result.notify_publish = [];
      for (const userId of userIds) {
        vars.notify_user_id = shellEscape(normalizeText(userId));
        (result.notify_publish as JsonRecord[]).push(
          await runTemplate(config, normalizeText(feishu.notify_cmd), vars)
        );
      }
    } else {
      result.notify_publish = await runTemplate(config, normalizeText(feishu.notify_cmd), vars);
    }
  }

  const latestPath = path.join(dataDir, "latest.json");
  await fs.writeFile(
    latestPath,
    `${JSON.stringify(
      {
        title: payload.title,
        doc_title: docTitle,
        markdown_file: markdownFile,
        records_file: recordsFile,
        papers_file: papersFile,
        created_at: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf-8"
  );
  result.latest_meta = latestPath;
  return result;
}
