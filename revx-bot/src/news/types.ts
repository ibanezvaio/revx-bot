export type NewsDirection = "UP" | "DOWN" | "NEUTRAL";

export type NewsCategory =
  | "macro"
  | "war"
  | "rates"
  | "crypto"
  | "regulation"
  | "exchange"
  | "outage"
  | "other";

export type Headline = {
  id: string;
  ts: number;
  title: string;
  source: string;
  url: string;
  tags: string[];
  symbols: string[];
  category: NewsCategory;
  impact: number;
  direction: NewsDirection;
  confidence: number;
  raw?: unknown;
};

export type NewsAggregate = {
  impact: number;
  direction: NewsDirection;
  confidence: number;
  categoryCounts: Record<NewsCategory, number>;
};

export type NewsSnapshot = {
  ts: number;
  items: Headline[];
  aggregate: NewsAggregate;
  lastError?: string;
};

export type RawHeadline = {
  ts: number;
  title: string;
  source: string;
  url: string;
  raw?: unknown;
};

export type NewsProviderResult = {
  provider: string;
  ok: boolean;
  items: RawHeadline[];
  error: string;
  durationMs: number;
  fetchedAtTs: number;
};

export type NewsProvider = {
  readonly name: string;
  fetch(nowTs?: number): Promise<NewsProviderResult>;
};

export type NewsDebugState = {
  ts: number;
  providerHealth: Array<{
    provider: string;
    ok: boolean;
    error: string;
    nonBlockingTag?: "PROVIDER_RATE_LIMIT" | "PROVIDER_AUTH_ERROR" | "PROVIDER_NO_ITEMS" | "PROVIDER_TIMEOUT" | "PROVIDER_CONFIG_ERROR" | "";
    excludeFromConfidence?: boolean;
    usingCachedItems?: boolean;
    backoffUntilTs?: number;
    lastSuccessTs?: number;
    lastItemTs?: number;
    pollSeconds?: number;
    itemsLastHour?: number;
    durationMs: number;
    fetchedAtTs: number;
    count: number;
  }>;
  dedupe: {
    rawCount: number;
    dedupedCount: number;
    duplicateCount: number;
  };
  lastError: string;
  lastRefreshTs: number;
};
