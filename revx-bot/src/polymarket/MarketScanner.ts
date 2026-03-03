import { BotConfig } from "../config";
import { Logger } from "../logger";
import { GammaSeedScanner } from "./GammaSeedScanner";
import { PolymarketClient, RawPolymarketMarket } from "./PolymarketClient";
import { BtcWindowMarket } from "./types";

const MAX_CANDIDATE_PREVIEW = 200;
const MAX_REJECTION_PREVIEW = 10;

export type MarketScanCounters = {
  fetchedTotal: number;
  pagesScanned: number;
  recentEventsCount: number;
  prefixMatchesCount: number;
  tradableTotal: number;
  btcTotal: number;
  cadenceTotal: number;
  directionTotal: number;
  btc5mCandidates: number;
  activeWindows: number;
};

export type MarketScanCandidatePreview = {
  marketId: string;
  question: string;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  closed: boolean;
  active: boolean;
};

export type MarketScanRejection = {
  marketId: string;
  question: string;
  reasons: string[];
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  closed: boolean;
  active: boolean;
};

export type MarketScanDiagnostics = {
  ts: string;
  counters: MarketScanCounters;
  candidates: MarketScanCandidatePreview[];
  rejectedNotTradable: MarketScanRejection[];
  activeMarkets: BtcWindowMarket[];
  selectedSlug: string | null;
  selectedWindowStart: number | null;
  selectedWindowEnd: number | null;
  selectedAcceptingOrders: boolean | null;
  selectedEnableOrderBook: boolean | null;
  selectedMarket: BtcWindowMarket | null;
};

export class MarketScanner {
  private readonly btcPattern: RegExp;
  private readonly cadencePattern: RegExp;
  private readonly directionPattern: RegExp;
  private readonly seedScanner: GammaSeedScanner;
  private lastDiagnostics: MarketScanDiagnostics = {
    ts: new Date(0).toISOString(),
    counters: {
      fetchedTotal: 0,
      pagesScanned: 0,
      recentEventsCount: 0,
      prefixMatchesCount: 0,
      tradableTotal: 0,
      btcTotal: 0,
      cadenceTotal: 0,
      directionTotal: 0,
      btc5mCandidates: 0,
      activeWindows: 0
    },
    candidates: [],
    rejectedNotTradable: [],
    activeMarkets: [],
    selectedSlug: null,
    selectedWindowStart: null,
    selectedWindowEnd: null,
    selectedAcceptingOrders: null,
    selectedEnableOrderBook: null,
    selectedMarket: null
  };

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: PolymarketClient
  ) {
    this.seedScanner = new GammaSeedScanner(config, logger, client);
    this.btcPattern = safeCompileRegex(
      config.polymarket.marketQuery.patterns.btc,
      "(?:\\bbtc\\b|bitcoin|\\$btc)",
      logger,
      "POLYMARKET_PATTERN_BTC"
    );
    this.cadencePattern = safeCompileRegex(
      config.polymarket.marketQuery.patterns.cadence,
      "(?:\\b5m\\b|\\b5\\s*min(?:ute)?s?\\b|5-minute|5\\s*minute|minute market)",
      logger,
      "POLYMARKET_PATTERN_CADENCE"
    );
    this.directionPattern = safeCompileRegex(
      config.polymarket.marketQuery.patterns.direction,
      "(?:up\\s*/\\s*down|up\\s+down|direction|higher\\s*/\\s*lower|higher|lower|above\\s*/\\s*below|above|below)",
      logger,
      "POLYMARKET_PATTERN_DIRECTION"
    );
  }

  getLastDiagnostics(): MarketScanDiagnostics {
    return {
      ts: this.lastDiagnostics.ts,
      counters: { ...this.lastDiagnostics.counters },
      candidates: this.lastDiagnostics.candidates.map((row) => ({ ...row })),
      rejectedNotTradable: this.lastDiagnostics.rejectedNotTradable.map((row) => ({
        ...row,
        reasons: [...row.reasons]
      })),
      activeMarkets: this.lastDiagnostics.activeMarkets.map((row) => ({ ...row })),
      selectedSlug: this.lastDiagnostics.selectedSlug,
      selectedWindowStart: this.lastDiagnostics.selectedWindowStart,
      selectedWindowEnd: this.lastDiagnostics.selectedWindowEnd,
      selectedAcceptingOrders: this.lastDiagnostics.selectedAcceptingOrders,
      selectedEnableOrderBook: this.lastDiagnostics.selectedEnableOrderBook,
      selectedMarket: this.lastDiagnostics.selectedMarket ? { ...this.lastDiagnostics.selectedMarket } : null
    };
  }

  async scanActiveBtc5m(nowTs = Date.now()): Promise<BtcWindowMarket[]> {
    const diagnostics = await this.scanBtc5m(nowTs);
    return diagnostics.activeMarkets;
  }

  async scanBtc5m(nowTs = Date.now(), options?: { debug?: boolean }): Promise<MarketScanDiagnostics> {
    if (this.seedScanner.hasSeedConfig()) {
      const seeded = await this.seedScanner.scan(nowTs);
      const diagnostics: MarketScanDiagnostics = {
        ts: new Date(nowTs).toISOString(),
        counters: {
          fetchedTotal: seeded.fetchedTotal,
          pagesScanned: seeded.pagesScanned,
          recentEventsCount: seeded.recentEventsCount,
          prefixMatchesCount: seeded.prefixMatchesCount,
          tradableTotal: seeded.candidates.filter(
            (row) => row.active && !row.closed && row.enableOrderBook && row.acceptingOrders
          ).length,
          btcTotal: seeded.seededTotal,
          cadenceTotal: seeded.seededTotal,
          directionTotal: seeded.seededTotal,
          btc5mCandidates: seeded.seededTotal,
          activeWindows: seeded.activeMarkets.length
        },
        candidates: seeded.candidates.slice(0, MAX_CANDIDATE_PREVIEW).map((row) => ({
          marketId: row.conditionId,
          question: row.question,
          acceptingOrders: row.acceptingOrders,
          enableOrderBook: row.enableOrderBook,
          closed: row.closed,
          active: row.active
        })),
        rejectedNotTradable: seeded.candidates
          .filter((row) => row.closed || !row.acceptingOrders || !row.enableOrderBook || !row.active)
          .slice(0, MAX_REJECTION_PREVIEW)
          .map((row) => ({
            marketId: row.conditionId,
            question: row.question,
            reasons: [
              ...(row.closed ? ["closed"] : []),
              ...(!row.acceptingOrders ? ["not accepting_orders"] : []),
              ...(!row.enableOrderBook ? ["enable_order_book false"] : []),
              ...(!row.active ? ["not active"] : [])
            ],
            acceptingOrders: row.acceptingOrders,
            enableOrderBook: row.enableOrderBook,
            closed: row.closed,
            active: row.active
          })),
        activeMarkets: seeded.activeMarkets,
        selectedSlug: seeded.selectedSlug,
        selectedWindowStart: seeded.selectedWindowStart,
        selectedWindowEnd: seeded.selectedWindowEnd,
        selectedAcceptingOrders: seeded.selectedAcceptingOrders,
        selectedEnableOrderBook: seeded.selectedEnableOrderBook,
        selectedMarket: seeded.selectedMarket ? { ...seeded.selectedMarket } : null
      };
      this.lastDiagnostics = diagnostics;
      this.logger.info(
        {
          fetchedTotal: diagnostics.counters.fetchedTotal,
          tradableTotal: diagnostics.counters.tradableTotal,
          btcTotal: diagnostics.counters.btcTotal,
          cadenceTotal: diagnostics.counters.cadenceTotal,
          directionTotal: diagnostics.counters.directionTotal,
          btc5mCandidates: diagnostics.counters.btc5mCandidates,
          activeWindows: diagnostics.counters.activeWindows,
          recentEventsCount: diagnostics.counters.recentEventsCount,
          prefixMatchesCount: diagnostics.counters.prefixMatchesCount,
          selectedSlug: diagnostics.selectedSlug,
          selectedAcceptingOrders: diagnostics.selectedAcceptingOrders,
          selectedEnableOrderBook: diagnostics.selectedEnableOrderBook,
          selectedWindowStart: diagnostics.selectedWindowStart,
          selectedWindowEnd: diagnostics.selectedWindowEnd
        },
        "Polymarket seed scan counters"
      );
      if (options?.debug) {
        this.logger.info(
          {
            candidates: diagnostics.candidates.slice(0, 20)
          },
          "Polymarket seed candidate sample"
        );
      }
      return this.getLastDiagnostics();
    }

    const counters: MarketScanCounters = {
      fetchedTotal: 0,
      pagesScanned: 0,
      recentEventsCount: 0,
      prefixMatchesCount: 0,
      tradableTotal: 0,
      btcTotal: 0,
      cadenceTotal: 0,
      directionTotal: 0,
      btc5mCandidates: 0,
      activeWindows: 0
    };
    const candidates: MarketScanCandidatePreview[] = [];
    const rejectedNotTradable: MarketScanRejection[] = [];
    const activeMarkets: BtcWindowMarket[] = [];
    const seenRows = new Set<string>();

    const query = this.config.polymarket.marketQuery;
    const processRows = (rows: RawPolymarketMarket[]): void => {
      for (const row of rows) {
        const uniqueKey = scanUniqueKey(row);
        if (seenRows.has(uniqueKey)) continue;
        seenRows.add(uniqueKey);

        counters.fetchedTotal += 1;
        const marketId =
          pickString(row, ["id", "market_id", "conditionId", "condition_id"]) || `unknown:${counters.fetchedTotal}`;
        const slug = pickString(row, ["slug", "market_slug"]);
        const question =
          pickString(row, ["question", "title", "description"]) ||
          pickString(row, ["description", "subtitle"]) ||
          slug ||
          marketId;

        const active = pickBoolean(row, ["active", "is_active"], true);
        const closed = pickBoolean(row, ["closed", "is_closed", "resolved"], false);
        const acceptingOrders = pickBoolean(row, ["accepting_orders", "acceptingOrders", "tradable"], true);
        const enableOrderBook = pickBoolean(row, ["enable_order_book", "enableOrderBook"], true);
        if (active && !closed && acceptingOrders && enableOrderBook) {
          counters.tradableTotal += 1;
        }

        const text = marketText(row, slug, question);
        const btcMatch = this.btcPattern.test(text);
        const cadenceMatch = this.cadencePattern.test(text);
        const directionMatch = this.directionPattern.test(text);
        if (btcMatch) counters.btcTotal += 1;
        if (cadenceMatch) counters.cadenceTotal += 1;
        if (directionMatch) counters.directionTotal += 1;

        if (!(btcMatch && cadenceMatch && directionMatch)) continue;
        counters.btc5mCandidates += 1;

        if (candidates.length < MAX_CANDIDATE_PREVIEW) {
          candidates.push({
            marketId,
            question,
            acceptingOrders,
            enableOrderBook,
            closed,
            active
          });
        }

        const rejectionReasons: string[] = [];
        if (closed) rejectionReasons.push("closed");
        if (!acceptingOrders) rejectionReasons.push("not accepting_orders");
        if (!enableOrderBook) rejectionReasons.push("enable_order_book false");
        if (!active) rejectionReasons.push("not active");
        if (rejectionReasons.length > 0) {
          if (rejectedNotTradable.length < MAX_REJECTION_PREVIEW) {
            rejectedNotTradable.push({
              marketId,
              question,
              reasons: rejectionReasons,
              acceptingOrders,
              enableOrderBook,
              closed,
              active
            });
          }
          continue;
        }

        const parsed = this.parseCandidateToActiveMarket(row, nowTs, {
          marketId,
          slug,
          question,
          acceptingOrders
        });
        if (!parsed) continue;
        activeMarkets.push(parsed);
      }
    };

    const pageHandler = (rows: RawPolymarketMarket[], state: { pages: number }): boolean => {
      processRows(rows);
      counters.pagesScanned = state.pages;
      return counters.btc5mCandidates >= query.scanTargetCandidates;
    };

    const primary = await this.client.listMarketsPaginated({
      maxScan: query.maxScanMarkets,
      pageSize: query.scanPageSize,
      search: query.search,
      onPage: pageHandler
    });

    const search = query.search.trim();
    if (counters.btc5mCandidates < query.scanTargetCandidates && search.length > 0) {
      // Recovery pass without server-side search in case query filtering is too narrow.
      const fallback = await this.client.listMarketsPaginated({
        maxScan: query.maxScanMarkets,
        pageSize: query.scanPageSize,
        onPage: pageHandler
      });
      counters.pagesScanned = Math.max(counters.pagesScanned, primary.pages + fallback.pages);
    } else {
      counters.pagesScanned = Math.max(counters.pagesScanned, primary.pages);
    }

    activeMarkets.sort((a, b) => a.endTs - b.endTs);
    counters.activeWindows = activeMarkets.length;

    const diagnostics: MarketScanDiagnostics = {
      ts: new Date(nowTs).toISOString(),
      counters,
      candidates: candidates.slice(0, MAX_CANDIDATE_PREVIEW),
      rejectedNotTradable: rejectedNotTradable.slice(0, MAX_REJECTION_PREVIEW),
      activeMarkets,
      selectedSlug: activeMarkets[0]?.eventSlug ?? null,
      selectedWindowStart: activeMarkets[0]?.startTs ?? null,
      selectedWindowEnd: activeMarkets[0]?.endTs ?? null,
      selectedAcceptingOrders: activeMarkets[0]?.acceptingOrders ?? null,
      selectedEnableOrderBook: activeMarkets[0]?.enableOrderBook ?? null,
      selectedMarket: activeMarkets[0] ? { ...activeMarkets[0] } : null
    };
    this.lastDiagnostics = diagnostics;

    this.logger.info(
      {
        fetchedTotal: diagnostics.counters.fetchedTotal,
        tradableTotal: diagnostics.counters.tradableTotal,
        btcTotal: diagnostics.counters.btcTotal,
        cadenceTotal: diagnostics.counters.cadenceTotal,
        directionTotal: diagnostics.counters.directionTotal,
        btc5mCandidates: diagnostics.counters.btc5mCandidates,
        activeWindows: diagnostics.counters.activeWindows,
        pagesScanned: diagnostics.counters.pagesScanned
      },
      "Polymarket scan counters"
    );
    if (diagnostics.rejectedNotTradable.length > 0) {
      this.logger.info(
        {
          rejected: diagnostics.rejectedNotTradable
        },
        "Polymarket scan first non-tradable BTC-5m candidates"
      );
    }
    if (options?.debug) {
      this.logger.info(
        {
          candidates: diagnostics.candidates.slice(0, 20)
        },
        "Polymarket scan candidate sample"
      );
    }

    return this.getLastDiagnostics();
  }

  private parseCandidateToActiveMarket(
    row: RawPolymarketMarket,
    nowTs: number,
    input: {
      marketId: string;
      slug: string;
      question: string;
      acceptingOrders: boolean;
    }
  ): BtcWindowMarket | null {
    const endTs = pickTimestamp(row, ["endDate", "end_date", "end_time", "endTime", "end_date_iso"]);
    if (!Number.isFinite(endTs) || endTs <= nowTs) return null;

    const startTs = pickTimestamp(row, ["startDate", "start_date", "start_time", "startTime"]);
    if (Number.isFinite(startTs) && startTs > 0) {
      const windowSec = Math.max(0, (endTs - startTs) / 1000);
      if (
        windowSec < this.config.polymarket.marketQuery.minWindowSec ||
        windowSec > this.config.polymarket.marketQuery.maxWindowSec
      ) {
        return null;
      }
    }

    const priceToBeat =
      pickNumber(row, ["price_to_beat", "priceToBeat", "target_price", "strike", "threshold"]) ||
      parsePriceToBeat(input.question);
    if (!(priceToBeat > 0)) return null;

    const tokens = parseTokens(row);
    const yesToken = tokens.find((t) => t.outcome === "yes") ?? tokens[0];
    if (!yesToken?.tokenId) return null;

    const noToken = tokens.find((t) => t.outcome === "no");
    const tickSize = parseTickSize(
      pickString(row, ["minimum_tick_size", "minimumTickSize", "tick_size", "tickSize"])
    );
    const negRisk = pickBoolean(row, ["neg_risk", "negRisk"], false);

    return {
      marketId: input.marketId,
      slug: input.slug,
      question: input.question,
      priceToBeat,
      endTs,
      startTs: Number.isFinite(startTs) && startTs > 0 ? startTs : undefined,
      yesTokenId: yesToken.tokenId,
      noTokenId: noToken?.tokenId,
      tickSize: tickSize ?? undefined,
      negRisk,
      acceptingOrders: input.acceptingOrders
    };
  }
}

function parseTokens(row: RawPolymarketMarket): Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> {
  const raw = row.tokens;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const tokenId = pickString(obj, ["token_id", "tokenId", "id", "clob_token_id"]);
    if (!tokenId) continue;
    const outcomeRaw = pickString(obj, ["outcome", "name", "label"]).toLowerCase();
    const outcome: "yes" | "no" | "other" =
      outcomeRaw === "yes" ? "yes" : outcomeRaw === "no" ? "no" : "other";
    out.push({ outcome, tokenId });
  }
  return out;
}

function parsePriceToBeat(text: string): number {
  const normalized = text.replace(/,/g, "");
  const matches = normalized.matchAll(/\$?([0-9]+(?:\.[0-9]+)?)\s*(?:usd)?/gi);
  let best = 0;
  for (const match of matches) {
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    if (parsed > best) {
      best = parsed;
    }
  }
  return best >= 1_000 ? best : 0;
}

function safeCompileRegex(source: string, fallback: string, logger: Logger, envName: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch (error) {
    logger.warn(
      {
        envName,
        source,
        fallback,
        error: error instanceof Error ? error.message : String(error)
      },
      "Invalid Polymarket pattern regex, falling back"
    );
    return new RegExp(fallback, "i");
  }
}

function marketText(row: RawPolymarketMarket, slug: string, question: string): string {
  const description = pickString(row, ["description", "subtitle", "details"]);
  return `${slug} ${question} ${description}`.toLowerCase();
}

function scanUniqueKey(row: RawPolymarketMarket): string {
  const id = pickString(row, ["id", "market_id", "conditionId", "condition_id"]);
  if (id) return id;
  const slug = pickString(row, ["slug", "market_slug"]);
  if (slug) return `slug:${slug.toLowerCase()}`;
  const question = pickString(row, ["question", "title", "description"]);
  if (question) return `q:${question.toLowerCase()}`;
  return `fallback:${JSON.stringify(row).slice(0, 120)}`;
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
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
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

function parseTickSize(value: string): "0.1" | "0.01" | "0.001" | "0.0001" | null {
  const normalized = String(value || "").trim();
  if (normalized === "0.1") return "0.1";
  if (normalized === "0.01") return "0.01";
  if (normalized === "0.001") return "0.001";
  if (normalized === "0.0001") return "0.0001";
  return null;
}
