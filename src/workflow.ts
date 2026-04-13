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
