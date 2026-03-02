import { BotConfig } from "../../config";
import { RawSignalInput, SignalsProvider, SignalsProviderResult } from "../types";
import {
  dedupeKey,
  domainFromUrl,
  fetchTextWithTimeout,
  parseTimestamp,
  SIGNAL_PROVIDER_TIMEOUT_MS,
  stripHtml,
  withRetry
} from "./common";

const DEFAULT_QUERY =
  '("bitcoin" OR "btc" OR "crypto" OR "fed" OR "rate hike" OR "rate cut" OR "cpi" OR "inflation" OR "iran" OR "strike" OR "sanctions" OR "oil")';

export class GdeltProvider implements SignalsProvider {
  readonly name = "gdelt";

  constructor(private readonly config: BotConfig) {}

  async fetch(nowTs: number): Promise<SignalsProviderResult> {
    const started = Date.now();
    const query = this.config.signalsGdeltQuery || DEFAULT_QUERY;
    const lookbackMinutes = Math.max(15, Math.floor(this.config.signalsNewsRefreshMs / 1000 / 60) * 10);
    const endpoint =
      "https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=ArtList&sort=DateDesc&maxrecords=100&query=" +
      encodeURIComponent(query) +
      "&timespan=" +
      encodeURIComponent(`${lookbackMinutes}min`);
    try {
      const raw = await withRetry(
        () => fetchTextWithTimeout(endpoint, SIGNAL_PROVIDER_TIMEOUT_MS),
        1
      );
      const parsed = JSON.parse(raw) as { articles?: unknown[] };
      const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
      const out: RawSignalInput[] = [];
      const seen = new Set<string>();
      for (const row of articles) {
        if (!row || typeof row !== "object") continue;
        const article = row as Record<string, unknown>;
        const title = stripHtml(String(article.title ?? ""));
        const url = String(article.url ?? article.socialimage ?? "").trim();
        if (!title || !url) continue;
        const key = dedupeKey(title, url);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ts: parseTimestamp(article.seendate ?? article.date ?? article.datetime, nowTs),
          kind: "NEWS",
          title,
          source: domainFromUrl(url) || "gdelt",
          url,
          raw: {
            sourceCountry: article.sourcecountry ?? null,
            domain: article.domain ?? null,
            language: article.language ?? null
          }
        });
      }
      return {
        provider: this.name,
        ok: true,
        items: out.sort((a, b) => b.ts - a.ts),
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
