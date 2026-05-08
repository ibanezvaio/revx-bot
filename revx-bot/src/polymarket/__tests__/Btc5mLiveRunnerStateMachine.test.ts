import { deriveBtc5mTickContext } from "../btc5m";
import { Btc5mLiveRunner } from "../live/Btc5mLiveRunner";
import { BTC5M_SELECTOR_REASONS } from "../live/Btc5mSelector";
import { Btc5mDecision, Btc5mSelectedMarket, Btc5mTick } from "../live/Btc5mTypes";
import { SharedMarketIntelligence } from "../../runtime/SharedMarketIntelligence";

type LogEntry = {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  payload: Record<string, unknown>;
};

type RunnerHarness = {
  runner: Btc5mLiveRunner;
  logs: LogEntry[];
  executionMock: {
    cancelAllCalls: number;
    openEntryOrders: number;
    hasUnknownOpenOrders: boolean;
  };
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === "string") {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch?: Record<string, unknown>): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = out[key];
    if (isObject(baseValue) && isObject(value)) {
      out[key] = deepMerge(baseValue, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    symbol: "BTC-USD",
    signalsEnabled: false,
    enableIntel: false,
    polymarket: {
      mode: "live",
      liveConfirmed: true,
      liveExecutionEnabled: true,
      killSwitch: false,
      baseUrls: {
        gamma: "https://gamma-api.polymarket.com",
        data: "https://data-api.polymarket.com",
        clob: "https://clob.polymarket.com",
        bridge: "https://bridge.polymarket.com"
      },
      http: {
        requestsPerMinute: 600
      },
      execution: {
        cancelAllOnStart: false,
        takerPriceBuffer: 0.01
      },
      live: {
        minEntryRemainingSec: 60,
        minEdgeThreshold: 0.0005,
        maxSpread: 0.05,
        oracleWarnMs: 5_000,
        oracleHardBlockMs: 30_000,
        scalpMode: false,
        maxEntriesPerWindow: 1,
        reentryCooldownSec: 8,
        scalpTp1Usd: 0.12,
        scalpTp2Usd: 0.25,
        scalpMaxHoldSec: 60,
        scalpTrailRetraceFrac: 0.35
      },
      sizing: {
        maxNotionalPerWindow: 10,
        maxConcurrentWindows: 3,
        maxDailyLoss: 100
      },
      risk: {
        maxExposure: 100,
        staleMs: 60_000,
        noNewOrdersInLastSec: 10,
        maxOpenOrders: 10
      }
    }
  };
  return deepMerge(base, overrides);
}

function createHarness(configOverrides?: Record<string, unknown>): RunnerHarness {
  const logs: LogEntry[] = [];
  const logger = {
    info: (payload: Record<string, unknown>, msg: string) => logs.push({ level: "info", msg, payload }),
    warn: (payload: Record<string, unknown>, msg: string) => logs.push({ level: "warn", msg, payload }),
    error: (payload: Record<string, unknown>, msg: string) => logs.push({ level: "error", msg, payload }),
    debug: (payload: Record<string, unknown>, msg: string) => logs.push({ level: "debug", msg, payload })
  };
  const runner = new Btc5mLiveRunner(makeConfig(configOverrides) as any, logger as any, {});

  const executionMock = {
    cancelAllCalls: 0,
    openEntryOrders: 0,
    hasUnknownOpenOrders: false
  };

  (runner as any).execution = {
    cancelAll: async () => {
      executionMock.cancelAllCalls += 1;
    },
    cancelUnfilledEntryOrders: async () => ({ requestedCount: 1, cancelledCount: 1 }),
    countOpenEntryOrdersForMarket: () => executionMock.openEntryOrders,
    hasUnknownOpenOrders: () => executionMock.hasUnknownOpenOrders,
    getPositions: () => [] as Array<Record<string, unknown>>,
    getOpenOrders: () => [] as Array<Record<string, unknown>>,
    getTotalExposureUsd: () => 0,
    getOpenOrderCount: () => 0,
    getConcurrentWindows: () => 0,
    executeBuyYes: async () => ({ action: "BUY_YES", accepted: true, filledShares: 1, reason: null }),
    executeBuyNo: async () => ({ action: "BUY_NO", accepted: true, filledShares: 1, reason: null }),
    executeExit: async () => ({ accepted: true, filledShares: 1, fillPrice: 0.55, reason: null })
  };
  (runner as any).risk = {
    checkNewOrder: () => ({ ok: true }),
    getRemainingDailyLossBudget: () => 100
  };
  (runner as any).sizing = {
    compute: () => ({ notionalUsd: 2 })
  };
  (runner as any).selector = {
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };
  (runner as any).client = {
    getTokenPriceQuote: async () => ({ bestBid: 0.49, bestAsk: 0.5, mid: 0.495, ts: Date.now() })
  };
  return { runner, logs, executionMock };
}

function makeTick(nowMs = Date.now()): Btc5mTick {
  return deriveBtc5mTickContext(nowMs);
}

function makeSelected(tick: Btc5mTick, overrides?: Partial<Btc5mSelectedMarket>): Btc5mSelectedMarket {
  const selected: Btc5mSelectedMarket = {
    marketId: "market-1",
    slug: tick.currentSlug,
    question: "BTC 5m up/down",
    priceToBeat: 100_000,
    startTs: tick.currentBucketStartSec * 1000,
    endTs: (tick.currentBucketStartSec + 300) * 1000,
    remainingSec: tick.remainingSec,
    tickSize: "0.01",
    negRisk: false,
    chosenSide: "YES",
    selectedTokenId: "yes-token",
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    yesBook: {
      side: "YES",
      tokenId: "yes-token",
      bestBid: 0.48,
      bestAsk: 0.5,
      mid: 0.49,
      spread: 0.02,
      quoteTs: Date.now(),
      bookable: true,
      reason: null
    },
    noBook: {
      side: "NO",
      tokenId: "no-token",
      bestBid: 0.48,
      bestAsk: 0.5,
      mid: 0.49,
      spread: 0.02,
      quoteTs: Date.now(),
      bookable: true,
      reason: null
    },
    selectionSource: "current_slug",
    orderbookOk: true
  };
  return { ...selected, ...overrides };
}

function makeDecision(
  tick: Btc5mTick,
  overrides?: Partial<Btc5mDecision> & { chosenSide?: "YES" | "NO"; action?: "BUY_YES" | "BUY_NO" | "HOLD" }
): Btc5mDecision {
  const chosenSide = overrides?.chosenSide ?? "YES";
  const action = overrides?.action ?? (chosenSide === "YES" ? "BUY_YES" : "BUY_NO");
  const decision: Btc5mDecision = {
    action,
    blocker: null,
    blockerSeverity: null,
    warning: null,
    chosenSide,
    edge: 0.01,
    yesEdge: 0.01,
    noEdge: 0.005,
    threshold: 0.0005,
    spread: 0.01,
    yesSpread: 0.01,
    noSpread: 0.01,
    maxSpread: 0.05,
    remainingSec: tick.remainingSec,
    minEntryRemainingSec: 60,
    oracleAgeMs: 100,
    oracleWarnMs: 5_000,
    oracleHardBlockMs: 30_000,
    intelligenceSource: "TEST",
    intelligencePosture: "TEST",
    intelligenceScore: 0.5,
    sideEnabled: true,
    orderbookOk: true,
    sideAsk: chosenSide === "YES" ? 0.5 : 0.49,
    pUpModel: 0.55,
    pDownModel: 0.45
  };
  return { ...decision, ...overrides };
}

function makeAttempt(
  tick: Btc5mTick,
  selected: Btc5mSelectedMarket,
  decision: Btc5mDecision,
  overrides?: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    attemptId: "att-test",
    executionSlug: selected.slug,
    selectedSlug: selected.slug,
    currentSlugAtCreate: tick.currentSlug,
    intendedOrderMode: "MARKETABLE_ENTRY",
    side: decision.chosenSide ?? "YES",
    tokenId: decision.chosenSide === "NO" ? selected.noTokenId : selected.yesTokenId,
    retryCount: 0,
    createdTs: Date.now(),
    deadlineTs: Date.now() + 25_000,
    postingStarted: false,
    postReturned: false,
    awaitingSettlement: false,
    tick,
    selected,
    decision,
    ...overrides
  };
}

function logEntries(logs: LogEntry[], msg: string): LogEntry[] {
  return logs.filter((row) => row.msg === msg);
}

async function waitForRunnerTasksToDrain(runner: Btc5mLiveRunner, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (((runner as any).activeExecutionTask || (runner as any).activeProfitTakeTask) && Date.now() - start < timeoutMs) {
    await sleep(2);
  }
  await sleep(0);
}

function assertNoDanglingExecutionRefs(runner: Btc5mLiveRunner, label: string): void {
  assert((runner as any).activeExecutionAttempt === null, `${label}: activeExecutionAttempt should be null`);
  assert((runner as any).activeExecutionTask === null, `${label}: activeExecutionTask should be null`);
}

function assertCleanupCount(logs: LogEntry[], reason: string, expected: number, label: string): void {
  const count = logEntries(logs, "POLY_V2_ATTEMPT_CLEANUP").filter((row) => row.payload.reason === reason).length;
  assert(count === expected, `${label}: expected cleanup count ${expected} for ${reason}, got ${count}`);
}

async function testSingleActiveAttemptInvariant(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);

  (runner as any).verifySideBookAvailableForExecution = async () => true;
  let started = 0;
  (runner as any).startExecutionAttempt = () => {
    started += 1;
  };

  const first = await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true });
  assert(first.action === "BUY_YES", `single-active: first dispatch action expected BUY_YES, got ${first.action}`);
  (runner as any).entryAttemptCooldownUntilTs = 0;
  const second = await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true });

  assert(second.action === "HOLD", `single-active: second dispatch expected HOLD, got ${second.action}`);
  assert(second.blocker === "EXECUTION_IN_FLIGHT", `single-active: expected EXECUTION_IN_FLIGHT, got ${second.blocker}`);
  assert(started === 1, `single-active: expected startExecutionAttempt called once, got ${started}`);
  assert(
    logEntries(logs, "POLY_V2_EXECUTION_ATTEMPT_CREATED").length === 1,
    "single-active: expected exactly one POLY_V2_EXECUTION_ATTEMPT_CREATED"
  );
}

async function testRolloverStaleHandling(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);
  (runner as any).activeExecutionAttempt = makeAttempt(tick, selected, decision, {
    attemptId: "att-rollover",
    postingStarted: true
  });
  const previousCooldown = Number((runner as any).executionCooldownUntilTs || 0);
  (runner as any).invalidateExecutionAttempt("ROLLOVER", { currentSlug: tick.nextSlug, selectedSlug: selected.slug });
  await sleep(5);

  assertCleanupCount(logs, "ROLLOVER", 1, "rollover");
  const cleanup = logEntries(logs, "POLY_V2_ATTEMPT_CLEANUP")[0];
  assert(cleanup.payload.cancelRequested === true, "rollover: expected cancelRequested=true");
  assert(
    Number((runner as any).executionCooldownUntilTs) >= previousCooldown,
    "rollover: expected execution cooldown to be monotonic"
  );
  assert(logEntries(logs, "POLY_V2_UNFILLED_ORDER_CANCEL_REQUEST").length === 1, "rollover: expected cancel request log");
  assertNoDanglingExecutionRefs(runner, "rollover");
}

async function testRolloverPreservesAttemptAlreadyTargetingNewBucket(): Promise<void> {
  const { runner, logs } = createHarness();
  const oldTick = makeTick();
  const newTick = deriveBtc5mTickContext((oldTick.currentBucketStartSec + 300) * 1000 + 1_000);
  const selected = makeSelected(newTick);
  const decision = makeDecision(newTick);
  (runner as any).activeExecutionAttempt = makeAttempt(newTick, selected, decision, {
    attemptId: "att-rollover-preserved",
    postingStarted: false
  });
  (runner as any).previousCurrentSlug = oldTick.currentSlug;
  (runner as any).state.currentBucketSlug = oldTick.currentSlug;

  const shouldInvalidate = (runner as any).shouldInvalidateExecutionAttemptForRollover(newTick.currentSlug);

  assert(shouldInvalidate === false, "rollover-preserved: expected rollover to preserve attempt for new current bucket");
  assertCleanupCount(logs, "ROLLOVER", 0, "rollover-preserved");
  assert((runner as any).activeExecutionAttempt?.attemptId === "att-rollover-preserved", "rollover-preserved: attempt should remain active");
}

async function testSupersededSelectionHandling(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);
  (runner as any).activeExecutionAttempt = makeAttempt(tick, selected, decision, {
    attemptId: "att-superseded",
    postingStarted: false
  });
  (runner as any).invalidateExecutionAttempt("SUPERSEDED", { currentSlug: tick.currentSlug, selectedSlug: tick.nextSlug });
  await sleep(5);

  assertCleanupCount(logs, "SUPERSEDED", 1, "superseded");
  const cleanup = logEntries(logs, "POLY_V2_ATTEMPT_CLEANUP")[0];
  assert(cleanup.payload.cancelRequested === false, "superseded: expected cancelRequested=false");
  assertNoDanglingExecutionRefs(runner, "superseded");
}

async function testDeadlineExceededBeforePost(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);
  const attempt = makeAttempt(tick, selected, decision, {
    attemptId: "att-deadline-before-post",
    postingStarted: false,
    deadlineTs: Date.now() + 20
  });
  (runner as any).activeExecutionAttempt = attempt;
  (runner as any).maybeExecuteDecision = async () => new Promise(() => undefined);
  (runner as any).startExecutionAttempt(attempt);
  await sleep(50);
  await waitForRunnerTasksToDrain(runner);

  assert(logEntries(logs, "POLY_V2_EXECUTION_TIMEOUT").length === 1, "deadline-before-post: expected timeout log");
  assertCleanupCount(logs, "DEADLINE_EXCEEDED", 1, "deadline-before-post");
  const cleanup = logEntries(logs, "POLY_V2_ATTEMPT_CLEANUP")[0];
  assert(cleanup.payload.cancelRequested === false, "deadline-before-post: expected cancelRequested=false");
  assertNoDanglingExecutionRefs(runner, "deadline-before-post");
}

async function testDeadlineExceededAfterPostingStarted(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);
  const attempt = makeAttempt(tick, selected, decision, {
    attemptId: "att-deadline-after-post",
    postingStarted: true,
    deadlineTs: Date.now() + 20
  });
  (runner as any).activeExecutionAttempt = attempt;
  (runner as any).maybeExecuteDecision = async () => new Promise(() => undefined);
  (runner as any).startExecutionAttempt(attempt);
  await sleep(50);
  await waitForRunnerTasksToDrain(runner);

  const lifecycle = logEntries(logs, "POLY_V2_EXECUTION_ATTEMPT_LIFECYCLE");
  const deadlineLifecycle = lifecycle.find(
    (row) => row.payload.state === "deadline_exceeded" && row.payload.postingStarted === true
  );
  assert(Boolean(deadlineLifecycle), "deadline-after-post: expected lifecycle deadline_exceeded with postingStarted=true");
  assertCleanupCount(logs, "DEADLINE_EXCEEDED", 1, "deadline-after-post");
  const cleanup = logEntries(logs, "POLY_V2_ATTEMPT_CLEANUP")[0];
  assert(cleanup.payload.cancelRequested === true, "deadline-after-post: expected cancelRequested=true");
  assert(logEntries(logs, "POLY_V2_UNFILLED_ORDER_CANCEL_REQUEST").length === 1, "deadline-after-post: cancel log missing");
  assertNoDanglingExecutionRefs(runner, "deadline-after-post");
}

async function testStaleAfterPostPath(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);
  const attempt = makeAttempt(tick, selected, decision, {
    attemptId: "att-stale-after-post",
    postingStarted: true
  });
  const previousCooldown = Number((runner as any).executionCooldownUntilTs || 0);
  (runner as any).activeExecutionAttempt = attempt;
  (runner as any).maybeExecuteDecision = async () => ({ action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" });
  (runner as any).startExecutionAttempt(attempt);
  await waitForRunnerTasksToDrain(runner);

  assertCleanupCount(logs, "STALE_AFTER_POST", 1, "stale-after-post");
  assert(
    logEntries(logs, "POLY_V2_RETRY_COOLDOWN").some((row) => row.payload.reason === "STALE_AFTER_POST"),
    "stale-after-post: expected stale cooldown log"
  );
  assert(
    Number((runner as any).executionCooldownUntilTs) >= previousCooldown,
    "stale-after-post: expected cooldown monotonicity"
  );
  const finalized = logEntries(logs, "POLY_V2_ATTEMPT_FINALIZED").find((row) => row.payload.attemptId === "att-stale-after-post");
  assert(finalized?.payload.blocker === "STALE_ATTEMPT_ABORTED", "stale-after-post: expected normalized blocker");
  assertNoDanglingExecutionRefs(runner, "stale-after-post");
}

async function testLivePlacedNoFillPath(): Promise<void> {
  const original = process.env.POLY_REENTRY_AFTER_UNFILLED;
  try {
    const runCase = async (enabled: boolean): Promise<void> => {
      process.env.POLY_REENTRY_AFTER_UNFILLED = enabled ? "true" : "false";
      const { runner, logs } = createHarness();
      const tick = makeTick();
      const selected = makeSelected(tick);
      const decision = makeDecision(tick);
      const attempt = makeAttempt(tick, selected, decision, {
        attemptId: enabled ? "att-no-fill-reentry-on" : "att-no-fill-reentry-off",
        postingStarted: true
      });
      (runner as any).activeExecutionAttempt = attempt;
      (runner as any).maybeExecuteDecision = async () => ({ action: "HOLD", blocker: "LIVE_PLACED_NO_FILL" });
      (runner as any).startExecutionAttempt(attempt);
      await waitForRunnerTasksToDrain(runner);

      const finalized = logEntries(logs, "POLY_V2_ATTEMPT_FINALIZED").find((row) => row.payload.attemptId === attempt.attemptId);
      assert(finalized?.payload.blocker === "LIVE_PLACED_NO_FILL", "no-fill: expected LIVE_PLACED_NO_FILL blocker");
      assert(logEntries(logs, "POLY_V2_UNFILLED_ORDER_CANCEL_REQUEST").length === 1, "no-fill: expected cancel path");
      const reentryCount = logEntries(logs, "POLY_V2_REENTRY_ELIGIBLE").length;
      if (enabled) {
        assert(reentryCount === 1, "no-fill: expected reentry eligible log when enabled");
      } else {
        assert(reentryCount === 0, "no-fill: expected no reentry eligible log when disabled");
      }
      assertNoDanglingExecutionRefs(runner, "no-fill");
    };

    await runCase(true);
    await runCase(false);
  } finally {
    if (original === undefined) {
      delete process.env.POLY_REENTRY_AFTER_UNFILLED;
    } else {
      process.env.POLY_REENTRY_AFTER_UNFILLED = original;
    }
  }
}

async function testScalpModeAllowsMultipleEntriesAfterCooldown(): Promise<void> {
  const { runner, logs } = createHarness({
    polymarket: {
      live: {
        scalpMode: true,
        maxEntriesPerWindow: 3,
        reentryCooldownSec: 1
      }
    }
  });
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, { action: "BUY_YES", chosenSide: "YES" });
  const windowState = (runner as any).getWindowEntryState(selected.slug);
  windowState.entries = 1;
  windowState.clearedSinceLastEntry = true;
  windowState.cooldownUntilTs = Date.now() - 1_000;
  (runner as any).verifySideBookAvailableForExecution = async () => true;
  let startCalls = 0;
  (runner as any).startExecutionAttempt = () => {
    startCalls += 1;
  };

  const result = await (runner as any).dispatchExecutionAttempt({
    tick,
    selected,
    decision,
    allowExecution: true
  });

  assert(result.action === "BUY_YES", `scalp-multi-entry: expected BUY_YES, got ${result.action}`);
  assert(result.blocker === null, `scalp-multi-entry: blocker should be null, got ${result.blocker}`);
  assert(startCalls === 1, `scalp-multi-entry: expected one attempt start, got ${startCalls}`);
  assert(logEntries(logs, "POLY_V2_EXECUTION_ATTEMPT_CREATED").length === 1, "scalp-multi-entry: missing created log");
}

async function testScalpModeReentryBlockedByCooldown(): Promise<void> {
  const { runner, logs } = createHarness({
    polymarket: {
      live: {
        scalpMode: true,
        maxEntriesPerWindow: 3,
        reentryCooldownSec: 8
      }
    }
  });
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, { action: "BUY_YES", chosenSide: "YES" });
  const windowState = (runner as any).getWindowEntryState(selected.slug);
  windowState.entries = 1;
  windowState.clearedSinceLastEntry = true;
  windowState.cooldownUntilTs = Date.now() + 10_000;
  (runner as any).verifySideBookAvailableForExecution = async () => true;
  let startCalls = 0;
  (runner as any).startExecutionAttempt = () => {
    startCalls += 1;
  };

  const result = await (runner as any).dispatchExecutionAttempt({
    tick,
    selected,
    decision,
    allowExecution: true
  });

  assert(result.action === "HOLD", `scalp-reentry-cooldown: expected HOLD, got ${result.action}`);
  assert(result.blocker === "REENTRY_COOLDOWN", `scalp-reentry-cooldown: expected REENTRY_COOLDOWN, got ${result.blocker}`);
  assert(startCalls === 0, `scalp-reentry-cooldown: startExecutionAttempt should not run, got ${startCalls}`);
  assert(
    logEntries(logs, "POLY_V2_REENTRY_EVAL").some((row) => row.payload.reason === "REENTRY_COOLDOWN"),
    "scalp-reentry-cooldown: expected REENTRY_COOLDOWN log"
  );
}

async function testScalpEntriesCappedByMaxEntriesPerWindow(): Promise<void> {
  const { runner, logs } = createHarness({
    polymarket: {
      live: {
        scalpMode: true,
        maxEntriesPerWindow: 2,
        reentryCooldownSec: 1
      }
    }
  });
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, { action: "BUY_YES", chosenSide: "YES" });
  const windowState = (runner as any).getWindowEntryState(selected.slug);
  windowState.entries = 2;
  windowState.clearedSinceLastEntry = true;
  windowState.cooldownUntilTs = 0;
  (runner as any).verifySideBookAvailableForExecution = async () => true;
  let startCalls = 0;
  (runner as any).startExecutionAttempt = () => {
    startCalls += 1;
  };

  const result = await (runner as any).dispatchExecutionAttempt({
    tick,
    selected,
    decision,
    allowExecution: true
  });

  assert(result.action === "HOLD", `scalp-max-entries: expected HOLD, got ${result.action}`);
  assert(result.blocker === "MAX_ENTRIES_PER_WINDOW", `scalp-max-entries: expected MAX_ENTRIES_PER_WINDOW, got ${result.blocker}`);
  assert(startCalls === 0, `scalp-max-entries: startExecutionAttempt should not run, got ${startCalls}`);
  assert(
    logEntries(logs, "POLY_V2_REENTRY_EVAL").some((row) => row.payload.reason === "MAX_ENTRIES_PER_WINDOW"),
    "scalp-max-entries: expected max entries log"
  );
}

async function testScalpProfitTakeTp1AndTp2RealizePnl(): Promise<void> {
  const runCase = async (input: {
    label: string;
    shares: number;
    avgPrice: number;
    bidPrice: number;
    expectedExitReason: "TP1" | "TP2";
  }): Promise<void> => {
    const { runner, logs } = createHarness({
      polymarket: {
        live: {
          scalpMode: true,
          scalpTp1Usd: 0.12,
          scalpTp2Usd: 0.25,
          scalpMaxHoldSec: 60
        }
      }
    });
    const tick = makeTick();
    const selected = makeSelected(tick, {
      yesBook: {
        ...makeSelected(tick).yesBook,
        bestBid: input.bidPrice,
        bestAsk: input.bidPrice + 0.01,
        mid: input.bidPrice + 0.005
      }
    });
    (runner as any).execution = {
      hasUnknownOpenOrders: () => false,
      getPositions: () => [
        {
          marketId: selected.marketId,
          tokenId: selected.yesTokenId,
          side: "YES",
          shares: input.shares,
          avgPrice: input.avgPrice,
          updatedTs: tick.tickNowMs - 10_000
        }
      ],
      getOpenOrders: () => [],
      executeExit: async () => ({
        accepted: true,
        filledShares: input.shares,
        fillPrice: input.bidPrice,
        reason: null
      })
    };
    (runner as any).selector = {
      isSideBookUnavailable: () => false,
      markSideBookUnavailable: () => undefined
    };

    const blocker = await (runner as any).maybeDispatchProfitTake({
      tick,
      selected,
      allowExecution: true
    });
    assert(blocker === "PROFIT_TAKE_IN_FLIGHT", `${input.label}: expected PROFIT_TAKE_IN_FLIGHT, got ${blocker}`);
    await waitForRunnerTasksToDrain(runner);

    const windowState = (runner as any).getWindowEntryState(selected.slug);
    assert(windowState.exits === 1, `${input.label}: expected one exit, got ${windowState.exits}`);
    assert(windowState.realizedPnlUsd > 0, `${input.label}: expected realized pnl > 0, got ${windowState.realizedPnlUsd}`);
    assert(windowState.lastExitReason === input.expectedExitReason, `${input.label}: exit reason mismatch ${windowState.lastExitReason}`);
    const resultLog = logEntries(logs, "POLY_V2_PROFIT_TAKE_RESULT").find(
      (row) => row.payload.accepted === true
    );
    assert(Boolean(resultLog), `${input.label}: missing accepted profit-take result log`);
    assert(
      resultLog?.payload.exitReason === input.expectedExitReason,
      `${input.label}: expected exitReason ${input.expectedExitReason}, got ${String(resultLog?.payload.exitReason)}`
    );
  };

  await runCase({
    label: "tp1",
    shares: 1,
    avgPrice: 0.4,
    bidPrice: 0.55,
    expectedExitReason: "TP1"
  });
  await runCase({
    label: "tp2",
    shares: 2,
    avgPrice: 0.25,
    bidPrice: 0.5,
    expectedExitReason: "TP2"
  });
}

async function testScalpProfitTakeMaxHoldExit(): Promise<void> {
  const { runner, logs } = createHarness({
    polymarket: {
      live: {
        scalpMode: true,
        scalpTp1Usd: 1,
        scalpTp2Usd: 2,
        scalpMaxHoldSec: 20
      }
    }
  });
  const tick = makeTick();
  const selected = makeSelected(tick, {
    yesBook: {
      ...makeSelected(tick).yesBook,
      bestBid: 0.49,
      bestAsk: 0.5,
      mid: 0.495
    }
  });
  (runner as any).execution = {
    hasUnknownOpenOrders: () => false,
    getPositions: () => [
      {
        marketId: selected.marketId,
        tokenId: selected.yesTokenId,
        side: "YES",
        shares: 1,
        avgPrice: 0.5,
        updatedTs: tick.tickNowMs - 40_000
      }
    ],
    getOpenOrders: () => [],
    executeExit: async () => ({
      accepted: true,
      filledShares: 1,
      fillPrice: 0.49,
      reason: null
    })
  };
  (runner as any).selector = {
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };

  const blocker = await (runner as any).maybeDispatchProfitTake({
    tick,
    selected,
    allowExecution: true
  });
  assert(blocker === "PROFIT_TAKE_IN_FLIGHT", `max-hold: expected PROFIT_TAKE_IN_FLIGHT, got ${blocker}`);
  await waitForRunnerTasksToDrain(runner);

  const windowState = (runner as any).getWindowEntryState(selected.slug);
  assert(windowState.exits === 1, `max-hold: expected one exit, got ${windowState.exits}`);
  assert(windowState.lastExitReason === "MAX_HOLD", `max-hold: expected MAX_HOLD, got ${windowState.lastExitReason}`);
  const resultLog = logEntries(logs, "POLY_V2_PROFIT_TAKE_RESULT").find((row) => row.payload.accepted === true);
  assert(Boolean(resultLog), "max-hold: missing accepted result log");
  assert(resultLog?.payload.exitReason === "MAX_HOLD", `max-hold: expected MAX_HOLD, got ${String(resultLog?.payload.exitReason)}`);
}

async function testManualStopPath(): Promise<void> {
  const { runner, logs, executionMock } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);
  (runner as any).running = true;
  (runner as any).state.running = true;
  (runner as any).loopTask = Promise.resolve();
  (runner as any).activeExecutionAttempt = makeAttempt(tick, selected, decision, {
    attemptId: "att-manual-stop",
    postingStarted: true
  });

  await runner.stop("MANUAL_STOP_TEST");
  await sleep(5);

  assert((runner as any).stopRequested === true, "manual-stop: stopRequested should be true");
  assert((runner as any).running === false, "manual-stop: running should be false");
  assert((runner as any).state.running === false, "manual-stop: state.running should be false");
  assert((runner as any).state.holdReason === "MANUAL_STOP_TEST", "manual-stop: holdReason should be stop reason");
  assert(executionMock.cancelAllCalls === 1, "manual-stop: cancelAll should be called once");
  assertCleanupCount(logs, "MANUAL_STOP", 1, "manual-stop");
  assertNoDanglingExecutionRefs(runner, "manual-stop");
}

async function testProfitTakeInflightGating(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick);

  (runner as any).verifySideBookAvailableForExecution = async () => true;
  (runner as any).activeProfitTakeAttempt = {
    attemptId: "pt-1",
    executionSlug: selected.slug,
    marketId: selected.marketId,
    tokenId: selected.yesTokenId,
    side: "YES",
    shares: 1,
    bidPrice: 0.5,
    avgPrice: 0.49,
    createdTs: Date.now()
  };
  const result = await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true });
  assert(result.action === "HOLD", "profit-take-gating: expected HOLD");
  assert(result.blocker === "PROFIT_TAKE_IN_FLIGHT", `profit-take-gating: unexpected blocker ${result.blocker}`);
  assert(
    logEntries(logs, "POLY_V2_EXECUTION_ATTEMPT_CREATED").length === 0,
    "profit-take-gating: should not create entry attempt"
  );
}

async function testNextBucketHandoffWaitPreventsDispatch(): Promise<void> {
  const { runner, logs } = createHarness();
  const nowMs = 1_773_318_895_000; // 5s remaining in current bucket
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const tick = makeTick(nowMs);
    const nextSelected = makeSelected(tick, {
      slug: tick.nextSlug,
      selectionSource: "next_slug"
    });
    (runner as any).selector = {
      select: async ({ tick: selectorTick }: { tick: Btc5mTick }) => ({
        tick: selectorTick,
        attemptedSlugs: [selectorTick.currentSlug, selectorTick.nextSlug, selectorTick.prevSlug],
        candidatesBeforeFilter: 1,
        candidatesAfterFilter: 1,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected: nextSelected,
        reason: "OK"
      }),
      isSideBookUnavailable: () => false,
      markSideBookUnavailable: () => undefined
    };
    (runner as any).getReferencePrice = () => ({ price: 100_000, ageMs: 100, ts: nowMs, source: "TEST" });
    (runner as any).resolveDirectionalIntelligence = () => ({
      source: "TEST",
      posture: "TEST",
      score: 0.5,
      pUpModel: 0.55,
      fallbackUsed: false
    });
    (runner as any).gate = {
      evaluate: () => makeDecision(tick, { action: "BUY_YES", chosenSide: "YES" })
    };
    (runner as any).maybeDispatchProfitTake = async () => null;
    let dispatchCalls = 0;
    (runner as any).dispatchExecutionAttempt = async () => {
      dispatchCalls += 1;
      return { action: "BUY_YES", blocker: null };
    };

    await (runner as any).processCycle(true);

    assert(dispatchCalls === 0, "next-handoff: dispatchExecutionAttempt should not be called");
    assert((runner as any).state.blockedBy === "NEXT_BUCKET_HANDOFF_WAIT", "next-handoff: expected NEXT_BUCKET_HANDOFF_WAIT");
    assert((runner as any).state.handoffWaitTriggered === true, "next-handoff: expected handoffWaitTriggered=true");
    assert((runner as any).state.dispatchEligibilityReason === "NEXT_BUCKET_HANDOFF_WAIT", "next-handoff: dispatch eligibility mismatch");
  } finally {
    Date.now = originalDateNow;
  }
}

async function testNextBucketPreselectionDispatchesBeforeHandoffWait(): Promise<void> {
  const { runner } = createHarness();
  const nowMs = 1_773_318_680_000; // comfortably before handoff wait
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const tick = makeTick(nowMs);
    const nextSelected = makeSelected(tick, {
      slug: tick.nextSlug,
      selectionSource: "next_slug"
    });
    (runner as any).selector = {
      select: async ({ tick: selectorTick }: { tick: Btc5mTick }) => ({
        tick: selectorTick,
        attemptedSlugs: [selectorTick.currentSlug, selectorTick.nextSlug, selectorTick.prevSlug],
        candidatesBeforeFilter: 1,
        candidatesAfterFilter: 1,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected: nextSelected,
        reason: "OK"
      }),
      isSideBookUnavailable: () => false,
      markSideBookUnavailable: () => undefined
    };
    (runner as any).getReferencePrice = () => ({ price: 100_000, ageMs: 100, ts: nowMs, source: "TEST" });
    (runner as any).resolveDirectionalIntelligence = () => ({
      source: "TEST",
      posture: "TEST",
      score: 0.5,
      pUpModel: 0.55,
      fallbackUsed: false
    });
    (runner as any).gate = {
      evaluate: () => makeDecision(tick, { action: "BUY_YES", chosenSide: "YES" })
    };
    (runner as any).maybeDispatchProfitTake = async () => null;
    let dispatchCalls = 0;
    (runner as any).dispatchExecutionAttempt = async () => {
      dispatchCalls += 1;
      return { action: "BUY_YES", blocker: null };
    };

    await (runner as any).processCycle(true);

    assert(dispatchCalls === 1, `next-preentry: expected one dispatch call, got ${dispatchCalls}`);
    assert((runner as any).state.blockedBy === null, "next-preentry: expected no structural blocker");
    assert((runner as any).state.dispatchEligibilityReason === "ELIGIBLE_CURRENT", "next-preentry: dispatch eligibility mismatch");
    assert((runner as any).state.selectedSlug === tick.nextSlug, "next-preentry: expected next slug to stay selected");
  } finally {
    Date.now = originalDateNow;
  }
}

async function testNextBucketAttemptRemainsActiveBeforeHandoff(): Promise<void> {
  const { runner, logs } = createHarness();
  const nowMs = 1_773_318_680_000;
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const tick = makeTick(nowMs);
    const selected = makeSelected(tick, {
      slug: tick.nextSlug,
      selectionSource: "next_slug"
    });
    const decision = makeDecision(tick, { action: "BUY_NO", chosenSide: "NO" });
    (runner as any).startExecutionAttempt = () => undefined;

    const result = await (runner as any).dispatchExecutionAttempt({
      tick,
      selected,
      decision,
      allowExecution: true
    });

    const attempt = (runner as any).activeExecutionAttempt;
    assert(result.action === "BUY_NO", `next-bucket-attempt-active: expected BUY_NO, got ${String(result.action)}`);
    assert(result.blocker === null, `next-bucket-attempt-active: expected null blocker, got ${String(result.blocker)}`);
    assert(attempt?.executionSlug === tick.nextSlug, "next-bucket-attempt-active: expected active attempt for next slug");
    assert(
      (runner as any).isExecutionSlugEligible(attempt.executionSlug, tick) === true,
      "next-bucket-attempt-active: next-bucket execution slug should be eligible before handoff"
    );
    assert(
      logEntries(logs, "POLY_V2_EXECUTION_ATTEMPT_CREATED").length === 1,
      "next-bucket-attempt-active: expected attempt created log"
    );
  } finally {
    Date.now = originalDateNow;
  }
}

async function testStaleSelectionTriggersReselection(): Promise<void> {
  const { runner } = createHarness();
  const staleMs = 1_773_318_890_000;
  const freshMs = staleMs + 20_000;
  const staleTick = makeTick(staleMs);
  const staleSelected = makeSelected(staleTick, { slug: staleTick.currentSlug });
  const freshTick = makeTick(freshMs);
  let selectorCalls = 0;
  (runner as any).selector = {
    select: async ({ tick }: { tick: Btc5mTick }) => {
      selectorCalls += 1;
      return {
        tick,
        attemptedSlugs: [tick.currentSlug, tick.nextSlug, tick.prevSlug],
        candidatesBeforeFilter: 1,
        candidatesAfterFilter: 1,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected: makeSelected(tick, { slug: tick.currentSlug }),
        reason: "OK"
      };
    },
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };
  const originalDateNow = Date.now;
  Date.now = () => freshMs;
  try {
    const result = await (runner as any).validateSelectionForDispatch({
      selected: staleSelected,
      tick: staleTick,
      expectedSelectionVersion: (runner as any).selectionVersion
    });
    assert(selectorCalls === 1, `stale-reselection: expected selector reselection call once, got ${selectorCalls}`);
    assert(result.reselectionTriggered === true, "stale-reselection: expected reselectionTriggered=true");
    assert(result.selected?.slug === freshTick.currentSlug, "stale-reselection: expected fresh current slug after reselection");
    assert(result.dispatchEligibilityReason === "ELIGIBLE_CURRENT", "stale-reselection: expected ELIGIBLE_CURRENT after reselection");
  } finally {
    Date.now = originalDateNow;
  }
}

async function testLateCurrentSelectionReselectsNextBucketBeforeGate(): Promise<void> {
  const { runner } = createHarness({
    polymarket: {
      live: {
        minEntryRemainingSec: 60
      }
    }
  });
  const anchorTick = makeTick(1_773_318_800_000);
  const bucketStartMs = anchorTick.currentBucketStartSec * 1000;
  const staleMs = bucketStartMs + 205_000;
  const freshMs = bucketStartMs + 245_000;
  const staleTick = makeTick(staleMs);
  const staleSelected = makeSelected(staleTick, { slug: staleTick.currentSlug });
  const freshTick = makeTick(freshMs);
  let selectorCalls = 0;
  (runner as any).selector = {
    select: async ({ tick }: { tick: Btc5mTick }) => {
      selectorCalls += 1;
      return {
        tick,
        attemptedSlugs: [tick.currentSlug, tick.nextSlug, tick.prevSlug],
        candidatesBeforeFilter: 1,
        candidatesAfterFilter: 1,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected: makeSelected(tick, { slug: tick.nextSlug, selectionSource: "next_slug" }),
        reason: "OK"
      };
    },
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };
  const originalDateNow = Date.now;
  Date.now = () => freshMs;
  try {
    const result = await (runner as any).validateSelectionForDispatch({
      selected: staleSelected,
      tick: staleTick,
      expectedSelectionVersion: (runner as any).selectionVersion
    });
    assert(staleTick.remainingSec > 60, `late-current-reselection: expected stale tick to begin entry-eligible, got ${staleTick.remainingSec}`);
    assert(freshTick.remainingSec <= 60, `late-current-reselection: expected fresh tick to be too late, got ${freshTick.remainingSec}`);
    assert(selectorCalls === 1, `late-current-reselection: expected selector reselection call once, got ${selectorCalls}`);
    assert(result.reselectionTriggered === true, "late-current-reselection: expected reselectionTriggered=true");
    assert(result.selected?.slug === freshTick.nextSlug, "late-current-reselection: expected next slug after reselection");
    assert(
      result.dispatchEligibilityReason === "ELIGIBLE_CURRENT",
      `late-current-reselection: expected ELIGIBLE_CURRENT, got ${String(result.dispatchEligibilityReason)}`
    );
  } finally {
    Date.now = originalDateNow;
  }
}

async function testCurrentBucketDispatchRemainsEligibleAboveConfiguredMinEntry(): Promise<void> {
  const original = process.env.POLY_V2_CURRENT_BUCKET_MIN_DISPATCH_REMAINING_SEC;
  delete process.env.POLY_V2_CURRENT_BUCKET_MIN_DISPATCH_REMAINING_SEC;
  try {
    const { runner } = createHarness({
      polymarket: {
        live: {
          minEntryRemainingSec: 20
        }
      }
    });
    const anchorTick = makeTick(1_773_318_800_000);
    const bucketStartMs = anchorTick.currentBucketStartSec * 1000;
    const eligibleCurrentMs = bucketStartMs + 246_000;
    const tick = makeTick(eligibleCurrentMs);
    const selected = makeSelected(tick, { slug: tick.currentSlug });

    assert(
      tick.remainingSec > 20 && tick.remainingSec < 60,
      `current-bucket-floor: expected remainingSec between 20 and 60, got ${tick.remainingSec}`
    );
    const reason = (runner as any).computeDispatchEligibilityReason(selected, tick);
    assert(reason === "ELIGIBLE_CURRENT", `current-bucket-floor: expected ELIGIBLE_CURRENT, got ${String(reason)}`);
  } finally {
    restoreEnv("POLY_V2_CURRENT_BUCKET_MIN_DISPATCH_REMAINING_SEC", original);
  }
}

async function testDispatchReselectionTimeoutFailsFast(): Promise<void> {
  const { runner } = createHarness({
    polymarket: {
      live: {
        minEntryRemainingSec: 60
      }
    }
  });
  const anchorTick = makeTick(1_773_318_800_000);
  const bucketStartMs = anchorTick.currentBucketStartSec * 1000;
  const staleMs = bucketStartMs + 205_000;
  const freshMs = bucketStartMs + 245_000;
  const staleTick = makeTick(staleMs);
  const staleSelected = makeSelected(staleTick, { slug: staleTick.currentSlug });
  let selectorCalls = 0;
  (runner as any).selector = {
    select: async () => {
      selectorCalls += 1;
      await new Promise(() => undefined);
      return {
        tick: makeTick(freshMs),
        attemptedSlugs: [],
        candidatesBeforeFilter: 0,
        candidatesAfterFilter: 0,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected: null,
        reason: BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS
      };
    },
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };
  (runner as any).getDispatchReselectionTimeoutMs = () => 1;
  const originalDateNow = Date.now;
  Date.now = () => freshMs;
  try {
    const result = await (runner as any).validateSelectionForDispatch({
      selected: staleSelected,
      tick: staleTick,
      expectedSelectionVersion: (runner as any).selectionVersion
    });
    assert(selectorCalls === 1, `dispatch-reselection-timeout: expected one reselection call, got ${selectorCalls}`);
    assert(result.reselectionTriggered === true, "dispatch-reselection-timeout: expected reselectionTriggered=true");
    assert(result.selected === null, "dispatch-reselection-timeout: expected null selected after timeout");
    assert(
      result.dispatchEligibilityReason === "DISCOVERY_IN_PROGRESS",
      `dispatch-reselection-timeout: expected DISCOVERY_IN_PROGRESS, got ${String(result.dispatchEligibilityReason)}`
    );
  } finally {
    Date.now = originalDateNow;
  }
}

async function testAdvisoryAttributionThrottleStillAllowsMinimumExecutableTicket(): Promise<void> {
  const { runner } = createHarness({
    polymarket: {
      sizing: {
        maxNotionalPerWindow: 10,
        minOrderNotional: 0.5,
        minSharesRequired: 1
      }
    }
  });
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, {
    action: "BUY_YES",
    chosenSide: "YES",
    sideAsk: 0.23
  });
  let postedNotionalUsd = 0;
  (runner as any).portfolioEntryPolicy = {
    allowNewEntries: true,
    additionalBudgetUsd: 0.84,
    reason: "ATTRIBUTION_POLY_SOFT_THROTTLE",
    source: "TEST"
  };
  (runner as any).execution.executeBuyYes = async (params: { notionalUsd: number }) => {
    postedNotionalUsd = Number(params.notionalUsd || 0);
    return { action: "BUY_YES", accepted: true, filledShares: 5, reason: null };
  };

  const result = await (runner as any).maybeExecuteDecision({
    tick,
    selected,
    decision,
    allowExecution: true
  });

  assert(result.action === "BUY_YES", `advisory-throttle: expected BUY_YES, got ${String(result.action)}`);
  assert(result.blocker === null, `advisory-throttle: expected null blocker, got ${String(result.blocker)}`);
  assert(
    postedNotionalUsd >= 1.15 - 1e-9,
    `advisory-throttle: expected minimum executable notional >=1.15, got ${String(postedNotionalUsd)}`
  );
}

async function testNextBucketPreselectionSkipsRedundantReselection(): Promise<void> {
  const { runner } = createHarness();
  const nowMs = 1_773_318_680_000; // comfortably before handoff wait
  const tick = makeTick(nowMs);
  const nextSelected = makeSelected(tick, {
    slug: tick.nextSlug,
    selectionSource: "next_slug"
  });
  let selectorCalls = 0;
  (runner as any).selector = {
    select: async ({ tick: selectorTick }: { tick: Btc5mTick }) => {
      selectorCalls += 1;
      return {
        tick: selectorTick,
        attemptedSlugs: [selectorTick.currentSlug, selectorTick.nextSlug, selectorTick.prevSlug],
        candidatesBeforeFilter: 1,
        candidatesAfterFilter: 1,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected: makeSelected(selectorTick, { slug: selectorTick.nextSlug, selectionSource: "next_slug" }),
        reason: "OK"
      };
    },
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const result = await (runner as any).validateSelectionForDispatch({
      selected: nextSelected,
      tick,
      expectedSelectionVersion: (runner as any).selectionVersion
    });
    assert(selectorCalls === 0, `next-preselection: expected no reselection call, got ${selectorCalls}`);
    assert(result.reselectionTriggered === false, "next-preselection: expected reselectionTriggered=false");
    assert(result.selected?.slug === tick.nextSlug, "next-preselection: expected selected next slug to be retained");
    assert(
      result.dispatchEligibilityReason === "ELIGIBLE_CURRENT",
      `next-preselection: expected ELIGIBLE_CURRENT, got ${String(result.dispatchEligibilityReason)}`
    );
  } finally {
    Date.now = originalDateNow;
  }
}

async function testFreshSelectionIgnoresPriorDiscoveryStaleWarning(): Promise<void> {
  const { runner } = createHarness();
  const nowMs = 1_773_318_680_000;
  const tick = makeTick(nowMs);
  const selected = makeSelected(tick, {
    slug: tick.currentSlug,
    selectionSource: "current_slug"
  });
  let selectorCalls = 0;
  (runner as any).state.warningState = "DISCOVERY_STALE";
  (runner as any).selector = {
    select: async ({ tick: selectorTick }: { tick: Btc5mTick }) => {
      selectorCalls += 1;
      return {
        tick: selectorTick,
        attemptedSlugs: [selectorTick.currentSlug, selectorTick.nextSlug, selectorTick.prevSlug],
        candidatesBeforeFilter: 1,
        candidatesAfterFilter: 1,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected: makeSelected(selectorTick, { slug: selectorTick.currentSlug, selectionSource: "current_slug" }),
        reason: "OK"
      };
    },
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const result = await (runner as any).validateSelectionForDispatch({
      selected,
      tick,
      expectedSelectionVersion: (runner as any).selectionVersion
    });
    assert(selectorCalls === 0, `fresh-selection-stale-warning: expected no reselection call, got ${selectorCalls}`);
    assert(result.reselectionTriggered === false, "fresh-selection-stale-warning: expected reselectionTriggered=false");
    assert(result.selected?.slug === tick.currentSlug, "fresh-selection-stale-warning: expected current slug retained");
    assert(
      result.dispatchEligibilityReason === "ELIGIBLE_CURRENT",
      `fresh-selection-stale-warning: expected ELIGIBLE_CURRENT, got ${String(result.dispatchEligibilityReason)}`
    );
  } finally {
    Date.now = originalDateNow;
  }
}

async function testDispatchExecutionAttemptPreservesStaleOracleBlocker(): Promise<void> {
  const { runner } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, {
    action: "BUY_YES",
    chosenSide: "YES",
    oracleAgeMs: 35_000,
    oracleHardBlockMs: 30_000
  });
  (runner as any).verifySideBookAvailableForExecution = async () => true;
  const result = await (runner as any).dispatchExecutionAttempt({
    tick,
    selected,
    decision,
    allowExecution: true
  });
  assert(result.action === "HOLD", `stale-oracle-dispatch: expected HOLD, got ${String(result.action)}`);
  assert(
    result.blocker === "STALE_ORACLE_HARD_BLOCK",
    `stale-oracle-dispatch: expected STALE_ORACLE_HARD_BLOCK, got ${String(result.blocker)}`
  );
}

async function testDispatchExecutionUsesSelectedExecutableBookWithoutReprobe(): Promise<void> {
  const { runner, logs } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick, {
    yesBook: {
      side: "YES",
      tokenId: "yes-token",
      bestBid: 0.48,
      bestAsk: 0.5,
      mid: 0.49,
      spread: 0.02,
      quoteTs: Date.now(),
      bookable: true,
      reason: null
    }
  });
  const decision = makeDecision(tick, { action: "BUY_YES", chosenSide: "YES" });
  let startCalls = 0;
  (runner as any).startExecutionAttempt = () => {
    startCalls += 1;
  };
  (runner as any).client.getTokenPriceQuote = async () => {
    throw new Error("quote reprobe should not run");
  };

  const result = await (runner as any).dispatchExecutionAttempt({
    tick,
    selected,
    decision,
    allowExecution: true
  });

  assert(result.action === "BUY_YES", `selected-book-dispatch: expected BUY_YES, got ${String(result.action)}`);
  assert(result.blocker === null, `selected-book-dispatch: expected null blocker, got ${String(result.blocker)}`);
  assert(startCalls === 1, `selected-book-dispatch: expected one attempt start, got ${startCalls}`);
  assert(
    logEntries(logs, "POLY_V2_EXECUTION_ATTEMPT_CREATED").length === 1,
    "selected-book-dispatch: expected exactly one attempt created log"
  );
}

async function testProcessCycleRefreshesReferenceAfterSlowSelection(): Promise<void> {
  const { runner } = createHarness();
  const nowMs = 1_773_318_680_000;
  const originalDateNow = Date.now;
  let currentNowMs = nowMs;
  Date.now = () => currentNowMs;
  try {
    const tick = makeTick(nowMs);
    const selected = makeSelected(tick, { slug: tick.currentSlug, selectionSource: "current_slug" });
    let referenceCalls = 0;
    let observedOracleAgeMs: number | null = null;
    (runner as any).getReferencePrice = (requestedNowMs: number) => {
      referenceCalls += 1;
      if (referenceCalls === 1) {
        return { price: 100_000, ageMs: 600_000, ts: requestedNowMs - 600_000, source: "STALE" };
      }
      return { price: 100_000, ageMs: 100, ts: requestedNowMs - 100, source: "FRESH" };
    };
    (runner as any).selector = {
      select: async ({ tick: selectorTick }: { tick: Btc5mTick }) => {
        currentNowMs = nowMs + 35_000;
        return {
          tick: selectorTick,
          attemptedSlugs: [selectorTick.currentSlug, selectorTick.nextSlug, selectorTick.prevSlug],
          candidatesBeforeFilter: 1,
          candidatesAfterFilter: 1,
          droppedExtreme: 0,
          droppedWideSpread: 0,
          droppedInvalid: 0,
          selected: makeSelected(makeTick(currentNowMs), { slug: makeTick(currentNowMs).currentSlug, selectionSource: "current_slug" }),
          reason: "OK"
        };
      },
      isSideBookUnavailable: () => false,
      markSideBookUnavailable: () => undefined
    };
    (runner as any).resolveDirectionalIntelligence = () => ({
      source: "TEST",
      posture: "TEST",
      score: 0.5,
      pUpModel: 0.55,
      fallbackUsed: false
    });
    (runner as any).gate = {
      evaluate: ({ tick: gateTick, oracleAgeMs }: { tick: Btc5mTick; oracleAgeMs: number | null }) =>
        makeDecision(gateTick, { action: "BUY_YES", chosenSide: "YES", oracleAgeMs: oracleAgeMs ?? null })
    };
    (runner as any).maybeDispatchProfitTake = async () => null;
    (runner as any).dispatchExecutionAttempt = async ({ decision }: { decision: Btc5mDecision }) => {
      observedOracleAgeMs = decision.oracleAgeMs;
      return { action: "BUY_YES", blocker: null };
    };

    await (runner as any).processCycle(true);

    assert(referenceCalls >= 2, `refresh-reference: expected at least 2 reference reads, got ${referenceCalls}`);
    assert(observedOracleAgeMs === 100, `refresh-reference: expected fresh oracle age 100, got ${String(observedOracleAgeMs)}`);
    assert((runner as any).state.action === "BUY_YES", `refresh-reference: expected BUY_YES action, got ${String((runner as any).state.action)}`);
  } finally {
    Date.now = originalDateNow;
  }
}

async function testValidatedPathAvoidsExpiredWindowAbortReason(): Promise<void> {
  const { runner } = createHarness();
  const staleMs = 1_773_318_890_000;
  const freshMs = staleMs + 20_000;
  const staleTick = makeTick(staleMs);
  const staleSelected = makeSelected(staleTick, { slug: staleTick.currentSlug });
  (runner as any).selector = {
    select: async ({ tick }: { tick: Btc5mTick }) => ({
      tick,
      attemptedSlugs: [tick.currentSlug, tick.nextSlug, tick.prevSlug],
      candidatesBeforeFilter: 1,
      candidatesAfterFilter: 1,
      droppedExtreme: 0,
      droppedWideSpread: 0,
      droppedInvalid: 0,
      selected: makeSelected(tick, { slug: tick.currentSlug }),
      reason: "OK"
    }),
    isSideBookUnavailable: () => false,
    markSideBookUnavailable: () => undefined
  };
  const originalDateNow = Date.now;
  Date.now = () => freshMs;
  try {
    const result = await (runner as any).validateSelectionForDispatch({
      selected: staleSelected,
      tick: staleTick,
      expectedSelectionVersion: (runner as any).selectionVersion
    });
    assert(
      result.dispatchEligibilityReason !== "EXPIRED_WINDOW",
      "validated-path: should not return EXPIRED_WINDOW for stale selection race path"
    );
    assert(
      result.dispatchEligibilityReason !== "ORDER_ABORT",
      "validated-path: should not return ORDER_ABORT in validated selection path"
    );
  } finally {
    Date.now = originalDateNow;
  }
}

async function testAllCandidatesFilteredEmitsNoViableHold(): Promise<void> {
  const { runner } = createHarness();
  const nowMs = 1_773_318_900_000;
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const tick = makeTick(nowMs);
    (runner as any).selector = {
      select: async ({ tick: selectorTick }: { tick: Btc5mTick }) => ({
        tick: selectorTick,
        attemptedSlugs: [selectorTick.currentSlug, selectorTick.nextSlug, selectorTick.prevSlug],
        candidatesBeforeFilter: 3,
        candidatesAfterFilter: 0,
        droppedExtreme: 2,
        droppedWideSpread: 1,
        droppedInvalid: 0,
        selected: null,
        reason: "NO_VIABLE_CANDIDATE_AFTER_FILTER"
      }),
      isSideBookUnavailable: () => false,
      markSideBookUnavailable: () => undefined
    };
    (runner as any).getReferencePrice = () => ({ price: 100_000, ageMs: 100, ts: nowMs, source: "TEST" });
    await (runner as any).processCycle(true);

    assert((runner as any).state.selectedSlug === null, "no-viable: selectedSlug should be null");
    assert((runner as any).state.selectedTokenId === null, "no-viable: selectedTokenId should be null");
    assert((runner as any).state.action === "HOLD", "no-viable: action should be HOLD");
    assert(
      (runner as any).state.blockedBy === "NO_VIABLE_CANDIDATE_AFTER_FILTER",
      "no-viable: blockedBy should be NO_VIABLE_CANDIDATE_AFTER_FILTER"
    );
    assert(
      (runner as any).state.holdReason === "NO_VIABLE_CANDIDATE_AFTER_FILTER",
      "no-viable: holdReason should be NO_VIABLE_CANDIDATE_AFTER_FILTER"
    );
    assert((runner as any).state.candidatesBeforeFilter === 3, "no-viable: candidatesBeforeFilter mismatch");
    assert((runner as any).state.candidatesAfterFilter === 0, "no-viable: candidatesAfterFilter mismatch");
    assert((runner as any).state.droppedExtreme === 2, "no-viable: droppedExtreme mismatch");
    assert((runner as any).state.droppedWideSpread === 1, "no-viable: droppedWideSpread mismatch");
    assert((runner as any).state.droppedInvalid === 0, "no-viable: droppedInvalid mismatch");
    assert(
      (runner as any).state.dispatchEligibilityReason === null,
      "no-viable: dispatchEligibilityReason should remain null on pre-dispatch selection failure"
    );
    assert(
      (runner as any).state.selectionVersion > 0,
      "no-viable: selectionVersion should advance on invalidation path"
    );
    assert(
      (runner as any).state.selectionCommitEpoch === null,
      "no-viable: selectionCommitEpoch should be null when no candidate committed"
    );
  } finally {
    Date.now = originalDateNow;
  }
}

async function testSelectionVersionMismatchBlocksDispatch(): Promise<void> {
  const { runner } = createHarness();
  const nowMs = 1_773_318_905_000;
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    const tick = makeTick(nowMs);
    const selected = makeSelected(tick);
    (runner as any).selector = {
      select: async ({ tick: selectorTick }: { tick: Btc5mTick }) => ({
        tick: selectorTick,
        attemptedSlugs: [selectorTick.currentSlug, selectorTick.nextSlug, selectorTick.prevSlug],
        candidatesBeforeFilter: 1,
        candidatesAfterFilter: 1,
        droppedExtreme: 0,
        droppedWideSpread: 0,
        droppedInvalid: 0,
        selected,
        reason: "OK"
      }),
      isSideBookUnavailable: () => false,
      markSideBookUnavailable: () => undefined
    };
    (runner as any).getReferencePrice = () => ({ price: 100_000, ageMs: 100, ts: nowMs, source: "TEST" });
    (runner as any).resolveDirectionalIntelligence = () => ({
      source: "TEST",
      posture: "TEST",
      score: 0.5,
      pUpModel: 0.55,
      fallbackUsed: false
    });
    (runner as any).gate = {
      evaluate: () => makeDecision(tick, { action: "BUY_YES", chosenSide: "YES" })
    };
    (runner as any).maybeDispatchProfitTake = async () => null;
    let dispatchCalls = 0;
    (runner as any).dispatchExecutionAttempt = async () => {
      dispatchCalls += 1;
      return { action: "BUY_YES", blocker: null };
    };
    (runner as any).validateSelectionForDispatch = async () => {
      (runner as any).selectionVersion += 1; // introduce mismatch after start version capture
      return {
        tick,
        selected,
        dispatchEligibilityReason: "ELIGIBLE_CURRENT",
        reselectionTriggered: false,
        handoffWaitTriggered: false
      };
    };

    await (runner as any).processCycle(true);

    assert(dispatchCalls === 0, "selection-version-mismatch: dispatch should not be called");
    assert((runner as any).state.action === "HOLD", "selection-version-mismatch: action should be HOLD");
    assert(
      (runner as any).state.blockedBy === "NEXT_BUCKET_HANDOFF_WAIT",
      "selection-version-mismatch: blockedBy should normalize to NEXT_BUCKET_HANDOFF_WAIT"
    );
    assert(
      (runner as any).state.dispatchEligibilityReason === "SELECTION_VERSION_MISMATCH",
      "selection-version-mismatch: dispatchEligibilityReason should indicate mismatch"
    );
    assert((runner as any).state.handoffWaitTriggered === true, "selection-version-mismatch: handoffWaitTriggered should be true");
  } finally {
    Date.now = originalDateNow;
  }
}

async function testBlockerNormalizationSnapshot(): Promise<void> {
  const originalMaxEntries = process.env.POLY_V2_MAX_ENTRIES_PER_WINDOW;
  const originalMaxOpenEntry = process.env.POLY_MAX_OPEN_ENTRY_ORDERS_PER_WINDOW;
  const originalPostRolloverGrace = process.env.POLY_V2_POST_ROLLOVER_GRACE_MS;
  try {
    process.env.POLY_V2_MAX_ENTRIES_PER_WINDOW = "1";
    process.env.POLY_MAX_OPEN_ENTRY_ORDERS_PER_WINDOW = "1";
    process.env.POLY_V2_POST_ROLLOVER_GRACE_MS = "6000";

    const expected = new Set<string>([
      "EXECUTION_IN_FLIGHT",
      "EXECUTION_COOLDOWN",
      "ENTRY_ATTEMPT_COOLDOWN",
      "PROFIT_TAKE_IN_FLIGHT",
      "MAX_ENTRIES_PER_WINDOW",
      "MAX_OPEN_ENTRY_ORDERS_PER_WINDOW",
      "REENTRY_WAIT_CLEAR",
      "REENTRY_COOLDOWN",
      "POST_ROLLOVER_GRACE",
      "STALE_ATTEMPT_ABORTED",
      "LIVE_PLACED_NO_FILL",
      "LIVE_EXECUTION_DISABLED"
    ]);
    const observed = new Set<string>();
    const { runner, logs, executionMock } = createHarness();
    const tick = makeTick();
    const selected = makeSelected(tick);
    const decision = makeDecision(tick);
    (runner as any).verifySideBookAvailableForExecution = async () => true;
    const collect = (value: string | null | undefined): void => {
      if (value) observed.add(value);
    };

    (runner as any).config.polymarket.liveExecutionEnabled = false;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);
    (runner as any).config.polymarket.liveExecutionEnabled = true;

    (runner as any).executionCooldownUntilTs = Date.now() + 5_000;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);
    (runner as any).executionCooldownUntilTs = 0;

    (runner as any).entryAttemptCooldownUntilTs = Date.now() + 5_000;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);
    (runner as any).entryAttemptCooldownUntilTs = 0;

    (runner as any).activeProfitTakeAttempt = {
      attemptId: "pt-1",
      executionSlug: selected.slug,
      marketId: selected.marketId,
      tokenId: selected.yesTokenId,
      side: "YES",
      shares: 1,
      bidPrice: 0.5,
      avgPrice: 0.49,
      createdTs: Date.now()
    };
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);
    (runner as any).activeProfitTakeAttempt = null;

    const state = (runner as any).getWindowEntryState(selected.slug);
    state.entries = 1;
    state.clearedSinceLastEntry = true;
    state.cooldownUntilTs = 0;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);

    state.entries = 1;
    state.clearedSinceLastEntry = false;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);

    state.entries = 1;
    state.clearedSinceLastEntry = true;
    state.cooldownUntilTs = Date.now() + 5_000;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);

    state.entries = 0;
    state.clearedSinceLastEntry = true;
    state.cooldownUntilTs = 0;
    (runner as any).lastRolloverTs = Date.now();
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);
    (runner as any).lastRolloverTs = 0;

    const inflightAttempt = makeAttempt(tick, selected, decision, {
      attemptId: "att-inflight",
      postingStarted: false,
      deadlineTs: Date.now() + 5_000
    });
    (runner as any).activeExecutionAttempt = inflightAttempt;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);
    (runner as any).activeExecutionAttempt = null;

    executionMock.openEntryOrders = 1;
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected, decision, allowExecution: true })).blocker);
    executionMock.openEntryOrders = 0;

    const nextSelected = makeSelected(tick, {
      slug: tick.nextSlug,
      selectionSource: "next_slug"
    });
    collect((await (runner as any).dispatchExecutionAttempt({ tick, selected: nextSelected, decision, allowExecution: true })).blocker);

    const noFillAttempt = makeAttempt(tick, selected, decision, {
      attemptId: "att-no-fill-snapshot",
      postingStarted: true
    });
    (runner as any).activeExecutionAttempt = noFillAttempt;
    (runner as any).maybeExecuteDecision = async () => ({ action: "HOLD", blocker: "LIVE_PLACED_NO_FILL" });
    (runner as any).startExecutionAttempt(noFillAttempt);
    await waitForRunnerTasksToDrain(runner);
    const finalBlockers = logEntries(logs, "POLY_V2_ATTEMPT_FINALIZED").map((row) => String(row.payload.blocker || ""));
    for (const blocker of finalBlockers) {
      if (blocker) observed.add(blocker);
    }

    for (const blocker of observed) {
      assert(expected.has(blocker), `blocker-normalization: unexpected blocker emitted: ${blocker}`);
    }
  } finally {
    if (originalMaxEntries === undefined) delete process.env.POLY_V2_MAX_ENTRIES_PER_WINDOW;
    else process.env.POLY_V2_MAX_ENTRIES_PER_WINDOW = originalMaxEntries;
    if (originalMaxOpenEntry === undefined) delete process.env.POLY_MAX_OPEN_ENTRY_ORDERS_PER_WINDOW;
    else process.env.POLY_MAX_OPEN_ENTRY_ORDERS_PER_WINDOW = originalMaxOpenEntry;
    if (originalPostRolloverGrace === undefined) delete process.env.POLY_V2_POST_ROLLOVER_GRACE_MS;
    else process.env.POLY_V2_POST_ROLLOVER_GRACE_MS = originalPostRolloverGrace;
  }
}

async function testSynthesizedSharedMarketIntelligenceBridge(): Promise<void> {
  const nowMs = Date.now();
  const marketIntelligence = new SharedMarketIntelligence({
    store: {
      getLatestVenueQuotes: () => [
        { venue: "coinbase", mid: 100_250, ts: nowMs - 250 },
        { venue: "binance", mid: 100_200, ts: nowMs - 150 }
      ],
      getRecentTickerSnapshots: () => []
    } as any,
    signalsEngine: {
      getLatestAggregate: () => ({
        direction: "UP",
        confidence: 0.8,
        impact: 0.7,
        ts: nowMs - 100,
        latestTs: nowMs - 100,
        state: "RISK_ON"
      })
    } as any,
    intelEngine: {
      getPosture: () => ({
        direction: "UP",
        confidence: 0.6,
        impact: 0.9,
        ts: nowMs - 80,
        state: "MOMENTUM_UP"
      })
    } as any
  });
  marketIntelligence.publishVenueBias({
    bias: "LONG",
    confidence: 0.65,
    ts: nowMs - 100,
    source: "TEST_SHARED_BIAS"
  });
  const runner = new Btc5mLiveRunner(
    makeConfig({ signalsEnabled: true, enableIntel: true }) as any,
    {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    } as any,
    {
      marketIntelligence
    }
  );

  const reference = (runner as any).getReferencePrice(nowMs);
  assert(reference.price === 100_250, `shared-intel: expected median quote 100250, got ${String(reference.price)}`);
  assert(
    reference.source === "EXTERNAL_VENUES:binance,coinbase",
    `shared-intel: unexpected source ${String(reference.source)}`
  );

  const intelligence = (runner as any).resolveDirectionalIntelligence({
    nowMs,
    referencePrice: reference.price,
    priceToBeat: 100_000,
    fallbackMid: 0.51
  });
  assert(intelligence.fallbackUsed === false, "shared-intel: expected shared intelligence path, not fallback");
  assert(
    intelligence.source === "SIGNALS_ENGINE+INTEL_ENGINE+CROSS_VENUE_BIAS",
    `shared-intel: unexpected intelligence source ${String(intelligence.source)}`
  );
  assert(intelligence.crossVenueBiasScore === 0.65, `shared-intel: expected bias score 0.65, got ${intelligence.crossVenueBiasScore}`);
}

async function testSharedMarketIntelligencePrefersFresherTickerSnapshot(): Promise<void> {
  const nowMs = Date.now();
  const marketIntelligence = new SharedMarketIntelligence({
    store: {
      getLatestVenueQuotes: () => [{ venue: "coinbase", mid: 100_250, ts: nowMs - 60_000 }],
      getRecentTickerSnapshots: () => [
        { symbol: "BTC-USD", bid: 100_090, ask: 100_110, mid: 100_100, last: 100_100, ts: nowMs - 250 }
      ]
    } as any
  });
  const runner = new Btc5mLiveRunner(
    makeConfig() as any,
    {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    } as any,
    {
      marketIntelligence
    }
  );

  const reference = (runner as any).getReferencePrice(nowMs);
  assert(reference.price === 100_100, `shared-intel-freshest: expected ticker mid 100100, got ${String(reference.price)}`);
  assert(reference.source === "TICKER_SNAPSHOT", `shared-intel-freshest: unexpected source ${String(reference.source)}`);
  assert(reference.ageMs !== null && reference.ageMs < 5_000, `shared-intel-freshest: unexpected age ${String(reference.ageMs)}`);
}

async function testPortfolioEntryPolicyBlocksExecution(): Promise<void> {
  const { runner } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, { chosenSide: "YES", action: "BUY_YES" });
  (runner as any).setPortfolioEntryPolicy({
    allowNewEntries: false,
    additionalBudgetUsd: 0,
    reason: "POLYMARKET_DAILY_LOSS_LIMIT",
    source: "TEST"
  });
  const result = await (runner as any).dispatchExecutionAttempt({
    tick,
    selected,
    decision,
    allowExecution: true
  });
  assert(result.action === "HOLD", `portfolio-gate: expected HOLD, got ${result.action}`);
  assert(
    result.blocker === "POLYMARKET_DAILY_LOSS_LIMIT",
    `portfolio-gate: unexpected blocker ${String(result.blocker)}`
  );
}

async function testUnknownOrderStateBlocksExecution(): Promise<void> {
  const { runner, executionMock } = createHarness();
  const tick = makeTick();
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, { chosenSide: "YES", action: "BUY_YES" });
  executionMock.hasUnknownOpenOrders = true;

  const result = await (runner as any).dispatchExecutionAttempt({
    tick,
    selected,
    decision,
    allowExecution: true
  });
  assert(result.action === "HOLD", `unknown-order-state: expected HOLD, got ${String(result.action)}`);
  assert(
    result.blocker === "ORDER_STATUS_UNKNOWN",
    `unknown-order-state: unexpected blocker ${String(result.blocker)}`
  );
}

function testDecisionAttributionIsPersisted(): void {
  const recorded: Array<Record<string, unknown>> = [];
  const tick = makeTick();
  const runner = new Btc5mLiveRunner(
    makeConfig() as any,
    {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    } as any,
    {
      store: {
        recordDecisionAttribution: (row: Record<string, unknown>) => recorded.push(row)
      } as any,
      marketIntelligence: new SharedMarketIntelligence({
        store: {
          getLatestVenueQuotes: () => [{ venue: "coinbase", mid: 100_100, ts: tick.tickNowMs - 200 }],
          getRecentTickerSnapshots: () => []
        } as any,
        signalsEngine: {
          getLatestAggregate: () => ({
            direction: "UP",
            confidence: 0.7,
            impact: 0.6,
            ts: tick.tickNowMs - 100,
            latestTs: tick.tickNowMs - 100,
            state: "RISK_ON",
            reasons: ["TEST_SIGNAL"]
          })
        } as any,
        intelEngine: {
          getPosture: () => ({
            direction: "UP",
            confidence: 0.55,
            impact: 0.5,
            ts: tick.tickNowMs - 50,
            state: "MOMENTUM_UP",
            widenBps: 0,
            sizeCut: 0,
            skewBps: 0,
            haltUntilTs: 0,
            reasons: ["TEST_INTEL"]
          })
        } as any
      })
    }
  );
  const selected = makeSelected(tick);
  const decision = makeDecision(tick, { chosenSide: "YES", action: "BUY_YES" });
  (runner as any).recordDecisionAttribution({
    tick,
    reference: { price: 100_100, ageMs: 250, ts: tick.tickNowMs - 250, source: "TEST_REFERENCE" },
    selected,
    intelligence: {
      source: "TEST_INTELLIGENCE",
      posture: "RISK_ON",
      score: 0.8,
      pUpModel: 0.55
    },
    decision,
    finalAction: "BUY_YES",
    finalBlocker: null
  });
  assert(recorded.length === 1, `decision-attribution: expected 1 record, got ${recorded.length}`);
  assert(recorded[0].venue === "POLYMARKET", `decision-attribution: unexpected venue ${String(recorded[0].venue)}`);
  assert(recorded[0].action === "BUY_YES", `decision-attribution: unexpected action ${String(recorded[0].action)}`);
  const details = JSON.parse(String(recorded[0].details_json || "{}")) as Record<string, unknown>;
  assert(details.schema === "decision_attribution.v1", "decision-attribution: missing schema");
  assert((details.market as Record<string, unknown>).selected_slug === selected.slug, "decision-attribution: missing slug");
}

export async function runBtc5mLiveRunnerStateMachineTests(): Promise<void> {
  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "single active attempt invariant", fn: testSingleActiveAttemptInvariant },
    { name: "scalp mode allows multiple entries after cooldown", fn: testScalpModeAllowsMultipleEntriesAfterCooldown },
    { name: "scalp mode blocks re-entry during cooldown", fn: testScalpModeReentryBlockedByCooldown },
    { name: "scalp entries capped by max entries per window", fn: testScalpEntriesCappedByMaxEntriesPerWindow },
    { name: "scalp TP1/TP2 exits realize pnl", fn: testScalpProfitTakeTp1AndTp2RealizePnl },
    { name: "scalp max-hold exit fires", fn: testScalpProfitTakeMaxHoldExit },
    { name: "rollover stale cleanup", fn: testRolloverStaleHandling },
    { name: "rollover preserves attempt already targeting new bucket", fn: testRolloverPreservesAttemptAlreadyTargetingNewBucket },
    { name: "superseded selection cleanup", fn: testSupersededSelectionHandling },
    { name: "deadline exceeded before post", fn: testDeadlineExceededBeforePost },
    { name: "deadline exceeded after posting started", fn: testDeadlineExceededAfterPostingStarted },
    { name: "stale-after-post path normalization", fn: testStaleAfterPostPath },
    { name: "live placed no fill path", fn: testLivePlacedNoFillPath },
    { name: "manual stop path", fn: testManualStopPath },
    { name: "profit take in-flight gating", fn: testProfitTakeInflightGating },
    { name: "next-bucket handoff wait prevents dispatch", fn: testNextBucketHandoffWaitPreventsDispatch },
    { name: "next-bucket preselection dispatches before handoff wait", fn: testNextBucketPreselectionDispatchesBeforeHandoffWait },
    { name: "next-bucket attempt remains active before handoff", fn: testNextBucketAttemptRemainsActiveBeforeHandoff },
    { name: "stale selection triggers reselection", fn: testStaleSelectionTriggersReselection },
    { name: "late current selection reselects next bucket before gate", fn: testLateCurrentSelectionReselectsNextBucketBeforeGate },
    { name: "current bucket dispatch remains eligible above configured min entry", fn: testCurrentBucketDispatchRemainsEligibleAboveConfiguredMinEntry },
    { name: "dispatch reselection timeout fails fast", fn: testDispatchReselectionTimeoutFailsFast },
    { name: "advisory attribution throttle still allows minimum executable ticket", fn: testAdvisoryAttributionThrottleStillAllowsMinimumExecutableTicket },
    { name: "next bucket preselection skips redundant reselection", fn: testNextBucketPreselectionSkipsRedundantReselection },
    { name: "fresh selection ignores prior discovery stale warning", fn: testFreshSelectionIgnoresPriorDiscoveryStaleWarning },
    { name: "dispatch execution preserves stale oracle blocker", fn: testDispatchExecutionAttemptPreservesStaleOracleBlocker },
    { name: "dispatch execution uses selected executable book without reprobe", fn: testDispatchExecutionUsesSelectedExecutableBookWithoutReprobe },
    { name: "process cycle refreshes reference after slow selection", fn: testProcessCycleRefreshesReferenceAfterSlowSelection },
    { name: "validated path avoids expired window abort", fn: testValidatedPathAvoidsExpiredWindowAbortReason },
    { name: "all candidates filtered emits no-viable hold", fn: testAllCandidatesFilteredEmitsNoViableHold },
    { name: "selection version mismatch blocks dispatch", fn: testSelectionVersionMismatchBlocksDispatch },
    { name: "blocker normalization snapshot", fn: testBlockerNormalizationSnapshot },
    { name: "shared intelligence bridge", fn: testSynthesizedSharedMarketIntelligenceBridge },
    { name: "shared intelligence prefers fresher ticker snapshot", fn: testSharedMarketIntelligencePrefersFresherTickerSnapshot },
    { name: "portfolio entry policy blocks execution", fn: testPortfolioEntryPolicyBlocksExecution },
    { name: "unknown order state blocks execution", fn: testUnknownOrderStateBlocksExecution },
    { name: "decision attribution is persisted", fn: async () => testDecisionAttributionIsPersisted() }
  ];

  for (const test of tests) {
    await test.fn();
  }
  // eslint-disable-next-line no-console
  console.log("Btc5mLiveRunnerStateMachine tests: PASS");
}

if (require.main === module) {
  void runBtc5mLiveRunnerStateMachineTests().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
