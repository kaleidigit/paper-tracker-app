import type { AppConfig, JsonRecord, Paper, PublishPayload } from "./types.js";
import { enrichPapers, fetchPapers, publishDigest, sendAlert } from "./modules.js";

export class EmptyPapersError extends Error {
  constructor(message = "未获取到任何论文数据") {
    super(message);
    this.name = "EmptyPapersError";
  }
}

function logProgress(event: string, extra: Record<string, unknown> = {}): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level: "INFO",
    event,
    ...extra
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function nowInTimezone(timezone: string): Date {
  const text = new Date().toLocaleString("en-US", { timeZone: timezone });
  return new Date(text);
}

export function buildDigestTitle(config: AppConfig): string {
  const timezone = config.app?.timezone || "Asia/Shanghai";
  const dateText = nowInTimezone(timezone).toISOString().slice(0, 10);
  const tpl = config.pipeline?.digest_title_template || "{date} 顶刊论文日报";
  return tpl.replace("{date}", dateText);
}

export function buildMarkdown(title: string, papers: Paper[]): string {
  const lines: string[] = [`# ${title}`, "", `共收录 ${papers.length} 篇。`, ""];
  papers.forEach((paper, index) => {
    const cls = paper.classification || {};
    const journal = paper.journal?.name || "";
    lines.push(`## ${index + 1}. ${paper.title_zh || paper.title_en}`);
    lines.push(`- 英文标题: ${paper.title_en || ""}`);
    lines.push(`- 作者: ${(paper.authors || []).join(", ")}`);
    lines.push(`- 作者单位: ${(paper.author_affiliations || []).join("; ")}`);
    lines.push(`- 期刊: ${journal}`);
    lines.push(`- 日期: ${paper.published_date || ""}`);
    lines.push(`- 类型: ${paper.publication_type || "unknown"}`);
    lines.push(`- 一级领域: ${cls.domain || ""}`);
    lines.push(`- 二级领域: ${cls.subdomain || ""}`);
    lines.push(`- 标签: ${(cls.tags || []).join(", ")}`);
    lines.push(`- 中文摘要: ${paper.abstract_zh || ""}`);
    lines.push(`- 摘要总结: ${paper.summary_zh || ""}`);
    lines.push(`- DOI: ${paper.doi || "N/A"}`);
    lines.push(`- 链接: ${paper.url || ""}`);
    lines.push(`- 主图: ${paper.image_url || ""}`);
    lines.push("");
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

async function withRetry<T>(maxAttempts: number, backoffMs: number, job: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await job();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

export async function runWorkflow(config: AppConfig): Promise<{ payload: PublishPayload; publishResult: JsonRecord }> {
  const attempts = Math.max(1, config.runtime.retry.max_attempts);
  const backoff = Math.max(0, config.runtime.retry.backoff_ms);
  const title = buildDigestTitle(config);

  logProgress("workflow.fetch.start");
  const papers = await withRetry(attempts, backoff, () => fetchPapers(config));
  logProgress("workflow.fetch.done", { papers: papers.length });
  if (papers.length === 0) {
    throw new EmptyPapersError();
  }
  logProgress("workflow.enrich.start", { papers: papers.length });
  const enriched = await withRetry(attempts, backoff, () => enrichPapers(config, papers));
  logProgress("workflow.enrich.done", { papers: enriched.length });
  const payload: PublishPayload = {
    title,
    markdown: buildMarkdown(title, enriched),
    records: buildRecords(enriched),
    papers: enriched
  };
  logProgress("workflow.publish.start", { papers: enriched.length });
  const publishResult = await withRetry(attempts, backoff, () => publishDigest(config, payload));
  logProgress("workflow.publish.done");
  return { payload, publishResult };
}

export async function sendEmptyPapersAlert(config: AppConfig): Promise<void> {
  await sendAlert(config, "未获取到任何论文数据，已终止日报推送，请排查抓取源、时间窗口与过滤配置。");
}
