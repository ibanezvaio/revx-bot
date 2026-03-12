import { deriveBtc5mTickContext } from "../btc5m";
import { Btc5mLiveRunner } from "../live/Btc5mLiveRunner";
import { Btc5mDecision, Btc5mSelectedMarket, Btc5mTick } from "../live/Btc5mTypes";

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
        oracleHardBlockMs: 30_000
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
    openEntryOrders: 0
  };

  (runner as any).execution = {
    cancelAll: async () => {
      executionMock.cancelAllCalls += 1;
    },
    cancelUnfilledEntryOrders: async () => ({ requestedCount: 1, cancelledCount: 1 }),
    countOpenEntryOrdersForMarket: () => executionMock.openEntryOrders,
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
  while ((runner as any).activeExecutionTask && Date.now() - start < timeoutMs) {
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

export async function runBtc5mLiveRunnerStateMachineTests(): Promise<void> {
  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "single active attempt invariant", fn: testSingleActiveAttemptInvariant },
    { name: "rollover stale cleanup", fn: testRolloverStaleHandling },
    { name: "superseded selection cleanup", fn: testSupersededSelectionHandling },
    { name: "deadline exceeded before post", fn: testDeadlineExceededBeforePost },
    { name: "deadline exceeded after posting started", fn: testDeadlineExceededAfterPostingStarted },
    { name: "stale-after-post path normalization", fn: testStaleAfterPostPath },
    { name: "live placed no fill path", fn: testLivePlacedNoFillPath },
    { name: "manual stop path", fn: testManualStopPath },
    { name: "profit take in-flight gating", fn: testProfitTakeInflightGating },
    { name: "next-bucket handoff wait prevents dispatch", fn: testNextBucketHandoffWaitPreventsDispatch },
    { name: "stale selection triggers reselection", fn: testStaleSelectionTriggersReselection },
    { name: "validated path avoids expired window abort", fn: testValidatedPathAvoidsExpiredWindowAbortReason },
    { name: "all candidates filtered emits no-viable hold", fn: testAllCandidatesFilteredEmitsNoViableHold },
    { name: "selection version mismatch blocks dispatch", fn: testSelectionVersionMismatchBlocksDispatch },
    { name: "blocker normalization snapshot", fn: testBlockerNormalizationSnapshot }
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
