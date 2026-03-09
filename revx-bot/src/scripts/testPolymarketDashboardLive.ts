import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { loadConfig } from "../config";
import { PaperLedger } from "../polymarket/paper/PaperLedger";
import { DashboardServer } from "../web/DashboardServer";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function makeElement(): Record<string, any> {
  return {
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    title: "",
    className: "",
    style: {
      display: "",
      setProperty: () => undefined
    },
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => false,
      contains: () => false
    },
    setAttribute: () => undefined,
    getAttribute: () => "",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    querySelectorAll: () => []
  };
}

function countRows(html: string): number {
  const matches = String(html || "").match(/<tr>/g);
  return matches ? matches.length : 0;
}

function buildStubLogger(): any {
  const logger: Record<string, any> = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined
  };
  logger.child = () => logger;
  return logger;
}

function run(): void {
  process.env.DRY_RUN = "true";
  process.env.POLYMARKET_ENABLED = "true";
  process.env.POLYMARKET_MODE = "paper";
  process.env.DASHBOARD_ENABLED = "true";
  process.env.DASHBOARD_PORT = "0";

  const rootDir = mkdtempSync(path.join(tmpdir(), "revx-poly-dashboard-live-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    const baseNow = Date.now();
    mkdirSync(path.join(rootDir, "data"), { recursive: true });
    mkdirSync(path.join(rootDir, "logs"), { recursive: true });
    const ledgerPath = path.join(rootDir, "data", "polymarket-paper-ledger.jsonl");
    const ledger = new PaperLedger(ledgerPath);

    const openTrade = ledger.recordTrade({
      marketId: "m-open",
      marketSlug: "btc-updown-5m-open",
      windowStartTs: baseNow - 59_000,
      windowEndTs: baseNow + 241_000,
      side: "NO",
      entryPrice: 0.44,
      qty: 5,
      notionalUsd: 2.2,
      feeBps: 0,
      slippageBps: 0,
      feesUsd: 0,
      entryCostUsd: 2.2,
      priceToBeat: 100,
      yesTokenId: "yes-open",
      noTokenId: "no-open",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      heldTokenId: "no-open",
      createdTs: baseNow - 40_000
    });
    const resolvedWin = ledger.recordTrade({
      marketId: "m-resolved-win",
      marketSlug: "btc-updown-5m-resolved-win",
      windowStartTs: baseNow - 180_000,
      windowEndTs: baseNow - 120_000,
      side: "YES",
      entryPrice: 0.4,
      qty: 10,
      notionalUsd: 4,
      feeBps: 0,
      slippageBps: 0,
      feesUsd: 0,
      entryCostUsd: 4,
      priceToBeat: 100,
      yesTokenId: "yes-win",
      noTokenId: "no-win",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      heldTokenId: "yes-win",
      createdTs: baseNow - 170_000
    });
    ledger.resolveTrade({
      tradeId: resolvedWin.id,
      resolvedAt: baseNow - 140_000,
      outcome: "UP",
      payoutUsd: 10,
      pnlUsd: 6,
      winningTokenId: "yes-win",
      resolutionSource: "OFFICIAL"
    });
    const exitedEarly = ledger.recordTrade({
      marketId: "m-exit",
      marketSlug: "btc-updown-5m-exit",
      windowStartTs: baseNow - 150_000,
      windowEndTs: baseNow - 90_000,
      side: "NO",
      entryPrice: 0.48,
      qty: 4,
      notionalUsd: 1.92,
      feeBps: 0,
      slippageBps: 0,
      feesUsd: 0,
      entryCostUsd: 1.92,
      priceToBeat: 100,
      yesTokenId: "yes-exit",
      noTokenId: "no-exit",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      heldTokenId: "no-exit",
      createdTs: baseNow - 145_000
    });
    ledger.closeTrade({
      tradeId: exitedEarly.id,
      resolvedAt: baseNow - 110_000,
      closeReason: "TAKE_PROFIT",
      exitPrice: 0.65,
      exitProceedsUsd: 2.6,
      exitFeesUsd: 0,
      pnlUsd: 0.68
    });
    const voidTrade = ledger.recordTrade({
      marketId: "m-void",
      marketSlug: "btc-updown-5m-void",
      windowStartTs: baseNow - 120_000,
      windowEndTs: baseNow - 60_000,
      side: "YES",
      entryPrice: 0.51,
      qty: 2,
      notionalUsd: 1.02,
      feeBps: 0,
      slippageBps: 0,
      feesUsd: 0,
      entryCostUsd: 1.02,
      priceToBeat: 100,
      yesTokenId: "yes-void",
      noTokenId: "no-void",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      heldTokenId: "yes-void",
      createdTs: baseNow - 115_000
    });
    ledger.cancelTrade({
      tradeId: voidTrade.id,
      resolvedAt: baseNow - 80_000,
      cancelReason: "MARKET_CANCELLED",
      status: "VOID",
      payoutUsd: 1.02,
      pnlUsd: 0,
      resolutionSource: "OFFICIAL"
    });

    const base = loadConfig();
    const config = {
      ...base,
      dashboardEnabled: true,
      dashboardPort: 0,
      polymarket: {
        ...base.polymarket,
        enabled: true,
        mode: "paper" as const,
        paper: {
          ...base.polymarket.paper,
          ledgerPath: "data/polymarket-paper-ledger.jsonl"
        }
      }
    };
    const logger = buildStubLogger();
    const runtimeProvider = {
      getDashboardSnapshot: () => ({
        latestPolymarket: {
          ts: baseNow,
          windowSlug: "btc-updown-5m-live",
          tauSec: 244,
          priceToBeat: 100,
          fastMid: 99.5,
          yesMid: 0.37,
          impliedProbMid: 0.37
        },
        latestModel: {
          ts: baseNow,
          pBase: 0.34,
          pBoosted: 0.31,
          z: -1.2,
          d: -45,
          sigma: 0.11,
          tauSec: 244,
          polyUpdateAgeMs: 210,
          lagPolyP90Ms: 450,
          oracleAgeMs: 180,
          boostApplied: false,
          boostReason: null
        },
        latestLag: {
          samples: 3,
          lastFastMidTsMs: baseNow,
          lastOracleTsMs: baseNow,
          lastBookTsMs: baseNow,
          lastYesMid: 0.37,
          metrics: {
            polyUpdateAgeMs: { count: 3, mean: 210, p50: 210, p90: 260 },
            oracleAgeMs: { count: 3, mean: 180, p50: 180, p90: 220 },
            bookMoveLagMs: { count: 3, mean: 330, p50: 300, p90: 420 }
          }
        },
        sniperWindow: {
          minRemainingSec: 45,
          maxRemainingSec: 285
        },
        tradingPaused: false,
        pauseReason: null,
        warningState: null,
        mode: "paper" as const,
        polyMoney: false,
        lastAction: "OPEN" as const,
        holdReason: null,
        blockedBy: null,
        selectedTokenId: "market-live-no",
        selectedBookable: true,
        selectedTradable: true,
        selectionSource: "current_slug",
        liveValidationReason: "tradable_current_slug",
        lastBookTs: baseNow - 1_500,
        lastQuoteTs: baseNow - 1_000,
        lastActionTs: baseNow,
        serverNowTs: baseNow,
        selection: {
          finalCandidatesCount: 1,
          discoveredCandidatesCount: 1,
          windowsCount: 1,
          selectedSlug: "btc-updown-5m-live",
          selectedMarketId: "market-live",
          windowStartTs: baseNow - 56_000,
          windowEndTs: baseNow + 244_000,
          remainingSec: 244,
          chosenSide: "NO",
          chosenDirection: "DOWN",
          entriesInWindow: 2,
          realizedPnlUsd: 0.68,
          resolutionSource: "PAPER_EXIT",
          lifecycleStatus: "OPEN"
        },
        dataHealth: {
          oracleSource: "internal_fair_mid",
          oracleState: "OK",
          latestPolymarketTs: baseNow,
          latestModelTs: baseNow,
          lastFetchAttemptTs: baseNow,
          lastFetchOkTs: baseNow,
          lastFetchErr: null,
          lastHttpStatus: 200,
          lastBookTsMs: baseNow,
          lastYesBid: 0.36,
          lastYesAsk: 0.38,
          lastYesMid: 0.37,
          lastModelTs: baseNow
        },
        state: {
          holdDetailReason: null,
          dominantReject: null,
          rejectCountsByStage: {
            active: {},
            search: {},
            window: {},
            pattern: {},
            scoring: {},
            dataHealth: {}
          },
          sampleRejected: []
        },
        lastTrade: {
          id: openTrade.id,
          slug: openTrade.marketSlug || null,
          ts: openTrade.createdTs
        },
        openTrade: {
          tradeId: openTrade.id,
          marketId: openTrade.marketId,
          marketSlug: openTrade.marketSlug || null,
          windowStartTs: baseNow - 56_000,
          windowEndTs: baseNow + 244_000,
          side: "NO" as const,
          direction: "DOWN",
          heldTokenId: openTrade.heldTokenId || null,
          strikePrice: 100,
          btcStartPrice: 100.2,
          entryBtcReferencePrice: 100.2,
          btcReferencePrice: 68123.45,
          btcReferenceTs: baseNow - 300,
          btcReferenceAgeMs: 300,
          btcReferenceStale: false,
          contractEntryPrice: openTrade.entryPrice,
          contractLivePrice: 0.62,
          impliedProbPct: 62,
          bestBid: 0.61,
          bestAsk: 0.63,
          livePrice: 0.62,
          markSource: "MID",
          markTs: baseNow - 1_500,
          markAgeMs: 1_500,
          markStale: false,
          isStale: false,
          qty: openTrade.qty,
          shares: openTrade.qty,
          entryPrice: openTrade.entryPrice,
          entryNotionalUsd: openTrade.entryCostUsd,
          feesUsd: openTrade.feesUsd,
          markValueUsd: openTrade.qty * 0.62,
          unrealizedPnlUsd: openTrade.qty * 0.62 - openTrade.entryCostUsd - openTrade.feesUsd
        },
        polyEngineRunning: true,
        lastUpdateTs: baseNow,
        lastUpdateAgeSec: 0,
        status: "RUNNING" as const
      }),
      getLagSnapshot: () => ({
        stats: {
          samples: 3,
          lastFastMidTsMs: baseNow,
          lastOracleTsMs: baseNow,
          lastBookTsMs: baseNow,
          lastYesMid: 0.37,
          metrics: {
            polyUpdateAgeMs: { count: 3, mean: 210, p50: 210, p90: 260 },
            oracleAgeMs: { count: 3, mean: 180, p50: 180, p90: 220 },
            bookMoveLagMs: { count: 3, mean: 330, p50: 300, p90: 420 }
          }
        },
        recent: []
      })
    };

    const server = new DashboardServer(
      config,
      logger,
      {} as any,
      "poly-live-test",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtimeProvider
    );

    const payload = (server as any).buildPolymarketDashboardPayload(50);
    assert(String(payload.mechanism || "") === "SSE", "dashboard payload should advertise SSE");
    assert(Number(payload.serverNowTs || 0) > 0, "dashboard payload should expose serverNowTs");
    assert(Number(payload.summary?.windowEndTs || 0) > Number(payload.serverNowTs || 0), "summary should expose an active windowEndTs");
    assert(Number(payload.summary?.windowStartTs || 0) > 0, "summary should expose windowStartTs");
    assert(String(payload.summary?.lifecycleStatus || "") === "OPEN", "summary should expose lifecycleStatus");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "pollMode"), "summary should expose pollMode field");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "holdCategory"), "summary should expose holdCategory field");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "selectedTokenId"), "summary should expose selectedTokenId field");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "selectedBookable"), "summary should expose selectedBookable field");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "selectedTradable"), "summary should expose selectedTradable field");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "liveValidationReason"), "summary should expose liveValidationReason field");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "lastBookTs"), "summary should expose lastBookTs field");
    assert(Object.prototype.hasOwnProperty.call(payload.summary || {}, "lastQuoteTs"), "summary should expose lastQuoteTs field");
    assert(Number(payload.summary?.lastActionTs || 0) > 0, "summary should expose lastActionTs");
    assert(Number(payload.summary?.openTrade?.livePrice || 0) === 0.62, "summary should expose open trade livePrice");
    assert(Number(payload.summary?.openTrade?.contractLivePrice || 0) === 0.62, "summary should expose contractLivePrice");
    assert(Number(payload.summary?.openTrade?.strikePrice || 0) === 100, "summary should expose strikePrice");
    assert(Number(payload.summary?.openTrade?.btcStartPrice || 0) === 100.2, "summary should expose btcStartPrice");
    assert(Number(payload.summary?.openTrade?.btcReferencePrice || 0) === 68123.45, "summary should expose btcReferencePrice");
    assert(Number(payload.summary?.openTrade?.impliedProbPct || 0) === 62, "summary should expose impliedProbPct");
    assert(Number(payload.summary?.openTrade?.unrealizedPnlUsd || 0) > 0, "summary should expose open trade unrealized PnL");
    assert(Array.isArray(payload.openTrades) && payload.openTrades.length === 1, "expected one open trade row");
    assert(Array.isArray(payload.recentTrades) && payload.recentTrades.length === 3, "recent trades should merge resolved, exited, and void rows");
    assert(
      String(payload.recentTrades[0].marketSlug || "") === "btc-updown-5m-void",
      "recent trades should be newest first"
    );
    assert(Array.isArray(payload.equityPoints), "equity points should be an array");
    assert(String(payload.activityEvent?.action || "") === "OPEN", "dashboard payload should expose activityEvent action");
    if (payload.equityPoints.length > 1) {
      assert(
        Math.abs(Number(payload.equityPoints[1].equityUsd || 0) - 6.68) < 1e-9,
        "equity curve should accumulate exited-early pnl"
      );
    }

    const streamReq = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
    streamReq.method = "GET";
    streamReq.url = "/api/polymarket/stream";
    streamReq.headers = { host: "localhost" };
    const streamWrites: string[] = [];
    const streamRes = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      setHeader: (name: string, value: string) => void;
      write: (chunk: string) => void;
      end: () => void;
    };
    streamRes.statusCode = 0;
    streamRes.headers = {};
    streamRes.setHeader = (name: string, value: string): void => {
      streamRes.headers[name.toLowerCase()] = value;
    };
    streamRes.write = (chunk: string): void => {
      streamWrites.push(String(chunk));
    };
    streamRes.end = (): void => undefined;
    void (server as any).handle(streamReq, streamRes);
    streamReq.emit("close");
    assert(
      String(streamRes.headers["content-type"] || "").includes("text/event-stream"),
      "SSE endpoint should use text/event-stream"
    );
    assert(streamWrites.some((chunk) => chunk.includes("event: snapshot")), "SSE endpoint should emit snapshot events");
    assert(streamWrites.some((chunk) => chunk.includes("event: activity")), "SSE endpoint should emit activity events");

    const htmlSink: { body: string; statusCode: number } = { body: "", statusCode: 0 };
    const htmlRes = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (body?: Buffer | string) => {
        htmlSink.body = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : "";
      }
    };
    void (server as any).handle(
      { method: "GET", url: "/polymarket", headers: { host: "localhost" } },
      htmlRes
    );
    htmlSink.statusCode = htmlRes.statusCode;
    assert(htmlSink.statusCode === 200, `expected /polymarket 200, got ${htmlSink.statusCode}`);
    assert(htmlSink.body.includes('id="pmLiveStrip"'), "polymarket HTML should include live status strip");
    assert(htmlSink.body.includes("BTC Start"), "dashboard should label BTC start explicitly");
    assert(htmlSink.body.includes("BTC Live"), "dashboard should label BTC live explicitly");
    assert(htmlSink.body.includes("Contract Entry"), "dashboard should label contract entry explicitly");
    assert(htmlSink.body.includes("Estimated Live"), "dashboard should label estimated live explicitly");
    assert(htmlSink.body.includes("Entries In Window"), "dashboard should expose entries in window in dedicated fields");
    assert(htmlSink.body.includes("Lifecycle"), "dashboard should expose lifecycle in dedicated fields");
    assert(htmlSink.body.includes("Hold Category"), "dashboard should expose hold category");
    assert(htmlSink.body.includes("Poll Mode"), "dashboard should expose poll mode");
    assert(htmlSink.body.includes("Selected Token"), "dashboard should expose selected token id");
    assert(htmlSink.body.includes("Selected Bookable"), "dashboard should expose selected token bookability");
    assert(htmlSink.body.includes("Selected Tradable"), "dashboard should expose selected token tradability");
    assert(htmlSink.body.includes("Last Book TS"), "dashboard should expose last successful book timestamp");
    assert(htmlSink.body.includes("Last Quote TS"), "dashboard should expose last successful quote timestamp");
    assert(htmlSink.body.includes('id="pmCurrentPanel"'), "polymarket HTML should include current/model details panel");
    assert(!htmlSink.body.includes('id="pmCurrentPanel" open'), "current/model panel should be collapsed by default");
    assert(htmlSink.body.includes('id="pmLagPanel"'), "polymarket HTML should include lag details panel");
    assert(!htmlSink.body.includes("Selected / Candidates"), "dashboard should not render concatenated selected/candidates summary card");
    assert(!htmlSink.body.includes('id="pmSelection"'), "dashboard should not render concatenated selection summary field");
    assert(!htmlSink.body.includes("Awaiting official outcome"), "awaiting official outcome section should be removed");
    assert(!htmlSink.body.includes("Resolution retry queue"), "resolution retry queue should be removed");

    const jsSink: { body: string } = { body: "" };
    const jsRes = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (body?: Buffer | string) => {
        jsSink.body = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : "";
      }
    };
    void (server as any).handle(
      { method: "GET", url: "/polymarket.js", headers: { host: "localhost" } },
      jsRes
    );

    const elements = new Map<string, Record<string, any>>();
    const getElementById = (id: string): Record<string, any> => {
      const existing = elements.get(id);
      if (existing) return existing;
      const next = makeElement();
      elements.set(id, next);
      return next;
    };

    class EventSourceMock {
      static instances: EventSourceMock[] = [];
      readonly url: string;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      private readonly handlers = new Map<string, Array<(event: { data: string }) => void>>();
      constructor(url: string) {
        this.url = url;
        EventSourceMock.instances.push(this);
      }
      addEventListener(name: string, fn: (event: { data: string }) => void): void {
        const list = this.handlers.get(name) || [];
        list.push(fn);
        this.handlers.set(name, list);
      }
      close(): void {}
      emitSnapshot(payloadValue: unknown): void {
        const event = { data: JSON.stringify(payloadValue) };
        const list = this.handlers.get("snapshot") || [];
        for (const fn of list) fn(event);
        if (this.onmessage) this.onmessage(event);
      }
      emitActivity(payloadValue: unknown): void {
        const event = { data: JSON.stringify(payloadValue) };
        const list = this.handlers.get("activity") || [];
        for (const fn of list) fn(event);
      }
    }

    let fakeNow = Number(payload.serverNowTs || baseNow);
    class FakeDate extends Date {
      constructor(value?: string | number | Date) {
        super(value === undefined ? fakeNow : value);
      }
      static now(): number {
        return fakeNow;
      }
    }

    const timerCallbacks: Array<() => void> = [];
    const context: Record<string, unknown> = {
      window: {
        document: {
          getElementById,
          querySelectorAll: () => [],
          addEventListener: () => undefined,
          createElement: () => makeElement()
        },
        __REVX_POLYMARKET_HOOKS__: undefined
      },
      document: {
        getElementById,
        querySelectorAll: () => [],
        addEventListener: () => undefined,
        createElement: () => makeElement()
      },
      console,
      Date: FakeDate,
      Math,
      Number,
      String,
      Boolean,
      Array,
      JSON,
      Promise,
      Intl,
      RegExp,
      URL,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval: (fn: () => void) => {
        timerCallbacks.push(fn);
        return timerCallbacks.length;
      },
      clearInterval: () => undefined,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => payload
      }),
      EventSource: EventSourceMock
    };
    (context.window as any).fetch = context.fetch;
    (context.window as any).EventSource = EventSourceMock;

    vm.createContext(context);
    vm.runInContext(jsSink.body, context, { timeout: 10_000 });
    const hooks = ((context.window as any).__REVX_POLYMARKET_HOOKS__ || {}) as {
      renderPayload?: (value: unknown) => void;
      applyPayload?: (value: unknown) => void;
      handleActivityEvent?: (value: { data: string }) => void;
      getState?: () => Record<string, unknown>;
      handleStreamError?: () => void;
    };
    assert(typeof hooks.renderPayload === "function", "polymarket JS should expose renderPayload hook");
    assert(EventSourceMock.instances.length === 1, "polymarket JS should create one EventSource stream");
    assert(EventSourceMock.instances[0].url === "/api/polymarket/stream", "EventSource should connect to SSE endpoint");

    hooks.renderPayload?.(payload);
    assert(String(getElementById("liveDirection").textContent || "") === "DOWN", "live strip should render current direction");
    assert(String(getElementById("liveDirection").innerHTML || "").includes("trade-signal-good"), "live strip should show a positive direction indicator when DOWN is working");
    assert(String(getElementById("liveOpenTrade").textContent || "") === "YES", "live strip should render open trade state");
    assert(String(getElementById("liveEntriesInWindow").textContent || "") === "2", "live strip should render entries in window");
    assert(String(getElementById("liveLifecycle").textContent || "") === "OPEN", "live strip should render lifecycle");
    assert(String(getElementById("liveBtcStart").textContent || "") === "$100.20", "live strip should render BTC start price");
    assert(String(getElementById("liveBtcReference").textContent || "") === "$99.50", `expected BTC price to render from live BTC feed, got ${String(getElementById("liveBtcReference").textContent || "")}`);
    assert(String(getElementById("liveContractEntry").textContent || "") === "0.4400", `expected contract entry to render separately, got ${String(getElementById("liveContractEntry").textContent || "")}`);
    assert(
      parseFloat(String(getElementById("livePrice").textContent || "").replace(/[^0-9.]/g, "")) > 0.61,
      `expected live estimated price to render above 0.61, got ${String(getElementById("livePrice").textContent || "")}`
    );
    const initialSyntheticDownPrice = parseFloat(String(getElementById("livePrice").textContent || "").replace(/[^0-9.]/g, ""));
    assert(
      parseFloat(String(getElementById("liveImpliedProb").textContent || "").replace(/[^0-9.]/g, "")) > 61,
      `expected implied probability to render from the live estimate, got ${String(getElementById("liveImpliedProb").textContent || "")}`
    );
    assert(
      parseFloat(String(getElementById("liveUnrealizedPnl").textContent || "").replace(/[^0-9.-]/g, "")) > 0.8,
      `expected live unrealized pnl to stay positive, got ${String(getElementById("liveUnrealizedPnl").textContent || "")}`
    );
    assert(String(getElementById("pmBtcStart").textContent || "") === "$100.20", "current panel should render BTC start price");
    assert(String(getElementById("pmEntriesInWindow").textContent || "") === "2", "current panel should render entries in window in dedicated field");
    assert(String(getElementById("pmWindowPnl").textContent || "") === "$0.68", "current panel should render window pnl in dedicated field");
    assert(String(getElementById("pmLifecycle").textContent || "") === "OPEN", "current panel should render lifecycle in dedicated field");
    assert(String(getElementById("pmSelectedTokenId").textContent || "") === "market-live-no", "current panel should render selected token id");
    assert(String(getElementById("pmSelectedBookable").textContent || "") === "YES", "current panel should render selected token bookability");
    assert(String(getElementById("pmSelectedTradable").textContent || "") === "YES", "current panel should render selected token tradability");
    assert(String(getElementById("pmLiveValidationReason").textContent || "") === "tradable_current_slug", "current panel should render live validation reason");
    assert(String(getElementById("openTradesBody").innerHTML || "").includes("$100.20"), "open trades table should render BTC start separately");
    assert(String(getElementById("openTradesBody").innerHTML || "").includes("$99.50"), "open trades table should render BTC live separately");
    assert(String(getElementById("openTradesBody").innerHTML || "").includes("trade-signal-good"), "open trades table should render a positive direction indicator");
    assert(!String(getElementById("openTradesBody").innerHTML || "").includes("cached last good"), "open trades table should hide technical mark-source text");
    assert(String(getElementById("mLastAction").textContent || "") === "OPEN", "dashboard should render current last action");
    assert(!String(getElementById("mSelectedInfo").textContent || "").includes("btc-updown-5m-live"), "removed summary card should stay absent from normal UI");
    const initialRemainingSec = Math.max(
      0,
      Math.floor((Number(payload.summary.windowEndTs || 0) - Number(payload.serverNowTs || baseNow)) / 1000)
    );
    const expectedInitialCountdown =
      String(Math.floor(initialRemainingSec / 60)) + "m " + String(initialRemainingSec % 60).padStart(2, "0") + "s";
    assert(
      String(getElementById("liveRemaining").textContent || "") === expectedInitialCountdown,
      `expected initial live countdown ${expectedInitialCountdown}, got ${String(getElementById("liveRemaining").textContent || "")}`
    );

    fakeNow += 3_000;
    for (const callback of timerCallbacks) callback();
    const nextRemainingSec = Math.max(0, initialRemainingSec - 3);
    const expectedNextCountdown =
      String(Math.floor(nextRemainingSec / 60)) + "m " + String(nextRemainingSec % 60).padStart(2, "0") + "s";
    assert(
      String(getElementById("liveRemaining").textContent || "") === expectedNextCountdown,
      `expected client countdown to tick locally to ${expectedNextCountdown}, got ${String(getElementById("liveRemaining").textContent || "")}`
    );

    const upPayload = JSON.parse(JSON.stringify(payload));
    upPayload.summary.chosenDirection = "UP";
    upPayload.summary.openTrade.direction = "UP";
    upPayload.summary.openTrade.side = "YES";
    upPayload.summary.openTrade.contractEntryPrice = 0.4;
    upPayload.summary.openTrade.entryPrice = 0.4;
    upPayload.summary.openTrade.livePrice = 0.58;
    upPayload.summary.openTrade.contractLivePrice = 0.58;
    upPayload.summary.openTrade.impliedProbPct = 58;
    upPayload.summary.openTrade.qty = 10;
    upPayload.summary.openTrade.shares = 10;
    upPayload.summary.openTrade.entryNotionalUsd = 4;
    upPayload.summary.openTrade.feesUsd = 0.1;
    upPayload.summary.openTrade.strikePrice = 100;
    upPayload.summary.openTrade.btcStartPrice = 100;
    upPayload.summary.openTrade.entryBtcReferencePrice = 100;
    upPayload.summary.latestPolymarket.fastMid = 100.8;
    upPayload.summary.latestPolymarket.ts = Number(payload.serverNowTs || baseNow) + 500;
    upPayload.openTrades[0].direction = "UP";
    upPayload.openTrades[0].side = "YES";
    upPayload.openTrades[0].contractEntryPrice = 0.4;
    upPayload.openTrades[0].entryPrice = 0.4;
    upPayload.openTrades[0].livePrice = 0.58;
    upPayload.openTrades[0].contractLivePrice = 0.58;
    upPayload.openTrades[0].impliedProbPct = 58;
    upPayload.openTrades[0].qty = 10;
    upPayload.openTrades[0].shares = 10;
    upPayload.openTrades[0].entryNotionalUsd = 4;
    upPayload.openTrades[0].feesUsd = 0.1;
    upPayload.openTrades[0].strikePrice = 100;
    upPayload.openTrades[0].btcStartPrice = 100;
    upPayload.openTrades[0].entryBtcReferencePrice = 100;
    upPayload.snapshotVersionTs = Number(payload.serverNowTs || baseNow) + 500;
    upPayload.fingerprint = "up-direction-payload";
    upPayload.serverNowTs = upPayload.snapshotVersionTs;
    upPayload.summary.serverNowTs = upPayload.snapshotVersionTs;
    upPayload.summary.lastActionTs = upPayload.snapshotVersionTs;
    hooks.applyPayload?.(upPayload);
    assert(String(getElementById("liveDirection").textContent || "") === "UP", "live strip should render UP direction when payload selects UP");
    assert(String(getElementById("liveDirection").innerHTML || "").includes("trade-signal-good"), "UP direction should show a positive indicator when BTC is above start");
    assert(
      parseFloat(String(getElementById("livePrice").textContent || "").replace(/[^0-9.]/g, "")) > 0.55,
      `synthetic UP estimate should rise above 0.55 on bullish BTC move, got ${String(getElementById("livePrice").textContent || "")}`
    );

    hooks.applyPayload?.(payload);
    const btcDrivenPayload = JSON.parse(JSON.stringify(payload));
    btcDrivenPayload.summary.latestPolymarket.fastMid = 99.8;
    btcDrivenPayload.summary.latestPolymarket.ts = Number(payload.serverNowTs || baseNow) + 1_000;
    btcDrivenPayload.summary.openTrade.contractLivePrice = 0.62;
    btcDrivenPayload.summary.openTrade.livePrice = 0.62;
    btcDrivenPayload.openTrades[0].contractLivePrice = 0.62;
    btcDrivenPayload.openTrades[0].livePrice = 0.62;
    btcDrivenPayload.snapshotVersionTs = Number(payload.serverNowTs || baseNow) + 1_000;
    btcDrivenPayload.fingerprint = "btc-driven-payload";
    btcDrivenPayload.serverNowTs = btcDrivenPayload.snapshotVersionTs;
    btcDrivenPayload.summary.serverNowTs = btcDrivenPayload.snapshotVersionTs;
    btcDrivenPayload.summary.lastActionTs = btcDrivenPayload.snapshotVersionTs;
    hooks.applyPayload?.(btcDrivenPayload);
    assert(String(getElementById("liveBtcReference").textContent || "") === "$99.80", "BTC-driven payload should update BTC price immediately");
    assert(
      parseFloat(String(getElementById("livePrice").textContent || "").replace(/[^0-9.]/g, "")) < initialSyntheticDownPrice,
      `synthetic DOWN estimate should move lower on a bullish BTC move, got ${String(getElementById("livePrice").textContent || "")}`
    );

    const wrongSidePayload = JSON.parse(JSON.stringify(payload));
    wrongSidePayload.summary.latestPolymarket.fastMid = 100.8;
    wrongSidePayload.summary.latestPolymarket.ts = Number(payload.serverNowTs || baseNow) + 1_500;
    wrongSidePayload.summary.openTrade.btcStartPrice = 100.2;
    wrongSidePayload.summary.openTrade.entryBtcReferencePrice = 100.2;
    wrongSidePayload.openTrades[0].btcStartPrice = 100.2;
    wrongSidePayload.openTrades[0].entryBtcReferencePrice = 100.2;
    wrongSidePayload.snapshotVersionTs = Number(payload.serverNowTs || baseNow) + 1_500;
    wrongSidePayload.fingerprint = "wrong-side-payload";
    wrongSidePayload.serverNowTs = wrongSidePayload.snapshotVersionTs;
    wrongSidePayload.summary.serverNowTs = wrongSidePayload.snapshotVersionTs;
    wrongSidePayload.summary.lastActionTs = wrongSidePayload.snapshotVersionTs;
    hooks.applyPayload?.(wrongSidePayload);
    assert(String(getElementById("liveDirection").innerHTML || "").includes("trade-signal-bad"), "DOWN direction should show a negative indicator when BTC is above start");
    assert(String(getElementById("openTradesBody").innerHTML || "").includes("trade-signal-bad"), "open trades table should render a negative direction indicator");

    hooks.handleActivityEvent?.({
      data: JSON.stringify({
        ts: Number(payload.summary.lastActionTs || payload.serverNowTs || baseNow) + 2_000,
        action: "AWAITING_RESOLUTION",
        lifecycleStatus: "AWAITING_RESOLUTION",
        holdReason: "AWAITING_RESOLUTION",
        selectedSlug: null,
        windowStartTs: null,
        windowEndTs: null,
        chosenDirection: "DOWN",
        entriesInWindow: 2,
        realizedPnlWindowUsd: 0.68,
        resolutionSource: "OFFICIAL"
      })
    });
    assert(String(getElementById("mLastAction").textContent || "") === "AWAITING_RESOLUTION", "activity event should update last action immediately");

    const beforeRowCount = countRows(String(getElementById("recentTradesBody").innerHTML || ""));
    hooks.renderPayload?.(payload);
    const afterRowCount = countRows(String(getElementById("recentTradesBody").innerHTML || ""));
    assert(beforeRowCount === afterRowCount, "re-rendering same payload should not duplicate recent trade rows");

    hooks.handleActivityEvent?.({
      data: JSON.stringify({
        ts: Number(payload.summary.lastActionTs || payload.serverNowTs || baseNow) + 6_000,
        action: "RESOLVE",
        lifecycleStatus: "RESOLVED_WIN",
        holdReason: null,
        selectedSlug: null,
        windowStartTs: null,
        windowEndTs: null,
        chosenDirection: "DOWN",
        entriesInWindow: 2,
        realizedPnlWindowUsd: 0.68,
        resolutionSource: "OFFICIAL"
      })
    });
    assert(String(getElementById("mLastAction").textContent || "") === "RESOLVE", "activity update should replace current last action");

    const stalePayload = JSON.parse(JSON.stringify(payload));
    stalePayload.serverNowTs = Number(payload.serverNowTs || baseNow) - 5_000;
    stalePayload.snapshotVersionTs = stalePayload.serverNowTs;
    stalePayload.fingerprint = "stale-payload";
    stalePayload.summary.serverNowTs = stalePayload.serverNowTs;
    stalePayload.summary.lastActionTs = stalePayload.serverNowTs;
    stalePayload.summary.lastAction = "HOLD";
    hooks.applyPayload?.(stalePayload);
    assert(String(getElementById("mLastAction").textContent || "") === "RESOLVE", "older poll payload must not overwrite newer stream state");

    const staleMarkPayload = JSON.parse(JSON.stringify(payload));
    staleMarkPayload.summary.latestPolymarket.ts = Number(payload.serverNowTs || baseNow) - 20_000;
    staleMarkPayload.summary.openTrade.btcReferenceTs = Number(payload.serverNowTs || baseNow) - 20_000;
    staleMarkPayload.summary.openTrade.btcReferenceStale = true;
    staleMarkPayload.openTrades[0].btcReferenceTs = Number(payload.serverNowTs || baseNow) - 20_000;
    staleMarkPayload.openTrades[0].btcReferenceStale = true;
    staleMarkPayload.snapshotVersionTs = Number(payload.serverNowTs || baseNow) + 10_000;
    staleMarkPayload.fingerprint = "stale-mark-payload";
    staleMarkPayload.serverNowTs = staleMarkPayload.snapshotVersionTs;
    staleMarkPayload.summary.serverNowTs = staleMarkPayload.snapshotVersionTs;
    staleMarkPayload.summary.lastActionTs = staleMarkPayload.snapshotVersionTs;
    hooks.applyPayload?.(staleMarkPayload);
    assert(String(getElementById("liveBtcReference").textContent || "").includes("STALE"), "stale BTC feed should render badge text only on BTC live");
    assert(!String(getElementById("livePrice").textContent || "").includes("STALE"), "estimated live should not render stale badge text");
    assert(String(getElementById("openTradesBody").innerHTML || "").includes("STALE"), "stale mark should render badge in open trades table");
    assert(!String(getElementById("openTradesBody").innerHTML || "").includes("MID"), "open trades table should hide technical source labels");

    const unavailablePayload = JSON.parse(JSON.stringify(payload));
    unavailablePayload.summary.latestPolymarket.fastMid = null;
    unavailablePayload.summary.latestPolymarket.ts = null;
    unavailablePayload.summary.openTrade.btcReferencePrice = null;
    unavailablePayload.summary.openTrade.btcReferenceTs = null;
    unavailablePayload.summary.openTrade.btcReferenceStale = true;
    unavailablePayload.summary.openTrade.impliedProbPct = null;
    unavailablePayload.summary.openTrade.unrealizedPnlUsd = null;
    unavailablePayload.openTrades[0].btcReferencePrice = null;
    unavailablePayload.openTrades[0].btcReferenceTs = null;
    unavailablePayload.openTrades[0].btcReferenceStale = true;
    unavailablePayload.openTrades[0].impliedProbPct = null;
    unavailablePayload.openTrades[0].unrealizedPnlUsd = null;
    unavailablePayload.snapshotVersionTs = Number(payload.serverNowTs || baseNow) + 15_000;
    unavailablePayload.fingerprint = "unavailable-mark-payload";
    unavailablePayload.serverNowTs = unavailablePayload.snapshotVersionTs;
    unavailablePayload.summary.serverNowTs = unavailablePayload.snapshotVersionTs;
    unavailablePayload.summary.lastActionTs = unavailablePayload.snapshotVersionTs;
    hooks.applyPayload?.(unavailablePayload);
    assert(
      String(getElementById("livePrice").textContent || "").includes("waiting for quote"),
      "unavailable mark should render waiting-for-quote text in live strip"
    );
    assert(String(getElementById("liveBtcStart").textContent || "") === "$100.20", "BTC start should remain visible even if BTC live is unavailable");
    assert(String(getElementById("liveBtcReference").textContent || "") === "-", "unavailable BTC feed should clear BTC price");
    assert(String(getElementById("liveUnrealizedPnl").textContent || "") === "-", "unavailable mark should render dash unrealized pnl");
    assert(
      String(getElementById("openTradesBody").innerHTML || "").includes("waiting for quote"),
      "unavailable mark should render waiting-for-quote text in open trades table"
    );

    const noOpenPayload = JSON.parse(JSON.stringify(payload));
    noOpenPayload.openTrades = [];
    noOpenPayload.summary.openTrade = null;
    noOpenPayload.liveStrip.btcReferencePrice = null;
    noOpenPayload.liveStrip.btcStartPrice = null;
    noOpenPayload.liveStrip.contractEntryPrice = null;
    noOpenPayload.liveStrip.contractLivePrice = null;
    noOpenPayload.liveStrip.impliedProbPct = null;
    noOpenPayload.liveStrip.livePrice = null;
    noOpenPayload.liveStrip.unrealizedPnlUsd = null;
    noOpenPayload.liveStrip.hasOpenTrade = false;
    noOpenPayload.snapshotVersionTs = Number(payload.serverNowTs || baseNow) + 20_000;
    noOpenPayload.fingerprint = "no-open-payload";
    noOpenPayload.serverNowTs = noOpenPayload.snapshotVersionTs;
    noOpenPayload.summary.serverNowTs = noOpenPayload.snapshotVersionTs;
    noOpenPayload.summary.lastActionTs = noOpenPayload.snapshotVersionTs;
    hooks.applyPayload?.(noOpenPayload);
    assert(String(getElementById("liveOpenTrade").textContent || "") === "NO", "no-open-trade payload should clear live open state");
    assert(String(getElementById("liveBtcStart").textContent || "") === "-", "no-open-trade payload should show dash BTC start");
    assert(String(getElementById("liveBtcReference").textContent || "") === "-", "no-open-trade payload should show dash BTC reference");
    assert(String(getElementById("liveContractEntry").textContent || "") === "-", "no-open-trade payload should show dash contract entry");
    assert(String(getElementById("livePrice").textContent || "") === "-", "no-open-trade payload should show dash live price");
    assert(String(getElementById("liveImpliedProb").textContent || "") === "-", "no-open-trade payload should show dash implied probability");
    assert(String(getElementById("liveUnrealizedPnl").textContent || "") === "-", "no-open-trade payload should show dash unrealized pnl");

    hooks.handleStreamError?.();
    const liveState = hooks.getState?.() || {};
    assert(Boolean(liveState.fallbackPollingActive), "stream error should enable polling fallback");

    // eslint-disable-next-line no-console
    console.log("Polymarket dashboard live tests: PASS");
  } finally {
    process.chdir(previousCwd);
    rmSync(rootDir, { recursive: true, force: true });
  }
}

run();
