import { BotConfig } from "../../config";
import { NewsProvider, NewsProviderResult, RawHeadline } from "../types";
import {
  coerceTimestamp,
  fetchWithRetry,
  makeHeadlineId,
  NEWS_PROVIDER_TIMEOUT_MS,
  sourceFromUrl,
  stripHtml
} from "./common";

const BASE_URLS = [
  "https://cryptopanic.com/api/v1/posts/",
  "https://api.cryptopanic.com/v1/posts/"
];

export class CryptoPanicProvider implements NewsProvider {
  readonly name = "cryptopanic";

  constructor(private readonly config: BotConfig) {}

  async fetch(nowTs = Date.now()): Promise<NewsProviderResult> {
    const started = Date.now();
    if (!this.config.enableCryptopanic) {
      return {
        provider: this.name,
        ok: true,
        items: [],
        error: "",
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    }
    if (!this.config.cryptopanicToken) {
      return {
        provider: this.name,
        ok: false,
        items: [],
        error: "CRYPTOPANIC_TOKEN missing",
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    }

    try {
      let text = "";
      let resolvedError = "";
      for (const baseUrl of BASE_URLS) {
        const url =
          `${baseUrl}?auth_token=${encodeURIComponent(this.config.cryptopanicToken)}` +
          "&public=true&currencies=BTC&kind=news";
        try {
          text = await fetchWithRetry(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), NEWS_PROVIDER_TIMEOUT_MS);
            try {
              const response = await fetch(url, {
                method: "GET",
                signal: controller.signal,
                headers: {
                  accept: "application/json"
                }
              });
              const body = await response.text();
              if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${baseUrl}`);
              }
              return body;
            } finally {
              clearTimeout(timer);
            }
          }, 1);
          resolvedError = "";
          break;
        } catch (error) {
          resolvedError = error instanceof Error ? error.message : String(error);
          text = "";
        }
      }
      if (!text) {
        throw new Error(resolvedError || "CryptoPanic request failed");
      }

      const parsed = JSON.parse(text) as { results?: unknown[] };
      const rows = Array.isArray(parsed.results) ? parsed.results : [];
      const items: RawHeadline[] = [];

      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        const title = stripHtml(String(item.title ?? ""));
        const source =
          item.source && typeof item.source === "object"
            ? String((item.source as Record<string, unknown>).title ?? "cryptopanic")
            : "cryptopanic";
        const url = String(item.url ?? "").trim();
        if (!title || !url) continue;
        items.push({
          ts: coerceTimestamp(item.published_at ?? item.created_at, nowTs),
          title,
          source: sourceFromUrl(url) || source,
          url,
          raw: {
            provider: "cryptopanic",
            domain: source,
            kind: item.kind ?? null,
            votes: item.votes ?? null
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
  for (const row of items) {
    const key = makeHeadlineId(row.title, row.url);
    const prev = map.get(key);
    if (!prev || row.ts > prev.ts) {
      map.set(key, row);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.ts - a.ts);
}
