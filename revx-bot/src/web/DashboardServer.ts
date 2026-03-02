import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { RuntimeOverridesInput } from "../overrides/runtimeOverrides";
import { VenueQuote as ExternalServiceQuote } from "../quotes/ExternalQuoteService";
import {
  BalanceSnapshot,
  BotStatus,
  FillRecord,
  OrderHistoryRecord,
  Side,
  Store,
  TickerSnapshot,
  VenueQuote
} from "../store/Store";
import { QuoteInputs, QuotePlan, quoteDebugState } from "../strategy/QuoteDebugState";
import {
  NormalizedBalances,
  normalizeBalancesForSymbol
} from "../strategy/balances/normalizeBalances";
import { signalDebugState } from "../signals/SignalDebugState";
import { computeSeedState } from "../strategy/inventorySeeding";
import { adverseDebugState } from "../strategy/AdverseDebugState";
import { seedDebugState } from "../strategy/SeedDebugState";
import { strategyHealthState } from "../strategy/StrategyHealthState";
import { getAssetCandidates, findAsset } from "../recon/balanceParsing";
import { BalanceState } from "../recon/BalanceState";
import { orderReconcileState } from "../recon/OrderReconcileState";
import { orderSubmitState } from "../recon/OrderSubmitState";
import { NewsEngine } from "../news/NewsEngine";
import { SignalsEngine } from "../signals/SignalsEngine";
import { SignalSnapshot } from "../signals/types";
import { IntelEngine } from "../intel/IntelEngine";
import { PerformanceEngine } from "../performance/PerformanceEngine";
import { AdaptiveStatus, AnalysisSummary, AnalysisWindowKey } from "../performance/types";
import { renderEquityChartScript } from "../ui/components/EquityChart";
import { renderDrawdownChartScript } from "../ui/components/DrawdownChart";
import { renderUseEquitySeriesScript } from "../ui/hooks/useEquitySeries";

type PnlWindowKey = "24h" | "12h" | "4h" | "1h" | "15m";

type DashboardActions = {
  cancelAllBotOrders: () => Promise<void>;
};

type ExternalQuoteReader = {
  getLatest: () => Record<string, ExternalServiceQuote>;
};

const PNL_WINDOW_MS: Record<PnlWindowKey, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "15m": 15 * 60 * 1000
};

type DashboardEventType =
  | "PLACED"
  | "CANCELLED"
  | "FILLED"
  | "REPLACED"
  | "SEED_TAKER"
  | "REJECTED"
  | "ERROR"
  | "OVERRIDE";

type DashboardEvent = {
  event_id: string;
  ts: number;
  type: DashboardEventType;
  side: string;
  price: number | null;
  size: number | null;
  reason: string;
  client_id: string;
  client_order_id: string;
  venue_order_id: string | null;
};

type OrderLifecycleState = "PENDING_LOCAL" | "OPEN_VENUE" | "TERMINAL";

type DashboardActiveOrder = {
  clientOrderId: string;
  venueOrderId: string | null;
  side: string;
  price: number;
  quoteSize: number;
  status: string;
  createdTs: number;
  updatedTs: number;
  lifecycleState: OrderLifecycleState;
  isVenueOpen: boolean;
  isPending: boolean;
  ageSeconds: number;
  reconcile: {
    lastSeenVenueTs: number;
    lastReconcileTs: number;
    staleReason?: string;
  };
  client_order_id: string;
  venue_order_id: string | null;
  quote_size: number;
  quote_size_usd?: number;
  quoteSizeUsd?: number;
  created_at: number;
  updated_at: number;
  bot_tag?: string | null;
  symbol?: string;
  is_bot?: number;
};

export class DashboardServer {
  private server: Server | null = null;
  private pauseActive = false;
  private killActive = false;
  private dashboardJsCache = "";
  private intelJsCache = "";
  private performanceJsCache = "";
  private readonly dashboardJsLastGoodPath: string;
  private readonly intelJsLastGoodPath: string;
  private readonly performanceJsLastGoodPath: string;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly store: Store,
    private readonly runId: string,
    private readonly actions?: DashboardActions,
    private readonly externalQuotes?: ExternalQuoteReader,
    private readonly newsEngine?: NewsEngine,
    private readonly signalsEngine?: SignalsEngine,
    private readonly intelEngine?: IntelEngine,
    private readonly performanceEngine?: PerformanceEngine
  ) {
    this.dashboardJsLastGoodPath = join(this.config.runtimeBaseDir, ".dashboard.last-good.js");
    this.intelJsLastGoodPath = join(this.config.runtimeBaseDir, ".intel.last-good.js");
    this.performanceJsLastGoodPath = join(this.config.runtimeBaseDir, ".performance.last-good.js");
  }

  start(): void {
    if (!this.config.dashboardEnabled) {
      this.logger.info("Dashboard disabled by DASHBOARD_ENABLED=false");
      return;
    }

    if (this.server) return;
    this.dashboardJsCache = this.prepareDashboardJs();
    this.intelJsCache = this.prepareIntelJs();
    this.performanceJsCache = this.preparePerformanceJs();

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });

    this.server.on("error", (error) => {
      this.logger.warn(
        { error: (error as Error).message, port: this.config.dashboardPort },
        "Dashboard server unavailable; continuing without UI"
      );
      this.stop();
    });

    this.server.listen(this.config.dashboardPort, "127.0.0.1", () => {
      this.logger.info(
        { url: `http://127.0.0.1:${this.config.dashboardPort}` },
        "Dashboard listening"
      );
    });
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }

  getPort(): number {
    if (!this.server) return 0;
    const address = this.server.address();
    if (!address || typeof address === "string") return 0;
    return Number(address.port) || 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/api/status") {
      const windowKey = parsePnlWindow(url.searchParams.get("window"));
      const eventLimit = parseLimit(url.searchParams.get("limit"), this.config.maxApiEvents, 50, 10_000);
      const payload = this.buildStatus(windowKey, eventLimit);
      writeJson(res, 200, payload);
      return;
    }

    if (method === "GET" && url.pathname === "/api/analysis/summary") {
      const window = parseAnalysisWindow(url.searchParams.get("window"));
      if (!this.performanceEngine) {
        writeJson(res, 200, buildEmptyAnalysisSummary(window));
        return;
      }
      writeJson(res, 200, this.performanceEngine.getSummary(window));
      return;
    }

    if (method === "GET" && url.pathname === "/api/analysis/fills") {
      const window = parseAnalysisWindow(url.searchParams.get("window"));
      const limit = parseLimit(url.searchParams.get("limit"), 50, 1, 1_000);
      const rows = this.performanceEngine ? this.performanceEngine.getFills(window, limit) : [];
      writeJson(res, 200, { ts: Date.now(), window, count: rows.length, rows });
      return;
    }

    if (method === "GET" && url.pathname === "/api/analysis/equity_curve") {
      const window = parseAnalysisWindow(url.searchParams.get("window"));
      const points = this.performanceEngine ? this.performanceEngine.getEquityCurve(window) : [];
      writeJson(res, 200, { ts: Date.now(), window, points });
      return;
    }

    if (method === "GET" && url.pathname === "/api/adaptive/status") {
      const status = this.performanceEngine ? this.performanceEngine.getAdaptiveStatus() : buildEmptyAdaptiveStatus();
      writeJson(res, 200, status);
      return;
    }

    if (method === "POST" && url.pathname === "/api/adaptive/enable") {
      const body = await readRequestBody(req);
      const enabled = parseBoolean(body.enabled);
      if (enabled === null) {
        writeJson(res, 400, { ok: false, message: "enabled must be boolean" });
        return;
      }
      const status = this.performanceEngine
        ? this.performanceEngine.setAdaptiveEnabled(enabled)
        : buildEmptyAdaptiveStatus();
      writeJson(res, 200, { ok: true, status });
      return;
    }

    if (method === "POST" && url.pathname === "/api/adaptive/setParams") {
      const body = await readRequestBody(req);
      const patch = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      const status = this.performanceEngine
        ? this.performanceEngine.setAdaptiveParams(
            {
              quoteMode: patch.quoteMode === "JOIN_TOB" ? "JOIN_TOB" : patch.quoteMode === "STEP_BACK" ? "STEP_BACK" : undefined,
              baseSpreadTicks: Number.isFinite(Number(patch.baseSpreadTicks)) ? Number(patch.baseSpreadTicks) : undefined,
              sizeMultiplier: Number.isFinite(Number(patch.sizeMultiplier)) ? Number(patch.sizeMultiplier) : undefined,
              levels: Number.isFinite(Number(patch.levels)) ? Number(patch.levels) : undefined,
              minRestSeconds: Number.isFinite(Number(patch.minRestSeconds)) ? Number(patch.minRestSeconds) : undefined
            },
            "api_set_params"
          )
        : buildEmptyAdaptiveStatus();
      writeJson(res, 200, { ok: true, status });
      return;
    }

    if (method === "GET" && url.pathname === "/api/signals") {
      const snapshot = this.signalsEngine?.getSnapshot() ?? buildEmptySignalsSnapshot(this.config.signalsEnabled);
      writeJson(res, 200, snapshot);
      return;
    }

    if (method === "GET" && url.pathname === "/api/intel/snapshot") {
      const nowTs = Date.now();
      const snapshot = this.intelEngine?.getIntelSnapshot(nowTs) ?? buildEmptyIntelSnapshot(this.config.enableIntel);
      const quoteDebug = quoteDebugState.getSnapshot();
      const enrichedBotStatus = ensureBotStatusWithQuoting(
        this.store.getBotStatus(),
        nowTs,
        quoteDebug.lastPlan,
        quoteDebug.lastUpdatedTs
      );
      const health = strategyHealthState.getSnapshot();
      const hardRisk = deriveHardRiskState(enrichedBotStatus, {
        stalled: health.stalled,
        lastCycleCompletedTs: health.lastCycleCompletedTs
      });
      const commentary =
        snapshot &&
        typeof snapshot === "object" &&
        (snapshot as Record<string, unknown>).commentary &&
        typeof (snapshot as Record<string, unknown>).commentary === "object"
          ? ((snapshot as Record<string, unknown>).commentary as Record<string, unknown>)
          : {};
      const providerHealth = Array.isArray(commentary.providerHealth)
        ? commentary.providerHealth
        : Array.isArray(commentary.providerFreshness)
          ? (commentary.providerFreshness as Array<Record<string, unknown>>).map((row) => ({
              provider: String(row.provider || "unknown"),
              ok: row.ok !== false,
              blocking: "NON_BLOCKING",
              lastError: row.lastError ? String(row.lastError) : undefined
            }))
          : [];
      const postureRecord =
        snapshot &&
        typeof snapshot === "object" &&
        (snapshot as Record<string, unknown>).posture &&
        typeof (snapshot as Record<string, unknown>).posture === "object"
          ? ((snapshot as Record<string, unknown>).posture as Record<string, unknown>)
          : {};
      const postureReasons = dedupeStrings([
        ...(Array.isArray(postureRecord.reasons) ? postureRecord.reasons.map((row) => String(row)) : []),
        ...(hardRisk.state === "HALT"
          ? hardRisk.reasons.map((row) => `HARD_RISK_${String(row).toUpperCase().replace(/\s+/g, "_")}`)
          : [])
      ]);
      const postureState = hardRisk.state === "HALT" ? "HALT" : String(postureRecord.state || "NORMAL");
      const enriched = {
        ...(snapshot as Record<string, unknown>),
        posture: {
          ...postureRecord,
          state: postureState,
          reasons: postureReasons
        },
        postureState,
        hardRiskState: hardRisk.state,
        commentary: {
          ...commentary,
          hardRiskState: hardRisk.state,
          hardHaltReasons: hardRisk.state === "HALT" ? dedupeStrings(hardRisk.reasons) : [],
          reasons: dedupeStrings([
            ...(Array.isArray(commentary.reasons) ? commentary.reasons.map((row) => String(row)) : []),
            ...(hardRisk.state === "HALT"
              ? hardRisk.reasons.map((row) => `HARD_RISK: ${row}`)
              : [])
          ]),
          providerHealth
        }
      };
      writeJson(res, 200, enriched);
      return;
    }

    if (method === "GET" && url.pathname === "/api/intel/health") {
      const health = this.intelEngine?.getIntelHealth() ?? buildEmptyIntelHealth(this.config.enableIntel);
      writeJson(res, 200, health);
      return;
    }

    if (method === "GET" && url.pathname === "/api/intel/commentary") {
      const nowTs = Date.now();
      const basePayload =
        this.intelEngine?.getIntelCommentary(nowTs) ?? {
          ts: nowTs,
          posture: "NORMAL",
          commentary: buildEmptyIntelSnapshot(this.config.enableIntel).commentary
        };
      const quoteDebug = quoteDebugState.getSnapshot();
      const enrichedBotStatus = ensureBotStatusWithQuoting(
        this.store.getBotStatus(),
        nowTs,
        quoteDebug.lastPlan,
        quoteDebug.lastUpdatedTs
      );
      const health = strategyHealthState.getSnapshot();
      const hardRisk = deriveHardRiskState(enrichedBotStatus, {
        stalled: health.stalled,
        lastCycleCompletedTs: health.lastCycleCompletedTs
      });
      const commentary = (basePayload.commentary ?? {}) as Record<string, unknown>;
      const intelConfidence = Number.isFinite(Number(commentary.intelConfidence))
        ? Number(commentary.intelConfidence)
        : 0;
      const providerHealth = Array.isArray(commentary.providerHealth)
        ? commentary.providerHealth
        : Array.isArray(commentary.providerFreshness)
          ? (commentary.providerFreshness as Array<Record<string, unknown>>).map((row) => ({
              provider: String(row.provider || "unknown"),
              ok: row.ok !== false,
              blocking: "NON_BLOCKING",
              lastError: row.lastError ? String(row.lastError) : undefined
            }))
          : [];
      const commentaryReasons = dedupeStrings([
        ...(Array.isArray(commentary.reasons) ? commentary.reasons.map((row) => String(row)) : []),
        ...(hardRisk.state === "HALT" ? hardRisk.reasons.map((row) => `HARD_RISK: ${row}`) : [])
      ]);
      const payload = {
        ...basePayload,
        posture: hardRisk.state === "HALT" ? "HALT" : basePayload.posture,
        hardRiskState: hardRisk.state,
        hardRiskReasons: hardRisk.reasons,
        intelConfidence,
        providerHealth,
        commentary: {
          ...commentary,
          reasons: commentaryReasons,
          hardHaltReasons:
            hardRisk.state === "HALT"
              ? dedupeStrings([
                  ...(Array.isArray(commentary.hardHaltReasons)
                    ? commentary.hardHaltReasons.map((row) => String(row))
                    : []),
                  ...hardRisk.reasons
                ])
              : Array.isArray(commentary.hardHaltReasons)
                ? commentary.hardHaltReasons.map((row) => String(row))
                : [],
          hardRiskState: hardRisk.state,
          intelConfidence,
          providerHealth
        }
      };
      writeJson(res, 200, payload);
      return;
    }

    if (method === "GET" && url.pathname === "/api/intel/debug") {
      const payload =
        this.intelEngine?.getDebugSnapshot() ?? {
          ts: Date.now(),
          posture: "NORMAL",
          reasons: ["INTEL_NOT_READY"],
          uniqueHighImpactCount1m: 0,
          dedupeStats: {
            rawEvents: 0,
            uniqueEvents: 0,
            duplicateEvents: 0,
            cooldownSuppressed: 0
          },
          adjustmentsApplied: {
            spreadMult: 1,
            sizeMult: 1,
            tobModeOverride: "UNCHANGED",
            hardBlock: false,
            cooldownSeconds: 0,
            reasonCodes: []
          },
          guardEnabled: false
        };
      writeJson(res, 200, payload);
      return;
    }

    if (method === "GET" && url.pathname === "/api/intel/debug/dedupe") {
      const payload =
        this.intelEngine?.getDedupeDebugSnapshot() ?? {
          ts: Date.now(),
          ttl: {
            seenIdsSeconds: 24 * 60 * 60,
            seenTitleDomainSeconds: 60 * 60
          },
          lastPoll: {
            ts: 0,
            received: 0,
            emitted: 0,
            droppedById: 0,
            droppedByTitleDomain: 0,
            droppedByTemporal: 0,
            droppedByCooldown: 0
          },
          totals: {
            received: 0,
            emitted: 0,
            droppedById: 0,
            droppedByTitleDomain: 0,
            droppedByTemporal: 0,
            droppedByCooldown: 0
          },
          recentPolls: [],
          cacheSize: {
            seenIds: 0,
            seenTitleDomain: 0,
            perKeyCooldown: 0
          }
        };
      writeJson(res, 200, payload);
      return;
    }

    if (method === "GET" && url.pathname === "/api/signals/news") {
      const snapshot = this.signalsEngine?.getSnapshot() ?? buildEmptySignalsSnapshot(this.config.signalsEnabled);
      writeJson(res, 200, {
        ts: snapshot.ts,
        aggregate: snapshot.aggregate,
        health: snapshot.health,
        items: snapshot.items.filter((row) => row.kind === "NEWS")
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/signals/macro") {
      const snapshot = this.signalsEngine?.getSnapshot() ?? buildEmptySignalsSnapshot(this.config.signalsEnabled);
      writeJson(res, 200, {
        ts: snapshot.ts,
        aggregate: snapshot.aggregate,
        health: snapshot.health,
        items: snapshot.items.filter((row) => row.kind === "MACRO")
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/signals") {
      const snapshot = this.signalsEngine?.getSnapshot() ?? buildEmptySignalsSnapshot(this.config.signalsEnabled);
      const debug = this.signalsEngine?.getDebugState() ?? {
        ts: Date.now(),
        health: snapshot.health,
        dedupe: { rawCount: 0, keptCount: snapshot.items.length, duplicateCount: 0 },
        loopTimings: {
          newsLastDurationMs: 0,
          macroLastDurationMs: 0,
          systemLastDurationMs: 0,
          llmLastDurationMs: 0
        },
        llm: {
          enabled: false,
          suspendedUntilTs: 0,
          lastRunTs: 0
        },
        lastRefreshTs: 0
      };
      writeJson(res, 200, {
        ts: Date.now(),
        enabled: this.config.signalsEnabled,
        snapshot,
        debug
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/news") {
      const snapshot = this.newsEngine?.getSnapshot() ?? {
        ts: Date.now(),
        items: [],
        aggregate: {
          impact: 0,
          direction: "NEUTRAL",
          confidence: 0,
          categoryCounts: {
            macro: 0,
            war: 0,
            rates: 0,
            crypto: 0,
            regulation: 0,
            exchange: 0,
            outage: 0,
            other: 0
          }
        },
        lastError: this.config.newsEnabled ? "News engine not initialized" : "News disabled"
      };
      writeJson(res, 200, snapshot);
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/news") {
      const snapshot = this.newsEngine?.getSnapshot() ?? null;
      const debug = this.newsEngine?.getDebugState() ?? {
        ts: Date.now(),
        providerHealth: [],
        dedupe: { rawCount: 0, dedupedCount: 0, duplicateCount: 0 },
        lastError: this.config.newsEnabled ? "News engine not initialized" : "News disabled",
        lastRefreshTs: 0
      };
      writeJson(res, 200, {
        ts: Date.now(),
        enabled: this.config.newsEnabled,
        snapshot,
        debug
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/fs") {
      writeJson(res, 200, {
        ts: Date.now(),
        cwd: process.cwd(),
        runtimeBaseDir: this.config.runtimeBaseDir
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/balances") {
      const balanceSnapshot = BalanceState.getSnapshot();
      const normalizedBalances = normalizeDashboardBalances(
        balanceSnapshot.normalizedBalances.length > 0
          ? balanceSnapshot.normalizedBalances
          : this.store.getLatestBalances()
      );
      const [baseAsset, quoteAsset] = splitSymbol(this.config.symbol);
      const baseAliases = getAssetCandidates(baseAsset, "base");
      const quoteAliases = getAssetCandidates(quoteAsset, "quote");
      const detectedBaseAsset = findAsset(normalizedBalances, baseAliases)?.asset ?? null;
      const detectedQuoteAsset = findAsset(normalizedBalances, quoteAliases)?.asset ?? null;
      const rawBalancesFromVenue = balanceSnapshot.rawBalancesFromVenue ?? { status: "not_ready" };
      writeJson(res, 200, {
        ts: Date.now(),
        cwd: process.cwd(),
        symbol: this.config.symbol,
        runtimeBaseDir: this.config.runtimeBaseDir,
        lastVenueBalancesTs: balanceSnapshot.lastVenueBalancesTs,
        lastVenueBalancesError: balanceSnapshot.lastVenueBalancesError,
        rawBalancesFromVenue,
        normalizedBalances,
        detectedAssets: extractAssetCodesFromRawBalances(rawBalancesFromVenue),
        detectedBaseAsset,
        detectedQuoteAsset,
        aliasMappingUsed: {
          baseAliases,
          quoteAliases,
          canonicalBaseAsset: baseAliases[0] ?? baseAsset,
          canonicalQuoteAsset: quoteAliases[0] ?? quoteAsset,
          quoteAliasesMerged: false
        },
        diagnostics: balanceSnapshot.lastDiagnostics,
        lastBalanceFetchError: balanceSnapshot.lastBalanceFetchError,
        lastBalanceFetchTs: balanceSnapshot.lastBalanceFetchTs
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/orders/venue-active") {
      const reconcile = orderReconcileState.getSnapshot();
      writeJson(res, 200, {
        ts: Date.now(),
        count: reconcile.venueActiveOrders.length,
        sample: reconcile.venueActiveOrders.slice(0, 20),
        normalized: reconcile.venueActiveOrders
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/orders/reconcile") {
      const reconcile = orderReconcileState.getSnapshot();
      writeJson(res, 200, {
        ts: Date.now(),
        localCountBefore: reconcile.localCountBefore,
        localCountAfter: reconcile.localCountAfter,
        pendingPruned: reconcile.pendingPruned,
        dupesRemoved: reconcile.dupesRemoved,
        lastReconcileTs: reconcile.lastReconcileTs,
        lastError: reconcile.lastError,
        venueFetchOk: reconcile.venueFetchOk
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/quotes") {
      const crossVenue = {
        venues: this.store.getRecentExternalPriceSnapshots(this.config.symbol, 50),
        signal: this.store.getRecentSignalSnapshots(this.config.symbol, 1)[0] ?? null
      };
      const externalQuotes = normalizeExternalQuotesFromCrossVenue(crossVenue);
      writeJson(res, 200, {
        ts: Date.now(),
        externalQuotes,
        count: externalQuotes.length
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/external-quotes") {
      const crossVenue = {
        venues: this.store.getRecentExternalPriceSnapshots(this.config.symbol, 50),
        signal: this.store.getRecentSignalSnapshots(this.config.symbol, 1)[0] ?? null
      };
      const externalQuotes = normalizeExternalQuotesFromCrossVenue(crossVenue);
      writeJson(res, 200, {
        ts: Date.now(),
        externalQuotesCount: externalQuotes.length,
        externalQuotes,
        crossVenueVenuesCount: Array.isArray(crossVenue.venues) ? crossVenue.venues.length : 0
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/seed") {
      const seed = seedDebugState.getSnapshot();
      writeJson(res, 200, {
        ts: Date.now(),
        seedMode: seed.seedMode,
        seedStartTs: seed.seedStartTs,
        seedReposts: seed.seedReposts,
        seedTakerFired: seed.seedTakerFired,
        lastSeedOrderIds: seed.lastSeedOrderIds,
        progress: {
          btcNotionalUsd: seed.btcNotionalUsd,
          lowGateUsd: seed.lowGateUsd,
          targetUsd: seed.targetUsd
        },
        blockedReasons: seed.blockedReasons,
        lastUpdatedTs: seed.lastUpdatedTs
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/signal") {
      const signal = signalDebugState.getSnapshot();
      writeJson(res, 200, {
        ts: Date.now(),
        lastUpdatedTs: signal.lastUpdatedTs,
        lastError: signal.lastError,
        snapshot: signal.snapshot,
        venues: signal.venues
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/adverse") {
      const adverse = adverseDebugState.getSnapshot();
      writeJson(res, 200, {
        ts: Date.now(),
        lastUpdatedTs: adverse.lastUpdatedTs,
        lastError: adverse.lastError,
        state: adverse.state
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/venues") {
      const signal = signalDebugState.getSnapshot();
      const crossVenue = {
        venues: this.store.getRecentExternalPriceSnapshots(this.config.symbol, 50),
        signal: this.store.getRecentSignalSnapshots(this.config.symbol, 1)[0] ?? null
      };
      const externalQuotes = normalizeExternalQuotesFromCrossVenue(crossVenue);
      writeJson(res, 200, {
        ts: Date.now(),
        count: externalQuotes.length,
        externalQuotes,
        signalVenues: signal.venues,
        signalLastError: signal.lastError
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/debug/quote") {
      const quoteDebug = quoteDebugState.getSnapshot();
      const strategyHealth = strategyHealthState.getSnapshot();
      const beforeFirstCycle = strategyHealth.lastCycleCompletedTs === 0;
      const bootError = beforeFirstCycle
        ? quoteDebug.bootError ?? "Quote planner has not completed its first cycle yet."
        : null;
      const inputs =
        quoteDebug.lastInputs ??
        (strategyHealth.lastCycleCompletedTs > 0
          ? buildFallbackQuoteInputs(this.config, strategyHealth.lastCycleCompletedTs)
          : null);
      const quotePlan =
        quoteDebug.lastPlan ??
        (inputs ? buildFallbackQuotePlan(inputs) : null);
      const normalizedBalancesUsed =
        quoteDebug.normalizedBalancesUsed ??
        (inputs ? normalizeBalancesFromQuoteInputs(inputs) : null);
      writeJson(res, 200, {
        ts: Date.now(),
        quotePlan,
        inputs,
        normalizedBalancesUsed,
        lastUpdatedTs: quoteDebug.lastUpdatedTs,
        bootError
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/action/cancel-all") {
      await this.handleCancelAllAction(res);
      return;
    }

    if (method === "POST" && url.pathname === "/api/action/pause") {
      await this.handlePauseAction(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/api/action/kill") {
      await this.handleKillAction(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/api/overrides") {
      const symbol = normalizeSymbolParam(url.searchParams.get("symbol"), this.config.symbol);
      const overrides = this.store.getRuntimeOverrides(symbol);
      const effectiveConfig = this.store.getEffectiveConfig(symbol);
      writeJson(res, 200, {
        ok: true,
        symbol,
        overrides,
        effectiveConfig,
        expired: overrides === null
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/overrides/set") {
      await this.handleSetOverridesAction(req, res);
      return;
    }

    if (
      method === "POST" &&
      (url.pathname === "/api/overrides/clear" || url.pathname === "/api/overrides/reset-defaults")
    ) {
      await this.handleClearOverridesAction(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/healthz") {
      writeJson(res, 200, { ok: true, ts: Date.now() });
      return;
    }

    if (method === "GET" && url.pathname === "/dashboard.js") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      if (!this.dashboardJsCache) {
        this.dashboardJsCache = this.prepareDashboardJs();
      }
      res.end(this.dashboardJsCache);
      return;
    }

    if (method === "GET" && url.pathname === "/intel.js") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      if (!this.intelJsCache) {
        this.intelJsCache = this.prepareIntelJs();
      }
      res.end(this.intelJsCache);
      return;
    }

    if (method === "GET" && url.pathname === "/performance.js") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      if (!this.performanceJsCache) {
        this.performanceJsCache = this.preparePerformanceJs();
      }
      res.end(this.performanceJsCache);
      return;
    }

    if (method === "GET" && url.pathname === "/intel") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.end(renderIntelConsoleHtml(this.config.symbol));
      return;
    }

    if (method === "GET" && url.pathname === "/performance") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.end(renderPerformanceHtml(this.config.symbol));
      return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (String(url.searchParams.get("view") || "").toLowerCase() === "intel") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.end(renderIntelConsoleHtml(this.config.symbol));
        return;
      }
      if (String(url.searchParams.get("view") || "").toLowerCase() === "performance") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.end(renderPerformanceHtml(this.config.symbol));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.end(
        renderDashboardHtml(
          this.config.maxUiEvents,
          this.config.maxEquityPoints,
          this.config.equitySampleMs,
          this.config.persistEquitySeries,
          this.config.symbol
        )
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
  }

  private prepareDashboardJs(): string {
    const candidate = renderDashboardJs(
      this.config.maxUiEvents,
      this.config.maxEquityPoints,
      this.config.equitySampleMs,
      this.config.persistEquitySeries,
      this.config.symbol
    );
    if (this.validateJs(candidate)) {
      try {
        writeFileSync(this.dashboardJsLastGoodPath, candidate, "utf8");
      } catch (error) {
        this.logger.warn({ error }, "Unable to persist last-known-good dashboard.js");
      }
      return candidate;
    }
    this.logger.error("Generated dashboard.js failed syntax check; attempting fallback");
    try {
      if (existsSync(this.dashboardJsLastGoodPath)) {
        const fallback = readFileSync(this.dashboardJsLastGoodPath, "utf8");
        if (fallback && this.validateJs(fallback)) {
          this.logger.warn("Serving cached last-known-good dashboard.js");
          return fallback;
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Failed reading cached dashboard.js");
    }
    return "window.__REVX_BOOT_ERR__='dashboard.js syntax check failed';";
  }

  private prepareIntelJs(): string {
    const candidate = renderIntelConsoleJs();
    if (this.validateJs(candidate)) {
      try {
        writeFileSync(this.intelJsLastGoodPath, candidate, "utf8");
      } catch (error) {
        this.logger.warn({ error }, "Unable to persist last-known-good intel.js");
      }
      return candidate;
    }
    this.logger.error("Generated intel.js failed syntax check; attempting fallback");
    try {
      if (existsSync(this.intelJsLastGoodPath)) {
        const fallback = readFileSync(this.intelJsLastGoodPath, "utf8");
        if (fallback && this.validateJs(fallback)) {
          this.logger.warn("Serving cached last-known-good intel.js");
          return fallback;
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Failed reading cached intel.js");
    }
    return "window.__REVX_INTEL_ERR__='intel.js syntax check failed';";
  }

  private preparePerformanceJs(): string {
    const candidate = renderPerformanceJs();
    if (this.validateJs(candidate)) {
      try {
        writeFileSync(this.performanceJsLastGoodPath, candidate, "utf8");
      } catch (error) {
        this.logger.warn({ error }, "Unable to persist last-known-good performance.js");
      }
      return candidate;
    }
    this.logger.error("Generated performance.js failed syntax check; attempting fallback");
    try {
      if (existsSync(this.performanceJsLastGoodPath)) {
        const fallback = readFileSync(this.performanceJsLastGoodPath, "utf8");
        if (fallback && this.validateJs(fallback)) {
          this.logger.warn("Serving cached last-known-good performance.js");
          return fallback;
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Failed reading cached performance.js");
    }
    return "window.__REVX_PERFORMANCE_ERR__='performance.js syntax check failed';";
  }

  private validateJs(source: string): boolean {
    const tempPath = join(tmpdir(), `revx-dashboard-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.js`);
    try {
      writeFileSync(tempPath, source, "utf8");
      execFileSync(process.execPath, ["--check", tempPath], { stdio: "pipe" });
      return true;
    } catch (error) {
      this.logger.error({ error }, "dashboard.js syntax validation failed");
      return false;
    } finally {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // ignore tmp cleanup failures
      }
    }
  }

  private buildStatus(windowKey: PnlWindowKey, eventLimit: number): Record<string, unknown> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const windowMs = PNL_WINDOW_MS[windowKey];
    const balanceLimit = estimateSnapshotCount(windowMs, this.config.reconcileSeconds, 220, 20_000);
    const tickerIntervalSeconds = Math.max(this.config.refreshSeconds, this.config.reconcileSeconds);
    const tickerLimit = estimateSnapshotCount(windowMs, tickerIntervalSeconds, 400, 20_000);

    const balances = normalizeDashboardBalances(this.store.getLatestBalances());
    const trackedBotOrdersRaw = this.store
      .getRecentBotOrders(1_500)
      .filter((order) => order.symbol === this.config.symbol);
    const orderReconcileSnapshot = orderReconcileState.getSnapshot();
    const reconciledOrders = buildReconciledActiveOrders({
      orders: trackedBotOrdersRaw,
      reconcileSnapshot: orderReconcileSnapshot,
      nowTs: now,
      venueSnapshotReady: orderReconcileSnapshot.lastReconcileTs > 0,
      pendingStaleSeconds: this.config.pendingStaleSeconds,
      maxRows: 500
    });
    const activeBotOrders = reconciledOrders.openOrders;
    const activeBotOrdersAll = reconciledOrders.allTrackedOrders;
    const activeBotOrdersSummary = reconciledOrders.summary;
    const recentBotOrders = this.store.getRecentBotOrderHistory(eventLimit);
    const recentFills = this.store.getRecentFills(eventLimit);
    const recentExternalPrice = this.store.getRecentExternalPriceSnapshots(this.config.symbol, 20);
    const latestSignalSnapshot = this.store.getRecentSignalSnapshots(this.config.symbol, 1)[0] ?? null;
    const newsSnapshot = this.newsEngine?.getSnapshot() ?? null;
    const signalsSnapshot = this.signalsEngine?.getSnapshot() ?? buildEmptySignalsSnapshot(this.config.signalsEnabled);
    const intelSnapshot = this.intelEngine?.getIntelSnapshot(now) ?? buildEmptyIntelSnapshot(this.config.enableIntel);
    const intelHealth = this.intelEngine?.getIntelHealth(now) ?? buildEmptyIntelHealth(this.config.enableIntel);
    const runtimeOverrides = this.store.getRuntimeOverrides(this.config.symbol);
    const runtimeOverrideMetaKeys = new Set([
      "symbol",
      "createdAtMs",
      "updatedAtMs",
      "expiresAtMs",
      "source",
      "note"
    ]);
    const runtimeOverrideValues: Record<string, unknown> = {};
    const runtimeOverrideFields: string[] = [];
    if (runtimeOverrides && typeof runtimeOverrides === "object") {
      for (const [key, value] of Object.entries(runtimeOverrides as Record<string, unknown>)) {
        if (runtimeOverrideMetaKeys.has(key)) continue;
        if (value === undefined || value === null) continue;
        runtimeOverrideFields.push(key);
        runtimeOverrideValues[key] = value;
      }
    }
    runtimeOverrideFields.sort((a, b) => a.localeCompare(b));
    const runtimeOverridesStatus = {
      active: runtimeOverrideFields.length > 0,
      fields: runtimeOverrideFields,
      values: runtimeOverrideValues
    };
    const effectiveConfig = this.store.getEffectiveConfig(this.config.symbol);
    const recentEvents = this.store.getRecentBotEvents(eventLimit).map((row) => ({
      event_id: row.event_id,
      ts: row.ts,
      type: row.type as DashboardEventType,
      side: row.side,
      price: Number.isFinite(row.price) ? row.price : null,
      size: Number.isFinite(row.quote_size_usd) ? row.quote_size_usd : null,
      reason: row.reason,
      details_json: row.details_json ?? null,
      client_id: row.client_order_id,
      client_order_id: row.client_order_id,
      venue_order_id: row.venue_order_id
    }));
    const strategyHealthSnapshot = strategyHealthState.getSnapshot();
    const quoteDebug = quoteDebugState.getSnapshot();
    const quoteInputsForStatus =
      quoteDebug.lastInputs ??
      (strategyHealthSnapshot.lastCycleCompletedTs > 0
        ? buildFallbackQuoteInputs(this.config, strategyHealthSnapshot.lastCycleCompletedTs)
        : null);
    const quotePlanForStatus =
      quoteDebug.lastPlan ??
      (quoteInputsForStatus ? buildFallbackQuotePlan(quoteInputsForStatus) : null);
    const strategyStallThresholdMs = Math.max(1_000, this.config.reconcileSeconds * 5_000);
    const strategyStalled =
      strategyHealthSnapshot.lastCycleCompletedTs > 0 &&
      now - strategyHealthSnapshot.lastCycleCompletedTs > strategyStallThresholdMs;
    const strategyStatus = {
      lastCycleCompletedTs: strategyHealthSnapshot.lastCycleCompletedTs,
      stalled: strategyStalled || strategyHealthSnapshot.stalled
    };
    const botStatus = ensureBotStatusWithQuoting(
      this.store.getBotStatus(),
      now,
      quotePlanForStatus,
      quoteDebug.lastUpdatedTs
    );
    const orderSubmitSnapshot = orderSubmitState.getSnapshot();
    const botStatusWithSubmitDiagnostics: BotStatus = {
      ...botStatus,
      lastError:
        orderSubmitSnapshot.lastError && orderSubmitSnapshot.lastError.trim().length > 0
          ? orderSubmitSnapshot.lastError
          : orderReconcileSnapshot.lastError && orderReconcileSnapshot.lastError.trim().length > 0
            ? orderReconcileSnapshot.lastError
          : undefined,
      lastSubmitError: orderSubmitSnapshot.lastSubmit
    };
    const hardRisk = deriveHardRiskState(botStatusWithSubmitDiagnostics, strategyStatus);
    const intelCommentaryRaw =
      intelSnapshot &&
      typeof intelSnapshot === "object" &&
      (intelSnapshot as Record<string, unknown>).commentary &&
      typeof (intelSnapshot as Record<string, unknown>).commentary === "object"
        ? ((intelSnapshot as Record<string, unknown>).commentary as Record<string, unknown>)
        : {};
    const intelProviderHealth = Array.isArray(intelCommentaryRaw.providerHealth)
      ? intelCommentaryRaw.providerHealth
      : Array.isArray(intelCommentaryRaw.providerFreshness)
        ? (intelCommentaryRaw.providerFreshness as Array<Record<string, unknown>>).map((row) => ({
            provider: String(row.provider || "unknown"),
            ok: row.ok !== false,
            blocking: "NON_BLOCKING",
            lastError: row.lastError ? String(row.lastError) : undefined
          }))
        : [];
    const intelConfidenceResolved = Number.isFinite(Number(intelCommentaryRaw.intelConfidence))
      ? Number(intelCommentaryRaw.intelConfidence)
      : asNumber((intelSnapshot as Record<string, unknown>).posture && (intelSnapshot as Record<string, unknown>).posture
          ? ((intelSnapshot as Record<string, unknown>).posture as Record<string, unknown>).confidence
          : 0, 0);
    const intelPostureRaw =
      intelSnapshot &&
      typeof intelSnapshot === "object" &&
      (intelSnapshot as Record<string, unknown>).posture &&
      typeof (intelSnapshot as Record<string, unknown>).posture === "object"
        ? ((intelSnapshot as Record<string, unknown>).posture as Record<string, unknown>)
        : {};
    const resolvedIntelPostureState =
      hardRisk.state === "HALT" ? "HALT" : String(intelPostureRaw.state || "NORMAL");
    const resolvedIntelPostureReasons = dedupeStrings([
      ...(Array.isArray(intelPostureRaw.reasons)
        ? intelPostureRaw.reasons.map((row) => String(row))
        : []),
      ...(hardRisk.state === "HALT"
        ? hardRisk.reasons.map((row) => `HARD_RISK_${String(row).toUpperCase().replace(/\s+/g, "_")}`)
        : [])
    ]);
    const intelSnapshotEnriched = {
      ...(intelSnapshot as Record<string, unknown>),
      posture: {
        ...intelPostureRaw,
        state: resolvedIntelPostureState,
        reasons: resolvedIntelPostureReasons
      },
      postureState: resolvedIntelPostureState,
      hardRiskState: hardRisk.state,
      commentary: {
        ...intelCommentaryRaw,
        reasons: dedupeStrings([
          ...(Array.isArray(intelCommentaryRaw.reasons)
            ? intelCommentaryRaw.reasons.map((row) => String(row))
            : []),
          ...(hardRisk.state === "HALT" ? hardRisk.reasons.map((row) => `HARD_RISK: ${row}`) : [])
        ]),
        hardHaltReasons:
          hardRisk.state === "HALT"
            ? dedupeStrings([
                ...(Array.isArray(intelCommentaryRaw.hardHaltReasons)
                  ? intelCommentaryRaw.hardHaltReasons.map((row) => String(row))
                  : []),
                ...hardRisk.reasons
              ])
            : Array.isArray(intelCommentaryRaw.hardHaltReasons)
              ? intelCommentaryRaw.hardHaltReasons.map((row) => String(row))
              : [],
        hardRiskState: hardRisk.state,
        intelConfidence: intelConfidenceResolved,
        providerHealth: intelProviderHealth
      }
    };
    const fills1h = this.store.getFillsSince(oneHourAgo);
    const fills24h = this.store.getFillsSince(now - 24 * 60 * 60 * 1000);
    const lastFillTsRaw = this.store.getRecentFills(1)[0]?.ts;
    const lastFillTs = Number.isFinite(Number(lastFillTsRaw)) ? Number(lastFillTsRaw) : null;

    const edgeStats = summarizeEdgeBps(fills1h);
    const realizedPnlMetric = this.store.getMetrics("realized_pnl_usd", 0, 1)[0];
    const avgEdgeBuyMetric = this.store.getMetrics("avg_edge_bps_buy", oneHourAgo, 1)[0];
    const avgEdgeSellMetric = this.store.getMetrics("avg_edge_bps_sell", oneHourAgo, 1)[0];
    const fills1hMetric = this.store.getMetrics("fills_1h_count", oneHourAgo, 1)[0];
    const fillsLast30mMetric = this.store.getMetrics("fills_last_30m", now - 30 * 60 * 1000, 1)[0];
    const postOnlyRejectsMetric = this.store.getMetrics("post_only_rejects_last_1h", oneHourAgo, 1)[0];
    const cancelsLast1hMetric = this.store.getMetrics("cancels_last_1h", oneHourAgo, 1)[0];
    const avgRestingMetric = this.store.getMetrics("avg_resting_time_seconds", oneHourAgo, 1)[0];
    const revxDegradedMetric = this.store.getMetrics("revx_degraded", now - 5 * 60 * 1000, 1)[0];
    const revxLastDegradedMetric = this.store.getMetrics("revx_last_degraded_ts", 0, 1)[0];
    const latestDecision = this.store.getRecentStrategyDecisions(1)[0];
    const latestDecisionDetails = parseJsonObject(latestDecision?.details_json);
    const latestDecisionQuotePlan = parseJsonObject(latestDecisionDetails.quote_plan);
    const signalState = parseJsonObject(latestDecisionDetails.signal_state);

    const tickerSeries = this.store.getRecentTickerSnapshots(this.config.symbol, tickerLimit);
    const ticker = tickerSeries[0] ?? null;
    const normalizedBalances = normalizeBalancesForSymbol(
      this.config.symbol,
      balances,
      ticker?.mid ?? 0
    );
    const crossVenue = {
      venues: recentExternalPrice,
      signal: latestSignalSnapshot
    };
    const externalQuotes = normalizeExternalQuotesFromCrossVenue(crossVenue);
    const externalQuotesMap = externalQuotesArrayToMap(externalQuotes);
    const latestVenueQuotes = this.store.getLatestVenueQuotes(this.config.symbol);
    const mergedVenueQuotes = mergeVenueQuotes(latestVenueQuotes, externalQuotesMap);
    const quotes = buildNormalizedQuotes({
      ticker,
      mergedVenueQuotes,
      configuredVenues: this.config.externalVenues,
      nowTs: now,
      fairMid:
        asNumber(signalState.fair_mid, latestSignalSnapshot?.fair_mid ?? Number.NaN) > 0
          ? asNumber(signalState.fair_mid, latestSignalSnapshot?.fair_mid ?? Number.NaN)
          : null
    });
    const fairMidForComparisons =
      asNumber(signalState.fair_mid, latestSignalSnapshot?.fair_mid ?? Number.NaN) > 0
        ? asNumber(signalState.fair_mid, latestSignalSnapshot?.fair_mid ?? Number.NaN)
        : quotes.fairMid ?? null;
    const quoteComparisons = buildQuoteComparisons(
      ticker,
      externalQuotesMap,
      now,
      fairMidForComparisons
    );
    const quoteComparisonsSummary = {
      revxMid: ticker && Number.isFinite(ticker.mid) ? ticker.mid : null,
      fairMid: fairMidForComparisons,
      basisBps: asNumber(signalState.basis_bps, latestSignalSnapshot?.basis_bps ?? Number.NaN),
      dispersionBps: asNumber(
        signalState.dispersion_bps,
        latestSignalSnapshot?.dispersion_bps ?? Number.NaN
      ),
      venuesCompared: quoteComparisons.length
    };
    const market = {
      revx: {
        venue: "REVX",
        bid: quotes.revx.bid,
        ask: quotes.revx.ask,
        mid: quotes.revx.mid,
        ts: quotes.revx.ts ?? 0,
        ageMs:
          typeof quotes.revx.ageSeconds === "number" && Number.isFinite(quotes.revx.ageSeconds)
            ? Math.max(0, quotes.revx.ageSeconds * 1000)
            : null,
        error: quotes.revx.error ?? undefined
      },
      venues: quotes.venues.map((row) => ({
        venue: String(row.venue || "").toUpperCase(),
        bid: row.bid,
        ask: row.ask,
        mid: row.mid,
        ts: row.ts ?? 0,
        ageMs:
          typeof row.ageSeconds === "number" && Number.isFinite(row.ageSeconds)
            ? Math.max(0, row.ageSeconds * 1000)
            : null,
        error: row.error ?? undefined
      }))
    };

    const pnlSeries = buildPnlSeries(
      this.config.symbol,
      this.store.getRecentBalanceSnapshots(balanceLimit),
      tickerSeries,
      now - windowMs
    );

    const pnlNow = pnlSeries.length > 0 ? pnlSeries[pnlSeries.length - 1].pnlUsd : 0;
    const pnlMin = pnlSeries.length > 0 ? Math.min(...pnlSeries.map((point) => point.pnlUsd)) : 0;
    const pnlMax = pnlSeries.length > 0 ? Math.max(...pnlSeries.map((point) => point.pnlUsd)) : 0;
    const overridesDisabled = runtimeOverrides ? (runtimeOverrides as Record<string, unknown>).enabled === false : false;
    const overrideSource = String((runtimeOverrides as Record<string, unknown> | null)?.source ?? "").toLowerCase();
    const derivedKillActive = overridesDisabled && overrideSource.includes("dashboard:kill");
    const derivedPauseActive = overridesDisabled && overrideSource.includes("dashboard:pause");
    const killActive = this.killActive || derivedKillActive;
    const pauseActive = this.pauseActive || derivedPauseActive;
    if (!overridesDisabled) {
      this.pauseActive = false;
      this.killActive = false;
    } else {
      this.killActive = killActive;
      this.pauseActive = pauseActive && !killActive;
    }
    const seedState =
      quoteInputsForStatus !== null
        ? computeSeedState(quoteInputsForStatus, {
            lowBtcGateUsd: quoteInputsForStatus.config.lowBtcGateUsd,
            targetBtcNotionalUsd: quoteInputsForStatus.config.targetBtcNotionalUsd,
            minBtcNotionalUsd: asNumber(quoteInputsForStatus.config.minBtcNotionalUsd, 10),
            seedTargetBtcNotionalUsd: asNumber(
              quoteInputsForStatus.config.seedTargetBtcNotionalUsd,
              quoteInputsForStatus.config.targetBtcNotionalUsd
            ),
            maxBtcNotionalUsd:
              Number.isFinite(Number(quoteInputsForStatus.config.maxBtcNotionalUsd)) &&
              Number(quoteInputsForStatus.config.maxBtcNotionalUsd) > 0
                ? Number(quoteInputsForStatus.config.maxBtcNotionalUsd)
                : undefined
          })
        : null;
    const seedMode = String(quotePlanForStatus?.seedMode ?? seedState?.mode ?? "TWO_SIDED");
    const seedReason = String(quotePlanForStatus?.seedReason ?? seedState?.reason ?? "No quote plan yet");
    const seedProgress = quotePlanForStatus?.seedProgress ?? seedState?.progress ?? null;
    const seedStartTs = Math.max(
      0,
      Math.floor(
        asNumber(
          latestDecisionQuotePlan.seed_start_ts,
          asNumber((botStatus as Record<string, unknown>)?.seed_start_ts, 0)
        )
      )
    );
    const seedReposts = Math.max(
      0,
      Math.floor(
        asNumber(
          latestDecisionQuotePlan.seed_reposts,
          asNumber(
            latestDecisionQuotePlan.seed_attempts,
            asNumber(
              (botStatus as Record<string, unknown>)?.seed_reposts,
              asNumber((botStatus as Record<string, unknown>)?.seed_attempts, 0)
            )
          )
        )
      )
    );
    const seedTakerFired =
      Boolean(latestDecisionQuotePlan.seed_taker_fired) ||
      Boolean((botStatus as Record<string, unknown>)?.seed_taker_fired);
    const quotingForSeeding =
      botStatusWithSubmitDiagnostics &&
      typeof (botStatusWithSubmitDiagnostics as Record<string, unknown>).quoting === "object" &&
      (botStatusWithSubmitDiagnostics as Record<string, unknown>).quoting
        ? ((botStatusWithSubmitDiagnostics as Record<string, unknown>).quoting as Record<string, unknown>)
        : null;
    const seedingFromQuoting =
      quotingForSeeding &&
      typeof quotingForSeeding.seeding === "object" &&
      quotingForSeeding.seeding
        ? (quotingForSeeding.seeding as Record<string, unknown>)
        : null;
    const seedingStatus = {
      active: seedMode.toUpperCase() === "SEED_BUY" || seedMode.toUpperCase() === "ACCUMULATE_BTC",
      mode: (
        seedMode.toUpperCase() === "SEED_BUY" || seedMode.toUpperCase() === "ACCUMULATE_BTC"
          ? "ACCUMULATE_BTC"
          : seedMode.toUpperCase() === "REBALANCE"
            ? "REBALANCE"
            : "TWO_SIDED"
      ) as "ACCUMULATE_BTC" | "TWO_SIDED" | "REBALANCE",
      btcNotionalUsd: seedProgress ? asNumber(seedProgress.btcNotionalUsd, 0) : 0,
      targetUsd: seedProgress ? asNumber(seedProgress.targetUsd, 0) : 0,
      lastSeedOrderTs: seedingFromQuoting ? Math.max(0, asNumber(seedingFromQuoting.lastSeedOrderTs, 0)) : 0,
      reason: seedReason
    };
    const performanceSummaries = this.performanceEngine
      ? this.performanceEngine.getStatusSummaries()
      : {
          analysisSummary_1h: buildEmptyAnalysisSummary("1h"),
          analysisSummary_24h: buildEmptyAnalysisSummary("24h")
        };
    const adaptiveStatus = this.performanceEngine
      ? this.performanceEngine.getAdaptiveStatus()
      : buildEmptyAdaptiveStatus();

    return {
      ts: now,
      uptimeSeconds: Math.floor(process.uptime()),
      runId: this.runId,
      symbol: this.config.symbol,
      pnlWindow: windowKey,
      eventLimit,
      mode: {
        dryRun: this.config.dryRun,
        mockMode: this.config.mockMode,
        paused: this.pauseActive,
        kill: this.killActive
      },
      strategy: strategyStatus,
      strategyHealth: strategyStatus,
      hardRiskState: hardRisk.state,
      hardRiskReasons: hardRisk.reasons,
      switchPaths: {
        runtimeBaseDir: this.config.runtimeBaseDir
      },
      diagnostics: {
        cwd: process.cwd(),
        runtimeBaseDir: this.config.runtimeBaseDir,
        orders: {
          ok: Boolean(orderSubmitSnapshot.ok) && !Boolean(orderReconcileSnapshot.lastError),
          lastError:
            orderSubmitSnapshot.lastError && orderSubmitSnapshot.lastError.trim().length > 0
              ? orderSubmitSnapshot.lastError
              : orderReconcileSnapshot.lastError && orderReconcileSnapshot.lastError.trim().length > 0
                ? orderReconcileSnapshot.lastError
              : null,
          reconcileLastError:
            orderReconcileSnapshot.lastError && orderReconcileSnapshot.lastError.trim().length > 0
              ? orderReconcileSnapshot.lastError
              : null,
          lastSubmit: orderSubmitSnapshot.lastSubmit
        },
        signals: {
          ok: Boolean(signalsSnapshot.health.ok),
          lastError: signalsSnapshot.health.lastError ?? null
        },
        intel: {
          ok: intelHealth.providers.some((row) => row.ok),
          lastError: intelHealth.lastError || null
        }
      },
      market,
      quotes,
      fills: {
        lastFillTs,
        fills1h: Math.max(0, Math.floor(fills1hMetric?.value ?? fills1h.length)),
        fills24h: Math.max(0, fills24h.length)
      },
      seeding: seedingStatus,
      inventoryAction: asString(
        (botStatus as Record<string, unknown>)?.inventory_action as string,
        asString((botStatus?.quoting as Record<string, unknown> | undefined)?.inventoryAction as string, "HOLD")
      ),
      bands: {
        floor: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.floor,
          this.config.inventoryFloorBtcNotionalUsd
        ),
        target: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.target,
          this.config.inventoryTargetBtcNotionalUsd
        ),
        cap: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.cap,
          this.config.inventoryCapBtcNotionalUsd
        ),
        hysteresis: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.hysteresis,
          5
        )
      },
      phaseAwareCaps: {
        maxSellUsdPerHour: asNumber(
          ((botStatus as Record<string, unknown>)?.phase_aware_caps as Record<string, unknown> | undefined)?.maxSellUsdPerHour,
          this.config.phaseAwareMaxSellUsdPerHour
        ),
        seedBuyUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.phase_aware_caps as Record<string, unknown> | undefined)?.seedBuyUsd,
          this.config.seedBuyUsd
        )
      },
      ticker,
      externalQuotes,
      externalQuotesCount: externalQuotes.length,
      quoteComparisons,
      quoteComparisonsSummary,
      balances,
      normalizedBalances,
      activeBotOrders,
      activeBotOrdersAll,
      activeBotOrdersSummary,
      recentBotOrders,
      recentFills,
      recentEvents,
      overrides: runtimeOverrides,
      runtimeOverrides: runtimeOverridesStatus,
      whyNotQuoting:
        botStatusWithSubmitDiagnostics.quoting &&
        typeof botStatusWithSubmitDiagnostics.quoting.whyNotQuoting === "string"
          ? botStatusWithSubmitDiagnostics.quoting.whyNotQuoting
          : null,
      effectiveConfig: {
        ...effectiveConfig,
        makerFeeBps: this.config.makerFeeBps,
        takerFeeBps: this.config.takerFeeBps,
        takerSlipBps: this.config.takerSlipBps,
        takerSafetyBps: this.config.takerSafetyBps,
        minRealizedEdgeBps: this.config.minRealizedEdgeBps,
        minTakerEdgeBps: this.config.minTakerEdgeBps,
        enableAdverseSelectionLoop: this.config.enableAdverseSelectionLoop,
        asHorizonSeconds: this.config.asHorizonSeconds,
        asSampleFills: this.config.asSampleFills,
        asBadAvgBps: this.config.asBadAvgBps,
        asBadRate: this.config.asBadRate,
        asBadFillBps: this.config.asBadFillBps,
        asWidenStepBps: this.config.asWidenStepBps,
        asMaxWidenBps: this.config.asMaxWidenBps,
        asDisableTobOnToxic: this.config.asDisableTobOnToxic,
        asCooldownSeconds: this.config.asCooldownSeconds,
        asReduceLevelsOnToxic: this.config.asReduceLevelsOnToxic,
        asLevelsFloor: this.config.asLevelsFloor,
        asDecayBpsPerMin: this.config.asDecayBpsPerMin,
        signalRefreshMs: this.config.signalRefreshMs,
        signalMaxQuoteAgeMs: this.config.signalMaxQuoteAgeMs,
        signalMinConf: this.config.signalMinConf,
        signalUsdtDegrade: this.config.signalUsdtDegrade,
        signalVenues: this.config.signalVenues,
        adverseEnabled: this.config.adverseEnabled,
        adverseMarkoutWindowsMs: this.config.adverseMarkoutWindowsMs,
        adverseToxicMarkoutBps: this.config.adverseToxicMarkoutBps,
        adverseMinFills: this.config.adverseMinFills,
        adverseDecay: this.config.adverseDecay,
        adverseStateThresholdsCsv: this.config.adverseStateThresholdsCsv,
        adverseMaxSpreadMult: this.config.adverseMaxSpreadMult,
        seedEnabled: this.config.seedEnabled,
        enableTakerSeed: this.config.enableTakerSeed,
        seedTakerMaxUsd: this.config.seedTakerMaxUsd,
        seedTakerMaxSlippageBps: this.config.seedTakerMaxSlippageBps,
        hedgeEnabled: this.config.hedgeEnabled,
        hedgeMaxUsdPerMin: this.config.hedgeMaxUsdPerMin,
        hedgeMaxSlippageBps: this.config.hedgeMaxSlippageBps,
        hedgeOnlyWhenConfident: this.config.hedgeOnlyWhenConfident,
        newsEnabled: this.config.newsEnabled,
        newsRefreshMs: this.config.newsRefreshMs,
        newsMaxItems: this.config.newsMaxItems,
        newsHalfLifeMs: this.config.newsHalfLifeMs,
        newsMinConf: this.config.newsMinConf,
        newsPauseImpact: this.config.newsPauseImpact,
        newsPauseSeconds: this.config.newsPauseSeconds,
        newsSpreadMult: this.config.newsSpreadMult,
        newsSizeCutMult: this.config.newsSizeCutMult,
        newsSourcesRss: this.config.newsSourcesRss,
        newsGdeltQuery: this.config.newsGdeltQuery,
        newsApiEnabled: Boolean(this.config.newsApiKey),
        enableFairPrice: this.config.enableFairPrice,
        fairPriceMinVenues: this.config.fairPriceMinVenues,
        fairPriceMaxStaleMs: this.config.fairPriceMaxStaleMs,
        fairPriceUsdtPenaltyBps: this.config.fairPriceUsdtPenaltyBps,
        enableAdverse: this.config.enableAdverse,
        enableIntel: this.config.enableIntel,
        intelHardHaltOnly: this.config.intelHardHaltOnly,
        enableIntelTradeGuard: this.config.enableIntelTradeGuard,
        intelMaxAction: this.config.intelMaxAction,
        intelCrossvenueAction: this.config.intelCrossvenueAction,
        intelProviderDegradedAction: this.config.intelProviderDegradedAction,
        intelFastPollSeconds: this.config.intelFastPollSeconds,
        intelSlowPollSeconds: this.config.intelSlowPollSeconds,
        intelMaxItems: this.config.intelMaxItems,
        intelDedupeWindowMin: this.config.intelDedupeWindowMin,
        intelDedupeWindowSeconds: this.config.intelDedupeWindowSeconds,
        intelItemTtlSeconds: this.config.intelItemTtlSeconds,
        intelStaleSeconds: this.config.intelStaleSeconds,
        intelProviderMinOk: this.config.intelProviderMinOk,
        intelSoftPauseImpact: this.config.intelSoftPauseImpact,
        intelSoftPauseConf: this.config.intelSoftPauseConf,
        intelHardHaltImpact: this.config.intelHardHaltImpact,
        intelAlwaysOn: this.config.intelAlwaysOn,
        intelMinQuoteLevels: this.config.intelMinQuoteLevels,
        intelMinSizeMult: this.config.intelMinSizeMult,
        intelMaxSpreadMult: this.config.intelMaxSpreadMult,
        intelHeadlineMaxAgeSeconds: this.config.intelHeadlineMaxAgeSeconds,
        intelAnomalyMaxAgeSeconds: this.config.intelAnomalyMaxAgeSeconds,
        intelEventCooldownSeconds: this.config.intelEventCooldownSeconds,
        intelMaxHighImpactPerMinute: this.config.intelMaxHighImpactPerMinute,
        enableGdelt: this.config.enableGdelt,
        enableRss: this.config.enableRss,
        enableCryptopanic: this.config.enableCryptopanic,
        enableNewsapi: this.config.enableNewsapi,
        enableX: this.config.enableX,
        gdeltQuery: this.config.gdeltQuery,
        gdeltMaxArticles: this.config.gdeltMaxArticles,
        rssUrls: this.config.rssUrls,
        xQuery: this.config.xQuery,
        xMaxResultsPerPoll: this.config.xMaxResultsPerPoll,
        intelMaxWidenBps: this.config.intelMaxWidenBps,
        intelMaxSizeCut: this.config.intelMaxSizeCut,
        intelMaxSkewBps: this.config.intelMaxSkewBps,
        intelHaltImpact: this.config.intelHaltImpact,
        intelHaltSeconds: this.config.intelHaltSeconds,
        intelDecayMinutes: this.config.intelDecayMinutes,
        shockEnterBps: this.config.shockEnterBps,
        shockSpreadBps: this.config.shockSpreadBps,
        shockDispersionBps: this.config.shockDispersionBps,
        shockMinSeconds: this.config.shockMinSeconds,
        reentryNoNewLowSeconds: this.config.reentryNoNewLowSeconds,
        recoveryDispersionBps: this.config.recoveryDispersionBps,
        recoveryPersistSeconds: this.config.recoveryPersistSeconds,
        inventoryFloorBtcNotionalUsd: this.config.inventoryFloorBtcNotionalUsd,
        inventoryTargetBtcNotionalUsd: this.config.inventoryTargetBtcNotionalUsd,
        inventoryCapBtcNotionalUsd: this.config.inventoryCapBtcNotionalUsd,
        phaseAwareMaxSellUsdPerHour: this.config.phaseAwareMaxSellUsdPerHour,
        enableTakerReentry: this.config.enableTakerReentry,
        maxTakerReentryUsdPerHour: this.config.maxTakerReentryUsdPerHour,
        reentryMinEdgeOverFeesBps: this.config.reentryMinEdgeOverFeesBps,
        volWidenInCalm: this.config.volWidenInCalm,
        volWidenMultCalm: this.config.volWidenMultCalm,
        uiShowDiagnosticsDrawer: this.config.uiShowDiagnosticsDrawer,
        uiDiagnosticsDefaultOpen: this.config.uiDiagnosticsDefaultOpen,
        uiHeaderMaxRows: this.config.uiHeaderMaxRows,
        signalsEnabled: this.config.signalsEnabled,
        signalsNewsRefreshMs: this.config.signalsNewsRefreshMs,
        signalsMacroEnabled: this.config.signalsMacroEnabled,
        signalsMacroRefreshMs: this.config.signalsMacroRefreshMs,
        signalsSystemRefreshMs: this.config.signalsSystemRefreshMs,
        signalsMaxItems: this.config.signalsMaxItems,
        signalsHalfLifeMs: this.config.signalsHalfLifeMs,
        signalsMinConf: this.config.signalsMinConf,
        signalsPauseImpact: this.config.signalsPauseImpact,
        signalsPauseSeconds: this.config.signalsPauseSeconds,
        signalsSpreadMult: this.config.signalsSpreadMult,
        signalsSizeCutMult: this.config.signalsSizeCutMult,
        signalsRssUrls: this.config.signalsRssUrls,
        signalsGdeltQuery: this.config.signalsGdeltQuery,
        signalsMacroUrl: this.config.signalsMacroUrl,
        signalsLlmEnabled: this.config.signalsLlmEnabled,
        signalsLlmConfigured: Boolean(this.config.openAiApiKey),
        pendingStaleSeconds: this.config.pendingStaleSeconds,
        performanceEnabled: this.config.performanceEnabled,
        adaptiveControllerEnabled: this.config.adaptiveControllerEnabled,
        adaptiveControllerIntervalSeconds: this.config.adaptiveControllerIntervalSeconds,
        adaptiveFillsPerHourMin: this.config.adaptiveFillsPerHourMin,
        adaptiveToxicPctMax: this.config.adaptiveToxicPctMax,
        adaptiveAvgToxBpsMin: this.config.adaptiveAvgToxBpsMin,
        adaptiveNetPnlStopLoss24h: this.config.adaptiveNetPnlStopLoss24h
      },
      botStatus: botStatusWithSubmitDiagnostics,
      analytics: {
        trendMoveBps: botStatusWithSubmitDiagnostics?.trend_move_bps ?? null,
        realizedPnlUsd: realizedPnlMetric?.value ?? 0,
        edgeBpsLastFill: edgeStats.lastEdgeBps,
        avgEdgeBps1hBuy: avgEdgeBuyMetric?.value ?? 0,
        avgEdgeBps1hSell: avgEdgeSellMetric?.value ?? 0,
        fills1hCount: fills1hMetric?.value ?? fills1h.length,
        fillsLast1h: fills1hMetric?.value ?? fills1h.length,
        fillsLast30m: fillsLast30mMetric?.value ?? this.store.getFillsSince(now - 30 * 60 * 1000).length,
        postOnlyRejectsLast1h: postOnlyRejectsMetric?.value ?? 0,
        cancelsLast1h: cancelsLast1hMetric?.value ?? 0,
        avgRestingTimeSeconds: avgRestingMetric?.value ?? 0,
        signalVolRegime: asString(signalState.vol_regime, "normal"),
        signalRegime: asString(
          asString(
            signalState.regime,
            (botStatusWithSubmitDiagnostics as Record<string, unknown>)?.signal_regime as string
          ),
          "CALM"
        ),
        signalBias: asString(
          asString(
            signalState.bias,
            (botStatusWithSubmitDiagnostics as Record<string, unknown>)?.signal_bias as string
          ),
          "NEUTRAL"
        ),
        signalBiasConfidence: asNumber(
          signalState.bias_confidence,
          asNumber(
            (botStatusWithSubmitDiagnostics as Record<string, unknown>)?.signal_bias_confidence,
            0
          )
        ),
        signalDriftBps: asNumber(signalState.drift_bps, 0),
        driftBps: asNumber(signalState.drift_bps, 0),
        signalZScore: asNumber(signalState.z_score, 0),
        signalStdevBps: asNumber(signalState.stdev_bps, 0),
        signalSkewBpsApplied: asNumber(latestDecisionDetails.signal_skew_bps_applied, 0),
        signalConfidence: asNumber(signalState.confidence, 0),
        signalGlobalMid: asNumber(signalState.global_mid, latestSignalSnapshot?.global_mid ?? 0),
        signalFairMid: asNumber(signalState.fair_mid, latestSignalSnapshot?.fair_mid ?? 0),
        signalBasisBps: asNumber(signalState.basis_bps, latestSignalSnapshot?.basis_bps ?? 0),
        signalDispersionBps: asNumber(
          signalState.dispersion_bps,
          latestSignalSnapshot?.dispersion_bps ?? 0
        ),
        effectiveHalfSpreadBps: asNumber(
          latestDecisionDetails.effective_half_spread_bps_after_adaptive,
          asNumber(latestDecisionDetails.effective_half_spread_bps, 0)
        ),
        adaptiveSpreadDeltaBps: asNumber(latestDecisionDetails.adaptive_spread_bps_delta, 0),
        adaptiveAdjustments: Array.isArray(latestDecisionDetails.adaptive_adjustments_applied)
          ? latestDecisionDetails.adaptive_adjustments_applied
          : [],
        targetFillsPerHour: this.config.targetFillsPerHour,
        actionBudgetUsed: asNumber(botStatus?.action_budget_used, 0),
        actionBudgetMax: asNumber(botStatus?.action_budget_max, this.config.maxActionsPerLoop),
        churnWarning: Boolean(botStatus?.churn_warning),
        seedMode,
        seedReason,
        seedBtcNotionalUsd: seedProgress ? asNumber(seedProgress.btcNotionalUsd, 0) : 0,
        seedLowGateUsd: seedProgress ? asNumber(seedProgress.lowGateUsd, 0) : 0,
        seedTargetUsd: seedProgress ? asNumber(seedProgress.targetUsd, 0) : 0,
        seedStartTs,
        seedReposts,
        seedAttempts: seedReposts,
        seedTakerFired,
        seedLastOrderTs: seedingStatus.lastSeedOrderTs,
        marketPhase: asString(
          (botStatus as Record<string, unknown>)?.market_phase as string,
          asString(
            (botStatus as Record<string, unknown>)?.quoting &&
              typeof (botStatus as Record<string, unknown>)?.quoting === "object"
              ? ((botStatus as Record<string, unknown>).quoting as Record<string, unknown>).marketPhase as string
              : undefined,
            "STABILIZING"
          )
        ),
        phaseReasons: Array.isArray((botStatus as Record<string, unknown>)?.phase_reasons)
          ? ((botStatus as Record<string, unknown>)?.phase_reasons as unknown[])
              .map((row) => String(row || "").trim())
              .filter((row) => row.length > 0)
              .slice(0, 8)
          : botStatus?.quoting && Array.isArray((botStatus.quoting as Record<string, unknown>).phaseReasons)
            ? ((botStatus.quoting as Record<string, unknown>).phaseReasons as unknown[])
                .map((row) => String(row || "").trim())
                .filter((row) => row.length > 0)
                .slice(0, 8)
            : [],
        phaseSinceTs: asNumber(
          (botStatus as Record<string, unknown>)?.phase_since_ts,
          asNumber((botStatus?.quoting as Record<string, unknown> | undefined)?.phaseSinceTs, 0)
        ),
      shockVolPeakBps: asNumber(
        (botStatus as Record<string, unknown>)?.shock_vol_peak_bps,
        asNumber((botStatus?.quoting as Record<string, unknown> | undefined)?.shockVolPeakBps, 0)
      ),
      inventoryAction: asString(
        (botStatus as Record<string, unknown>)?.inventory_action as string,
        asString((botStatus?.quoting as Record<string, unknown> | undefined)?.inventoryAction as string, "HOLD")
      ),
      bands: {
        floor: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.floor,
          this.config.inventoryFloorBtcNotionalUsd
        ),
        target: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.target,
          this.config.inventoryTargetBtcNotionalUsd
        ),
        cap: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.cap,
          this.config.inventoryCapBtcNotionalUsd
        ),
        hysteresis: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.hysteresis,
          5
        )
      },
      phaseAwareCaps: {
        maxSellUsdPerHour: asNumber(
          ((botStatus as Record<string, unknown>)?.phase_aware_caps as Record<string, unknown> | undefined)?.maxSellUsdPerHour,
          this.config.phaseAwareMaxSellUsdPerHour
        ),
        seedBuyUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.phase_aware_caps as Record<string, unknown> | undefined)?.seedBuyUsd,
          this.config.seedBuyUsd
        )
      },
      shockState: asString(
        (botStatus as Record<string, unknown>)?.shock_state as string,
        asString(botStatus?.quoting?.shockState as string, "NORMAL")
        ),
        shockReasons: Array.isArray((botStatus as Record<string, unknown>)?.shock_reasons)
          ? ((botStatus as Record<string, unknown>)?.shock_reasons as unknown[])
              .map((row) => String(row || "").trim())
              .filter((row) => row.length > 0)
              .slice(0, 8)
          : botStatus?.quoting && Array.isArray(botStatus.quoting.shockReasons)
            ? botStatus.quoting.shockReasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0).slice(0, 8)
            : [],
        shockSinceTs: asNumber(
          (botStatus as Record<string, unknown>)?.shock_since_ts,
          asNumber(botStatus?.quoting?.shockSinceTs, 0)
        ),
        reentryBtcNotionalUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.btcNotionalUsd,
          asNumber(botStatus?.quoting?.reentryProgress?.btcNotionalUsd, 0)
        ),
        inventoryFloorBtcNotionalUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.floor,
          asNumber(this.config.inventoryFloorBtcNotionalUsd, 20)
        ),
        inventoryTargetBtcNotionalUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.target,
          asNumber(this.config.inventoryTargetBtcNotionalUsd, 80)
        ),
        inventoryCapBtcNotionalUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.cap,
          asNumber(this.config.inventoryCapBtcNotionalUsd, 160)
        ),
        inventoryHysteresisUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.inventory_bands as Record<string, unknown> | undefined)?.hysteresis,
          5
        ),
        phaseAwareMaxSellUsdPerHour: asNumber(
          ((botStatus as Record<string, unknown>)?.phase_aware_caps as Record<string, unknown> | undefined)?.maxSellUsdPerHour,
          asNumber(this.config.phaseAwareMaxSellUsdPerHour, 30)
        ),
        phaseAwareSeedBuyUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.phase_aware_caps as Record<string, unknown> | undefined)?.seedBuyUsd,
          asNumber(this.config.seedBuyUsd, 0)
        ),
        reentryTargetUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.targetUsd,
          asNumber(botStatus?.quoting?.reentryProgress?.targetUsd, 0)
        ),
        reentrySeedOrdersPlaced: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.seedOrdersPlaced,
          asNumber(botStatus?.quoting?.reentryProgress?.seedOrdersPlaced, 0)
        ),
        reentryLastSeedTs: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.lastSeedTs,
          asNumber(botStatus?.quoting?.reentryProgress?.lastSeedTs, 0)
        ),
        errorPolicyRecoverableCount5m: asNumber(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.recoverableCount5m,
          asNumber(botStatus?.quoting?.errorPolicy?.recoverableCount5m, 0)
        ),
        errorPolicyLastRecoverableError: asString(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.lastRecoverableError as string,
          asString(botStatus?.quoting?.errorPolicy?.lastRecoverableError as string, "")
        ),
        errorPolicyTransientBackoffMs: asNumber(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.transientBackoffMs,
          asNumber(botStatus?.quoting?.errorPolicy?.transientBackoffMs, 0)
        ),
        errorPolicyHardHalt: Boolean(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.hardHalt ||
          botStatus?.quoting?.errorPolicy?.hardHalt
        ),
        adverseSelectionAvgBps: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_selection_avg_bps,
          0
        ),
        adverseSelectionBadRate: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_selection_bad_rate,
          0
        ),
        adverseSelectionLastBps: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_selection_last_bps,
          0
        ),
        adverseSelectionSamples: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_selection_samples,
          0
        ),
        adverseSelectionToxic: Boolean(
          (botStatus as Record<string, unknown>)?.adverse_selection_toxic
        ),
        adverseSelectionWidenBps: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_selection_widen_bps,
          0
        ),
        adverseSelectionCooldownSeconds: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_selection_cooldown_seconds,
          0
        ),
        adverseSelectionState: asString(
          (botStatus as Record<string, unknown>)?.adverse_state as string,
          asString(latestDecisionQuotePlan.adverse_state, "NORMAL")
        ),
        adverseSelectionToxicityScore: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_toxicity_score,
          asNumber(latestDecisionQuotePlan.adverse_toxicity_score, 0)
        ),
        adverseSelectionSpreadMult: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_spread_mult,
          asNumber(latestDecisionQuotePlan.adverse_spread_mult, 1)
        ),
        newsImpact: asNumber(
          (botStatus as Record<string, unknown>)?.news_impact,
          asNumber(newsSnapshot?.aggregate?.impact, 0)
        ),
        newsDirection: asString(
          (botStatus as Record<string, unknown>)?.news_direction as string,
          asString(newsSnapshot?.aggregate?.direction, "NEUTRAL")
        ),
        newsConfidence: asNumber(
          (botStatus as Record<string, unknown>)?.news_confidence,
          asNumber(newsSnapshot?.aggregate?.confidence, 0)
        ),
        newsState: asString(
          (botStatus as Record<string, unknown>)?.news_state as string,
          "NORMAL"
        ),
        newsLastTs: asNumber(
          (botStatus as Record<string, unknown>)?.news_last_ts,
          asNumber(newsSnapshot?.items?.[0]?.ts, 0)
        ),
        signalsImpact: asNumber(
          (botStatus as Record<string, unknown>)?.signals_impact,
          asNumber(signalsSnapshot.aggregate.impact, 0)
        ),
        signalsDirection: asString(
          (botStatus as Record<string, unknown>)?.signals_direction as string,
          asString(signalsSnapshot.aggregate.direction, "NEUTRAL")
        ),
        signalsConfidence: asNumber(
          (botStatus as Record<string, unknown>)?.signals_confidence,
          asNumber(signalsSnapshot.aggregate.confidence, 0)
        ),
        signalsState: asString(
          (botStatus as Record<string, unknown>)?.signals_state as string,
          asString(signalsSnapshot.aggregate.state, "NORMAL")
        ),
        signalsLastTs: asNumber(
          (botStatus as Record<string, unknown>)?.signals_last_ts,
          asNumber(signalsSnapshot.aggregate.latestTs, 0)
        ),
        intelState: asString(
          (botStatus as Record<string, unknown>)?.intel_state as string,
          asString(intelSnapshot.posture.state, "NORMAL")
        ),
        intelImpact: asNumber(
          (botStatus as Record<string, unknown>)?.intel_impact,
          asNumber(intelSnapshot.posture.impact, 0)
        ),
        intelDirection: asString(
          (botStatus as Record<string, unknown>)?.intel_direction as string,
          asString(intelSnapshot.posture.direction, "NEUTRAL")
        ),
        intelConfidence: asNumber(
          (botStatus as Record<string, unknown>)?.intel_confidence,
          asNumber(intelSnapshot.posture.confidence, 0)
        ),
        intelWidenBps: asNumber(intelSnapshot.posture.widenBps, 0),
        intelSizeCut: asNumber(intelSnapshot.posture.sizeCut, 0),
        intelSkewBps: asNumber(intelSnapshot.posture.skewBps, 0),
        intelHaltUntilTs: asNumber(intelSnapshot.posture.haltUntilTs, 0),
        makerFeeBps: this.config.makerFeeBps,
        takerFeeBps: this.config.takerFeeBps,
        revxDegraded: asNumber(revxDegradedMetric?.value, 0) >= 1,
        revxLastDegradedTs: asNumber(revxLastDegradedMetric?.value, 0),
        hardRiskState: hardRisk.state,
        performanceFillsPerHour1h: performanceSummaries.analysisSummary_1h.fillsPerHour,
        performanceAvgEdgeBps1h: performanceSummaries.analysisSummary_1h.avgEdgeBps,
        performanceToxicPct1h: performanceSummaries.analysisSummary_1h.toxicPct30s,
        performanceNetPnl24h: performanceSummaries.analysisSummary_24h.netPnlUsd,
        adaptiveMode: adaptiveStatus.enabled
          ? adaptiveStatus.lastDecision?.action ?? "ENABLED"
          : "DISABLED"
      },
      shockState: asString(
        (botStatus as Record<string, unknown>)?.shock_state as string,
        asString(botStatus?.quoting?.shockState as string, "NORMAL")
      ),
      marketPhase: asString(
        (botStatus as Record<string, unknown>)?.market_phase as string,
        asString((botStatus?.quoting as Record<string, unknown> | undefined)?.marketPhase as string, "STABILIZING")
      ),
      phaseReasons: Array.isArray((botStatus as Record<string, unknown>)?.phase_reasons)
        ? ((botStatus as Record<string, unknown>)?.phase_reasons as unknown[])
            .map((row) => String(row || "").trim())
            .filter((row) => row.length > 0)
            .slice(0, 8)
        : Array.isArray((botStatus?.quoting as Record<string, unknown> | undefined)?.phaseReasons)
          ? ((botStatus?.quoting as Record<string, unknown>).phaseReasons as unknown[])
              .map((row) => String(row || "").trim())
              .filter((row) => row.length > 0)
              .slice(0, 8)
          : [],
      phaseSinceTs: asNumber(
        (botStatus as Record<string, unknown>)?.phase_since_ts,
        asNumber((botStatus?.quoting as Record<string, unknown> | undefined)?.phaseSinceTs, 0)
      ),
      shockVolPeakBps: asNumber(
        (botStatus as Record<string, unknown>)?.shock_vol_peak_bps,
        asNumber((botStatus?.quoting as Record<string, unknown> | undefined)?.shockVolPeakBps, 0)
      ),
      shockReasons: Array.isArray((botStatus as Record<string, unknown>)?.shock_reasons)
        ? ((botStatus as Record<string, unknown>)?.shock_reasons as unknown[])
            .map((row) => String(row || "").trim())
            .filter((row) => row.length > 0)
            .slice(0, 8)
        : Array.isArray(botStatus?.quoting?.shockReasons)
          ? botStatus.quoting.shockReasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0).slice(0, 8)
        : [],
      shockSinceTs: asNumber((botStatus as Record<string, unknown>)?.shock_since_ts, asNumber(botStatus?.quoting?.shockSinceTs, 0)),
      reentryProgress: {
        btcNotionalUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.btcNotionalUsd,
          asNumber(botStatus?.quoting?.reentryProgress?.btcNotionalUsd, 0)
        ),
        targetUsd: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.targetUsd,
          asNumber(botStatus?.quoting?.reentryProgress?.targetUsd, 0)
        ),
        seedOrdersPlaced: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.seedOrdersPlaced,
          asNumber(botStatus?.quoting?.reentryProgress?.seedOrdersPlaced, 0)
        ),
        lastSeedTs: asNumber(
          ((botStatus as Record<string, unknown>)?.reentry_progress as Record<string, unknown> | undefined)?.lastSeedTs,
          asNumber(botStatus?.quoting?.reentryProgress?.lastSeedTs, 0)
        )
      },
      errorPolicy: {
        recoverableCount5m: asNumber(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.recoverableCount5m,
          asNumber(botStatus?.quoting?.errorPolicy?.recoverableCount5m, 0)
        ),
        lastRecoverableError: asString(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.lastRecoverableError as string,
          asString(botStatus?.quoting?.errorPolicy?.lastRecoverableError as string, "")
        ),
        transientBackoffMs: asNumber(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.transientBackoffMs,
          asNumber(botStatus?.quoting?.errorPolicy?.transientBackoffMs, 0)
        ),
        hardHalt: Boolean(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.hardHalt ||
          botStatus?.quoting?.errorPolicy?.hardHalt
        ),
        hardHaltReason: asString(
          ((botStatus as Record<string, unknown>)?.error_policy as Record<string, unknown> | undefined)?.hardHaltReason as string,
          asString(botStatus?.quoting?.errorPolicy?.hardHaltReason as string, "")
        )
      },
      signals: {
        state: asString(signalsSnapshot.aggregate.state, "NORMAL"),
        impact: asNumber(signalsSnapshot.aggregate.impact, 0),
        direction: asString(signalsSnapshot.aggregate.direction, "NEUTRAL"),
        confidence: asNumber(signalsSnapshot.aggregate.confidence, 0),
        latestTs: asNumber(signalsSnapshot.aggregate.latestTs, 0),
        counts: signalsSnapshot.aggregate.counts ?? {}
      },
      intelSnapshot: intelSnapshotEnriched,
      intelHealth,
      fairPrice: {
        globalMid: asNumber(
          latestSignalSnapshot?.global_mid,
          asNumber((botStatus as Record<string, unknown>)?.signal_global_mid, 0)
        ),
        fairMid: asNumber(
          latestSignalSnapshot?.fair_mid,
          asNumber((botStatus as Record<string, unknown>)?.fair_mid, 0)
        ),
        basisBps: asNumber(
          latestSignalSnapshot?.basis_bps,
          asNumber((botStatus as Record<string, unknown>)?.basis_bps, 0)
        ),
        dispersionBps: asNumber(
          latestSignalSnapshot?.dispersion_bps,
          asNumber((botStatus as Record<string, unknown>)?.dispersion_bps, 0)
        ),
        confidence: asNumber(
          latestSignalSnapshot?.confidence,
          asNumber((botStatus as Record<string, unknown>)?.cross_venue_confidence, 0)
        )
      },
      adverse: {
        state: asString(
          (botStatus as Record<string, unknown>)?.adverse_state as string,
          asString(latestDecisionQuotePlan.adverse_state, "NORMAL")
        ),
        avgMarkoutBpsBuy: asNumber(
          ((latestDecisionDetails as Record<string, unknown>)?.adverse_selection as Record<string, unknown> | undefined)?.avg_bps,
          asNumber((botStatus as Record<string, unknown>)?.adverse_selection_avg_bps, 0)
        ),
        avgMarkoutBpsSell: asNumber(
          ((latestDecisionDetails as Record<string, unknown>)?.adverse_selection as Record<string, unknown> | undefined)?.avg_bps,
          asNumber((botStatus as Record<string, unknown>)?.adverse_selection_avg_bps, 0)
        ),
        toxicScore: asNumber(
          (botStatus as Record<string, unknown>)?.adverse_toxicity_score,
          asNumber(latestDecisionQuotePlan.adverse_toxicity_score, 0)
        ),
        toxic: Boolean((botStatus as Record<string, unknown>)?.adverse_selection_toxic)
      },
      news: {
        aggregate: newsSnapshot?.aggregate ?? {
          impact: 0,
          direction: "NEUTRAL",
          confidence: 0,
          categoryCounts: {
            macro: 0,
            war: 0,
            rates: 0,
            crypto: 0,
            regulation: 0,
            exchange: 0,
            outage: 0,
            other: 0
          }
        },
        latestHeadlineTs: asNumber(newsSnapshot?.items?.[0]?.ts, 0),
        ts: asNumber(newsSnapshot?.ts, 0),
        lastError: newsSnapshot?.lastError ?? null
      },
      crossVenue,
      analysisSummary_1h: performanceSummaries.analysisSummary_1h,
      analysisSummary_24h: performanceSummaries.analysisSummary_24h,
      adaptiveStatus,
      pnlSeries,
      pnlSummary: {
        pnlUsd: pnlNow,
        minPnlUsd: pnlMin,
        maxPnlUsd: pnlMax
      }
    };
  }

  private async handleCancelAllAction(res: ServerResponse): Promise<void> {
    if (!this.actions) {
      writeJson(res, 501, { ok: false, message: "cancel-all action unavailable" });
      return;
    }

    try {
      await this.actions.cancelAllBotOrders();
      writeJson(res, 200, { ok: true });
    } catch (error) {
      this.logger.error({ error }, "Dashboard cancel-all action failed");
      writeJson(res, 500, { ok: false, message: "cancel-all failed" });
    }
  }

  private async handlePauseAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readRequestBody(req);
      const symbol = normalizeSymbolParam(asOptionalString(body.symbol), this.config.symbol);
      const requested = parseBoolean(body.paused);
      const nextPaused = requested === null ? !this.pauseActive : requested;
      if (nextPaused) {
        this.store.setRuntimeOverrides(
          symbol,
          { enabled: false },
          {
            source: "dashboard:pause",
            note: "Pause action from header"
          }
        );
        this.pauseActive = true;
      } else {
        this.store.setRuntimeOverrides(
          symbol,
          { enabled: true },
          {
            source: "dashboard:pause",
            note: "Resume action from header"
          }
        );
        this.pauseActive = false;
        this.killActive = false;
      }
      writeJson(res, 200, { ok: true, paused: this.pauseActive, kill: this.killActive });
    } catch (error) {
      this.logger.error({ error }, "Dashboard pause action failed");
      writeJson(res, 500, { ok: false, message: "pause action failed" });
    }
  }

  private async handleKillAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readRequestBody(req);
      const symbol = normalizeSymbolParam(asOptionalString(body.symbol), this.config.symbol);
      this.store.setRuntimeOverrides(
        symbol,
        { enabled: false },
        {
          source: "dashboard:kill",
          note: "Kill action from header"
        }
      );
      this.killActive = true;
      this.pauseActive = false;
      if (this.actions) {
        await this.actions.cancelAllBotOrders();
      }
      writeJson(res, 200, { ok: true, paused: this.pauseActive, kill: this.killActive });
    } catch (error) {
      this.logger.error({ error }, "Dashboard kill action failed");
      writeJson(res, 500, { ok: false, message: "kill action failed" });
    }
  }

  private async handleSetOverridesAction(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await readRequestBody(req);
      const symbol = normalizeSymbolParam(asOptionalString(body.symbol), this.config.symbol);
      const rawPatch = body.patch;
      if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
        writeJson(res, 400, { ok: false, message: "body.patch must be an object" });
        return;
      }
      const patch = coerceOverridesPatch(rawPatch as Record<string, unknown>);
      if (Object.keys(patch).length === 0) {
        writeJson(res, 400, { ok: false, message: "No valid override fields in patch" });
        return;
      }
      const note = asOptionalString(body.note) ?? "";
      const overrides = this.store.setRuntimeOverrides(symbol, patch, {
        source: "dashboard",
        note
      });
      const effectiveConfig = this.store.getEffectiveConfig(symbol);
      const warnings: string[] = [];
      const appliedDiff = Object.entries(patch).map(([key, requested]) => {
        const applied = (overrides as Record<string, unknown>)[key];
        const adjusted =
          typeof requested === "number" && typeof applied === "number"
            ? Math.abs(requested - applied) > 1e-9
            : requested !== applied;
        return { key, requested, applied, adjusted };
      });
      for (const [key, requested] of Object.entries(patch)) {
        const applied = (overrides as Record<string, unknown>)[key];
        if (applied === undefined) continue;
        if (typeof requested === "number" && typeof applied === "number") {
          if (Math.abs(requested - applied) > 1e-9) {
            warnings.push(`${key} adjusted to ${String(applied)}`);
          }
          continue;
        }
        if (requested !== applied) {
          warnings.push(`${key} adjusted to ${String(applied)}`);
        }
      }
      this.logger.info(
        { symbol, patchKeys: Object.keys(patch), noteLength: note.length },
        "Runtime overrides updated"
      );
      writeJson(res, 200, {
        ok: true,
        symbol,
        overrides,
        effectiveConfig,
        warnings,
        appliedDiff
      });
    } catch (error) {
      this.logger.error({ error }, "Dashboard set-overrides action failed");
      writeJson(res, 500, { ok: false, message: "set overrides failed" });
    }
  }

  private async handleClearOverridesAction(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await readRequestBody(req);
      const symbol = normalizeSymbolParam(asOptionalString(body.symbol), this.config.symbol);
      const note = asOptionalString(body.note) ?? "";
      this.store.clearRuntimeOverrides(symbol, {
        source: "dashboard",
        note
      });
      const effectiveConfig = this.store.getEffectiveConfig(symbol);
      this.logger.info({ symbol }, "Runtime overrides cleared");
      writeJson(res, 200, {
        ok: true,
        symbol,
        overrides: null,
        effectiveConfig
      });
    } catch (error) {
      this.logger.error({ error }, "Dashboard clear-overrides action failed");
      writeJson(res, 500, { ok: false, message: "clear overrides failed" });
    }
  }
}

type PnlPoint = {
  ts: number;
  equityUsd: number;
  pnlUsd: number;
  mid: number;
};

function buildPnlSeries(
  symbol: string,
  balances: BalanceSnapshot[],
  tickerSeries: TickerSnapshot[],
  cutoffTs: number
): PnlPoint[] {
  if (balances.length === 0 || tickerSeries.length === 0) {
    return [];
  }

  const [baseAsset, quoteAsset] = splitSymbol(symbol);
  const groupedSnapshots = groupBalanceSnapshotsByTs(balances).filter((row) => row.ts >= cutoffTs);
  const tickersAsc = [...tickerSeries].sort((a, b) => a.ts - b.ts);

  if (groupedSnapshots.length === 0 || tickersAsc.length === 0) {
    return [];
  }

  let tickerIndex = 0;
  let lastMid = Number.NaN;
  const points: PnlPoint[] = [];

  for (const snapshot of groupedSnapshots) {
    while (tickerIndex < tickersAsc.length && tickersAsc[tickerIndex].ts <= snapshot.ts) {
      lastMid = tickersAsc[tickerIndex].mid;
      tickerIndex += 1;
    }

    if (!Number.isFinite(lastMid) || lastMid <= 0) {
      lastMid = tickersAsc[Math.min(tickerIndex, tickersAsc.length - 1)].mid;
    }

    if (!Number.isFinite(lastMid) || lastMid <= 0) {
      continue;
    }

    const baseBalance = snapshot.assets.get(baseAsset)?.total ?? 0;
    const quoteBalance = snapshot.assets.get(quoteAsset)?.total ?? 0;
    const equityUsd = quoteBalance + baseBalance * lastMid;

    points.push({
      ts: snapshot.ts,
      equityUsd,
      pnlUsd: 0,
      mid: lastMid
    });
  }

  if (points.length === 0) {
    return [];
  }

  const baseline = points[0].equityUsd;
  for (const point of points) {
    point.pnlUsd = point.equityUsd - baseline;
  }

  return downsamplePoints(points, 280);
}

function groupBalanceSnapshotsByTs(
  balances: BalanceSnapshot[]
): Array<{ ts: number; assets: Map<string, BalanceSnapshot> }> {
  const grouped = new Map<number, Map<string, BalanceSnapshot>>();

  for (const row of balances) {
    const ts = row.ts;
    if (!grouped.has(ts)) {
      grouped.set(ts, new Map<string, BalanceSnapshot>());
    }
    grouped.get(ts)?.set(row.asset.toUpperCase(), row);
  }

  return Array.from(grouped.entries())
    .map(([ts, assets]) => ({ ts, assets }))
    .sort((a, b) => a.ts - b.ts);
}

function downsamplePoints(points: PnlPoint[], maxPoints: number): PnlPoint[] {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.ceil(points.length / maxPoints);
  const sampled = points.filter((_, idx) => idx % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }
  return sampled;
}

function summarizeEdgeBps(
  fills: Array<{ edge_bps?: number | null; ts: number }>
): { lastEdgeBps: number | null } {
  if (!Array.isArray(fills) || fills.length === 0) {
    return { lastEdgeBps: null };
  }
  const sorted = [...fills].sort((a, b) => b.ts - a.ts);
  for (const fill of sorted) {
    if (typeof fill.edge_bps === "number" && Number.isFinite(fill.edge_bps)) {
      return { lastEdgeBps: fill.edge_bps };
    }
  }
  return { lastEdgeBps: null };
}

function classifyOrderEventType(status: string | null | undefined): DashboardEventType {
  const value = String(status ?? "").toUpperCase();
  if (value.includes("REPLACED")) return "REPLACED";
  if (value.includes("CANCEL")) return "CANCELLED";
  if (value.includes("FILL")) return "FILLED";
  if (value.includes("REJECT")) return "REJECTED";
  if (value.includes("ERROR") || value.includes("FAIL")) return "ERROR";
  return "PLACED";
}

function buildRecentEvents(
  orders: OrderHistoryRecord[],
  fills: FillRecord[],
  limit: number
): DashboardEvent[] {
  const events: DashboardEvent[] = [];

  for (const order of orders) {
    const type = classifyOrderEventType(order.status);
    const ts = Number(order.ts);
    const venueOrderId = order.venue_order_id ?? null;
    const clientId = order.client_order_id || "-";
    events.push({
      event_id: `order:${ts}:${type}:${venueOrderId ?? "-"}:${clientId}:${order.status}:${order.price}:${order.quote_size}`,
      ts: Number.isFinite(ts) ? ts : 0,
      type,
      side: String(order.side || "-").toUpperCase(),
      price: Number.isFinite(order.price) ? order.price : null,
      size: Number.isFinite(order.quote_size) ? order.quote_size : null,
      reason: String(order.status || ""),
      client_id: clientId,
      client_order_id: clientId,
      venue_order_id: venueOrderId
    });
  }

  for (const fill of fills) {
    const ts = Number(fill.ts);
    const tradeId = String(fill.trade_id || "-");
    events.push({
      event_id: `fill:${tradeId}:${ts}`,
      ts: Number.isFinite(ts) ? ts : 0,
      type: "FILLED",
      side: "-",
      price: Number.isFinite(fill.price) ? fill.price : null,
      size: Number.isFinite(fill.qty) ? fill.qty : null,
      reason: `trade ${tradeId}`,
      client_id: "-",
      client_order_id: "-",
      venue_order_id: fill.venue_order_id || null
    });
  }

  return events
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

function splitSymbol(symbol: string): [string, string] {
  const [base, quote] = symbol.split("-");
  return [base.toUpperCase(), quote.toUpperCase()];
}

function normalizeDashboardBalances(rows: BalanceSnapshot[]): BalanceSnapshot[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => Math.abs(Number(row.free) || 0) > 1e-12 || Math.abs(Number(row.total) || 0) > 1e-12)
    .sort((a, b) => String(a.asset || "").localeCompare(String(b.asset || "")));
}

function extractAssetCodesFromRawBalances(raw: unknown): string[] {
  const detected = new Set<string>();
  const queue: unknown[] = [raw];
  const seen = new Set<unknown>();
  const keys = new Set(["asset", "currency", "symbol", "code", "ccy", "coin"]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (keys.has(String(key).toLowerCase()) && typeof value === "string" && value.trim().length > 0) {
        detected.add(value.trim().toUpperCase());
      }
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return Array.from(detected.values()).sort((a, b) => a.localeCompare(b));
}

function normalizeExternalQuotesFromCrossVenue(crossVenue: unknown): Array<{
  venue: string;
  symbol: string;
  quote: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread_bps: number | null;
  latency_ms: number | null;
  age_ms: number | null;
  ts: number;
  ok: boolean;
  stale: boolean;
  error: string;
}> {
  const nowTs = Date.now();
  const rawVenues = (crossVenue as { venues?: unknown } | null)?.venues;
  const venues = Array.isArray(rawVenues)
    ? (rawVenues as unknown[])
    : rawVenues && typeof rawVenues === "object"
      ? Object.values(rawVenues as Record<string, unknown>)
      : [];
  const mapped = venues.map((venueRaw) => {
    const row = venueRaw && typeof venueRaw === "object" ? (venueRaw as Record<string, unknown>) : {};
    const bidRaw = Number(row.bid);
    const askRaw = Number(row.ask);
    const midRaw = Number(row.mid);
    const computedMid =
      Number.isFinite(midRaw) && midRaw > 0
        ? midRaw
        : Number.isFinite(bidRaw) && bidRaw > 0 && Number.isFinite(askRaw) && askRaw > 0
          ? (bidRaw + askRaw) / 2
          : null;
    const ts = Number.isFinite(Number(row.ts)) ? Number(row.ts) : 0;
    const ageMs = ts > 0 ? Math.max(0, nowTs - ts) : null;
    const staleFromRow = row.stale === true;
    const staleByAge = ageMs !== null ? ageMs > 15_000 : true;
    const ok = row.ok !== false && !staleFromRow && !staleByAge && computedMid !== null;
    return {
      venue: String(row.venue ?? "unknown"),
      symbol: String(row.symbol ?? ""),
      quote: String(row.quote ?? ""),
      bid: Number.isFinite(bidRaw) ? bidRaw : null,
      ask: Number.isFinite(askRaw) ? askRaw : null,
      mid: computedMid,
      spread_bps: Number.isFinite(Number(row.spread_bps)) ? Number(row.spread_bps) : null,
      latency_ms: Number.isFinite(Number(row.latency_ms)) ? Number(row.latency_ms) : null,
      age_ms: ageMs,
      ts,
      ok,
      stale: staleFromRow || staleByAge || row.ok === false,
      error: row.error ? String(row.error) : ""
    };
  });
  const latestByVenue = new Map<string, (typeof mapped)[number]>();
  for (const row of mapped) {
    const key = String(row.venue || "").trim().toLowerCase();
    if (!key) continue;
    const existing = latestByVenue.get(key);
    if (!existing || row.ts >= existing.ts) {
      latestByVenue.set(key, row);
    }
  }
  return Array.from(latestByVenue.values()).sort((a, b) => a.venue.localeCompare(b.venue));
}

function externalQuotesArrayToMap(
  externalQuotes: Array<{
    venue: string;
    bid: number | null;
    ask: number | null;
    mid: number | null;
    ts: number;
    error?: string;
  }>
): Record<string, ExternalServiceQuote> {
  const map: Record<string, ExternalServiceQuote> = {};
  for (const row of externalQuotes) {
    const key = String(row.venue || "").trim().toLowerCase();
    if (!key) continue;
    map[key] = {
      venue: String(row.venue || key),
      bid: Number.isFinite(Number(row.bid)) ? Number(row.bid) : null,
      ask: Number.isFinite(Number(row.ask)) ? Number(row.ask) : null,
      mid: Number.isFinite(Number(row.mid)) ? Number(row.mid) : null,
      ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : 0,
      error: row.error ? String(row.error) : null
    };
  }
  return map;
}

function normalizeBalancesFromQuoteInputs(inputs: QuoteInputs): NormalizedBalances {
  return normalizeBalancesForSymbol(
    inputs.symbol || "BTC-USD",
    [
      {
        asset: "USD",
        free: inputs.usdFree,
        total: inputs.usdTotal,
        ts: inputs.ts
      },
      {
        asset: "BTC",
        free: inputs.btcFree,
        total: inputs.btcTotal,
        ts: inputs.ts
      }
    ],
    inputs.mid
  );
}

function buildQuoteComparisons(
  ticker: TickerSnapshot | null,
  externalQuotes: Record<string, ExternalServiceQuote>,
  nowTs: number,
  fairMid: number | null
): Array<{
  venue: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  ageSeconds: number | null;
  diffBpsVsRevx: number | null;
  diffBpsVsFair: number | null;
  error: string | null;
}> {
  const revxMid = ticker && Number.isFinite(ticker.mid) && ticker.mid > 0 ? ticker.mid : null;
  const fairMidSafe = Number.isFinite(Number(fairMid)) && Number(fairMid) > 0 ? Number(fairMid) : null;
  const result: Array<{
    venue: string;
    bid: number | null;
    ask: number | null;
    mid: number | null;
    spreadBps: number | null;
    ageSeconds: number | null;
    diffBpsVsRevx: number | null;
    diffBpsVsFair: number | null;
    error: string | null;
  }> = [];

  for (const [venue, quote] of Object.entries(externalQuotes)) {
    const bid = Number.isFinite(Number(quote.bid)) ? Number(quote.bid) : null;
    const ask = Number.isFinite(Number(quote.ask)) ? Number(quote.ask) : null;
    const mid = Number.isFinite(Number(quote.mid)) ? Number(quote.mid) : null;
    const spreadBps =
      bid !== null && ask !== null && bid > 0 && ask > 0 && ask > bid
        ? ((ask - bid) / ((ask + bid) / 2)) * 10_000
        : null;
    const ageSeconds =
      Number.isFinite(Number(quote.ts)) && Number(quote.ts) > 0
        ? Math.max(0, (nowTs - Number(quote.ts)) / 1000)
        : null;
    const diffBpsVsRevx =
      revxMid !== null && mid !== null && mid > 0 ? ((mid - revxMid) / revxMid) * 10_000 : null;
    const diffBpsVsFair =
      fairMidSafe !== null && mid !== null && mid > 0 ? ((mid - fairMidSafe) / fairMidSafe) * 10_000 : null;
    result.push({
      venue,
      bid,
      ask,
      mid,
      spreadBps,
      ageSeconds,
      diffBpsVsRevx,
      diffBpsVsFair,
      error: quote.error ?? null
    });
  }

  return result.sort((a, b) => a.venue.localeCompare(b.venue));
}

function mergeVenueQuotes(
  storeQuotes: VenueQuote[],
  externalQuotes: Record<string, ExternalServiceQuote>
): VenueQuote[] {
  const byVenue = new Map<string, VenueQuote>();
  for (const row of storeQuotes) {
    const key = String(row.venue || "").trim().toLowerCase();
    if (!key) continue;
    byVenue.set(key, {
      venue: key,
      bid: Number.isFinite(row.bid) ? row.bid : null,
      ask: Number.isFinite(row.ask) ? row.ask : null,
      mid: Number.isFinite(row.mid) ? row.mid : null,
      ts: Number.isFinite(row.ts) ? row.ts : 0,
      error: row.error ?? null
    });
  }

  for (const [venue, quote] of Object.entries(externalQuotes)) {
    const key = String(venue || "").trim().toLowerCase();
    if (!key) continue;
    const current = byVenue.get(key);
    const candidate: VenueQuote = {
      venue: key,
      bid: Number.isFinite(Number(quote.bid)) ? Number(quote.bid) : null,
      ask: Number.isFinite(Number(quote.ask)) ? Number(quote.ask) : null,
      mid: Number.isFinite(Number(quote.mid)) ? Number(quote.mid) : null,
      ts: Number.isFinite(Number(quote.ts)) ? Number(quote.ts) : 0,
      error: quote.error ?? null
    };
    if (!current || candidate.ts >= current.ts) {
      byVenue.set(key, candidate);
    }
  }
  return Array.from(byVenue.values()).sort((a, b) => a.venue.localeCompare(b.venue));
}

function buildFallbackQuoteInputs(config: BotConfig, ts: number): QuoteInputs {
  return {
    ts: Math.max(0, Number(ts) || Date.now()),
    symbol: config.symbol,
    mid: 0,
    bid: 0,
    ask: 0,
    marketSpreadBps: 0,
    volMoveBps: 0,
    trendMoveBps: 0,
    usdFree: 0,
    usdTotal: 0,
    btcFree: 0,
    btcTotal: 0,
    btcNotionalUsd: 0,
    inventoryRatio: 0,
    config: {
      levels: config.levels,
      enableTopOfBook: config.enableTopOfBook,
      minInsideSpreadBps: config.minInsideSpreadBps,
      minVolMoveBpsToQuote: config.minVolMoveBpsToQuote,
      volProtectMode: config.volProtectMode,
      cashReserveUsd: config.cashReserveUsd,
      workingCapUsd: config.workingCapUsd,
      targetBtcNotionalUsd: config.targetBtcNotionalUsd,
      lowBtcGateUsd: config.targetBtcNotionalUsd,
      maxActionsPerLoop: config.maxActionsPerLoop,
      maxBtcNotionalUsd: config.maxBtcNotionalUsd,
      seedForceTob: config.seedForceTob
    }
  };
}

function buildEmptySignalsSnapshot(enabled: boolean): SignalSnapshot {
  const nowTs = Date.now();
  return {
    ts: nowTs,
    items: [],
    aggregate: {
      ts: nowTs,
      impact: 0,
      direction: "NEUTRAL",
      confidence: 0,
      state: "NORMAL",
      reasons: ["SIGNALS_NOT_READY"],
      latestTs: 0,
      counts: {}
    },
    health: {
      ok: !enabled,
      lastError: enabled ? "Signals engine not initialized" : undefined,
      providers: []
    }
  };
}

function buildEmptyIntelSnapshot(enabled: boolean): {
  ts: number;
  posture: {
    ts: number;
    state: "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT";
    impact: number;
    direction: "UP" | "DOWN" | "NEUTRAL";
    confidence: number;
    widenBps: number;
    sizeCut: number;
    skewBps: number;
    haltUntilTs: number;
    reasons: string[];
  };
  postureState: "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT";
  postureScore: number;
  commentary: {
    headline: string;
    reasons: string[];
    hardHaltReasons: string[];
    softRiskReasons: string[];
    hardRiskState: "OK" | "HALT";
    intelConfidence: number;
    providerHealth: Array<{
      provider: string;
      ok: boolean;
      blocking: "NON_BLOCKING";
      lastError?: string;
    }>;
    topDrivers: Array<{
      source: string;
      title: string;
      impact: number;
      ageSeconds: number;
      category: string;
      url?: string;
    }>;
    decaySeconds: number;
    providerFreshness: Array<{
      provider: string;
      ok: boolean;
      lastSuccessTs: number;
      lastItemTs: number;
      lastError?: string;
      pollSeconds: number;
      itemsLastHour: number;
    }>;
  };
  providers: Array<{
    provider: string;
    enabled: boolean;
    ok: boolean;
    degraded: boolean;
    lastError: string;
    lastFetchTs: number;
    lastSuccessTs: number;
    lastItemTs: number;
    pollSeconds: number;
    itemsLastHour: number;
    count: number;
  }>;
  items: unknown[];
} {
  const nowTs = Date.now();
  return {
    ts: nowTs,
    posture: {
      ts: nowTs,
      state: "NORMAL",
      impact: 0,
      direction: "NEUTRAL",
      confidence: 0,
      widenBps: 0,
      sizeCut: 0,
      skewBps: 0,
      haltUntilTs: 0,
      reasons: [enabled ? "INTEL_NOT_READY" : "INTEL_DISABLED"]
    },
    postureState: "NORMAL",
    postureScore: 0,
    commentary: {
      headline: enabled ? "NORMAL: Intel warming up" : "NORMAL: Intel disabled",
      reasons: [enabled ? "INTEL_NOT_READY" : "INTEL_DISABLED"],
      hardHaltReasons: [],
      softRiskReasons: [enabled ? "INTEL_NOT_READY" : "INTEL_DISABLED"],
      hardRiskState: "OK",
      intelConfidence: 0,
      providerHealth: [],
      topDrivers: [],
      decaySeconds: 0,
      providerFreshness: []
    },
    providers: [],
    items: []
  };
}

function buildEmptyIntelHealth(enabled: boolean): {
  ts: number;
  providers: Array<{
    provider: string;
    enabled: boolean;
    ok: boolean;
    degraded: boolean;
    lastError: string;
    lastFetchTs: number;
    count: number;
  }>;
  lastError: string;
  running: boolean;
} {
  return {
    ts: Date.now(),
    providers: [],
    lastError: enabled ? "Intel engine not initialized" : "Intel disabled",
    running: false
  };
}

function buildFallbackQuotePlan(inputs: QuoteInputs): QuotePlan {
  const seedState = computeSeedState(inputs, {
    lowBtcGateUsd: inputs.config.lowBtcGateUsd,
    targetBtcNotionalUsd: inputs.config.targetBtcNotionalUsd,
    maxBtcNotionalUsd:
      Number.isFinite(Number(inputs.config.maxBtcNotionalUsd)) &&
      Number(inputs.config.maxBtcNotionalUsd) > 0
        ? Number(inputs.config.maxBtcNotionalUsd)
        : undefined
  });
  return {
    quoteEnabled: false,
    hardHalt: false,
    hardHaltReasons: [],
    blockedReasons: ["UNKNOWN_BLOCK (planner wired but no reasons emitted)"],
    buyLevels: 0,
    sellLevels: 0,
    tob: "OFF",
    newsState: "NORMAL",
    newsImpact: 0,
    newsDirection: "NEUTRAL",
    newsConfidence: 0,
    newsReasons: [],
    signalsState: "NORMAL",
    signalsImpact: 0,
    signalsDirection: "NEUTRAL",
    signalsConfidence: 0,
    signalsReasons: [],
    seedMode: seedState.mode,
    seedReason: seedState.reason,
    seedProgress: {
      btcNotionalUsd: seedState.progress.btcNotionalUsd,
      lowGateUsd: seedState.progress.lowGateUsd,
      targetUsd: seedState.progress.targetUsd
    }
  };
}

function ensureBotStatusWithQuoting(
  status: BotStatus | null,
  nowTs: number,
  debugPlan: QuotePlan | null = null,
  debugLastUpdatedTs: number = 0
): BotStatus {
  const base: BotStatus = status ?? {
    ts: nowTs,
    mid: 0,
    exposure_usd: 0,
    allow_buy: false,
    allow_sell: false,
    buy_reasons: ["Awaiting strategy decision"],
    sell_reasons: ["Awaiting strategy decision"]
  };
  const sourceBlockedReasons =
    debugPlan && Array.isArray(debugPlan.blockedReasons)
      ? debugPlan.blockedReasons.map((v) => String(v))
      : base.quoting && Array.isArray(base.quoting.quoteBlockedReasons)
        ? base.quoting.quoteBlockedReasons.map((v) => String(v))
        : [
            ...(Array.isArray(base.buy_reasons) ? base.buy_reasons : []),
            ...(Array.isArray(base.sell_reasons) ? base.sell_reasons : [])
          ];
  const quoteBlockedReasons = dedupeStrings(sourceBlockedReasons);
  const sourceHardHaltReasons =
    debugPlan && Array.isArray(debugPlan.hardHaltReasons)
      ? debugPlan.hardHaltReasons.map((v) => String(v))
      : base.quoting && Array.isArray(base.quoting.hardHaltReasons)
        ? base.quoting.hardHaltReasons.map((v) => String(v))
        : [];
  const hardHaltReasons = dedupeStrings(sourceHardHaltReasons);
  const hardHalt = debugPlan
    ? Boolean(debugPlan.hardHalt)
    : base.quoting && typeof base.quoting.hardHalt === "boolean"
      ? base.quoting.hardHalt
      : hardHaltReasons.length > 0;
  const tobPlanned = debugPlan
    ? debugPlan.tob
    : base.quoting && isQuotePlanTob(base.quoting.tobPlanned)
      ? base.quoting.tobPlanned
      : "OFF";
  const buyLevelsPlanned = debugPlan
    ? Math.max(0, Math.floor(Number(debugPlan.buyLevels) || 0))
    : base.quoting && Number.isFinite(Number(base.quoting.buyLevelsPlanned))
      ? Math.max(0, Math.floor(Number(base.quoting.buyLevelsPlanned)))
      : 0;
  const sellLevelsPlanned = debugPlan
    ? Math.max(0, Math.floor(Number(debugPlan.sellLevels) || 0))
    : base.quoting && Number.isFinite(Number(base.quoting.sellLevelsPlanned))
      ? Math.max(0, Math.floor(Number(base.quoting.sellLevelsPlanned)))
      : 0;
  const impliedOrders =
    buyLevelsPlanned + sellLevelsPlanned + (tobPlanned === "BOTH" ? 2 : tobPlanned === "OFF" ? 0 : 1);
  const quoteEnabled = debugPlan
    ? Boolean(debugPlan.quoteEnabled)
    : base.quoting && typeof base.quoting.quoteEnabled === "boolean"
      ? base.quoting.quoteEnabled
      : impliedOrders > 0 && (base.allow_buy || base.allow_sell);
  const normalizedBlockedReasons =
    !quoteEnabled && !hardHalt && quoteBlockedReasons.length === 0
      ? ["UNKNOWN_BLOCK (planner wired but no reasons emitted)"]
      : quoteBlockedReasons;
  const targetLevelsRaw =
    base.quoting && typeof base.quoting.targetLevels === "object" && base.quoting.targetLevels
      ? (base.quoting.targetLevels as Record<string, unknown>)
      : null;
  const effectiveTargetLevelsRaw =
    base.quoting && typeof base.quoting.effectiveTargetLevels === "object" && base.quoting.effectiveTargetLevels
      ? (base.quoting.effectiveTargetLevels as Record<string, unknown>)
      : null;
  const pausePolicyRaw =
    base.quoting && typeof base.quoting.pausePolicy === "object" && base.quoting.pausePolicy
      ? (base.quoting.pausePolicy as Record<string, unknown>)
      : null;
  const targetLevels = {
    buy:
      targetLevelsRaw && Number.isFinite(Number(targetLevelsRaw.buy))
        ? Math.max(0, Math.floor(Number(targetLevelsRaw.buy)))
        : buyLevelsPlanned,
    sell:
      targetLevelsRaw && Number.isFinite(Number(targetLevelsRaw.sell))
        ? Math.max(0, Math.floor(Number(targetLevelsRaw.sell)))
        : sellLevelsPlanned,
    tob:
      targetLevelsRaw && isQuotePlanTob(targetLevelsRaw.tob)
        ? targetLevelsRaw.tob
        : tobPlanned
  };
  const effectiveTargetLevels = {
    buy:
      effectiveTargetLevelsRaw && Number.isFinite(Number(effectiveTargetLevelsRaw.buy))
        ? Math.max(0, Math.floor(Number(effectiveTargetLevelsRaw.buy)))
        : targetLevels.buy,
    sell:
      effectiveTargetLevelsRaw && Number.isFinite(Number(effectiveTargetLevelsRaw.sell))
        ? Math.max(0, Math.floor(Number(effectiveTargetLevelsRaw.sell)))
        : targetLevels.sell,
    tob:
      effectiveTargetLevelsRaw && isQuotePlanTob(effectiveTargetLevelsRaw.tob)
        ? effectiveTargetLevelsRaw.tob
        : targetLevels.tob
  };
  const minLevelsFloorApplied =
    base.quoting && typeof base.quoting.minLevelsFloorApplied === "boolean"
      ? base.quoting.minLevelsFloorApplied
      : false;
  const tobPolicy =
    base.quoting &&
    (base.quoting.tobPolicy === "JOIN" ||
      base.quoting.tobPolicy === "JOIN+1" ||
      base.quoting.tobPolicy === "JOIN+2" ||
      base.quoting.tobPolicy === "OFF")
      ? base.quoting.tobPolicy
      : "JOIN";
  const appliedSpreadMult =
    base.quoting && Number.isFinite(Number(base.quoting.appliedSpreadMult))
      ? Number(base.quoting.appliedSpreadMult)
      : 1;
  const appliedSizeMult =
    base.quoting && Number.isFinite(Number(base.quoting.appliedSizeMult))
      ? Number(base.quoting.appliedSizeMult)
      : 1;
  const makerMinEdgeBps =
    base.quoting && Number.isFinite(Number(base.quoting.makerMinEdgeBps))
      ? Math.max(0, Number(base.quoting.makerMinEdgeBps))
      : undefined;
  const takerMinEdgeBps =
    base.quoting && Number.isFinite(Number(base.quoting.takerMinEdgeBps))
      ? Math.max(0, Number(base.quoting.takerMinEdgeBps))
      : undefined;
  const takerFeeBps =
    base.quoting && Number.isFinite(Number(base.quoting.takerFeeBps))
      ? Math.max(0, Number(base.quoting.takerFeeBps))
      : undefined;
  const slippageBufferBps =
    base.quoting && Number.isFinite(Number(base.quoting.slippageBufferBps))
      ? Math.max(0, Number(base.quoting.slippageBufferBps))
      : undefined;
  const seedingRaw =
    base.quoting && typeof base.quoting.seeding === "object" && base.quoting.seeding
      ? (base.quoting.seeding as Record<string, unknown>)
      : null;
  const normalizedSeedingMode: "ACCUMULATE_BTC" | "TWO_SIDED" | "REBALANCE" =
    seedingRaw && String(seedingRaw.mode || "").toUpperCase() === "ACCUMULATE_BTC"
      ? "ACCUMULATE_BTC"
      : seedingRaw && String(seedingRaw.mode || "").toUpperCase() === "REBALANCE"
        ? "REBALANCE"
        : "TWO_SIDED";
  const seeding = seedingRaw
    ? {
        active: Boolean(seedingRaw.active),
        mode: normalizedSeedingMode,
        btcNotionalUsd: Number.isFinite(Number(seedingRaw.btcNotionalUsd))
          ? Number(seedingRaw.btcNotionalUsd)
          : 0,
        targetUsd: Number.isFinite(Number(seedingRaw.targetUsd))
          ? Number(seedingRaw.targetUsd)
          : 0,
        lastSeedOrderTs: Number.isFinite(Number(seedingRaw.lastSeedOrderTs))
          ? Math.max(0, Math.floor(Number(seedingRaw.lastSeedOrderTs)))
          : 0,
        reason: String(seedingRaw.reason ?? "")
      }
    : undefined;
  const lowVolMode =
    base.quoting && base.quoting.lowVolMode === "KEEP_QUOTING"
      ? "KEEP_QUOTING"
      : "KEEP_QUOTING";
  const volMoveBps =
    base.quoting && Number.isFinite(Number(base.quoting.volMoveBps))
      ? Number(base.quoting.volMoveBps)
      : undefined;
  const minVolMoveBps =
    base.quoting && Number.isFinite(Number(base.quoting.minVolMoveBps))
      ? Number(base.quoting.minVolMoveBps)
      : undefined;
  const whyNotQuoting =
    base.quoting && typeof base.quoting.whyNotQuoting === "string"
      ? String(base.quoting.whyNotQuoting).trim()
      : "";
  const whyNotQuotingDetails =
    base.quoting && typeof base.quoting.whyNotQuotingDetails === "string"
      ? String(base.quoting.whyNotQuotingDetails).trim()
      : "";
  const lastPlannerOutputSummaryRaw =
    base.quoting &&
    typeof base.quoting.lastPlannerOutputSummary === "object" &&
    base.quoting.lastPlannerOutputSummary
      ? (base.quoting.lastPlannerOutputSummary as Record<string, unknown>)
      : null;
  const lastPlannerOutputSummary = lastPlannerOutputSummaryRaw
    ? {
        desiredCount: Number.isFinite(Number(lastPlannerOutputSummaryRaw.desiredCount))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.desiredCount)))
          : 0,
        buyLevels: Number.isFinite(Number(lastPlannerOutputSummaryRaw.buyLevels))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.buyLevels)))
          : 0,
        sellLevels: Number.isFinite(Number(lastPlannerOutputSummaryRaw.sellLevels))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.sellLevels)))
          : 0,
        tob:
          isQuotePlanTob(lastPlannerOutputSummaryRaw.tob)
            ? lastPlannerOutputSummaryRaw.tob
            : "OFF",
        usedLevelsBuy: Number.isFinite(Number(lastPlannerOutputSummaryRaw.usedLevelsBuy))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.usedLevelsBuy)))
          : undefined,
        usedLevelsSell: Number.isFinite(Number(lastPlannerOutputSummaryRaw.usedLevelsSell))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.usedLevelsSell)))
          : undefined,
        usedTob:
          isQuotePlanTob(lastPlannerOutputSummaryRaw.usedTob)
            ? lastPlannerOutputSummaryRaw.usedTob
            : undefined,
        perSideBlockReasons:
          typeof lastPlannerOutputSummaryRaw.perSideBlockReasons === "object" &&
          lastPlannerOutputSummaryRaw.perSideBlockReasons
            ? {
                buy: Array.isArray(
                  (lastPlannerOutputSummaryRaw.perSideBlockReasons as Record<string, unknown>).buy
                )
                  ? (
                      (lastPlannerOutputSummaryRaw.perSideBlockReasons as Record<string, unknown>)
                        .buy as unknown[]
                    )
                      .map((row) => String(row || "").trim())
                      .filter((row) => row.length > 0)
                      .slice(0, 20)
                  : [],
                sell: Array.isArray(
                  (lastPlannerOutputSummaryRaw.perSideBlockReasons as Record<string, unknown>).sell
                )
                  ? (
                      (lastPlannerOutputSummaryRaw.perSideBlockReasons as Record<string, unknown>)
                        .sell as unknown[]
                    )
                      .map((row) => String(row || "").trim())
                      .filter((row) => row.length > 0)
                      .slice(0, 20)
                  : []
              }
            : { buy: [], sell: [] },
        actionBudget: Number.isFinite(Number(lastPlannerOutputSummaryRaw.actionBudget))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.actionBudget)))
          : 0,
        actionsUsed: Number.isFinite(Number(lastPlannerOutputSummaryRaw.actionsUsed))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.actionsUsed)))
          : 0,
        openBuyVenue: Number.isFinite(Number(lastPlannerOutputSummaryRaw.openBuyVenue))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.openBuyVenue)))
          : 0,
        openSellVenue: Number.isFinite(Number(lastPlannerOutputSummaryRaw.openSellVenue))
          ? Math.max(0, Math.floor(Number(lastPlannerOutputSummaryRaw.openSellVenue)))
          : 0
      }
    : undefined;
  const forceBaselineApplied =
    base.quoting && typeof base.quoting.forceBaselineApplied === "boolean"
      ? base.quoting.forceBaselineApplied
      : false;
  const overrideApplied =
    base.quoting && typeof base.quoting.overrideApplied === "boolean"
      ? base.quoting.overrideApplied
      : false;
  const overrideReasons =
    base.quoting && Array.isArray(base.quoting.overrideReasons)
      ? base.quoting.overrideReasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
      : [];
  const lastClampEventsRaw =
    base.quoting && Array.isArray(base.quoting.lastClampEvents)
      ? (base.quoting.lastClampEvents as unknown[])
      : [];
  const lastClampEvents = lastClampEventsRaw
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : null))
    .filter((row): row is Record<string, unknown> => row !== null)
    .map((row) => ({
      ts: Number.isFinite(Number(row.ts)) ? Math.max(0, Math.floor(Number(row.ts))) : 0,
      side: (String(row.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY") as Side,
      tag: String(row.tag ?? "-"),
      reason: String(row.reason ?? ""),
      beforeQuoteUsd: Number.isFinite(Number(row.beforeQuoteUsd)) ? Number(row.beforeQuoteUsd) : 0,
      afterQuoteUsd: Number.isFinite(Number(row.afterQuoteUsd)) ? Number(row.afterQuoteUsd) : 0,
      beforeBaseQtyBtc: Number.isFinite(Number(row.beforeBaseQtyBtc)) ? Number(row.beforeBaseQtyBtc) : 0,
      afterBaseQtyBtc: Number.isFinite(Number(row.afterBaseQtyBtc)) ? Number(row.afterBaseQtyBtc) : 0,
      details: String(row.details ?? "")
    }))
    .slice(-20);
  const clampCountersRaw =
    base.quoting && typeof base.quoting.clampCounters === "object" && base.quoting.clampCounters
      ? (base.quoting.clampCounters as Record<string, unknown>)
      : {};
  const clampCounters: Record<string, number> = {};
  for (const [reasonKey, reasonValue] of Object.entries(clampCountersRaw)) {
    if (!reasonKey) continue;
    if (!Number.isFinite(Number(reasonValue))) continue;
    clampCounters[reasonKey] = Math.max(0, Math.floor(Number(reasonValue)));
  }
  const pausePolicy = {
    minLevelsFloorEnabled:
      pausePolicyRaw && typeof pausePolicyRaw.minLevelsFloorEnabled === "boolean"
        ? pausePolicyRaw.minLevelsFloorEnabled
        : true,
    minLevelsFloor: {
      buy:
        pausePolicyRaw &&
        pausePolicyRaw.minLevelsFloor &&
        typeof pausePolicyRaw.minLevelsFloor === "object" &&
        Number.isFinite(Number((pausePolicyRaw.minLevelsFloor as Record<string, unknown>).buy))
          ? Math.max(0, Math.floor(Number((pausePolicyRaw.minLevelsFloor as Record<string, unknown>).buy)))
          : 1,
      sell:
        pausePolicyRaw &&
        pausePolicyRaw.minLevelsFloor &&
        typeof pausePolicyRaw.minLevelsFloor === "object" &&
        Number.isFinite(Number((pausePolicyRaw.minLevelsFloor as Record<string, unknown>).sell))
          ? Math.max(0, Math.floor(Number((pausePolicyRaw.minLevelsFloor as Record<string, unknown>).sell)))
          : 1
    },
    pauseThresholds: {
      impact:
        pausePolicyRaw &&
        pausePolicyRaw.pauseThresholds &&
        typeof pausePolicyRaw.pauseThresholds === "object" &&
        Number.isFinite(Number((pausePolicyRaw.pauseThresholds as Record<string, unknown>).impact))
          ? Number((pausePolicyRaw.pauseThresholds as Record<string, unknown>).impact)
          : 0.97,
      confidence:
        pausePolicyRaw &&
        pausePolicyRaw.pauseThresholds &&
        typeof pausePolicyRaw.pauseThresholds === "object" &&
        Number.isFinite(Number((pausePolicyRaw.pauseThresholds as Record<string, unknown>).confidence))
          ? Number((pausePolicyRaw.pauseThresholds as Record<string, unknown>).confidence)
          : 0.75
    },
    persistenceSeconds:
      pausePolicyRaw && Number.isFinite(Number(pausePolicyRaw.persistenceSeconds))
        ? Math.max(0, Math.floor(Number(pausePolicyRaw.persistenceSeconds)))
        : 120
  };
  const cancelReasonCountsRaw =
    base.quoting && typeof base.quoting.cancelReasonCounts === "object" && base.quoting.cancelReasonCounts
      ? (base.quoting.cancelReasonCounts as Record<string, unknown>)
      : {};
  const cancelReasonCounts: Record<string, number> = {};
  for (const [reasonKey, reasonValue] of Object.entries(cancelReasonCountsRaw)) {
    if (!reasonKey) continue;
    if (!Number.isFinite(Number(reasonValue))) continue;
    cancelReasonCounts[reasonKey] = Math.max(0, Math.floor(Number(reasonValue)));
  }
  const cycleActionsRaw =
    base.quoting && typeof base.quoting.cycleActions === "object" && base.quoting.cycleActions
      ? (base.quoting.cycleActions as Record<string, unknown>)
      : {};
  const cycleActions = {
    placed: Number.isFinite(Number(cycleActionsRaw.placed))
      ? Math.max(0, Math.floor(Number(cycleActionsRaw.placed)))
      : 0,
    cancelled: Number.isFinite(Number(cycleActionsRaw.cancelled))
      ? Math.max(0, Math.floor(Number(cycleActionsRaw.cancelled)))
      : 0,
    kept: Number.isFinite(Number(cycleActionsRaw.kept))
      ? Math.max(0, Math.floor(Number(cycleActionsRaw.kept)))
      : 0,
    refreshSkipped: Boolean(cycleActionsRaw.refreshSkipped),
    refreshSkipReason: String(cycleActionsRaw.refreshSkipReason ?? "").trim()
  };
  const lastCancelReason =
    base.quoting && typeof base.quoting.lastCancelReason === "string"
      ? String(base.quoting.lastCancelReason)
      : null;

  return {
    ...base,
    quoting: {
      pausePolicy,
      quoteEnabled,
      hardHalt,
      hardHaltReasons,
      quoteBlockedReasons: normalizedBlockedReasons,
      buyLevelsPlanned,
      sellLevelsPlanned,
      tobPlanned,
      effectiveTargetLevels,
      targetLevels,
      minLevelsFloorApplied,
      tobPolicy,
      appliedSpreadMult,
      appliedSizeMult,
      makerMinEdgeBps,
      takerMinEdgeBps,
      takerFeeBps,
      slippageBufferBps,
      seeding,
      lowVolMode,
      volMoveBps,
      minVolMoveBps,
      whyNotQuoting: whyNotQuoting.length > 0 ? whyNotQuoting : undefined,
      whyNotQuotingDetails:
        whyNotQuotingDetails.length > 0 ? whyNotQuotingDetails : undefined,
      lastPlannerOutputSummary,
      forceBaselineApplied,
      overrideApplied,
      overrideReasons,
      lastClampEvents,
      clampCounters,
      marketPhase:
        debugPlan?.marketPhase ??
        (base.quoting?.marketPhase === "SHOCK" ||
        base.quoting?.marketPhase === "COOLDOWN" ||
        base.quoting?.marketPhase === "STABILIZING" ||
        base.quoting?.marketPhase === "RECOVERY"
          ? base.quoting.marketPhase
          : undefined),
      phaseReasons:
        Array.isArray(debugPlan?.phaseReasons)
          ? debugPlan?.phaseReasons.map((row) => String(row))
          : Array.isArray(base.quoting?.phaseReasons)
            ? base.quoting?.phaseReasons.map((row) => String(row))
            : [],
      phaseSinceTs:
        Number.isFinite(Number(debugPlan?.phaseSinceTs))
          ? Number(debugPlan?.phaseSinceTs)
          : Number.isFinite(Number(base.quoting?.phaseSinceTs))
            ? Number(base.quoting?.phaseSinceTs)
            : undefined,
      shockVolPeakBps:
        Number.isFinite(Number(debugPlan?.shockVolPeakBps))
          ? Number(debugPlan?.shockVolPeakBps)
          : Number.isFinite(Number(base.quoting?.shockVolPeakBps))
            ? Number(base.quoting?.shockVolPeakBps)
            : undefined,
      shockState:
        debugPlan?.shockState ??
        (base.quoting?.shockState === "NORMAL" ||
        base.quoting?.shockState === "SHOCK" ||
        base.quoting?.shockState === "COOLDOWN" ||
        base.quoting?.shockState === "REENTRY"
          ? base.quoting.shockState
          : undefined),
      shockReasons:
        Array.isArray(debugPlan?.shockReasons)
          ? debugPlan?.shockReasons.map((row) => String(row))
          : Array.isArray(base.quoting?.shockReasons)
            ? base.quoting?.shockReasons.map((row) => String(row))
            : [],
      shockSinceTs:
        Number.isFinite(Number(debugPlan?.shockSinceTs))
          ? Number(debugPlan?.shockSinceTs)
          : Number.isFinite(Number(base.quoting?.shockSinceTs))
            ? Number(base.quoting?.shockSinceTs)
            : undefined,
      reentryProgress:
        base.quoting && base.quoting.reentryProgress && typeof base.quoting.reentryProgress === "object"
          ? {
              btcNotionalUsd: Number.isFinite(Number(base.quoting.reentryProgress.btcNotionalUsd))
                ? Number(base.quoting.reentryProgress.btcNotionalUsd)
                : 0,
              targetUsd: Number.isFinite(Number(base.quoting.reentryProgress.targetUsd))
                ? Number(base.quoting.reentryProgress.targetUsd)
                : 0,
              seedOrdersPlaced: Number.isFinite(Number(base.quoting.reentryProgress.seedOrdersPlaced))
                ? Math.max(0, Math.floor(Number(base.quoting.reentryProgress.seedOrdersPlaced)))
                : 0,
              lastSeedTs: Number.isFinite(Number(base.quoting.reentryProgress.lastSeedTs))
                ? Math.max(0, Math.floor(Number(base.quoting.reentryProgress.lastSeedTs)))
                : 0
            }
          : undefined,
      errorPolicy:
        base.quoting && base.quoting.errorPolicy && typeof base.quoting.errorPolicy === "object"
          ? {
              recoverableCount5m: Number.isFinite(Number(base.quoting.errorPolicy.recoverableCount5m))
                ? Math.max(0, Math.floor(Number(base.quoting.errorPolicy.recoverableCount5m)))
                : 0,
              lastRecoverableError: String(base.quoting.errorPolicy.lastRecoverableError ?? ""),
              transientBackoffMs: Number.isFinite(Number(base.quoting.errorPolicy.transientBackoffMs))
                ? Math.max(0, Math.floor(Number(base.quoting.errorPolicy.transientBackoffMs)))
                : 0,
              hardHalt: Boolean(base.quoting.errorPolicy.hardHalt),
              hardHaltReason: String(base.quoting.errorPolicy.hardHaltReason ?? "")
            }
          : undefined,
      cancelReasonCounts,
      lastCancelReason,
      cycleActions,
      newsState: debugPlan?.newsState ?? base.quoting?.newsState,
      newsImpact:
        Number.isFinite(Number(debugPlan?.newsImpact))
          ? Number(debugPlan?.newsImpact)
          : Number.isFinite(Number(base.quoting?.newsImpact))
            ? Number(base.quoting?.newsImpact)
            : undefined,
      newsDirection:
        debugPlan?.newsDirection ??
        (base.quoting?.newsDirection === "UP" ||
        base.quoting?.newsDirection === "DOWN" ||
        base.quoting?.newsDirection === "NEUTRAL"
          ? base.quoting.newsDirection
          : undefined),
      newsConfidence:
        Number.isFinite(Number(debugPlan?.newsConfidence))
          ? Number(debugPlan?.newsConfidence)
          : Number.isFinite(Number(base.quoting?.newsConfidence))
            ? Number(base.quoting?.newsConfidence)
            : undefined,
      newsReasons:
        Array.isArray(debugPlan?.newsReasons)
          ? debugPlan?.newsReasons.map((row) => String(row))
          : Array.isArray(base.quoting?.newsReasons)
            ? base.quoting?.newsReasons.map((row) => String(row))
            : undefined,
      signalsState:
        debugPlan?.signalsState ??
        (base.quoting?.signalsState === "NORMAL" ||
        base.quoting?.signalsState === "CAUTION" ||
        base.quoting?.signalsState === "RISK_OFF" ||
        base.quoting?.signalsState === "RISK_ON" ||
        base.quoting?.signalsState === "PAUSE"
          ? base.quoting.signalsState
          : undefined),
      signalsImpact:
        Number.isFinite(Number(debugPlan?.signalsImpact))
          ? Number(debugPlan?.signalsImpact)
          : Number.isFinite(Number(base.quoting?.signalsImpact))
            ? Number(base.quoting?.signalsImpact)
            : undefined,
      signalsDirection:
        debugPlan?.signalsDirection ??
        (base.quoting?.signalsDirection === "UP" ||
        base.quoting?.signalsDirection === "DOWN" ||
        base.quoting?.signalsDirection === "NEUTRAL"
          ? base.quoting.signalsDirection
          : undefined),
      signalsConfidence:
        Number.isFinite(Number(debugPlan?.signalsConfidence))
          ? Number(debugPlan?.signalsConfidence)
          : Number.isFinite(Number(base.quoting?.signalsConfidence))
            ? Number(base.quoting?.signalsConfidence)
            : undefined,
      signalsReasons:
        Array.isArray(debugPlan?.signalsReasons)
          ? debugPlan?.signalsReasons.map((row) => String(row))
          : Array.isArray(base.quoting?.signalsReasons)
            ? base.quoting?.signalsReasons.map((row) => String(row))
            : undefined,
      lastDecisionTs:
        debugLastUpdatedTs > 0
          ? Math.max(0, Number(debugLastUpdatedTs))
          : base.quoting && Number.isFinite(Number(base.quoting.lastDecisionTs))
            ? Math.max(0, Number(base.quoting.lastDecisionTs))
          : Math.max(0, Number(base.ts || nowTs))
    }
  };
}

function isQuotePlanTob(value: unknown): value is "OFF" | "BUY" | "SELL" | "BOTH" {
  return value === "OFF" || value === "BUY" || value === "SELL" || value === "BOTH";
}

type NormalizedQuote = {
  venue: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  ts: number | null;
  spreadBps: number | null;
  ageSeconds: number | null;
  error: string | null;
};

type NormalizedQuotesPayload = {
  revx: Omit<NormalizedQuote, "venue">;
  venues: NormalizedQuote[];
  bestBid: { venue: string; price: number } | null;
  bestAsk: { venue: string; price: number } | null;
  fairMid: number | null;
};

function buildNormalizedQuotes(params: {
  ticker: TickerSnapshot | null;
  mergedVenueQuotes: VenueQuote[];
  configuredVenues: string[];
  nowTs: number;
  fairMid: number | null;
}): NormalizedQuotesPayload {
  const nowTs = Number.isFinite(params.nowTs) ? params.nowTs : Date.now();
  const revxQuote = normalizeQuoteRow(
    {
      venue: "REVX",
      bid: params.ticker?.bid ?? null,
      ask: params.ticker?.ask ?? null,
      mid: params.ticker?.mid ?? null,
      ts: params.ticker?.ts ?? null,
      error: null
    },
    nowTs
  );
  if (
    revxQuote.bid === null &&
    revxQuote.ask === null &&
    revxQuote.mid === null &&
    revxQuote.error === null
  ) {
    revxQuote.error = "no data";
  }

  const configuredVenueSet = new Set(
    (Array.isArray(params.configuredVenues) ? params.configuredVenues : [])
      .map((venue) => String(venue ?? "").trim().toLowerCase())
      .filter((venue) => venue.length > 0)
  );
  const byVenue = new Map<string, NormalizedQuote>();
  for (const row of params.mergedVenueQuotes) {
    const venueKey = String(row.venue ?? "").trim().toLowerCase();
    if (!venueKey) continue;
    const normalized = normalizeQuoteRow(
      {
        venue: venueKey,
        bid: row.bid ?? null,
        ask: row.ask ?? null,
        mid: row.mid ?? null,
        ts: row.ts ?? null,
        error: row.error ?? null
      },
      nowTs
    );
    if (
      normalized.bid === null &&
      normalized.ask === null &&
      normalized.mid === null &&
      normalized.error === null
    ) {
      normalized.error = "no data";
    }
    byVenue.set(venueKey, normalized);
  }

  for (const venue of configuredVenueSet) {
    if (byVenue.has(venue)) continue;
    byVenue.set(
      venue,
      normalizeQuoteRow(
        {
          venue,
          bid: null,
          ask: null,
          mid: null,
          ts: null,
          error: "no data"
        },
        nowTs
      )
    );
  }

  const venues = Array.from(byVenue.values()).sort((a, b) => a.venue.localeCompare(b.venue));
  const bestBid = bestBidFromQuotes([revxQuote, ...venues]);
  const bestAsk = bestAskFromQuotes([revxQuote, ...venues]);

  const fairMidRaw = Number(params.fairMid);
  const fairMid =
    Number.isFinite(fairMidRaw) && fairMidRaw > 0
      ? fairMidRaw
      : revxQuote.mid !== null && revxQuote.mid > 0
        ? revxQuote.mid
        : null;

  return {
    revx: {
      bid: revxQuote.bid,
      ask: revxQuote.ask,
      mid: revxQuote.mid,
      ts: revxQuote.ts,
      spreadBps: revxQuote.spreadBps,
      ageSeconds: revxQuote.ageSeconds,
      error: revxQuote.error
    },
    venues,
    bestBid,
    bestAsk,
    fairMid
  };
}

function normalizeQuoteRow(
  row: {
    venue: string;
    bid: number | null;
    ask: number | null;
    mid: number | null;
    ts: number | null;
    error: string | null;
  },
  nowTs: number
): NormalizedQuote {
  const bid = toPositiveNumber(row.bid);
  const ask = toPositiveNumber(row.ask);
  const providedMid = toPositiveNumber(row.mid);
  const mid = providedMid ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null);
  const tsValue = toTimestamp(row.ts);
  const spreadBps =
    mid !== null && mid > 0 && bid !== null && ask !== null ? ((ask - bid) / mid) * 10_000 : null;
  const ageSeconds =
    tsValue !== null ? Math.max(0, (Math.max(nowTs, tsValue) - tsValue) / 1000) : null;
  const rawError = typeof row.error === "string" ? row.error.trim() : "";
  return {
    venue: String(row.venue || "").trim().toUpperCase(),
    bid,
    ask,
    mid,
    ts: tsValue,
    spreadBps: spreadBps !== null && Number.isFinite(spreadBps) ? spreadBps : null,
    ageSeconds: ageSeconds !== null && Number.isFinite(ageSeconds) ? ageSeconds : null,
    error: rawError.length > 0 ? rawError : null
  };
}

function toPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 0 ? parsed : null;
}

function toTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 0 ? parsed : null;
}

function bestBidFromQuotes(quotes: NormalizedQuote[]): { venue: string; price: number } | null {
  let best: { venue: string; price: number } | null = null;
  for (const row of quotes) {
    if (row.bid === null || !Number.isFinite(row.bid) || row.bid <= 0) continue;
    if (!best || row.bid > best.price) {
      best = { venue: row.venue, price: row.bid };
    }
  }
  return best;
}

function bestAskFromQuotes(quotes: NormalizedQuote[]): { venue: string; price: number } | null {
  let best: { venue: string; price: number } | null = null;
  for (const row of quotes) {
    if (row.ask === null || !Number.isFinite(row.ask) || row.ask <= 0) continue;
    if (!best || row.ask < best.price) {
      best = { venue: row.venue, price: row.ask };
    }
  }
  return best;
}

function parsePnlWindow(raw: string | null): PnlWindowKey {
  if (raw === "12h" || raw === "4h" || raw === "1h" || raw === "15m" || raw === "24h") {
    return raw;
  }
  return "24h";
}

function deriveHardRiskState(
  botStatus: BotStatus | null,
  strategyStatus?: { stalled?: boolean; lastCycleCompletedTs?: number } | null
): { state: "OK" | "HALT"; reasons: string[] } {
  const reasons: string[] = [];
  const quoting = botStatus?.quoting;
  if (strategyStatus?.stalled) {
    reasons.push(
      `STRATEGY_STALLED (lastCycleCompletedTs=${Math.max(
        0,
        Math.floor(Number(strategyStatus.lastCycleCompletedTs) || 0)
      )})`
    );
  }
  if (quoting?.hardHalt === true) {
    reasons.push("HARD_HALT_FLAGGED");
  }
  const hardHaltReasons = Array.isArray(quoting?.hardHaltReasons)
    ? quoting?.hardHaltReasons.map((row) => String(row))
    : [];
  const criticalPattern = /KILL|MANUAL_HALT|MARKET_DATA_STALE|ORDER_ACK|ACK_TIMEOUT|INVENTORY_BREACH|EXTREME_VOL|REVX_UNREACHABLE|PNL_STOP|HARD_HALT/i;
  for (const reason of hardHaltReasons) {
    if (criticalPattern.test(reason)) {
      reasons.push(reason);
    }
  }
  if (reasons.length === 0) {
    return { state: "OK", reasons: [] };
  }
  return { state: "HALT", reasons: dedupeStrings(reasons).slice(0, 6) };
}

function parseAnalysisWindow(raw: string | null): AnalysisWindowKey {
  if (raw === "1h" || raw === "24h" || raw === "7d") {
    return raw;
  }
  return "24h";
}

function buildEmptyAnalysisSummary(window: AnalysisWindowKey): AnalysisSummary {
  const nowTs = Date.now();
  return {
    window,
    ts: nowTs,
    fillsCount: 0,
    fillsPerHour: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    netPnlUsd: 0,
    avgEdgeBps: 0,
    medianEdgeBps: 0,
    avgEdgeBpsBuy: 0,
    avgEdgeBpsSell: 0,
    avgToxBps30s: 0,
    avgToxBps2m: 0,
    toxicPct30s: 0,
    toxP10Bps30s: 0,
    avgInventoryNotionalUsdAbs: 0,
    inventoryAboveThresholdPct: 0,
    inventorySkewDirection: "NEUTRAL",
    avgHoldSeconds: 0,
    cancelReplaceRatio: 0,
    latestMid: 0,
    computedAtTs: nowTs
  };
}

function buildEmptyAdaptiveStatus(): AdaptiveStatus {
  const nowTs = Date.now();
  return {
    enabled: false,
    ts: nowTs,
    currentParams: {
      quoteMode: "JOIN_TOB",
      baseSpreadTicks: 0,
      sizeMultiplier: 1,
      levels: 1,
      minRestSeconds: 10
    },
    lastDecision: null,
    lastEventTs: 0,
    lastEventReason: "",
    guardrails: {
      posture: "NORMAL",
      hardLimited: false
    }
  };
}

function dedupeStrings(input: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseLimit(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function estimateSnapshotCount(
  windowMs: number,
  intervalSeconds: number,
  floor: number,
  ceiling: number
): number {
  const intervalMs = Math.max(intervalSeconds, 1) * 1000;
  const estimated = Math.ceil((windowMs * 1.1) / intervalMs) + 180;
  return Math.max(floor, Math.min(ceiling, estimated));
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  }
  return null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSymbolParam(raw: string | null | undefined, fallback: string): string {
  const value = raw ?? fallback;
  return value.trim().toUpperCase().replace("/", "-");
}

function coerceOverridesPatch(input: Record<string, unknown>): Partial<RuntimeOverridesInput> {
  const patch: Partial<RuntimeOverridesInput> = {};
  const boolKeys: Array<keyof RuntimeOverridesInput> = [
    "enabled",
    "allowBuy",
    "allowSell",
    "tobEnabled"
  ];
  const numberKeys: Array<keyof RuntimeOverridesInput> = [
    "levelsBuy",
    "levelsSell",
    "levelQuoteSizeUsd",
    "baseHalfSpreadBps",
    "levelStepBps",
    "minMarketSpreadBps",
    "repriceMoveBps",
    "queueRefreshSeconds",
    "tobQuoteSizeUsd",
    "targetBtcNotionalUsd",
    "maxBtcNotionalUsd",
    "skewMaxBps",
    "cashReserveUsd",
    "workingCapUsd",
    "maxActiveOrders",
    "maxActionsPerLoop",
    "ttlSeconds"
  ];

  for (const key of boolKeys) {
    if (!(key in input)) continue;
    const value = input[key];
    const parsed = parseBoolean(value);
    if (parsed === null) continue;
    (patch as Record<string, unknown>)[key] = parsed;
  }

  for (const key of numberKeys) {
    if (!(key in input)) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value)) continue;
    (patch as Record<string, unknown>)[key] = value;
  }

  return patch;
}

async function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.end(JSON.stringify(payload));
}

function renderDashboardHtml(
  maxUiEventsDefault: number,
  maxEquityPointsDefault: number,
  equitySampleMsDefault: number,
  persistEquitySeriesDefault: boolean,
  symbol: string
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>REVX-BOT CONTROL ROOM</title>
  <script>window.__REVX_HTML_LOADED__=Date.now();</script>
  <style>
    :root {
      --bg: #060b14;
      --panel: #0f1826;
      --panel-2: #131e2f;
      --line: rgba(167, 196, 228, 0.14);
      --line-strong: rgba(167, 196, 228, 0.26);
      --text: #f3f7fc;
      --muted: #8fa6c1;
      --accent: #37b4ff;
      --good: #21e3a2;
      --warn: #f4c14d;
      --bad: #ff6d7c;
      --shadow: 0 14px 30px rgba(0, 0, 0, 0.33);
      --topbar-height: 68px;
      --nav-rail-collapsed: 60px;
      --nav-rail-expanded: 240px;
      --nav-rail-width: var(--nav-rail-collapsed);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--text);
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(1000px 520px at 0% -20%, rgba(55,180,255,0.16), transparent 55%),
        radial-gradient(900px 480px at 100% 0%, rgba(33,227,162,0.08), transparent 50%),
        linear-gradient(180deg, #050a12 0%, #07101b 50%, #060b14 100%);
      min-height: 100vh;
    }

    .shell {
      width: 100%;
      max-width: none;
      margin: 0 auto;
      padding: 14px 16px 24px;
    }

    .app-layout {
      display: grid;
      grid-template-columns: var(--nav-rail-width) minmax(290px, 350px) minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      transition: grid-template-columns 200ms ease;
    }

    .app-layout.nav-expanded {
      --nav-rail-width: var(--nav-rail-expanded);
    }

    .nav-rail {
      position: sticky;
      top: calc(var(--topbar-height) + 18px);
      display: flex;
      flex-direction: column;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(10, 16, 26, 0.82);
      padding: 10px;
      box-shadow: var(--shadow);
      overflow: hidden;
      width: var(--nav-rail-width);
      min-width: 0;
      z-index: 25;
      transition: width 200ms ease;
    }

    .app-layout.nav-collapsed .nav-rail:hover {
      width: var(--nav-rail-expanded);
    }

    .nav-btn {
      width: 100%;
      text-align: left;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      justify-content: flex-start;
      text-decoration: none;
    }

    .nav-toggle {
      border: 1px solid var(--line);
      background: rgba(18, 31, 49, 0.74);
      color: var(--text);
      border-radius: 9px;
      padding: 7px 8px;
      font-size: 0.68rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }

    .nav-icon {
      width: 18px;
      min-width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: currentColor;
    }

    .nav-icon svg {
      width: 16px;
      height: 16px;
      display: block;
      fill: currentColor;
    }

    .nav-label {
      opacity: 1;
      transform: translateX(0);
      max-width: 180px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: opacity 180ms ease, transform 180ms ease, max-width 180ms ease;
    }

    .app-layout.nav-collapsed .nav-label {
      opacity: 0;
      transform: translateX(-6px);
      max-width: 0;
      pointer-events: none;
    }

    .app-layout.nav-collapsed .nav-rail:hover .nav-label {
      opacity: 1;
      transform: translateX(0);
      max-width: 180px;
    }

    .app-layout.nav-collapsed .nav-btn {
      justify-content: center;
      padding-left: 7px;
      padding-right: 7px;
    }

    .app-layout.nav-collapsed .nav-rail:hover .nav-btn {
      justify-content: flex-start;
      padding-left: 8px;
      padding-right: 8px;
    }

    .nav-divider {
      height: 1px;
      background: var(--line);
      margin: 2px 0 4px;
    }

    .nav-link-intel {
      border: 1px solid var(--line);
      background: rgba(18, 31, 49, 0.66);
      color: var(--muted);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.68rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
    }

    .nav-link-intel.active {
      color: #06101b;
      background: var(--accent);
      border-color: var(--accent);
      font-weight: 700;
    }

    .content-stack {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .intel-sidebar {
      position: sticky;
      top: calc(var(--topbar-height) + 18px);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(10, 16, 26, 0.88);
      box-shadow: var(--shadow);
      overflow: hidden;
      max-height: calc(100vh - var(--topbar-height) - 32px);
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .intel-head {
      padding: 10px 12px 6px;
      font-size: 0.75rem;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      text-transform: uppercase;
    }

    .intel-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      padding: 0 10px 8px;
    }

    .intel-tab {
      border: 1px solid var(--line);
      background: rgba(18, 31, 49, 0.8);
      color: var(--muted);
      border-radius: 8px;
      font-size: 0.68rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      padding: 5px 6px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .intel-tab.active {
      border-color: var(--accent);
      color: var(--text);
      background: rgba(55, 180, 255, 0.22);
    }

    .news-aggregate-banner {
      margin: 0 10px 8px;
      border-radius: 8px;
      border: 1px solid var(--line-strong);
      padding: 8px;
      font-size: 0.72rem;
      line-height: 1.35;
      background: rgba(16, 28, 44, 0.9);
      color: var(--text);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .news-banner-head {
      font-size: 0.72rem;
      line-height: 1.35;
      color: var(--text);
    }

    .news-banner-sub {
      margin-top: 4px;
      font-size: 0.65rem;
      line-height: 1.3;
      color: var(--muted);
      white-space: normal;
      word-break: break-word;
    }

    .news-aggregate-banner.warn {
      border-color: rgba(244, 193, 77, 0.45);
      background: rgba(67, 46, 18, 0.45);
    }

    .news-aggregate-banner.bad {
      border-color: rgba(255, 109, 124, 0.5);
      background: rgba(75, 24, 30, 0.45);
    }

    .intel-controls {
      padding: 0 10px 8px;
      display: grid;
      gap: 6px;
    }

    .intel-control-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .intel-chip {
      border: 1px solid var(--line);
      background: rgba(17, 26, 38, 0.85);
      border-radius: 999px;
      padding: 3px 7px;
      color: var(--muted);
      font-size: 0.66rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .intel-chip.active {
      border-color: var(--accent);
      color: var(--text);
      background: rgba(55, 180, 255, 0.2);
    }

    .intel-list {
      overflow-y: auto;
      padding: 0 10px 10px;
      display: grid;
      gap: 6px;
    }

    .news-row {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px;
      background: rgba(12, 22, 33, 0.85);
      display: grid;
      gap: 4px;
      text-decoration: none;
      color: var(--text);
    }

    .news-row:hover {
      border-color: var(--line-strong);
      background: rgba(18, 31, 46, 0.92);
    }

    .news-row-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 0.66rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .news-row-title {
      font-size: 0.74rem;
      line-height: 1.28;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .news-row-summary {
      font-size: 0.67rem;
      color: var(--muted);
      line-height: 1.3;
      border-top: 1px dashed var(--line);
      padding-top: 5px;
      margin-top: 2px;
    }

    .news-row-collapsible > summary {
      list-style: none;
      cursor: pointer;
      display: grid;
      gap: 4px;
    }

    .news-row-collapsible > summary::-webkit-details-marker {
      display: none;
    }

    .news-cat-chip {
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(16, 27, 40, 0.9);
      color: var(--muted);
      padding: 1px 6px;
      font-size: 0.6rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .news-source-chip {
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(21, 35, 52, 0.92);
      color: var(--muted);
      padding: 1px 6px;
      font-size: 0.6rem;
      letter-spacing: 0.03em;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .news-row-head-cluster {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    .news-row-title-link {
      color: inherit;
      text-decoration: none;
    }

    .news-row-title-link:hover {
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .impact-pill {
      border-radius: 999px;
      padding: 2px 6px;
      font-size: 0.62rem;
      border: 1px solid var(--line);
      background: rgba(19, 30, 46, 0.9);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .impact-pill.high {
      border-color: rgba(255, 109, 124, 0.55);
      color: #ffd7dd;
      background: rgba(118, 38, 50, 0.5);
    }

    .impact-pill.med {
      border-color: rgba(244, 193, 77, 0.45);
      color: #ffe8b0;
      background: rgba(88, 64, 24, 0.46);
    }

    .impact-pill.low {
      border-color: rgba(33, 227, 162, 0.35);
      color: #ccf7e7;
      background: rgba(23, 68, 56, 0.44);
    }

    .intel-empty {
      color: var(--muted);
      font-size: 0.73rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      padding: 8px 6px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      text-align: center;
    }

    .view-pane {
      min-width: 0;
    }

    .overview-shell {
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr) 340px;
      gap: 12px;
      align-items: start;
    }

    .portfolio-strip-shell {
      position: relative;
      margin: 0 0 6px;
      border-radius: 12px;
      overflow: hidden;
    }

    .portfolio-strip-shell::before,
    .portfolio-strip-shell::after {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      width: 18px;
      pointer-events: none;
      z-index: 2;
    }

    .portfolio-strip-shell::before {
      left: 0;
      background: linear-gradient(90deg, rgba(6, 11, 20, 0.95), rgba(6, 11, 20, 0));
    }

    .portfolio-strip-shell::after {
      right: 0;
      background: linear-gradient(270deg, rgba(6, 11, 20, 0.95), rgba(6, 11, 20, 0));
    }

    .kpi-strip,
    .portfolio-strip {
      position: static;
      top: auto;
      z-index: 1;
      margin: 0;
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(12, 20, 32, 0.94), rgba(10, 17, 28, 0.9));
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.22);
      padding: 8px 10px 6px;
      display: flex;
      flex-wrap: nowrap;
      gap: 8px;
      align-items: stretch;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(167, 196, 228, 0.35) rgba(255, 255, 255, 0.03);
    }

    .kpi-strip::-webkit-scrollbar,
    .portfolio-strip::-webkit-scrollbar {
      height: 7px;
    }

    .kpi-strip::-webkit-scrollbar-track,
    .portfolio-strip::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 999px;
    }

    .kpi-strip::-webkit-scrollbar-thumb,
    .portfolio-strip::-webkit-scrollbar-thumb {
      background: rgba(167, 196, 228, 0.35);
      border-radius: 999px;
    }

    /* Tweak min-width values here if tile content needs more room. */
    .strip-cell {
      flex: 0 0 auto;
      min-width: 220px;
    }

    .strip-cell {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.015);
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .strip-cell-wide {
      min-width: 320px;
    }

    .strip-cell-gates {
      min-width: 290px;
    }

    .strip-cell-book {
      min-width: 285px;
    }

    .strip-title {
      color: var(--muted);
      font-size: 0.62rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .strip-value {
      font-size: 0.82rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .strip-toggle {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      margin-top: 2px;
    }

    .strip-gates {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: nowrap;
    }

    .operate-grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 12px;
      align-items: start;
    }

    .col-12 { grid-column: span 12; }
    .col-8 { grid-column: span 8; }
    .col-6 { grid-column: span 6; }
    .col-4 { grid-column: span 4; }

    .primary-chart-shell {
      position: relative;
    }

    .primary-tooltip {
      position: absolute;
      display: none;
      min-width: 220px;
      pointer-events: none;
      background: rgba(8, 14, 24, 0.96);
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      padding: 8px 10px;
      box-shadow: var(--shadow);
      color: var(--text);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.68rem;
      line-height: 1.45;
      z-index: 8;
      white-space: nowrap;
    }

    .panel-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      align-items: start;
    }

    .panel-left {
      min-width: 0;
    }

    .panel-right {
      min-width: 0;
      display: grid;
      gap: 12px;
    }

    .panel-right-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.015);
      padding: 10px;
      min-width: 0;
    }

    .right-table-wrap {
      max-height: 380px;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(3, 8, 16, 0.45);
    }

    .overview-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .insight-rail {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      position: sticky;
      top: 88px;
    }

    .mission-bar {
      position: sticky;
      top: 0;
      left: auto;
      transform: none;
      width: 100%;
      z-index: 80;
      margin: 0;
      background: linear-gradient(180deg, rgba(16,26,39,0.97), rgba(10,17,28,0.96));
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(12px);
      min-height: var(--topbar-height);
      padding: 8px 10px;
      overflow: hidden;
    }

    .topbar-spacer {
      height: 8px;
    }

    .mission-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 42px;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(167, 196, 228, 0.35) transparent;
    }

    .mission-venue-row {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(167, 196, 228, 0.35) transparent;
    }

    .header-venue-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid rgba(167, 196, 228, 0.24);
      border-radius: 999px;
      padding: 3px 8px;
      background: rgba(255, 255, 255, 0.015);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.6rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
      color: #cfe0f5;
    }

    .header-venue-chip .venue-label {
      color: var(--muted);
    }

    .header-venue-chip.stale {
      border-color: rgba(244, 193, 77, 0.7);
      color: #ffdca3;
    }

    .header-venue-chip.err {
      border-color: rgba(255, 109, 124, 0.72);
      color: #ffc2cb;
    }

    .mission-cluster {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.015);
      padding: 6px 8px;
      min-height: 34px;
      flex: 0 0 auto;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.66rem;
      letter-spacing: 0.03em;
    }

    .mission-left {
      min-width: 235px;
      justify-content: flex-start;
    }

    .mission-market {
      min-width: 290px;
      justify-content: flex-start;
    }

    .mission-cross {
      min-width: 300px;
      justify-content: flex-start;
    }

    .mission-status {
      min-width: 280px;
      justify-content: flex-start;
      gap: 5px;
    }

    .mission-actions {
      min-width: 150px;
      justify-content: flex-end;
      margin-left: auto;
    }

    .brand-mini {
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .run-mini {
      color: var(--muted);
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .market-kv {
      color: var(--muted);
      text-transform: uppercase;
    }

    .market-v {
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }

    .status-chip {
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      padding: 3px 8px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      text-transform: uppercase;
      font-size: 0.62rem;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }

    #headerQuoteReasons {
      max-width: 380px;
      overflow: hidden;
      text-overflow: ellipsis;
      text-transform: none;
      letter-spacing: 0.02em;
    }

    .status-chip.active-warn {
      border-color: rgba(244, 193, 77, 0.7);
      color: #ffdca3;
    }

    .status-chip.active-good {
      border-color: rgba(33, 227, 162, 0.72);
      color: #c7f5e5;
    }

    .status-chip.active-bad {
      border-color: rgba(255, 109, 124, 0.72);
      color: #ffc2cb;
    }

    .btn-icon {
      min-width: 34px;
      padding: 6px 8px;
      line-height: 1;
      font-size: 0.7rem;
      border-radius: 9px;
    }

    .btn-icon.active {
      border-color: rgba(244, 193, 77, 0.75);
      color: #ffdca3;
    }

    .venue-strip {
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(12, 20, 32, 0.94), rgba(10, 17, 28, 0.9));
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.22);
      padding: 8px 10px;
      margin-bottom: 10px;
    }

    .venue-strip-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 7px;
      flex-wrap: wrap;
    }

    .venue-strip-head h3 {
      margin: 0;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .venue-filter {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .venue-filter select {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.03);
      color: var(--text);
      padding: 4px 10px;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.65rem;
    }

    .venue-chip-row {
      display: flex;
      gap: 7px;
      align-items: stretch;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(167, 196, 228, 0.35) transparent;
      padding-bottom: 2px;
    }

    .venue-chip {
      min-width: 230px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.015);
      padding: 6px 8px;
      display: grid;
      gap: 3px;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.62rem;
      color: var(--text);
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
    }

    .venue-chip .venue-line {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .venue-chip .quote-line {
      color: var(--text);
    }

    .venue-chip .meta-line {
      color: var(--muted);
    }

    .venue-chip.stale {
      border-color: rgba(244, 193, 77, 0.6);
      background: rgba(244, 193, 77, 0.08);
    }

    .venue-chip.err {
      border-color: rgba(255, 109, 124, 0.65);
      background: rgba(255, 109, 124, 0.08);
    }

    .exec-strip {
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(12, 20, 32, 0.9), rgba(10, 17, 28, 0.88));
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.22);
      padding: 8px 10px;
      margin-bottom: 10px;
    }

    .exec-title {
      margin: 0 0 7px;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .exec-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 7px;
      margin-bottom: 6px;
    }

    .exec-metric {
      border: 1px solid var(--line);
      border-radius: 9px;
      padding: 6px 8px;
      background: rgba(255,255,255,0.015);
      min-width: 0;
    }

    .exec-k {
      color: var(--muted);
      text-transform: uppercase;
      font-size: 0.58rem;
      letter-spacing: 0.07em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      margin-bottom: 4px;
    }

    .exec-v {
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.72rem;
      color: var(--text);
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .exec-banner {
      border: 1px solid rgba(244, 193, 77, 0.65);
      border-radius: 10px;
      background: rgba(244, 193, 77, 0.12);
      color: #ffe0a4;
      padding: 8px;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.68rem;
      line-height: 1.35;
      display: none;
      white-space: normal;
    }

    .header-grid {
      height: 100%;
      display: grid;
      grid-template-columns: 360px minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .header-left {
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
    }

    .header-center {
      min-width: 0;
      overflow: hidden;
    }

    .header-right {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(167, 196, 228, 0.3) transparent;
    }

    .header-meta-row {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      white-space: nowrap;
    }

    .brand-title {
      margin: 0;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.84rem;
      line-height: 1.1;
    }

    .brand-sub {
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.64rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .market-strip {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.02);
      display: flex;
      align-items: center;
      padding: 0 8px;
      min-width: 0;
      overflow: hidden;
    }

    .quote-tape {
      min-width: 0;
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(167, 196, 228, 0.35) transparent;
      padding-bottom: 0;
      white-space: nowrap;
      flex-wrap: nowrap;
    }

    .ticker {
      min-width: 0;
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(167, 196, 228, 0.35) transparent;
    }

    .quote-tape::-webkit-scrollbar {
      height: 5px;
    }

    .quote-tape::-webkit-scrollbar-thumb {
      background: rgba(167, 196, 228, 0.35);
      border-radius: 999px;
    }

    .quote-chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      background: rgba(255, 255, 255, 0.01);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.6rem;
      letter-spacing: 0.04em;
      white-space: nowrap;
      color: var(--text);
      max-width: 360px;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 0 0 auto;
    }

    .quote-chip[data-error="1"] {
      border-color: rgba(255, 109, 124, 0.4);
      color: #f2b3bc;
    }

    .quote-chip .venue {
      color: var(--muted);
      text-transform: uppercase;
      margin-right: 2px;
    }

    .ticker .seg {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.01);
      color: var(--text);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.6rem;
      letter-spacing: 0.04em;
      padding: 3px 8px;
      white-space: nowrap;
      max-width: 420px;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 0 0 auto;
    }

    .ticker .seg.ok {
      border-color: rgba(33, 227, 162, 0.42);
      color: #c7f5e5;
    }

    .ticker .seg.stale {
      border-color: rgba(244, 193, 77, 0.52);
      color: #ffdca3;
    }

    .ticker .seg.err {
      border-color: rgba(255, 109, 124, 0.52);
      color: #ffc2cb;
    }

    .top-pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.01);
      min-width: 48px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .chip {
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 0 0 auto;
    }

    .meta-key {
      color: var(--muted);
      font-size: 0.58rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      margin: 0;
    }

    .meta-val {
      font-size: 0.66rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-toggle-btn {
      min-width: 34px;
      padding: 6px 8px;
      font-size: 0.76rem;
      line-height: 1;
    }

    .mission-right {
      display: contents;
    }

    .pill {
      border-radius: 999px;
      padding: 4px 8px;
      border: 1px solid var(--line-strong);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.64rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .dot.live { background: var(--good); box-shadow: 0 0 0 5px rgba(33, 227, 162, 0.18); }
    .dot.warn { background: var(--warn); box-shadow: 0 0 0 5px rgba(255, 205, 92, 0.2); }
    .dot.dead { background: var(--bad); box-shadow: 0 0 0 5px rgba(255, 109, 124, 0.18); }

    .btn {
      border: 1px solid var(--line-strong);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 0.64rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      transition: 160ms ease;
      flex: 0 0 auto;
    }

    .btn:hover { border-color: rgba(55, 180, 255, 0.75); color: #fff; }
    .btn.warn { border-color: rgba(244, 193, 77, 0.48); }
    .btn.bad { border-color: rgba(255, 109, 124, 0.6); }

    .debug-overlay {
      display: none;
    }

    .debug-toggle {
      pointer-events: auto;
      border: 1px solid rgba(167, 196, 228, 0.32);
      border-radius: 999px;
      background: rgba(5, 10, 18, 0.86);
      color: rgba(243, 247, 252, 0.88);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 11px;
      padding: 4px 8px;
      line-height: 1.1;
      cursor: pointer;
    }

    .debug-panel {
      width: 100%;
      border: 1px solid rgba(167, 196, 228, 0.28);
      border-radius: 10px;
      background: rgba(5, 10, 18, 0.82);
      color: rgba(243, 247, 252, 0.9);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 11px;
      overflow: hidden;
      backdrop-filter: blur(8px);
    }

    .debug-panel.collapsed .debug-details {
      display: none;
    }

    .debug-strip {
      margin: 0;
      padding: 5px 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-height: 24px;
      line-height: 1.2;
    }

    .debug-details {
      margin: 0;
      padding: 8px;
      border-top: 1px solid rgba(167, 196, 228, 0.18);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
      overflow: auto;
      color: rgba(210, 226, 244, 0.9);
    }

    .debug-strip .bad { color: #ffb2bd; }
    .debug-strip .ok { color: #a8f4d6; }
    .debug-strip .muted { color: #8fa6c1; }
    .debug-strip .mono {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 520px;
      min-width: 0;
    }

    .debug-drawer {
      margin-top: 0;
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 110;
      width: min(620px, calc(100vw - 28px));
      border: 1px solid rgba(167, 196, 228, 0.28);
      border-radius: 10px;
      background: rgba(5, 10, 18, 0.82);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }

    .debug-drawer > summary {
      cursor: pointer;
      list-style: none;
      padding: 6px 10px;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.63rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      border-bottom: 1px solid rgba(167, 196, 228, 0.14);
    }

    .debug-drawer > summary::-webkit-details-marker {
      display: none;
    }

    .grid-kpi {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 0;
    }

    .view-tabs {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px;
      margin: 0 0 10px;
      background: rgba(255, 255, 255, 0.02);
    }

    .view-tab {
      border: 0;
      background: transparent;
      color: var(--muted);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.68rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
    }

    .view-tab.active {
      color: #06101b;
      background: var(--accent);
      font-weight: 700;
    }

    .kpi-card {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 45%), var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      box-shadow: var(--shadow);
      min-width: 0;
    }

    .kpi-key {
      font-family: "IBM Plex Mono", "Menlo", monospace;
      color: var(--muted);
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }

    .kpi-info {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 1px solid var(--line-strong);
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      cursor: help;
    }

    .kpi-val {
      font-size: 1.16rem;
      font-weight: 700;
      line-height: 1.1;
    }

    .kpi-sub {
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.73rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .panel {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 45%), var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 12px;
      min-width: 0;
    }

    .panel-title {
      margin: 0;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.76rem;
      color: var(--muted);
    }

    .pnl-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }

    .pnl-main {
      font-size: 1.3rem;
      font-weight: 700;
    }

    .pnl-meta {
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.76rem;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .toggle-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }

    .toggle-btn {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.02);
      color: var(--muted);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.7rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .toggle-btn.active {
      color: #06101b;
      background: var(--accent);
      border-color: rgba(55, 180, 255, 0.85);
      font-weight: 700;
    }

    .gate-row {
      margin: 8px 0;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .gate-chip {
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      padding: 4px 10px;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.68rem;
      cursor: pointer;
      background: rgba(255,255,255,0.02);
    }

    .gate-chip.ok { border-color: rgba(33, 227, 162, 0.5); color: #9ff2d3; }
    .gate-chip.block { border-color: rgba(255, 109, 124, 0.58); color: #ffc3cb; }

    .gate-line {
      width: 100%;
      color: var(--muted);
      font-size: 0.75rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .gate-details {
      display: none;
      width: 100%;
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 8px;
      color: var(--muted);
      font-size: 0.73rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: normal;
      word-break: break-word;
    }

    .chart-wrap {
      width: 100%;
      height: 300px;
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.005));
    }

    #pnlChart { width: 100%; height: 100%; display: block; }
    #primaryChart { width: 100%; height: 100%; display: block; }
    #equityChart { width: 100%; height: 100%; display: block; }
    #compositionChart { width: 100%; height: 100%; display: block; }

    .equity-chart-shell {
      position: relative;
      margin-top: 8px;
    }

    .chart-tooltip {
      position: absolute;
      display: none;
      min-width: 220px;
      max-width: 300px;
      pointer-events: none;
      transform: translate(-50%, -100%);
      background: rgba(8, 14, 24, 0.96);
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      padding: 8px 10px;
      box-shadow: var(--shadow);
      color: var(--text);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.68rem;
      line-height: 1.45;
      z-index: 8;
      white-space: nowrap;
    }

    .equity-sub {
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.72rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .bottom-grid {
      margin-top: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .events-panel { margin-top: 12px; }

    .table-wrap {
      width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(3, 8, 16, 0.45);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
      font-size: 0.86rem;
    }

    th, td {
      border-bottom: 1px solid var(--line);
      padding: 8px 8px;
      white-space: nowrap;
      text-align: left;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.74rem;
    }

    th {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 500;
      position: sticky;
      top: 0;
      background: rgba(14, 23, 36, 0.95);
    }

    tbody tr {
      transition: background-color 120ms ease;
    }

    tbody tr:hover {
      background: rgba(55, 180, 255, 0.08);
    }

    .side-buy { color: #7ad7ff; font-weight: 700; }
    .side-sell { color: #ffb2bd; font-weight: 700; }

    .copy-btn {
      margin-left: 6px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--muted);
      border-radius: 6px;
      font-size: 10px;
      padding: 1px 4px;
      cursor: pointer;
    }

    .orders-segment {
      margin: 6px 0 8px;
      gap: 6px;
    }

    .orders-summary-line {
      margin-bottom: 8px;
    }

    .order-row-pending {
      opacity: 0.72;
    }

    .order-row-stale {
      opacity: 0.6;
    }

    .order-status-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.66rem;
    }

    .orders-fade {
      transition: opacity 140ms ease;
      will-change: opacity;
    }

    .orders-fade.is-updating {
      opacity: 0.72;
    }

    .event-filters {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 8px;
      align-items: center;
    }

    .event-pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.02);
      color: var(--muted);
      padding: 4px 9px;
      font-size: 0.66rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
    }

    .event-pill.active {
      color: #06101b;
      background: var(--accent);
      border-color: rgba(55, 180, 255, 0.9);
      font-weight: 700;
    }

    .event-limit-label {
      color: var(--muted);
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      margin-left: 8px;
    }

    .event-limit-select {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.02);
      color: var(--text);
      padding: 4px 10px;
      font-size: 0.68rem;
      letter-spacing: 0.05em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      outline: none;
      cursor: pointer;
    }

    .event-info {
      margin-left: auto;
      color: var(--muted);
      font-size: 0.68rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    #eventStoredInfo {
      margin-left: 6px;
    }

    .badge {
      display: inline-flex;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 2px 8px;
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .b-placed { border-color: rgba(55, 180, 255, 0.7); color: #8ad5ff; }
    .b-cancelled { border-color: rgba(244, 193, 77, 0.7); color: #ffd98f; }
    .b-filled { border-color: rgba(33, 227, 162, 0.7); color: #a8f4d6; }
    .b-replaced { border-color: rgba(191, 155, 255, 0.7); color: #dbc5ff; }
    .b-seed { border-color: rgba(244, 193, 77, 0.7); color: #ffd98f; }
    .b-rejected { border-color: rgba(255, 156, 109, 0.7); color: #ffd1b7; }
    .b-override { border-color: rgba(55, 180, 255, 0.7); color: #8ad5ff; }
    .b-error { border-color: rgba(255, 109, 124, 0.7); color: #ffc3cb; }
    .ovr-diff-row-ok td {
      background: rgba(33, 227, 162, 0.08);
      color: #bff4de;
    }
    .ovr-diff-row-adjusted td {
      background: rgba(244, 193, 77, 0.12);
      color: #ffe0a4;
    }
    .ovr-diff-status-ok {
      border-color: rgba(33, 227, 162, 0.7);
      color: #bff4de;
    }
    .ovr-diff-status-adjusted {
      border-color: rgba(244, 193, 77, 0.75);
      color: #ffe0a4;
    }

    .chip-row {
      margin-top: 4px;
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
    }

    .tiny-chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 0.6rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .roadmap-grid {
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .roadmap-col {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.015);
      min-width: 0;
    }

    .roadmap-col h4 {
      margin: 0 0 8px;
      font-size: 0.78rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #d3e8ff;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .roadmap-col ul {
      margin: 0;
      padding-left: 16px;
      color: var(--muted);
      font-size: 0.76rem;
      line-height: 1.45;
    }

    .readiness {
      margin-top: 10px;
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 8px;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.73rem;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 10px;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 12, 0.72);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 120;
      padding: 20px;
    }

    .modal {
      width: min(430px, 100%);
      background: #0d1726;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 14px;
    }

    .modal h3 {
      margin: 0 0 8px;
      font-size: 1rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .modal p {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.45;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    input[type="range"] {
      width: 100%;
      margin: 4px 0 10px;
      accent-color: var(--accent);
    }

    @media (max-width: 1180px) {
      :root { --topbar-height: 58px; }
      .mission-row { gap: 6px; }
      .mission-venue-row { margin-top: 5px; gap: 5px; }
      .mission-cluster { padding: 5px 7px; }
      .mission-left { min-width: 215px; }
      .mission-market { min-width: 265px; }
      .mission-cross { min-width: 275px; }
      .mission-status { min-width: 250px; }
      .exec-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .portfolio-strip { position: static; }
      .app-layout {
        grid-template-columns: 1fr;
        --nav-rail-width: 100%;
      }
      .nav-rail {
        position: static;
        flex-direction: row;
        flex-wrap: wrap;
        width: 100%;
      }
      .intel-sidebar { position: static; max-height: none; }
      .nav-btn { width: auto; text-align: center; }
      .app-layout.nav-collapsed .nav-label { opacity: 1; transform: none; max-width: 180px; pointer-events: auto; }
      .app-layout.nav-collapsed .nav-btn { justify-content: flex-start; }
      .overview-shell { grid-template-columns: 1fr; }
      .insight-rail { position: static; }
      .grid-kpi { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .roadmap-grid { grid-template-columns: 1fr; }
      .bottom-grid { grid-template-columns: 1fr; }
      .operate-grid { grid-template-columns: 1fr; }
      .panel-split { grid-template-columns: 1fr; }
      .col-12, .col-8, .col-6, .col-4 { grid-column: span 1; }
    }

    @media (max-width: 760px) {
      .shell { padding: 10px; }
      .mission-row { gap: 5px; }
      .mission-venue-row { gap: 4px; }
      .grid-kpi { grid-template-columns: 1fr; }
      .chart-wrap { height: 220px; }
      .nav-rail { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); }
      .nav-toggle { grid-column: span 2; }
      .intel-tabs { grid-template-columns: repeat(3, minmax(0,1fr)); }
      .exec-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .debug-drawer {
        right: 8px;
        bottom: 8px;
        width: calc(100vw - 16px);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="mission-bar app-bar compact" id="missionBar">
      <div class="mission-row">
        <div class="mission-cluster mission-left">
          <span class="brand-mini">REVX-BOT</span>
          <span class="market-kv">SYMBOL</span>
          <span class="market-v" id="headerLeftSymbol">-</span>
          <span class="market-kv">RUN</span>
          <span class="run-mini" id="missionRunId">-</span>
        </div>
        <div class="mission-cluster mission-market">
          <span class="market-kv">REVX</span>
          <span class="market-v" id="headerRevxBid">B -</span>
          <span class="market-v" id="headerRevxAsk">A -</span>
          <span class="market-v" id="headerRevxMid">M -</span>
          <span class="market-v" id="headerRevxSpread">SPR -</span>
        </div>
        <div class="mission-cluster mission-cross">
          <span class="market-kv">CROSS</span>
          <span class="market-v" id="headerBestBid">best bid -</span>
          <span class="market-v" id="headerBestAsk">best ask -</span>
          <span class="market-v" id="headerFairMid">fair -</span>
        </div>
        <div class="mission-cluster mission-status">
          <span class="status-chip" id="connectionPill"><span class="dot dead" id="connectionDot"></span><span id="headerStatusConnected">disconnected</span></span>
          <span class="status-chip">MODE <span id="headerMode">-</span></span>
          <span class="status-chip" id="feesChip" title="Configured maker/taker fees (bps)">FEES <span id="headerFees">Maker/Taker -/- bps</span></span>
          <span class="status-chip" id="regimeChip">REGIME <span id="headerRegime">-</span></span>
          <span class="status-chip" id="biasChip">BIAS <span id="headerBias">-</span></span>
          <span class="status-chip" id="newsChip">SIG <span id="headerNews">NORMAL 0.00•</span></span>
          <span class="status-chip" id="quotePill" title="QUOTE">QUOTE <span id="headerQuoteState">-</span></span>
          <span class="status-chip" id="quotePlanPill">planned: <span id="headerQuotePlan">B0/S0/TOB:OFF</span></span>
          <span class="status-chip" id="seedBadge">SEED <span id="headerSeed">-</span></span>
          <span class="status-chip" id="headerQuoteReasons">Quoting: -</span>
          <span class="status-chip" id="pausedFlag">paused <span id="headerPaused">no</span></span>
          <span class="status-chip" id="killFlag">kill <span id="headerKill">no</span></span>
        </div>
        <div class="mission-cluster mission-actions">
          <button class="btn btn-icon" id="pauseBtn" title="Pause/Resume quoting">⏸</button>
          <button class="btn btn-icon warn" id="cancelBtn" title="Cancel all bot orders (Shortcut: C)">✖</button>
          <button class="btn btn-icon bad" id="killBtn" title="Kill quoting and cancel all">☠</button>
          <button class="btn btn-icon" id="debugToggle" type="button" title="Toggle debug diagnostics">DBG</button>
        </div>
      </div>
      <div class="mission-venue-row" id="headerVenueQuotesRow"></div>
    </header>
    <div class="topbar-spacer" id="topbarSpacer"></div>
    <section class="venue-strip">
      <div class="venue-strip-head">
        <h3>Venue Quotes</h3>
        <label class="venue-filter">
          <span>Show:</span>
          <select id="venueQuotesFilter">
            <option value="all">All</option>
            <option value="active">Only active</option>
            <option value="stale">Only stale/errors</option>
          </select>
        </label>
      </div>
      <div class="venue-chip-row" id="venueQuotesStrip"></div>
    </section>
    <section class="exec-strip" id="executionCard">
      <h3 class="exec-title">Execution</h3>
      <div class="exec-grid">
        <article class="exec-metric">
          <div class="exec-k">Fills (1h / 24h)</div>
          <div class="exec-v" id="execFills">-</div>
        </article>
        <article class="exec-metric">
          <div class="exec-k">Last Fill</div>
          <div class="exec-v" id="execLastFill">-</div>
        </article>
        <article class="exec-metric">
          <div class="exec-k">Active Orders</div>
          <div class="exec-v" id="execActiveOrders">-</div>
        </article>
        <article class="exec-metric">
          <div class="exec-k">Post-only Rejects 1h</div>
          <div class="exec-v" id="execRejects1h">-</div>
        </article>
        <article class="exec-metric">
          <div class="exec-k">Avg Resting 1h</div>
          <div class="exec-v" id="execAvgRest1h">-</div>
        </article>
      </div>
      <div class="exec-banner" id="execNoFillsBanner">No fills yet.</div>
    </section>
    <section class="exec-strip" id="whyPanel" style="margin-top:8px;">
      <h3 class="exec-title">Why Not Trading?</h3>
      <div class="exec-banner" id="alwaysOnBanner" style="display:none;"></div>
      <div class="kpi-sub" id="whyNowAction">-</div>
      <div class="kpi-sub" id="reentryPanelLine">Re-Entry: -</div>
      <div class="kpi-sub" id="whyIntelCommentary">Intel: -</div>
      <div class="chip-row" id="whyNotList"></div>
    </section>
    <div class="portfolio-strip-shell">
    <section class="portfolio-strip kpi-strip" id="portfolioStrip">
      <article class="strip-cell">
        <div class="strip-title">Total Equity</div>
        <div class="strip-value" id="stripEquity">-</div>
        <div class="strip-toggle">
          <button class="toggle-btn portfolio-equity-btn active" data-equity-mode="USD">USD</button>
          <button class="toggle-btn portfolio-equity-btn" data-equity-mode="BTC">BTC</button>
        </div>
      </article>
      <article class="strip-cell">
        <div class="strip-title">USD Free / Total</div>
        <div class="strip-value" id="stripUsd">-</div>
      </article>
      <article class="strip-cell">
        <div class="strip-title">BTC Free / Total</div>
        <div class="strip-value" id="stripBtc">-</div>
      </article>
      <article class="strip-cell">
        <div class="strip-title">Active Bot Orders</div>
        <div class="strip-value" id="stripActiveOrders">-</div>
      </article>
      <article class="strip-cell">
        <div class="strip-title">BTC Notional / Inventory Ratio</div>
        <div class="strip-value" id="stripInventory">-</div>
      </article>
      <article class="strip-cell strip-cell-gates">
        <div class="strip-title">Gates</div>
        <div class="strip-gates">
          <button class="gate-chip" id="buyGateChip" data-gate="buy">Buy: -</button>
          <button class="gate-chip" id="sellGateChip" data-gate="sell">Sell: -</button>
        </div>
        <div class="kpi-sub" id="gateLine">Buy: - | Sell: -</div>
      </article>
      <article class="strip-cell strip-cell-book">
        <div class="strip-title">Best Active BUY</div>
        <div class="strip-value" id="stripBestBid">-</div>
      </article>
      <article class="strip-cell strip-cell-book">
        <div class="strip-title">Best Active SELL</div>
        <div class="strip-value" id="stripBestAsk">-</div>
      </article>
      <article class="strip-cell strip-cell-wide">
        <div class="strip-title">Runtime Overrides</div>
        <div class="strip-value" id="stripOverrides">none</div>
        <div class="chip-row" id="overrideChips"></div>
        <div class="kpi-sub" id="overrideMeta">-</div>
        <div class="toggle-row">
          <button class="btn" id="clearOverridesStripBtn">Clear</button>
        </div>
      </article>
    </section>
    </div>
    <div class="gate-details" id="gateDetails"></div>

    <div class="app-layout" id="appLayout">
      <aside class="nav-rail" id="navRail">
        <button class="nav-toggle nav-btn" id="navRailToggle" type="button" aria-pressed="false" title="Toggle navigation rail">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"/></svg></span>
          <span class="nav-label">Navigation</span>
        </button>
        <button class="view-tab active nav-btn" data-view="operate" title="Operate">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 12l9-8 9 8v8h-7v-6h-4v6H3v-8z"/></svg></span>
          <span class="nav-label">Operate</span>
        </button>
        <button class="view-tab nav-btn" data-view="overrides" title="Overrides">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.49 7.49 0 0 0 .05-.94 7.49 7.49 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.24 7.24 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.68 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.51.4 1.05.72 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.24 7.24 0 0 0 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg></span>
          <span class="nav-label">Overrides</span>
        </button>
        <button class="view-tab nav-btn" data-view="diagnose" title="Diagnose">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M11 2h2v3h-2V2zm0 17h2v3h-2v-3zM2 11h3v2H2v-2zm17 0h3v2h-3v-2zM5.64 4.22l1.41-1.41 2.12 2.12-1.41 1.41-2.12-2.12zm9.19 13.02 1.41-1.41 2.12 2.12-1.41 1.41-2.12-2.12zM4.22 18.36l2.12-2.12 1.41 1.41-2.12 2.12-1.41-1.41zm13.02-9.19 2.12-2.12 1.41 1.41-2.12 2.12-1.41-1.41zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg></span>
          <span class="nav-label">Diagnose</span>
        </button>
        <button class="view-tab nav-btn" data-view="optimize" title="Optimize">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 17h2v4H3v-4zm4-6h2v10H7V11zm4 3h2v7h-2v-7zm4-8h2v15h-2V6zm4 5h2v10h-2V11z"/></svg></span>
          <span class="nav-label">Optimize</span>
        </button>
        <button class="view-tab nav-btn" data-view="audit" title="Audit">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM8 12h8v1.5H8V12zm0 4h8v1.5H8V16zm0-8h4v1.5H8V8z"/></svg></span>
          <span class="nav-label">Audit</span>
        </button>
        <div class="nav-divider"></div>
        <a class="nav-btn nav-link-intel" id="navIntelLink" href="/intel" title="Open Intel page">
          <span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 3h18v18H3V3zm2 2v14h14V5H5zm2 10h3v2H7v-2zm0-4h5v2H7v-2zm0-4h10v2H7V7z"/></svg></span>
          <span class="nav-label">Intel</span>
        </a>
      </aside>

      <aside class="intel-sidebar" id="intelSidebar">
        <div class="intel-head">Intel Feed</div>
        <div class="intel-tabs">
          <button class="intel-tab active" data-intel-tab="signals">Intel</button>
          <button class="intel-tab" data-intel-tab="events">Events</button>
          <button class="intel-tab" data-intel-tab="orders">Orders</button>
        </div>
        <div class="news-aggregate-banner" id="newsAggregateBanner">
          <div class="news-banner-head" id="newsAggregateHeadline">Intel: NORMAL — feed idle</div>
          <div class="news-banner-sub" id="newsAggregateDrivers">Top drivers: -</div>
          <div class="news-banner-sub" id="newsAggregateProviders">Providers: -</div>
        </div>
        <div class="intel-controls" id="newsControls">
          <div class="intel-control-row">
            <button class="intel-chip active" data-signal-kind="all">All</button>
            <button class="intel-chip" data-signal-kind="NEWS">News</button>
            <button class="intel-chip" data-signal-kind="MACRO">Macro</button>
            <button class="intel-chip" data-signal-kind="SYSTEM">System</button>
          </div>
          <div class="intel-control-row">
            <button class="intel-chip active" data-news-cat="all">All</button>
            <button class="intel-chip" data-news-cat="risk">Risk</button>
            <button class="intel-chip" data-news-cat="war">War</button>
            <button class="intel-chip" data-news-cat="rates">Rates</button>
            <button class="intel-chip" data-news-cat="inflation">Infl</button>
            <button class="intel-chip" data-news-cat="crypto">Crypto</button>
            <button class="intel-chip" data-news-cat="regulation">Reg</button>
            <button class="intel-chip" data-news-cat="exchange">Exch</button>
            <button class="intel-chip" data-news-cat="oil">Oil</button>
          </div>
          <div class="intel-control-row">
            <button class="intel-chip active" data-news-impact="all">All</button>
            <button class="intel-chip" data-news-impact="med">Med+</button>
            <button class="intel-chip" data-news-impact="high">High</button>
          </div>
        </div>
        <div class="intel-list" id="intelList"></div>
      </aside>

      <main class="content-stack">
        <section id="operateView" class="view-pane">
          <section class="operate-grid">
            <article class="panel col-12">
              <div class="panel-split">
                <div class="panel-left">
                  <div class="pnl-head">
                    <h2 class="panel-title">Equity & PnL</h2>
                    <div class="toggle-row">
                      <button class="toggle-btn primary-chart-btn active" data-primary-chart="equity">Equity</button>
                      <button class="toggle-btn primary-chart-btn" data-primary-chart="pnl">PnL</button>
                      <button class="toggle-btn drawdown-toggle-btn active" data-dd-mode="abs">DD Abs</button>
                      <button class="toggle-btn drawdown-toggle-btn" data-dd-mode="pct">DD %</button>
                    </div>
                  </div>
                  <div class="pnl-meta">
                    <span id="equityNow">-</span>
                    <span id="equityRange">USD range -</span>
                    <span id="equitySpan">-</span>
                    <span id="pnlNow">PnL -</span>
                    <span id="pnlRange">24H range -</span>
                    <span id="pnlSpan">-</span>
                  </div>
                  <div class="toggle-row" id="windowToggles">
                    <button class="toggle-btn active" data-window="24h">24H</button>
                    <button class="toggle-btn" data-window="12h">12H</button>
                    <button class="toggle-btn" data-window="4h">4H</button>
                    <button class="toggle-btn" data-window="1h">1H</button>
                    <button class="toggle-btn" data-window="15m">15M</button>
                    <button class="toggle-btn equity-window-btn active" data-equity-window="24h">Eq 24H</button>
                    <button class="toggle-btn equity-window-btn" data-equity-window="12h">Eq 12H</button>
                    <button class="toggle-btn equity-window-btn" data-equity-window="4h">Eq 4H</button>
                    <button class="toggle-btn equity-window-btn" data-equity-window="1h">Eq 1H</button>
                    <button class="toggle-btn equity-window-btn" data-equity-window="15m">Eq 15M</button>
                  </div>
                  <div class="primary-chart-shell" id="primaryChartShell">
                    <div class="chart-wrap" style="height:300px;">
                      <svg id="primaryChart" viewBox="0 0 1200 360" preserveAspectRatio="none"></svg>
                    </div>
                    <div class="primary-tooltip" id="primaryTooltip"></div>
                  </div>
                  <div class="equity-sub">
                    <span id="compositionLegend">USD total - | BTC notional -</span>
                    <span id="drawdownSummary">Max DD: -</span>
                    <span id="kpiRealized">-</span>
                    <span id="kpiFills1h">-</span>
                    <span id="kpiEdge">-</span>
                  </div>
                </div>
                <div class="panel-right">
                  <article class="panel-right-card">
                    <h3 class="panel-title">Portfolio Balances</h3>
                    <div class="right-table-wrap">
                      <table>
                        <thead><tr><th>Asset</th><th>Free</th><th>Total</th></tr></thead>
                        <tbody id="balancesBodyRight"></tbody>
                      </table>
                    </div>
                  </article>
                  <article class="panel-right-card">
                    <h3 class="panel-title">Active Bot Orders</h3>
                    <div class="toggle-row orders-segment" id="ordersViewControls">
                      <button class="toggle-btn order-view-btn active" data-order-view="open">OPEN</button>
                      <button class="toggle-btn order-view-btn" data-order-view="pending">PENDING</button>
                      <button class="toggle-btn order-view-btn" data-order-view="all">ALL</button>
                    </div>
                    <div class="kpi-sub orders-summary-line" id="ordersSummaryLine">Open on venue: - | Pending: - | Total tracked: -</div>
                    <div class="right-table-wrap">
                      <table>
                        <thead><tr><th>Client ID</th><th>Side</th><th>Price</th><th>Quote</th><th>Status</th><th>Age</th><th>Updated</th></tr></thead>
                        <tbody id="ordersBodyRight"></tbody>
                      </table>
                    </div>
                  </article>
                  <article class="panel-right-card">
                    <h3 class="panel-title">Top Of Book Summary</h3>
                    <div class="kpi-sub" id="rightBestBid">Best BUY: -</div>
                    <div class="kpi-sub" id="rightBestAsk">Best SELL: -</div>
                  </article>
                </div>
              </div>
            </article>

            <article class="panel col-4">
              <h3 class="panel-title">Drawdown</h3>
              <div class="chart-wrap" style="height:220px; margin-top:8px;">
                <svg id="drawdownMainChart" viewBox="0 0 1200 240" preserveAspectRatio="none"></svg>
              </div>
              <div class="kpi-sub" id="drawdownMainSummary">-</div>
            </article>

            <article class="panel col-4">
              <h3 class="panel-title">Fills Cadence (5m bins)</h3>
              <div class="chart-wrap" style="height:220px; margin-top:8px;">
                <svg id="fillsCadenceChart" viewBox="0 0 1200 240" preserveAspectRatio="none"></svg>
              </div>
              <div class="kpi-sub" id="fillsCadenceSummary">-</div>
            </article>

            <article class="panel col-4">
              <h3 class="panel-title">Edge Histogram</h3>
              <div class="chart-wrap" style="height:220px; margin-top:8px;">
                <svg id="edgeHistogramChart" viewBox="0 0 1200 240" preserveAspectRatio="none"></svg>
              </div>
              <div class="kpi-sub" id="edgeHistogramSummary">-</div>
            </article>

            <article class="panel col-12">
              <h3 class="panel-title">Situation / Autonomy</h3>
              <div class="kpi-sub" id="regimeLine1">-</div>
              <div class="kpi-sub" id="regimeLine2">-</div>
              <div class="kpi-sub" id="regimeLine3">-</div>
              <div class="chart-wrap" style="height:72px; margin-top:8px;">
                <svg id="regimeRibbon" viewBox="0 0 1200 72" preserveAspectRatio="none"></svg>
              </div>
              <div class="toggle-row" style="margin-top:8px;">
                <span class="tiny-chip" id="autonomyAction">-</span>
                <span class="tiny-chip" id="autonomyConfidence">-</span>
                <span class="tiny-chip" id="autonomyImpact">-</span>
                <span class="tiny-chip" id="insightAdaptive">-</span>
                <span class="tiny-chip" id="insightTob">-</span>
                <span class="tiny-chip" id="safetyState">-</span>
              </div>
              <div class="chip-row" id="autonomyReasons"></div>
            </article>

            <article class="panel col-12" style="padding:10px;">
              <h3 class="panel-title">Forecast (30m, heuristic)</h3>
              <div class="kpi-sub" id="forecastLine1">-</div>
              <div class="kpi-sub" id="forecastLine2">-</div>
            </article>
          </section>

          <section class="grid-kpi" id="kpiCards" style="margin-top:12px;">
            <article class="kpi-card">
              <div class="kpi-key">Market</div>
              <div class="kpi-val" id="kpiMid">-</div>
              <div class="kpi-sub">Spread <span id="kpiSpread">-</span></div>
              <div class="kpi-sub">Trend <span id="kpiTrend">-</span></div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Execution</div>
              <div class="kpi-val" id="kpiExecHealth">-</div>
              <div class="kpi-sub" id="kpiExecHealthSub">-</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Inventory</div>
              <div class="kpi-val" id="kpiBtcNotionalUsd">-</div>
              <div class="kpi-sub" id="kpiUsdFree">USD free -</div>
              <div class="kpi-sub" id="kpiBtcFree">BTC free -</div>
              <div class="kpi-sub" id="kpiUsdTotal">USD total -</div>
              <div class="kpi-sub" id="kpiBtcTotal">BTC total -</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Signals</div>
              <div class="kpi-val" id="kpiSignal">-</div>
              <div class="kpi-sub" id="kpiSignalSub">-</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Adverse Selection</div>
              <div class="kpi-val" id="kpiAs">-</div>
              <div class="kpi-sub" id="kpiAsSub">-</div>
              <div class="kpi-sub" id="kpiAsSub2">-</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Adaptive Controller</div>
              <div class="kpi-val" id="kpiAdaptive">-</div>
              <div class="kpi-sub" id="kpiAdaptiveSub">-</div>
              <div class="kpi-sub" id="kpiAdaptiveSub2">-</div>
              <div class="chip-row" id="kpiAdaptiveReasons"></div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Performance</div>
              <div class="kpi-val" id="kpiPerf">-</div>
              <div class="kpi-sub" id="kpiPerfSub">-</div>
              <div class="kpi-sub" id="kpiPerfSub2">-</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Fill Edge</div>
              <div class="kpi-val" id="kpiEdgeAlt">-</div>
              <div class="kpi-sub" id="kpiEdgeSub">-</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Active Orders</div>
              <div class="kpi-val" id="kpiActive">-</div>
              <div class="kpi-sub">Bot-tagged live orders</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Equity USD</div>
              <div class="kpi-val" id="kpiEquityUsd">-</div>
              <div class="kpi-sub" id="kpiEquityUsdSub">-</div>
            </article>
            <article class="kpi-card">
              <div class="kpi-key">Equity BTC</div>
              <div class="kpi-val" id="kpiEquityBtc">-</div>
              <div class="kpi-sub" id="kpiEquityBtcSub">-</div>
            </article>
          </section>

          <section class="operate-grid" style="margin-top:12px;">
            <article class="panel col-12 events-panel">
              <h3 class="panel-title">Recent Bot Order Events <span class="badge">Newest First</span></h3>
              <div class="event-filters" id="eventFilters">
                <button class="event-pill active" data-filter="ALL">ALL <span id="eventCountALL">0</span></button>
                <button class="event-pill" data-filter="PLACED">PLACED <span id="eventCountPLACED">0</span></button>
                <button class="event-pill" data-filter="CANCELLED">CANCELLED <span id="eventCountCANCELLED">0</span></button>
                <button class="event-pill" data-filter="FILLED">FILLED <span id="eventCountFILLED">0</span></button>
                <button class="event-pill" data-filter="REPLACED">REPLACED <span id="eventCountREPLACED">0</span></button>
                <button class="event-pill" data-filter="REJECTED">REJECTED <span id="eventCountREJECTED">0</span></button>
                <button class="event-pill" data-filter="OVERRIDE">OVERRIDE <span id="eventCountOVERRIDE">0</span></button>
                <button class="event-pill" data-filter="ERROR">ERROR <span id="eventCountERROR">0</span></button>
                <span class="event-limit-label">max</span>
                <select class="event-limit-select" id="eventLimitSelect" aria-label="Maximum events kept">
                  <option value="50">50</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                  <option value="2000">2000</option>
                </select>
                <span class="event-info" id="eventsInfo">Showing last - events</span>
                <span class="event-info" id="eventStoredInfo">Stored 0 / Cap 0</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Time</th><th>Type</th><th>Side</th><th>Price</th><th>Size</th><th>Reason</th><th>Client ID</th></tr></thead>
                  <tbody id="eventsBody"></tbody>
                </table>
              </div>
            </article>
          </section>

          <section style="display:none;">
            <div class="chart-wrap"><svg id="equityChart" viewBox="0 0 1200 300" preserveAspectRatio="none"></svg></div>
            <div class="chart-wrap"><svg id="drawdownChart" viewBox="0 0 1200 180" preserveAspectRatio="none"></svg></div>
            <div class="chart-wrap"><svg id="compositionChart" viewBox="0 0 1200 180" preserveAspectRatio="none"></svg></div>
            <div class="chart-wrap"><svg id="pnlChart" viewBox="0 0 1200 300" preserveAspectRatio="none"></svg></div>
            <div id="equityChartShell"><div id="equityTooltip"></div></div>
            <div id="chartModeEquity"></div><div id="chartModeDrawdown"></div><div id="chartModeFills"></div><div id="chartModeEdge"></div>
          </section>
        </section>

        <section id="overridesView" class="view-pane" style="display:none">
          <section class="bottom-grid">
            <article class="panel">
              <h3 class="panel-title">Runtime Overrides</h3>
              <div class="kpi-sub">Applies per symbol and is clamped to safe limits.</div>
              <div class="toggle-row" style="margin-top:8px;">
                <label class="kpi-sub"><input type="checkbox" id="ovrEnabled" /> Strategy Enabled</label>
                <label class="kpi-sub"><input type="checkbox" id="ovrAllowBuy" /> Allow Buy</label>
                <label class="kpi-sub"><input type="checkbox" id="ovrAllowSell" /> Allow Sell</label>
                <label class="kpi-sub"><input type="checkbox" id="ovrTobEnabled" /> TOB Enabled</label>
              </div>
              <div class="toggle-row" style="margin-top:8px;">
                <label class="kpi-sub">Levels Buy <input id="ovrLevelsBuy" type="number" class="event-limit-select" min="0" max="10" /></label>
                <label class="kpi-sub">Levels Sell <input id="ovrLevelsSell" type="number" class="event-limit-select" min="0" max="10" /></label>
                <label class="kpi-sub">Quote USD <input id="ovrLevelQuoteSizeUsd" type="number" class="event-limit-select" min="1" max="25" step="0.01" /></label>
                <label class="kpi-sub">TOB Quote USD <input id="ovrTobQuoteSizeUsd" type="number" class="event-limit-select" min="1" max="10" step="0.01" /></label>
              </div>
              <div class="toggle-row">
                <label class="kpi-sub">Half Spread bps <input id="ovrBaseHalfSpreadBps" type="number" class="event-limit-select" min="1" max="50" step="0.1" /></label>
                <label class="kpi-sub">Level Step bps <input id="ovrLevelStepBps" type="number" class="event-limit-select" min="1" max="50" step="0.1" /></label>
                <label class="kpi-sub">Min Market Spread bps <input id="ovrMinMarketSpreadBps" type="number" class="event-limit-select" min="0.1" max="20" step="0.1" /></label>
                <label class="kpi-sub">Reprice bps <input id="ovrRepriceMoveBps" type="number" class="event-limit-select" min="1" max="50" step="0.1" /></label>
                <label class="kpi-sub">Queue Refresh (s) <input id="ovrQueueRefreshSeconds" type="number" class="event-limit-select" min="10" max="600" /></label>
              </div>
              <div class="toggle-row">
                <label class="kpi-sub">Cash Reserve USD <input id="ovrCashReserveUsd" type="number" class="event-limit-select" min="0" max="2000" step="0.01" /></label>
                <label class="kpi-sub">Working Cap USD <input id="ovrWorkingCapUsd" type="number" class="event-limit-select" min="0" max="5000" step="0.01" /></label>
                <label class="kpi-sub">Target BTC Notional USD <input id="ovrTargetBtcNotionalUsd" type="number" class="event-limit-select" min="0" max="1000" step="0.01" /></label>
                <label class="kpi-sub">Max BTC Notional USD <input id="ovrMaxBtcNotionalUsd" type="number" class="event-limit-select" min="0" max="2000" step="0.01" /></label>
                <label class="kpi-sub">Skew Max bps <input id="ovrSkewMaxBps" type="number" class="event-limit-select" min="0" max="100" step="0.1" /></label>
              </div>
              <div class="toggle-row">
                <label class="kpi-sub">Max Active Orders <input id="ovrMaxActiveOrders" type="number" class="event-limit-select" min="1" max="25" /></label>
                <label class="kpi-sub">Max Actions/Loop <input id="ovrMaxActionsPerLoop" type="number" class="event-limit-select" min="1" max="20" /></label>
                <label class="kpi-sub">TTL Seconds <input id="ovrTtlSeconds" type="number" class="event-limit-select" min="1" max="604800" /></label>
                <label class="kpi-sub">Note <input id="ovrNote" type="text" maxlength="160" class="event-limit-select" style="min-width:220px" /></label>
              </div>
              <div class="toggle-row">
                <button class="btn warn" id="ovrApplyBtn">Apply Patch</button>
                <button class="btn" id="ovrClearBtn">Clear Overrides</button>
                <span class="kpi-sub" id="ovrStatusLine">-</span>
              </div>
              <div class="kpi-sub" id="ovrDiffSummary">No override diff yet.</div>
              <div class="table-wrap" style="max-height:220px;">
                <table>
                  <thead><tr><th>Field</th><th>Requested</th><th>Applied</th><th>Status</th></tr></thead>
                  <tbody id="ovrDiffBody"><tr><td colspan="4" style="color:#8fa6c1">none</td></tr></tbody>
                </table>
              </div>
            </article>
            <article class="panel">
              <h3 class="panel-title">Effective Config (read-only)</h3>
              <div class="table-wrap" style="max-height:60vh;">
                <pre id="effectiveConfigBlock" style="margin:0; padding:10px; color:var(--text); font-size:0.72rem; font-family:'IBM Plex Mono','Menlo',monospace;"></pre>
              </div>
            </article>
          </section>
        </section>

        <section id="diagnoseView" class="view-pane" style="display:none">
          <article class="panel">
            <h3 class="panel-title">Diagnose: Why Isn’t It Filling?</h3>
            <div class="kpi-val" id="diagnoseCause">-</div>
            <div class="kpi-sub" id="diagnoseContext1">-</div>
            <div class="kpi-sub" id="diagnoseContext2">-</div>
            <div class="kpi-sub" id="diagnoseContext3">-</div>
            <div class="kpi-sub" style="margin-top:8px;">Suggested Actions</div>
            <ul id="diagnoseActions" style="margin-top:6px; color:var(--muted); font-family:'IBM Plex Mono','Menlo',monospace; font-size:0.74rem;"></ul>
          </article>
        </section>

        <section id="optimizeView" class="view-pane" style="display:none">
          <section class="bottom-grid">
            <article class="panel">
              <h3 class="panel-title">Guided Tuning (UI-only)</h3>
              <div class="kpi-sub">BASE_HALF_SPREAD_BPS <span id="optSpreadVal">-</span></div>
              <input id="optSpread" type="range" min="1" max="30" value="10" />
              <div class="kpi-sub">LEVEL_STEP_BPS <span id="optStepVal">-</span></div>
              <input id="optStep" type="range" min="1" max="30" value="10" />
              <div class="kpi-sub">LEVELS <span id="optLevelsVal">-</span></div>
              <input id="optLevels" type="range" min="0" max="5" value="2" />
              <div class="kpi-sub">QUOTE_SIZE_USD <span id="optQuoteVal">-</span></div>
              <input id="optQuote" type="range" min="1" max="25" value="8" />
              <div class="kpi-sub">SKEW_MAX_BPS <span id="optSkewVal">-</span></div>
              <input id="optSkew" type="range" min="0" max="50" value="25" />
              <div class="kpi-sub">TARGET_FILLS_PER_HOUR <span id="optTargetFillsVal">-</span></div>
              <input id="optTargetFills" type="range" min="0" max="10" value="2" />
              <button class="btn" id="applyOverridesBtn" disabled title="Next milestone: write OVERRIDES.json and reload each cycle">Apply overrides</button>
            </article>
            <article class="panel">
              <h3 class="panel-title">Preview</h3>
              <div class="kpi-sub" id="optimizePreview1">-</div>
              <div class="kpi-sub" id="optimizePreview2">-</div>
              <div class="kpi-sub" id="optimizePreview3">-</div>
            </article>
          </section>
        </section>

        <section id="auditView" class="view-pane" style="display:none">
          <article class="panel">
            <div class="pnl-head">
              <h3 class="panel-title">Decision Timeline</h3>
              <button class="btn" id="exportReportBtn">Export report</button>
            </div>
            <div class="kpi-sub" id="decisionInfo">-</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Mid</th><th>Spread</th><th>Buy</th><th>Sell</th><th>Trend</th><th>Half Spread</th><th>Adaptive Δ</th><th>Fills30m</th><th>Cancels1h</th><th>Rejects1h</th><th>Signal</th><th>Action</th></tr></thead>
                <tbody id="decisionBody"></tbody>
              </table>
            </div>
          </article>
          <section class="bottom-grid">
            <article class="panel">
              <h3 class="panel-title">Recent Bot Orders</h3>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Time</th><th>Client ID</th><th>Side</th><th>Price</th><th>Quote</th><th>Status</th></tr></thead>
                  <tbody id="recentOrdersBody"></tbody>
                </table>
              </div>
            </article>
            <article class="panel">
              <h3 class="panel-title">Roadmap</h3>
              <div class="roadmap-grid">
                <article class="roadmap-col">
                  <h4>Milestone 1</h4>
                  <ul>
                    <li>Stable post-only maker loop</li>
                    <li>TOB micro with guardrails</li>
                    <li>Volatility and risk guardrails</li>
                  </ul>
                </article>
                <article class="roadmap-col">
                  <h4>Milestone 2 (Current)</h4>
                  <ul>
                    <li>Adaptive spread + edge-weighted quoting</li>
                    <li>Execution health diagnostics</li>
                    <li>Bounded, deduped order events</li>
                  </ul>
                </article>
                <article class="roadmap-col">
                  <h4>Milestone 3 (Scale)</h4>
                  <ul>
                    <li>Multi-symbol scheduling and risk buckets</li>
                    <li>Improved metrics persistence + replay</li>
                    <li>Alerts and backtesting harness</li>
                  </ul>
                </article>
              </div>
              <div class="readiness">
                <div id="roadmapEdge">Avg edge last 1h: - bps (target &gt; 5)</div>
                <div id="roadmapFills">Fills/hr: - (target 2-4)</div>
                <div id="roadmapCancels">Churn cancels/hr: - (target &lt; 150)</div>
                <div id="roadmapPnl">PnL today: -</div>
              </div>
            </article>
          </section>
          <article class="panel" style="margin-top:12px;">
            <h3 class="panel-title">UI Settings</h3>
            <div class="toggle-row">
              <label class="kpi-sub">maxUiEvents
                <select class="event-limit-select" id="settingMaxUiEvents">
                  <option value="50">50</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                  <option value="2000">2000</option>
                </select>
              </label>
              <label class="kpi-sub">maxEquityPoints <input id="settingMaxEquityPoints" type="number" class="event-limit-select" style="border-radius:8px" min="200" max="20000" /></label>
              <label class="kpi-sub">equitySampleMs <input id="settingEquitySampleMs" type="number" class="event-limit-select" style="border-radius:8px" min="250" max="60000" /></label>
              <label class="kpi-sub" style="display:flex; gap:8px; align-items:center;"><input id="settingPersistEquitySeries" type="checkbox" /> Persist equity series</label>
              <button class="btn" id="resetEquityBtn">Reset equity series</button>
            </div>
          </article>
        </section>
      </main>
    </div>
    <details class="debug-drawer" id="debugPanel">
      <summary>Debug Diagnostics</summary>
      <div id="debugStrip" class="debug-strip mono">DBG • waiting for updates...</div>
      <pre id="debugDetails" class="debug-details mono">-</pre>
    </details>
  </div>

  <div class="modal-backdrop" id="confirmModal">
    <div class="modal">
      <h3>Cancel All Bot Orders</h3>
      <p>This will cancel active bot-tagged orders for the current symbol. Continue?</p>
      <div class="modal-actions">
        <button class="btn" id="modalCancel">Back</button>
        <button class="btn warn" id="modalConfirm">Confirm Cancel All</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="decisionModal">
    <div class="modal" style="width:min(820px,100%);">
      <h3>Decision Snapshot</h3>
      <p id="decisionModalMeta">-</p>
      <div class="table-wrap" style="max-height:60vh;">
        <pre id="decisionJson" style="margin:0; padding:10px; color:var(--text); font-size:0.72rem; font-family:'IBM Plex Mono','Menlo',monospace;"></pre>
      </div>
      <div class="modal-actions">
        <button class="btn" id="decisionModalClose">Close</button>
      </div>
    </div>
  </div>

  <script src="/dashboard.js" defer></script>
</body>
</html>`;
}

function renderIntelConsoleHtml(symbol: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>REVX Intel Console</title>
  <style>
    :root {
      --bg: #061019;
      --panel: #0d1928;
      --line: rgba(158, 191, 227, 0.22);
      --text: #eaf3ff;
      --muted: #96abc6;
      --good: #1fe39f;
      --warn: #f5c35f;
      --bad: #ff6f80;
      --accent: #3fb8ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(980px 520px at 0% -15%, rgba(63,184,255,0.18), transparent 60%),
        radial-gradient(900px 480px at 100% 0%, rgba(31,227,159,0.10), transparent 56%),
        linear-gradient(180deg, #040b12 0%, #081221 100%);
      min-height: 100vh;
    }
    .shell {
      width: min(1960px, 100%);
      margin: 0 auto;
      padding: 14px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--line);
      background: rgba(11, 20, 32, 0.86);
      border-radius: 12px;
      padding: 10px 12px;
      margin-bottom: 10px;
    }
    .title {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .sub {
      font-size: 0.75rem;
      color: var(--muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .top-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.72rem;
      background: rgba(10, 20, 30, 0.8);
      color: var(--text);
      white-space: nowrap;
    }
    .chip.good { color: var(--good); border-color: rgba(31,227,159,0.35); }
    .chip.warn { color: var(--warn); border-color: rgba(245,195,95,0.38); }
    .chip.bad { color: var(--bad); border-color: rgba(255,111,128,0.42); }
    .intel-grid {
      display: grid;
      grid-template-columns: minmax(330px, 1.25fr) minmax(430px, 1.2fr) minmax(330px, 0.95fr);
      gap: 10px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(10, 19, 31, 0.90);
      min-height: 220px;
      overflow: hidden;
    }
    .panel-head {
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .panel-title {
      font-size: 0.78rem;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .panel-body { padding: 10px 12px; }
    .feed-meta { display: grid; gap: 4px; margin-bottom: 8px; }
    .feed-line {
      font-size: 0.78rem;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .feed-line.headline { color: var(--text); font-weight: 600; }
    .controls {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 10px;
    }
    .select {
      width: 100%;
      background: rgba(8, 15, 25, 0.95);
      color: var(--text);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 0.78rem;
    }
    .list {
      max-height: calc(100vh - 250px);
      overflow: auto;
      display: grid;
      gap: 8px;
      padding-right: 2px;
    }
    .cluster {
      border: 1px solid rgba(158, 191, 227, 0.18);
      border-radius: 9px;
      padding: 8px;
      background: rgba(8, 14, 22, 0.70);
      display: grid;
      gap: 6px;
      opacity: 1;
      transform: translateY(0);
      transition: opacity 180ms ease, transform 180ms ease, border-color 180ms ease;
    }
    .cluster.enter { opacity: 0; transform: translateY(5px); }
    .cluster.exit { opacity: 0; transform: translateY(-4px); }
    .cluster-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 0.74rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .pill {
      border-radius: 999px;
      padding: 2px 8px;
      font-weight: 700;
      font-size: 0.68rem;
      border: 1px solid transparent;
      letter-spacing: 0.05em;
    }
    .pill.low { color: var(--good); border-color: rgba(31,227,159,0.36); }
    .pill.med { color: var(--warn); border-color: rgba(245,195,95,0.36); }
    .pill.high { color: var(--bad); border-color: rgba(255,111,128,0.42); }
    .cluster-title { font-size: 0.87rem; line-height: 1.25; }
    .cluster-sub {
      font-size: 0.72rem;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .timeline-wrap { display: grid; gap: 10px; }
    .chart-summary {
      border: 1px solid rgba(158,191,227,0.18);
      border-radius: 9px;
      padding: 8px;
      background: rgba(8, 14, 24, 0.78);
      display: grid;
      gap: 6px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
    }
    .summary-item {
      border: 1px solid rgba(158,191,227,0.14);
      border-radius: 8px;
      padding: 6px;
      display: grid;
      gap: 2px;
      background: rgba(7, 12, 20, 0.75);
    }
    .summary-item span {
      font-size: 0.66rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .summary-item strong {
      font-size: 0.83rem;
      line-height: 1.15;
    }
    .summary-item small {
      font-size: 0.68rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .legend-help {
      font-size: 0.72rem;
      color: var(--muted);
      line-height: 1.35;
    }
    .current-action {
      font-size: 0.73rem;
      color: var(--text);
      border-top: 1px dashed rgba(158,191,227,0.18);
      padding-top: 6px;
      line-height: 1.35;
    }
    canvas#intelTimelineChart {
      width: 100%;
      height: 210px;
      background: rgba(8, 14, 24, 0.78);
      border: 1px solid rgba(158,191,227,0.16);
      border-radius: 9px;
    }
    .stale-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.72rem;
      color: var(--muted);
      margin-left: 8px;
    }
    .stale-indicator.bad { color: var(--bad); }
    .timeline-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .timeline-span-2 { grid-column: 1 / span 2; }
    .mini-panel {
      border: 1px solid rgba(158,191,227,0.16);
      border-radius: 8px;
      background: rgba(8, 14, 24, 0.72);
      padding: 8px;
      min-height: 150px;
      transition: border-color 180ms ease, transform 180ms ease, opacity 180ms ease;
    }
    .mini-panel.pulse {
      border-color: rgba(63,184,255,0.45);
      transform: translateY(-1px);
    }
    .mini-title {
      font-size: 0.70rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 6px;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .mini-list {
      display: grid;
      gap: 6px;
      max-height: 120px;
      overflow: auto;
      font-size: 0.76rem;
    }
    .mini-row {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      color: var(--text);
    }
    .regime-strip {
      display: flex;
      gap: 2px;
      margin-bottom: 8px;
      border: 1px solid rgba(158,191,227,0.12);
      border-radius: 7px;
      overflow: hidden;
      min-height: 18px;
    }
    .regime-seg {
      min-height: 16px;
      flex: 1 1 auto;
      opacity: 0.88;
      transition: opacity 160ms ease;
    }
    .regime-seg:hover { opacity: 1; }
    .regime-NORMAL { background: rgba(31,227,159,0.55); }
    .regime-CAUTION { background: rgba(245,195,95,0.60); }
    .regime-RISK_OFF { background: rgba(255,140,89,0.62); }
    .regime-HALT { background: rgba(255,111,128,0.70); }
    .anomaly-card {
      border: 1px solid rgba(158,191,227,0.18);
      border-radius: 8px;
      padding: 7px;
      display: grid;
      gap: 4px;
      background: rgba(8, 14, 24, 0.74);
      font-size: 0.75rem;
    }
    .anomaly-card.high { border-color: rgba(255,111,128,0.44); }
    .anomaly-card.med { border-color: rgba(245,195,95,0.36); }
    .anomaly-card.low { border-color: rgba(31,227,159,0.30); }
    .skeleton {
      position: relative;
      color: transparent !important;
      background: linear-gradient(90deg, rgba(120,147,176,0.18), rgba(171,195,222,0.30), rgba(120,147,176,0.18));
      background-size: 220% 100%;
      animation: shimmer 1.2s linear infinite;
      border-radius: 6px;
    }
    .updated-at {
      font-size: 0.71rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .right-stack { display: grid; gap: 8px; }
    .decision-headline {
      font-size: 0.9rem;
      font-weight: 700;
      line-height: 1.25;
      margin-bottom: 6px;
    }
    .reason-list {
      margin: 0;
      padding-left: 16px;
      display: grid;
      gap: 4px;
      font-size: 0.77rem;
      color: var(--muted);
    }
    .drivers {
      display: grid;
      gap: 6px;
      margin-top: 8px;
      font-size: 0.75rem;
    }
    .driver-row {
      border: 1px solid rgba(158,191,227,0.16);
      border-radius: 8px;
      padding: 7px;
      background: rgba(8, 14, 24, 0.74);
    }
    .kv {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      font-size: 0.78rem;
      padding: 3px 0;
      border-bottom: 1px dashed rgba(158,191,227,0.14);
    }
    .kv:last-child { border-bottom: 0; }
    details.diag {
      border: 1px solid rgba(158,191,227,0.16);
      border-radius: 8px;
      background: rgba(7, 12, 20, 0.84);
    }
    details.diag > summary {
      cursor: pointer;
      padding: 8px 10px;
      font-size: 0.76rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .diag pre {
      margin: 0;
      border-top: 1px solid rgba(158,191,227,0.16);
      padding: 8px 10px;
      max-height: 260px;
      overflow: auto;
      font-size: 0.72rem;
      color: #b8d0ea;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: pre-wrap;
    }
    .muted { color: var(--muted); font-size: 0.75rem; }
    @media (max-width: 1320px) {
      .intel-grid {
        grid-template-columns: 1fr;
      }
      .list { max-height: 420px; }
      canvas#intelTimelineChart { height: 180px; }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .timeline-span-2 { grid-column: auto; }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div>
        <div class="title">REVX Intel Console</div>
        <div class="sub">${escapeInlineHtml(symbol)} • market-moving intelligence and posture diagnostics</div>
      </div>
      <div class="top-actions">
        <span class="chip" id="intelHeaderPosture">INTEL: NORMAL</span>
        <span class="chip" id="intelHeaderFair">Fair --</span>
        <a class="chip" href="/">Open Trading Cockpit</a>
      </div>
    </header>

    <main class="intel-grid">
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">Intel Stream</div>
          <div class="muted" id="streamCount">0 clusters</div>
        </div>
        <div class="panel-body">
          <div class="feed-meta">
            <div class="feed-line headline" id="intelBannerHeadline">Intel: loading…</div>
            <div class="feed-line" id="intelBannerDrivers">Top drivers: -</div>
            <div class="feed-line" id="intelBannerProviders">Providers: -</div>
          </div>
          <div class="controls">
            <select class="select" id="intelSort">
              <option value="impact">Sort: impact</option>
              <option value="age">Sort: age</option>
              <option value="category">Sort: category</option>
              <option value="source">Sort: source</option>
            </select>
            <select class="select" id="intelFilterCategory">
              <option value="all">Category: all</option>
              <option value="WAR">WAR</option>
              <option value="RATES">RATES</option>
              <option value="INFLATION">INFLATION</option>
              <option value="CRYPTO">CRYPTO</option>
              <option value="EXCHANGE">EXCHANGE</option>
              <option value="RISK">RISK</option>
              <option value="MACRO">MACRO</option>
              <option value="NEWS">NEWS</option>
              <option value="SYSTEM">SYSTEM</option>
            </select>
            <select class="select" id="intelFilterSource">
              <option value="all">Source: all</option>
            </select>
          </div>
          <div class="list" id="intelStreamList"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">Timeline & Anomalies</div>
          <div class="muted"><span id="timelineMeta">-</span><span class="stale-indicator" id="timelineStale">live</span></div>
        </div>
        <div class="panel-body timeline-wrap">
          <div class="chart-summary" id="chartSummary">
            <div class="summary-grid">
              <div class="summary-item">
                <span>Fair Price</span>
                <strong id="chartFairMid" class="skeleton">-</strong>
                <small id="chartGlobalMid">global -</small>
              </div>
              <div class="summary-item">
                <span>RevX Mid</span>
                <strong id="chartRevxMid" class="skeleton">-</strong>
                <small id="chartRevxSpread">spread -</small>
              </div>
              <div class="summary-item">
                <span>Basis</span>
                <strong id="chartBasisBps" class="skeleton">-</strong>
                <small id="chartBasisExplain">revx vs fair</small>
              </div>
              <div class="summary-item">
                <span>Dispersion</span>
                <strong id="chartDispersionBps" class="skeleton">-</strong>
                <small id="chartDispersionBand">OK/WARN/RISK</small>
              </div>
              <div class="summary-item">
                <span>Confidence</span>
                <strong id="chartConfidence" class="skeleton">-</strong>
                <small id="chartConfidenceExplain">source agreement</small>
              </div>
            </div>
            <div class="legend-help" id="chartLegend">
              Dispersion = how far venues disagree. Basis = RevX distance from fair price. Confidence rises when sources agree and quotes are fresh.
            </div>
            <div class="current-action" id="chartCurrentAction">Current action: waiting for posture…</div>
          </div>
          <canvas id="intelTimelineChart" width="920" height="210"></canvas>
          <div class="updated-at" id="intelChartUpdated">updated -</div>
          <div class="timeline-grid">
            <div class="mini-panel timeline-span-2" id="regimePanel">
              <div class="mini-title">Regime Timeline (last 120m)</div>
              <div class="regime-strip" id="intelRegimeStrip"></div>
              <div class="mini-list" id="intelRegimeList"></div>
            </div>
            <div class="mini-panel" id="deltaPanel">
              <div class="mini-title">What Changed Recently?</div>
              <div class="mini-list" id="intelDeltaList"></div>
            </div>
            <div class="mini-panel" id="anomalyPanel">
              <div class="mini-title">Market Anomalies</div>
              <div class="mini-list" id="intelAnomalyList"></div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">Decision Panel</div>
          <div class="muted" id="decisionUpdated">-</div>
        </div>
        <div class="panel-body right-stack">
          <div>
            <div class="decision-headline" id="decisionHeadline">Loading posture…</div>
            <ul class="reason-list" id="decisionReasons"></ul>
            <div class="muted" id="decisionClear">Clears when impact decays and confirmations fade.</div>
            <div class="drivers" id="decisionDrivers"></div>
          </div>

          <div class="mini-panel">
            <div class="mini-title">Trading Influence (probabilistic, risk-only)</div>
            <div class="kv"><span>intelBias</span><strong id="influenceBias">0.00</strong></div>
            <div class="kv"><span>confidence</span><strong id="influenceConf">0.00</strong></div>
            <div class="kv"><span>spread widen</span><strong id="influenceSpread">x1.00</strong></div>
            <div class="kv"><span>size throttle</span><strong id="influenceSize">x1.00</strong></div>
            <div class="kv"><span>TOB override</span><strong id="influenceTob">UNCHANGED</strong></div>
            <div class="kv"><span>halt effect</span><strong id="influenceHalt">soft</strong></div>
            <div class="kv"><span>quoting blockers</span><strong id="influenceBlocked">-</strong></div>
          </div>

          <div class="mini-panel">
            <div class="mini-title">Provider Freshness</div>
            <div class="mini-list" id="providerFreshness"></div>
          </div>

          <details class="diag" id="intelDiagnostics">
            <summary>Diagnostics (collapsible)</summary>
            <pre id="intelDiagDetails">waiting for updates…</pre>
          </details>
        </div>
      </section>
    </main>
  </div>
  <script src="/intel.js" defer></script>
</body>
</html>`;
}

function renderIntelConsoleJs(): string {
  const js = `(() => {
  const state = {
    snapshot: null,
    prevSnapshot: null,
    debug: null,
    prevDebug: null,
    status: null,
    prevStatus: null,
    filters: {
      sort: "impact",
      category: "all",
      source: "all"
    },
    sourceOptions: [],
    timeline: [],
    regimeMarkers: [],
    streamNodes: new Map(),
    initialLoading: true
  };

  function el(id) {
    return document.getElementById(id);
  }

  function n(v, d = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function ageText(ts) {
    const age = Math.max(0, Math.floor((Date.now() - n(ts, 0)) / 1000));
    if (age < 60) return age + "s";
    if (age < 3600) return Math.floor(age / 60) + "m";
    return Math.floor(age / 3600) + "h";
  }

  function impactClass(v) {
    const x = n(v, 0);
    if (x >= 0.75) return "high";
    if (x >= 0.45) return "med";
    return "low";
  }

  function severityClass(v) {
    const x = n(v, 0);
    if (x >= 0.75) return "high";
    if (x >= 0.45) return "med";
    return "low";
  }

  function shorten(v, maxLen) {
    const s = String(v || "").trim();
    const m = Math.max(8, n(maxLen, 44));
    return s.length <= m ? s : s.slice(0, m - 1).trimEnd() + "...";
  }

  function headlineLine(snapshot) {
    const commentary = snapshot && snapshot.commentary && typeof snapshot.commentary === "object" ? snapshot.commentary : {};
    const headline = String(commentary.headline || "").trim();
    if (headline.length > 0) return headline;
    const posture = snapshot && snapshot.posture && snapshot.posture.state ? String(snapshot.posture.state) : "NORMAL";
    const impact = n(snapshot && snapshot.posture && snapshot.posture.impact, 0);
    return "Intel: " + posture + " (" + impact.toFixed(2) + ")";
  }

  function setText(id, value) {
    const node = el(id);
    if (!node) return;
    const next = String(value == null ? "" : value);
    if (node.textContent !== next) {
      node.textContent = next;
    }
  }

  function removeSkeletons() {
    document.querySelectorAll(".skeleton").forEach((node) => {
      node.classList.remove("skeleton");
    });
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " for " + url);
    }
    return response.json();
  }

  async function refresh() {
    const [snapshot, debug, status] = await Promise.all([
      fetchJson("/api/intel/snapshot"),
      fetchJson("/api/intel/debug"),
      fetchJson("/api/status")
    ]);
    state.prevSnapshot = state.snapshot;
    state.prevDebug = state.debug;
    state.prevStatus = state.status;
    state.snapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    state.debug = debug && typeof debug === "object" ? debug : {};
    state.status = status && typeof status === "object" ? status : {};
    ingestTimeline();
    render();
    if (state.initialLoading) {
      state.initialLoading = false;
      removeSkeletons();
    }
  }

  function ingestTimeline() {
    const snapshot = state.snapshot || {};
    const posture = snapshot.posture && typeof snapshot.posture === "object" ? snapshot.posture : {};
    const analytics = state.status && state.status.analytics && typeof state.status.analytics === "object" ? state.status.analytics : {};
    const ts = n(snapshot.ts, Date.now());
    const entry = {
      ts,
      impact: clamp(n(posture.impact, 0), 0, 1),
      confidence: clamp(n(posture.confidence, 0), 0, 1),
      basisBps: n(analytics.signalBasisBps, 0),
      dispersionBps: n(analytics.signalDispersionBps, 0),
      regime: String(analytics.signalRegime || analytics.intelState || "NORMAL").toUpperCase(),
      posture: String(posture.state || "NORMAL").toUpperCase()
    };
    const prev = state.timeline[state.timeline.length - 1];
    state.timeline.push(entry);
    while (state.timeline.length > 480) state.timeline.shift();
    if (!prev || prev.regime !== entry.regime || prev.posture !== entry.posture) {
      state.regimeMarkers.push(entry);
      while (state.regimeMarkers.length > 80) state.regimeMarkers.shift();
    }
  }

  function getThresholds() {
    const effective = state.status && state.status.effectiveConfig && typeof state.status.effectiveConfig === "object"
      ? state.status.effectiveConfig
      : {};
    const dispersionOk = Math.max(2, n(effective.fairMaxDispersionBps, 10));
    const dispersionWarn = Math.max(dispersionOk + 1, dispersionOk * 1.5);
    const dispersionRisk = Math.max(dispersionWarn + 1, dispersionOk * 2);
    const basisWarn = Math.max(2, n(effective.fairMaxBasisBps, 12));
    return { dispersionOk, dispersionWarn, dispersionRisk, basisWarn };
  }

  function getClusters() {
    const snapshot = state.snapshot || {};
    const clusters = Array.isArray(snapshot.clusters) ? snapshot.clusters.slice() : [];
    const category = String(state.filters.category || "all").toUpperCase();
    const source = String(state.filters.source || "all").toLowerCase();
    const sort = String(state.filters.sort || "impact").toLowerCase();
    const filtered = clusters.filter((row) => {
      const cat = String(row && row.category || "").toUpperCase();
      if (category !== "ALL" && cat !== category) return false;
      if (source !== "all") {
        const providers = Array.isArray(row && row.providerBuckets) ? row.providerBuckets : [];
        if (!providers.some((p) => String(p || "").toLowerCase() === source)) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (sort === "age") return n(b.ts, 0) - n(a.ts, 0);
      if (sort === "category") return String(a.category || "").localeCompare(String(b.category || ""));
      if (sort === "source") {
        const aa = Array.isArray(a.providerBuckets) && a.providerBuckets[0] ? String(a.providerBuckets[0]) : "";
        const bb = Array.isArray(b.providerBuckets) && b.providerBuckets[0] ? String(b.providerBuckets[0]) : "";
        return aa.localeCompare(bb);
      }
      if (n(b.maxImpact, 0) !== n(a.maxImpact, 0)) return n(b.maxImpact, 0) - n(a.maxImpact, 0);
      return n(b.ts, 0) - n(a.ts, 0);
    });
    return filtered;
  }

  function createClusterNode(row) {
    const node = document.createElement("article");
    node.className = "cluster enter";
    node.dataset.key = String(row.id || row.key || row.title || Math.random());
    updateClusterNode(node, row);
    requestAnimationFrame(() => {
      node.classList.remove("enter");
    });
    return node;
  }

  function updateClusterNode(node, row) {
    const impact = n(row.maxImpact, 0);
    const providers = Array.isArray(row.providerBuckets) ? row.providerBuckets : [];
    const sources = Array.isArray(row.sources) ? row.sources : [];
    const urls = Array.isArray(row.urls) ? row.urls : [];
    const primaryUrl = urls[0] ? String(urls[0]) : "";
    const title = String(row.title || "-");
    const sourceText = providers.length > 0 ? providers.join(", ") : sources.join(", ");
    const conf = n(row.avgConfidence, 0);
    node.innerHTML =
      '<div class="cluster-head">' +
        '<span class="pill ' + impactClass(impact) + '">' + esc(impact.toFixed(2)) + '</span>' +
        '<span>' + esc(String(row.category || "NEWS")) + ' | ' + esc(ageText(row.ts)) + '</span>' +
      '</div>' +
      '<div class="cluster-title">' +
        (primaryUrl
          ? '<a href="' + esc(primaryUrl) + '" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:none;">' + esc(title) + '</a>'
          : esc(title)) +
      '</div>' +
      '<div class="cluster-sub">' + esc(sourceText) + ' | conf ' + esc(conf.toFixed(2)) + ' | confirmations ' + esc(String(n(row.confirmations, 0))) + '</div>';
  }

  function renderStream() {
    const list = el("intelStreamList");
    const count = el("streamCount");
    const clusters = getClusters();
    if (count) {
      count.textContent = clusters.length + " clusters";
    }
    if (!list) return;
    if (clusters.length === 0) {
      list.innerHTML = '<div class="cluster"><div class="cluster-title">No items match filters.</div><div class="cluster-sub">Try category/source = all.</div></div>';
      state.streamNodes.clear();
      return;
    }

    const nextKeys = new Set();
    for (const row of clusters) {
      const key = String(row.id || row.key || row.title || Math.random());
      nextKeys.add(key);
      let node = state.streamNodes.get(key);
      if (!node) {
        node = createClusterNode(row);
        state.streamNodes.set(key, node);
      } else {
        updateClusterNode(node, row);
      }
      list.appendChild(node);
    }

    for (const [key, node] of state.streamNodes.entries()) {
      if (nextKeys.has(key)) continue;
      node.classList.add("exit");
      setTimeout(() => {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 170);
      state.streamNodes.delete(key);
    }
  }

  function renderBanner() {
    const snapshot = state.snapshot || {};
    const commentary = snapshot.commentary && typeof snapshot.commentary === "object" ? snapshot.commentary : {};
    const providers = Array.isArray(commentary.providerFreshness) ? commentary.providerFreshness : [];
    const providerHealth = Array.isArray(commentary.providerHealth) ? commentary.providerHealth : [];
    const drivers = Array.isArray(commentary.topDrivers) ? commentary.topDrivers : [];
    setText("intelBannerHeadline", headlineLine(snapshot));
    setText(
      "intelBannerDrivers",
      "Top drivers: " +
        (drivers.slice(0, 3).map((row) => String(row.title || "").trim()).filter((row) => row.length > 0).join(" | ") || "-")
    );
    setText(
      "intelBannerProviders",
      "Providers: " +
        (providers.slice(0, 6).map((row) => {
          const provider = String(row.provider || "unknown");
          const age = n(row.lastItemTs, 0) > 0 ? ageText(row.lastItemTs) : "n/a";
          const healthRow = providerHealth.find((entry) => String(entry.provider || "").toLowerCase() === provider.toLowerCase());
          const status = row.ok === false ? " NON_BLOCKING" : "";
          const errorSuffix =
            row.ok === false && healthRow && healthRow.lastError
              ? " (" + shorten(String(healthRow.lastError), 18) + ")"
              : "";
          return provider + " " + age + status + errorSuffix;
        }).join(" | ") || "-")
    );
  }

  function currentActionText(postureState, adjustment) {
    const spread = n(adjustment && adjustment.spreadMult, 1);
    const size = n(adjustment && adjustment.sizeMult, 1);
    const tob = String(adjustment && adjustment.tobModeOverride || "UNCHANGED");
    const hard = Boolean(adjustment && adjustment.hardBlock);
    if (hard) {
      return "Current action: HALT hard guard active — quoting paused by intel trade guard.";
    }
    if (postureState === "HALT") {
      return "Current action: HALT (soft) — de-risking with wider spread x" + spread.toFixed(2) + ", size x" + size.toFixed(2) + ", TOB " + tob + ".";
    }
    if (postureState === "RISK_OFF") {
      return "Current action: DE-RISK — widen x" + spread.toFixed(2) + ", size throttle x" + size.toFixed(2) + ", TOB " + tob + ".";
    }
    if (postureState === "CAUTION") {
      return "Current action: CAUTION — moderate widen x" + spread.toFixed(2) + " and size x" + size.toFixed(2) + ".";
    }
    return "Current action: NORMAL — baseline quoting parameters.";
  }

  // Middle-column summary turns raw metrics into an operator-readable status line.
  function renderSummary() {
    const snapshot = state.snapshot || {};
    const posture = snapshot.posture && typeof snapshot.posture === "object" ? snapshot.posture : {};
    const debug = state.debug && typeof state.debug === "object" ? state.debug : {};
    const status = state.status && typeof state.status === "object" ? state.status : {};
    const analytics = status.analytics && typeof status.analytics === "object" ? status.analytics : {};
    const ticker = status.ticker && typeof status.ticker === "object" ? status.ticker : {};
    const thresholds = getThresholds();

    const fairMid = n(analytics.signalFairMid, 0);
    const globalMid = n(analytics.signalGlobalMid, 0);
    const revxMid = n(ticker.mid, 0);
    const basis = n(analytics.signalBasisBps, 0);
    const dispersion = n(analytics.signalDispersionBps, 0);
    const confidence = clamp(n(analytics.signalConfidence, n(posture.confidence, 0)), 0, 1);
    const spreadBps = n(ticker.spreadBps, 0);

    setText("chartFairMid", fairMid > 0 ? fairMid.toFixed(2) : "-");
    setText("chartGlobalMid", "global " + (globalMid > 0 ? globalMid.toFixed(2) : "-"));
    setText("chartRevxMid", revxMid > 0 ? revxMid.toFixed(2) : "-");
    setText("chartRevxSpread", "spread " + spreadBps.toFixed(2) + "bps");
    setText("chartBasisBps", basis.toFixed(2) + " bps");
    setText("chartDispersionBps", dispersion.toFixed(2) + " bps");
    setText(
      "chartDispersionBand",
      "ok<" + thresholds.dispersionOk.toFixed(1) + " warn<" + thresholds.dispersionWarn.toFixed(1) + " risk>" + thresholds.dispersionWarn.toFixed(1)
    );
    setText("chartConfidence", confidence.toFixed(2));
    setText("chartConfidenceExplain", confidence >= 0.7 ? "high agreement" : confidence >= 0.45 ? "mixed agreement" : "fragile agreement");
    setText(
      "chartLegend",
      "Dispersion = venue disagreement. Basis = RevX minus fair price. Confidence rises with fresh, independent agreement."
    );
    setText("chartCurrentAction", currentActionText(String(posture.state || "NORMAL").toUpperCase(), debug.adjustmentsApplied || {}));

    const ageMs = Math.max(0, Date.now() - n(snapshot.ts, Date.now()));
    setText("intelChartUpdated", "updated " + ageText(snapshot.ts || Date.now()) + " ago");
    const staleNode = el("timelineStale");
    if (staleNode) {
      staleNode.textContent = ageMs > 15_000 ? "stale " + Math.floor(ageMs / 1000) + "s" : "live";
      staleNode.classList.toggle("bad", ageMs > 15_000);
    }

    const chart = el("intelTimelineChart");
    if (chart instanceof HTMLCanvasElement) {
      chart.title =
        "What this means:\\n" +
        "- Dispersion high: venues disagree, adverse selection risk rises.\\n" +
        "- Basis far from zero: RevX diverges from fair price.\\n" +
        "- Confidence low: fewer fresh, agreeing providers.";
    }
  }

  function getTimelineSeries() {
    const now = Date.now();
    const windowMs = 120 * 60 * 1000;
    const cutoff = now - windowMs;
    return state.timeline.filter((row) => n(row.ts, 0) >= cutoff).slice(-180);
  }

  // Timeline overlays impact/dispersion/basis with dispersion risk bands.
  function renderTimelineChart() {
    const canvas = el("intelTimelineChart");
    const meta = el("timelineMeta");
    const series = getTimelineSeries();
    const thresholds = getThresholds();
    if (meta) {
      const latest = series[series.length - 1];
      meta.textContent = latest
        ? "impact " + latest.impact.toFixed(2) + " | dispersion " + latest.dispersionBps.toFixed(2) + "bps | basis " + latest.basisBps.toFixed(2) + "bps"
        : "-";
    }
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const pad = 10;
    const chartH = h - pad * 2;
    const chartW = w - pad * 2;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#081523";
    ctx.fillRect(0, 0, w, h);

    if (series.length < 2) return;
    const maxDispersion = Math.max(
      thresholds.dispersionRisk * 1.2,
      5,
      ...series.map((row) => Math.abs(n(row.dispersionBps, 0)))
    );
    const yForDispersion = (value) => pad + (1 - clamp(Math.abs(value) / maxDispersion, 0, 1)) * chartH;
    const yRisk = yForDispersion(thresholds.dispersionRisk);
    const yWarn = yForDispersion(thresholds.dispersionWarn);

    ctx.fillStyle = "rgba(255,111,128,0.14)";
    ctx.fillRect(pad, pad, chartW, Math.max(0, yRisk - pad));
    ctx.fillStyle = "rgba(245,195,95,0.12)";
    ctx.fillRect(pad, yRisk, chartW, Math.max(0, yWarn - yRisk));
    ctx.fillStyle = "rgba(31,227,159,0.08)";
    ctx.fillRect(pad, yWarn, chartW, Math.max(0, h - pad - yWarn));

    ctx.strokeStyle = "rgba(158,191,227,0.24)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = Math.round(chartH * (i / 4)) + pad;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(245,195,95,0.40)";
    ctx.beginPath();
    ctx.moveTo(pad, yWarn);
    ctx.lineTo(w - pad, yWarn);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,111,128,0.45)";
    ctx.beginPath();
    ctx.moveTo(pad, yRisk);
    ctx.lineTo(w - pad, yRisk);
    ctx.stroke();

    const xFor = (idx) => pad + (idx / Math.max(1, series.length - 1)) * chartW;
    const yImpact = (v) => pad + (1 - clamp(v, 0, 1)) * chartH;
    const maxBasisAbs = Math.max(4, ...series.map((row) => Math.abs(n(row.basisBps, 0))));
    const yBasis = (v) => pad + (1 - (clamp(v / (maxBasisAbs * 2), -0.5, 0.5) + 0.5)) * chartH;

    ctx.beginPath();
    ctx.strokeStyle = "#3fb8ff";
    ctx.lineWidth = 2;
    for (let i = 0; i < series.length; i += 1) {
      const x = xFor(i);
      const y = yImpact(n(series[i].impact, 0));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = "#f5c35f";
    ctx.lineWidth = 1.6;
    for (let i = 0; i < series.length; i += 1) {
      const x = xFor(i);
      const y = yForDispersion(n(series[i].dispersionBps, 0));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = "#d894ff";
    ctx.lineWidth = 1.4;
    for (let i = 0; i < series.length; i += 1) {
      const x = xFor(i);
      const y = yBasis(n(series[i].basisBps, 0));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function timelineHistory() {
    const snapshot = state.snapshot || {};
    const history = Array.isArray(snapshot.postureHistory) ? snapshot.postureHistory : [];
    if (history.length > 0) {
      return history.map((row) => ({
        ts: n(row.ts, 0),
        state: String(row.state || "NORMAL").toUpperCase(),
        reason: String(row.reason || "-"),
        impact: n(row.impact, 0),
        confidence: n(row.confidence, 0)
      })).filter((row) => row.ts > 0);
    }
    return state.regimeMarkers.map((row) => ({
      ts: n(row.ts, 0),
      state: String(row.posture || row.regime || "NORMAL").toUpperCase(),
      reason: "local-history",
      impact: n(row.impact, 0),
      confidence: n(row.confidence, 0)
    }));
  }

  function renderRegimeTimeline() {
    const strip = el("intelRegimeStrip");
    const list = el("intelRegimeList");
    const now = Date.now();
    const windowMs = 120 * 60 * 1000;
    const cutoff = now - windowMs;
    const history = timelineHistory().filter((row) => row.ts >= cutoff).sort((a, b) => a.ts - b.ts);

    if (strip) {
      if (history.length === 0) {
        strip.innerHTML = '<div class="regime-seg regime-NORMAL" style="width:100%;" title="No posture transitions yet"></div>';
      } else {
        const parts = [];
        for (let i = 0; i < history.length; i += 1) {
          const start = Math.max(cutoff, history[i].ts);
          const end = i < history.length - 1 ? history[i + 1].ts : now;
          const width = clamp((end - start) / windowMs, 0.01, 1);
          parts.push(
            '<div class="regime-seg regime-' + esc(history[i].state) + '" ' +
            'style="flex:' + esc((width * 120).toFixed(2)) + ' 1 0%;" ' +
            'title="' + esc(history[i].state + ' | ' + ageText(history[i].ts) + ' ago | ' + history[i].reason) + '"></div>'
          );
        }
        strip.innerHTML = parts.join("");
      }
    }

    if (list) {
      const rows = history.slice(-10).reverse();
      list.innerHTML = rows.length === 0
        ? '<div class="mini-row"><span>No transitions yet</span><span>-</span></div>'
        : rows.map((row) => {
            return '<div class="mini-row"><span>' + esc(ageText(row.ts) + " • " + row.state) + '</span><span>' + esc(shorten(row.reason, 28)) + '</span></div>';
          }).join("");
    }
  }

  function renderDeltaPanel() {
    const list = el("intelDeltaList");
    if (!list) return;
    const currAnalytics = state.status && state.status.analytics && typeof state.status.analytics === "object" ? state.status.analytics : {};
    const prevAnalytics = state.prevStatus && state.prevStatus.analytics && typeof state.prevStatus.analytics === "object" ? state.prevStatus.analytics : null;
    const currProviders = Array.isArray(state.snapshot && state.snapshot.providers) ? state.snapshot.providers : [];
    const prevProviders = Array.isArray(state.prevSnapshot && state.prevSnapshot.providers) ? state.prevSnapshot.providers : null;
    if (!prevAnalytics || !prevProviders) {
      list.innerHTML = '<div class="mini-row"><span>Collecting baseline…</span><span>' + esc(ageText(state.snapshot && state.snapshot.ts || Date.now())) + '</span></div>';
      return;
    }
    const deltas = [];
    const dispDelta = n(currAnalytics.signalDispersionBps, 0) - n(prevAnalytics.signalDispersionBps, 0);
    deltas.push({ label: "Dispersion", value: dispDelta, text: (dispDelta >= 0 ? "+" : "") + dispDelta.toFixed(2) + " bps" });
    const basisDelta = n(currAnalytics.signalBasisBps, 0) - n(prevAnalytics.signalBasisBps, 0);
    deltas.push({ label: "Basis", value: basisDelta, text: (basisDelta >= 0 ? "+" : "") + basisDelta.toFixed(2) + " bps" });
    const confDelta = n(currAnalytics.signalConfidence, 0) - n(prevAnalytics.signalConfidence, 0);
    deltas.push({ label: "Confidence", value: confDelta, text: (confDelta >= 0 ? "+" : "") + confDelta.toFixed(2) });
    const driftDelta = n(currAnalytics.signalDriftBps, 0) - n(prevAnalytics.signalDriftBps, 0);
    deltas.push({ label: "Drift (vol)", value: driftDelta, text: (driftDelta >= 0 ? "+" : "") + driftDelta.toFixed(2) + " bps" });
    const regimeNow = String(currAnalytics.signalRegime || currAnalytics.intelState || "NORMAL");
    const regimePrev = String(prevAnalytics.signalRegime || prevAnalytics.intelState || "NORMAL");
    deltas.push({ label: "Regime", value: regimeNow === regimePrev ? 0 : 1, text: regimePrev + " -> " + regimeNow });
    const degradedNow = currProviders.filter((row) => !row.ok).length;
    const degradedPrev = prevProviders.filter((row) => !row.ok).length;
    const providerDelta = degradedNow - degradedPrev;
    deltas.push({ label: "Providers", value: providerDelta, text: (providerDelta >= 0 ? "+" : "") + providerDelta + " degraded" });
    list.innerHTML = deltas.map((row) => {
      const color = Math.abs(row.value) < 0.01 ? "#8fa6c1" : row.value > 0 ? "#f5c35f" : "#1fe39f";
      return '<div class="mini-row"><span>' + esc(row.label) + '</span><span style="color:' + color + '">' + esc(row.text) + '</span></div>';
    }).join("");
  }

  function buildAnomalies() {
    const anomalies = [];
    const status = state.status && typeof state.status === "object" ? state.status : {};
    const analytics = status.analytics && typeof status.analytics === "object" ? status.analytics : {};
    const snapshot = state.snapshot || {};
    const thresholds = getThresholds();
    const dispersion = Math.abs(n(analytics.signalDispersionBps, 0));
    if (dispersion >= thresholds.dispersionWarn) {
      const sev = dispersion >= thresholds.dispersionRisk ? 0.9 : 0.6;
      anomalies.push({
        id: "dispersion",
        severity: sev,
        title: "Cross-venue dispersion spike",
        detail: dispersion.toFixed(2) + " bps vs warn " + thresholds.dispersionWarn.toFixed(2),
        ageSeconds: Math.max(0, Math.floor((Date.now() - n(snapshot.ts, Date.now())) / 1000)),
        count: 1
      });
    }
    const basis = Math.abs(n(analytics.signalBasisBps, 0));
    if (basis >= thresholds.basisWarn) {
      anomalies.push({
        id: "basis",
        severity: basis >= thresholds.basisWarn * 1.8 ? 0.84 : 0.58,
        title: "RevX vs fair basis dislocation",
        detail: basis.toFixed(2) + " bps vs warn " + thresholds.basisWarn.toFixed(2),
        ageSeconds: Math.max(0, Math.floor((Date.now() - n(snapshot.ts, Date.now())) / 1000)),
        count: 1
      });
    }
    const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    const degraded = providers.filter((row) => !row.ok);
    if (degraded.length > 0) {
      anomalies.push({
        id: "providers",
        severity: degraded.length >= 3 ? 0.72 : 0.48,
        title: "Provider degradation",
        detail: degraded.length + " degraded: " + degraded.slice(0, 3).map((row) => String(row.provider || "x")).join(", "),
        ageSeconds: 0,
        count: degraded.length
      });
    }
    const clusters = Array.isArray(snapshot.clusters) ? snapshot.clusters : [];
    const confirmed = clusters.filter((row) => n(row.maxImpact, 0) >= 0.8 && n(row.confirmations, 0) >= 2);
    if (confirmed.length > 0) {
      anomalies.push({
        id: "confirmed",
        severity: 0.76,
        title: "Confirmed high-impact intel clusters",
        detail: confirmed.length + " clusters with >=2 providers",
        ageSeconds: Math.max(0, Math.floor((Date.now() - n(confirmed[0].ts, Date.now())) / 1000)),
        count: confirmed.length
      });
    }
    return anomalies.sort((a, b) => b.severity - a.severity);
  }

  function renderAnomalies() {
    const list = el("intelAnomalyList");
    if (!list) return;
    const thresholds = getThresholds();
    const rows = buildAnomalies();
    if (rows.length === 0) {
      list.innerHTML =
        '<div class="anomaly-card low">' +
          '<div><strong>No active anomalies</strong></div>' +
          '<div class="muted">Watchers armed: dispersion warn ' + esc(thresholds.dispersionWarn.toFixed(1)) + 'bps, risk ' + esc(thresholds.dispersionRisk.toFixed(1)) + 'bps; basis warn ' + esc(thresholds.basisWarn.toFixed(1)) + 'bps.</div>' +
        '</div>';
      return;
    }
    list.innerHTML = rows.slice(0, 6).map((row) => {
      return '<article class="anomaly-card ' + severityClass(row.severity) + '">' +
        '<div class="mini-row"><strong>' + esc(row.title) + '</strong><span class="pill ' + severityClass(row.severity) + '">' + esc(row.severity.toFixed(2)) + '</span></div>' +
        '<div class="muted">' + esc(row.detail) + '</div>' +
        '<div class="mini-row"><span>count ' + esc(String(row.count)) + '</span><span>age ' + esc(String(row.ageSeconds)) + 's</span></div>' +
      '</article>';
    }).join("");
  }

  function renderDecision() {
    const snapshot = state.snapshot || {};
    const posture = snapshot.posture && typeof snapshot.posture === "object" ? snapshot.posture : {};
    const commentary = snapshot.commentary && typeof snapshot.commentary === "object" ? snapshot.commentary : {};
    const debug = state.debug && typeof state.debug === "object" ? state.debug : {};
    const status = state.status && typeof state.status === "object" ? state.status : {};
    const quoteBlocked = status.botStatus && status.botStatus.quoting && Array.isArray(status.botStatus.quoting.quoteBlockedReasons)
      ? status.botStatus.quoting.quoteBlockedReasons.map((x) => String(x)).filter((x) => x.length > 0)
      : [];

    const stateLabel = String(posture.state || "NORMAL").toUpperCase();
    const impact = clamp(n(posture.impact, 0), 0, 1);
    const direction = String(posture.direction || "NEUTRAL").toUpperCase();
    const confidence = clamp(n(posture.confidence, 0), 0, 1);
    const bias = direction === "UP" ? impact : direction === "DOWN" ? -impact : 0;

    const topbarPosture = el("intelHeaderPosture");
    if (topbarPosture) {
      topbarPosture.textContent = "INTEL: " + stateLabel + " (" + impact.toFixed(2) + ")";
      topbarPosture.className = "chip " + (stateLabel === "NORMAL" ? "good" : stateLabel === "CAUTION" ? "warn" : "bad");
    }
    const fairNode = el("intelHeaderFair");
    if (fairNode) {
      const analytics = status.analytics && typeof status.analytics === "object" ? status.analytics : {};
      fairNode.textContent = "Fair " + n(analytics.signalFairMid, 0).toFixed(2) + " | basis " + n(analytics.signalBasisBps, 0).toFixed(2) + "bps";
    }

    setText("decisionUpdated", "updated " + ageText(snapshot.ts || Date.now()) + " ago");
    setText("decisionHeadline", headlineLine(snapshot));

    const reasonsNode = el("decisionReasons");
    if (reasonsNode) {
      const reasons = Array.isArray(commentary.reasons)
        ? commentary.reasons.map((x) => String(x).trim()).filter((x) => x.length > 0)
        : [];
      const merged = quoteBlocked.slice(0, 2).map((x) => "Blocker: " + x).concat(reasons.slice(0, 4));
      reasonsNode.innerHTML = merged.length > 0
        ? merged.map((row) => "<li>" + esc(row) + "</li>").join("")
        : "<li>No blockers or elevated reasons.</li>";
    }
    const decaySeconds = Math.max(0, Math.floor(n(commentary.decaySeconds, 0)));
    setText(
      "decisionClear",
      stateLabel === "HALT"
        ? "Clear conditions: decay ~" + decaySeconds + "s, confirmed clusters < 2 providers, and no news-anomaly alignment."
        : "Clear conditions: impact decay and driver confirmations falling across providers."
    );

    const driversNode = el("decisionDrivers");
    if (driversNode) {
      const drivers = Array.isArray(commentary.topDrivers) ? commentary.topDrivers.slice(0, 3) : [];
      driversNode.innerHTML = drivers.length === 0
        ? '<div class="driver-row">No active high-impact drivers.</div>'
        : drivers.map((row) => {
            const title = String(row.title || "-");
            const source = String(row.source || "unknown");
            const impactText = n(row.impact, 0).toFixed(2);
            const age = ageText(Date.now() - n(row.ageSeconds, 0) * 1000);
            const url = row.url ? String(row.url) : "";
            const body = esc(source + " • " + age + " • " + String(row.category || "NEWS"));
            const titleHtml = url ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:none;">' + esc(title) + '</a>' : esc(title);
            return '<div class="driver-row"><div><strong>' + titleHtml + '</strong></div><div class="muted">' + body + ' | impact ' + esc(impactText) + '</div></div>';
          }).join("");
    }

    const adj = debug.adjustmentsApplied && typeof debug.adjustmentsApplied === "object" ? debug.adjustmentsApplied : {};
    const spreadMult = n(adj.spreadMult, 1);
    const sizeMult = n(adj.sizeMult, 1);
    const tob = String(adj.tobModeOverride || "UNCHANGED");
    const hardBlock = Boolean(adj.hardBlock);
    setText("influenceBias", bias.toFixed(2));
    setText("influenceConf", confidence.toFixed(2));
    setText("influenceSpread", "x" + spreadMult.toFixed(2));
    setText("influenceSize", "x" + sizeMult.toFixed(2));
    setText("influenceTob", tob);
    setText("influenceHalt", hardBlock ? "hard guard active" : "soft posture only");
    setText("influenceBlocked", quoteBlocked.length > 0 ? quoteBlocked.slice(0, 2).join(" | ") : "none");

    const providerList = el("providerFreshness");
    if (providerList) {
      const freshness = Array.isArray(commentary.providerFreshness) ? commentary.providerFreshness : [];
      const providerHealth = Array.isArray(commentary.providerHealth) ? commentary.providerHealth : [];
      providerList.innerHTML = freshness.length === 0
        ? '<div class="mini-row"><span>No provider data yet</span><span>-</span></div>'
        : freshness.slice(0, 10).map((row) => {
            const provider = String(row.provider || "unknown");
            const ok = Boolean(row.ok);
            const age = n(row.lastItemTs, 0) > 0 ? ageText(row.lastItemTs) : "n/a";
            const itemsLastHour = n(row.itemsLastHour, 0);
            const healthRow = providerHealth.find((entry) => String(entry.provider || "").toLowerCase() === provider.toLowerCase());
            const statusText = ok ? "ok" : "NON_BLOCKING";
            const errorSuffix = !ok && healthRow && healthRow.lastError ? ' • ' + shorten(String(healthRow.lastError), 28) : "";
            return '<div class="mini-row"><span>' + esc(provider) + ' • ' + esc(age) + ' • ' + esc(String(itemsLastHour)) + '/h' + esc(errorSuffix) + '</span><span style="color:' + (ok ? "#1fe39f" : "#f5c35f") + '">' + esc(statusText) + '</span></div>';
          }).join("");
    }

    const diagnosticsNode = el("intelDiagDetails");
    const diagnostics = el("intelDiagnostics");
    if (diagnosticsNode && diagnostics && diagnostics.open) {
      const debugPayload = {
        posture: snapshot.posture || {},
        commentary: commentary,
        adjustmentsApplied: adj,
        dedupeStats: debug.dedupeStats || {},
        uniqueHighImpactCount1m: debug.uniqueHighImpactCount1m || 0,
        providers: snapshot.providers || [],
        quoteBlockedReasons: quoteBlocked
      };
      diagnosticsNode.textContent = JSON.stringify(debugPayload, null, 2);
    }
  }

  function updateSourceFilterOptions() {
    const sourceFilter = el("intelFilterSource");
    if (!(sourceFilter instanceof HTMLSelectElement)) return;
    const clusters = Array.isArray(state.snapshot && state.snapshot.clusters) ? state.snapshot.clusters : [];
    const sourceSet = new Set(["all"]);
    for (const row of clusters) {
      const providers = Array.isArray(row.providerBuckets) ? row.providerBuckets : [];
      for (const provider of providers) {
        const key = String(provider || "").toLowerCase();
        if (key) sourceSet.add(key);
      }
    }
    const options = Array.from(sourceSet).sort((a, b) => a.localeCompare(b));
    if (options.join("|") === state.sourceOptions.join("|")) return;
    state.sourceOptions = options;
    const current = String(state.filters.source || "all").toLowerCase();
    sourceFilter.innerHTML = options.map((value) => {
      const label = value === "all" ? "Source: all" : "Source: " + value;
      return '<option value="' + esc(value) + '">' + esc(label) + '</option>';
    }).join("");
    sourceFilter.value = options.includes(current) ? current : "all";
    state.filters.source = sourceFilter.value;
  }

  function renderTimelineSection() {
    renderSummary();
    renderTimelineChart();
    renderRegimeTimeline();
    renderDeltaPanel();
    renderAnomalies();
  }

  function render() {
    renderBanner();
    updateSourceFilterOptions();
    renderStream();
    renderTimelineSection();
    renderDecision();
  }

  function bindControls() {
    const sort = el("intelSort");
    if (sort instanceof HTMLSelectElement) {
      sort.addEventListener("change", () => {
        state.filters.sort = String(sort.value || "impact");
        renderStream();
      });
    }
    const category = el("intelFilterCategory");
    if (category instanceof HTMLSelectElement) {
      category.addEventListener("change", () => {
        state.filters.category = String(category.value || "all");
        renderStream();
      });
    }
    const source = el("intelFilterSource");
    if (source instanceof HTMLSelectElement) {
      source.addEventListener("change", () => {
        state.filters.source = String(source.value || "all");
        renderStream();
      });
    }
    const diagnostics = el("intelDiagnostics");
    if (diagnostics) {
      diagnostics.addEventListener("toggle", () => {
        renderDecision();
      });
    }
  }

  async function tick() {
    try {
      await refresh();
    } catch (error) {
      const msg = String(error && error.message ? error.message : error);
      setText("intelBannerHeadline", "Intel disconnected: " + msg);
      const staleNode = el("timelineStale");
      if (staleNode) {
        staleNode.textContent = "disconnected";
        staleNode.classList.add("bad");
      }
    }
  }

  bindControls();
  void tick();
  setInterval(() => {
    void tick();
  }, 4000);
})();`;
  if (js.includes('+\n"') || js.includes('+"\n')) {
    throw new Error("Generated intel.js contains raw newline inside string; escape with \\n");
  }
  return js;
}

function renderPerformanceHtml(symbol: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>REVX Performance</title>
  <style>
    :root {
      --bg: #071120;
      --panel: #0d1929;
      --line: rgba(148, 176, 214, 0.24);
      --text: #e8f2ff;
      --muted: #95abc6;
      --good: #20e39f;
      --warn: #f5c35f;
      --bad: #ff6f80;
      --accent: #42b8ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(900px 560px at 0% -10%, rgba(66,184,255,0.14), transparent 60%),
        radial-gradient(860px 460px at 100% 0%, rgba(32,227,159,0.10), transparent 58%),
        linear-gradient(180deg, #050b15 0%, #081323 100%);
      min-height: 100vh;
    }
    .shell {
      width: min(1800px, 100%);
      margin: 0 auto;
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .topbar {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(10, 18, 30, 0.9);
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .title {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.03em;
    }
    .subtitle {
      font-size: 0.75rem;
      color: var(--muted);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.72rem;
      text-decoration: none;
      color: var(--text);
      background: rgba(8, 14, 23, 0.86);
      white-space: nowrap;
    }
    .controls {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(9, 17, 28, 0.9);
      padding: 10px 12px;
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .select,
    .btn {
      border-radius: 8px;
      border: 1px solid var(--line);
      background: rgba(8, 15, 24, 0.92);
      color: var(--text);
      font-size: 0.78rem;
      padding: 6px 8px;
    }
    .btn { cursor: pointer; }
    .btn.warn { border-color: rgba(245,195,95,0.42); color: var(--warn); }
    .btn.good { border-color: rgba(32,227,159,0.42); color: var(--good); }
    .kpis {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(11, 20, 32, 0.92);
      padding: 10px;
      display: grid;
      gap: 6px;
    }
    .kpi-key {
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .kpi-val {
      font-size: 1rem;
      font-weight: 700;
      line-height: 1.1;
    }
    .kpi-sub {
      font-size: 0.76rem;
      color: var(--muted);
      line-height: 1.35;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 10px;
      align-items: start;
    }
    canvas {
      width: 100%;
      height: 240px;
      border: 1px solid rgba(148,176,214,0.2);
      border-radius: 8px;
      background: rgba(8, 14, 24, 0.75);
    }
    .table-wrap {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(11, 20, 32, 0.92);
      overflow: auto;
      max-height: 480px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.76rem;
    }
    thead th {
      position: sticky;
      top: 0;
      background: rgba(10, 18, 28, 0.98);
      z-index: 2;
      text-align: left;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      letter-spacing: 0.05em;
      font-size: 0.66rem;
      text-transform: uppercase;
      border-bottom: 1px solid var(--line);
      padding: 7px 8px;
    }
    td {
      border-bottom: 1px solid rgba(148,176,214,0.12);
      padding: 6px 8px;
      white-space: nowrap;
    }
    .right-stack { display: grid; gap: 10px; }
    .status-line { font-size: 0.76rem; color: var(--muted); }
    .status-line strong { color: var(--text); font-weight: 600; }
    .tiny-chip {
      border: 1px solid rgba(148,176,214,0.22);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 0.68rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      color: var(--muted);
      margin-right: 4px;
    }
    @media (max-width: 1200px) {
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div>
        <div class="title">Performance Analytics</div>
        <div class="subtitle">${escapeInlineHtml(symbol)} • realized/unrealized pnl, edge, toxicity, adaptive controls</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="chip" id="perfLastUpdated">updated -</span>
        <a class="chip" href="/">Open Trading Cockpit</a>
      </div>
    </header>

    <section class="controls">
      <label class="kpi-key" for="perfWindow">Window</label>
      <select id="perfWindow" class="select">
        <option value="1h">1h</option>
        <option value="24h" selected>24h</option>
        <option value="7d">7d</option>
      </select>
      <button class="btn good" id="adaptiveEnableBtn">Enable Adaptive</button>
      <button class="btn warn" id="adaptiveDisableBtn">Disable Adaptive</button>
      <button class="btn" id="adaptiveDefensiveBtn">Apply Defensive Preset</button>
      <button class="btn" id="adaptiveCompetitiveBtn">Apply Competitive Preset</button>
      <span class="status-line" id="adaptiveActionLine">Adaptive: -</span>
    </section>

    <section class="kpis">
      <article class="card"><div class="kpi-key">Net PnL</div><div class="kpi-val" id="kpiNetPnl">-</div><div class="kpi-sub" id="kpiNetPnlSub">-</div></article>
      <article class="card"><div class="kpi-key">Realized / Unrealized</div><div class="kpi-val" id="kpiRealizedPerf">-</div><div class="kpi-sub" id="kpiUnrealizedPerf">-</div></article>
      <article class="card"><div class="kpi-key">Edge / Toxicity</div><div class="kpi-val" id="kpiEdgePerf">-</div><div class="kpi-sub" id="kpiToxicPerf">-</div></article>
      <article class="card"><div class="kpi-key">Activity</div><div class="kpi-val" id="kpiFillsHrPerf">-</div><div class="kpi-sub" id="kpiActivityPerf">-</div></article>
      <article class="card"><div class="kpi-key">Inventory Drift</div><div class="kpi-val" id="kpiInvPerf">-</div><div class="kpi-sub" id="kpiInvPerfSub">-</div></article>
      <article class="card"><div class="kpi-key">Adaptive Mode</div><div class="kpi-val" id="kpiAdaptivePerf">-</div><div class="kpi-sub" id="kpiAdaptivePerfSub">-</div></article>
      <article class="card"><div class="kpi-key">Fees</div><div class="kpi-val" id="kpiFeesPerf">-</div><div class="kpi-sub">Maker/Taker assumptions</div></article>
      <article class="card"><div class="kpi-key">Hold & Churn</div><div class="kpi-val" id="kpiHoldPerf">-</div><div class="kpi-sub" id="kpiChurnPerf">-</div></article>
    </section>

    <section class="grid">
      <article class="card">
        <div class="kpi-key">Equity Curve</div>
        <canvas id="equityCurveCanvas" width="920" height="240"></canvas>
        <div class="kpi-sub" id="equityCurveSummary">-</div>
      </article>
      <div class="right-stack">
        <article class="card">
          <div class="kpi-key">Edge vs Toxicity (last 100 fills)</div>
          <canvas id="edgeToxCanvas" width="700" height="240"></canvas>
          <div class="kpi-sub" id="edgeToxSummary">-</div>
        </article>
        <article class="card">
          <div class="kpi-key">Adaptive Parameters</div>
          <div class="status-line"><strong id="adaptiveParamsLine">-</strong></div>
          <div class="status-line" id="adaptiveDecisionLine">Last decision: -</div>
          <div class="status-line" id="adaptiveGuardrailLine">Guardrail: -</div>
          <div id="adaptiveReasonChips"></div>
        </article>
      </div>
    </section>

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ts</th>
            <th>side</th>
            <th>price</th>
            <th>base qty</th>
            <th>mid@fill</th>
            <th>edge bps</th>
            <th>tox 30s</th>
            <th>tox 2m</th>
            <th>posture</th>
            <th>order</th>
          </tr>
        </thead>
        <tbody id="fillsTableBody"></tbody>
      </table>
    </section>
  </div>
  <script src="/performance.js" defer></script>
</body>
</html>`;
}

function renderPerformanceJs(): string {
  const js = `(() => {
  const state = {
    window: "24h",
    summary: null,
    fills: [],
    curve: [],
    adaptive: null,
    status: null,
    lastHeavyTs: 0
  };

  function el(id) {
    return document.getElementById(id);
  }

  function n(v, d = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  }

  function text(id, value) {
    const node = el(id);
    if (!node) return;
    const next = String(value == null ? "" : value);
    if (node.textContent !== next) node.textContent = next;
  }

  function money(v, d = 2) {
    return n(v, 0).toFixed(d);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pct(v, d = 1) {
    return (n(v, 0) * 100).toFixed(d) + "%";
  }

  function ts(v) {
    const x = n(v, 0);
    if (!(x > 0)) return "-";
    return new Date(x).toLocaleString();
  }

  function ageText(v) {
    const age = Math.max(0, Math.floor((Date.now() - n(v, 0)) / 1000));
    if (age < 60) return age + "s";
    if (age < 3600) return Math.floor(age / 60) + "m";
    return Math.floor(age / 3600) + "h";
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "content-type": "application/json" },
      ...(init || {})
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " for " + url);
    }
    return response.json();
  }

  async function refresh(lightOnly) {
    const windowKey = state.window;
    const summaryUrl = "/api/analysis/summary?window=" + encodeURIComponent(windowKey);
    const adaptiveUrl = "/api/adaptive/status";
    const statusUrl = "/api/status";
    const jobs = [fetchJson(summaryUrl), fetchJson(adaptiveUrl), fetchJson(statusUrl)];
    if (!lightOnly) {
      jobs.push(fetchJson("/api/analysis/fills?window=" + encodeURIComponent(windowKey) + "&limit=100"));
      jobs.push(fetchJson("/api/analysis/equity_curve?window=" + encodeURIComponent(windowKey)));
    }
    const results = await Promise.all(jobs);
    state.summary = results[0] && typeof results[0] === "object" ? results[0] : null;
    state.adaptive = results[1] && typeof results[1] === "object" ? results[1] : null;
    state.status = results[2] && typeof results[2] === "object" ? results[2] : null;
    if (!lightOnly) {
      const fillsResp = results[3] && typeof results[3] === "object" ? results[3] : {};
      const curveResp = results[4] && typeof results[4] === "object" ? results[4] : {};
      state.fills = Array.isArray(fillsResp.rows) ? fillsResp.rows : [];
      state.curve = Array.isArray(curveResp.points) ? curveResp.points : [];
      state.lastHeavyTs = Date.now();
    }
    render();
  }

  function render() {
    const summary = state.summary || {};
    const adaptive = state.adaptive || {};
    const status = state.status || {};
    const analytics = status.analytics && typeof status.analytics === "object" ? status.analytics : {};
    const effective = status.effectiveConfig && typeof status.effectiveConfig === "object" ? status.effectiveConfig : {};
    text("perfLastUpdated", "updated " + ageText(n(summary.computedAtTs, summary.ts)));

    text("kpiNetPnl", "$" + money(summary.netPnlUsd, 2));
    text("kpiNetPnlSub", "window " + String(summary.window || state.window) + " | mid " + money(summary.latestMid, 2));
    text("kpiRealizedPerf", "$" + money(summary.realizedPnlUsd, 2));
    text("kpiUnrealizedPerf", "unrealized $" + money(summary.unrealizedPnlUsd, 2));
    text("kpiEdgePerf", money(summary.avgEdgeBps, 2) + " bps");
    text("kpiToxicPerf", "tox " + money(summary.avgToxBps30s, 2) + " bps | toxic " + pct(summary.toxicPct30s));
    text("kpiFillsHrPerf", money(summary.fillsPerHour, 2));
    text("kpiActivityPerf", "fills " + String(Math.floor(n(summary.fillsCount, 0))) + " | hold " + money(summary.avgHoldSeconds, 1) + "s");
    text("kpiInvPerf", "$" + money(summary.avgInventoryNotionalUsdAbs, 2));
    text("kpiInvPerfSub", "above thresh " + pct(summary.inventoryAboveThresholdPct) + " | skew " + String(summary.inventorySkewDirection || "NEUTRAL"));
    text("kpiAdaptivePerf", adaptive.enabled ? "ENABLED" : "DISABLED");
    text(
      "kpiAdaptivePerfSub",
      "mode " + String(adaptive.lastDecision && adaptive.lastDecision.action ? adaptive.lastDecision.action : "NONE")
    );
    text("kpiFeesPerf", "maker " + money(effective.makerFeeBps, 2) + " / taker " + money(effective.takerFeeBps, 2) + " bps");
    text("kpiHoldPerf", money(summary.avgHoldSeconds, 1) + "s");
    text("kpiChurnPerf", "cancel/replace " + money(summary.cancelReplaceRatio, 2));

    const mode = adaptive.enabled ? "enabled" : "disabled";
    text("adaptiveActionLine", "Adaptive: " + mode + " | last " + String(adaptive.lastEventReason || "none"));
    const params = adaptive.currentParams && typeof adaptive.currentParams === "object" ? adaptive.currentParams : {};
    text(
      "adaptiveParamsLine",
      "mode " +
        String(params.quoteMode || "-") +
        " | spread ticks " +
        String(Math.floor(n(params.baseSpreadTicks, 0))) +
        " | size x" +
        money(params.sizeMultiplier, 2) +
        " | levels " +
        String(Math.floor(n(params.levels, 0))) +
        " | min rest " +
        String(Math.floor(n(params.minRestSeconds, 0))) +
        "s"
    );
    const decision = adaptive.lastDecision && typeof adaptive.lastDecision === "object" ? adaptive.lastDecision : null;
    text(
      "adaptiveDecisionLine",
      "Last decision: " +
        (decision ? String(decision.action || "NONE") + " @ " + ts(decision.ts) + " | " + String(decision.reason || "-") : "none")
    );
    text(
      "adaptiveGuardrailLine",
      "Guardrail: posture " +
        String(adaptive.guardrails && adaptive.guardrails.posture ? adaptive.guardrails.posture : "NORMAL") +
        " | hard limited " +
        (adaptive.guardrails && adaptive.guardrails.hardLimited ? "yes" : "no")
    );
    renderAdaptiveReasonChips(decision);
    renderEquityCurve();
    renderEdgeToxScatter();
    renderFillsTable();
    text(
      "edgeToxSummary",
      "avg edge " + money(summary.avgEdgeBps, 2) + " bps | avg tox30s " + money(summary.avgToxBps30s, 2) + " bps"
    );
  }

  function renderAdaptiveReasonChips(decision) {
    const node = el("adaptiveReasonChips");
    if (!node) return;
    const reasons = decision && typeof decision.reason === "string" && decision.reason.trim().length > 0
      ? decision.reason.split("|").map((v) => v.trim()).filter((v) => v.length > 0)
      : [];
    node.innerHTML = reasons.length
      ? reasons.slice(0, 6).map((reason) => '<span class="tiny-chip">' + escapeHtml(reason) + "</span>").join("")
      : '<span class="tiny-chip">No recent adjustment</span>';
  }

  function renderEquityCurve() {
    const canvas = el("equityCurveCanvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const points = Array.isArray(state.curve) ? state.curve : [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (points.length < 2) {
      ctx.fillStyle = "#90a7c3";
      ctx.font = '13px "IBM Plex Mono", monospace';
      ctx.fillText("Awaiting equity data", 16, 26);
      text("equityCurveSummary", "No equity points for selected window yet.");
      return;
    }
    const vals = points.map((row) => n(row.netPnlUsd, 0));
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    const padX = 36;
    const padY = 24;
    const w = canvas.width - padX * 2;
    const h = canvas.height - padY * 2;
    const range = Math.max(1e-6, max - min);
    ctx.strokeStyle = "rgba(72,184,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((row, idx) => {
      const x = padX + (idx / (points.length - 1)) * w;
      const y = padY + h - ((n(row.netPnlUsd, 0) - min) / range) * h;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const zeroY = padY + h - ((0 - min) / range) * h;
    ctx.strokeStyle = "rgba(245,195,95,0.45)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(padX, zeroY);
    ctx.lineTo(padX + w, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    text("equityCurveSummary", "net pnl min $" + money(min, 2) + " | max $" + money(max, 2) + " | points " + String(points.length));
  }

  function renderEdgeToxScatter() {
    const canvas = el("edgeToxCanvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const fills = Array.isArray(state.fills) ? state.fills.slice(0, 100) : [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (fills.length <= 0) {
      ctx.fillStyle = "#90a7c3";
      ctx.font = '13px "IBM Plex Mono", monospace';
      ctx.fillText("Awaiting fill analytics", 16, 26);
      return;
    }
    const xs = fills.map((row) => n(row.edgeBps, 0));
    const ys = fills.map((row) => n(row.toxBps30s, 0));
    const maxAbs = Math.max(2, ...xs.map((v) => Math.abs(v)), ...ys.map((v) => Math.abs(v)));
    const pad = 24;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    const zeroX = pad + w / 2;
    const zeroY = pad + h / 2;
    ctx.strokeStyle = "rgba(148,176,214,0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, zeroY);
    ctx.lineTo(pad + w, zeroY);
    ctx.moveTo(zeroX, pad);
    ctx.lineTo(zeroX, pad + h);
    ctx.stroke();
    for (const row of fills) {
      const edge = n(row.edgeBps, 0);
      const tox = n(row.toxBps30s, 0);
      const x = zeroX + (edge / maxAbs) * (w / 2);
      const y = zeroY - (tox / maxAbs) * (h / 2);
      ctx.fillStyle = tox < -2 ? "rgba(255,111,128,0.74)" : "rgba(32,227,159,0.74)";
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function renderFillsTable() {
    const body = el("fillsTableBody");
    if (!body) return;
    const rows = Array.isArray(state.fills) ? state.fills : [];
    body.innerHTML = rows.length
      ? rows.slice(0, 50).map((row) => {
          const side = String(row.side || "-");
          const cls = side === "BUY" ? "style=\\"color:#20e39f;\\"" : side === "SELL" ? "style=\\"color:#ff8f9f;\\"" : "";
          return "<tr>" +
            "<td>" + escapeHtml(ts(n(row.ts, 0))) + "</td>" +
            "<td " + cls + ">" + escapeHtml(side) + "</td>" +
            "<td>" + escapeHtml(money(row.price, 2)) + "</td>" +
            "<td>" + escapeHtml(money(row.baseQty, 6)) + "</td>" +
            "<td>" + escapeHtml(money(row.revxMidAtFill, 2)) + "</td>" +
            "<td>" + escapeHtml(money(row.edgeBps, 2)) + "</td>" +
            "<td>" + escapeHtml(money(row.toxBps30s, 2)) + "</td>" +
            "<td>" + escapeHtml(money(row.toxBps2m, 2)) + "</td>" +
            "<td>" + escapeHtml(String(row.posture || "-")) + "</td>" +
            "<td>" + escapeHtml(String(row.clientOrderId || row.orderId || "-")) + "</td>" +
          "</tr>";
        }).join("")
      : '<tr><td colspan="10" style="color:#95abc6;">No fills in selected window.</td></tr>';
  }

  async function setAdaptiveEnabled(enabled) {
    await fetchJson("/api/adaptive/enable", {
      method: "POST",
      body: JSON.stringify({ enabled: Boolean(enabled) })
    });
    await refresh(true);
  }

  async function applyPreset(mode) {
    const patch = mode === "defensive"
      ? { quoteMode: "STEP_BACK", baseSpreadTicks: 2, sizeMultiplier: 0.75, levels: 1, minRestSeconds: 12 }
      : { quoteMode: "JOIN_TOB", baseSpreadTicks: 0, sizeMultiplier: 1, levels: 3, minRestSeconds: 8 };
    await fetchJson("/api/adaptive/setParams", {
      method: "POST",
      body: JSON.stringify(patch)
    });
    await refresh(true);
  }

  function bind() {
    const windowSelect = el("perfWindow");
    if (windowSelect instanceof HTMLSelectElement) {
      windowSelect.value = state.window;
      windowSelect.addEventListener("change", () => {
        state.window = String(windowSelect.value || "24h");
        void refresh(false);
      });
    }
    const enableBtn = el("adaptiveEnableBtn");
    if (enableBtn) {
      enableBtn.addEventListener("click", () => void setAdaptiveEnabled(true));
    }
    const disableBtn = el("adaptiveDisableBtn");
    if (disableBtn) {
      disableBtn.addEventListener("click", () => void setAdaptiveEnabled(false));
    }
    const defensiveBtn = el("adaptiveDefensiveBtn");
    if (defensiveBtn) {
      defensiveBtn.addEventListener("click", () => void applyPreset("defensive"));
    }
    const competitiveBtn = el("adaptiveCompetitiveBtn");
    if (competitiveBtn) {
      competitiveBtn.addEventListener("click", () => void applyPreset("competitive"));
    }
  }

  async function tick() {
    try {
      const heavy = Date.now() - state.lastHeavyTs > 10_000;
      await refresh(!heavy);
    } catch (error) {
      text("perfLastUpdated", "update failed: " + String(error && error.message ? error.message : error));
    }
  }

  bind();
  void tick();
  setInterval(() => {
    void tick();
  }, 5000);
})();`;
  if (js.includes('+\n"') || js.includes('+"\n')) {
    throw new Error("Generated performance.js contains raw newline inside string; escape with \\n");
  }
  return js;
}


function renderDashboardJs(
  maxUiEventsDefault: number,
  maxEquityPointsDefault: number,
  equitySampleMsDefault: number,
  persistEquitySeriesDefault: boolean,
  symbol: string
): string {
  const useEquitySeriesScript = sanitizeJsForHtmlScript(
    renderUseEquitySeriesScript({
      maxEquityPointsDefault,
      equitySampleMsDefault,
      persistDefault: persistEquitySeriesDefault,
      symbol
    })
  );
  const equityChartScript = sanitizeJsForHtmlScript(renderEquityChartScript());
  const drawdownChartScript = sanitizeJsForHtmlScript(renderDrawdownChartScript());

  const js = `    const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
    const fmtMid = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    const BUILD_ID = "ui-" + Date.now();
    window.__REVX_BOOT_ERR__ = "";
    window.__REVX_HEARTBEAT__ = 0;
    window.__REVX_LAST_TICK__ = Date.now();
    window.__REVX_STORE__ = null;
    window.__REVX_DEBUG_LAST_PAINT__ = 0;
    window.addEventListener("error", (e) => {
      window.__REVX_BOOT_ERR__ = String((e && e.message) || e || "");
    });
    window.addEventListener("unhandledrejection", (e) => {
      const reason = e && e.reason;
      window.__REVX_BOOT_ERR__ = String((reason && reason.message) || reason || e || "");
    });
    const DEBUG_OVERLAY_STORAGE_KEY = "revx_ui_debug_panel_open";

    function readDebugOverlayOpen() {
      try {
        const raw = localStorage.getItem(DEBUG_OVERLAY_STORAGE_KEY);
        return raw === "1";
      } catch {
        return false;
      }
    }

    function writeDebugOverlayOpen(open) {
      try {
        localStorage.setItem(DEBUG_OVERLAY_STORAGE_KEY, open ? "1" : "0");
      } catch {
        // ignore storage errors
      }
    }

    function createDebugOverlay() {
      const panel = document.getElementById("debugPanel");
      const toggle = document.getElementById("debugToggle");
      if (!panel) return;
      let open = readDebugOverlayOpen();
      if (panel instanceof HTMLDetailsElement) {
        panel.open = open;
      } else {
        panel.classList.toggle("collapsed", !open);
      }
      const applyOpen = () => {
        if (panel instanceof HTMLDetailsElement) {
          panel.open = open;
        } else {
          panel.classList.toggle("collapsed", !open);
        }
        if (toggle) toggle.setAttribute("aria-pressed", open ? "true" : "false");
      };
      applyOpen();
      const flip = () => {
        open = !open;
        applyOpen();
        writeDebugOverlayOpen(open);
      };
      if (toggle) {
        toggle.addEventListener("click", flip);
      }
      if (panel instanceof HTMLDetailsElement) {
        panel.addEventListener("toggle", () => {
          open = panel.open;
          writeDebugOverlayOpen(open);
          if (toggle) toggle.setAttribute("aria-pressed", open ? "true" : "false");
        });
      }
    }

    function buildDebugSnapshot(state) {
      const now = Date.now();
      const payload = state && state.data && typeof state.data === "object" ? state.data : null;
      const connected =
        state && Number(state.lastSuccessMs) > 0 && now - Number(state.lastSuccessMs) < 12000;
      const refreshCount = state ? Number(state.refreshCount || 0) : 0;
      const lastAttemptMs = state ? Number(state.lastRefreshAttemptMs || 0) : 0;
      const lastSuccessMs = state ? Number(state.lastSuccessMs || 0) : 0;
      const payloadTs = payload && Number(payload.ts) > 0 ? Number(payload.ts) : 0;
      const runId = payload && payload.runId ? String(payload.runId) : "-";
      const symbol = payload && payload.symbol ? String(payload.symbol) : "-";
      const lastErrRaw =
        (state && state.lastError ? String(state.lastError) : "") ||
        (payload && payload.ok === false ? String(payload.error || "status returned ok:false") : "");
      const bootErrRaw = String(window.__REVX_BOOT_ERR__ || "");
      const lastErr = lastErrRaw.trim().slice(0, 220);
      const bootErr = bootErrRaw.trim().slice(0, 220);
      const hb = Number(window.__REVX_HEARTBEAT__ || 0);
      const tickAge = Math.floor(Math.max(0, now - Number(window.__REVX_LAST_TICK__ || 0)) / 1000);
      const lastSuccessAge = Math.floor(Math.max(0, now - lastSuccessMs) / 1000);
      return {
        now,
        connected,
        refreshCount,
        lastAttemptMs,
        lastSuccessMs,
        payloadTs,
        runId,
        symbol,
        lastErr,
        bootErr,
        hb,
        tickAge,
        lastSuccessAge
      };
    }

    function updateDebugOverlay(snapshot, force) {
      const now = Date.now();
      const panel = document.getElementById("debugPanel");
      const isOpen =
        panel instanceof HTMLDetailsElement
          ? panel.open
          : panel
            ? !panel.classList.contains("collapsed")
            : false;
      if (!force && !isOpen) {
        return;
      }
      if (!force && now - Number(window.__REVX_DEBUG_LAST_PAINT__ || 0) < 500) {
        return;
      }
      window.__REVX_DEBUG_LAST_PAINT__ = now;
      const summaryNode = document.getElementById("debugStrip");
      const detailsNode = document.getElementById("debugDetails");
      if (summaryNode) {
        summaryNode.textContent =
          "DBG • ok • hb " +
          String(snapshot.hb) +
          " • refresh " +
          String(snapshot.refreshCount) +
          " • conn " +
          String(Boolean(snapshot.connected)) +
          " • age " +
          String(snapshot.lastSuccessAge) +
          "s";
      }
      if (detailsNode) {
        const lastAttemptLabel = snapshot.lastAttemptMs > 0 ? new Date(snapshot.lastAttemptMs).toLocaleTimeString() : "-";
        const payloadTsLabel = snapshot.payloadTs > 0 ? new Date(snapshot.payloadTs).toLocaleTimeString() : "null";
        detailsNode.textContent =
          "build=" +
          BUILD_ID +
          " hb=" +
          String(snapshot.hb) +
          " tickAge=" +
          String(snapshot.tickAge) +
          "s refresh=" +
          String(snapshot.refreshCount) +
          " connected=" +
          String(Boolean(snapshot.connected)) +
          " lastAttempt=" +
          lastAttemptLabel +
          " lastSuccessAge=" +
          String(snapshot.lastSuccessAge) +
          "s payload.ts=" +
          payloadTsLabel +
          " run/symbol=" +
          snapshot.runId +
          "/" +
          snapshot.symbol +
          (snapshot.lastErr ? "\\nerr=" + snapshot.lastErr : "\\nerr=-") +
          (snapshot.bootErr ? "\\nbootErr=" + snapshot.bootErr : "\\nbootErr=-");
      }
    }

    setInterval(() => {
      window.__REVX_HEARTBEAT__ += 1;
      window.__REVX_LAST_TICK__ = Date.now();
      let state = null;
      try {
        const activeStore = window.__REVX_STORE__;
        state = activeStore && typeof activeStore.getState === "function" ? activeStore.getState() : null;
      } catch {
        state = null;
      }
      updateDebugOverlay(buildDebugSnapshot(state), false);
    }, 1000);
    const WINDOW_ORDER = ["24h", "12h", "4h", "1h", "15m"];
    const EVENT_LIMIT_OPTIONS = [50, 200, 500, 2000];
    const DEFAULT_MAX_UI_EVENTS = ${Math.min(2000, Math.max(50, maxUiEventsDefault))};

    function normalizeEventLimit(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return DEFAULT_MAX_UI_EVENTS;
      if (EVENT_LIMIT_OPTIONS.includes(parsed)) return parsed;
      let nearest = EVENT_LIMIT_OPTIONS[0];
      let bestDist = Math.abs(parsed - nearest);
      for (const option of EVENT_LIMIT_OPTIONS) {
        const dist = Math.abs(parsed - option);
        if (dist < bestDist) {
          nearest = option;
          bestDist = dist;
        }
      }
      return nearest;
    }

    ${useEquitySeriesScript}

    ${equityChartScript}

    ${drawdownChartScript}

    const UI_SETTINGS_STORAGE_KEY = "revx_dashboard_ui_settings_v2";
    const HEADER_COMPACT_STORAGE_KEY = "revx_ui_header_compact";
    const NAV_COLLAPSED_STORAGE_KEY = "ui.navCollapsed";
    const VALID_VIEWS = ["operate", "overrides", "diagnose", "optimize", "audit"];
    const VALID_CHART_MODES = ["equity", "drawdown", "fills", "edge"];
    const VALID_AUTOPILOT_MODES = ["OFF", "ADVISORY", "ON"];

    function readUiSettings() {
      try {
        const raw = localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        return parsed;
      } catch {
        return {};
      }
    }

    function readHeaderCompactState() {
      try {
        const raw = localStorage.getItem(HEADER_COMPACT_STORAGE_KEY);
        if (raw === null) return true;
        const normalized = String(raw).trim().toLowerCase();
        if (normalized === "false" || normalized === "0" || normalized === "no") return false;
        return true;
      } catch {
        return true;
      }
    }

    function writeHeaderCompactState(compact) {
      try {
        localStorage.setItem(HEADER_COMPACT_STORAGE_KEY, compact ? "true" : "false");
      } catch {
        // ignore storage errors
      }
    }

    function readNavCollapsedState(savedSettings) {
      try {
        const raw = localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY);
        if (raw !== null) {
          const normalized = String(raw).trim().toLowerCase();
          if (normalized === "false" || normalized === "0" || normalized === "no") return false;
          return true;
        }
      } catch {
        // ignore storage errors
      }
      if (savedSettings && typeof savedSettings.navCollapsed === "boolean") {
        return savedSettings.navCollapsed;
      }
      return true;
    }

    function writeNavCollapsedState(collapsed) {
      try {
        localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
      } catch {
        // ignore storage errors
      }
    }

    function writeUiSettings(settings) {
      try {
        localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings || {}));
      } catch {
        // ignore storage errors
      }
    }

    let latestOverrideDiff = [];
    let latestOverrideWarnings = [];
    let ordersRenderFrame = 0;

    function useDashboardState() {
      const savedSettings = readUiSettings();
      const initialMaxUiEvents = normalizeEventLimit(savedSettings.maxUiEvents ?? DEFAULT_MAX_UI_EVENTS);
      const initialMaxEquityPoints = eqNormalizeMaxPoints(savedSettings.maxEquityPoints ?? DEFAULT_MAX_EQUITY_POINTS);
      const initialEquitySampleMs = eqNormalizeSampleMs(savedSettings.equitySampleMs ?? DEFAULT_EQUITY_SAMPLE_MS);
      const initialPersistEquitySeries =
        typeof savedSettings.persistEquitySeries === "boolean"
          ? savedSettings.persistEquitySeries
          : DEFAULT_PERSIST_EQUITY_SERIES;
      const state = {
        data: null,
        lastSuccessMs: 0,
        lastRefreshAttemptMs: 0,
        refreshCount: 0,
        lastError: "",
        pnlWindow: "24h",
        equityMode: "USD",
        equityWindow: "24h",
        drawdownMode: "abs",
        eventFilter: "ALL",
        uiEvents: [],
        maxUiEvents: initialMaxUiEvents,
        maxEquityPoints: initialMaxEquityPoints,
        equitySampleMs: initialEquitySampleMs,
        persistEquitySeries: initialPersistEquitySeries,
        equityStorageKey: DEFAULT_EQUITY_STORAGE_KEY,
        equitySeries: initialPersistEquitySeries ? eqReadPersistedSeries(DEFAULT_EQUITY_STORAGE_KEY) : [],
        view: "operate",
        viewTab: "operate",
        chartMode: "equity",
        primarySeriesMode: "equity",
        autopilotMode: "OFF",
        headerCompact: readHeaderCompactState(),
        navCollapsed: readNavCollapsedState(savedSettings),
        venueQuotesFilter: "all",
        decisionHistory: [],
        regimeHistory: [],
        computedAutonomy: null,
        selectedDecisionIndex: -1,
        signalsSnapshot: null,
        signalsError: "",
        lastSignalsFetchMs: 0,
        intelTab: "signals",
        signalKindFilter: "all",
        newsCategoryFilter: "all",
        newsImpactFilter: "all",
        orderViewFilter: "open"
      };
      const listeners = [];
      let inFlight = false;
      let settingsPersistTimer = null;

      function getState() { return state; }
      function subscribe(fn) { listeners.push(fn); return () => { const idx = listeners.indexOf(fn); if (idx >= 0) listeners.splice(idx, 1); }; }
      function notify() { for (const fn of listeners) fn(state); }
      function persistSettingsSoon() {
        if (settingsPersistTimer) clearTimeout(settingsPersistTimer);
        settingsPersistTimer = setTimeout(() => {
          settingsPersistTimer = null;
          writeUiSettings({
            maxUiEvents: state.maxUiEvents,
            maxEquityPoints: state.maxEquityPoints,
            equitySampleMs: state.equitySampleMs,
            persistEquitySeries: state.persistEquitySeries,
            navCollapsed: state.navCollapsed
          });
        }, 40);
      }

      async function refresh() {
        if (inFlight) return;
        inFlight = true;
        state.lastRefreshAttemptMs = Date.now();
        notify();
        try {
          const r = await fetch(
            "/api/status?window=" +
              encodeURIComponent(state.pnlWindow) +
              "&limit=" +
              encodeURIComponent(String(state.maxUiEvents)),
            { cache: "no-store" }
          );
          if (!r.ok) throw new Error("status " + r.status);
          const payload = await r.json();
          const externalQuotes = Array.isArray(payload.externalQuotes)
            ? payload.externalQuotes
            : payload.externalQuotes && typeof payload.externalQuotes === "object"
              ? Object.values(payload.externalQuotes)
              : [];
          payload.externalQuotes = externalQuotes;
          const incoming = Array.isArray(payload.recentEvents) ? payload.recentEvents : buildEvents(payload);
          state.uiEvents = mergeEvents(state.uiEvents, incoming, state.maxUiEvents);
          state.equitySeries = useEquitySeries(payload, state.equitySeries, {
            maxPoints: state.maxEquityPoints,
            sampleMs: state.equitySampleMs,
            persist: state.persistEquitySeries,
            storageKey: state.equityStorageKey
          });
          state.regimeHistory = mergeRegimeHistory(
            state.regimeHistory,
            n(payload.ts, Date.now()),
            String((payload.analytics || {}).signalVolRegime || "normal")
          );
          state.decisionHistory = mergeDecisionHistory(state.decisionHistory, payload);
          state.computedAutonomy = computeAutonomyRecommendation(payload);
          state.data = payload;
          if (Date.now() - n(state.lastSignalsFetchMs, 0) >= 10_000 || !state.signalsSnapshot) {
            try {
              const signalsResp = await fetch("/api/intel/snapshot", { cache: "no-store" });
              if (signalsResp.ok) {
                state.signalsSnapshot = await signalsResp.json();
                state.lastSignalsFetchMs = Date.now();
                state.signalsError = "";
              } else {
                state.signalsError = "signals " + signalsResp.status;
              }
            } catch (signalsErr) {
              state.signalsError = String(signalsErr && signalsErr.message ? signalsErr.message : signalsErr);
            }
          }
          state.lastSuccessMs = Date.now();
          state.refreshCount = n(state.refreshCount, 0) + 1;
          state.lastError = "";
        } catch (err) {
          state.lastError = String(err && err.message ? err.message : err);
        } finally {
          inFlight = false;
          notify();
        }
      }

      async function action(path, body) {
        const r = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {})
        });
        if (!r.ok) {
          const maybe = await r.text();
          throw new Error(maybe || ("action failed " + r.status));
        }
        await refresh();
        return r.json();
      }

      function setWindow(windowKey) {
        if (!WINDOW_ORDER.includes(windowKey)) return;
        state.pnlWindow = windowKey;
        notify();
        void refresh();
      }

      function setEventFilter(filter) {
        state.eventFilter = filter;
        notify();
      }

      function setMaxUiEvents(limit) {
        state.maxUiEvents = normalizeEventLimit(limit);
        state.uiEvents = state.uiEvents.slice(0, state.maxUiEvents);
        persistSettingsSoon();
        notify();
        void refresh();
      }

      function setView(view) {
        if (!VALID_VIEWS.includes(view)) return;
        state.view = view;
        state.viewTab = view;
        notify();
      }

      function setChartMode(mode) {
        if (!VALID_CHART_MODES.includes(mode)) return;
        state.chartMode = mode;
        notify();
      }

      function setAutopilotMode(mode) {
        if (!VALID_AUTOPILOT_MODES.includes(mode)) return;
        state.autopilotMode = mode;
        notify();
      }

      function setHeaderCompact(compact) {
        state.headerCompact = Boolean(compact);
        writeHeaderCompactState(state.headerCompact);
        notify();
      }

      function setNavCollapsed(collapsed) {
        state.navCollapsed = Boolean(collapsed);
        writeNavCollapsedState(state.navCollapsed);
        persistSettingsSoon();
        notify();
      }

      function toggleNavCollapsed() {
        setNavCollapsed(!state.navCollapsed);
      }

      function setVenueQuotesFilter(value) {
        if (value !== "all" && value !== "active" && value !== "stale") return;
        state.venueQuotesFilter = value;
        notify();
      }

      function setIntelTab(value) {
        if (value !== "signals" && value !== "events" && value !== "orders") return;
        state.intelTab = value;
        notify();
      }

      function setSignalKindFilter(value) {
        const normalized = String(value || "all").toLowerCase();
        if (
          normalized !== "all" &&
          normalized !== "news" &&
          normalized !== "macro" &&
          normalized !== "system" &&
          normalized !== "onchain"
        ) {
          return;
        }
        state.signalKindFilter = normalized;
        notify();
      }

      function setNewsCategoryFilter(value) {
        state.newsCategoryFilter = String(value || "all").toLowerCase();
        notify();
      }

      function setNewsImpactFilter(value) {
        if (value !== "all" && value !== "med" && value !== "high") return;
        state.newsImpactFilter = value;
        notify();
      }

      function setOrderViewFilter(value) {
        const normalized = String(value || "open").toLowerCase();
        if (normalized !== "open" && normalized !== "pending" && normalized !== "all") return;
        state.orderViewFilter = normalized;
        notify();
      }

      function setPrimarySeriesMode(mode) {
        if (mode !== "equity" && mode !== "pnl") return;
        state.primarySeriesMode = mode;
        notify();
      }

      function setEquityMode(mode) {
        if (mode !== "USD" && mode !== "BTC") return;
        state.equityMode = mode;
        notify();
      }

      function setEquityWindow(windowKey) {
        const valid = ["15m", "1h", "4h", "12h", "24h"];
        if (!valid.includes(windowKey)) return;
        state.equityWindow = windowKey;
        notify();
      }

      function setDrawdownMode(mode) {
        if (mode !== "abs" && mode !== "pct") return;
        state.drawdownMode = mode;
        notify();
      }

      function setMaxEquityPoints(value) {
        state.maxEquityPoints = eqNormalizeMaxPoints(value);
        if (state.equitySeries.length > state.maxEquityPoints) {
          state.equitySeries = state.equitySeries.slice(state.equitySeries.length - state.maxEquityPoints);
        }
        if (state.persistEquitySeries) {
          eqWritePersistedSeries(state.equityStorageKey, state.equitySeries);
        }
        persistSettingsSoon();
        notify();
      }

      function setEquitySampleMs(value) {
        state.equitySampleMs = eqNormalizeSampleMs(value);
        persistSettingsSoon();
        notify();
      }

      function setPersistEquitySeries(value) {
        state.persistEquitySeries = Boolean(value);
        if (state.persistEquitySeries) {
          eqWritePersistedSeries(state.equityStorageKey, state.equitySeries);
        } else {
          eqClearPersistedSeries(state.equityStorageKey);
        }
        persistSettingsSoon();
        notify();
      }

      function resetEquitySeries() {
        state.equitySeries = [];
        eqClearPersistedSeries(state.equityStorageKey);
        notify();
      }

      return {
        getState,
        subscribe,
        refresh,
        setWindow,
        setEventFilter,
        setMaxUiEvents,
        setView,
        setChartMode,
        setAutopilotMode,
        setHeaderCompact,
        setNavCollapsed,
        toggleNavCollapsed,
        setVenueQuotesFilter,
        setIntelTab,
        setSignalKindFilter,
        setNewsCategoryFilter,
        setNewsImpactFilter,
        setOrderViewFilter,
        setPrimarySeriesMode,
        setEquityMode,
        setEquityWindow,
        setDrawdownMode,
        setMaxEquityPoints,
        setEquitySampleMs,
        setPersistEquitySeries,
        resetEquitySeries,
        action
      };
    }

    function el(id) { return document.getElementById(id); }
    function text(id, v) { const node = el(id); if (node) node.textContent = v; }

    function n(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function ts(ms) {
      if (!ms) return "-";
      return new Date(ms).toLocaleTimeString();
    }

    function ageSince(ms) {
      if (!ms) return "-";
      const delta = Math.max(0, Date.now() - Number(ms));
      const totalSeconds = Math.floor(delta / 1000);
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    }

    function relTimeFromTs(tsMs) {
      const t = n(tsMs, 0);
      if (!(t > 0)) return "never";
      const delta = Math.max(0, Date.now() - t);
      const sec = Math.floor(delta / 1000);
      if (sec < 5) return "just now";
      if (sec < 60) return String(sec) + "s ago";
      const min = Math.floor(sec / 60);
      if (min < 60) return String(min) + "m ago";
      const hrs = Math.floor(min / 60);
      if (hrs < 24) return String(hrs) + "h ago";
      const days = Math.floor(hrs / 24);
      return String(days) + "d ago";
    }

    function money(v, d = 2) {
      const x = Number(v);
      if (!Number.isFinite(x)) return "-";
      return x.toFixed(d);
    }

    function parseNumericField(value) {
      if (value === null || value === undefined) return null;
      if (typeof value === "string" && value.trim().length === 0) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function parseQuotePrice(value) {
      const parsed = parseNumericField(value);
      return parsed !== null && parsed > 0 ? parsed : null;
    }

    function quoteFromOrder(order) {
      const directFields = [
        order.quote_size,
        order.quoteSize,
        order.quoteSizeUsd,
        order.quote_size_usd,
        order.quote_amount,
        order.notional
      ];
      for (const value of directFields) {
        const parsed = parseNumericField(value);
        if (parsed !== null && parsed > 0) return parsed;
      }

      const qty =
        parseNumericField(order.qty) ??
        parseNumericField(order.quantity) ??
        parseNumericField(order.base_size) ??
        parseNumericField(order.size);
      const price = parseNumericField(order.price);
      if (qty !== null && qty > 0 && price !== null && price > 0) {
        return qty * price;
      }
      return null;
    }

    function normalizeAssetCodeForUi(row) {
      if (!row || typeof row !== "object") return "";
      const values = [row.asset, row.currency, row.code, row.ccy, row.symbol];
      for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim().toUpperCase();
        }
      }
      return "";
    }

    function findBalanceRow(rows, aliases) {
      if (!Array.isArray(rows)) return null;
      const wanted = new Set((aliases || []).map((value) => String(value).toUpperCase()));
      for (const row of rows) {
        const code = normalizeAssetCodeForUi(row);
        if (wanted.has(code)) return row;
      }
      return null;
    }

    function computeClientEquity(data) {
      const rows = Array.isArray(data && data.balances) ? data.balances : [];
      const ticker = data && data.ticker ? data.ticker : {};
      const mid = n(ticker.mid, 0);
      const usdRow = findBalanceRow(rows, ["USD", "USDC"]);
      const btcRow = findBalanceRow(rows, ["BTC", "XBT"]);
      const usd_total = n(usdRow && usdRow.total, 0);
      const usd_free = n(usdRow && usdRow.free, 0);
      const btc_total = n(btcRow && btcRow.total, 0);
      const btc_free = n(btcRow && btcRow.free, 0);

      if (!(mid > 0)) {
        return {
          mid,
          usd_total,
          usd_free,
          btc_total,
          btc_free,
          equityUsd: 0,
          equityBtc: 0,
          btcNotionalUsd: 0,
          usdNotionalBtc: 0
        };
      }

      const equityUsd = usd_total + btc_total * mid;
      const equityBtc = btc_total + usd_total / mid;
      const btcNotionalUsd = btc_total * mid;
      const usdNotionalBtc = usd_total / mid;
      return {
        mid,
        usd_total,
        usd_free,
        btc_total,
        btc_free,
        equityUsd,
        equityBtc,
        btcNotionalUsd,
        usdNotionalBtc
      };
    }

    function classifyEventType(status) {
      const s = String(status || "").toUpperCase();
      if (!s) return "PLACED";
      if (s.includes("REPLACED")) return "REPLACED";
      if (s.includes("CANCEL")) return "CANCELLED";
      if (s.includes("FILL")) return "FILLED";
      if (s.includes("REJECT")) return "REJECTED";
      if (s.includes("ERROR") || s.includes("FAIL")) return "ERROR";
      return "PLACED";
    }

    function eventBadgeClass(type) {
      if (type === "PLACED") return "b-placed";
      if (type === "CANCELLED") return "b-cancelled";
      if (type === "FILLED") return "b-filled";
      if (type === "REPLACED") return "b-replaced";
      if (type === "SEED_TAKER") return "b-seed";
      if (type === "REJECTED") return "b-rejected";
      if (type === "OVERRIDE") return "b-override";
      return "b-error";
    }

    function statusToGate(enabled, reasons) {
      if (enabled === null || enabled === undefined) {
        return { short: "unknown", details: "awaiting first strategy cycle", ok: false };
      }
      if (enabled) {
        return { short: "enabled", details: "all checks passed", ok: true };
      }
      const detail = Array.isArray(reasons) && reasons.length > 0 ? reasons.join("; ") : "blocked";
      return { short: "blocked", details: detail, ok: false };
    }

    function buildEvents(data) {
      const events = [];
      const orders = Array.isArray(data.recentBotOrders) ? data.recentBotOrders : [];
      const fills = Array.isArray(data.recentFills) ? data.recentFills : [];
      const rows = Array.isArray(data.recentEvents) ? data.recentEvents : [];

      for (const row of rows) {
        events.push(normalizeIncomingEvent(row));
      }

      for (const row of orders) {
        events.push({
          event_id:
            "order:" +
            String(row.ts || row.updated_at || 0) +
            ":" +
            String(row.status || "") +
            ":" +
            String(row.venue_order_id || "-") +
            ":" +
            String(row.client_order_id || "-"),
          ts: n(row.ts || row.updated_at, 0),
          type: classifyEventType(row.status),
          side: String(row.side || "-"),
          price: n(row.price, Number.NaN),
          size: quoteFromOrder(row),
          reason: String(row.status || ""),
          client_id: String(row.client_order_id || "-"),
          client_order_id: String(row.client_order_id || "-"),
          venue_order_id: String(row.venue_order_id || "-")
        });
      }

      for (const row of fills) {
        events.push({
          event_id: "fill:" + String(row.trade_id || "-") + ":" + String(row.ts || 0),
          ts: n(row.ts, 0),
          type: "FILLED",
          side: "-",
          price: n(row.price, Number.NaN),
          size: n(row.qty, Number.NaN),
          reason: "trade " + String(row.trade_id || "-"),
          client_id: "-",
          client_order_id: "-",
          venue_order_id: String(row.venue_order_id || "-")
        });
      }

      events.sort((a, b) => b.ts - a.ts);
      return events;
    }

    function normalizeIncomingEvent(row) {
      return {
        event_id: String(
            row.event_id ||
            row.eventId ||
            (String(row.ts || 0) +
              ":" +
              String(row.type || "") +
              ":" +
              String(row.venue_order_id || row.order_id || "-") +
              ":" +
              String(row.client_order_id || row.client_id || row.clientId || "-"))
        ),
        ts: n(row.ts, 0),
        type: String(row.type || "PLACED").toUpperCase(),
        side: String(row.side || "-").toUpperCase(),
        price: parseNumericField(row.price),
        size: parseNumericField(row.size ?? row.qty ?? row.quote_size ?? row.quoteSizeUsd),
        reason: String(row.reason || row.status || ""),
        client_id: String(row.client_id || row.clientId || row.client_order_id || "-"),
        client_order_id: String(row.client_order_id || row.client_id || row.clientId || "-"),
        venue_order_id: String(row.venue_order_id || row.venueId || row.order_id || "-")
      };
    }

    function eventKey(row) {
      if (row && row.event_id) return String(row.event_id);
      const venueOrderId = String((row && (row.venue_order_id || row.order_id)) || "-");
      const clientOrderId = String((row && (row.client_order_id || row.client_id || row.clientId)) || "-");
      return (
        String(n(row && row.ts, 0)) +
        "|" +
        String((row && row.type) || "-") +
        "|" +
        venueOrderId +
        "|" +
        clientOrderId
      );
    }

    function mergeEvents(existing, incoming, maxEvents) {
      const merged = [];
      const seen = new Set();
      const combined = []
        .concat(Array.isArray(incoming) ? incoming : [])
        .concat(Array.isArray(existing) ? existing : [])
        .map((row) => normalizeIncomingEvent(row))
        .sort((a, b) => n(b.ts, 0) - n(a.ts, 0));

      for (const row of combined) {
        const key = eventKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
        if (merged.length >= maxEvents) break;
      }

      return merged;
    }

    function mergeRegimeHistory(existing, tsMs, regime) {
      const next = Array.isArray(existing) ? existing.slice() : [];
      const key = String(regime || "normal").toLowerCase();
      const tsBucket = Math.floor(n(tsMs, Date.now()) / 2000) * 2000;
      const last = next.length > 0 ? next[next.length - 1] : null;
      if (last && n(last.ts, 0) === tsBucket && String(last.regime) === key) {
        return next;
      }
      next.push({ ts: tsBucket, regime: key });
      if (next.length > 1800) {
        return next.slice(next.length - 1800);
      }
      return next;
    }

    function mergeDecisionHistory(existing, payload) {
      const next = Array.isArray(existing) ? existing.slice() : [];
      const analytics = payload && payload.analytics ? payload.analytics : {};
      const bot = payload && payload.botStatus ? payload.botStatus : {};
      const ticker = payload && payload.ticker ? payload.ticker : {};
      const details =
        bot.latest_decision_details && typeof bot.latest_decision_details === "object"
          ? bot.latest_decision_details
          : {};
      const tsMs = n(payload && payload.ts, Date.now());
      const snapshot = {
        ts: tsMs,
        mid: n(ticker.mid, 0),
        spreadBps: n(ticker.mid, 0) > 0 ? ((n(ticker.ask, 0) - n(ticker.bid, 0)) / n(ticker.mid, 1)) * 10000 : 0,
        allow_buy: Boolean(bot.allow_buy),
        allow_sell: Boolean(bot.allow_sell),
        trendMoveBps: n(analytics.trendMoveBps, n(bot.trend_move_bps, 0)),
        effectiveHalfSpreadBps: n(analytics.effectiveHalfSpreadBps, 0),
        adaptiveDelta: n(analytics.adaptiveSpreadDeltaBps, 0),
        inventoryRatio: n(bot.inventory_ratio, 0),
        fills30m: n(analytics.fillsLast30m, 0),
        cancels1h: n(analytics.cancelsLast1h, 0),
        rejects1h: n(analytics.postOnlyRejectsLast1h, 0),
        signalVolRegime: String(analytics.signalVolRegime || "normal"),
        drift: n(analytics.signalDriftBps, 0),
        z: n(analytics.signalZScore, 0),
        confidence: n(analytics.signalConfidence, 0),
        reasons: Array.isArray(analytics.adaptiveAdjustments) ? analytics.adaptiveAdjustments : [],
        details,
        payload
      };
      const last = next.length > 0 ? next[next.length - 1] : null;
      if (!last || n(last.ts, 0) !== tsMs) {
        next.push(snapshot);
      }
      if (next.length > 2000) {
        return next.slice(next.length - 2000);
      }
      return next;
    }

    function computeAutonomyRecommendation(payload) {
      const analytics = payload && payload.analytics ? payload.analytics : {};
      const fills30m = n(analytics.fillsLast30m, 0);
      const fills1h = n(analytics.fillsLast1h, n(analytics.fills1hCount, 0));
      const cancels1h = n(analytics.cancelsLast1h, 0);
      const rejects1h = n(analytics.postOnlyRejectsLast1h, 0);
      const avgEdge = (n(analytics.avgEdgeBps1hBuy, 0) + n(analytics.avgEdgeBps1hSell, 0)) / 2;
      const reasons = [];
      let action = "HOLD";
      let confidence = 55;
      let fillDelta = 0;
      let churnDelta = 0;
      let edgeDelta = 0;

      if (rejects1h >= 6) {
        action = "WIDEN";
        confidence = 88;
        reasons.push("REJECTS_HIGH");
        fillDelta = -0.5;
        churnDelta = -25;
        edgeDelta = 1.2;
      } else if (cancels1h > 150) {
        action = "WIDEN";
        confidence = 80;
        reasons.push("CHURN_HIGH");
        fillDelta = -0.4;
        churnDelta = -20;
        edgeDelta = 0.8;
      } else if (fills30m === 0) {
        action = "TIGHTEN";
        confidence = 76;
        reasons.push("FILL_DROUGHT");
        fillDelta = 0.8;
        churnDelta = 10;
        edgeDelta = -0.9;
      } else if (avgEdge < 0) {
        action = "WIDEN";
        confidence = 73;
        reasons.push("EDGE_NEGATIVE");
        fillDelta = -0.3;
        churnDelta = -8;
        edgeDelta = 1.5;
      } else {
        reasons.push("BALANCED");
      }
      if (Array.isArray(analytics.adaptiveAdjustments)) {
        for (const item of analytics.adaptiveAdjustments) {
          const label = String(item || "").trim();
          if (label && !reasons.includes(label)) reasons.push(label);
        }
      }

      return {
        action,
        confidence,
        reasons,
        expectedFillsHrDelta: fillDelta,
        expectedChurnDelta: churnDelta,
        expectedEdgeDeltaBps: edgeDelta,
        fills1h,
        avgEdge
      };
    }

    function renderVenueQuotesStrip(state) {
      const node = el("venueQuotesStrip");
      if (!node) return;
      const data = state.data || {};
      const quotes = data.quotes && typeof data.quotes === "object" ? data.quotes : {};
      const revx = quotes.revx && typeof quotes.revx === "object" ? quotes.revx : {};
      const externalRows = preferredExternalVenueRows(data);
      const fallbackRows = Array.isArray(quotes.venues)
        ? quotes.venues.map((row) => normalizeVenueQuoteRow(row)).filter(Boolean)
        : [];
      const venueRows = externalRows.length > 0 ? externalRows : fallbackRows;
      const revxRow = normalizeVenueQuoteRow({ venue: "REVX", ...revx });
      const rows = (revxRow ? [revxRow] : []).concat(venueRows);
      const mode = String(state.venueQuotesFilter || "all").toLowerCase();
      const chips = [];
      for (const row of rows) {
        const chip = venueQuoteChipHtml(row, mode);
        if (chip) chips.push(chip);
      }
      node.innerHTML =
        chips.length > 0
          ? chips.join("")
          : '<div class="venue-chip stale"><div class="venue-line"><span>No venues</span><span>STALE</span></div><div class="quote-line">No venue quotes match filter.</div></div>';

      const select = el("venueQuotesFilter");
      if (select && String(select.value) !== mode) {
        select.value = mode;
      }
    }

    function parseVenueAgeSeconds(raw) {
      if (!raw || typeof raw !== "object") return null;
      const direct = parseNumericField(raw.ageSeconds);
      if (direct !== null) return Math.max(0, direct);
      const snake = parseNumericField(raw.age_ms);
      if (snake !== null) return Math.max(0, snake / 1000);
      const camel = parseNumericField(raw.ageMs);
      if (camel !== null) return Math.max(0, camel / 1000);
      const tsValue = parseNumericField(raw.ts);
      if (tsValue !== null && tsValue > 0) {
        return Math.max(0, (Date.now() - tsValue) / 1000);
      }
      return null;
    }

    function normalizeVenueQuoteRow(raw) {
      const row = raw && typeof raw === "object" ? raw : {};
      const venue = String(row.venue || row.exchange || row.source || "").trim();
      if (!venue) return null;
      const bid = parseQuotePrice(row.bid);
      const ask = parseQuotePrice(row.ask);
      const midRaw = parseQuotePrice(row.mid);
      const mid =
        midRaw !== null
          ? midRaw
          : bid !== null && ask !== null && bid > 0 && ask > 0
            ? (bid + ask) / 2
            : null;
      const spreadExplicit = parseNumericField(
        row.spreadBps !== undefined ? row.spreadBps : row.spread_bps
      );
      const spreadBps =
        spreadExplicit !== null
          ? spreadExplicit
          : bid !== null && ask !== null && mid !== null && mid > 0
            ? ((ask - bid) / mid) * 10000
            : null;
      const ageSeconds = parseVenueAgeSeconds(row);
      const error =
        typeof row.error === "string" && String(row.error).trim().length > 0
          ? String(row.error).trim()
          : "";
      const ok = row.ok === false ? false : true;
      const staleByFlag = row.stale === true;
      const staleByAge = ageSeconds !== null && ageSeconds > 15;
      const stale = staleByFlag || staleByAge || !ok || error.length > 0;
      return {
        venue,
        bid,
        ask,
        mid,
        spreadBps,
        ageSeconds,
        error,
        ok,
        stale,
        ts: parseNumericField(row.ts)
      };
    }

    function preferredExternalVenueRows(data) {
      const payload = data && typeof data === "object" ? data : {};
      const externalQuotes = Array.isArray(payload.externalQuotes) ? payload.externalQuotes : [];
      const crossVenueRows =
        payload.crossVenue && Array.isArray(payload.crossVenue.venues)
          ? payload.crossVenue.venues
          : [];
      const sourceRows = externalQuotes.length > 0 ? externalQuotes : crossVenueRows;
      const byVenue = {};
      for (const raw of sourceRows) {
        const normalized = normalizeVenueQuoteRow(raw);
        if (!normalized) continue;
        const key = String(normalized.venue).toLowerCase();
        const existing = byVenue[key];
        const nextTs = parseNumericField(normalized.ts);
        const prevTs = existing ? parseNumericField(existing.ts) : null;
        if (!existing || (nextTs !== null && (prevTs === null || nextTs >= prevTs))) {
          byVenue[key] = normalized;
        }
      }
      return Object.values(byVenue).sort((a, b) => String(a.venue).localeCompare(String(b.venue)));
    }

    function venueQuoteChipHtml(raw, filterMode) {
      const normalized = normalizeVenueQuoteRow(raw);
      if (!normalized) return "";
      const venue = formatVenueLabel(String(normalized.venue || "venue"));
      const bid = normalized.bid;
      const ask = normalized.ask;
      const mid = normalized.mid;
      const spreadBps = normalized.spreadBps;
      const ageSeconds = normalized.ageSeconds;
      const error = normalized.error ? String(normalized.error).trim() : null;
      const stale = normalized.stale;
      const active = !stale && bid !== null && ask !== null && mid !== null;

      if (filterMode === "active" && !active) return "";
      if (filterMode === "stale" && !stale) return "";

      const status = error ? "ERR" : stale ? "STALE" : "ACTIVE";
      const title = error
        ? error
        : stale
          ? "stale quote: age " + (ageSeconds === null ? "-" : money(ageSeconds, 1)) + "s"
          : "quote healthy";
      const classes = "venue-chip" + (error ? " err" : stale ? " stale" : "");
      return (
        '<article class="' +
        classes +
        '" title="' +
        escapeHtml(title) +
        '">' +
        '<div class="venue-line"><span>' +
        escapeHtml(venue) +
        "</span><span>" +
        escapeHtml(status) +
        "</span></div>" +
        '<div class="quote-line">B ' +
        (bid === null ? "-" : money(bid, 2)) +
        " • A " +
        (ask === null ? "-" : money(ask, 2)) +
        " • M " +
        (mid === null ? "-" : money(mid, 2)) +
        "</div>" +
        '<div class="meta-line">spr ' +
        (spreadBps === null ? "-" : money(spreadBps, 2)) +
        " bps • age " +
        (ageSeconds === null ? "-" : money(ageSeconds, 1)) +
        "s</div>" +
        "</article>"
      );
    }

    function formatVenueLabel(value) {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized === "coinbase") return "Coinbase";
      if (normalized === "kraken") return "Kraken";
      if (normalized === "binanceus") return "BinanceUS";
      if (normalized === "binance") return "Binance";
      if (normalized.length === 0) return "Venue";
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    function renderHeaderVenueQuotes(data, quotesPayload) {
      const row = el("headerVenueQuotesRow");
      if (!row) return;
      const quotes = quotesPayload && typeof quotesPayload === "object" ? quotesPayload : {};
      const revx = quotes.revx && typeof quotes.revx === "object" ? quotes.revx : {};
      const externalRows = preferredExternalVenueRows(data);
      const fallbackRows = Array.isArray(quotes.venues)
        ? quotes.venues.map((item) => normalizeVenueQuoteRow(item)).filter(Boolean)
        : [];
      const venueRows = externalRows.length > 0 ? externalRows : fallbackRows;
      const revxRow = normalizeVenueQuoteRow({ venue: "REVX", ...revx });
      const rows = (revxRow ? [revxRow] : []).concat(venueRows);
      const chips = rows.map((item) => {
        const normalized = normalizeVenueQuoteRow(item);
        if (!normalized) return "";
        const venue = formatVenueLabel(String(normalized.venue || "venue"));
        const bid = normalized.bid;
        const ask = normalized.ask;
        const mid = normalized.mid;
        const ageSeconds = normalized.ageSeconds;
        const error = normalized.error || "";
        const stale = normalized.stale;
        const classes = "header-venue-chip" + (error ? " err" : stale ? " stale" : "");
        const tooltip =
          error.length > 0
            ? error
            : stale
              ? "stale quote age=" + (ageSeconds === null ? "-" : money(ageSeconds, 1)) + "s"
              : "quote healthy";
        return (
          '<span class="' +
          classes +
          '" title="' +
          escapeHtml(tooltip) +
          '">' +
          '<span class="venue-label">' +
          escapeHtml(venue) +
          "</span>" +
          "<span>B " +
          (bid === null ? "—" : money(bid, 2)) +
          "</span>" +
          "<span>A " +
          (ask === null ? "—" : money(ask, 2)) +
          "</span>" +
          "<span>M " +
          (mid === null ? "—" : money(mid, 2)) +
          "</span>" +
          "<span>age " +
          (ageSeconds === null ? "—" : money(ageSeconds, 1) + "s") +
          "</span>" +
          "</span>"
        );
      });
      const filtered = chips.filter((item) => item && item.length > 0);
      row.innerHTML =
        filtered.length > 0
          ? filtered.join("")
          : '<span class="header-venue-chip stale">No venue quotes</span>';
    }

    function renderMissionBar(state) {
      const data = state.data;
      if (!data) return;
      const now = Date.now();
      const connected = state.lastSuccessMs > 0 && now - state.lastSuccessMs < 12000;
      const mode = data.mode || {};
      const analytics = data.analytics || {};
      const bot = data.botStatus || {};
      const quotes = data.quotes && typeof data.quotes === "object" ? data.quotes : {};
      const revx = quotes.revx && typeof quotes.revx === "object" ? quotes.revx : {};
      const bestBid = quotes.bestBid && typeof quotes.bestBid === "object" ? quotes.bestBid : null;
      const bestAsk = quotes.bestAsk && typeof quotes.bestAsk === "object" ? quotes.bestAsk : null;
      const fairMid = parseQuotePrice(quotes.fairMid);
      const modeLabel = mode.dryRun ? "DRY" : "LIVE";
      const revxDegraded = Boolean(analytics.revxDegraded);
      const paused = Boolean(mode.paused);
      const kill = Boolean(mode.kill);
      const quoting = bot.quoting && typeof bot.quoting === "object" ? bot.quoting : {};
      const quoteEnabled = Boolean(quoting.quoteEnabled);
      const hardHalt = Boolean(quoting.hardHalt);
      const hardHaltReasons = Array.isArray(quoting.hardHaltReasons)
        ? quoting.hardHaltReasons.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
        : [];
      const quoteBuyLevels = Math.max(0, Math.floor(n(quoting.buyLevelsPlanned, 0)));
      const quoteSellLevels = Math.max(0, Math.floor(n(quoting.sellLevelsPlanned, 0)));
      const quoteTob = String(quoting.tobPlanned || "OFF").toUpperCase();
      const quoteTobPolicy =
        quoting.tobPolicy === "JOIN" ||
        quoting.tobPolicy === "JOIN+1" ||
        quoting.tobPolicy === "JOIN+2" ||
        quoting.tobPolicy === "OFF"
          ? quoting.tobPolicy
          : "JOIN";
      const quoteAppliedSpreadMult = n(quoting.appliedSpreadMult, 1);
      const quoteAppliedSizeMult = n(quoting.appliedSizeMult, 1);
      const quoteOverrideApplied = Boolean(quoting.overrideApplied);
      const quoteOverrideReasons = Array.isArray(quoting.overrideReasons)
        ? quoting.overrideReasons.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
        : [];
      const quoteBlocked = Array.isArray(quoting.quoteBlockedReasons)
        ? quoting.quoteBlockedReasons.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
        : [];
      const signalsReasons = Array.isArray(quoting.signalsReasons)
        ? quoting.signalsReasons.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
        : [];
      const seedMode = String(analytics.seedMode || "TWO_SIDED").toUpperCase();
      const seedBtcNotionalUsd = n(analytics.seedBtcNotionalUsd, 0);
      const seedLowGateUsd = n(analytics.seedLowGateUsd, 0);
      const seedTargetUsd = n(analytics.seedTargetUsd, 0);
      const seedReason = String(analytics.seedReason || "").trim();
      const seedStartTs = Math.max(0, Math.floor(n(analytics.seedStartTs, 0)));
      const seedReposts = Math.max(0, Math.floor(n(analytics.seedReposts, n(analytics.seedAttempts, 0))));
      const seedTakerFired = Boolean(analytics.seedTakerFired);
      const seedElapsedSeconds = seedStartTs > 0 ? Math.max(0, Math.floor((now - seedStartTs) / 1000)) : 0;
      const seedElapsedLabel = seedStartTs > 0 ? String(seedElapsedSeconds) + "s" : "n/a";
      const seedBlockedByVolWiden =
        (seedMode === "SEED_BUY" || seedMode === "ACCUMULATE_BTC") &&
        quoteBlocked.some((reason) => String(reason).toUpperCase().includes("VOL_WIDEN_APPLIED"));
      const signalRegime = String(analytics.signalRegime || analytics.signalVolRegime || "CALM").toUpperCase();
      const signalBias = String(analytics.signalBias || "NEUTRAL").toUpperCase();
      const signalBiasConfidence = n(analytics.signalBiasConfidence, 0);
      const signalsState = String(analytics.signalsState || quoting.signalsState || "NORMAL").toUpperCase();
      const signalsImpact = n(analytics.signalsImpact, n(quoting.signalsImpact, 0));
      const signalsDirection = String(analytics.signalsDirection || quoting.signalsDirection || "NEUTRAL").toUpperCase();
      const signalsArrow = signalsDirection === "UP" ? "↑" : signalsDirection === "DOWN" ? "↓" : "•";
      const signalsDisconnected = String(state.signalsError || "").length > 0;
      const marketPhase = String(
        analytics.marketPhase || bot.market_phase || "STABILIZING"
      ).toUpperCase();
      const phaseReasons = Array.isArray(analytics.phaseReasons)
        ? analytics.phaseReasons.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
        : [];
      const shockState = String(analytics.shockState || bot.shock_state || (marketPhase === "RECOVERY" ? "REENTRY" : marketPhase === "STABILIZING" ? "NORMAL" : marketPhase)).toUpperCase();
      const shockReasons = Array.isArray(analytics.shockReasons)
        ? analytics.shockReasons.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
        : [];
      const reentryTargetUsd = n(analytics.reentryTargetUsd, 0);
      const reentryBtcNotionalUsd = n(analytics.reentryBtcNotionalUsd, 0);
      const reentrySeedOrdersPlaced = Math.max(0, Math.floor(n(analytics.reentrySeedOrdersPlaced, 0)));
      const inventoryFloorUsd = n(analytics.inventoryFloorBtcNotionalUsd, 10);
      const inventoryCapUsd = n(analytics.inventoryCapBtcNotionalUsd, Math.max(reentryTargetUsd, 200));
      const reentryGapUsd = Math.max(0, reentryTargetUsd - reentryBtcNotionalUsd);

      text("headerLeftSymbol", String(data.symbol || "-"));
      text("missionRunId", String(data.runId || "-"));
      text("headerRevxBid", "B " + (parseQuotePrice(revx.bid) === null ? "-" : money(parseQuotePrice(revx.bid), 2)));
      text("headerRevxAsk", "A " + (parseQuotePrice(revx.ask) === null ? "-" : money(parseQuotePrice(revx.ask), 2)));
      text("headerRevxMid", "M " + (parseQuotePrice(revx.mid) === null ? "-" : money(parseQuotePrice(revx.mid), 2)));
      text(
        "headerRevxSpread",
        "SPR " + (parseNumericField(revx.spreadBps) === null ? "-" : money(parseNumericField(revx.spreadBps), 2)) + "bps"
      );
      text(
        "headerBestBid",
        bestBid && parseQuotePrice(bestBid.price) !== null
          ? "best bid " + formatVenueLabel(String(bestBid.venue || "-")) + " " + money(parseQuotePrice(bestBid.price), 2)
          : "best bid -"
      );
      text(
        "headerBestAsk",
        bestAsk && parseQuotePrice(bestAsk.price) !== null
          ? "best ask " + formatVenueLabel(String(bestAsk.venue || "-")) + " " + money(parseQuotePrice(bestAsk.price), 2)
          : "best ask -"
      );
      text("headerFairMid", "fair " + (fairMid === null ? "-" : money(fairMid, 2)));
      text("headerStatusConnected", revxDegraded ? "revx degraded" : connected ? "connected" : "disconnected");
      text("headerMode", modeLabel);
      text(
        "headerFees",
        "Maker/Taker " +
          money(n(analytics.makerFeeBps, 0), 2) +
          "/" +
          money(n(analytics.takerFeeBps, 0), 2) +
          " bps"
      );
      text("headerQuoteState", hardHalt ? "HARD_HALT" : quoteEnabled ? "LIVE" : "SOFT_OFF");
      text("headerRegime", signalRegime);
      text(
        "headerBias",
        signalBias + " " + money(signalBiasConfidence, 2)
      );
      text("headerNews", signalsState + " " + money(signalsImpact, 2) + signalsArrow);
      text(
        "headerQuotePlan",
        "B" +
          String(quoteBuyLevels) +
          "/S" +
          String(quoteSellLevels) +
          "/TOB:" +
          quoteTob +
          " " +
          quoteTobPolicy
      );
      text(
        "headerSeed",
        seedMode +
          " " +
          "$" +
          money(seedBtcNotionalUsd, 2) +
          "/" +
          "$" +
          money(seedLowGateUsd, 2) +
          " (target $" +
          money(seedTargetUsd, 2) +
          ") • t " +
          seedElapsedLabel +
          " • taker " +
          (seedTakerFired ? "yes" : "no")
      );
      text(
        "headerQuoteReasons",
        "Quoting: " +
          (hardHalt ? "hard-halt" : quoteEnabled ? "enabled" : "soft-caution/no-orders") +
          " | reason(s): " +
          (hardHalt
            ? (hardHaltReasons.length > 0 ? hardHaltReasons.join(" | ") : "hard halt active")
            : (quoteBlocked.length > 0 ? quoteBlocked.join(" | ") : "none")) +
          " | spread x" +
          money(quoteAppliedSpreadMult, 2) +
          " | size x" +
          money(quoteAppliedSizeMult, 2) +
          " | tobPolicy " +
          quoteTobPolicy +
          (quoteOverrideApplied ? " | Always-on baseline active" : "") +
          (quoteOverrideReasons.length > 0 ? " | override: " + quoteOverrideReasons.join(" | ") : "") +
          (signalsReasons.length > 0 ? " | signals: " + signalsReasons.join(" | ") : "") +
          (marketPhase !== "STABILIZING"
            ? " | phase: " + marketPhase + (phaseReasons.length > 0 ? " (" + phaseReasons[0] + ")" : "")
            : "") +
          (seedBlockedByVolWiden ? " | seed blocked by vol widen" : "")
      );
      text("headerPaused", paused ? "yes" : "no");
      text("headerKill", kill ? "yes" : "no");
      renderHeaderVenueQuotes(data, quotes);

      const dot = el("connectionDot");
      if (dot) {
        dot.classList.remove("live", "dead", "warn");
        dot.classList.add(revxDegraded ? "warn" : connected ? "live" : "dead");
      }
      const pauseBtn = el("pauseBtn");
      if (pauseBtn) {
        pauseBtn.textContent = paused ? "▶" : "⏸";
        pauseBtn.classList.toggle("active", paused);
        pauseBtn.title = paused ? "Resume quoting" : "Pause quoting";
      }
      const pausedFlag = el("pausedFlag");
      if (pausedFlag) {
        pausedFlag.classList.toggle("active-warn", paused);
      }
      const killFlag = el("killFlag");
      if (killFlag) {
        killFlag.classList.toggle("active-bad", kill);
      }
      const quotePill = el("quotePill");
      if (quotePill) {
        quotePill.classList.remove("active-good", "active-bad", "active-warn");
        if (hardHalt) {
          quotePill.classList.add("active-bad");
        } else if (quoteEnabled) {
          quotePill.classList.add("active-good");
        } else {
          quotePill.classList.add("active-warn");
        }
        const planLine = \`planned: B\${String(quoteBuyLevels)}/S\${String(quoteSellLevels)}/TOB:\${quoteTob}\`;
        const reasonLine =
          hardHalt
            ? hardHaltReasons.join(" | ") || "Hard halt active."
            : quoteBlocked.length > 0
              ? quoteBlocked.join(" | ")
              : quoteEnabled
                ? "No blocking guards."
                : "Soft caution or no quote levels planned.";
        quotePill.setAttribute("title", \`\${planLine}\\n\${reasonLine}\`);
      }
      const alwaysOnBanner = el("alwaysOnBanner");
      if (alwaysOnBanner) {
        const showShockBanner =
          marketPhase === "SHOCK" ||
          marketPhase === "COOLDOWN" ||
          marketPhase === "RECOVERY";
        if (quoteOverrideApplied || showShockBanner) {
          alwaysOnBanner.style.display = "block";
          const baselineText = quoteOverrideApplied
            ? "Always-on baseline active. " +
              (quoteOverrideReasons.length > 0
                ? quoteOverrideReasons.join(" | ")
                : "SAFE_BASELINE_OVERRIDE applied.")
            : "";
          const shockText = showShockBanner
            ? "Market phase: " +
              marketPhase +
              (marketPhase === "RECOVERY" || marketPhase === "STABILIZING"
                ? " — Rebuilding BTC inventory (" +
                  money(reentryBtcNotionalUsd, 2) +
                  "/" +
                  money(reentryTargetUsd, 2) +
                  ", gap=" +
                  money(reentryGapUsd, 2) +
                  ", seedOrders=" +
                  String(reentrySeedOrdersPlaced) +
                  ", floor=" +
                  money(inventoryFloorUsd, 2) +
                  ", cap=" +
                  money(inventoryCapUsd, 2) +
                  ")"
                : " — " + (phaseReasons.length > 0 ? phaseReasons[0] : shockReasons[0] || "risk-reduced quoting active"))
            : "";
          alwaysOnBanner.textContent = [baselineText, shockText].filter((v) => v.length > 0).join(" | ");
        } else {
          alwaysOnBanner.style.display = "none";
          alwaysOnBanner.textContent = "";
        }
      }
      text(
        "reentryPanelLine",
        "Re-Entry: " +
          marketPhase +
          " | BTC $" +
          money(reentryBtcNotionalUsd, 2) +
          " / floor $" +
          money(inventoryFloorUsd, 2) +
          " / target $" +
          money(reentryTargetUsd, 2) +
          " / cap $" +
          money(inventoryCapUsd, 2) +
          " | active " +
          ((marketPhase === "STABILIZING" || marketPhase === "RECOVERY") && reentryGapUsd > 0 ? "yes" : "no") +
          " | last seed " +
          (n(analytics.reentryLastSeedTs, 0) > 0 ? relTime(n(analytics.reentryLastSeedTs, 0), now) : "n/a")
      );
      const regimeChip = el("regimeChip");
      if (regimeChip) {
        regimeChip.classList.remove("active-good", "active-warn", "active-bad");
        if (signalRegime === "CALM") regimeChip.classList.add("active-good");
        else if (signalRegime === "TREND") regimeChip.classList.add("active-warn");
        else regimeChip.classList.add("active-bad");
      }
      const biasChip = el("biasChip");
      if (biasChip) {
        biasChip.classList.remove("active-good", "active-warn", "active-bad");
        if (signalBias === "NEUTRAL") biasChip.classList.add("active-warn");
        else if (signalBiasConfidence >= 0.7) biasChip.classList.add("active-bad");
        else biasChip.classList.add("active-good");
      }
      const newsChip = el("newsChip");
      if (newsChip) {
        newsChip.classList.remove("active-good", "active-warn", "active-bad");
        if (signalsDisconnected) newsChip.classList.add("active-bad");
        else if (signalsState === "NORMAL") newsChip.classList.add("active-good");
        else if (signalsState === "PAUSE" || signalsState === "RISK_OFF") newsChip.classList.add("active-bad");
        else newsChip.classList.add("active-warn");
      }
      const seedBadge = el("seedBadge");
      if (seedBadge) {
        seedBadge.classList.remove("active-good", "active-bad", "active-warn");
        if (seedMode === "TWO_SIDED") {
          seedBadge.classList.add("active-good");
        } else if (seedMode === "SEED_BUY" || seedMode === "ACCUMULATE_BTC") {
          seedBadge.classList.add("active-warn");
        } else {
          seedBadge.classList.add("active-bad");
        }
        seedBadge.setAttribute(
          "title",
          (seedReason || ("Seed mode " + seedMode + " | btcNotional " + money(seedBtcNotionalUsd, 2))) +
            " | reposts " +
            String(seedReposts) +
            " | elapsed " +
            seedElapsedLabel +
            " | takerFired " +
            (seedTakerFired ? "yes" : "no")
        );
        if (seedBlockedByVolWiden) {
          seedBadge.classList.remove("active-good");
          seedBadge.classList.add("active-bad");
        }
      }
      document.documentElement.style.setProperty("--topbar-height", "76px");
    }

    function renderDebugStrip(state) {
      updateDebugOverlay(buildDebugSnapshot(state), false);
    }

    function renderPortfolioStrip(state) {
      const data = state.data;
      if (!data) return;
      const bot = data.botStatus || {};
      const activeOrders = Array.isArray(data.activeBotOrders) ? data.activeBotOrders : [];
      const equity = computeClientEquity(data);
      const buyGate = statusToGate(bot.allow_buy, bot.buy_reasons || []);
      const sellGate = statusToGate(bot.allow_sell, bot.sell_reasons || []);
      const bestBuy = activeOrders
        .filter((row) => String(row.side || "").toUpperCase() === "BUY" && Number.isFinite(Number(row.price)))
        .sort((a, b) => n(b.price, 0) - n(a.price, 0))[0] || null;
      const bestSell = activeOrders
        .filter((row) => String(row.side || "").toUpperCase() === "SELL" && Number.isFinite(Number(row.price)))
        .sort((a, b) => n(a.price, 0) - n(b.price, 0))[0] || null;

      text(
        "stripEquity",
        state.equityMode === "BTC"
          ? money(equity.equityBtc, 8) + " BTC"
          : "$" + money(equity.equityUsd, 2) + " (" + money(equity.equityBtc, 6) + " BTC)"
      );
      text("stripUsd", "$" + money(equity.usd_free, 2) + " / $" + money(equity.usd_total, 2));
      text("stripBtc", money(equity.btc_free, 8) + " / " + money(equity.btc_total, 8));
      text("stripActiveOrders", String(activeOrders.length));
      text(
        "stripInventory",
        "$" +
          money(equity.btcNotionalUsd, 2) +
          " | ratio " +
          (Number.isFinite(n(bot.inventory_ratio, Number.NaN)) ? money(n(bot.inventory_ratio, 0), 3) : "n/a")
      );
      text(
        "stripBestBid",
        bestBuy
          ? money(n(bestBuy.price, 0), 2) + " | q " + (quoteFromOrder(bestBuy) === null ? "-" : money(quoteFromOrder(bestBuy), 2))
          : "-"
      );
      text(
        "stripBestAsk",
        bestSell
          ? money(n(bestSell.price, 0), 2) + " | q " + (quoteFromOrder(bestSell) === null ? "-" : money(quoteFromOrder(bestSell), 2))
          : "-"
      );
      text(
        "rightBestBid",
        bestBuy
          ? "Best BUY: " +
              money(n(bestBuy.price, 0), 2) +
              " | q " +
              (quoteFromOrder(bestBuy) === null ? "-" : money(quoteFromOrder(bestBuy), 2))
          : "Best BUY: -"
      );
      text(
        "rightBestAsk",
        bestSell
          ? "Best SELL: " +
              money(n(bestSell.price, 0), 2) +
              " | q " +
              (quoteFromOrder(bestSell) === null ? "-" : money(quoteFromOrder(bestSell), 2))
          : "Best SELL: -"
      );
      const buyChip = el("buyGateChip");
      if (buyChip) {
        buyChip.textContent = "Buy: " + buyGate.short;
        buyChip.classList.remove("ok", "block");
        buyChip.classList.add(buyGate.ok ? "ok" : "block");
      }
      const sellChip = el("sellGateChip");
      if (sellChip) {
        sellChip.textContent = "Sell: " + sellGate.short;
        sellChip.classList.remove("ok", "block");
        sellChip.classList.add(sellGate.ok ? "ok" : "block");
      }
      text("gateLine", "Buy: " + buyGate.short + " | Sell: " + sellGate.short);
      const overrides = data.overrides && typeof data.overrides === "object" ? data.overrides : null;
      const overrideEntries = [];
      if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
          if (
            key === "symbol" ||
            key === "createdAtMs" ||
            key === "updatedAtMs" ||
            key === "expiresAtMs" ||
            key === "source" ||
            key === "note"
          ) {
            continue;
          }
          if (value === null || value === undefined) continue;
          overrideEntries.push({ key, value });
        }
      }
      text("stripOverrides", overrideEntries.length > 0 ? String(overrideEntries.length) + " active" : "none");
      text(
        "overrideMeta",
        overrides
          ? "updated " + ts(overrides.updatedAtMs) + " by " + String(overrides.source || "dashboard")
          : "No active runtime overrides"
      );
      const chipsNode = el("overrideChips");
      if (chipsNode) {
        chipsNode.innerHTML =
          overrideEntries.length > 0
            ? overrideEntries
                .slice(0, 10)
                .map((entry) => '<span class="tiny-chip">' + escapeHtml("OVR: " + entry.key + "=" + String(entry.value)) + "</span>")
                .join("")
            : '<span class="tiny-chip">defaults</span>';
      }
      const clearOverrideButton = el("clearOverridesStripBtn");
      if (clearOverrideButton) {
        clearOverrideButton.disabled = overrideEntries.length === 0;
      }
      document.querySelectorAll(".portfolio-equity-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-equity-mode") === state.equityMode);
      });
    }

    function topNoFillReasons(data) {
      const bot = data && data.botStatus ? data.botStatus : {};
      const analytics = data && data.analytics ? data.analytics : {};
      const quotes = data && data.quotes ? data.quotes : {};
      const revx = quotes && quotes.revx ? quotes.revx : {};
      const reasons = [];
      const spreadBps = parseNumericField(revx.spreadBps);
      const targetHalfSpread = n(analytics.effectiveHalfSpreadBps, 0);
      const postOnlyRejects1h = n(analytics.postOnlyRejectsLast1h, 0);
      if (spreadBps !== null && spreadBps > 0 && targetHalfSpread > 0 && spreadBps <= targetHalfSpread * 2.2) {
        reasons.push("Market spread is tight (" + money(spreadBps, 2) + " bps).");
      }
      if (postOnlyRejects1h > 0) {
        reasons.push("Post-only rejects are elevated (" + String(postOnlyRejects1h) + "/1h).");
      }
      const gateReasons = []
        .concat(Array.isArray(bot.buy_reasons) ? bot.buy_reasons : [])
        .concat(Array.isArray(bot.sell_reasons) ? bot.sell_reasons : [])
        .map((item) => String(item || "").trim())
        .filter((item) => item.length > 0);
      const balanceGateReason = gateReasons.find((item) => {
        const upper = item.toUpperCase();
        return (
          upper.includes("INSUFFICIENT_USD") ||
          upper.includes("INSUFFICIENT_BTC") ||
          upper.includes("BELOW_MIN_NOTIONAL_AFTER_CLAMP")
        );
      });
      if (balanceGateReason) {
        reasons.push("Balance-limited quoting on one side: " + balanceGateReason + ".");
      }
      if (bot.allow_buy === false || bot.allow_sell === false) {
        reasons.push(
          gateReasons.length > 0
            ? "Guards blocking quoting: " + gateReasons[0]
            : "Guards are blocking one side of quoting."
        );
      }
      if (n(analytics.cancelsLast1h, 0) > 120) {
        reasons.push("Order churn is high (" + String(n(analytics.cancelsLast1h, 0)) + " cancels/1h).");
      }
      return reasons.slice(0, 2);
    }

    function renderExecutionCard(state) {
      const data = state.data;
      if (!data) return;
      const analytics = data.analytics || {};
      const fills = data.fills && typeof data.fills === "object" ? data.fills : {};
      const activeOrders = Array.isArray(data.activeBotOrders) ? data.activeBotOrders : [];
      const fills1h = Math.max(0, Math.floor(n(fills.fills1h, n(analytics.fillsLast1h, n(analytics.fills1hCount, 0)))));
      const fills24h = Math.max(0, Math.floor(n(fills.fills24h, 0)));
      const lastFillTs = n(fills.lastFillTs, 0);
      text("execFills", String(fills1h) + " / " + String(fills24h));
      text("execLastFill", lastFillTs > 0 ? relTimeFromTs(lastFillTs) : "never");
      text("execActiveOrders", String(activeOrders.length));
      text("execRejects1h", String(n(analytics.postOnlyRejectsLast1h, 0)));
      text("execAvgRest1h", money(n(analytics.avgRestingTimeSeconds, 0), 1) + "s");

      const banner = el("execNoFillsBanner");
      if (!banner) return;
      if (fills24h === 0) {
        const reasons = topNoFillReasons(data);
        banner.style.display = "block";
        banner.textContent =
          "No fills yet. Most likely: spread too tight, post-only rejects, or guards blocking quoting." +
          (reasons.length > 0 ? " Top reasons: " + reasons.join(" ") : "");
      } else {
        banner.style.display = "none";
        banner.textContent = "";
      }
    }

    function renderWhyNotTrading(state) {
      const data = state.data;
      if (!data) return;
      const bot = data.botStatus && typeof data.botStatus === "object" ? data.botStatus : {};
      const quoting = bot.quoting && typeof bot.quoting === "object" ? bot.quoting : {};
      const analytics = data.analytics && typeof data.analytics === "object" ? data.analytics : {};
      const reasons = [];
      const quoteReasons = Array.isArray(quoting.quoteBlockedReasons)
        ? quoting.quoteBlockedReasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
        : [];
      const balanceSkipReasons = quoteReasons.filter((row) => {
        const upper = String(row || "").toUpperCase();
        return (
          upper.includes("INSUFFICIENT_USD") ||
          upper.includes("INSUFFICIENT_BTC") ||
          upper.includes("BELOW_MIN_NOTIONAL_AFTER_CLAMP")
        );
      });
      const hardHalt = Boolean(quoting.hardHalt);
      const hardHaltReasons = Array.isArray(quoting.hardHaltReasons)
        ? quoting.hardHaltReasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
        : [];
      const buyReasons = Array.isArray(bot.buy_reasons)
        ? bot.buy_reasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
        : [];
      const sellReasons = Array.isArray(bot.sell_reasons)
        ? bot.sell_reasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
        : [];
      const signalsReasons = Array.isArray(quoting.signalsReasons)
        ? quoting.signalsReasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
        : [];
      const cycleActions =
        quoting.cycleActions && typeof quoting.cycleActions === "object"
          ? quoting.cycleActions
          : {};
      const cancelReasonCounts =
        quoting.cancelReasonCounts && typeof quoting.cancelReasonCounts === "object"
          ? quoting.cancelReasonCounts
          : {};
      const lastCancelReason = String(quoting.lastCancelReason || "").trim();
      const intelSnapshot =
        data.intelSnapshot && typeof data.intelSnapshot === "object" ? data.intelSnapshot : {};
      const intelCommentary =
        intelSnapshot.commentary && typeof intelSnapshot.commentary === "object"
          ? intelSnapshot.commentary
          : {};
      const intelHeadline = String(intelCommentary.headline || "").trim();
      const intelReasons = Array.isArray(intelCommentary.reasons)
        ? intelCommentary.reasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
        : [];
      const intelDecaySeconds = Math.max(0, Math.floor(n(intelCommentary.decaySeconds, 0)));
      const hardRiskState = String(
        data.hardRiskState || intelCommentary.hardRiskState || "OK"
      ).toUpperCase();
      const intelConfidence = n(intelCommentary.intelConfidence, n(analytics.intelConfidence, 0));
      const providerHealth = Array.isArray(intelCommentary.providerHealth)
        ? intelCommentary.providerHealth.map((row) => ({
            provider: String(row && row.provider ? row.provider : "provider"),
            ok: row && row.ok !== false,
            lastError: row && row.lastError ? String(row.lastError) : "",
            blocking: String(row && row.blocking ? row.blocking : "NON_BLOCKING")
          }))
        : [];
      const adverseState = String(analytics.adverseSelectionState || "NORMAL");
      const seedMode = String(analytics.seedMode || "TWO_SIDED");
      const intelState = String(
        (intelSnapshot.posture && intelSnapshot.posture.state) || analytics.intelState || "NORMAL"
      );
      const quoteEnabled = Boolean(quoting.quoteEnabled);

      if (balanceSkipReasons.length > 0) {
        reasons.push(
          "Balance-limited side skip/clamp (non-fatal): " + balanceSkipReasons.slice(0, 2).join(" | ")
        );
      }
      if (hardHalt) {
        for (const item of hardHaltReasons.slice(0, 3)) reasons.push("HARD_HALT: " + item);
      }
      for (const item of quoteReasons.slice(0, 4)) reasons.push(item);
      if (!quoteEnabled && hardHalt && reasons.length === 0) {
        reasons.push("Quoting hard-halted but no explicit hardHaltReasons were emitted.");
      }
      if (!quoteEnabled && !hardHalt && quoteReasons.length === 0) {
        reasons.push("No quote levels currently planned (soft caution, inventory, or funding constraints).");
      }
      if (buyReasons.length > 0) reasons.push("BUY gate: " + buyReasons[0]);
      if (sellReasons.length > 0) reasons.push("SELL gate: " + sellReasons[0]);
      if (signalsReasons.length > 0) reasons.push("SIG: " + signalsReasons.join(" | "));
      const cyclePlaced = Math.max(0, Math.floor(n(cycleActions.placed, 0)));
      const cycleCancelled = Math.max(0, Math.floor(n(cycleActions.cancelled, 0)));
      const cycleKept = Math.max(0, Math.floor(n(cycleActions.kept, 0)));
      reasons.push(
        "Cycle actions: placed " +
          String(cyclePlaced) +
          ", cancelled " +
          String(cycleCancelled) +
          ", kept " +
          String(cycleKept)
      );
      const cancelTop = Object.entries(cancelReasonCounts)
        .map((entry) => ({
          reason: String(entry[0] || "").trim(),
          count: Math.max(0, Math.floor(n(entry[1], 0)))
        }))
        .filter((entry) => entry.reason.length > 0 && entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 2);
      if (cancelTop.length > 0 || lastCancelReason.length > 0) {
        reasons.push(
          "Cancel reasons: " +
            (cancelTop.length > 0
              ? cancelTop.map((entry) => entry.reason + "=" + String(entry.count)).join(", ")
              : "none") +
            (lastCancelReason.length > 0 ? " | last: " + lastCancelReason : "")
        );
      }
      if (intelReasons.length > 0) {
        for (const reason of intelReasons.slice(0, 3)) {
          reasons.push("INTEL: " + reason);
        }
      }
      for (const row of providerHealth.filter((item) => !item.ok).slice(0, 2)) {
        const suffix = row.lastError.length > 0 ? " (" + row.lastError + ")" : "";
        reasons.push("NON_BLOCKING_PROVIDER: " + row.provider + suffix);
      }
      if (reasons.length === 0) reasons.push("No active block reasons.");

      const actionLine =
        "Mode: " +
        (hardHalt ? "Quoting hard-halted" : quoteEnabled ? "Quoting live" : "Quoting caution/soft-off") +
        " | Phase: " +
        String(analytics.marketPhase || analytics.shockState || "STABILIZING") +
        " | Seed: " +
        seedMode +
        " | Adverse: " +
        adverseState +
        " | Intel: " +
        intelState +
        " | Regime: " +
        String(analytics.signalRegime || analytics.signalVolRegime || "CALM") +
        " | Bias: " +
        String(analytics.signalBias || "NEUTRAL");

      text("whyNowAction", actionLine);
      const intelLine = el("whyIntelCommentary");
      if (intelLine) {
        const line =
          intelHeadline.length > 0
            ? intelHeadline
            : "Intel: " + intelState + " (" + money(n(analytics.intelImpact, 0), 2) + ")";
        intelLine.textContent =
          "Intel: " +
          line +
          " | hardRisk " +
          hardRiskState +
          " | conf " +
          money(intelConfidence, 2) +
          (intelState === "HALT" && intelDecaySeconds > 0 ? " | cooldown ~" + String(intelDecaySeconds) + "s" : "");
        intelLine.title = intelReasons.length > 0 ? intelReasons.join(" | ") : "";
      }
      const body = el("whyNotList");
      if (!body) return;
      body.innerHTML = reasons
        .slice(0, 6)
        .map((reason) => '<span class="tiny-chip">' + escapeHtml(reason) + "</span>")
        .join("");
    }

    function renderIntelSidebar(state) {
      const data = state.data || {};
      const analytics = data.analytics || {};
      const tab = String(state.intelTab || "signals").toLowerCase();
      const listNode = el("intelList");
      const bannerNode = el("newsAggregateBanner");
      const bannerHeadlineNode = el("newsAggregateHeadline");
      const bannerDriversNode = el("newsAggregateDrivers");
      const bannerProvidersNode = el("newsAggregateProviders");
      const controlsNode = el("newsControls");
      if (!listNode || !bannerNode || !controlsNode) return;
      function safeQuoteSize(row) {
        const a = Number(row?.quote_size_usd);
        const b = Number(row?.quote_size);
        const c = Number(row?.quoteSizeUsd);
        const d = Number(row?.quoteSize);
        const val = [a, b, c, d].find((x) => Number.isFinite(x) && x > 0);
        return Number.isFinite(val) ? val : 0;
      }
      const snapshot =
        state.signalsSnapshot && typeof state.signalsSnapshot === "object" ? state.signalsSnapshot : {};
      const aggregate =
        snapshot.aggregate && typeof snapshot.aggregate === "object"
          ? snapshot.aggregate
          : snapshot.posture && typeof snapshot.posture === "object"
            ? {
                impact: snapshot.posture.impact,
                direction: snapshot.posture.direction,
                confidence: snapshot.posture.confidence,
                state: snapshot.posture.state,
                latestTs: snapshot.ts
              }
            : {};
      const commentary =
        snapshot.commentary && typeof snapshot.commentary === "object" ? snapshot.commentary : {};
      const commentaryReasons = Array.isArray(commentary.reasons)
        ? commentary.reasons.map((row) => String(row || "").trim()).filter((row) => row.length > 0)
        : [];
      const hardRiskState = String(commentary.hardRiskState || data.hardRiskState || "OK").toUpperCase();
      const intelConfidence = n(commentary.intelConfidence, n(analytics.intelConfidence, 0));
      const providerHealth = Array.isArray(commentary.providerHealth)
        ? commentary.providerHealth.filter((row) => row && typeof row === "object")
        : [];
      const topDrivers = Array.isArray(commentary.topDrivers)
        ? commentary.topDrivers.filter((row) => row && typeof row === "object")
        : [];
      const providerFreshness = Array.isArray(commentary.providerFreshness)
        ? commentary.providerFreshness.filter((row) => row && typeof row === "object")
        : [];
      const signalsImpact = n(aggregate.impact, n(analytics.signalsImpact, 0));
      const signalsDirection = String(aggregate.direction || analytics.signalsDirection || "NEUTRAL").toUpperCase();
      const signalsConfidence = n(aggregate.confidence, n(analytics.signalsConfidence, 0));
      const signalsState = String(aggregate.state || analytics.signalsState || "NORMAL").toUpperCase();
      const latestTs = n(aggregate.latestTs, n(analytics.signalsLastTs, 0));
      const decaySeconds = Math.max(0, Math.floor(n(commentary.decaySeconds, 0)));
      const arrow = signalsDirection === "UP" ? "↑" : signalsDirection === "DOWN" ? "↓" : "•";
      bannerNode.classList.remove("warn", "bad");
      if (signalsState === "PAUSE" || signalsState === "RISK_OFF") {
        bannerNode.classList.add("bad");
      } else if (signalsState === "CAUTION" || signalsState === "RISK_ON") {
        bannerNode.classList.add("warn");
      }
      const fallbackHeadline =
        "Intel: " +
        signalsState +
        " (" +
        money(signalsImpact, 2) +
        " " +
        arrow +
        ") conf " +
        money(signalsConfidence, 2);
      const headline = String(commentary.headline || fallbackHeadline);
      const headlineLine =
        "Intel: " +
        signalsState +
        " — " +
        headline +
        " | hardRisk " +
        hardRiskState +
        " | conf " +
        money(intelConfidence, 2) +
        (signalsState === "HALT" && decaySeconds > 0 ? " | decay ~" + String(decaySeconds) + "s" : "");
      const driversLine =
        topDrivers.length > 0
          ? "Top drivers: " +
            topDrivers
              .slice(0, 3)
              .map((row) => {
                const source = String(row.source || "source");
                const impact = money(n(row.impact, 0), 2);
                return source + " " + impact;
              })
              .join(" | ")
          : "Top drivers: none";
      const providersLine =
        providerFreshness.length > 0
          ? "Providers: " +
            providerFreshness
              .slice(0, 5)
              .map((row) => {
                const provider = String(row.provider || "provider");
                const lastItemTs = n(row.lastItemTs, 0);
                const providerStatus = providerHealth.find((candidate) => String(candidate.provider || "").toLowerCase() === provider.toLowerCase());
                const status = row.ok === false
                  ? "NON_BLOCKING"
                  : lastItemTs > 0
                    ? relTimeFromTs(lastItemTs)
                    : "no-items";
                const errorSuffix =
                  providerStatus && providerStatus.ok === false && providerStatus.lastError
                    ? " (" + String(providerStatus.lastError).slice(0, 24) + ")"
                    : "";
                return provider + " " + status + errorSuffix;
              })
              .join(" | ")
          : "Providers: not_ready";
      if (bannerHeadlineNode) bannerHeadlineNode.textContent = headlineLine;
      if (bannerDriversNode) bannerDriversNode.textContent = driversLine;
      if (bannerProvidersNode) bannerProvidersNode.textContent = providersLine;
      bannerNode.title = commentaryReasons.length > 0 ? commentaryReasons.join(" | ") : "";
      if (String(state.signalsError || "").length > 0) {
        if (bannerProvidersNode) {
          bannerProvidersNode.textContent += " | intel disconnected";
        } else if (bannerHeadlineNode) {
          bannerHeadlineNode.textContent += " | intel disconnected";
        } else {
          bannerNode.textContent = headlineLine + " | intel disconnected";
        }
      }

      document.querySelectorAll(".intel-tab").forEach((node) => {
        node.classList.toggle("active", String(node.getAttribute("data-intel-tab") || "").toLowerCase() === tab);
      });
      const showNewsControls = tab === "signals";
      controlsNode.style.display = showNewsControls ? "" : "none";
      document.querySelectorAll("[data-signal-kind]").forEach((node) => {
        node.classList.toggle(
          "active",
          String(node.getAttribute("data-signal-kind") || "").toLowerCase() === String(state.signalKindFilter || "all")
        );
      });
      document.querySelectorAll("[data-news-cat]").forEach((node) => {
        node.classList.toggle(
          "active",
          String(node.getAttribute("data-news-cat") || "").toLowerCase() === String(state.newsCategoryFilter || "all")
        );
      });
      document.querySelectorAll("[data-news-impact]").forEach((node) => {
        node.classList.toggle(
          "active",
          String(node.getAttribute("data-news-impact") || "").toLowerCase() === String(state.newsImpactFilter || "all")
        );
      });

      if (tab === "events") {
        const events = Array.isArray(state.uiEvents) ? state.uiEvents.slice(0, 60) : [];
        listNode.innerHTML =
          events.length > 0
            ? events
                .map((row) => {
                  const type = String(row.type || "-");
                  const side = String(row.side || "-");
                  const reason = String(row.reason || "-");
                  return (
                    '<article class="news-row">' +
                    '<div class="news-row-head"><span class="impact-pill low">' +
                    escapeHtml(type) +
                    '</span><span>' +
                    escapeHtml(relTimeFromTs(n(row.ts, 0))) +
                    "</span></div>" +
                    '<div class="news-row-title">' +
                    escapeHtml(side + " " + reason) +
                    "</div></article>"
                  );
                })
                .join("")
            : '<div class="intel-empty">No events yet.</div>';
        return;
      }

      if (tab === "orders") {
        const orders = Array.isArray(data.activeBotOrders) ? data.activeBotOrders.slice(0, 80) : [];
        const html = orders.length
          ? orders
              .map((row) => {
                const side = String(row?.side ?? "-");
                const price = money(n(row?.price, 0), 2);
                const tag = String(
                  row?.bot_tag ?? row?.botTag ?? row?.client_order_id ?? row?.clientOrderId ?? "-"
                );
                const status = String(row?.status ?? "-");
                const q = money(safeQuoteSize(row), 2);
                return \`
<article class="news-row">
  <div class="news-row-head">
    <span class="impact-pill low">\${escapeHtml(side)}</span>
    <span>\${escapeHtml(price)}</span>
  </div>
  <div class="news-row-title">\${escapeHtml(tag)}</div>
  <div class="news-row-head">
    <span>\${escapeHtml(status)}</span>
    <span>q \${escapeHtml(q)}</span>
  </div>
</article>\`.trim();
              })
              .join("")
          : '<div class="intel-empty">No active orders.</div>';
        listNode.innerHTML = html;
        return;
      }

      const rows = Array.isArray(snapshot.items) ? snapshot.items : [];
      const kindFilter = String(state.signalKindFilter || "all").toLowerCase();
      const categoryFilter = String(state.newsCategoryFilter || "all").toLowerCase();
      const impactFilter = String(state.newsImpactFilter || "all").toLowerCase();
      const minImpact = impactFilter === "high" ? 0.7 : impactFilter === "med" ? 0.4 : 0;
      const preFiltered = rows
        .filter((row) => row && typeof row === "object")
        .filter((row) => kindFilter === "all" || String(row.kind || "").toLowerCase() === kindFilter)
        .filter((row) => categoryFilter === "all" || String(row.category || "").toLowerCase() === categoryFilter)
        .filter((row) => n(row.impact, 0) >= minImpact)
        .slice(0, 80);
      const seenIntelRows = new Set();
      const filtered = [];
      for (const row of preFiltered) {
        const key =
          String(row.source || "source").trim().toLowerCase() +
          "|" +
          String(row.title || "").trim().toLowerCase().replace(/\\s+/g, " ");
        if (seenIntelRows.has(key)) continue;
        seenIntelRows.add(key);
        filtered.push(row);
      }
      const hasActiveFilters = kindFilter !== "all" || categoryFilter !== "all" || impactFilter !== "all";
      listNode.innerHTML =
        filtered.length > 0
          ? filtered
              .map((row) => {
                const impact = n(row.impact, 0);
                const impactClass = impact >= 0.7 ? "high" : impact >= 0.4 ? "med" : "low";
                const impactLabel = impact >= 0.7 ? "High" : impact >= 0.4 ? "Med" : "Low";
                const dir = String(row.direction || "NEUTRAL").toUpperCase();
                const dirArrow = dir === "UP" ? "↑" : dir === "DOWN" ? "↓" : "•";
                const source = String(row.source || "source");
                const sourceDomain = String(row.sourceDomain || "").trim().toLowerCase();
                const sourceLabel = sourceDomain.length > 0 ? sourceDomain : source;
                const kind = String(row.kind || "NEWS");
                const category = String(row.category || "other");
                const url = String(row.url || "");
                const tags = Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)).slice(0, 3).join(", ") : "";
                const safeUrl = /^https?:\/\//i.test(url) ? url : "#";
                const summary = String(row.summary || "").trim();
                const showSummary = summary.length > 0 && summary !== String(row.title || "").trim();
                const titleText = escapeHtml(String(row.title || "-"));
                const titleHtml =
                  safeUrl !== "#"
                    ? '<a class="news-row-title-link" target="_blank" rel="noopener noreferrer" href="' +
                      escapeHtml(safeUrl) +
                      '">' +
                      titleText +
                      "</a>"
                    : titleText;
                const openLink =
                  safeUrl !== "#"
                    ? '<a target="_blank" rel="noreferrer noopener" href="' +
                      escapeHtml(safeUrl) +
                      '" title="Open source">↗</a>'
                    : '<span style="opacity:.45;">-</span>';
                const sourceChip = '<span class="news-source-chip">' + escapeHtml(sourceLabel) + "</span>";
                const summaryHtml = showSummary
                  ? '<div class="news-row-summary">' + escapeHtml(summary) + "</div>"
                  : "";
                return (
                  '<details class="news-row news-row-collapsible">' +
                  "<summary>" +
                  '<div class="news-row-head"><span class="news-row-head-cluster"><span class="impact-pill ' +
                  impactClass +
                  '">' +
                  impactLabel +
                  " " +
                  dirArrow +
                  '</span><span class="news-cat-chip">' +
                  escapeHtml(category) +
                  "</span>" +
                  sourceChip +
                  '</span><span>' +
                  openLink +
                  "</span></div>" +
                  '<div class="news-row-title">' +
                  titleHtml +
                  "</div>" +
                  '<div class="news-row-head"><span>' +
                  escapeHtml(source + " • " + relTimeFromTs(n(row.ts, 0))) +
                  "</span><span>" +
                  escapeHtml(kind) +
                  (tags ? " • " + escapeHtml(tags) : "") +
                  "</span></div>" +
                  "</summary>" +
                  summaryHtml +
                  "</details>"
                );
              })
              .join("")
          : hasActiveFilters
            ? '<div class="intel-empty">No items match filters. Try ALL categories.</div>'
            : '<div class="intel-empty">No intel items yet.</div>';
    }

    function renderNav(state) {
      const collapsed = Boolean(state.navCollapsed);
      const appLayout = el("appLayout");
      if (appLayout) {
        appLayout.classList.toggle("nav-collapsed", collapsed);
        appLayout.classList.toggle("nav-expanded", !collapsed);
      }
      const rail = el("navRail");
      if (rail) {
        rail.setAttribute("data-collapsed", collapsed ? "1" : "0");
      }
      const toggle = el("navRailToggle");
      if (toggle) {
        toggle.setAttribute("aria-pressed", String(!collapsed));
        toggle.setAttribute("title", collapsed ? "Expand navigation rail" : "Collapse navigation rail");
      }
      const intelLink = el("navIntelLink");
      const onIntelRoute =
        window.location.pathname === "/intel" ||
        String(window.location.search || "").toLowerCase().includes("view=intel");
      if (intelLink) {
        intelLink.classList.toggle("active", onIntelRoute);
      }
      document.querySelectorAll(".view-tab[data-view]").forEach((node) => {
        const value = node.getAttribute("data-view");
        node.classList.toggle("active", !onIntelRoute && value === state.view);
      });
    }

    function renderViewPanes(state) {
      const map = {
        operate: "operateView",
        overrides: "overridesView",
        diagnose: "diagnoseView",
        optimize: "optimizeView",
        audit: "auditView"
      };
      Object.keys(map).forEach((key) => {
        const node = el(map[key]);
        if (node) {
          node.style.display = state.view === key ? "" : "none";
        }
      });
    }

    function executionHealth(analytics) {
      const rejects1h = n(analytics.postOnlyRejectsLast1h, 0);
      const cancels1h = n(analytics.cancelsLast1h, 0);
      const fills30m = n(analytics.fillsLast30m, 0);
      if (rejects1h >= 6) return "REJECTS";
      if (cancels1h > 150) return "CHURN";
      if (fills30m === 0) return "STARVED";
      return "OK";
    }

    function renderKpiCards(state) {
      const data = state.data;
      if (!data) return;

      const ticker = data.ticker || {};
      const analytics = data.analytics || {};
      const botStatus = data.botStatus || {};
      const perf1h = data.analysisSummary_1h && typeof data.analysisSummary_1h === "object" ? data.analysisSummary_1h : {};
      const perf24h = data.analysisSummary_24h && typeof data.analysisSummary_24h === "object" ? data.analysisSummary_24h : {};
      const adaptiveStatus = data.adaptiveStatus && typeof data.adaptiveStatus === "object" ? data.adaptiveStatus : {};

      const bid = n(ticker.bid, 0);
      const ask = n(ticker.ask, 0);
      const mid = n(ticker.mid, 0);
      const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : 0;
      const volMoveBps = n(botStatus.vol_move_bps, 0);
      const trendMoveBps = n(analytics.trendMoveBps, n(botStatus.trend_move_bps, 0));

      text("kpiMid", mid > 0 ? fmt.format(mid) : "-");
      text(
        "kpiSpread",
        bid > 0 && ask > 0
          ? money(spreadBps, 2) + " bps | vol " + money(volMoveBps, 2) + " bps"
          : "-"
      );
      text("kpiActive", String(Array.isArray(data.activeBotOrders) ? data.activeBotOrders.length : 0));
      text("kpiTrend", money(trendMoveBps, 2) + " bps");
      text("regimeLine1", "Regime: " + String(analytics.signalRegime || analytics.signalVolRegime || "normal") + " | stdev " + money(n(analytics.signalStdevBps, 0), 2) + " bps");
      text("regimeLine2", "Drift " + money(n(analytics.signalDriftBps, 0), 2) + " bps | z-score " + money(n(analytics.signalZScore, 0), 2) + " | conf " + money(n(analytics.signalConfidence, 0), 2));
      text("regimeLine3", "Inside spread " + money(spreadBps, 2) + " bps | trend move " + money(trendMoveBps, 2) + " bps");

      const edge = analytics.edgeBpsLastFill;
      const edgeText = edge === null || edge === undefined ? "-" : money(edge, 2) + " bps";
      text("kpiEdge", edgeText);
      text("kpiEdgeAlt", edgeText);
      text(
        "kpiEdgeSub",
        "1h avg B " + money(n(analytics.avgEdgeBps1hBuy, 0), 2) + " | S " + money(n(analytics.avgEdgeBps1hSell, 0), 2)
      );

      text("kpiRealized", money(n(analytics.realizedPnlUsd, 0), 2) + " USD");
      text("kpiFills1h", "fills 1h: " + String(n(analytics.fills1hCount, 0)));

      const cancels1h = n(analytics.cancelsLast1h, 0);
      const rejects1h = n(analytics.postOnlyRejectsLast1h, 0);
      const fills30m = n(analytics.fillsLast30m, 0);
      const fills1h = n(analytics.fillsLast1h, n(analytics.fills1hCount, 0));
      const avgRest = n(analytics.avgRestingTimeSeconds, 0);
      const actionBudgetUsed = n(analytics.actionBudgetUsed, 0);
      const actionBudgetMax = Math.max(1, n(analytics.actionBudgetMax, 1));
      const health = executionHealth(analytics);

      text("kpiExecHealth", health + " | fills 1h " + String(fills1h) + " | 30m " + String(fills30m));
      text(
        "kpiExecHealthSub",
        "post-only rejects 1h: " +
          String(rejects1h) +
          " | cancels 1h: " +
          String(cancels1h) +
          " | avg rest: " +
          money(avgRest, 1) +
          "s | budget: " +
          String(actionBudgetUsed) +
          "/" +
          String(actionBudgetMax)
      );

      text("kpiSignal", String(analytics.signalRegime || analytics.signalVolRegime || "normal"));
      text(
        "kpiSignalSub",
        "drift " +
          money(n(analytics.signalDriftBps, 0), 2) +
          " bps | z " +
          money(n(analytics.signalZScore, 0), 2) +
          " | stdev " +
          money(n(analytics.signalStdevBps, 0), 2) +
          " bps | skew " +
          money(n(analytics.signalSkewBpsApplied, 0), 2) +
          " bps | basis " +
          money(n(analytics.signalBasisBps, 0), 2) +
          " bps | disp " +
          money(n(analytics.signalDispersionBps, 0), 2) +
          " bps | conf " +
          money(n(analytics.signalConfidence, 0), 2) +
          " | bias " +
          String(analytics.signalBias || "NEUTRAL")
      );
      const asAvgBps = n(analytics.adverseSelectionAvgBps, 0);
      const asBadRate = n(analytics.adverseSelectionBadRate, 0);
      const asSamples = Math.max(0, Math.floor(n(analytics.adverseSelectionSamples, 0)));
      const asWidenBps = n(analytics.adverseSelectionWidenBps, 0);
      const asToxic = Boolean(analytics.adverseSelectionToxic);
      const asCooldownSeconds = Math.max(0, Math.floor(n(analytics.adverseSelectionCooldownSeconds, 0)));
      const asLastBps = n(analytics.adverseSelectionLastBps, 0);
      text(
        "kpiAs",
        (asToxic ? "TOXIC" : "OK") + " | avg " + money(asAvgBps, 2) + " bps"
      );
      text(
        "kpiAsSub",
        "bad rate " + money(asBadRate * 100, 1) + "% | widen " + money(asWidenBps, 2) + " bps"
      );
      text(
        "kpiAsSub2",
        "state " +
          String(analytics.adverseSelectionState || "NORMAL") +
          " | score " +
          money(n(analytics.adverseSelectionToxicityScore, 0), 2) +
          " | spread x" +
          money(n(analytics.adverseSelectionSpreadMult, 1), 2) +
          " | last " +
          money(asLastBps, 2) +
          " bps | samples " +
          String(asSamples) +
          " | cooldown " +
          String(asCooldownSeconds) +
          "s"
      );
      const kpiAsNode = el("kpiAs");
      if (kpiAsNode) {
        kpiAsNode.setAttribute(
          "title",
          "Adverse selection compares fill mid versus future mid over horizon; negative means fills tend to move against you."
        );
      }

      text("kpiAdaptive", money(n(analytics.effectiveHalfSpreadBps, 0), 2) + " bps");
      text(
        "kpiAdaptiveSub",
        "delta " +
          money(n(analytics.adaptiveSpreadDeltaBps, 0), 2) +
          " bps | target fills/hr " +
          String(n(analytics.targetFillsPerHour, 0)) +
          " | current " +
          String(fills1h)
      );
      const tobMode = String(botStatus.tob_mode || "OFF");
      const tobReason = String(botStatus.tob_reason || "n/a");
      const sellThrottleState = String(botStatus.sell_throttle_state || "NORMAL");
      text("kpiAdaptiveSub2", "TOB: " + tobMode + " (" + tobReason + ") | Sell throttle: " + sellThrottleState);

      const adaptiveReasons = Array.isArray(analytics.adaptiveAdjustments) ? analytics.adaptiveAdjustments : [];
      const reasonNode = el("kpiAdaptiveReasons");
      if (reasonNode) {
        reasonNode.innerHTML = adaptiveReasons.length
          ? adaptiveReasons
              .map((reason) => '<span class="tiny-chip">' + escapeHtml(String(reason)) + "</span>")
              .join("")
          : '<span class="tiny-chip">NONE</span>';
      }
      const perfFillsPerHour = n(perf1h.fillsPerHour, n(analytics.performanceFillsPerHour1h, 0));
      const perfAvgEdge = n(perf1h.avgEdgeBps, n(analytics.performanceAvgEdgeBps1h, 0));
      const perfToxicPct = n(perf1h.toxicPct30s, n(analytics.performanceToxicPct1h, 0));
      const perfNetPnl24h = n(perf24h.netPnlUsd, n(analytics.performanceNetPnl24h, 0));
      const adaptiveMode =
        String(
          (adaptiveStatus.lastDecision && adaptiveStatus.lastDecision.action) ||
            analytics.adaptiveMode ||
            (adaptiveStatus.enabled ? "ENABLED" : "DISABLED")
        ).toUpperCase();
      text(
        "kpiPerf",
        "fills/hr " + money(perfFillsPerHour, 2) + " | edge " + money(perfAvgEdge, 2) + " bps"
      );
      text(
        "kpiPerfSub",
        "toxic " + money(perfToxicPct * 100, 1) + "% | net pnl 24h $" + money(perfNetPnl24h, 2)
      );
      text(
        "kpiPerfSub2",
        "adaptive mode " + adaptiveMode + " | view /performance for full analytics"
      );

      const equity = computeClientEquity(data);
      const hasMid = equity.mid > 0;
      text("kpiEquityUsd", hasMid ? "$" + money(equity.equityUsd, 2) : "-");
      text("kpiEquityUsdSub", hasMid ? "BTC notional: $" + money(equity.btcNotionalUsd, 2) : "BTC notional: -");
      text("kpiEquityBtc", hasMid ? money(equity.equityBtc, 6) + " BTC" : "-");
      text("kpiEquityBtcSub", hasMid ? "USD notional: " + money(equity.usdNotionalBtc, 8) + " BTC" : "USD notional: -");
      text("kpiUsdTotal", "$" + money(equity.usd_total, 2));
      text("kpiUsdFree", "free: $" + money(equity.usd_free, 2));
      text("kpiBtcTotal", money(equity.btc_total, 6) + " BTC");
      text("kpiBtcFree", "free: " + money(equity.btc_free, 8) + " BTC");
      text("kpiBtcNotionalUsd", hasMid ? "$" + money(equity.btcNotionalUsd, 2) : "-");

      text(
        "insightAdaptive",
        "half spread " +
          money(n(analytics.effectiveHalfSpreadBps, 0), 2) +
          " bps | delta " +
          money(n(analytics.adaptiveSpreadDeltaBps, 0), 2) +
          " bps"
      );
      text("insightTob", "TOB " + tobMode + " | " + tobReason);
      text(
        "safetyState",
        "errors=" + String(n(botStatus.consecutive_errors, 0))
      );
    }

    function renderRegimeRibbon(state) {
      const svg = el("regimeRibbon");
      if (!svg) return;
      const history = Array.isArray(state.regimeHistory) ? state.regimeHistory : [];
      if (history.length < 2) {
        svg.innerHTML = '<text x="14" y="36" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="12">Awaiting regime history</text>';
        return;
      }

      const W = 1200;
      const H = 72;
      const cutoff = Date.now() - 60 * 60 * 1000;
      const recent = history.filter((row) => n(row.ts, 0) >= cutoff);
      const points = recent.length > 0 ? recent : history.slice(-120);
      const segment = Math.max(1, Math.floor(W / Math.max(1, points.length)));
      const colorFor = (value) => {
        const regime = String(value || "normal").toLowerCase();
        if (regime === "calm") return "#21e3a2";
        if (regime === "hot") return "#ff6d7c";
        return "#37b4ff";
      };

      let rects = "";
      for (let i = 0; i < points.length; i += 1) {
        rects +=
          '<rect x="' +
          String(i * segment) +
          '" y="10" width="' +
          String(segment + 1) +
          '" height="36" fill="' +
          colorFor(points[i].regime) +
          '" opacity="0.7"><title>' +
          escapeHtml(ts(points[i].ts) + " " + String(points[i].regime || "normal")) +
          "</title></rect>";
      }
      svg.innerHTML =
        rects +
        '<text x="12" y="62" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="11">calm</text>' +
        '<text x="76" y="62" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="11">normal</text>' +
        '<text x="164" y="62" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="11">hot</text>';
    }

    function renderDrawdownMain(state) {
      const svg = el("drawdownMainChart");
      if (!svg) return;
      if (typeof renderDrawdownChart !== "function") return;
      const field = state.equityMode === "BTC" ? "equityBtc" : "equityUsd";
      const filtered = eqFilterByWindow(state.equitySeries || [], state.equityWindow || "24h");
      const result = renderDrawdownChart(svg, filtered, field, state.drawdownMode, {
        abs: (v) => (state.equityMode === "BTC" ? money(v, 8) + " BTC" : "$" + money(v, 2)),
        pct: (v) => money(v, 2) + "%"
      });
      const absText = state.equityMode === "BTC" ? money(result.maxDdAbs, 8) + " BTC" : "$" + money(result.maxDdAbs, 2);
      text("drawdownMainSummary", "Max DD " + absText + " (" + money(result.maxDdPct, 2) + "%)");
    }

    function renderFillsCadence(state) {
      const svg = el("fillsCadenceChart");
      if (!svg) return;
      const data = state.data || {};
      const fills = Array.isArray(data.recentFills) ? data.recentFills : [];
      if (fills.length === 0) {
        svg.innerHTML = '<text x="20" y="44" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="15">No fills in selected window</text>';
        text("fillsCadenceSummary", "No fills recorded in current sample.");
        return;
      }

      const now = Date.now();
      const windowMs = eqWindowMs(state.equityWindow || "24h");
      const start = now - windowMs;
      const bins = [];
      const binSizeMs = 5 * 60 * 1000;
      const binCount = Math.max(1, Math.ceil(windowMs / binSizeMs));
      for (let i = 0; i < binCount; i += 1) bins.push(0);
      for (const row of fills) {
        const t = n(row.ts, 0);
        if (t < start || t > now) continue;
        const idx = Math.min(binCount - 1, Math.max(0, Math.floor((t - start) / binSizeMs)));
        bins[idx] += 1;
      }
      const W = 1200;
      const H = 300;
      const PADX = 50;
      const PADY = 28;
      const maxBin = Math.max(1, ...bins);
      const bw = (W - PADX * 2) / bins.length;
      let bars = "";
      bins.forEach((value, idx) => {
        const height = ((H - PADY * 2) * value) / maxBin;
        const x = PADX + idx * bw;
        const y = H - PADY - height;
        bars +=
          '<rect x="' +
          x.toFixed(2) +
          '" y="' +
          y.toFixed(2) +
          '" width="' +
          Math.max(1, bw - 1).toFixed(2) +
          '" height="' +
          height.toFixed(2) +
          '" fill="rgba(55,180,255,0.72)"><title>' +
          String(value) +
          " fills</title></rect>";
      });
      const target = n((data.analytics || {}).targetFillsPerHour, 0);
      const targetPerBin = (target * 5) / 60;
      const targetY = H - PADY - ((H - PADY * 2) * targetPerBin) / maxBin;
      svg.innerHTML =
        bars +
        '<line x1="' + PADX + '" y1="' + targetY.toFixed(2) + '" x2="' + (W - PADX) + '" y2="' + targetY.toFixed(2) + '" stroke="#f4c14d" stroke-width="2" stroke-dasharray="6 6"/>' +
        '<text x="' + (PADX + 6) + '" y="' + (targetY - 6).toFixed(2) + '" fill="#f4c14d" font-family="IBM Plex Mono, Menlo, monospace" font-size="12">target fills/hr ' + money(target, 2) + '</text>';
      const totalFills = bins.reduce((acc, item) => acc + item, 0);
      text("fillsCadenceSummary", "Total fills in window: " + String(totalFills) + " | Avg/5m bin: " + money(totalFills / bins.length, 2));
    }

    function renderEdgeHistogram(state) {
      const svg = el("edgeHistogramChart");
      if (!svg) return;
      const data = state.data || {};
      const fills = Array.isArray(data.recentFills) ? data.recentFills : [];
      const edges = fills
        .map((row) => parseNumericField(row.edge_bps))
        .filter((value) => value !== null && Number.isFinite(value));
      if (edges.length === 0) {
        svg.innerHTML = '<text x="20" y="44" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="15">No edge data available</text>';
        text("edgeHistogramSummary", "No edge_bps found in recent fills.");
        return;
      }

      const min = Math.min(...edges);
      const max = Math.max(...edges);
      const bucketCount = 20;
      const range = Math.max(1e-9, max - min);
      const buckets = new Array(bucketCount).fill(0);
      for (const edge of edges) {
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(((edge - min) / range) * bucketCount)));
        buckets[idx] += 1;
      }
      const W = 1200;
      const H = 300;
      const PADX = 50;
      const PADY = 28;
      const maxBin = Math.max(1, ...buckets);
      const bw = (W - PADX * 2) / bucketCount;
      let bars = "";
      buckets.forEach((count, idx) => {
        const h = ((H - PADY * 2) * count) / maxBin;
        const x = PADX + idx * bw;
        const y = H - PADY - h;
        bars += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + Math.max(1, bw - 1).toFixed(2) + '" height="' + h.toFixed(2) + '" fill="rgba(33,227,162,0.75)"></rect>';
      });
      const mean = edges.reduce((acc, v) => acc + v, 0) / edges.length;
      const sorted = [...edges].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const meanX = PADX + ((mean - min) / range) * (W - PADX * 2);
      svg.innerHTML =
        bars +
        '<line x1="' + meanX.toFixed(2) + '" y1="' + PADY + '" x2="' + meanX.toFixed(2) + '" y2="' + (H - PADY) + '" stroke="#ff6d7c" stroke-width="2"/>' +
        '<text x="' + (meanX + 6).toFixed(2) + '" y="' + (PADY + 12) + '" fill="#ff6d7c" font-family="IBM Plex Mono, Menlo, monospace" font-size="12">mean</text>';
      text("edgeHistogramSummary", "mean " + money(mean, 2) + " bps | median " + money(median, 2) + " bps | samples " + String(edges.length));
    }

    function renderChartMode(state) {
      const mode = state.chartMode || "equity";
      const map = {
        equity: "chartModeEquity",
        drawdown: "chartModeDrawdown",
        fills: "chartModeFills",
        edge: "chartModeEdge"
      };
      Object.keys(map).forEach((key) => {
        const node = el(map[key]);
        if (node) node.style.display = mode === key ? "" : "none";
      });
      document.querySelectorAll(".chart-mode-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-chart-mode") === mode);
      });
      if (mode === "drawdown") renderDrawdownMain(state);
      if (mode === "fills") renderFillsCadence(state);
      if (mode === "edge") renderEdgeHistogram(state);
    }

    function overlayFillMarkersOnEquity(state) {
      const svg = el("equityChart");
      const data = state.data || {};
      const fills = Array.isArray(data.recentFills) ? data.recentFills : [];
      const series = eqFilterByWindow(state.equitySeries || [], state.equityWindow || "24h");
      if (!svg || fills.length === 0 || series.length < 2) return;
      const startTs = n(series[0].ts, 0);
      const endTs = n(series[series.length - 1].ts, 0);
      if (endTs <= startTs) return;
      const mode = state.equityMode === "BTC" ? "equityBtc" : "equityUsd";
      const values = series.map((row) => n(row[mode], 0));
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = Math.max(1e-9, max - min);
      const W = 1200;
      const H = 300;
      const PADX = 56;
      const PADY = 28;
      let markers = "";
      for (const fill of fills) {
        const t = n(fill.ts, 0);
        if (t < startTs || t > endTs) continue;
        const x = PADX + ((t - startTs) / (endTs - startTs)) * (W - PADX * 2);
        const nearest = series.reduce(
          (best, point) => (Math.abs(n(point.ts, 0) - t) < Math.abs(n(best.ts, 0) - t) ? point : best),
          series[0]
        );
        const y = H - PADY - ((n(nearest[mode], 0) - min) / range) * (H - PADY * 2);
        const side = String(fill.side || "-").toUpperCase();
        const color = side === "SELL" ? "#ff6d7c" : "#21e3a2";
        markers += '<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="3" fill="' + color + '" opacity="0.9"></circle>';
      }
      if (markers) {
        svg.insertAdjacentHTML("beforeend", markers);
      }
    }

    function renderForecast(state) {
      const data = state.data || {};
      const analytics = data.analytics || {};
      const fills30m = n(analytics.fillsLast30m, 0);
      const fills1h = n(analytics.fillsLast1h, n(analytics.fills1hCount, 0));
      const cancels1h = n(analytics.cancelsLast1h, 0);
      const avgEdge = (n(analytics.avgEdgeBps1hBuy, 0) + n(analytics.avgEdgeBps1hSell, 0)) / 2;
      const expectedFills30 = Math.max(0, fills30m + (fills30m === 0 ? 1 : 0) - (cancels1h > 150 ? 1 : 0));
      const edge30 = avgEdge + (cancels1h > 150 ? -1 : 0);
      const pnlLow = (expectedFills30 * edge30 * 0.02) / 100;
      const pnlHigh = (expectedFills30 * edge30 * 0.06) / 100;
      text("forecastLine1", "Expected fills next 30m: " + String(expectedFills30) + " | baseline fills/hr " + String(fills1h));
      text("forecastLine2", "Expected edge 30m: " + money(edge30, 2) + " bps | PnL range: $" + money(pnlLow, 2) + " to $" + money(pnlHigh, 2));
    }

    function renderAutonomy(state) {
      const data = state.data || {};
      const analytics = data.analytics || {};
      const auto = state.computedAutonomy || computeAutonomyRecommendation(data);
      text("autonomyAction", String(auto.action || "HOLD"));
      text("autonomyConfidence", "confidence " + money(n(auto.confidence, 0), 0) + "%");
      const node = el("autonomyReasons");
      const reasons = Array.isArray(auto.reasons) ? auto.reasons : [];
      if (node) {
        node.innerHTML = reasons.length
          ? reasons.map((reason) => '<span class="tiny-chip">' + escapeHtml(String(reason)) + "</span>").join("")
          : '<span class="tiny-chip">NONE</span>';
      }
      text(
        "autonomyImpact",
        "fills/hr " +
          (n(auto.expectedFillsHrDelta, 0) >= 0 ? "+" : "") +
          money(n(auto.expectedFillsHrDelta, 0), 2) +
          " | churn " +
          (n(auto.expectedChurnDelta, 0) >= 0 ? "+" : "") +
          money(n(auto.expectedChurnDelta, 0), 1) +
          " | edge " +
          (n(auto.expectedEdgeDeltaBps, 0) >= 0 ? "+" : "") +
          money(n(auto.expectedEdgeDeltaBps, 0), 2) +
          " bps"
      );
      document.querySelectorAll(".autopilot-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-autopilot") === state.autopilotMode);
      });
      text("guardrailLine1", "Max inventory: " + (data.botStatus && data.botStatus.max_inventory_usd ? "$" + money(data.botStatus.max_inventory_usd, 2) : "n/a"));
      text("guardrailLine2", "Max cancels/hr: " + String(n(analytics.maxCancelsPerHour, n(analytics.cancelsLast1h, 0) > 0 ? 200 : 0) || "n/a"));
      text("guardrailLine3", "Max rejects/hr: n/a | Daily stop: " + (data.botStatus && data.botStatus.pnl_daily_stop_usd ? "$" + money(data.botStatus.pnl_daily_stop_usd, 2) : "n/a"));
    }

    function renderDiagnoseView(state) {
      const data = state.data;
      if (!data) return;
      const analytics = data.analytics || {};
      const bot = data.botStatus || {};
      const ticker = data.ticker || {};
      const mid = n(ticker.mid, 0);
      const spreadBps = mid > 0 ? ((n(ticker.ask, 0) - n(ticker.bid, 0)) / mid) * 10000 : 0;
      const fills30m = n(analytics.fillsLast30m, 0);
      const cancels1h = n(analytics.cancelsLast1h, 0);
      const rejects1h = n(analytics.postOnlyRejectsLast1h, 0);
      const buyReasons = Array.isArray(bot.buy_reasons) ? bot.buy_reasons : [];
      const sellReasons = Array.isArray(bot.sell_reasons) ? bot.sell_reasons : [];
      let cause = "Balanced";
      if (rejects1h >= 6) cause = "Post-only rejects / crossing";
      else if (fills30m === 0 && cancels1h > 120) cause = "Churn / queue position";
      else if (!bot.allow_buy || !bot.allow_sell) cause = "Inventory or reserve gate";
      else if (spreadBps < 2) cause = "Market too tight";

      text("diagnoseCause", cause);
      text("diagnoseContext1", "allow_buy=" + String(Boolean(bot.allow_buy)) + " | allow_sell=" + String(Boolean(bot.allow_sell)));
      text("diagnoseContext2", "fills30m=" + String(fills30m) + " | cancels1h=" + String(cancels1h) + " | rejects1h=" + String(rejects1h));
      text(
        "diagnoseContext3",
        "inside spread=" +
          money(spreadBps, 2) +
          "bps | TOB " +
          String(bot.tob_mode || "OFF") +
          " (" +
          String(bot.tob_reason || "n/a") +
          ") | buy reasons: " +
          String(buyReasons.join("; ") || "-") +
          " | sell reasons: " +
          String(sellReasons.join("; ") || "-")
      );
      const list = el("diagnoseActions");
      if (list) {
        const items = [
          "If fills are zero, tighten BASE_HALF_SPREAD_BPS by 1-2 bps.",
          "If rejects are high, widen by 1-2 bps and verify post-only offsets.",
          "If churn is high, increase REPRICE_MOVE_BPS or QUEUE_REFRESH_SECONDS.",
          "If buy blocked by reserve, lower CASH_RESERVE_USD or LEVEL_QUOTE_SIZE_USD.",
          "If inventory gate blocks one side, relax low/high inventory thresholds.",
          "Tune LEVELS / LEVEL_STEP_BPS / TOB_QUOTE_SIZE_USD for fill quality."
        ];
        list.innerHTML = items.map((item) => "<li>" + escapeHtml(item) + "</li>").join("");
      }
    }

    function optimizeInputs() {
      return {
        spread: n(el("optSpread") && el("optSpread").value, 10),
        step: n(el("optStep") && el("optStep").value, 10),
        levels: n(el("optLevels") && el("optLevels").value, 2),
        quote: n(el("optQuote") && el("optQuote").value, 8),
        skew: n(el("optSkew") && el("optSkew").value, 25),
        targetFills: n(el("optTargetFills") && el("optTargetFills").value, 2)
      };
    }

    function renderOptimizeView(state) {
      const vals = optimizeInputs();
      text("optSpreadVal", String(vals.spread));
      text("optStepVal", String(vals.step));
      text("optLevelsVal", String(vals.levels));
      text("optQuoteVal", String(vals.quote));
      text("optSkewVal", String(vals.skew));
      text("optTargetFillsVal", String(vals.targetFills));

      const data = state.data || {};
      const analytics = data.analytics || {};
      const baseFills = n(analytics.fillsLast1h, n(analytics.fills1hCount, 0));
      const baseCancels = n(analytics.cancelsLast1h, 0);
      const baseEdge = (n(analytics.avgEdgeBps1hBuy, 0) + n(analytics.avgEdgeBps1hSell, 0)) / 2;
      const expectedFills = Math.max(0, baseFills + (10 - vals.spread) * 0.25 + (vals.levels - 2) * 0.35 + (vals.targetFills - baseFills) * 0.25);
      const expectedCancels = Math.max(0, baseCancels + (vals.levels - 2) * 20 + (vals.step < 8 ? 15 : -8));
      const expectedEdge = baseEdge + (vals.spread - 10) * 0.35 - (vals.quote - 8) * 0.05;
      text("optimizePreview1", "Expected fills/hr: " + money(expectedFills, 2));
      text("optimizePreview2", "Expected cancels/hr: " + money(expectedCancels, 1));
      text("optimizePreview3", "Expected edge: " + money(expectedEdge, 2) + " bps");
    }

    function renderAuditView(state) {
      const body = el("decisionBody");
      if (!body) return;
      const history = Array.isArray(state.decisionHistory) ? state.decisionHistory : [];
      text("decisionInfo", "Stored snapshots: " + String(history.length) + " / cap 2000");
      if (history.length === 0) {
        body.innerHTML = '<tr><td colspan="13" style="color:#8fa6c1">none</td></tr>';
        return;
      }
      const rows = history.slice(-300).reverse();
      body.innerHTML = rows
        .map((row, idx) => {
          const sourceIndex = history.length - 1 - idx;
          return (
            '<tr data-decision-index="' +
            String(sourceIndex) +
            '">' +
            '<td>' +
            ts(row.ts) +
            "</td>" +
            "<td>" +
            money(row.mid, 2) +
            "</td>" +
            "<td>" +
            money(row.spreadBps, 2) +
            "</td>" +
            "<td>" +
            (row.allow_buy ? "yes" : "no") +
            "</td>" +
            "<td>" +
            (row.allow_sell ? "yes" : "no") +
            "</td>" +
            "<td>" +
            money(row.trendMoveBps, 2) +
            "</td>" +
            "<td>" +
            money(row.effectiveHalfSpreadBps, 2) +
            "</td>" +
            "<td>" +
            money(row.adaptiveDelta, 2) +
            "</td>" +
            "<td>" +
            String(row.fills30m) +
            "</td>" +
            "<td>" +
            String(row.cancels1h) +
            "</td>" +
            "<td>" +
            String(row.rejects1h) +
            "</td>" +
            "<td>" +
            escapeHtml(String(row.signalVolRegime || "-")) +
            "</td>" +
            '<td><button class="btn" data-view-decision="' +
            String(sourceIndex) +
            '">View</button></td>' +
            "</tr>"
          );
        })
        .join("");
    }

    function renderPnlPanel(state) {
      const data = state.data;
      if (!data) return;

      const summary = data.pnlSummary || {};
      const series = Array.isArray(data.pnlSeries) ? data.pnlSeries : [];
      const botStatus = data.botStatus || {};

      text("pnlNow", "PnL " + money(n(summary.pnlUsd, 0), 2) + " USD");
      text(
        "pnlRange",
        String(data.pnlWindow || "24h").toUpperCase() +
          " range " +
          money(n(summary.minPnlUsd, 0), 2) +
          " to " +
          money(n(summary.maxPnlUsd, 0), 2)
      );

      const spanStart = series.length > 0 ? ts(series[0].ts) : "-";
      const spanEnd = series.length > 0 ? ts(series[series.length - 1].ts) : "-";
      text("pnlSpan", spanStart + " to " + spanEnd);

      const buyGate = statusToGate(botStatus.allow_buy, botStatus.buy_reasons || []);
      const sellGate = statusToGate(botStatus.allow_sell, botStatus.sell_reasons || []);

      const buyChip = el("buyGateChip");
      if (buyChip) {
        buyChip.textContent = "Buy: " + buyGate.short;
        buyChip.classList.remove("ok", "block");
        buyChip.classList.add(buyGate.ok ? "ok" : "block");
      }

      const sellChip = el("sellGateChip");
      if (sellChip) {
        sellChip.textContent = "Sell: " + sellGate.short;
        sellChip.classList.remove("ok", "block");
        sellChip.classList.add(sellGate.ok ? "ok" : "block");
      }

      text("gateLine", "Buy: " + buyGate.short + " | Sell: " + sellGate.short);

      const toggles = document.querySelectorAll("#windowToggles [data-window]");
      toggles.forEach((btn) => {
        const win = btn.getAttribute("data-window");
        btn.classList.toggle("active", win === state.pnlWindow);
      });

      renderChart(series);
    }

    function renderChart(series) {
      const svg = el("pnlChart");
      if (!svg) return;

      if (!Array.isArray(series) || series.length === 0) {
        svg.innerHTML = '<text x="20" y="44" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="15">No PnL data yet</text>';
        return;
      }

      const W = 1200;
      const H = 300;
      const PADX = 46;
      const PADY = 28;
      const values = series.map((p) => n(p.pnlUsd, 0));
      let min = Math.min.apply(null, values);
      let max = Math.max.apply(null, values);
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const range = max - min;
      const xSpan = Math.max(1, series.length - 1);

      const x = (idx) => PADX + (idx / xSpan) * (W - PADX * 2);
      const y = (val) => H - PADY - ((val - min) / range) * (H - PADY * 2);

      const zeroVal = min > 0 ? min : (max < 0 ? max : 0);
      const yZero = y(zeroVal);
      const lastVal = values[values.length - 1];
      const up = lastVal >= 0;
      const stroke = up ? "#21e3a2" : "#ff6d7c";
      const fill = up ? "rgba(33, 227, 162, 0.16)" : "rgba(255, 109, 124, 0.18)";

      let line = "";
      for (let i = 0; i < series.length; i += 1) {
        line += (i === 0 ? "M " : " L ") + x(i).toFixed(2) + " " + y(values[i]).toFixed(2);
      }

      const area =
        line +
        " L " +
        x(series.length - 1).toFixed(2) +
        " " +
        yZero.toFixed(2) +
        " L " +
        x(0).toFixed(2) +
        " " +
        yZero.toFixed(2) +
        " Z";

      const maxY = y(max).toFixed(2);
      const minY = y(min).toFixed(2);
      const lastX = x(series.length - 1).toFixed(2);
      const lastY = y(lastVal).toFixed(2);

      svg.innerHTML =
        '<line x1="' + PADX + '" y1="' + yZero.toFixed(2) + '" x2="' + (W - PADX) + '" y2="' + yZero.toFixed(2) + '" stroke="rgba(143,166,193,0.4)" stroke-width="1" />' +
        '<line x1="' + PADX + '" y1="' + maxY + '" x2="' + (W - PADX) + '" y2="' + maxY + '" stroke="rgba(255,255,255,0.08)" stroke-width="1" />' +
        '<line x1="' + PADX + '" y1="' + minY + '" x2="' + (W - PADX) + '" y2="' + minY + '" stroke="rgba(255,255,255,0.08)" stroke-width="1" />' +
        '<path d="' + area + '" fill="' + fill + '" />' +
        '<path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="3" stroke-linecap="round" />' +
        '<circle cx="' + lastX + '" cy="' + lastY + '" r="4" fill="' + stroke + '" />' +
        '<text x="' + (PADX + 6) + '" y="' + (Number(maxY) - 8) + '" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="12">max ' + money(max, 2) + '</text>' +
        '<text x="' + (PADX + 6) + '" y="' + (Number(minY) - 8) + '" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="12">min ' + money(min, 2) + '</text>';
    }

    function drawGrid(svgWidth, svgHeight, padX, padY, rows, cols) {
      let out = "";
      const usableW = svgWidth - padX * 2;
      const usableH = svgHeight - padY * 2;
      for (let i = 0; i <= rows; i += 1) {
        const y = padY + (usableH * i) / rows;
        out += '<line x1="' + padX + '" y1="' + y.toFixed(2) + '" x2="' + (svgWidth - padX) + '" y2="' + y.toFixed(2) + '" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>';
      }
      for (let j = 0; j <= cols; j += 1) {
        const x = padX + (usableW * j) / cols;
        out += '<line x1="' + x.toFixed(2) + '" y1="' + padY + '" x2="' + x.toFixed(2) + '" y2="' + (svgHeight - padY) + '" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>';
      }
      return out;
    }

    function drawAxes(svgWidth, svgHeight, padX, padY, minVal, maxVal, yFormatter, startTs, endTs) {
      const ticks = 5;
      const out = [];
      for (let i = 0; i <= ticks; i += 1) {
        const pct = i / ticks;
        const val = maxVal - (maxVal - minVal) * pct;
        const y = padY + pct * (svgHeight - padY * 2);
        out.push(
          '<text x="' +
            (padX - 8) +
            '" y="' +
            (y + 4).toFixed(2) +
            '" fill="#8fa6c1" text-anchor="end" font-family="IBM Plex Mono, Menlo, monospace" font-size="11">' +
            escapeHtml(yFormatter(val)) +
            "</text>"
        );
      }
      const midTs = startTs + (endTs - startTs) / 2;
      const xLabels = [
        { x: padX, label: ts(startTs), anchor: "start" },
        { x: svgWidth / 2, label: ts(midTs), anchor: "middle" },
        { x: svgWidth - padX, label: ts(endTs), anchor: "end" }
      ];
      for (const label of xLabels) {
        out.push(
          '<text x="' +
            label.x.toFixed(2) +
            '" y="' +
            (svgHeight - 10) +
            '" fill="#8fa6c1" text-anchor="' +
            label.anchor +
            '" font-family="IBM Plex Mono, Menlo, monospace" font-size="11">' +
            escapeHtml(label.label) +
            "</text>"
        );
      }
      return out.join("");
    }

    function renderFillMarkers(fills, timeScale, yForTs, startTs, endTs) {
      const rows = Array.isArray(fills) ? fills : [];
      let out = "";
      for (const fill of rows) {
        const t = n(fill.ts, 0);
        if (t < startTs || t > endTs) continue;
        const x = timeScale(t);
        const y = yForTs(t, fill);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const side = String(fill.side || "-").toUpperCase();
        const color = side === "SELL" ? "#ff6d7c" : "#21e3a2";
        out += '<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="3" fill="' + color + '" opacity="0.9"></circle>';
      }
      return out;
    }

    function addCrosshairTooltip(svg, series, formatter, yScale, xScale, startTs, endTs) {
      const tooltip = el("primaryTooltip");
      const shell = el("primaryChartShell");
      if (!svg || !tooltip || !shell || !Array.isArray(series) || series.length < 2) return;
      let vLine = svg.querySelector("#primaryCrossV");
      let hLine = svg.querySelector("#primaryCrossH");
      if (!vLine) {
        vLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        vLine.setAttribute("id", "primaryCrossV");
        vLine.setAttribute("stroke", "rgba(55,180,255,0.65)");
        vLine.setAttribute("stroke-width", "1");
        vLine.setAttribute("display", "none");
        svg.appendChild(vLine);
      }
      if (!hLine) {
        hLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        hLine.setAttribute("id", "primaryCrossH");
        hLine.setAttribute("stroke", "rgba(55,180,255,0.45)");
        hLine.setAttribute("stroke-width", "1");
        hLine.setAttribute("display", "none");
        svg.appendChild(hLine);
      }
      svg.onmousemove = (event) => {
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0) return;
        const rx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const targetTs = startTs + (endTs - startTs) * rx;
        let nearest = series[0];
        for (const point of series) {
          if (Math.abs(n(point.ts, 0) - targetTs) < Math.abs(n(nearest.ts, 0) - targetTs)) {
            nearest = point;
          }
        }
        const x = xScale(n(nearest.ts, 0));
        const y = yScale(n(nearest.value, 0));
        vLine.setAttribute("x1", x.toFixed(2));
        vLine.setAttribute("x2", x.toFixed(2));
        vLine.setAttribute("y1", "30");
        vLine.setAttribute("y2", "330");
        vLine.setAttribute("display", "block");
        hLine.setAttribute("x1", "64");
        hLine.setAttribute("x2", "1136");
        hLine.setAttribute("y1", y.toFixed(2));
        hLine.setAttribute("y2", y.toFixed(2));
        hLine.setAttribute("display", "block");

        const shellRect = shell.getBoundingClientRect();
        const left = Math.max(8, Math.min(shellRect.width - 230, event.clientX - shellRect.left + 12));
        const top = Math.max(8, Math.min(shellRect.height - 70, event.clientY - shellRect.top - 14));
        tooltip.style.display = "block";
        tooltip.style.left = left + "px";
        tooltip.style.top = top + "px";
        tooltip.innerHTML =
          "<div><strong>" +
          escapeHtml(ts(nearest.ts)) +
          "</strong></div><div>" +
          escapeHtml(formatter(nearest.value)) +
          "</div><div>mid: " +
          escapeHtml(money(nearest.mid, 2)) +
          "</div>";
      };
      svg.onmouseleave = () => {
        tooltip.style.display = "none";
        vLine.setAttribute("display", "none");
        hLine.setAttribute("display", "none");
      };
    }

    function renderPrimaryChart(state) {
      const svg = el("primaryChart");
      const data = state.data || {};
      if (!svg) return;
      const mode = state.primarySeriesMode || "equity";
      const windowKey = state.pnlWindow || "24h";
      const series =
        mode === "pnl"
          ? (Array.isArray(data.pnlSeries) ? data.pnlSeries : []).map((row) => ({
              ts: n(row.ts, 0),
              value: n(row.pnlUsd, 0),
              mid: n(row.mid, 0)
            }))
          : eqFilterByWindow(state.equitySeries || [], windowKey).map((row) => ({
              ts: n(row.ts, 0),
              value: state.equityMode === "BTC" ? n(row.equityBtc, 0) : n(row.equityUsd, 0),
              mid: n(row.mid, 0),
              price: state.equityMode === "BTC" ? n(row.equityBtc, 0) : n(row.equityUsd, 0)
            }));
      if (!Array.isArray(series) || series.length < 2) {
        svg.innerHTML = '<text x="20" y="44" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="15">Awaiting chart data</text>';
        return;
      }

      const W = 1200;
      const H = 360;
      const PADX = 64;
      const PADY = 30;
      const values = series.map((p) => n(p.value, 0));
      let min = Math.min(...values);
      let max = Math.max(...values);
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const range = Math.max(1e-9, max - min);
      const startTs = n(series[0].ts, Date.now() - 1000);
      const endTs = n(series[series.length - 1].ts, Date.now());
      const xScale = (tsValue) => PADX + ((tsValue - startTs) / Math.max(1, endTs - startTs)) * (W - PADX * 2);
      const yScale = (value) => H - PADY - ((value - min) / range) * (H - PADY * 2);
      const stroke = mode === "pnl" ? "#21e3a2" : "#37b4ff";
      const fill = mode === "pnl" ? "rgba(33,227,162,0.14)" : "rgba(55,180,255,0.12)";

      let line = "";
      for (let i = 0; i < series.length; i += 1) {
        const x = xScale(series[i].ts);
        const y = yScale(series[i].value);
        line += (i === 0 ? "M " : " L ") + x.toFixed(2) + " " + y.toFixed(2);
      }
      const area =
        line +
        " L " +
        xScale(series[series.length - 1].ts).toFixed(2) +
        " " +
        (H - PADY).toFixed(2) +
        " L " +
        xScale(series[0].ts).toFixed(2) +
        " " +
        (H - PADY).toFixed(2) +
        " Z";

      const yFormatter =
        mode === "pnl"
          ? (value) => "$" + money(value, 2)
          : state.equityMode === "BTC"
            ? (value) => money(value, 6) + " BTC"
            : (value) => "$" + money(value, 2);
      const fills = Array.isArray(data.recentFills) ? data.recentFills : [];
      const fillMarkers = renderFillMarkers(
        fills,
        xScale,
        (fillTs) => {
          const nearest = series.reduce((best, point) =>
            Math.abs(n(point.ts, 0) - fillTs) < Math.abs(n(best.ts, 0) - fillTs) ? point : best
          , series[0]);
          return yScale(nearest.value);
        },
        startTs,
        endTs
      );

      svg.innerHTML =
        drawGrid(W, H, PADX, PADY, 5, 6) +
        drawAxes(W, H, PADX, PADY, min, max, yFormatter, startTs, endTs) +
        '<path d="' + area + '" fill="' + fill + '"></path>' +
        '<path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="3" stroke-linecap="round"></path>' +
        fillMarkers;

      addCrosshairTooltip(
        svg,
        series,
        (value) => (mode === "pnl" ? "PnL " + yFormatter(value) : "Equity " + yFormatter(value)),
        yScale,
        xScale,
        startTs,
        endTs
      );
      document.querySelectorAll(".primary-chart-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-primary-chart") === mode);
      });
    }

    function renderBalancesInto(targetId, rows) {
      const body = el(targetId);
      if (!body) return;
      if (!Array.isArray(rows) || rows.length === 0) {
        body.innerHTML = '<tr><td colspan="3" style="color:#8fa6c1">none</td></tr>';
        return;
      }
      body.innerHTML = rows
        .map((row) =>
          '<tr>' +
            '<td>' + String(row.asset || "-") + '</td>' +
            '<td>' + money(row.free, 8) + '</td>' +
            '<td>' + money(row.total, 8) + '</td>' +
          '</tr>'
        )
        .join("");
    }

    function renderBalances(state) {
      const data = state.data;
      if (!data) return;
      const rows = Array.isArray(data.balances) ? data.balances : [];
      renderBalancesInto("balancesBody", rows);
      renderBalancesInto("balancesBodyRight", rows);
    }

    function renderOrdersInto(targetId, rows) {
      const body = el(targetId);
      if (!body) return;
      body.classList.add("orders-fade");
      if (!Array.isArray(rows) || rows.length === 0) {
        body.innerHTML = '<tr><td colspan="7" style="color:#8fa6c1">none</td></tr>';
        return;
      }
      body.innerHTML = rows
        .map((row) => {
          const side = String(row.side || "-").toUpperCase();
          const sideClass = side === "BUY" ? "side-buy" : side === "SELL" ? "side-sell" : "";
          const clientId = String(row.clientOrderId || row.client_order_id || "-");
          const quote = quoteFromOrder(row);
          const status = String(row.status || "-");
          const lifecycleState = String(row.lifecycleState || "").toUpperCase();
          const staleReason =
            row.reconcile && typeof row.reconcile === "object" ? String(row.reconcile.staleReason || "") : "";
          const ageSeconds = Math.max(0, Math.floor(n(row.ageSeconds, 0)));
          const updatedTs = n(row.updatedTs, n(row.updated_at, 0));
          const staleBadge = staleReason ? '<span class="tiny-chip">stale</span>' : "";
          const rowClass =
            lifecycleState === "PENDING_LOCAL"
              ? staleReason
                ? "order-row-pending order-row-stale"
                : "order-row-pending"
              : "";
          return (
            '<tr class="' + rowClass + '">' +
              '<td><span>' + escapeHtml(clientId) + '</span><button class="copy-btn" data-copy="' + escapeHtml(clientId) + '">copy</button></td>' +
              '<td class="' + sideClass + '">' + side + '</td>' +
              '<td>' + money(row.price, 2) + '</td>' +
              '<td>' + (quote === null ? '-' : money(quote, 2)) + '</td>' +
              '<td><span class="order-status-chip">' + escapeHtml(status) + staleBadge + '</span></td>' +
              '<td>' + String(ageSeconds) + "s</td>" +
              '<td>' + ts(updatedTs) + '</td>' +
            '</tr>'
          );
        })
        .join("");
    }

    function renderOrders(state) {
      const data = state.data;
      if (!data) return;
      const openRows = Array.isArray(data.activeBotOrders) ? data.activeBotOrders : [];
      const allRows = Array.isArray(data.activeBotOrdersAll) ? data.activeBotOrdersAll : openRows;
      const pendingRows = allRows.filter((row) => String(row.lifecycleState || "").toUpperCase() === "PENDING_LOCAL");
      const filter = String(state.orderViewFilter || "open").toLowerCase();
      const rows = filter === "pending" ? pendingRows : filter === "all" ? allRows : openRows;
      const summary =
        data.activeBotOrdersSummary && typeof data.activeBotOrdersSummary === "object"
          ? data.activeBotOrdersSummary
          : {
              openVenue: openRows.length,
              pendingLocal: pendingRows.length,
              totalTracked: allRows.length
            };
      text(
        "ordersSummaryLine",
        "Open on venue: " +
          String(Math.max(0, Math.floor(n(summary.openVenue, openRows.length)))) +
          " | Pending: " +
          String(Math.max(0, Math.floor(n(summary.pendingLocal, pendingRows.length)))) +
          " | Total tracked: " +
          String(Math.max(0, Math.floor(n(summary.totalTracked, allRows.length))))
      );
      document.querySelectorAll(".order-view-btn").forEach((node) => {
        node.classList.toggle("active", String(node.getAttribute("data-order-view") || "").toLowerCase() === filter);
      });
      if (ordersRenderFrame) cancelAnimationFrame(ordersRenderFrame);
      ordersRenderFrame = requestAnimationFrame(() => {
        ordersRenderFrame = 0;
        const rightBody = el("ordersBodyRight");
        if (rightBody) rightBody.classList.add("is-updating");
        renderOrdersInto("ordersBody", rows);
        renderOrdersInto("ordersBodyRight", rows);
        requestAnimationFrame(() => {
          const node = el("ordersBodyRight");
          if (node) node.classList.remove("is-updating");
        });
      });
    }

    function renderRecentOrders(state) {
      const data = state.data;
      if (!data) return;
      const rows = Array.isArray(data.recentBotOrders) ? data.recentBotOrders : [];
      const body = el("recentOrdersBody");
      if (!body) return;
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="color:#8fa6c1">none</td></tr>';
        return;
      }

      body.innerHTML = rows
        .slice(0, 50)
        .map((row) => {
          const side = String(row.side || "-").toUpperCase();
          const sideClass = side === "BUY" ? "side-buy" : side === "SELL" ? "side-sell" : "";
          const clientId = String(row.client_order_id || "-");
          const quote = quoteFromOrder(row);
          const when = n(row.ts || row.updated_at || row.created_at, 0);
          return (
            '<tr>' +
              '<td>' + ts(when) + '</td>' +
              '<td>' + escapeHtml(clientId) + '</td>' +
              '<td class="' + sideClass + '">' + side + '</td>' +
              '<td>' + money(row.price, 2) + '</td>' +
              '<td>' + (quote === null ? "-" : money(quote, 2)) + '</td>' +
              '<td>' + escapeHtml(String(row.status || "-")) + '</td>' +
            '</tr>'
          );
        })
        .join("");
    }

    function renderEvents(state) {
      const filter = state.eventFilter;
      const allEvents = Array.isArray(state.uiEvents) ? state.uiEvents : [];
      const events = filter === "ALL" ? allEvents : allEvents.filter((row) => row.type === filter);
      text("eventsInfo", "Showing last " + String(state.maxUiEvents) + " events | newest first");
      text("eventStoredInfo", "Stored " + String(allEvents.length) + " / Cap " + String(state.maxUiEvents));

      const counts = {
        ALL: allEvents.length,
        PLACED: 0,
        CANCELLED: 0,
        FILLED: 0,
        REPLACED: 0,
        REJECTED: 0,
        OVERRIDE: 0,
        ERROR: 0
      };
      for (const row of allEvents) {
        const key = String(row.type || "").toUpperCase();
        if (Object.prototype.hasOwnProperty.call(counts, key)) {
          counts[key] += 1;
        }
      }
      text("eventCountALL", String(counts.ALL));
      text("eventCountPLACED", String(counts.PLACED));
      text("eventCountCANCELLED", String(counts.CANCELLED));
      text("eventCountFILLED", String(counts.FILLED));
      text("eventCountREPLACED", String(counts.REPLACED));
      text("eventCountREJECTED", String(counts.REJECTED));
      text("eventCountOVERRIDE", String(counts.OVERRIDE));
      text("eventCountERROR", String(counts.ERROR));

      document.querySelectorAll(".event-pill").forEach((node) => {
        const val = node.getAttribute("data-filter");
        node.classList.toggle("active", val === filter);
      });

      const body = el("eventsBody");
      if (!body) return;
      if (events.length === 0) {
        body.innerHTML = '<tr><td colspan="7" style="color:#8fa6c1">none</td></tr>';
        return;
      }

      body.innerHTML = events
        .slice(0, state.maxUiEvents)
        .map((row) => {
          const side = String(row.side || "-").toUpperCase();
          const sideClass = side === "BUY" ? "side-buy" : side === "SELL" ? "side-sell" : "";
          return (
            '<tr>' +
              '<td>' + ts(row.ts) + '</td>' +
              '<td><span class="badge ' + eventBadgeClass(row.type) + '">' + row.type + '</span></td>' +
              '<td class="' + sideClass + '">' + side + '</td>' +
              '<td>' + (Number.isFinite(row.price) ? money(row.price, 2) : '-') + '</td>' +
              '<td>' + (Number.isFinite(row.size) ? money(row.size, 8) : '-') + '</td>' +
              '<td>' + escapeHtml(row.reason || "-") + '</td>' +
              '<td>' + escapeHtml(row.client_id || "-") + '</td>' +
            '</tr>'
          );
        })
        .join("");
    }

    function renderExecutionView(state) {
      const data = state.data;
      if (!data) return;
      const analytics = data.analytics || {};
      text(
        "execDiagLine1",
        "fills 30m: " +
          String(n(analytics.fillsLast30m, 0)) +
          " | fills 1h: " +
          String(n(analytics.fillsLast1h, n(analytics.fills1hCount, 0)))
      );
      text(
        "execDiagLine2",
        "rejects 1h: " +
          String(n(analytics.postOnlyRejectsLast1h, 0)) +
          " | cancels 1h: " +
          String(n(analytics.cancelsLast1h, 0)) +
          " | avg rest: " +
          money(n(analytics.avgRestingTimeSeconds, 0), 1) +
          "s"
      );
      text(
        "execDiagLine3",
        "budget: " +
          String(n(analytics.actionBudgetUsed, 0)) +
          "/" +
          String(n(analytics.actionBudgetMax, 0)) +
          " | health: " +
          executionHealth(analytics)
      );
    }

    function renderSignalsView(state) {
      const data = state.data;
      if (!data) return;
      const analytics = data.analytics || {};
      text("signalLine1", "vol regime: " + String(analytics.signalVolRegime || "normal"));
      text(
        "signalLine2",
        "drift: " +
          money(n(analytics.signalDriftBps, 0), 2) +
          " bps | z: " +
          money(n(analytics.signalZScore, 0), 2) +
          " | stdev: " +
          money(n(analytics.signalStdevBps, 0), 2) +
          " bps"
      );
      text(
        "signalLine3",
        "skew applied: " +
          money(n(analytics.signalSkewBpsApplied, 0), 2) +
          " bps | basis: " +
          money(n(analytics.signalBasisBps, 0), 2) +
          " bps | dispersion: " +
          money(n(analytics.signalDispersionBps, 0), 2) +
          " bps | fair/global: " +
          money(n(analytics.signalFairMid, 0), 2) +
          "/" +
          money(n(analytics.signalGlobalMid, 0), 2) +
          " | confidence: " +
          money(n(analytics.signalConfidence, 0), 2)
      );
    }

    function renderRiskView(state) {
      const data = state.data;
      if (!data) return;
      const bot = data.botStatus || {};
      const buyGate = statusToGate(bot.allow_buy, bot.buy_reasons || []);
      const sellGate = statusToGate(bot.allow_sell, bot.sell_reasons || []);
      text("riskLine1", "buy gate: " + buyGate.short + " | sell gate: " + sellGate.short);
      text(
        "riskLine2",
        "consecutive errors: " + String(n(bot.consecutive_errors, 0))
      );
      text(
        "riskLine3",
        "buy reasons: " +
          String((bot.buy_reasons || []).join("; ") || "-") +
          " | sell reasons: " +
          String((bot.sell_reasons || []).join("; ") || "-")
      );
    }

    function renderOverridesView(state) {
      const data = state.data || {};
      const overrides = data.overrides && typeof data.overrides === "object" ? data.overrides : null;
      const effective = data.effectiveConfig && typeof data.effectiveConfig === "object" ? data.effectiveConfig : {};
      const setCheckbox = (id, value) => {
        const node = el(id);
        if (node) node.checked = Boolean(value);
      };
      const setInput = (id, value) => {
        const node = el(id);
        if (!node) return;
        node.value = value === null || value === undefined ? "" : String(value);
      };

      setCheckbox("ovrEnabled", overrides ? overrides.enabled : true);
      setCheckbox("ovrAllowBuy", overrides ? overrides.allowBuy : true);
      setCheckbox("ovrAllowSell", overrides ? overrides.allowSell : true);
      setCheckbox("ovrTobEnabled", overrides ? overrides.tobEnabled : effective.tobEnabled);

      setInput("ovrLevelsBuy", overrides ? overrides.levelsBuy : effective.levelsBuy);
      setInput("ovrLevelsSell", overrides ? overrides.levelsSell : effective.levelsSell);
      setInput(
        "ovrLevelQuoteSizeUsd",
        overrides ? overrides.levelQuoteSizeUsd : effective.levelQuoteSizeUsd
      );
      setInput("ovrTobQuoteSizeUsd", overrides ? overrides.tobQuoteSizeUsd : effective.tobQuoteSizeUsd);
      setInput(
        "ovrBaseHalfSpreadBps",
        overrides ? overrides.baseHalfSpreadBps : effective.baseHalfSpreadBps
      );
      setInput("ovrLevelStepBps", overrides ? overrides.levelStepBps : effective.levelStepBps);
      setInput(
        "ovrMinMarketSpreadBps",
        overrides ? overrides.minMarketSpreadBps : effective.minMarketSpreadBps
      );
      setInput("ovrRepriceMoveBps", overrides ? overrides.repriceMoveBps : effective.repriceMoveBps);
      setInput(
        "ovrQueueRefreshSeconds",
        overrides ? overrides.queueRefreshSeconds : effective.queueRefreshSeconds
      );
      setInput("ovrCashReserveUsd", overrides ? overrides.cashReserveUsd : effective.cashReserveUsd);
      setInput("ovrWorkingCapUsd", overrides ? overrides.workingCapUsd : effective.workingCapUsd);
      setInput(
        "ovrTargetBtcNotionalUsd",
        overrides ? overrides.targetBtcNotionalUsd : effective.targetBtcNotionalUsd
      );
      setInput(
        "ovrMaxBtcNotionalUsd",
        overrides ? overrides.maxBtcNotionalUsd : effective.maxBtcNotionalUsd
      );
      setInput("ovrSkewMaxBps", overrides ? overrides.skewMaxBps : effective.skewMaxBps);
      setInput("ovrMaxActiveOrders", overrides ? overrides.maxActiveOrders : effective.maxActiveOrders);
      setInput(
        "ovrMaxActionsPerLoop",
        overrides ? overrides.maxActionsPerLoop : effective.maxActionsPerLoop
      );
      setInput("ovrTtlSeconds", overrides ? overrides.ttlSeconds : "");
      const noteInput = el("ovrNote");
      if (noteInput && !noteInput.value && overrides && overrides.note) {
        setInput("ovrNote", overrides.note);
      }

      const effectiveBlock = el("effectiveConfigBlock");
      if (effectiveBlock) {
        effectiveBlock.textContent = JSON.stringify(effective, null, 2);
      }
      const statusNode = el("ovrStatusLine");
      if (statusNode && overrides) {
        const expires = overrides.expiresAtMs ? ts(overrides.expiresAtMs) : "none";
        statusNode.textContent =
          "Updated " +
          ts(overrides.updatedAtMs) +
          " by " +
          String(overrides.source || "dashboard") +
          " | expires " +
          expires;
      } else if (statusNode) {
        statusNode.textContent = "No active overrides";
      }
      renderOverrideDiffBlock();
    }

    function renderOverrideDiffBlock() {
      const body = el("ovrDiffBody");
      const summary = el("ovrDiffSummary");
      const diff = Array.isArray(latestOverrideDiff) ? latestOverrideDiff : [];
      const warnings = Array.isArray(latestOverrideWarnings) ? latestOverrideWarnings : [];
      if (summary) {
        if (diff.length === 0) {
          summary.textContent = "No override diff yet.";
        } else {
          const adjustedCount = diff.filter((row) => Boolean(row.adjusted)).length;
          summary.textContent =
            "Last apply: " +
            String(diff.length) +
            " fields, adjusted " +
            String(adjustedCount) +
            (warnings.length > 0 ? " | warnings: " + warnings.join("; ") : "");
        }
      }
      if (!body) return;
      if (diff.length === 0) {
        body.innerHTML = '<tr><td colspan="4" style="color:#8fa6c1">none</td></tr>';
        return;
      }
      body.innerHTML = diff
        .map((row) => {
          const adjusted = Boolean(row.adjusted);
          const requested = formatOverrideDiffValue(row.requested);
          const applied = formatOverrideDiffValue(row.applied);
          const status = adjusted ? "adjusted" : "ok";
          const rowClass = adjusted ? "ovr-diff-row-adjusted" : "ovr-diff-row-ok";
          const statusClass = adjusted ? "ovr-diff-status-adjusted" : "ovr-diff-status-ok";
          return (
            '<tr class="' + rowClass + '">' +
            "<td>" + escapeHtml(String(row.key || "-")) + "</td>" +
            "<td>" + escapeHtml(requested) + "</td>" +
            "<td>" + escapeHtml(applied) + "</td>" +
            '<td><span class="badge ' + statusClass + '">' + escapeHtml(status) + "</span></td>" +
            "</tr>"
          );
        })
        .join("");
    }

    function formatOverrideDiffValue(value) {
      if (value === null || value === undefined) return "-";
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return "-";
        return Number.isInteger(value) ? String(value) : value.toFixed(4);
      }
      if (typeof value === "boolean") return value ? "true" : "false";
      return String(value);
    }

    function renderRoadmap(state) {
      const data = state.data;
      if (!data) return;
      const analytics = data.analytics || {};
      text(
        "roadmapEdge",
        "Avg edge last 1h: " + money((n(analytics.avgEdgeBps1hBuy, 0) + n(analytics.avgEdgeBps1hSell, 0)) / 2, 2) + " bps (target > 5)"
      );
      text(
        "roadmapFills",
        "Fills/hr: " + String(n(analytics.fillsLast1h, n(analytics.fills1hCount, 0))) + " (target 2-4)"
      );
      text(
        "roadmapCancels",
        "Churn cancels/hr: " + String(n(analytics.cancelsLast1h, 0)) + " (target < 150)"
      );
      text("roadmapPnl", "PnL today: " + money(n(analytics.realizedPnlUsd, 0), 2) + " USD");
    }

    function renderSettingsView(state) {
      const maxUiEvents = el("settingMaxUiEvents");
      if (maxUiEvents && String(maxUiEvents.value) !== String(state.maxUiEvents)) {
        maxUiEvents.value = String(state.maxUiEvents);
      }
      const maxEqPoints = el("settingMaxEquityPoints");
      if (maxEqPoints && String(maxEqPoints.value) !== String(state.maxEquityPoints)) {
        maxEqPoints.value = String(state.maxEquityPoints);
      }
      const sampleMs = el("settingEquitySampleMs");
      if (sampleMs && String(sampleMs.value) !== String(state.equitySampleMs)) {
        sampleMs.value = String(state.equitySampleMs);
      }
      const persistToggle = el("settingPersistEquitySeries");
      if (persistToggle && Boolean(persistToggle.checked) !== Boolean(state.persistEquitySeries)) {
        persistToggle.checked = Boolean(state.persistEquitySeries);
      }
      const eventLimitSelect = el("eventLimitSelect");
      if (eventLimitSelect && String(eventLimitSelect.value) !== String(state.maxUiEvents)) {
        eventLimitSelect.value = String(state.maxUiEvents);
      }
    }

    function render(state) {
      renderDebugStrip(state);
      renderMissionBar(state);
      renderVenueQuotesStrip(state);
      renderIntelSidebar(state);
      renderExecutionCard(state);
      renderWhyNotTrading(state);
      renderPortfolioStrip(state);
      renderNav(state);
      renderViewPanes(state);
      renderRoadmap(state);
      renderKpiCards(state);
      renderRegimeRibbon(state);
      renderPnlPanel(state);
      renderEquityPanel(state);
      renderPrimaryChart(state);
      renderDrawdownMain(state);
      renderFillsCadence(state);
      renderEdgeHistogram(state);
      renderForecast(state);
      renderAutonomy(state);
      renderBalances(state);
      renderOrders(state);
      renderRecentOrders(state);
      renderEvents(state);
      renderOverridesView(state);
      renderDiagnoseView(state);
      renderOptimizeView(state);
      renderAuditView(state);
      renderSettingsView(state);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    createDebugOverlay();

    let store = null;
    try {
      console.log("[revx-ui] boot start", BUILD_ID);
      store = useDashboardState();
      window.__REVX_STORE__ = store;
      store.subscribe(render);

    document.querySelectorAll("#windowToggles .toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const windowKey = btn.getAttribute("data-window");
        if (!windowKey) return;
        store.setWindow(windowKey);
      });
    });

    document.querySelectorAll(".equity-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-equity-mode");
        if (!mode) return;
        store.setEquityMode(mode);
      });
    });

    document.querySelectorAll(".equity-window-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const windowKey = btn.getAttribute("data-equity-window");
        if (!windowKey) return;
        store.setEquityWindow(windowKey);
      });
    });

    document.querySelectorAll(".drawdown-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-dd-mode");
        if (!mode) return;
        store.setDrawdownMode(mode);
      });
    });

    document.querySelectorAll(".primary-chart-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-primary-chart");
        if (!mode) return;
        store.setPrimarySeriesMode(mode);
      });
    });

    document.querySelectorAll(".portfolio-equity-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-equity-mode");
        if (!mode) return;
        store.setEquityMode(mode);
      });
    });

    document.querySelectorAll(".autopilot-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-autopilot");
        if (!mode) return;
        store.setAutopilotMode(mode);
      });
    });

    const resetEquityBtn = el("resetEquityBtn");
    if (resetEquityBtn) {
      resetEquityBtn.addEventListener("click", () => {
        store.resetEquitySeries();
      });
    }

    document.querySelectorAll(".view-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.getAttribute("data-view");
        if (!view) return;
        store.setView(view);
      });
    });

    const navRailToggle = el("navRailToggle");
    if (navRailToggle) {
      navRailToggle.addEventListener("click", () => {
        store.toggleNavCollapsed();
      });
    }

    document.querySelectorAll(".event-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const filter = btn.getAttribute("data-filter");
        if (!filter) return;
        store.setEventFilter(filter);
      });
    });

    document.querySelectorAll(".intel-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-intel-tab");
        if (!tab) return;
        store.setIntelTab(String(tab).toLowerCase());
      });
    });

    document.querySelectorAll("[data-signal-kind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-signal-kind");
        if (!kind) return;
        store.setSignalKindFilter(String(kind).toLowerCase());
      });
    });

    document.querySelectorAll("[data-news-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const category = btn.getAttribute("data-news-cat");
        if (!category) return;
        store.setNewsCategoryFilter(String(category).toLowerCase());
      });
    });

    document.querySelectorAll("[data-news-impact]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const impact = btn.getAttribute("data-news-impact");
        if (!impact) return;
        store.setNewsImpactFilter(String(impact).toLowerCase());
      });
    });

    document.querySelectorAll("[data-order-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-order-view");
        if (!mode) return;
        store.setOrderViewFilter(String(mode).toLowerCase());
      });
    });

    const venueQuotesFilter = el("venueQuotesFilter");
    if (venueQuotesFilter) {
      venueQuotesFilter.addEventListener("change", () => {
        store.setVenueQuotesFilter(String(venueQuotesFilter.value || "all").toLowerCase());
      });
    }

    const eventLimitSelect = el("eventLimitSelect");
    if (eventLimitSelect) {
      eventLimitSelect.value = String(store.getState().maxUiEvents);
      eventLimitSelect.addEventListener("change", () => {
        store.setMaxUiEvents(eventLimitSelect.value);
      });
    }

    const settingMaxUiEvents = el("settingMaxUiEvents");
    if (settingMaxUiEvents) {
      settingMaxUiEvents.value = String(store.getState().maxUiEvents);
      settingMaxUiEvents.addEventListener("change", () => {
        store.setMaxUiEvents(settingMaxUiEvents.value);
      });
    }

    const settingMaxEquityPoints = el("settingMaxEquityPoints");
    if (settingMaxEquityPoints) {
      settingMaxEquityPoints.value = String(store.getState().maxEquityPoints);
      settingMaxEquityPoints.addEventListener("change", () => {
        store.setMaxEquityPoints(settingMaxEquityPoints.value);
      });
    }

    const settingEquitySampleMs = el("settingEquitySampleMs");
    if (settingEquitySampleMs) {
      settingEquitySampleMs.value = String(store.getState().equitySampleMs);
      settingEquitySampleMs.addEventListener("change", () => {
        store.setEquitySampleMs(settingEquitySampleMs.value);
      });
    }

    const settingPersistEquitySeries = el("settingPersistEquitySeries");
    if (settingPersistEquitySeries) {
      settingPersistEquitySeries.checked = Boolean(store.getState().persistEquitySeries);
      settingPersistEquitySeries.addEventListener("change", () => {
        store.setPersistEquitySeries(settingPersistEquitySeries.checked);
      });
    }

    ["optSpread", "optStep", "optLevels", "optQuote", "optSkew", "optTargetFills"].forEach((id) => {
      const node = el(id);
      if (!node) return;
      node.addEventListener("input", () => {
        renderOptimizeView(store.getState());
      });
    });

    let showingGate = "";
    document.querySelectorAll(".gate-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-gate") || "";
        const state = store.getState();
        const data = state.data;
        const detailsNode = el("gateDetails");
        if (!data || !detailsNode) return;
        const bot = data.botStatus || {};
        const details = key === "buy" ? (bot.buy_reasons || []) : (bot.sell_reasons || []);

        if (showingGate === key) {
          showingGate = "";
          detailsNode.style.display = "none";
          detailsNode.textContent = "";
          return;
        }

        showingGate = key;
        detailsNode.style.display = "block";
        detailsNode.textContent = (details && details.length > 0) ? details.join("; ") : "No reason details available";
      });
    });

    async function doCancelAll() {
      await store.action("/api/action/cancel-all", {});
    }

    async function doPauseToggle() {
      const state = store.getState();
      const data = state.data || {};
      const mode = data.mode || {};
      const symbol = String(data.symbol || "BTC-USD");
      await store.action("/api/action/pause", {
        symbol,
        paused: !Boolean(mode.paused)
      });
    }

    async function doKillSwitch() {
      const state = store.getState();
      const data = state.data || {};
      const symbol = String(data.symbol || "BTC-USD");
      await store.action("/api/action/kill", {
        symbol
      });
    }

    function readOverridePatchFromInputs() {
      const readNum = (id) => {
        const node = el(id);
        if (!node) return undefined;
        if (String(node.value).trim().length === 0) return undefined;
        const value = Number(node.value);
        return Number.isFinite(value) ? value : undefined;
      };
      const readBool = (id) => {
        const node = el(id);
        if (!node) return undefined;
        return Boolean(node.checked);
      };
      const patch = {};
      patch.enabled = readBool("ovrEnabled");
      patch.allowBuy = readBool("ovrAllowBuy");
      patch.allowSell = readBool("ovrAllowSell");
      patch.tobEnabled = readBool("ovrTobEnabled");
      patch.levelsBuy = readNum("ovrLevelsBuy");
      patch.levelsSell = readNum("ovrLevelsSell");
      patch.levelQuoteSizeUsd = readNum("ovrLevelQuoteSizeUsd");
      patch.tobQuoteSizeUsd = readNum("ovrTobQuoteSizeUsd");
      patch.baseHalfSpreadBps = readNum("ovrBaseHalfSpreadBps");
      patch.levelStepBps = readNum("ovrLevelStepBps");
      patch.minMarketSpreadBps = readNum("ovrMinMarketSpreadBps");
      patch.repriceMoveBps = readNum("ovrRepriceMoveBps");
      patch.queueRefreshSeconds = readNum("ovrQueueRefreshSeconds");
      patch.cashReserveUsd = readNum("ovrCashReserveUsd");
      patch.workingCapUsd = readNum("ovrWorkingCapUsd");
      patch.targetBtcNotionalUsd = readNum("ovrTargetBtcNotionalUsd");
      patch.maxBtcNotionalUsd = readNum("ovrMaxBtcNotionalUsd");
      patch.skewMaxBps = readNum("ovrSkewMaxBps");
      patch.maxActiveOrders = readNum("ovrMaxActiveOrders");
      patch.maxActionsPerLoop = readNum("ovrMaxActionsPerLoop");
      patch.ttlSeconds = readNum("ovrTtlSeconds");
      const cleaned = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || Number.isNaN(value)) continue;
        cleaned[key] = value;
      }
      return cleaned;
    }

    async function applyOverridesPatch() {
      const state = store.getState();
      const data = state.data || {};
      const symbol = data.symbol || "BTC-USD";
      const patch = readOverridePatchFromInputs();
      const noteNode = el("ovrNote");
      const note = noteNode ? String(noteNode.value || "").slice(0, 160) : "";
      if (Object.keys(patch).length === 0) {
        text("ovrStatusLine", "No valid override fields to apply.");
        return;
      }
      const response = await store.action("/api/overrides/set", { symbol, patch, note });
      latestOverrideDiff = Array.isArray(response && response.appliedDiff) ? response.appliedDiff : [];
      latestOverrideWarnings = Array.isArray(response && response.warnings) ? response.warnings : [];
      renderOverrideDiffBlock();
      const adjusted = latestOverrideDiff.filter((row) => Boolean(row && row.adjusted)).length;
      text(
        "ovrStatusLine",
        "Override patch applied (" +
          String(latestOverrideDiff.length) +
          " fields, " +
          String(adjusted) +
          " adjusted)."
      );
    }

    async function clearOverrides() {
      const state = store.getState();
      const data = state.data || {};
      const symbol = data.symbol || "BTC-USD";
      await store.action("/api/overrides/clear", { symbol });
      latestOverrideDiff = [];
      latestOverrideWarnings = [];
      renderOverrideDiffBlock();
      text("ovrStatusLine", "Overrides cleared.");
    }

    function openDecisionModal(index) {
      const state = store.getState();
      const history = Array.isArray(state.decisionHistory) ? state.decisionHistory : [];
      const entry = history[n(index, -1)];
      if (!entry) return;
      const modal = el("decisionModal");
      const meta = el("decisionModalMeta");
      const json = el("decisionJson");
      if (meta) {
        meta.textContent =
          ts(entry.ts) +
          " | mid " +
          money(entry.mid, 2) +
          " | spread " +
          money(entry.spreadBps, 2) +
          "bps | regime " +
          String(entry.signalVolRegime || "normal");
      }
      if (json) {
        json.textContent = JSON.stringify(entry, null, 2);
      }
      if (modal) modal.style.display = "flex";
    }

    function closeDecisionModal() {
      const modal = el("decisionModal");
      if (modal) modal.style.display = "none";
    }

    function exportAuditReport() {
      const state = store.getState();
      const data = state.data || {};
      const payload = {
        exportedAt: new Date().toISOString(),
        status: data,
        decisionHistory: (state.decisionHistory || []).slice(-1000),
        recentFills: Array.isArray(data.recentFills) ? data.recentFills : [],
        recentEvents: (state.uiEvents || []).slice(0, state.maxUiEvents),
        uiSettings: {
          pnlWindow: state.pnlWindow,
          equityMode: state.equityMode,
          equityWindow: state.equityWindow,
          drawdownMode: state.drawdownMode,
          maxUiEvents: state.maxUiEvents,
          maxEquityPoints: state.maxEquityPoints,
          equitySampleMs: state.equitySampleMs,
          persistEquitySeries: state.persistEquitySeries,
          chartMode: state.chartMode,
          autopilotMode: state.autopilotMode
        }
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "revx-audit-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    const modal = el("confirmModal");
    const openModal = () => { if (modal) modal.style.display = "flex"; };
    const closeModal = () => { if (modal) modal.style.display = "none"; };

    const cancelBtn = el("cancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", openModal);

    const pauseBtn = el("pauseBtn");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", async () => {
        try {
          await doPauseToggle();
        } catch (err) {
          alert("Pause action failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    const killBtn = el("killBtn");
    if (killBtn) {
      killBtn.addEventListener("click", async () => {
        if (!window.confirm("Kill quoting and cancel all bot orders?")) return;
        try {
          await doKillSwitch();
        } catch (err) {
          alert("Kill action failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    const modalCancel = el("modalCancel");
    if (modalCancel) modalCancel.addEventListener("click", closeModal);

    const modalConfirm = el("modalConfirm");
    if (modalConfirm) {
      modalConfirm.addEventListener("click", async () => {
        closeModal();
        try {
          await doCancelAll();
        } catch (err) {
          alert("Cancel-all failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    const ovrApplyBtn = el("ovrApplyBtn");
    if (ovrApplyBtn) {
      ovrApplyBtn.addEventListener("click", async () => {
        try {
          await applyOverridesPatch();
        } catch (err) {
          alert("Apply overrides failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    const ovrClearBtn = el("ovrClearBtn");
    if (ovrClearBtn) {
      ovrClearBtn.addEventListener("click", async () => {
        try {
          await clearOverrides();
        } catch (err) {
          alert("Clear overrides failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    const clearOverridesStripBtn = el("clearOverridesStripBtn");
    if (clearOverridesStripBtn) {
      clearOverridesStripBtn.addEventListener("click", async () => {
        try {
          await clearOverrides();
        } catch (err) {
          alert("Clear overrides failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    document.addEventListener("click", (evt) => {
      const target = evt.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches(".copy-btn")) {
        const value = target.getAttribute("data-copy") || "";
        if (!value || value === "-") return;
        navigator.clipboard.writeText(value).catch(() => {});
        return;
      }
      if (target.matches("[data-view-decision]")) {
        const idx = target.getAttribute("data-view-decision");
        openDecisionModal(n(idx, -1));
      }
    });

    const decisionModalClose = el("decisionModalClose");
    if (decisionModalClose) {
      decisionModalClose.addEventListener("click", () => {
        closeDecisionModal();
      });
    }

    const exportReportBtn = el("exportReportBtn");
    if (exportReportBtn) {
      exportReportBtn.addEventListener("click", () => {
        exportAuditReport();
      });
    }

    document.addEventListener("keydown", (evt) => {
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
      const tag = (evt.target && evt.target.tagName ? String(evt.target.tagName) : "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (evt.key === "c" || evt.key === "C") {
        evt.preventDefault();
        openModal();
      }

      if (evt.key === "p" || evt.key === "P") {
        evt.preventDefault();
        void doPauseToggle().catch((err) => {
          alert("Pause action failed: " + String(err && err.message ? err.message : err));
        });
      }

      if (evt.key === "k" || evt.key === "K") {
        evt.preventDefault();
        if (window.confirm("Kill quoting and cancel all bot orders?")) {
          void doKillSwitch().catch((err) => {
            alert("Kill action failed: " + String(err && err.message ? err.message : err));
          });
        }
      }

      if (evt.key === "Escape") {
        closeModal();
        closeDecisionModal();
      }
    });

      setTimeout(() => {
        try {
          void store.refresh();
        } catch (e) {
          window.__REVX_BOOT_ERR__ = String((e && e.message) || e || "");
        }
      }, 0);
      setInterval(() => {
        try {
          void store.refresh();
        } catch (e) {
          window.__REVX_BOOT_ERR__ = String((e && e.message) || e || "");
        }
      }, 2000);
      console.log("[revx-ui] boot ok", BUILD_ID);
    } catch (e) {
      window.__REVX_BOOT_ERR__ = String((e && e.message) || e || "");
      console.error("[revx-ui] boot failed", e);
    }
`;
  if (js.includes('+\n"') || js.includes('+"\n')) {
    throw new Error("Generated JS contains raw newline inside string; escape with \\n");
  }
  return js;
}

function sanitizeJsForHtmlScript(source: string): string {
  return String(source)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/\u2028|\u2029/g, "\n");
}

function escapeInlineHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildReconciledActiveOrders(args: {
  orders: Array<Record<string, unknown>>;
  reconcileSnapshot: {
    lastReconcileTs: number;
    venueOpenKeys: string[];
  };
  nowTs: number;
  venueSnapshotReady: boolean;
  pendingStaleSeconds: number;
  maxRows: number;
}): {
  openOrders: DashboardActiveOrder[];
  allTrackedOrders: DashboardActiveOrder[];
  summary: {
    openVenue: number;
    pendingLocal: number;
    terminal: number;
    totalTracked: number;
    byStatus: Record<string, number>;
  };
} {
  const nowTs = Math.max(0, Math.floor(Number(args.nowTs) || Date.now()));
  const lastReconcileTs = Math.max(0, Math.floor(Number(args.reconcileSnapshot.lastReconcileTs) || 0));
  const pendingStaleMs = Math.max(5_000, Math.floor(Number(args.pendingStaleSeconds) || 30) * 1000);
  const maxRows = Math.max(20, Math.floor(Number(args.maxRows) || 500));
  const venueOpenKeySet = new Set(
    (Array.isArray(args.reconcileSnapshot.venueOpenKeys) ? args.reconcileSnapshot.venueOpenKeys : [])
      .map((row) => String(row || "").trim())
      .filter((row) => row.length > 0)
  );

  const deduped = new Map<string, Record<string, unknown>>();
  for (const row of Array.isArray(args.orders) ? args.orders : []) {
    if (!row || typeof row !== "object") continue;
    const key = orderLifecycleKeyFromAny(row);
    if (!key) continue;
    const existing = deduped.get(key);
    const currentUpdated = normalizeOrderTs((row as { updated_at?: unknown; updatedAt?: unknown }).updated_at ?? (row as { updatedAt?: unknown }).updatedAt, 0);
    const existingUpdated = existing
      ? normalizeOrderTs((existing as { updated_at?: unknown; updatedAt?: unknown }).updated_at ?? (existing as { updatedAt?: unknown }).updatedAt, 0)
      : -1;
    if (!existing || currentUpdated >= existingUpdated) {
      deduped.set(key, row);
    }
  }

  const byStatus: Record<string, number> = {};
  const rows: DashboardActiveOrder[] = [];
  let openVenue = 0;
  let pendingLocal = 0;
  let terminal = 0;

  for (const raw of deduped.values()) {
    const clientOrderId = String(
      (raw as { client_order_id?: unknown; clientOrderId?: unknown }).client_order_id ??
        (raw as { clientOrderId?: unknown }).clientOrderId ??
        ""
    ).trim();
    const venueOrderIdValue =
      (raw as { venue_order_id?: unknown; venueOrderId?: unknown }).venue_order_id ??
      (raw as { venueOrderId?: unknown }).venueOrderId;
    const venueOrderId = venueOrderIdValue ? String(venueOrderIdValue).trim() : null;
    const status = String((raw as { status?: unknown }).status ?? "").trim().toUpperCase();
    const createdTs = normalizeOrderTs(
      (raw as { created_at?: unknown; createdTs?: unknown }).created_at ?? (raw as { createdTs?: unknown }).createdTs,
      nowTs
    );
    const updatedTs = normalizeOrderTs(
      (raw as { updated_at?: unknown; updatedTs?: unknown }).updated_at ?? (raw as { updatedTs?: unknown }).updatedTs,
      createdTs
    );
    const isPending = isOrderStatusPendingLike(status);
    const isTerminalStatus = isOrderStatusTerminal(status);
    const venueOpen = isOrderOpenInKeySet(clientOrderId, venueOrderId, venueOpenKeySet);
    const hasVenueOrderId = Boolean(venueOrderId && venueOrderId.length > 0);
    const activeLike = isOrderStatusActiveLike(status);
    const optimisticOpen = hasVenueOrderId && activeLike;
    const normalizedQuoteSize = normalizeOrderNumber(
      (raw as { quote_size?: unknown; quoteSize?: unknown; quote_size_usd?: unknown; quoteSizeUsd?: unknown }).quote_size ??
        (raw as { quoteSize?: unknown }).quoteSize ??
        (raw as { quote_size_usd?: unknown }).quote_size_usd ??
        (raw as { quoteSizeUsd?: unknown }).quoteSizeUsd,
      0
    );
    const ageSeconds = Math.max(0, Math.floor((nowTs - createdTs) / 1000));

    let lifecycleState: OrderLifecycleState = "TERMINAL";
    let staleReason: string | undefined;
    if (venueOpen || optimisticOpen) {
      lifecycleState = "OPEN_VENUE";
      openVenue += 1;
      if (!venueOpen) {
        staleReason = "awaiting_venue_poll";
      }
    } else if (!hasVenueOrderId && !args.venueSnapshotReady && activeLike) {
      lifecycleState = "PENDING_LOCAL";
      pendingLocal += 1;
      staleReason = "awaiting_reconcile";
    } else if (!hasVenueOrderId && isPending) {
      lifecycleState = "PENDING_LOCAL";
      pendingLocal += 1;
      if (nowTs - createdTs >= pendingStaleMs) {
        staleReason = "submit_stale";
      }
    } else if (!isTerminalStatus && activeLike) {
      lifecycleState = "TERMINAL";
      terminal += 1;
      staleReason = "not_seen_on_venue";
    } else {
      terminal += 1;
    }

    if (status) {
      byStatus[status] = (byStatus[status] || 0) + 1;
    }

    const isLifecycleOpen = lifecycleState === "OPEN_VENUE";
    const rowIsPending = lifecycleState === "PENDING_LOCAL";
    const lastSeenVenueTs = isLifecycleOpen ? (venueOpen ? lastReconcileTs : Math.max(updatedTs, createdTs)) : 0;

    rows.push({
      clientOrderId,
      venueOrderId,
      side: String((raw as { side?: unknown }).side ?? "").toUpperCase() || "-",
      price: normalizeOrderNumber((raw as { price?: unknown }).price, 0),
      quoteSize: normalizedQuoteSize,
      status: status || "UNKNOWN",
      createdTs,
      updatedTs,
      lifecycleState,
      isVenueOpen: isLifecycleOpen,
      isPending: rowIsPending,
      ageSeconds,
      reconcile: {
        lastSeenVenueTs,
        lastReconcileTs,
        staleReason
      },
      client_order_id: clientOrderId,
      venue_order_id: venueOrderId,
      quote_size: normalizedQuoteSize,
      quote_size_usd: normalizedQuoteSize,
      quoteSizeUsd: normalizedQuoteSize,
      created_at: createdTs,
      updated_at: updatedTs,
      bot_tag: ((raw as { bot_tag?: unknown }).bot_tag as string | null | undefined) ?? null,
      symbol: String((raw as { symbol?: unknown }).symbol ?? ""),
      is_bot: normalizeOrderNumber((raw as { is_bot?: unknown }).is_bot, 0)
    });
  }

  const sorted = rows.sort((a, b) => b.updatedTs - a.updatedTs);
  const openOrders = sorted.filter((row) => row.lifecycleState === "OPEN_VENUE").slice(0, maxRows);
  const allTrackedOrders = sorted
    .filter((row) => row.lifecycleState === "OPEN_VENUE" || row.lifecycleState === "PENDING_LOCAL")
    .slice(0, maxRows);
  return {
    openOrders,
    allTrackedOrders,
    summary: {
      openVenue,
      pendingLocal,
      terminal,
      totalTracked: allTrackedOrders.length,
      byStatus
    }
  };
}

function normalizeOrderNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOrderTs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(0, Math.floor(fallback));
  if (parsed < 10_000_000_000) return Math.floor(parsed * 1000);
  return Math.floor(parsed);
}

function isOrderStatusPendingLike(status: string): boolean {
  const normalized = String(status || "").trim().toUpperCase();
  return ["PENDING", "PENDING_NEW", "ACCEPTED", "SUBMITTING", "NEW"].includes(normalized);
}

function isOrderStatusActiveLike(status: string): boolean {
  const normalized = String(status || "").trim().toUpperCase();
  return [
    "NEW",
    "OPEN",
    "PARTIALLY_FILLED",
    "PARTIAL_FILLED",
    "PENDING",
    "PENDING_NEW",
    "ACCEPTED",
    "SUBMITTING"
  ].includes(normalized);
}

function isOrderStatusTerminal(status: string): boolean {
  const normalized = String(status || "").trim().toUpperCase();
  return [
    "FILLED",
    "CANCELLED",
    "CANCELLED_DRY_RUN",
    "FAILED",
    "REJECTED",
    "EXPIRED",
    "INACTIVE",
    "INACTIVE_DUPLICATE",
    "INACTIVE_RECONCILE"
  ].includes(normalized);
}

function orderLifecycleKeyFromAny(order: Record<string, unknown>): string {
  const venueOrderId = String(order.venue_order_id ?? order.venueOrderId ?? "").trim();
  if (venueOrderId.length > 0) return `venue:${venueOrderId}`;
  const clientOrderId = String(order.client_order_id ?? order.clientOrderId ?? "").trim();
  if (clientOrderId.length > 0) return `client:${clientOrderId}`;
  return "";
}

function isOrderOpenInKeySet(
  clientOrderId: string,
  venueOrderId: string | null,
  openKeys: Set<string>
): boolean {
  if (venueOrderId && openKeys.has(`venue:${venueOrderId}`)) return true;
  if (clientOrderId && openKeys.has(`client:${clientOrderId}`)) return true;
  return false;
}
