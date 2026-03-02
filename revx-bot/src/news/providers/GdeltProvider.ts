import { BotConfig } from "../../config";
import { NewsProvider, NewsProviderResult, RawHeadline } from "../types";
import {
  coerceTimestamp,
  fetchTextWithTimeout,
  fetchWithRetry,
  makeHeadlineId,
  NEWS_PROVIDER_TIMEOUT_MS,
  sourceFromUrl,
  stripHtml
} from "./common";

const DEFAULT_GDELT_QUERY =
  '(BTC OR Bitcoin OR crypto OR "Fed" OR "interest rates" OR "rate cut" OR "rate hike" OR CPI OR inflation OR Iran OR strike OR sanctions OR ETF OR "exchange outage" OR "exchange hack")';

export class GdeltProvider implements NewsProvider {
  readonly name = "gdelt";

  constructor(private readonly config: BotConfig) {}

  async fetch(nowTs = Date.now()): Promise<NewsProviderResult> {
    const started = Date.now();
    const query = this.config.newsGdeltQuery || DEFAULT_GDELT_QUERY;
    const lookbackMinutes = Math.max(10, Math.floor(this.config.newsRefreshMs / 1000 / 60) * 8);
    const url =
      "https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=ArtList&sort=DateDesc&maxrecords=80&query=" +
      encodeURIComponent(query) +
      "&timespan=" +
      encodeURIComponent(String(lookbackMinutes) + "min");
    try {
      const text = await fetchWithRetry(
        () => fetchTextWithTimeout(url, NEWS_PROVIDER_TIMEOUT_MS),
        1
      );
      const parsed = JSON.parse(text) as { articles?: unknown[] };
      const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
      const items: RawHeadline[] = [];
      for (const row of articles) {
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        const title = stripHtml(String(item.title ?? ""));
        const url = String(item.url ?? item.socialimage ?? "").trim();
        if (!title || !url) continue;
        const source = sourceFromUrl(url);
        items.push({
          ts: coerceTimestamp(item.seendate ?? item.date ?? item.datetime, nowTs),
          title,
          source,
          url,
          raw: {
            provider: "gdelt",
            sourceCountry: item.sourcecountry ?? null,
            domain: item.domain ?? null,
            language: item.language ?? null
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
    const previous = map.get(id);
    if (!previous || item.ts > previous.ts) {
      map.set(id, item);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.ts - a.ts);
}
