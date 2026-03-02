export type SignalRegime = "CALM" | "TREND" | "VOLATILE" | "CRISIS";
export type SignalBias = "LONG" | "SHORT" | "NEUTRAL";

export type QuoteVenue = {
  venue: string;
  symbol: string;
  quote: string;
  ts: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread_bps: number | null;
  latency_ms: number;
  ok: boolean;
  error: string;
};

export type CrossVenueSnapshot = {
  ts: number;
  symbol: string;
  venues: QuoteVenue[];
  globalMid: number;
  fairMid: number;
  basisBps: number;
  dispersionBps: number;
  confidence: number;
  regime: SignalRegime;
  bias: SignalBias;
  biasConfidence: number;
  driftBps: number;
  reason: string;
};

export type SignalDirection = "UP" | "DOWN" | "NEUTRAL";
export type SignalKind = "NEWS" | "MACRO" | "ONCHAIN" | "SYSTEM";
export type SignalCategory =
  | "war"
  | "rates"
  | "inflation"
  | "regulation"
  | "exchange"
  | "crypto"
  | "oil"
  | "risk";

export type SignalItem = {
  id: string;
  ts: number;
  kind: SignalKind;
  category: SignalCategory;
  title: string;
  source: string;
  url?: string;
  symbols: string[];
  impact: number;
  direction: SignalDirection;
  confidence: number;
  horizonMinutes: number;
  tags: string[];
  raw?: unknown;
  analysis?: {
    summary: string;
    rationale: string[];
  };
};

export type SignalAggregate = {
  ts: number;
  impact: number;
  direction: SignalDirection;
  confidence: number;
  state: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
  reasons: string[];
  latestTs: number;
  counts: Record<string, number>;
};

export type SignalSnapshot = {
  ts: number;
  items: SignalItem[];
  aggregate: SignalAggregate;
  health: {
    ok: boolean;
    lastError?: string;
    providers: ProviderHealth[];
  };
};

export type RawSignalInput = {
  ts: number;
  kind: SignalKind;
  title: string;
  source: string;
  url?: string;
  symbols?: string[];
  tags?: string[];
  raw?: unknown;
  categoryHint?: SignalCategory;
  directionHint?: SignalDirection;
  impactHint?: number;
  confidenceHint?: number;
  horizonMinutesHint?: number;
};

export type ProviderHealth = {
  provider: string;
  ok: boolean;
  count: number;
  durationMs: number;
  fetchedAtTs: number;
  error?: string;
};

export type SignalsProviderResult = {
  provider: string;
  ok: boolean;
  items: RawSignalInput[];
  error?: string;
  durationMs: number;
  fetchedAtTs: number;
};

export type SignalsProvider = {
  readonly name: string;
  fetch(nowTs: number): Promise<SignalsProviderResult>;
};

export type SignalsDebugState = {
  ts: number;
  health: {
    ok: boolean;
    lastError?: string;
    providers: ProviderHealth[];
  };
  dedupe: {
    rawCount: number;
    keptCount: number;
    duplicateCount: number;
  };
  loopTimings: {
    newsLastDurationMs: number;
    macroLastDurationMs: number;
    systemLastDurationMs: number;
    llmLastDurationMs: number;
  };
  llm: {
    enabled: boolean;
    suspendedUntilTs: number;
    lastError?: string;
    lastRunTs: number;
  };
  lastRefreshTs: number;
};
