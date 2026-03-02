import { BotConfig } from "../../config";
import { NewsProvider, NewsProviderResult, RawHeadline } from "../types";
import {
  coerceTimestamp,
  makeHeadlineId,
  NEWS_PROVIDER_TIMEOUT_MS,
  sourceFromUrl,
  stripHtml
} from "./common";

const DEFAULT_QUERY =
  '(bitcoin OR BTC OR crypto OR "federal reserve" OR "interest rates" OR inflation OR "rate cut" OR "rate hike" OR ETF OR sanctions OR strike)';

export class NewsApiProvider implements NewsProvider {
  readonly name = "newsapi";

  constructor(private readonly config: BotConfig) {}

  async fetch(nowTs = Date.now()): Promise<NewsProviderResult> {
    const started = Date.now();
    if (!this.config.newsApiKey) {
      return {
        provider: this.name,
        ok: true,
        items: [],
        error: "",
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    }
    const endpoint =
      "https://newsapi.org/v2/everything?language=en&pageSize=60&sortBy=publishedAt&q=" +
      encodeURIComponent(DEFAULT_QUERY);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NEWS_PROVIDER_TIMEOUT_MS);
      let body = "";
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            "X-Api-Key": this.config.newsApiKey
          },
          signal: controller.signal
        });
        body = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
      const parsed = JSON.parse(body) as { articles?: unknown[] };
      const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
      const items: RawHeadline[] = [];
      for (const row of articles) {
        if (!row || typeof row !== "object") continue;
        const article = row as Record<string, unknown>;
        const title = stripHtml(String(article.title ?? ""));
        const url = String(article.url ?? "").trim();
        if (!title || !url) continue;
        items.push({
          ts: coerceTimestamp(article.publishedAt, nowTs),
          title,
          source: sourceFromUrl(url),
          url,
          raw: {
            provider: "newsapi",
            sourceName:
              article.source && typeof article.source === "object"
                ? (article.source as Record<string, unknown>).name ?? null
                : null
          }
        });
      }
      return {
        provider: this.name,
        ok: true,
        items: dedupeRaw(items),
        error: "",
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    } catch (error) {
      return {
        provider: this.name,
        ok: false,
        items: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    }
  }
}

function dedupeRaw(items: RawHeadline[]): RawHeadline[] {
  const map = new Map<string, RawHeadline>();
  for (const item of items) {
    const id = makeHeadlineId(item.title, item.url);
    const prev = map.get(id);
    if (!prev || item.ts > prev.ts) {
      map.set(id, item);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.ts - a.ts);
}
