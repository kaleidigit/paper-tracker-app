/**
 * nature-parser.ts
 * Nature 系列期刊采集器
 * 数据来源：Nature RSS feed + 文章页面 JSON-LD/HTML
 */

import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import type { AppConfig, JsonRecord, Paper } from "../types.js";
import {
  normalizeText, dedupeStrings, toArray, resolvePath,
  fetchText, parseDate, parseDateTime, strictWindowStartAt,
  matchesKeywords, shouldSkipLlmRescueByTitle, extractImageFromRssItem,
  extractAffiliationsFromRssItem, normalizePublicationType, heuristicClassification
} from "../utils.js";
import { ArticlePageParser } from "./article-parser.js";
import type { FilterBudget, JournalEntry, ParsedPaper } from "./types.js";

async function loadJournals(config: AppConfig): Promise<JournalEntry[]> {
  const file = resolvePath(config.sources?.journals_file || "config/journals.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function resolveFeedItems(parsed: JsonRecord): JsonRecord[] {
  const rdf = parsed["rdf:RDF"] as JsonRecord | undefined;
  if (rdf) return toArray(rdf.item as JsonRecord[] | undefined);
  const rss = parsed.rss as JsonRecord | undefined;
  if (rss) return toArray((rss.channel as JsonRecord | undefined)?.item as JsonRecord[] | undefined);
  const atom = parsed.feed as JsonRecord | undefined;
  if (atom) return toArray(atom.entry as JsonRecord[] | undefined);
  return [];
}

async function loadTaxonomyFromModules(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const { loadTaxonomy } = await import("../modules.js");
  return loadTaxonomy(config);
}

async function llmFilterFromModules(config: AppConfig, taxonomy: Array<Record<string, unknown>>, candidate: Paper): Promise<JsonRecord> {
  const { llmFilter } = await import("../modules.js");
  return llmFilter(config, taxonomy, candidate);
}

function buildPaper(input: ParsedPaper): Paper {
  const titleEn = normalizeText(input.title);
  const abs = normalizeText(input.abstractOriginal);
  const cls = heuristicClassification(`${titleEn} ${abs} ${input.journal}`, input.taxonomy);

  return {
    id: normalizeText(input.doi) || normalizeText(input.url) || `${normalizeText(input.journal)}::${titleEn}`,
    title_en: titleEn,
    title_zh: "",
    authors: dedupeStrings(input.authors),
    author_affiliations: dedupeStrings(input.authorAffiliations),
    journal: { name: normalizeText(input.journal), source_group: normalizeText(input.sourceGroup || input.journal) },
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
    source: { provider: input.sourceProvider, raw_feed: input.rawFeed, raw_record_id: input.rawRecordId }
  };
}

export class NatureParser {
  async collect(config: AppConfig, taxonomy: Array<Record<string, unknown>>, filterBudget: FilterBudget): Promise<Paper[]> {
    const journals = await loadJournals(config);
    const feeds = journals
      .filter((j) => normalizeText(j.publisher_strategy) === "nature-rss")
      .flatMap((j) => toArray(j.rss_feeds as string[] | undefined));

    if (feeds.length === 0) return [];

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const start = strictWindowStartAt(config);
    const papers: Paper[] = [];
    const timeoutMs = 30000;
    const articleParser = new ArticlePageParser(timeoutMs);
    const authorInfoCache = new Map<string, ReturnType<ArticlePageParser["parse"]>>();

    for (const feedUrl of feeds) {
      process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.rss.start", feed: feedUrl })}\n`);
      let xml = "";
      try {
        xml = await fetchText(feedUrl, timeoutMs);
      } catch {
        process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.fetch.rss.failed", feed: feedUrl })}\n`);
        continue;
      }

      let items: JsonRecord[] = [];
      try {
        const parsed = parser.parse(xml) as JsonRecord;
        items = resolveFeedItems(parsed);
      } catch {
        continue;
      }

      for (const item of items) {
        const publishedAt = parseDateTime(item.pubDate || item.published || item.updated || item["dc:date"]);
        if (publishedAt && publishedAt < start) continue;

        const title = normalizeText(item.title);
        const rssAbstract = normalizeText(item.description || item.summary || "");
        const journal = normalizeText(item["prism:publicationName"] || item.source || "Nature");
        const publishedDate = parseDate(item.pubDate || item.published || item.updated || item["dc:date"]);
        const paperUrl = normalizeText(item.link);

        // 独立检查：correction/retraction 等特殊内容不进入日报
        if (shouldSkipLlmRescueByTitle(title)) continue;

        if (!matchesKeywords(config, title, rssAbstract, journal)) continue;
        if (filterBudget.remaining > 0) {
          filterBudget.remaining -= 1;
          const filterResult = await llmFilterFromModules(config, taxonomy, {
            title_en: title,
            journal: { name: journal },
            published_date: publishedDate,
            doi: normalizeText(item["dc:identifier"]),
            url: paperUrl,
            abstract_original: rssAbstract
          });
          if (!Boolean(filterResult.keep)) continue;
        }

        if (!authorInfoCache.has(paperUrl.toLowerCase())) {
          authorInfoCache.set(paperUrl.toLowerCase(), articleParser.parse(paperUrl));
        }
        const authorInfo = (await authorInfoCache.get(paperUrl.toLowerCase())) || { authors: [], affiliations: [], imageUrl: "", abstract: "", publicationType: "unknown" };

        // 优先使用页面提取的 abstract（通常比 RSS 摘要更完整）
        const resolvedAbstract = authorInfo.abstract || rssAbstract;
        const pubType = authorInfo.publicationType !== "unknown"
          ? authorInfo.publicationType
          : normalizeText(item["dc:type"] || item["prism:publicationType"] || item["prism:section"] || (item.category as string));

        papers.push(
          buildPaper({
            title,
            authors: authorInfo.authors.length > 0 ? authorInfo.authors : toArray(item.author as string[] | undefined),
            authorAffiliations: authorInfo.affiliations.length > 0 ? authorInfo.affiliations : extractAffiliationsFromRssItem(item),
            journal,
            sourceGroup: "Nature",
            publishedDate,
            doi: normalizeText(item["dc:identifier"]),
            url: paperUrl,
            abstractOriginal: resolvedAbstract,
            imageUrl: authorInfo.imageUrl || extractImageFromRssItem(item),
            publicationType: pubType,
            sourceProvider: "nature-rss",
            rawFeed: feedUrl,
            rawRecordId: normalizeText(item.guid || item.link),
            taxonomy
          })
        );
      }

      process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.rss.done", feed: feedUrl, papers: papers.length })}\n`);
    }

    return papers;
  }
}
