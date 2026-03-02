import { BotConfig } from "../../config";
import { RawSignalInput, SignalsProvider, SignalsProviderResult } from "../types";
import {
  dedupeKey,
  domainFromUrl,
  fetchTextWithTimeout,
  parseTimestamp,
  SIGNAL_PROVIDER_TIMEOUT_MS,
  stripHtml
} from "./common";

const DEFAULT_RSS_URLS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://feeds.reuters.com/reuters/worldNews",
  "https://www.ft.com/rss/home",
  "https://www.investing.com/rss/news.rss"
];

export class RssNewsProvider implements SignalsProvider {
  readonly name = "rss-news";
  private readonly urls: string[];

  constructor(config: BotConfig) {
    this.urls =
      Array.isArray(config.signalsRssUrls) && config.signalsRssUrls.length > 0
        ? config.signalsRssUrls
        : DEFAULT_RSS_URLS;
  }

  async fetch(nowTs: number): Promise<SignalsProviderResult> {
    const started = Date.now();
    try {
      const settled = await Promise.allSettled(
        this.urls.map((url) => fetchTextWithTimeout(url, SIGNAL_PROVIDER_TIMEOUT_MS))
      );
      const items: RawSignalInput[] = [];
      const seen = new Set<string>();
      let anySuccess = false;
      const errors: string[] = [];
      for (let i = 0; i < settled.length; i += 1) {
        const result = settled[i];
        const sourceUrl = this.urls[i];
        if (result.status !== "fulfilled") {
          errors.push(`${domainFromUrl(sourceUrl) || sourceUrl}: ${String(result.reason || "fetch failed")}`);
          continue;
        }
        anySuccess = true;
        const parsed = parseFeed(result.value, sourceUrl, nowTs);
        for (const item of parsed) {
          const key = dedupeKey(item.title, item.url);
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(item);
        }
      }
      return {
        provider: this.name,
        ok: anySuccess,
        items: items.sort((a, b) => b.ts - a.ts),
        error: errors.slice(0, 3).join(" | "),
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

function parseFeed(xml: string, sourceUrl: string, nowTs: number): RawSignalInput[] {
  const source = domainFromUrl(sourceUrl) || sourceUrl;
  const rows: RawSignalInput[] = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const title = stripHtml(pickTag(block, "title"));
    const url = stripHtml(pickTag(block, "link"));
    const ts = parseTimestamp(
      pickTag(block, "pubDate") || pickTag(block, "published") || pickTag(block, "updated"),
      nowTs
    );
    if (!title || !url) continue;
    rows.push({
      ts,
      kind: "NEWS",
      title,
      source,
      url
    });
  }
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of entryBlocks) {
    const title = stripHtml(pickTag(block, "title"));
    const href = pickLink(block);
    const ts = parseTimestamp(pickTag(block, "updated") || pickTag(block, "published"), nowTs);
    if (!title || !href) continue;
    rows.push({
      ts,
      kind: "NEWS",
      title,
      source,
      url: stripHtml(href)
    });
  }
  return rows;
}

function pickTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match && match[1] ? match[1] : "";
}

function pickLink(block: string): string {
  const href = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  if (href && href[1]) return href[1];
  return pickTag(block, "link");
}
