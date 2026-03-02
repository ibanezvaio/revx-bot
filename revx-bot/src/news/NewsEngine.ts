import { BotConfig } from "../config";
import { Logger } from "../logger";
import { Store } from "../store/Store";
import { buildHeadlineFingerprint, scoreHeadline } from "./NewsScorer";
import { CryptoPanicProvider } from "./providers/CryptoPanicProvider";
import { GdeltProvider } from "./providers/GdeltProvider";
import { NewsApiProvider } from "./providers/NewsApiProvider";
import { RssProvider } from "./providers/RssProvider";
import {
  Headline,
  NewsAggregate,
  NewsCategory,
  NewsDebugState,
  NewsDirection,
  NewsProvider,
  NewsSnapshot,
  RawHeadline
} from "./types";

const EMPTY_COUNTS: Record<NewsCategory, number> = {
  macro: 0,
  war: 0,
  rates: 0,
  crypto: 0,
  regulation: 0,
  exchange: 0,
  outage: 0,
  other: 0
};

type ProviderErrorTag =
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_NO_ITEMS"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_CONFIG_ERROR"
  | "";

type ProviderRuntimeState = {
  backoffUntilTs: number;
  lastSuccessTs: number;
  lastItems: RawHeadline[];
  lastError: string;
  lastErrorTag: ProviderErrorTag;
  excludeFromConfidence: boolean;
};

const PROVIDER_BACKOFF_SECONDS = 900;
const PROVIDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type NewsProviderResultWithMeta = {
  provider: string;
  ok: boolean;
  items: RawHeadline[];
  error: string;
  durationMs: number;
  fetchedAtTs: number;
  nonBlockingTag: ProviderErrorTag;
  excludeFromConfidence: boolean;
  usingCachedItems: boolean;
  backoffUntilTs: number;
  lastSuccessTs: number;
};

export class NewsEngine {
  private readonly providers: NewsProvider[];
  private readonly providerRuntime = new Map<string, ProviderRuntimeState>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private snapshot: NewsSnapshot = {
    ts: 0,
    items: [],
    aggregate: {
      impact: 0,
      direction: "NEUTRAL",
      confidence: 0,
      categoryCounts: { ...EMPTY_COUNTS }
    }
  };
  private debugState: NewsDebugState = {
    ts: 0,
    providerHealth: [],
    dedupe: {
      rawCount: 0,
      dedupedCount: 0,
      duplicateCount: 0
    },
    lastError: "",
    lastRefreshTs: 0
  };

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly store: Store
  ) {
    this.providers = [
      new RssProvider(config),
      new GdeltProvider(config)
    ];
    if (config.enableCryptopanic) {
      this.providers.push(new CryptoPanicProvider(config));
    }
    if (config.enableNewsapi || config.newsApiKey) {
      this.providers.push(new NewsApiProvider(config));
    }
  }

  start(): void {
    if (!this.config.newsEnabled || this.running) return;
    this.running = true;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, Math.max(15_000, this.config.newsRefreshMs));
    this.logger.info(
      {
        refreshMs: this.config.newsRefreshMs,
        providers: this.providers.map((row) => row.name)
      },
      "News engine started"
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): NewsSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  getDebugState(): NewsDebugState {
    return {
      ts: this.debugState.ts,
      providerHealth: this.debugState.providerHealth.map((row) => ({ ...row })),
      dedupe: { ...this.debugState.dedupe },
      lastError: this.debugState.lastError,
      lastRefreshTs: this.debugState.lastRefreshTs
    };
  }

  async refresh(nowTs = Date.now()): Promise<void> {
    if (!this.config.newsEnabled || this.inFlight) return;
    this.inFlight = true;
    let lastError = "";
    try {
      const providerResults: Array<{
        provider: NewsProviderResultWithMeta;
        health: NewsDebugState["providerHealth"][number];
      }> = [];
      for (const provider of this.providers) {
        providerResults.push(await this.executeProvider(provider, nowTs));
      }
      const mergedProviderResults = providerResults.map((row) => row.provider);
      const providerHealth = providerResults.map((row) => row.health);
      const raw = mergedProviderResults.flatMap((row) => row.items);
      const dedupedRaw = dedupeRaw(raw);
      const scored = scoreWithConsensus(dedupedRaw);
      const merged = mergeItems(this.snapshot.items, scored, this.config.newsMaxItems);
      const aggregate = computeNewsAggregate(merged, nowTs, this.config.newsHalfLifeMs);
      const bestTs = merged.length > 0 ? merged[0].ts : 0;

      this.snapshot = {
        ts: nowTs,
        items: merged,
        aggregate,
        lastError: mergedProviderResults.some((row) => !row.ok)
          ? mergedProviderResults
              .filter((row) => !row.ok)
              .map((row) => `${row.provider}:${row.error}`)
              .join(" | ")
          : undefined
      };

      this.debugState = {
        ts: nowTs,
        providerHealth,
        dedupe: {
          rawCount: raw.length,
          dedupedCount: dedupedRaw.length,
          duplicateCount: Math.max(0, raw.length - dedupedRaw.length)
        },
        lastError: this.snapshot.lastError ?? "",
        lastRefreshTs: nowTs
      };

      this.store.recordMetric({ ts: nowTs, key: "newsImpact", value: aggregate.impact });
      this.store.recordMetric({ ts: nowTs, key: "newsConfidence", value: aggregate.confidence });
      this.store.recordMetric({ ts: nowTs, key: "newsDirection", value: directionToNumber(aggregate.direction) });
      this.store.recordMetric({ ts: nowTs, key: "newsLastTs", value: bestTs });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      this.snapshot = {
        ...this.snapshot,
        ts: nowTs,
        lastError
      };
      this.debugState = {
        ...this.debugState,
        ts: nowTs,
        lastError,
        lastRefreshTs: nowTs
      };
      this.logger.warn({ error: lastError }, "News engine refresh failed");
    } finally {
      this.inFlight = false;
    }
  }

  private async executeProvider(
    provider: NewsProvider,
    nowTs: number
  ): Promise<{
    provider: NewsProviderResultWithMeta;
    health: NewsDebugState["providerHealth"][number];
  }> {
    const runtime = this.getProviderRuntime(provider.name);
    const backoffUntilTs = Math.max(0, runtime.backoffUntilTs);
    if (backoffUntilTs > nowTs) {
      const cachedItems = this.pullCachedItems(runtime.lastItems, nowTs);
      const result: NewsProviderResultWithMeta = {
        provider: provider.name,
        ok: false,
        items: cachedItems,
        error: `PROVIDER_RATE_LIMIT (backoff_active=${Math.ceil((backoffUntilTs - nowTs) / 1000)}s)`,
        durationMs: 0,
        fetchedAtTs: nowTs,
        nonBlockingTag: "PROVIDER_RATE_LIMIT",
        excludeFromConfidence: false,
        usingCachedItems: cachedItems.length > 0,
        backoffUntilTs,
        lastSuccessTs: runtime.lastSuccessTs
      };
      return {
        provider: result,
        health: {
          provider: provider.name,
          ok: false,
          error: result.error,
          nonBlockingTag: result.nonBlockingTag,
          excludeFromConfidence: false,
          usingCachedItems: result.usingCachedItems,
          backoffUntilTs: result.backoffUntilTs,
          lastSuccessTs: result.lastSuccessTs,
          lastItemTs: cachedItems[0]?.ts ?? 0,
          pollSeconds: Math.max(
            PROVIDER_BACKOFF_SECONDS,
            this.config.newsRefreshMs > 0 ? Math.max(1, Math.floor(this.config.newsRefreshMs / 1000)) : 1
          ),
          itemsLastHour: cachedItems.filter((row) => row.ts >= nowTs - 60 * 60 * 1000).length,
          durationMs: result.durationMs,
          fetchedAtTs: result.fetchedAtTs,
          count: cachedItems.length
        }
      };
    }

    const rawResult = await provider.fetch(nowTs);
    const errorTag = classifyProviderErrorTag(rawResult.error, rawResult.ok, rawResult.items.length);
    const excludeFromConfidence =
      errorTag === "PROVIDER_AUTH_ERROR" || errorTag === "PROVIDER_CONFIG_ERROR";

    let normalized: NewsProviderResultWithMeta = {
      provider: rawResult.provider,
      ok: rawResult.ok,
      items: rawResult.items,
      error: rawResult.error,
      durationMs: rawResult.durationMs,
      fetchedAtTs: rawResult.fetchedAtTs,
      nonBlockingTag: errorTag,
      excludeFromConfidence,
      usingCachedItems: false,
      backoffUntilTs: 0,
      lastSuccessTs: runtime.lastSuccessTs
    };

    if (errorTag === "PROVIDER_RATE_LIMIT") {
      runtime.backoffUntilTs = nowTs + PROVIDER_BACKOFF_SECONDS * 1000;
      const cachedItems = this.pullCachedItems(runtime.lastItems, nowTs);
      normalized = {
        ...normalized,
        ok: false,
        items: cachedItems,
        error: `PROVIDER_RATE_LIMIT (${rawResult.error || "quota/429"})`,
        usingCachedItems: cachedItems.length > 0,
        backoffUntilTs: runtime.backoffUntilTs
      };
    } else if (excludeFromConfidence) {
      normalized = {
        ...normalized,
        ok: true,
        items: [],
        error: `PROVIDER_CONFIG_ERROR (${rawResult.error || "auth"})`,
        backoffUntilTs: runtime.backoffUntilTs
      };
    } else if (errorTag === "PROVIDER_TIMEOUT") {
      normalized = {
        ...normalized,
        ok: false,
        items: [],
        error: `PROVIDER_TIMEOUT (${rawResult.error || "timeout"})`
      };
    } else if (errorTag === "PROVIDER_NO_ITEMS") {
      normalized = {
        ...normalized,
        ok: false,
        items: [],
        error: "PROVIDER_NO_ITEMS"
      };
    }

    if (rawResult.ok && rawResult.items.length > 0) {
      runtime.lastItems = dedupeRaw(rawResult.items).slice(0, 200);
      runtime.lastSuccessTs = nowTs;
      runtime.backoffUntilTs = 0;
      runtime.lastError = "";
      runtime.lastErrorTag = "";
      runtime.excludeFromConfidence = false;
    } else {
      runtime.lastError = normalized.error || rawResult.error || "";
      runtime.lastErrorTag = normalized.nonBlockingTag;
      runtime.excludeFromConfidence = excludeFromConfidence;
    }
    this.providerRuntime.set(provider.name, runtime);

    const itemsLastHour = normalized.items.filter((row) => row.ts >= nowTs - 60 * 60 * 1000).length;
    const health: NewsDebugState["providerHealth"][number] = {
      provider: provider.name,
      ok: normalized.ok,
      error: normalized.error,
      nonBlockingTag: normalized.nonBlockingTag,
      excludeFromConfidence: normalized.excludeFromConfidence,
      usingCachedItems: normalized.usingCachedItems,
      backoffUntilTs: normalized.backoffUntilTs,
      lastSuccessTs: runtime.lastSuccessTs,
      lastItemTs: normalized.items[0]?.ts ?? 0,
      pollSeconds:
        normalized.backoffUntilTs > nowTs
          ? Math.max(
              PROVIDER_BACKOFF_SECONDS,
              this.config.newsRefreshMs > 0 ? Math.max(1, Math.floor(this.config.newsRefreshMs / 1000)) : 1
            )
          : this.config.newsRefreshMs > 0
            ? Math.max(1, Math.floor(this.config.newsRefreshMs / 1000))
            : 1,
      itemsLastHour,
      durationMs: normalized.durationMs,
      fetchedAtTs: normalized.fetchedAtTs,
      count: normalized.items.length
    };
    return { provider: normalized, health };
  }

  private getProviderRuntime(name: string): ProviderRuntimeState {
    const existing = this.providerRuntime.get(name);
    if (existing) return existing;
    const created: ProviderRuntimeState = {
      backoffUntilTs: 0,
      lastSuccessTs: 0,
      lastItems: [],
      lastError: "",
      lastErrorTag: "",
      excludeFromConfidence: false
    };
    this.providerRuntime.set(name, created);
    return created;
  }

  private pullCachedItems(items: RawHeadline[], nowTs: number): RawHeadline[] {
    return dedupeRaw(items.filter((row) => nowTs - row.ts <= PROVIDER_CACHE_TTL_MS)).slice(0, 200);
  }
}

export function computeNewsAggregate(
  items: Headline[],
  nowTs: number,
  halfLifeMs: number
): NewsAggregate {
  const counts: Record<NewsCategory, number> = { ...EMPTY_COUNTS };
  if (!Array.isArray(items) || items.length === 0) {
    return {
      impact: 0,
      direction: "NEUTRAL",
      confidence: 0,
      categoryCounts: counts
    };
  }
  const safeHalfLife = Math.max(60_000, halfLifeMs);
  let weightedImpact = 0;
  let weightedDirection = 0;
  let weightSum = 0;
  for (const item of items) {
    const ageMs = Math.max(0, nowTs - item.ts);
    const weight = Math.exp(-ageMs / safeHalfLife);
    const dir = item.direction === "UP" ? 1 : item.direction === "DOWN" ? -1 : 0;
    weightedImpact += item.impact * weight;
    weightedDirection += dir * item.impact * item.confidence * weight;
    weightSum += weight;
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  }
  const normalizedImpact = clamp(Math.min(1.5, weightedImpact) / 1.5, 0, 1);
  const directionScore = weightSum > 0 ? weightedDirection / weightSum : 0;
  const direction: NewsDirection =
    directionScore > 0.06 ? "UP" : directionScore < -0.06 ? "DOWN" : "NEUTRAL";
  const confidence = clamp(
    0.1 +
      Math.min(0.5, Math.abs(directionScore) * 2.2) +
      Math.min(0.3, items.length / 20) +
      Math.min(0.1, normalizedImpact * 0.5),
    0,
    1
  );
  return {
    impact: normalizedImpact,
    direction,
    confidence,
    categoryCounts: counts
  };
}

function directionToNumber(direction: NewsDirection): number {
  if (direction === "UP") return 1;
  if (direction === "DOWN") return -1;
  return 0;
}

function dedupeRaw(items: RawHeadline[]): RawHeadline[] {
  const byId = new Map<string, RawHeadline>();
  for (const row of items) {
    const key = `${row.title} ${row.url}`.trim().toLowerCase();
    const existing = byId.get(key);
    if (!existing || row.ts > existing.ts) {
      byId.set(key, row);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.ts - a.ts);
}

function scoreWithConsensus(items: RawHeadline[]): Headline[] {
  const prelim = items.map((row) => scoreHeadline(row, 1));
  const bucket = new Map<string, Set<string>>();
  for (const item of prelim) {
    const key = buildHeadlineFingerprint(item.title);
    if (!bucket.has(key)) bucket.set(key, new Set<string>());
    bucket.get(key)?.add(item.source.toLowerCase());
  }
  return items
    .map((row) => {
      const key = buildHeadlineFingerprint(row.title);
      const sources = bucket.get(key);
      const similarSources = sources ? Math.max(1, sources.size) : 1;
      return scoreHeadline(row, similarSources);
    })
    .sort((a, b) => b.ts - a.ts);
}

function mergeItems(
  existing: Headline[],
  incoming: Headline[],
  limit: number
): Headline[] {
  const maxItems = Math.max(20, limit);
  const map = new Map<string, Headline>();
  for (const row of existing) {
    map.set(row.id, row);
  }
  for (const row of incoming) {
    const prev = map.get(row.id);
    if (!prev || row.ts >= prev.ts) {
      map.set(row.id, row);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, maxItems);
}

function cloneSnapshot(snapshot: NewsSnapshot): NewsSnapshot {
  return {
    ts: snapshot.ts,
    items: Array.isArray(snapshot.items) ? snapshot.items.map((row) => ({ ...row })) : [],
    aggregate: {
      impact: snapshot.aggregate.impact,
      direction: snapshot.aggregate.direction,
      confidence: snapshot.aggregate.confidence,
      categoryCounts: { ...snapshot.aggregate.categoryCounts }
    },
    lastError: snapshot.lastError
  };
}

function classifyProviderErrorTag(error: string, ok: boolean, itemCount: number): ProviderErrorTag {
  const text = String(error || "").toLowerCase();
  if (ok && itemCount > 0) return "";
  if (!ok && itemCount <= 0 && text.length === 0) return "PROVIDER_NO_ITEMS";
  if (/429|rate.?limit|quota|too many requests/.test(text)) return "PROVIDER_RATE_LIMIT";
  if (/401|403|unauthorized|forbidden|invalid api key|api key/.test(text)) return "PROVIDER_AUTH_ERROR";
  if (/abort|timeout|timed out|etimedout/.test(text)) return "PROVIDER_TIMEOUT";
  if (/missing|not set|no key|token/.test(text)) return "PROVIDER_CONFIG_ERROR";
  if (itemCount <= 0) return "PROVIDER_NO_ITEMS";
  return "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
