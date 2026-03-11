import { BotConfig } from "../config";
import { Logger } from "../logger";
import { clamp, emaUpdate } from "./math";
import { FairPriceModel } from "./FairPriceModel";
import { fetchBinanceTicker, resolveBinanceTickerUrl } from "./venues/binance";
import { fetchCoinbaseTicker, resolveCoinbaseTickerUrl } from "./venues/coinbase";
import { fetchKrakenTicker, resolveKrakenTickerUrl } from "./venues/kraken";
import {
  CrossVenueComputation,
  ExternalVenueSnapshot,
  SignalSnapshot,
  VenueId
} from "./types";

type VenueRuntime = {
  lastSnapshot: ExternalVenueSnapshot | null;
  failureCount: number;
  nextAllowedTs: number;
  inFlight: Promise<ExternalVenueSnapshot> | null;
};

type RollingPoint = {
  ts: number;
  globalMid: number;
  ema: number;
};

const DEFAULT_VENUES: VenueId[] = ["coinbase", "binance", "kraken"];
const MAX_ROLLING_POINTS = 2_000;

export class CrossVenueSignalEngine {
  private readonly runtimes: Record<VenueId, VenueRuntime> = {
    coinbase: emptyRuntime(),
    binance: emptyRuntime(),
    kraken: emptyRuntime()
  };
  private rolling: RollingPoint[] = [];
  private emaValue: number | null = null;
  private lastSignal: SignalSnapshot | null = null;
  private lastNoHealthyWarnMs = 0;
  private readonly fairPriceModel: FairPriceModel;

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {
    this.fairPriceModel = new FairPriceModel(config);
  }

  getLastSignal(): SignalSnapshot | null {
    return this.lastSignal;
  }

  async compute(symbol: string, revxMid: number, nowTs = Date.now()): Promise<CrossVenueComputation> {
    const venues = this.resolveConfiguredVenues();
    const effectiveTimeoutMs = Math.max(8_000, this.config.venueTimeoutMs);
    const settled = await Promise.allSettled(venues.map((venue) => this.refreshVenue(venue, symbol, nowTs)));
    const rawSnapshots = settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      return {
        symbol,
        venue: venues[index],
        quote: venues[index] === "binance" ? "USDT" : "USD",
        ts: nowTs,
        bid: null,
        ask: null,
        mid: null,
        spread_bps: null,
        latency_ms: 0,
        ok: false,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      } satisfies ExternalVenueSnapshot;
    });
    const fair = this.fairPriceModel.compute(symbol, revxMid, rawSnapshots, nowTs);
    const venueHealth = this.fairPriceModel.toVenueHealth(fair.venues);
    const healthyVenues = venueHealth.filter((row) => row.ok && !row.stale && row.mid && row.mid > 0);
    const globalMid = fair.globalMid > 0 ? fair.globalMid : Number.isFinite(revxMid) && revxMid > 0 ? revxMid : 0;

    const alpha = computeAlpha(this.config.venueRefreshMs, 60_000);
    this.emaValue = emaUpdate(this.emaValue, globalMid, alpha);
    this.rolling.push({ ts: nowTs, globalMid, ema: this.emaValue });
    this.trimRolling(nowTs);
    const driftBps = fair.driftBps;
    const stdevBps = fair.stdevBps;
    const zScore = stdevBps > 0 ? driftBps / stdevBps : 0;
    const basisBps = fair.basisBps;
    const dispersionBps = fair.dispersionBps;
    const confidence = fair.confidence;
    const volRegime = fair.volRegime;

    const driftComponentBps = clamp(driftBps, -this.config.fairDriftMaxBps, this.config.fairDriftMaxBps);
    const basisCorrectionBps = clamp(-basisBps, -this.config.fairBasisMaxBps, this.config.fairBasisMaxBps);
    const fairAnchorMid = fair.fairMid > 0 ? fair.fairMid : globalMid;
    const fairMid =
      fairAnchorMid > 0
        ? fairAnchorMid * (1 + (driftComponentBps + basisCorrectionBps) / 10_000)
        : fairAnchorMid;

    const signal: SignalSnapshot = {
      symbol,
      ts: nowTs,
      revx_mid: revxMid,
      global_mid: globalMid,
      fair_mid: fairMid,
      basis_bps: basisBps,
      drift_bps: driftBps,
      stdev_bps: stdevBps,
      z_score: zScore,
      confidence,
      dispersion_bps: dispersionBps,
      vol_regime: volRegime,
      drift_component_bps: driftComponentBps,
      basis_correction_bps: basisCorrectionBps,
      healthy_venues: healthyVenues.length,
      total_venues: venueHealth.length,
      reason: fair.reason
    };
    this.lastSignal = signal;

    const providerStatus = rawSnapshots.map((row) => {
      const ageMs = Math.max(0, nowTs - Number(row.ts || nowTs));
      const fresh = ageMs <= this.config.fairStaleMs;
      const accepted = Boolean(row.ok) && Number(row.mid || 0) > 0 && fresh;
      const abortCause = classifyAbortCause(row.error);
      const httpStatus = extractHttpStatus(row.error);
      const responseStatus = row.ok
        ? "OK"
        : abortCause === "LOCAL_TIMEOUT"
          ? "TIMEOUT"
          : abortCause === "PARENT_SIGNAL"
            ? "ABORTED"
            : "FAILED";
      return {
        provider: row.venue,
        url: getProviderUrl(row.venue, symbol),
        method: "GET",
        requestedSymbol: symbol,
        responseOk: Boolean(row.ok),
        responseStatus,
        mid: row.mid,
        timeoutMs: effectiveTimeoutMs,
        signalAbortedBeforeFetch: false,
        parentSignalAborted: abortCause === "PARENT_SIGNAL",
        abortCause,
        httpStatus,
        abortSource:
          abortCause === "LOCAL_TIMEOUT"
            ? "local_timeout"
            : abortCause === "PARENT_SIGNAL"
              ? "parent_shutdown"
              : abortCause === "UNKNOWN_ABORT"
                ? "unknown_abort"
                : "none",
        ageMs,
        fresh,
        accepted,
        error: row.error ?? null
      };
    });
    this.logger.debug(
      {
        symbol,
        configuredProviders: venues,
        providerStatus,
        finalAcceptedVenueCount: providerStatus.filter((row) => row.accepted).length
      },
      "Cross-venue provider pipeline"
    );

    if (confidence === 0 && healthyVenues.length === 0 && nowTs - this.lastNoHealthyWarnMs >= 30_000) {
      this.lastNoHealthyWarnMs = nowTs;
      this.logger.warn(
        {
          symbol,
          reason: fair.reason ?? "no healthy cross-venue snapshots",
          revxMid,
          configuredProviders: venues,
          providerStatus,
          finalAcceptedVenueCount: providerStatus.filter((row) => row.accepted).length
        },
        "Cross-venue signal low confidence"
      );
    }

    return {
      signal,
      venues: venueHealth,
      rawSnapshots
    };
  }

  private async refreshVenue(
    venue: VenueId,
    symbol: string,
    nowTs: number
  ): Promise<ExternalVenueSnapshot> {
    const runtime = this.runtimes[venue];
    if (runtime.inFlight) {
      return runtime.inFlight;
    }
    if (runtime.lastSnapshot && nowTs < runtime.nextAllowedTs) {
      const ageMs = Math.max(0, nowTs - Number(runtime.lastSnapshot.ts || nowTs));
      const reusable =
        Boolean(runtime.lastSnapshot.ok) &&
        Number(runtime.lastSnapshot.mid || 0) > 0 &&
        ageMs <= this.config.fairStaleMs;
      if (reusable) {
        this.logger.debug(
          {
            provider: venue,
            requestedSymbol: symbol,
            responseOk: runtime.lastSnapshot.ok,
            mid: runtime.lastSnapshot.mid,
            status: "CACHED_REUSE",
            ageMs,
            fresh: true
          },
          "Cross-venue provider response"
        );
        return runtime.lastSnapshot;
      }
    }

    const timeoutMs = Math.max(8_000, this.config.venueTimeoutMs);
    const providerUrl = getProviderUrl(venue, symbol);
    const signalAbortedBeforeFetch = false;
    const parentSignalAborted = false;
    const startTs = Date.now();

    this.logger.debug(
      {
        provider: venue,
        url: providerUrl,
        requestedSymbol: symbol,
        method: "GET",
        startTs,
        timeoutMs,
        signalAbortedBeforeFetch,
        parentSignalAborted,
        status: "START"
      },
      "Cross-venue provider start"
    );

    const fetchPromise = this.fetchVenueSnapshot(venue, symbol, timeoutMs)
      .then((snapshot) => {
        const endTs = Date.now();
        const elapsedMs = Math.max(0, endTs - startTs);
        const ageMs = Math.max(0, nowTs - Number(snapshot.ts || nowTs));
        const fresh = ageMs <= this.config.fairStaleMs;
        const abortCause = classifyAbortCause(snapshot.error);
        const httpStatus = extractHttpStatus(snapshot.error);
        const failurePhase = classifyFailurePhase(snapshot.error);
        const status = snapshot.ok
          ? "SUCCESS"
          : abortCause === "LOCAL_TIMEOUT"
            ? "TIMEOUT"
            : abortCause === "PARENT_SIGNAL"
              ? "ABORTED_PARENT"
              : "BAD_RESPONSE";
        if (snapshot.ok && snapshot.mid !== null && snapshot.mid > 0) {
          runtime.failureCount = 0;
          runtime.nextAllowedTs = nowTs + this.config.venueRefreshMs;
        } else {
          runtime.failureCount += 1;
          const backoffMs = Math.min(
            this.config.venueMaxBackoffMs,
            Math.round(this.config.venueRefreshMs * 2 ** Math.min(runtime.failureCount, 6))
          );
          runtime.nextAllowedTs = nowTs + backoffMs;
        }
        this.logger.debug(
          {
            provider: venue,
            url: providerUrl,
            requestedSymbol: symbol,
            method: "GET",
            responseOk: snapshot.ok,
            mid: snapshot.mid,
            status,
            responseStatus: status,
            startTs,
            endTs,
            elapsedMs,
            signalAbortedBeforeFetch,
            timeoutMs,
            parentSignalAborted,
            abortCause,
            httpStatus,
            failurePhase,
            abortSource:
              abortCause === "LOCAL_TIMEOUT"
                ? "local_timeout"
                : abortCause === "PARENT_SIGNAL"
                  ? "parent_shutdown"
                  : abortCause === "UNKNOWN_ABORT"
                    ? "unknown_abort"
                    : "none",
            ageMs,
            fresh,
            error: snapshot.error ?? null
          },
          "Cross-venue provider response"
        );
        runtime.lastSnapshot = snapshot;
        runtime.inFlight = null;
        return snapshot;
      })
      .catch((error) => {
        const endTs = Date.now();
        const elapsedMs = Math.max(0, endTs - startTs);
        runtime.failureCount += 1;
        const backoffMs = Math.min(
          this.config.venueMaxBackoffMs,
          Math.round(this.config.venueRefreshMs * 2 ** Math.min(runtime.failureCount, 6))
        );
        runtime.nextAllowedTs = nowTs + backoffMs;
        const failed: ExternalVenueSnapshot = {
          symbol,
          venue,
          quote: "USD",
          ts: nowTs,
          bid: null,
          ask: null,
          mid: null,
          spread_bps: null,
          latency_ms: 0,
          ok: false,
          error: (error as Error).message
        };
        const abortCause = classifyAbortCause(failed.error);
        const httpStatus = extractHttpStatus(failed.error);
        const failurePhase = classifyFailurePhase(failed.error);
        const status = abortCause === "LOCAL_TIMEOUT" ? "TIMEOUT" : "FETCH_ERROR";
        this.logger.debug(
          {
            provider: venue,
            url: providerUrl,
            requestedSymbol: symbol,
            method: "GET",
            responseOk: false,
            mid: null,
            status,
            responseStatus: status,
            startTs,
            endTs,
            elapsedMs,
            signalAbortedBeforeFetch,
            timeoutMs,
            parentSignalAborted,
            abortCause,
            httpStatus,
            failurePhase,
            abortSource:
              abortCause === "LOCAL_TIMEOUT"
                ? "local_timeout"
                : abortCause === "PARENT_SIGNAL"
                  ? "parent_shutdown"
                  : abortCause === "UNKNOWN_ABORT"
                    ? "unknown_abort"
                    : "none",
            ageMs: 0,
            fresh: false,
            error: failed.error ?? null
          },
          "Cross-venue provider response"
        );
        runtime.lastSnapshot = failed;
        runtime.inFlight = null;
        return failed;
      });
    runtime.inFlight = fetchPromise;
    return fetchPromise;
  }

  private resolveConfiguredVenues(): VenueId[] {
    const raw = Array.isArray(this.config.signalVenues) ? this.config.signalVenues : [];
    const parsed = raw
      .map((row) => String(row || "").trim().toLowerCase())
      .filter((row): row is VenueId => row === "coinbase" || row === "binance" || row === "kraken");
    if (parsed.length === 0) return DEFAULT_VENUES;
    return Array.from(new Set(parsed));
  }

  private async fetchVenueSnapshot(
    venue: VenueId,
    symbol: string,
    timeoutMs: number
  ): Promise<ExternalVenueSnapshot> {
    if (venue === "coinbase") {
      return fetchCoinbaseTicker(symbol, timeoutMs);
    }
    if (venue === "binance") {
      return fetchBinanceTicker(symbol, timeoutMs);
    }
    return fetchKrakenTicker(symbol, timeoutMs);
  }

  private trimRolling(nowTs: number): void {
    const keepWindowMs = Math.max(
      this.config.volWindowSeconds * 1000,
      this.config.trendWindowSeconds * 1000,
      120_000
    );
    const cutoff = nowTs - keepWindowMs;
    this.rolling = this.rolling.filter((point) => point.ts >= cutoff);
    if (this.rolling.length > MAX_ROLLING_POINTS) {
      this.rolling = this.rolling.slice(this.rolling.length - MAX_ROLLING_POINTS);
    }
  }
}

function emptyRuntime(): VenueRuntime {
  return {
    lastSnapshot: null,
    failureCount: 0,
    nextAllowedTs: 0,
    inFlight: null
  };
}

function computeAlpha(sampleMs: number, periodMs: number): number {
  const periods = Math.max(2, Math.round(periodMs / Math.max(sampleMs, 1)));
  return clamp(2 / (periods + 1), 0.01, 0.99);
}

function classifyAbortCause(errorText: string | undefined): string {
  const text = String(errorText || "").toUpperCase();
  if (text.includes("LOCAL_TIMEOUT")) return "LOCAL_TIMEOUT";
  if (text.includes("ABORTED_PARENT_SIGNAL")) return "PARENT_SIGNAL";
  if (text.includes("ABORTED")) return "UNKNOWN_ABORT";
  return "NONE";
}

function classifyFailurePhase(errorText: string | undefined): string {
  const text = String(errorText || "").toLowerCase();
  const match = text.match(/phase=([a-z_]+)/);
  if (match?.[1]) return match[1];
  return "unknown";
}

function extractHttpStatus(errorText: string | undefined): number | null {
  const text = String(errorText || "");
  const patterns = [/status=(\d{3})/i, /HTTP[\s_](\d{3})/i];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getProviderUrl(venue: VenueId, symbol: string): string {
  if (venue === "coinbase") return resolveCoinbaseTickerUrl(symbol);
  if (venue === "binance") return resolveBinanceTickerUrl(symbol);
  return resolveKrakenTickerUrl(symbol);
}
