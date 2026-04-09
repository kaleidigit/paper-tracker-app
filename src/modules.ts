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

function asStringList(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => asStringList(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      ...asStringList(record.name),
      ...asStringList(record["#text"]),
      ...asStringList(record.content),
      ...asStringList(record.url),
      ...asStringList(record.href),
      ...asStringList(record.src)
    ];
  }
  return [normalizeText(value)];
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

function formatDateInTz(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
}

function absoluteUrl(raw: string, base?: string): string {
  const url = normalizeText(raw);
  if (!url) {
    return "";
  }
  try {
    if (base) {
      return new URL(url, base).toString();
    }
    return new URL(url).toString();
  } catch {
    return url;
  }
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

function extractImageFromRssItem(item: JsonRecord): string {
  const candidates: unknown[] = [
    item["media:content"],
    item["media:thumbnail"],
    item.enclosure,
    item.image,
    item["itunes:image"],
    item["content:encoded"]
  ];
  for (const candidate of candidates) {
    const urls = dedupeStrings(asStringList(candidate));
    const match = urls.find((u) => /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(u) || /^https?:\/\//i.test(u));
    if (match) {
      return absoluteUrl(match, normalizeText(item.link));
    }
  }
  return "";
}

function extractAffiliationsFromRssItem(item: JsonRecord): string[] {
  const candidates: unknown[] = [
    item["prism:affiliation"],
    item.affiliation,
    item["dc:publisher"],
    item["dc:source"],
    item["author:affiliation"]
  ];
  return dedupeStrings(candidates.flatMap((candidate) => asStringList(candidate))).filter(Boolean);
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

async function loadJournals(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const journalFile = resolvePath(config.sources?.journals_file || "config/journals.json");
  const raw = await fs.readFile(journalFile, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function loadTaxonomy(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const file = resolvePath(config.classification?.file || "config/classification.json");
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

function strictWindowStartAt(config: AppConfig): Date {
  const timezone = config.pipeline?.paper_window?.timezone || config.app?.timezone || "Asia/Shanghai";
  const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const yesterday = new Date(nowInTz);
  yesterday.setDate(nowInTz.getDate() - 1);
  yesterday.setHours(8, 0, 0, 0);
  return yesterday;
}

async function fetchJson(url: string, timeoutMs: number): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "paper-tracker/1.0 (+https://local)" }
    });
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
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "paper-tracker/1.0 (+https://local)" }
    });
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

function translationApiKey(config: AppConfig): string {
  const env = config.ai?.translation?.api_key_env || config.ai?.api_key_env || "SILICONFLOW_API_KEY";
  const key = process.env[env] || process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "";
  if (!key) {
    throw new Error(`Missing translation API key in env ${env}`);
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
    const body = normalizeText(await response.text());
    throw new Error(`AI request failed: HTTP ${response.status}; body=${body}`);
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

function normalizePublicationType(value: unknown): string {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return "unknown";
  }
  if (text.includes("review")) {
    return "review";
  }
  if (text.includes("editorial")) {
    return "editorial";
  }
  if (text.includes("letter")) {
    return "letter";
  }
  if (text.includes("comment")) {
    return "comment";
  }
  if (text.includes("article")) {
    return "article";
  }
  return text;
}

function buildPaper(input: {
  title: string;
  authors: string[];
  authorAffiliations?: string[];
  journal: string;
  sourceGroup: string;
  publishedDate: string;
  doi: string;
  url: string;
  abstractOriginal: string;
  imageUrl?: string;
  publicationType: string;
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
    author_affiliations: dedupeStrings(input.authorAffiliations || []),
    journal: {
      name: normalizeText(input.journal),
      source_group: normalizeText(input.sourceGroup || input.journal)
    },
    published_date: input.publishedDate,
    doi: normalizeText(input.doi),
    url: normalizeText(input.url),
    image_url: normalizeText(input.imageUrl),
    abstract_original: abs,
    abstract_zh: "",
    publication_type: normalizePublicationType(input.publicationType),
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

function resolveFeedItems(parsed: JsonRecord): JsonRecord[] {
  const rdf = parsed["rdf:RDF"] as JsonRecord | undefined;
  if (rdf) {
    return toArray(rdf.item as JsonRecord[] | undefined);
  }
  const rss = parsed.rss as JsonRecord | undefined;
  if (rss) {
    return toArray(((rss.channel as JsonRecord | undefined)?.item) as JsonRecord[] | undefined);
  }
  const atom = parsed.feed as JsonRecord | undefined;
  if (atom) {
    return toArray(atom.entry as JsonRecord[] | undefined);
  }
  return [];
}

async function collectNature(config: AppConfig, taxonomy: Array<Record<string, unknown>>): Promise<Paper[]> {
  const journals = await loadJournals(config);
  const feeds = journals.flatMap((j) => toArray(j.rss_feeds as string[] | undefined));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const start = strictWindowStartAt(config);
  const papers: Paper[] = [];
  for (const feedUrl of feeds) {
    try {
      const xml = await fetchText(feedUrl, config.runtime.command_timeout_ms);
      const parsed = parser.parse(xml) as JsonRecord;
      const items = resolveFeedItems(parsed);
      const parsedItems = items.map((item) => {
        const publishedAt = parseDateTime(item.pubDate || item.published || item.updated || item["dc:date"]);
        return { item, publishedAt };
      });
      for (const entry of parsedItems) {
        const item = entry.item;
        const title = normalizeText(item.title);
        const summary = normalizeText(item.description || item.summary);
        const journal = normalizeText(item["prism:publicationName"] || item.source || "Nature");
        const publishedDate = parseDate(item.pubDate || item.published || item.updated || item["dc:date"]);
        const publishedAt = entry.publishedAt;
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
            authorAffiliations: extractAffiliationsFromRssItem(item),
            journal,
            sourceGroup: "Nature",
            publishedDate,
            doi: normalizeText(item["dc:identifier"]),
            url: normalizeText(item.link),
            abstractOriginal: summary,
            imageUrl: extractImageFromRssItem(item),
            publicationType: normalizeText(
              item["dc:type"] || item["prism:publicationType"] || item["prism:section"] || item.category
            ),
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
  const windowStart = strictWindowStartAt(config);
  const startDate = formatDateInTz(windowStart, "UTC");
  const select =
    "id,title,doi,publication_date,type,authorships,primary_location,abstract_inverted_index";
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
        const authorAffiliations = dedupeStrings(
          authorships.flatMap((a) =>
            toArray((a.institutions as JsonRecord[] | undefined)?.map((inst) => normalizeText(inst.display_name))).filter(Boolean)
          )
        );
        papers.push(
          buildPaper({
            title,
            authors: authorships.map((a) => normalizeText(((a.author as JsonRecord | undefined)?.display_name) || "")),
            authorAffiliations,
            journal: journal || "Unknown Journal",
            sourceGroup: normalizeText(source?.host_organization_name || journal),
            publishedDate,
            doi: normalizeText(item.doi),
            url: normalizeText(item.doi || item.id),
            abstractOriginal: abstract,
            publicationType: normalizeText(item.type),
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

async function resolvePublicationTypeByDoi(doi: string, timeoutMs: number): Promise<string> {
  const normalized = normalizeText(doi)
    .replace(/^doi:/i, "")
    .trim();
  if (!normalized) {
    return "unknown";
  }
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalized)}`;
  try {
    const payload = await fetchJson(url, timeoutMs);
    return normalizePublicationType(payload.type);
  } catch {
    return "unknown";
  }
}

function extractPublicationTypeFromHtml(html: string): string {
  const patterns = [
    /citation_article_type[^>]*content=["']([^"']+)["']/i,
    /name=["']dc\.type["'][^>]*content=["']([^"']+)["']/i,
    /property=["']article:type["'][^>]*content=["']([^"']+)["']/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return normalizePublicationType(match[1]);
    }
  }
  return "unknown";
}

function extractImageFromHtml(html: string, pageUrl: string): string {
  const patterns = [
    /property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /name=["']citation_cover_image["'][^>]*content=["']([^"']+)["']/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return absoluteUrl(match[1], pageUrl);
    }
  }
  return "";
}

function extractAffiliationsFromHtml(html: string): string[] {
  const matches = html.matchAll(/name=["']citation_author_institution["'][^>]*content=["']([^"']+)["']/gi);
  const affiliations = Array.from(matches).map((m) => normalizeText(m[1]));
  return dedupeStrings(affiliations).filter(Boolean);
}

async function resolveMetadataByUrl(
  url: string,
  timeoutMs: number
): Promise<{ publicationType: string; imageUrl: string; authorAffiliations: string[] }> {
  const articleUrl = normalizeText(url);
  if (!articleUrl) {
    return { publicationType: "unknown", imageUrl: "", authorAffiliations: [] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(articleUrl, {
      signal: controller.signal,
      headers: { "user-agent": "paper-tracker/1.0 (+https://local)" }
    });
    if (!response.ok) {
      return { publicationType: "unknown", imageUrl: "", authorAffiliations: [] };
    }
    const html = await response.text();
    return {
      publicationType: extractPublicationTypeFromHtml(html),
      imageUrl: extractImageFromHtml(html, articleUrl),
      authorAffiliations: extractAffiliationsFromHtml(html)
    };
  } catch {
    return { publicationType: "unknown", imageUrl: "", authorAffiliations: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function enrichPaperMetadata(config: AppConfig, papers: Paper[]): Promise<Paper[]> {
  const doiCache = new Map<string, string>();
  const urlCache = new Map<string, { publicationType: string; imageUrl: string; authorAffiliations: string[] }>();
  const result: Paper[] = [];
  for (const paper of papers) {
    const current = normalizePublicationType(paper.publication_type);
    const hasImage = Boolean(normalizeText(paper.image_url));
    const hasAffiliations = (paper.author_affiliations || []).length > 0;

    let resolvedType = current;
    let resolvedImage = normalizeText(paper.image_url);
    let resolvedAffiliations = dedupeStrings(paper.author_affiliations || []);

    if (resolvedType === "unknown") {
      const rawDoi = normalizeText(paper.doi);
      if (rawDoi) {
        const cacheKey = rawDoi.toLowerCase();
        if (!doiCache.has(cacheKey)) {
          const fromDoi = await resolvePublicationTypeByDoi(rawDoi, config.runtime.command_timeout_ms);
          doiCache.set(cacheKey, fromDoi);
        }
        resolvedType = doiCache.get(cacheKey) || "unknown";
      }
    }

    if (resolvedType === "unknown" || !hasImage || !hasAffiliations) {
      const rawUrl = normalizeText(paper.url);
      if (rawUrl) {
        const urlKey = rawUrl.toLowerCase();
        if (!urlCache.has(urlKey)) {
          const meta = await resolveMetadataByUrl(rawUrl, config.runtime.command_timeout_ms);
          urlCache.set(urlKey, meta);
        }
        const meta = urlCache.get(urlKey);
        if (meta) {
          if (resolvedType === "unknown") {
            resolvedType = meta.publicationType;
          }
          if (!resolvedImage) {
            resolvedImage = meta.imageUrl;
          }
          if (resolvedAffiliations.length === 0 && meta.authorAffiliations.length > 0) {
            resolvedAffiliations = meta.authorAffiliations;
          }
        }
      }
    }
    result.push({
      ...paper,
      publication_type: normalizePublicationType(resolvedType),
      image_url: resolvedImage,
      author_affiliations: resolvedAffiliations
    });
  }
  return result;
}

export async function fetchPapers(config: AppConfig): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const nature = await collectNature(config, taxonomy);
  const openalex = await collectOpenalex(config, taxonomy);
  const papers = [...nature, ...openalex];
  const seen = new Set<string>();
  const ordered = papers.sort((a, b) => `${b.published_date}`.localeCompare(`${a.published_date}`));
  const deduped = ordered.filter((paper) => {
    const key = itemKey(paper);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return enrichPaperMetadata(config, deduped);
}

async function translatePaperFields(config: AppConfig, paper: Paper): Promise<Pick<Paper, "title_zh" | "abstract_zh">> {
  if (!config.ai?.translation?.enabled) {
    return { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  }
  const baseUrl = normalizeText(config.ai?.base_url);
  const model = normalizeText(config.ai?.translation?.model || config.ai?.model);
  if (!baseUrl || !model) {
    return { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${translationApiKey(config)}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是学术翻译助手。请只输出 JSON，字段为 title_zh 和 abstract_zh。要求忠实、简洁、术语准确。"
        },
        {
          role: "user",
          content: JSON.stringify({
            title_en: paper.title_en || "",
            abstract_original: paper.abstract_original || ""
          })
        }
      ]
    })
  });
  if (!response.ok) {
    const body = normalizeText(await response.text());
    throw new Error(`translation request failed: HTTP ${response.status}; body=${body}`);
  }
  const json = (await response.json()) as JsonRecord;
  const choices = toArray(json.choices as JsonRecord[] | undefined);
  const content = normalizeText(((choices[0] as JsonRecord | undefined)?.message as JsonRecord | undefined)?.content);
  const translated = JSON.parse(content || "{}") as JsonRecord;
  return {
    title_zh: normalizeText(translated.title_zh),
    abstract_zh: normalizeText(translated.abstract_zh)
  };
}

async function enrichOne(config: AppConfig, paper: Paper, taxonomy: Array<Record<string, unknown>>): Promise<Paper> {
  let translated: Pick<Paper, "title_zh" | "abstract_zh"> = {
    title_zh: paper.title_zh || "",
    abstract_zh: paper.abstract_zh || ""
  };
  let translationError = "";
  try {
    translated = await translatePaperFields(config, paper);
  } catch (error) {
    translationError = String(error);
    if (config.ai?.translation?.required) {
      throw new Error(`translation_required_failed: ${translationError}`);
    }
  }
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify({
      title_en: paper.title_en,
      title_zh: translated.title_zh,
      authors: paper.authors || [],
      journal: paper.journal || {},
      published_date: paper.published_date || "",
      doi: paper.doi || "",
      url: paper.url || "",
      abstract_original: paper.abstract_original || "",
      abstract_zh: translated.abstract_zh,
      publication_type: paper.publication_type || "unknown",
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
    title_zh: normalizeText(parsed.title_zh) || translated.title_zh || paper.title_zh || "",
    abstract_zh: normalizeText(parsed.abstract_zh) || translated.abstract_zh || "",
    publication_type: normalizePublicationType(paper.publication_type),
    translation_error: translationError || undefined,
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
  const timezone = config.app?.timezone || "Asia/Shanghai";
  const dayDir = path.join(dataDir, formatDateInTz(new Date(), timezone));
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

export async function sendAlert(config: AppConfig, message: string): Promise<void> {
  const feishu = config.feishu || {};
  if (!Boolean(feishu.alert_enabled)) {
    return;
  }
  const alertTemplate = normalizeText(feishu.alert_message_template) || "未获取到任何论文数据";
  const alertText = `${alertTemplate}\n${message}`;
  const vars: Record<string, string> = {
    notify_text: shellEscape(alertText),
    notify_chat_id: shellEscape(normalizeText(feishu.alert_chat_id || feishu.notify_chat_id)),
    notify_user_id: shellEscape(normalizeText(feishu.alert_user_id || feishu.notify_user_id)),
    title: shellEscape(""),
    markdown_file: shellEscape(""),
    records_file: shellEscape(""),
    papers_file: shellEscape(""),
    doc_url: shellEscape("")
  };
  const command = normalizeText(feishu.alert_cmd || feishu.notify_cmd);
  if (!command) {
    return;
  }
  await runTemplate(config, command, vars);
}
