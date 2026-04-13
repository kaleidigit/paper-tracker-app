/**
 * modules.ts
 *
 * 职责：
 *   - LLM 翻译 / 分类 / 筛选
 *   - 调用采集器（NatureParser / OpenAlexParser）
 *   - 论文元数据补全
 *   - 飞书发布
 *
 * 采集逻辑已拆分至 src/parsers/：
 *   - nature-parser.ts   ：Nature 系列 RSS + 页面 JSON-LD
 *   - openalex-parser.ts ：Science / PNAS / Joule / EES 等 OpenAlex API
 *   - article-parser.ts  ：通用文章页面解析器
 */

import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { runShell } from "./command.js";
import { resolvePath } from "./config.js";
import type { AppConfig, JsonRecord, Paper, PublishPayload } from "./types.js";
import { NatureParser } from "./parsers/nature-parser.js";
import { OpenAlexParser } from "./parsers/openalex-parser.js";
import {
  normalizeText, dedupeStrings, toArray, parseDateTime,
  itemKey, normalizePublicationType, shouldSkipLlmRescueByTitle
} from "./utils.js";

// ─── LLM 相关 ───────────────────────────────────────────────

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value), template);
}

function parseJsonLenient(text: string): JsonRecord {
  const raw = normalizeText(text);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as JsonRecord;
  } catch {
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlock?.[1]) {
      try { return JSON.parse(codeBlock[1]) as JsonRecord; } catch { /* continue */ }
    }
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj?.[0]) {
      try { return JSON.parse(obj[0]) as JsonRecord; } catch { /* ignore */ }
    }
  }
  return {};
}

async function postJsonWithTimeout(
  url: string,
  body: JsonRecord,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function aiApiKey(config: AppConfig): string {
  const env = config.ai?.api_key_env || "SILICONFLOW_API_KEY";
  const key = process.env[env] || process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "";
  if (!key) throw new Error(`Missing AI API key in env ${env}`);
  return key;
}

function translationApiKey(config: AppConfig): string {
  const env = config.ai?.translation?.api_key_env || config.ai?.api_key_env || "SILICONFLOW_API_KEY";
  const key = process.env[env] || process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "";
  if (!key) throw new Error(`Missing translation API key in env ${env}`);
  return key;
}

async function chatJson(config: AppConfig, payload: JsonRecord): Promise<JsonRecord> {
  const baseUrl = normalizeText(config.ai?.base_url);
  if (!baseUrl) throw new Error("Missing ai.base_url");
  const response = await postJsonWithTimeout(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    payload,
    { "Content-Type": "application/json", Authorization: `Bearer ${aiApiKey(config)}` },
    config.runtime.command_timeout_ms
  );
  if (!response.ok) {
    const body = normalizeText(await response.text());
    throw new Error(`AI request failed: HTTP ${response.status}; body=${body}`);
  }
  const json = (await response.json()) as JsonRecord;
  const choices = toArray(json.choices as JsonRecord[] | undefined);
  const content = normalizeText(((choices[0] as JsonRecord | undefined)?.message as JsonRecord | undefined)?.content);
  return parseJsonLenient(content);
}

export async function loadTaxonomy(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const file = resolvePath(config.classification?.file || "config/classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw) as { domains?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.domains) ? parsed.domains : [];
}

export async function llmFilter(config: AppConfig, taxonomy: Array<Record<string, unknown>>, candidate: Paper): Promise<JsonRecord> {
  if (!config.ai?.filter?.enabled) {
    return { used: false, keep: false, confidence: 0 };
  }
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.filter.start", title: candidate.title_en || "" })}\n`);
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify(candidate),
    keywords_json: JSON.stringify(config.sources?.keywords || []),
    title_en: candidate.title_en || "",
    journal_name: candidate.journal?.name || "",
    published_date: candidate.published_date || "",
    doi: candidate.doi || "",
    url: candidate.url || "",
    abstract_original: candidate.abstract_original || ""
  };
  const systemPrompt = renderTemplate(
    normalizeText(prompts.filter_system) || "你是环境、能源与气候方向的论文筛选器。请只输出 JSON：keep, confidence, reason, suggested_domain, suggested_tags。",
    values
  ) || "";
  const userPrompt = renderTemplate(normalizeText(prompts.filter_user_template) || values.paper_json, values);
  const parsed = await chatJson(config, {
    model: config.ai?.filter?.model || config.ai?.model,
    temperature: config.ai?.filter?.temperature ?? 0,
    max_tokens: config.ai?.filter?.max_tokens ?? 500,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
  });
  const confidence = Number(parsed.confidence ?? 0);
  const min = Number(config.ai?.filter?.min_confidence ?? 0.5);
  const keep = Boolean(parsed.keep) && confidence >= min;
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.filter.done", keep, confidence })}\n`);
  return { ...parsed, used: true, keep, confidence };
}

async function translatePaperFields(config: AppConfig, paper: Paper): Promise<Pick<Paper, "title_zh" | "abstract_zh">> {
  if (config.ai?.translation?.enabled === false) {
    return { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  }
  const baseUrl = normalizeText(config.ai?.base_url);
  const model = normalizeText(config.ai?.translation?.model || config.ai?.model);
  if (!baseUrl || !model) {
    return { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  }
  const prompts = config.ai?.prompts || {};
  const values = {
    paper_json: JSON.stringify({ title_en: paper.title_en || "", abstract_original: paper.abstract_original || "" }),
    title_en: paper.title_en || "",
    abstract_original: paper.abstract_original || ""
  };
  const translationSystem = renderTemplate(
    normalizeText(prompts.translation_system) || "你是学术翻译助手。请只输出 JSON，字段为 title_zh 和 abstract_zh。要求忠实、简洁、术语准确，不要添加额外解释。",
    values
  ) || "";
  const translationUser = renderTemplate(normalizeText(prompts.translation_user_template) || values.paper_json, values);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${translationApiKey(config)}` };
  const requestPayload = (withResponseFormat: boolean): JsonRecord => ({
    model,
    temperature: 0,
    max_tokens: 1200,
    ...(withResponseFormat ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: translationSystem }, { role: "user", content: translationUser }]
  });

  const readTranslated = async (withResponseFormat: boolean): Promise<Pick<Paper, "title_zh" | "abstract_zh">> => {
    const response = await postJsonWithTimeout(`${baseUrl.replace(/\/$/, "")}/chat/completions`, requestPayload(withResponseFormat), headers, config.runtime.command_timeout_ms);
    if (!response.ok) {
      const body = normalizeText(await response.text());
      throw new Error(`translation request failed: HTTP ${response.status}; body=${body}`);
    }
    const json = (await response.json()) as JsonRecord;
    const choices = toArray(json.choices as JsonRecord[] | undefined);
    const content = normalizeText(((choices[0] as JsonRecord | undefined)?.message as JsonRecord | undefined)?.content);
    const translated = parseJsonLenient(content);
    return { title_zh: normalizeText(translated.title_zh), abstract_zh: normalizeText(translated.abstract_zh) };
  };

  let translated = await readTranslated(true);
  if (!translated.title_zh || !translated.abstract_zh) {
    translated = await readTranslated(false);
  }
  return translated;
}

async function classifyPaper(config: AppConfig, paper: Paper, taxonomy: Array<Record<string, unknown>>): Promise<Paper["classification"]> {
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify({
      title_en: paper.title_en || "",
      title_zh: paper.title_zh || "",
      abstract_original: paper.abstract_original || "",
      abstract_zh: paper.abstract_zh || "",
      journal: paper.journal || {},
      published_date: paper.published_date || "",
      doi: paper.doi || "",
      url: paper.url || ""
    }),
    title_en: paper.title_en || "",
    title_zh: paper.title_zh || "",
    abstract_original: paper.abstract_original || "",
    abstract_zh: paper.abstract_zh || "",
    journal_name: paper.journal?.name || "",
    published_date: paper.published_date || "",
    doi: paper.doi || "",
    url: paper.url || ""
  };
  const systemPrompt = renderTemplate(
    normalizeText(prompts.classify_system) || "你是环境与能源论文分类助手。请只输出 JSON，字段为 classification(domain, subdomain, tags)。",
    values
  ) || "";
  const userPrompt = renderTemplate(normalizeText(prompts.classify_user_template) || values.paper_json, values);
  const parsed = await chatJson(config, {
    model: config.ai?.model,
    temperature: 0,
    max_tokens: Math.min(config.ai?.max_tokens ?? 2000, 800),
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
  });
  const cls = parsed.classification as JsonRecord | undefined;
  return {
    domain: normalizeText(cls?.domain) || "未分类",
    subdomain: normalizeText(cls?.subdomain) || "未分类",
    tags: dedupeStrings(toArray(cls?.tags as string[] | undefined))
  };
}

// ─── 元数据补全 ─────────────────────────────────────────────

async function enrichPaperMetadata(config: AppConfig, papers: Paper[]): Promise<Paper[]> {
  return papers; // 元数据已在采集器中补全，此处保留扩展接口
}

// ─── Enrich：翻译 + 分类 ─────────────────────────────────────

async function enrichOne(config: AppConfig, paper: Paper, taxonomy: Array<Record<string, unknown>>): Promise<Paper> {
  // 防御：若采集器漏过滤，在此补上
  if (shouldSkipLlmRescueByTitle(paper.title_en)) {
    return {
      ...paper,
      title_zh: "",
      abstract_zh: "",
      summary_zh: "",
      novelty_points: [],
      main_content: []
    };
  }
  if (config.ai?.enrich?.enabled === false) {
    return {
      ...paper,
      title_zh: normalizeText(paper.title_zh || paper.title_en || ""),
      abstract_zh: normalizeText(paper.abstract_zh || paper.abstract_original || ""),
      summary_zh: "",
      novelty_points: [],
      main_content: [],
      publication_type: normalizePublicationType(paper.publication_type),
      classification: paper.classification || { domain: "未分类", subdomain: "未分类", tags: [] }
    };
  }
  let translated: Pick<Paper, "title_zh" | "abstract_zh"> = { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  let translationError = "";
  try {
    translated = await translatePaperFields(config, paper);
    const missingTitle = Boolean(paper.title_en) && !translated.title_zh;
    const missingAbstract = Boolean(paper.abstract_original) && !translated.abstract_zh;
    if (missingTitle || missingAbstract) {
      throw new Error(`translation_partial_output:title=${missingTitle ? "missing" : "ok"},abstract=${missingAbstract ? "missing" : "ok"}`);
    }
  } catch (error) {
    translationError = String(error);
    if (config.ai?.translation?.required && !translated.title_zh && Boolean(paper.title_en)) {
      throw new Error(`translation_required_failed: ${translationError}`);
    }
  }
  const mergedPaper: Paper = { ...paper, title_zh: translated.title_zh || paper.title_zh || "", abstract_zh: translated.abstract_zh || paper.abstract_zh || "" };
  let classification = mergedPaper.classification || { domain: "未分类", subdomain: "未分类", tags: [] };
  try {
    classification = { ...(await classifyPaper(config, mergedPaper, taxonomy)) };
  } catch {
    // 回退到规则分类
  }
  return {
    ...mergedPaper,
    publication_type: normalizePublicationType(paper.publication_type),
    translation_error: translationError || undefined,
    summary_zh: "",
    novelty_points: [],
    main_content: [],
    classification
  };
}

export async function enrichPapers(config: AppConfig, papers: Paper[]): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  // p-limit 并发控制，默认 3 并发
  const concurrency = Math.max(1, config.ai?.enrich?.concurrency ?? 3);
  const limit = pLimit(concurrency);
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.enrich.concurrency", concurrency })}\n`);

  const output: Paper[] = [];
  for (let index = 0; index < papers.length; index += 1) {
    const paper = papers[index];
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.enrich.paper", index: index + 1, total: papers.length, title: paper.title_en || "" })}\n`);
    try {
      // 标题命中的 correction/retraction 等论文不消耗 LLM，直接清空翻译字段
      if (shouldSkipLlmRescueByTitle(paper.title_en)) {
        output.push({
          ...paper,
          title_zh: "",
          abstract_zh: "",
          summary_zh: "",
          novelty_points: [],
          main_content: []
        });
        continue;
      }
      output.push(await limit(() => enrichOne(config, paper, taxonomy)));
    } catch (error) {
      output.push({ ...paper, enrich_error: String(error) });
    }
  }
  return output;
}

// ─── 采集入口 ───────────────────────────────────────────────

export async function fetchPapers(config: AppConfig): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const filterBudget = { remaining: Math.max(0, Number(config.ai?.filter?.max_checks_per_run ?? 20)) };
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.filter.budget", remaining: filterBudget.remaining })}\n`);

  // 并行运行 Nature + OpenAlex 采集器
  const [naturePapers, openalexPapers] = await Promise.all([
    new NatureParser().collect(config, taxonomy, filterBudget),
    new OpenAlexParser().collect(config, taxonomy, filterBudget)
  ]);

  const allPapers = [...naturePapers, ...openalexPapers];

  // 保存原始采集数据（用于调试和分析）
  await saveRawCollectedPapers(config, allPapers);

  // ✅ 先去重后排（避免对重复论文排序）
  const seen = new Set<string>();
  const deduped = allPapers.filter((p) => {
    const key = itemKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ordered = deduped.sort((a, b) => `${b.published_date}`.localeCompare(`${a.published_date}`));

  return enrichPaperMetadata(config, ordered);
}

async function saveRawCollectedPapers(config: AppConfig, papers: Paper[]): Promise<void> {
  const feishu = config.feishu || {};
  const dataDir = resolvePath(feishu.data_dir || "data/feishu-publisher");
  const timezone = config.app?.timezone || "Asia/Shanghai";
  const dayDir = path.join(dataDir, new Date(new Date().toLocaleString("en-US", { timeZone: timezone })).toISOString().slice(0, 10));
  await fs.mkdir(dayDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const rawFile = path.join(dayDir, `${stamp}-raw-collected.json`);
  await fs.writeFile(rawFile, `${JSON.stringify(papers, null, 2)}\n`, "utf-8");
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.raw_saved", file: rawFile, count: papers.length })}\n`);
}

// ─── 飞书发布 ───────────────────────────────────────────────

function shellEscape(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractUrl(text: string): string {
  const match = text.match(/https?:\/\/[^\s"]+/);
  return match ? match[0] : "";
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  Object.entries(vars).forEach(([key, value]) => { result = result.replaceAll(`{${key}}`, value); });
  return result;
}

async function runTemplate(config: AppConfig, template: string, vars: Record<string, string>): Promise<JsonRecord> {
  const command = fillTemplate(template, vars);
  const result = await runShell(command, config.runtime.command_timeout_ms);
  return { command, returncode: result.code, stdout: result.stdout, stderr: result.stderr };
}

function buildDigestTitle(config: AppConfig): string {
  const timezone = config.app?.timezone || "Asia/Shanghai";
  const dateText = new Date(new Date().toLocaleString("en-US", { timeZone: timezone })).toISOString().slice(0, 10);
  return (config.pipeline?.digest_title_template || "{date} 顶刊论文日报").replace("{date}", dateText);
}

export function buildMarkdown(title: string, papers: Paper[]): string {
  const normalizeBlock = (value?: string): string => (value || "").trim().replace(/\n{3,}/g, "\n\n");
  const lines: string[] = [`# ${title}`, "", `共收录 **${papers.length}** 篇。`, ""];

  papers.forEach((paper, index) => {
    const cls = paper.classification || {};
    const paperTitle = paper.title_zh || paper.title_en || `论文 ${index + 1}`;
    const englishTitle = (paper.title_en || "").trim();
    const metaLines: string[] = [];
    const resourceLines: string[] = [];
    const pushMeta = (target: string[], label: string, value?: string): void => {
      const text = (value || "").trim();
      if (text) {
        target.push(`- **${label}**：${text}`);
      }
    };
    const pushSection = (label: string, value?: string, quote = false): void => {
      const text = normalizeBlock(value);
      if (text) {
        lines.push(`**${label}**  `);
        lines.push(quote ? text.split("\n").map((line) => `> ${line}`).join("\n") : text);
        lines.push("");
      }
    };

    if (index > 0) {
      lines.push("---", "");
    }

    lines.push(`## ${index + 1}. ${paperTitle}`);
    lines.push("");

    if (englishTitle && englishTitle !== paperTitle) {
      lines.push(`*${englishTitle}*`);
      lines.push("");
    }

    pushMeta(metaLines, "作者", (paper.authors || []).join(", "));
    pushMeta(metaLines, "作者单位", (paper.author_affiliations || []).join("；"));
    pushMeta(metaLines, "期刊", paper.journal?.name || "");
    pushMeta(metaLines, "日期", paper.published_date || "");
    pushMeta(metaLines, "类型", paper.publication_type || "unknown");
    pushMeta(metaLines, "一级领域", cls.domain || "");
    pushMeta(metaLines, "二级领域", cls.subdomain || "");
    pushMeta(metaLines, "标签", (cls.tags || []).join("，"));
    if (metaLines.length > 0) {
      lines.push(...metaLines, "");
    }

    pushSection("中文摘要", paper.abstract_zh || "");
    pushSection("摘要总结", paper.summary_zh || "", true);

    pushMeta(resourceLines, "DOI", paper.doi || "");
    pushMeta(resourceLines, "链接", paper.url || "");
    if (resourceLines.length > 0) {
      lines.push("**资源信息**  ");
      lines.push(...resourceLines, "");
    }

    if (paper.image_url) {
      lines.push("**主图**  ");
      lines.push(`![](${paper.image_url})`);
      lines.push("");
    }
  });

  return lines.join("\n");
}

export function buildRecords(papers: Paper[]): JsonRecord[] {
  return papers.map((paper) => ({
    title_en: paper.title_en || "",
    title_zh: paper.title_zh || "",
    authors: (paper.authors || []).join(", "),
    author_affiliations: (paper.author_affiliations || []).join("; "),
    journal: paper.journal?.name || "",
    source_group: paper.journal?.source_group || "",
    published_date: paper.published_date || "",
    publication_type: paper.publication_type || "",
    domain: paper.classification?.domain || "",
    subdomain: paper.classification?.subdomain || "",
    tags: (paper.classification?.tags || []).join(", "),
    abstract_zh: paper.abstract_zh || "",
    summary_zh: paper.summary_zh || "",
    novelty_points: (paper.novelty_points || []).join("\n"),
    main_content: (paper.main_content || []).join("\n"),
    doi: paper.doi || "",
    url: paper.url || "",
    image_url: paper.image_url || ""
  }));
}

export class EmptyPapersError extends Error {
  constructor(message = "未获取到任何论文数据") {
    super(message);
    this.name = "EmptyPapersError";
  }
}

async function withRetry<T>(maxAttempts: number, backoffMs: number, job: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await job();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

export async function runWorkflow(config: AppConfig): Promise<{ payload: PublishPayload; publishResult: JsonRecord }> {
  const attempts = Math.max(1, config.runtime.retry.max_attempts);
  const backoff = Math.max(0, config.runtime.retry.backoff_ms);
  const title = buildDigestTitle(config);

  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.start" })}\n`);
  const papers = await withRetry(attempts, backoff, () => fetchPapers(config));
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.done", papers: papers.length })}\n`);
  if (papers.length === 0) throw new EmptyPapersError();

  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.enrich.start", papers: papers.length })}\n`);
  const enriched = await withRetry(attempts, backoff, () => enrichPapers(config, papers));
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.enrich.done", papers: enriched.length })}\n`);

  const payload: PublishPayload = { title, markdown: buildMarkdown(title, enriched), records: buildRecords(enriched), papers: enriched };
  const dryRun = process.env.PUSH_DRY_RUN === "1";
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.publish.start", papers: enriched.length, dry_run: dryRun })}\n`);
  const publishResult = await withRetry(attempts, backoff, () => publishDigest(config, payload));
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.publish.done", dry_run: dryRun })}\n`);
  return { payload, publishResult };
}

export async function sendEmptyPapersAlert(config: AppConfig): Promise<void> {
  await sendAlert(config, "未获取到任何论文数据，已终止日报推送，请排查抓取源、时间窗口与过滤配置。");
}

export async function publishDigest(config: AppConfig, payload: PublishPayload): Promise<JsonRecord> {
  const feishu = config.feishu || {};
  const dataDir = resolvePath(feishu.data_dir || "data/feishu-publisher");
  const timezone = config.app?.timezone || "Asia/Shanghai";
  const dayDir = path.join(dataDir, new Date(new Date().toLocaleString("en-US", { timeZone: timezone })).toISOString().slice(0, 10));
  await fs.mkdir(dayDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const safeTitle = payload.title.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60);
  const base = path.join(dayDir, `${stamp}-${safeTitle}`);
  const markdownFile = `${base}.md`;
  const recordsFile = `${base}.json`;
  const papersFile = `${base}-papers.json`;
  await fs.writeFile(markdownFile, payload.markdown, "utf-8");
  await fs.writeFile(recordsFile, `${JSON.stringify(payload.records, null, 2)}\n`, "utf-8");
  await fs.writeFile(papersFile, `${JSON.stringify(payload.papers, null, 2)}\n`, "utf-8");

  const latestPath = path.join(dataDir, "latest.json");
  await fs.writeFile(latestPath, `${JSON.stringify({ title: payload.title, markdown_file: markdownFile, records_file: recordsFile, papers_file: papersFile, created_at: new Date().toISOString(), dry_run: process.env.PUSH_DRY_RUN === "1" }, null, 2)}\n`, "utf-8");

  // ── Dry-run 模式：跳过飞书发布 ──────────────────────────
  const dryRun = process.env.PUSH_DRY_RUN === "1";
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.publish.dry_run", saved_markdown: markdownFile, saved_records: recordsFile, saved_papers: papersFile })}\n`);
    return { saved_markdown: markdownFile, saved_records: recordsFile, saved_papers: papersFile, execution_mode: "dry-run", dry_run: true };
  }
  // ── 正式发布 ─────────────────────────────────────────

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
  const result: JsonRecord = { saved_markdown: markdownFile, saved_records: recordsFile, saved_papers: papersFile, execution_mode: normalizeText(feishu.execution_mode) || "host", dry_run: false };

  if (Boolean(feishu.doc_enabled) && normalizeText(feishu.doc_publish_cmd)) {
    const docRes = await runTemplate(config, normalizeText(feishu.doc_publish_cmd), vars);
    result.doc_publish = docRes;
    const url = extractUrl(normalizeText(docRes.stdout));
    if (url) { result.doc_url = url; vars.doc_url = shellEscape(url); }
  }
  if (Boolean(feishu.base_enabled) && normalizeText(feishu.base_publish_cmd)) {
    result.base_publish = await runTemplate(config, normalizeText(feishu.base_publish_cmd), vars);
  }
  if (Boolean(feishu.notify_enabled) && normalizeText(feishu.notify_cmd)) {
    const textTpl = normalizeText(feishu.notify_message_template) || "论文日报已生成：{title}\n文档链接：{doc_url}";
    const notifyText = textTpl.replaceAll("{title}", docTitle).replaceAll("{doc_url}", String(result.doc_url || "")).replaceAll("{markdown_file}", markdownFile).replaceAll("{records_file}", recordsFile).replaceAll("{papers_file}", papersFile);
    vars.notify_text = shellEscape(notifyText);
    const userIds = toArray(feishu.notify_user_ids);
    if (userIds.length > 0) {
      result.notify_publish = [];
      for (const userId of userIds) {
        vars.notify_user_id = shellEscape(normalizeText(userId));
        (result.notify_publish as JsonRecord[]).push(await runTemplate(config, normalizeText(feishu.notify_cmd), vars));
      }
    } else {
      result.notify_publish = await runTemplate(config, normalizeText(feishu.notify_cmd), vars);
    }
  }

  result.latest_meta = latestPath;
  return result;
}

export async function sendAlert(config: AppConfig, message: string): Promise<void> {
  const feishu = config.feishu || {};
  if (!Boolean(feishu.alert_enabled)) return;
  const alertTemplate = normalizeText(feishu.alert_message_template) || "未获取到任何论文数据";
  const text = alertTemplate.replace("{message}", message);
  const chatId = normalizeText(feishu.alert_chat_id || feishu.notify_chat_id);
  const cmdTemplate = normalizeText(feishu.alert_cmd || feishu.notify_cmd);
  if (!cmdTemplate || !chatId) return;
  const vars: Record<string, string> = {
    notify_chat_id: shellEscape(chatId),
    notify_user_id: shellEscape(normalizeText(feishu.alert_user_id || "")),
    notify_text: shellEscape(text),
    doc_url: shellEscape("")
  };
  await runTemplate(config, cmdTemplate, vars);
}
