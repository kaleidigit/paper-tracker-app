import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import type { AppConfig, RunState, MetricsState } from "./types.js";

dotenv.config();

const ROOT_DIR = process.cwd();
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT_DIR, "config", "config.json");

function asNumber(input: unknown, fallback: number): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string") {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

export async function loadAppConfig(): Promise<AppConfig> {
  const raw = await fs.readFile(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as AppConfig;
  parsed.runtime = parsed.runtime || ({} as AppConfig["runtime"]);
  parsed.runtime.mode = parsed.runtime.mode || "run-once";
  parsed.runtime.state_dir = parsed.runtime.state_dir || "data/ts-runner";
  parsed.runtime.logs_dir = parsed.runtime.logs_dir || "data/ts-runner/logs";
  parsed.runtime.temp_dir = parsed.runtime.temp_dir || "data/ts-runner/tmp";
  parsed.runtime.command_timeout_ms = asNumber(parsed.runtime.command_timeout_ms, 300_000);
  parsed.runtime.retry = parsed.runtime.retry || { max_attempts: 1, backoff_ms: 1000 };
  parsed.runtime.retry.max_attempts = asNumber(parsed.runtime.retry.max_attempts, 1);
  parsed.runtime.retry.backoff_ms = asNumber(parsed.runtime.retry.backoff_ms, 1000);
  parsed.pipeline = parsed.pipeline || {};
  parsed.pipeline.default_days = asNumber(parsed.pipeline.default_days, 2);
  parsed.pipeline.schedule = parsed.pipeline.schedule || {};
  parsed.pipeline.schedule.hour = asNumber(parsed.pipeline.schedule.hour, 8);
  parsed.pipeline.schedule.minute = asNumber(parsed.pipeline.schedule.minute, 30);
  parsed.pipeline.schedule.check_every_hours = asNumber(parsed.pipeline.schedule.check_every_hours, 1);
  parsed.pipeline.paper_window = parsed.pipeline.paper_window || {};
  parsed.pipeline.paper_window.mode = parsed.pipeline.paper_window.mode || "since_yesterday_time";
  parsed.pipeline.paper_window.hour = asNumber(parsed.pipeline.paper_window.hour, 8);
  parsed.pipeline.paper_window.minute = asNumber(parsed.pipeline.paper_window.minute, 0);
  parsed.pipeline.paper_window.timezone =
    parsed.pipeline.paper_window.timezone || parsed.app?.timezone || "Asia/Shanghai";
  parsed.ai = parsed.ai || {};
  parsed.ai.translation = parsed.ai.translation || {};
  parsed.ai.translation.enabled = Boolean(parsed.ai.translation.enabled ?? true);
  parsed.ai.translation.model = parsed.ai.translation.model || parsed.ai.model || "";
  parsed.ai.translation.api_key_env = parsed.ai.translation.api_key_env || parsed.ai.api_key_env || "SILICONFLOW_API_KEY";
  parsed.ai.translation.required = Boolean(parsed.ai.translation.required ?? true);
  parsed.ai.temperature = asNumber(parsed.ai.temperature, 0.2);
  parsed.ai.max_tokens = asNumber(parsed.ai.max_tokens, 2000);
  parsed.ai.filter = parsed.ai.filter || {};
  parsed.ai.filter.enabled = Boolean(parsed.ai.filter.enabled);
  parsed.ai.filter.temperature = asNumber(parsed.ai.filter.temperature, 0);
  parsed.ai.filter.max_tokens = asNumber(parsed.ai.filter.max_tokens, 500);
  parsed.ai.filter.min_confidence = asNumber(parsed.ai.filter.min_confidence, 0.5);
  parsed.sources = parsed.sources || {};
  parsed.sources.keywords = Array.isArray(parsed.sources.keywords) ? parsed.sources.keywords : [];
  parsed.sources.openalex_queries = Array.isArray(parsed.sources.openalex_queries) ? parsed.sources.openalex_queries : [];
  parsed.sources.journals_file = parsed.sources.journals_file || "config/journals.json";
  parsed.feishu = parsed.feishu || {};
  parsed.feishu.alert_enabled = Boolean(parsed.feishu.alert_enabled ?? true);
  parsed.feishu.alert_message_template =
    parsed.feishu.alert_message_template || "未获取到任何论文数据，已终止日报推送，请立即排查数据源与过滤配置。";
  return parsed;
}

export const defaultRunState: RunState = {
  last_run_key: "",
  last_success_at: "",
  last_error: "",
  last_duration_ms: 0
};

export const defaultMetricsState: MetricsState = {
  total_runs: 0,
  success_runs: 0,
  failed_runs: 0,
  avg_duration_ms: 0,
  last_error: "",
  updated_at: ""
};
