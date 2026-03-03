import { BotConfig } from "../config";
import { Logger } from "../logger";
import { BtcWindowMarket } from "./types";
import { PolymarketClient, RawPolymarketEvent } from "./PolymarketClient";

const ROLLING_REFRESH_MS = 10_000;
const FIVE_MIN_BUCKET_SEC = 300;
const PROBE_OFFSETS_SEC = [-600, -300, 0, 300, 600, 900] as const;

export type GammaResolvedEvent = {
  slug: string;
  conditionId: string;
  question: string;
  priceToBeat: number;
  outcomes: string[];
  tokenUpId: string;
  tokenDownId: string;
  windowStartTs?: number;
  windowEndTs: number;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  active: boolean;
  closed: boolean;
  updatedTs: number;
  yesBidHint?: number;
  yesAskHint?: number;
  yesMidHint?: number;
  yesLastTradeHint?: number;
  outcomePricesHint?: number[];
};

export type GammaSeedScanResult = {
  fetchedTotal: number;
  pagesScanned: number;
  seededTotal: number;
  recentEventsCount: number;
  prefixMatchesCount: number;
  selectedSlug: string | null;
  selectedWindowStart: number | null;
  selectedWindowEnd: number | null;
  selectedAcceptingOrders: boolean | null;
  selectedEnableOrderBook: boolean | null;
  selectedMarket: BtcWindowMarket | null;
  candidates: GammaResolvedEvent[];
  activeMarkets: BtcWindowMarket[];
};

export class GammaSeedScanner {
  private rollingCache:
    | {
        refreshedTs: number;
        selected: GammaResolvedEvent | null;
        candidates: GammaResolvedEvent[];
        fetchedTotal: number;
        pagesScanned: number;
        recentEventsCount: number;
        prefixMatchesCount: number;
      }
    | undefined;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: PolymarketClient
  ) {}

  hasSeedConfig(): boolean {
    return this.config.polymarket.marketQuery.seedEventSlugs.length > 0 || this.getSeriesPrefix().length > 0;
  }

  async resolveEventBySlug(slug: string): Promise<GammaResolvedEvent | null> {
    const events = await this.client.getEventsBySlug(slug);
    const parsed = events
      .map((row) => parseEvent(row, slug))
      .filter((row): row is GammaResolvedEvent => row !== null)
      .sort((a, b) => b.updatedTs - a.updatedTs);
    return parsed[0] ?? null;
  }

  async scan(nowTs = Date.now()): Promise<GammaSeedScanResult> {
    const explicitSlugs = this.config.polymarket.marketQuery.seedEventSlugs;
    const seriesPrefix = this.getSeriesPrefix();
    const candidates: GammaResolvedEvent[] = [];
    const selectedForTrading: GammaResolvedEvent[] = [];
    let fetchedTotal = 0;
    let pagesScanned = 0;
    let recentEventsCount = 0;
    let prefixMatchesCount = 0;

    for (const slug of explicitSlugs) {
      const events = await this.client.getEventsBySlug(slug);
      fetchedTotal += events.length;
      pagesScanned += 1;
      const parsed = events
        .map((row) => parseEvent(row, slug, nowTs, this.config.polymarket.marketQuery.cadenceMinutes))
        .filter((row): row is GammaResolvedEvent => row !== null)
        .sort((a, b) => b.updatedTs - a.updatedTs);
      if (parsed[0]) {
        candidates.push(parsed[0]);
        selectedForTrading.push(parsed[0]);
      } else {
        this.logger.warn({ slug }, "Gamma seed slug did not resolve to a tradable event");
      }
    }

    if (seriesPrefix.length > 0) {
      const rolling = await this.scanRolling(seriesPrefix, nowTs);
      fetchedTotal += rolling.fetchedTotal;
      pagesScanned += rolling.pagesScanned;
      recentEventsCount += rolling.recentEventsCount;
      prefixMatchesCount += rolling.prefixMatchesCount;
      if (rolling.selected) {
        candidates.push(rolling.selected);
        selectedForTrading.push(rolling.selected);
      }
      for (const row of rolling.candidates) {
        if (!candidates.find((existing) => existing.conditionId === row.conditionId)) {
          candidates.push(row);
        }
      }
    }

    const uniqueCandidates = dedupeByCondition(candidates);
    const activeMarkets = dedupeByCondition(selectedForTrading)
      .filter((row) => isWindowActive(row, nowTs))
      .map((row) => toBtcWindowMarket(row));

    const selected = pickSelected(uniqueCandidates, nowTs);
    const selectedMarket = selected && isFutureWindowTradable(selected, nowTs) ? toBtcWindowMarket(selected) : null;
    return {
      fetchedTotal,
      pagesScanned,
      seededTotal: uniqueCandidates.length,
      recentEventsCount,
      prefixMatchesCount,
      selectedSlug: selected?.slug ?? null,
      selectedWindowStart: selected?.windowStartTs ?? null,
      selectedWindowEnd: selected?.windowEndTs ?? null,
      selectedAcceptingOrders: selected?.acceptingOrders ?? null,
      selectedEnableOrderBook: selected?.enableOrderBook ?? null,
      selectedMarket,
      candidates: uniqueCandidates,
      activeMarkets
    };
  }

  private async scanRolling(prefix: string, nowTs: number): Promise<{
    selected: GammaResolvedEvent | null;
    candidates: GammaResolvedEvent[];
    fetchedTotal: number;
    pagesScanned: number;
    recentEventsCount: number;
    prefixMatchesCount: number;
  }> {
    if (this.rollingCache && nowTs - this.rollingCache.refreshedTs < ROLLING_REFRESH_MS) {
      const cached = this.rollingCache.selected;
      const cacheStillUsable =
        !cached ||
        (cached.windowEndTs > nowTs && cached.acceptingOrders);
      if (cacheStillUsable) {
        return {
          selected: this.rollingCache.selected,
          candidates: this.rollingCache.candidates,
          fetchedTotal: this.rollingCache.fetchedTotal,
          pagesScanned: this.rollingCache.pagesScanned,
          recentEventsCount: this.rollingCache.recentEventsCount,
          prefixMatchesCount: this.rollingCache.prefixMatchesCount
        };
      }
    }

    const bucket = Math.floor(nowTs / 1000 / FIVE_MIN_BUCKET_SEC) * FIVE_MIN_BUCKET_SEC;
    const probeSlugs = PROBE_OFFSETS_SEC.map((offset) => `${prefix}${bucket + offset}`);
    const candidates: GammaResolvedEvent[] = [];
    const probeRows: Array<{
      slug: string;
      exists: boolean;
      eventCount: number;
      acceptingOrders: boolean | null;
      enableOrderBook: boolean | null;
      closed: boolean | null;
      endDate: string | null;
      error?: string;
    }> = [];
    let fetchedTotal = 0;

    let earlySelected: GammaResolvedEvent | null = null;
    for (const slug of probeSlugs) {
      try {
        const events = await this.client.getEventsBySlug(slug);
        fetchedTotal += events.length;
        const parsed = events
          .map((row) => parseEvent(row, slug, nowTs, this.config.polymarket.marketQuery.cadenceMinutes))
          .filter((row): row is GammaResolvedEvent => row !== null)
          .sort((a, b) => b.updatedTs - a.updatedTs);
        const first = parsed[0] ?? null;
        if (first) {
          candidates.push(first);
        }

        probeRows.push({
          slug,
          exists: events.length > 0,
          eventCount: events.length,
          acceptingOrders: first?.acceptingOrders ?? null,
          enableOrderBook: first?.enableOrderBook ?? null,
          closed: first?.closed ?? null,
          endDate: first ? new Date(first.windowEndTs).toISOString() : null
        });

        if (
          first &&
          !first.closed &&
          first.windowEndTs > nowTs &&
          first.enableOrderBook &&
          first.acceptingOrders
        ) {
          earlySelected = first;
          break;
        }
      } catch (error) {
        probeRows.push({
          slug,
          exists: false,
          eventCount: 0,
          acceptingOrders: null,
          enableOrderBook: null,
          closed: null,
          endDate: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const dedupedCandidates = dedupeByCondition(candidates);
    const selection = earlySelected
      ? {
          selected: earlySelected,
          reason: {
            pool: "early_accepting_probe_hit",
            selected: {
              slug: earlySelected.slug,
              acceptingOrders: earlySelected.acceptingOrders,
              enableOrderBook: earlySelected.enableOrderBook,
              windowEndTs: earlySelected.windowEndTs
            }
          }
        }
      : pickSelectedWithReason(dedupedCandidates, nowTs);
    const selected = selection.selected;

    this.logger.info(
      {
        seedSeriesPrefix: prefix,
        probeBucketSec: bucket,
        probeSlugs,
        probes: probeRows,
        recentEventsCount: fetchedTotal,
        prefixMatchesCount: dedupedCandidates.length,
        selectedSlug: selected?.slug ?? null,
        selectedAcceptingOrders: selected?.acceptingOrders ?? null,
        selectedWhy: selection.reason
      },
      "Polymarket seed prefix probe refresh"
    );

    this.rollingCache = {
      refreshedTs: nowTs,
      selected,
      candidates: dedupedCandidates,
      fetchedTotal,
      pagesScanned: probeRows.length,
      recentEventsCount: fetchedTotal,
      prefixMatchesCount: dedupedCandidates.length
    };
    return {
      selected,
      candidates: dedupedCandidates,
      fetchedTotal,
      pagesScanned: probeRows.length,
      recentEventsCount: fetchedTotal,
      prefixMatchesCount: dedupedCandidates.length
    };
  }

  private getSeriesPrefix(): string {
    return String(this.config.polymarket.marketQuery.seedSeriesPrefix || "").trim();
  }
}

function parseEvent(
  row: RawPolymarketEvent,
  slugOverride?: string,
  nowTs = Date.now(),
  cadenceMinutes = 5
): GammaResolvedEvent | null {
  const slug = slugOverride || pickString(row, ["slug"]);
  if (!slug) return null;

  const eventActive = pickBoolean(row, ["active", "isActive"], true);
  const eventClosed = pickBoolean(row, ["closed", "isClosed"], false);
  const eventUpdatedTs = pickTimestamp(row, ["updatedAt", "updated_at", "timestamp"]);
  const eventTitle = pickString(row, ["title", "question", "description"]);
  const eventStartTs = pickTimestamp(row, ["startDate", "start_date", "startTime", "eventStartTime"]);
  const eventEndTs = pickTimestamp(row, ["endDate", "end_date", "endTime"]);
  const markets = Array.isArray(row.markets) ? row.markets : [];
  const marketObj = markets[0];
  if (!marketObj || typeof marketObj !== "object") return null;
  const market = marketObj as Record<string, unknown>;

  const conditionId = pickString(market, ["conditionId", "condition_id", "id", "market_id"]);
  if (!conditionId) return null;

  const question = pickString(market, ["question", "title", "description"]) || eventTitle || slug;
  const outcomes = parseStringArray(market.outcomes) ?? parseStringArray((row as Record<string, unknown>).outcomes) ?? [];
  const tokenIds = parseStringArray(market.clobTokenIds) ?? [];
  if (tokenIds.length === 0) return null;

  const upIndex = findOutcomeIndex(outcomes, /(up|higher|above)/i, 0);
  const downIndex = findOutcomeIndex(outcomes, /(down|lower|below)/i, upIndex === 0 ? 1 : 0);
  const tokenUpId = tokenIds[upIndex] ?? tokenIds[0];
  const tokenDownId = tokenIds[downIndex] ?? tokenIds.find((id) => id !== tokenUpId) ?? tokenUpId;
  if (!tokenUpId || !tokenDownId) return null;

  const marketStartTs = pickTimestamp(market, ["eventStartTime", "startDate", "start_date", "startTime"]);
  const marketEndTs = pickTimestamp(market, ["endDate", "end_date", "endTime"]);
  const slugStartTs = parseSlugBucketStartTs(slug);
  const slugEndTs = slugStartTs > 0 ? slugStartTs + Math.max(1, cadenceMinutes) * 60_000 : 0;
  const windowEndTs = slugEndTs > 0 ? slugEndTs : marketEndTs > 0 ? marketEndTs : eventEndTs;
  if (!(windowEndTs > 0)) return null;
  const parsedStartFromTitle = parseEtStartFromQuestion(question, windowEndTs);
  const roundedNowStart = roundDownToCadence(nowTs, cadenceMinutes);
  const fallbackStartTs = parsedStartFromTitle ?? roundedNowStart;
  const windowStartTs =
    slugStartTs > 0
      ? slugStartTs
      : marketStartTs > 0
        ? marketStartTs
        : eventStartTs > 0
          ? eventStartTs
          : fallbackStartTs;

  const bestBidHint = pickNumber(market, ["bestBid", "best_bid"]);
  const bestAskHint = pickNumber(market, ["bestAsk", "best_ask"]);
  const lastTradeHint = pickNumber(market, ["lastTradePrice", "last_trade_price", "lastPrice", "last_price"]);
  const outcomePrices = parseNumberArray(market.outcomePrices) ?? parseNumberArray(market.outcome_prices);
  const yesFromOutcomes = outcomePrices && outcomePrices.length > upIndex ? outcomePrices[upIndex] : 0;
  const yesMidHint = midpointOrZero(bestBidHint, bestAskHint, yesFromOutcomes || lastTradeHint);

  const acceptingOrders = pickBoolean(market, ["acceptingOrders", "accepting_orders"], true);
  const enableOrderBook = pickBoolean(market, ["enableOrderBook", "enable_order_book"], true);
  const marketActive = pickBoolean(market, ["active", "isActive"], eventActive);
  const marketClosed = pickBoolean(market, ["closed", "isClosed"], eventClosed);
  const updatedTs = pickTimestamp(market, ["updatedAt", "updated_at"]) || eventUpdatedTs || Date.now();

  return {
    slug,
    conditionId,
    question,
    priceToBeat:
      pickNumber(market, ["price_to_beat", "priceToBeat", "target_price", "strike", "threshold"]) ||
      parsePriceToBeat(question),
    outcomes: outcomes.length > 0 ? outcomes : ["Up", "Down"],
    tokenUpId,
    tokenDownId,
    windowStartTs,
    windowEndTs,
    acceptingOrders,
    enableOrderBook,
    active: marketActive,
    closed: marketClosed,
    updatedTs,
    yesBidHint: bestBidHint > 0 ? bestBidHint : undefined,
    yesAskHint: bestAskHint > 0 ? bestAskHint : undefined,
    yesMidHint: yesMidHint > 0 ? yesMidHint : undefined,
    yesLastTradeHint: lastTradeHint > 0 ? lastTradeHint : undefined,
    outcomePricesHint: outcomePrices ?? undefined
  };
}

function toBtcWindowMarket(row: GammaResolvedEvent): BtcWindowMarket {
  return {
    marketId: row.conditionId,
    slug: row.slug,
    question: row.question,
    priceToBeat: row.priceToBeat,
    endTs: row.windowEndTs,
    startTs: row.windowStartTs,
    yesTokenId: row.tokenUpId,
    noTokenId: row.tokenDownId,
    acceptingOrders: row.acceptingOrders,
    eventSlug: row.slug,
    enableOrderBook: row.enableOrderBook,
    closed: row.closed,
    yesBidHint: row.yesBidHint,
    yesAskHint: row.yesAskHint,
    yesMidHint: row.yesMidHint,
    yesLastTradeHint: row.yesLastTradeHint,
    outcomePricesHint: row.outcomePricesHint
  };
}

function parseSlugBucketStartTs(slug: string): number {
  const match = String(slug || "").match(/-(\d{9,12})$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
}

function midpointOrZero(a: number, b: number, fallback = 0): number {
  if (a > 0 && b > 0 && b >= a) return (a + b) / 2;
  return fallback > 0 ? fallback : 0;
}

function parsePriceToBeat(text: string): number {
  const normalized = text.replace(/,/g, "");
  const matches = normalized.matchAll(/\$?([0-9]+(?:\.[0-9]+)?)\s*(?:usd)?/gi);
  let best = 0;
  for (const match of matches) {
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    if (parsed > best) best = parsed;
  }
  return best >= 1_000 ? best : 0;
}

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.map((row) => String(row)).filter((row) => row.trim().length > 0);
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((row) => String(row)).filter((row) => row.trim().length > 0);
  } catch {
    return null;
  }
}

function parseNumberArray(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const parsed = value
      .map((row) => Number(row))
      .filter((row) => Number.isFinite(row) && row >= 0 && row <= 1);
    return parsed.length > 0 ? parsed : null;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsedRaw = JSON.parse(value) as unknown;
    if (!Array.isArray(parsedRaw)) return null;
    const parsed = parsedRaw
      .map((row) => Number(row))
      .filter((row) => Number.isFinite(row) && row >= 0 && row <= 1);
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function findOutcomeIndex(outcomes: string[], pattern: RegExp, fallback: number): number {
  const idx = outcomes.findIndex((outcome) => pattern.test(String(outcome)));
  if (idx >= 0) return idx;
  return clampIndex(fallback, outcomes.length);
}

function clampIndex(index: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(size - 1, Math.max(0, index));
}

function isWindowActive(row: GammaResolvedEvent, nowTs: number): boolean {
  if (!row.active) return false;
  if (row.closed) return false;
  if (!row.enableOrderBook) return false;
  if (row.windowEndTs <= nowTs) return false;
  if (row.windowStartTs && row.windowStartTs > nowTs) return false;
  return true;
}

function isFutureWindowTradable(row: GammaResolvedEvent, nowTs: number): boolean {
  return !row.closed && row.enableOrderBook && row.windowEndTs > nowTs;
}

function pickSelected(rows: GammaResolvedEvent[], nowTs: number): GammaResolvedEvent | null {
  return pickSelectedWithReason(rows, nowTs).selected;
}

function pickSelectedWithReason(
  rows: GammaResolvedEvent[],
  nowTs: number
): {
  selected: GammaResolvedEvent | null;
  reason: Record<string, unknown>;
} {
  const endFuture = rows.filter((row) => row.windowEndTs > nowTs);
  const primary = endFuture.filter((row) => row.active && !row.closed && row.enableOrderBook);
  const primaryAccepting = primary.filter((row) => row.acceptingOrders);
  const fallbackPool = endFuture.filter((row) => !row.closed && row.enableOrderBook);

  let pool = primaryAccepting;
  let poolName = "primary_accepting";
  if (pool.length === 0) {
    if (primary.length > 0) {
      pool = primary;
      poolName = "primary_not_accepting_fallback";
    } else if (fallbackPool.length > 0) {
      pool = fallbackPool;
      poolName = "future_orderbook_fallback";
    } else {
      return {
        selected: null,
        reason: {
          pool: "none",
          rows: rows.length,
          endFuture: endFuture.length,
          primary: primary.length,
          primaryAccepting: primaryAccepting.length,
          fallbackPool: fallbackPool.length
        }
      };
    }
  }

  pool.sort((a, b) => {
    const aOpen = a.windowStartTs ? a.windowStartTs <= nowTs : true;
    const bOpen = b.windowStartTs ? b.windowStartTs <= nowTs : true;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return b.updatedTs - a.updatedTs;
  });
  const selected = pool[0] ?? null;
  return {
    selected,
    reason: {
      pool: poolName,
      rows: rows.length,
      endFuture: endFuture.length,
      primary: primary.length,
      primaryAccepting: primaryAccepting.length,
      fallbackPool: fallbackPool.length,
      selected: selected
        ? {
            slug: selected.slug,
            active: selected.active,
            closed: selected.closed,
            enableOrderBook: selected.enableOrderBook,
            acceptingOrders: selected.acceptingOrders,
            windowStartTs: selected.windowStartTs ?? null,
            windowEndTs: selected.windowEndTs,
            updatedTs: selected.updatedTs
          }
        : null
    }
  };
}

function dedupeByCondition(rows: GammaResolvedEvent[]): GammaResolvedEvent[] {
  const out: GammaResolvedEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.conditionId}:${row.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const parsed = Number(obj[key]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function pickBoolean(obj: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    }
  }
  return fallback;
}

function pickTimestamp(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const asNum = Number(value);
      if (Number.isFinite(asNum)) {
        return asNum > 10_000_000_000 ? asNum : asNum * 1000;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

function roundDownToCadence(nowTs: number, cadenceMinutes: number): number {
  const cadenceMs = Math.max(1, Math.floor(cadenceMinutes)) * 60_000;
  return Math.floor(nowTs / cadenceMs) * cadenceMs;
}

function parseEtStartFromQuestion(question: string, windowEndTs: number): number | undefined {
  const text = String(question || "");
  const timeRangeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s*ET\s*(?:-|to|–)\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (!timeRangeMatch) return undefined;
  const startTime = String(timeRangeMatch[1] || "").trim().toUpperCase();
  const hmMatch = startTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!hmMatch) return undefined;

  const hours12 = Number(hmMatch[1]);
  const minutes = Number(hmMatch[2]);
  const meridian = hmMatch[3];
  if (!Number.isFinite(hours12) || !Number.isFinite(minutes)) return undefined;
  let hours24 = hours12 % 12;
  if (meridian === "PM") {
    hours24 += 12;
  }

  const [year, month, day] = getYmdInTimeZone(windowEndTs, "America/New_York");
  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hh = String(hours24).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");

  const estCandidate = Date.parse(`${isoDate}T${hh}:${mm}:00-05:00`);
  const edtCandidate = Date.parse(`${isoDate}T${hh}:${mm}:00-04:00`);
  const candidates = [estCandidate, edtCandidate].filter((value) => Number.isFinite(value));
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => Math.abs(windowEndTs - a) - Math.abs(windowEndTs - b));
  const picked = candidates[0];
  if (!Number.isFinite(picked) || picked <= 0) return undefined;
  return picked;
}

function getYmdInTimeZone(ts: number, timeZone: string): [number, number, number] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(new Date(ts));
  const year = Number(parts.find((part) => part.type === "year")?.value || 0);
  const month = Number(parts.find((part) => part.type === "month")?.value || 0);
  const day = Number(parts.find((part) => part.type === "day")?.value || 0);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    const d = new Date(ts);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  }
  return [year, month, day];
}
