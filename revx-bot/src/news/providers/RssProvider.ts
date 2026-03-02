import { BotConfig } from "../../config";
import { NewsProvider, NewsProviderResult, RawHeadline } from "../types";
import {
  coerceTimestamp,
  fetchTextWithTimeout,
  makeHeadlineId,
  NEWS_PROVIDER_TIMEOUT_MS,
  sourceFromUrl,
  stripHtml
} from "./common";

const DEFAULT_RSS_SOURCES = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://www.theblock.co/rss.xml",
  "https://cryptoslate.com/feed/",
  "https://www.investing.com/rss/news_301.rss",
  "https://www.investing.com/rss/news_95.rss",
  "https://www.ft.com/rss/home"
];

export class RssProvider implements NewsProvider {
  readonly name = "rss";
  private readonly urls: string[];

  constructor(config: BotConfig) {
    this.urls =
      Array.isArray(config.newsSourcesRss) && config.newsSourcesRss.length > 0
        ? config.newsSourcesRss
        : DEFAULT_RSS_SOURCES;
    if (this.urls.length < 3) {
      this.urls = DEFAULT_RSS_SOURCES.slice();
    }
  }

  async fetch(nowTs = Date.now()): Promise<NewsProviderResult> {
    const started = Date.now();
    const settled = await Promise.allSettled(
      this.urls.map(async (url) => {
        const xml = await fetchTextWithTimeout(url, NEWS_PROVIDER_TIMEOUT_MS);
        return parseFeed(xml, url, nowTs);
      })
    );
    const items: RawHeadline[] = [];
    const errors: string[] = [];
    for (let i = 0; i < settled.length; i += 1) {
      const row = settled[i];
      if (row.status === "fulfilled") {
        items.push(...row.value);
      } else {
        const reason = row.reason instanceof Error ? row.reason.message : String(row.reason);
        errors.push(`${this.urls[i]}: ${reason}`);
      }
    }
    const merged = dedupeRaw(items);
    return {
      provider: this.name,
      ok: merged.length > 0 || errors.length === 0,
      items: merged,
      error: errors.slice(0, 3).join(" | "),
      durationMs: Date.now() - started,
      fetchedAtTs: nowTs
    };
  }
}

function parseFeed(xml: string, sourceUrl: string, nowTs: number): RawHeadline[] {
  const rows: RawHeadline[] = [];
  const source = sourceFromUrl(sourceUrl);
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const title = pickTagValue(block, "title");
    const link = pickTagValue(block, "link");
    const pubDate = pickTagValue(block, "pubDate") || pickTagValue(block, "published") || pickTagValue(block, "updated");
    if (!title || !link) continue;
    rows.push({
      ts: coerceTimestamp(pubDate, nowTs),
      title: stripHtml(title),
      source,
      url: stripHtml(link),
      raw: {
        provider: "rss",
        sourceUrl
      }
    });
  }

  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of entryBlocks) {
    const title = pickTagValue(block, "title");
    const linkHref = pickLinkHref(block);
    const updated = pickTagValue(block, "updated") || pickTagValue(block, "published");
    if (!title || !linkHref) continue;
    rows.push({
      ts: coerceTimestamp(updated, nowTs),
      title: stripHtml(title),
      source,
      url: stripHtml(linkHref),
      raw: {
        provider: "rss",
        sourceUrl
      }
    });
  }

  return dedupeRaw(rows);
}

function pickTagValue(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(re);
  return match && match[1] ? match[1] : "";
}

function pickLinkHref(block: string): string {
  const match = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  if (match && match[1]) return match[1];
  return pickTagValue(block, "link");
}

function dedupeRaw(items: RawHeadline[]): RawHeadline[] {
  const byId = new Map<string, RawHeadline>();
  for (const row of items) {
    const id = makeHeadlineId(row.title, row.url);
    const existing = byId.get(id);
    if (!existing || row.ts > existing.ts) {
      byId.set(id, row);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.ts - a.ts);
}
