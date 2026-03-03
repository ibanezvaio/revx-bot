import vm from "node:vm";
import { BotConfig, loadConfig } from "../config";
import { buildLogger } from "../logger";
import { Store } from "../store/Store";
import { DashboardServer } from "../web/DashboardServer";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function makeConfig(): BotConfig {
  process.env.DRY_RUN = "true";
  process.env.DASHBOARD_ENABLED = "true";
  process.env.DASHBOARD_PORT = "0";
  const base = loadConfig();
  return {
    ...base,
    dryRun: true,
    dashboardEnabled: true,
    dashboardPort: 0
  };
}

function makeClassList(): {
  add: (...names: string[]) => void;
  remove: (...names: string[]) => void;
  toggle: (name: string, force?: boolean) => boolean;
  contains: (name: string) => boolean;
} {
  const set = new Set<string>();
  return {
    add: (...names: string[]) => {
      for (const name of names) set.add(name);
    },
    remove: (...names: string[]) => {
      for (const name of names) set.delete(name);
    },
    toggle: (name: string, force?: boolean) => {
      if (force === true) {
        set.add(name);
        return true;
      }
      if (force === false) {
        set.delete(name);
        return false;
      }
      if (set.has(name)) {
        set.delete(name);
        return false;
      }
      set.add(name);
      return true;
    },
    contains: (name: string) => set.has(name)
  };
}

function makeElement(): Record<string, unknown> {
  return {
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    title: "",
    style: {
      display: "",
      setProperty: () => undefined
    },
    classList: makeClassList(),
    setAttribute: () => undefined,
    getAttribute: () => "",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    click: () => undefined,
    querySelectorAll: () => []
  };
}

async function run(): Promise<void> {
  const config = makeConfig();
  const logger = buildLogger(config);
  const store = {} as unknown as Store;
  const server = new DashboardServer(config, logger, store, "test-run");

  try {
    const dashboardJs = (
      server as unknown as {
        prepareDashboardJs: () => string;
      }
    ).prepareDashboardJs();

    const responseSink: {
      statusCode: number;
      headers: Record<string, string>;
      body?: Buffer;
    } = {
      statusCode: 0,
      headers: {}
    };

    const responseMock: {
      setHeader: (name: string, value: string) => void;
      end: (body?: Buffer | string) => void;
      statusCode: number;
    } = {
      setHeader: (name: string, value: string): void => {
        responseSink.headers[name.toLowerCase()] = value;
      },
      end: (body?: Buffer | string): void => {
        if (typeof body === "string") {
          responseSink.body = Buffer.from(body, "utf8");
        } else if (Buffer.isBuffer(body)) {
          responseSink.body = body;
        }
      },
      statusCode: 0
    };

    await (
      server as unknown as {
        handle: (req: unknown, res: unknown) => Promise<void>;
      }
    ).handle(
      {
        method: "GET",
        url: "/favicon.ico",
        headers: { host: "localhost" }
      },
      responseMock
    );
    responseSink.statusCode = responseMock.statusCode;

    assert(responseSink.statusCode === 200, `expected favicon handler status 200, got ${responseSink.statusCode}`);
    assert(
      String(responseSink.headers["content-type"] || "").includes("image/svg+xml"),
      `expected favicon content-type image/svg+xml, got ${String(responseSink.headers["content-type"] || "-")}`
    );
    assert(Boolean(responseSink.body && responseSink.body.length > 0), "expected non-empty favicon response body");

    const elements = new Map<string, Record<string, unknown>>();
    const getElementById = (id: string): Record<string, unknown> => {
      const existing = elements.get(id);
      if (existing) return existing;
      const next = makeElement();
      elements.set(id, next);
      return next;
    };

    const documentMock = {
      getElementById,
      querySelectorAll: () => [],
      addEventListener: () => undefined,
      createElement: () => makeElement(),
      createElementNS: () => makeElement(),
      body: {
        appendChild: () => undefined,
        removeChild: () => undefined
      },
      documentElement: {
        style: {
          setProperty: () => undefined
        }
      }
    };

    const localStorageMock = {
      getItem: () => null,
      setItem: () => undefined
    };

    const windowMock: Record<string, unknown> = {
      __REVX_TEST_MODE__: true,
      __REVX_BOOT_ERR__: "",
      __REVX_HEARTBEAT__: 0,
      __REVX_LAST_TICK__: Date.now(),
      addEventListener: () => undefined,
      location: {
        pathname: "/"
      },
      navigator: {
        clipboard: {
          writeText: async () => undefined
        }
      },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      confirm: () => true,
      localStorage: localStorageMock,
      document: documentMock
    };

    class HTMLElementMock {}
    class HTMLDetailsElementMock extends HTMLElementMock {
      open = false;
    }

    const context: Record<string, unknown> = {
      window: windowMock,
      document: documentMock,
      localStorage: localStorageMock,
      console,
      Date,
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
      Blob,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      HTMLElement: HTMLElementMock,
      HTMLDetailsElement: HTMLDetailsElementMock,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
    };

    vm.createContext(context);
    vm.runInContext(dashboardJs, context, { timeout: 10_000 });

    const hooks = (windowMock.__REVX_DASHBOARD_HOOKS__ as { render?: (state: unknown) => void } | undefined) ?? {};
    assert(typeof hooks.render === "function", "dashboard test hook render() not exposed");

    const now = Date.now();
    hooks.render?.({
      data: {
        symbol: "BTC-USD",
        runId: "test-run",
        ts: now,
        mode: { dryRun: true, paused: false, kill: false },
        analytics: { reentryLastSeedTs: now - 60_000 },
        botStatus: {
          allow_buy: true,
          allow_sell: true,
          buy_reasons: [],
          sell_reasons: [],
          quoting: {
            quoteEnabled: true,
            hardHalt: false,
            buyLevelsPlanned: 1,
            sellLevelsPlanned: 1,
            tobPlanned: "OFF",
            tobPolicy: "JOIN",
            appliedSpreadMult: 1,
            appliedSizeMult: 1,
            quoteBlockedReasons: [],
            signalsReasons: [],
            overrideReasons: []
          }
        },
        quotes: {
          revx: { bid: 100, ask: 101, mid: 100.5, spreadBps: 50 },
          bestBid: { venue: "coinbase", price: 100 },
          bestAsk: { venue: "kraken", price: 101 },
          fairMid: 100.4,
          venues: []
        },
        ticker: { bid: 100, ask: 101, mid: 100.5 },
        balances: [],
        activeBotOrders: [],
        recentBotOrders: [],
        recentEvents: [],
        recentFills: [],
        fills: { fills1h: 0, fills24h: 0, lastFillTs: 0 },
        crossVenue: { venues: [], signal: null },
        intelSnapshot: {},
        overrides: null,
        effectiveConfig: {}
      },
      lastSuccessMs: now,
      lastRefreshAttemptMs: now,
      refreshCount: 1,
      maxUiEvents: 500,
      maxEquityPoints: 5000,
      equitySampleMs: 2000,
      persistEquitySeries: false,
      signalsError: "",
      uiEvents: [],
      decisionHistory: [],
      pnlWindow: "24h",
      view: "overview",
      navCollapsed: false,
      equityMode: "USD",
      equityWindow: "24h",
      drawdownMode: "pct",
      chartMode: "mid",
      autopilotMode: "assist",
      eventFilter: "all",
      intelTab: "signals",
      signalKindFilter: "all",
      newsCategoryFilter: "all",
      newsImpactFilter: "all",
      orderViewFilter: "open",
      venueQuotesFilter: "all",
      primarySeriesMode: "mid"
    });

    const symbolNode = getElementById("headerLeftSymbol");
    assert(symbolNode.textContent === "BTC-USD", "render() did not update mission bar symbol");
  } finally {
    server.stop();
  }

  // eslint-disable-next-line no-console
  console.log("Dashboard render smoke: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Dashboard render smoke: FAIL", error);
  process.exit(1);
});
