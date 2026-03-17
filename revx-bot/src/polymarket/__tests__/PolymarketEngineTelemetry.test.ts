import { loadConfig } from "../../config";
import { evaluateEntryPriceGate, PolymarketEngine, resolvePriorityBlockedReason } from "../PolymarketEngine";
import { deriveBtc5mTickContext } from "../btc5m";
import { computePolymarketEffectiveSizingBasis } from "../sizingMinimums";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeLogger(lines: string[]): {
  info: (payload: unknown, msg?: string) => void;
  warn: (payload: unknown, msg?: string) => void;
  error: (payload: unknown, msg?: string) => void;
  debug: (payload: unknown, msg?: string) => void;
} {
  const capture = (payload: unknown, msg?: string): void => {
    if (typeof payload === "string") {
      lines.push(payload);
      return;
    }
    if (typeof msg === "string") {
      lines.push(msg);
    }
  };
  return {
    info: capture,
    warn: capture,
    error: capture,
    debug: capture
  };
}

function makeBaseTickLine(nowTs: number): Record<string, unknown> {
  return {
    marketsSeen: 0,
    activeWindows: 0,
    now: new Date(nowTs).toISOString(),
    currentMarketId: null,
    tauSec: null,
    priceToBeat: null,
    oracleEst: null,
    sigma: null,
    yesBid: null,
    yesAsk: null,
    pUpModel: null,
    edge: null,
    threshold: null,
    action: "HOLD",
    size: null,
    openTrades: 0,
    resolvedTrades: 0,
    selectedSlug: null,
    windowStart: null,
    windowEnd: null,
    acceptingOrders: null,
    enableOrderBook: null,
    holdReason: "NO_WINDOWS"
  };
}

export async function runPolymarketEngineTelemetryTests(): Promise<void> {
  const previousMinSharesRequired = process.env.POLYMARKET_MIN_SHARES_REQUIRED;
  const previousLiveMinVenueShares = process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES;
  const previousMaxEntryPrice = process.env.POLYMARKET_MAX_ENTRY_PRICE;
  const previousExtremeReselectTicks = process.env.POLYMARKET_EXTREME_RESELECT_TICKS;
  const previousExtremeReselectCooldownSec = process.env.POLYMARKET_EXTREME_RESELECT_COOLDOWN_SEC;
  const previousSizingFeeBufferBps = process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS;
  const lines: string[] = [];
  const config = loadConfig();
  const engine = new PolymarketEngine(config, makeLogger(lines) as any);
  const engineAny = engine as any;
  const nowTs = Date.now();
  const resolvedDefaultEntryPriceConfig = evaluateEntryPriceGate({ chosenSidePriceUsed: null }).maxEntryPriceConfig.toFixed(4);
  try {
    process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS = "30";
    // Required telemetry keys must always exist in POLY_STATUS with deterministic defaults.
    engineAny.emitPolyStatusLine(makeBaseTickLine(nowTs), nowTs);
    const baseStatusLine = [...lines].reverse().find((line) => line.startsWith("POLY_STATUS"));
    assert(Boolean(baseStatusLine), "expected POLY_STATUS line for base telemetry case");
    assert(baseStatusLine!.includes("selectionVersion=0"), "expected selectionVersion default");
    assert(baseStatusLine!.includes("reselectionTriggered=false"), "expected reselectionTriggered default");
    assert(baseStatusLine!.includes("handoffWaitTriggered=false"), "expected handoffWaitTriggered default");
    assert(baseStatusLine!.includes("dispatchEligibilityReason=-"), "expected dispatchEligibilityReason default");
    assert(baseStatusLine!.includes("candidatesBeforeFilter=0"), "expected candidatesBeforeFilter default");
    assert(baseStatusLine!.includes("candidatesAfterFilter=0"), "expected candidatesAfterFilter default");
    assert(baseStatusLine!.includes("droppedExtreme=0"), "expected droppedExtreme default");
    assert(baseStatusLine!.includes("droppedWideSpread=0"), "expected droppedWideSpread default");
    assert(baseStatusLine!.includes("droppedInvalid=0"), "expected droppedInvalid default");
    assert(baseStatusLine!.includes("consecutiveExtremeTicks=0"), "expected consecutiveExtremeTicks default");
    assert(baseStatusLine!.includes("extremeReselectThreshold=0"), "expected extremeReselectThreshold default");
    assert(baseStatusLine!.includes("extremeReselectTriggered=false"), "expected extremeReselectTriggered default");
    assert(
      baseStatusLine!.includes("extremeReselectCooldownSecRemaining=0"),
      "expected extremeReselectCooldownSecRemaining default"
    );
    assert(baseStatusLine!.includes("extremeReselectTokenId=-"), "expected extremeReselectTokenId default");
    assert(baseStatusLine!.includes("scalpModeActive=false"), "expected scalpModeActive default false");
    assert(baseStatusLine!.includes("entriesInWindow=0"), "expected entriesInWindow default 0");
    assert(baseStatusLine!.includes("exitsInWindow=0"), "expected exitsInWindow default 0");
    assert(baseStatusLine!.includes("reentryCooldownSec=0"), "expected reentryCooldownSec default 0");
    assert(baseStatusLine!.includes("reentryEligibleNow=false"), "expected reentryEligibleNow default false");
    assert(baseStatusLine!.includes("lastExitReason=-"), "expected lastExitReason default '-'");
    assert(baseStatusLine!.includes("timeInPositionSec=0"), "expected timeInPositionSec default 0");
    assert(
      baseStatusLine!.includes(`maxEntryPriceConfig=${resolvedDefaultEntryPriceConfig}`),
      "expected maxEntryPriceConfig resolved default"
    );
    assert(baseStatusLine!.includes("entryPriceGateHit=false"), "expected entryPriceGateHit default false");
    assert(baseStatusLine!.includes("entryPriceGateValue=-"), "expected entryPriceGateValue default dash");
    assert(baseStatusLine!.includes("entryPriceGateDelta=0.0000"), "expected entryPriceGateDelta default 0");
    assert(
      baseStatusLine!.includes("requiredNotionalForMinValidSize=0.0000"),
      "expected requiredNotionalForMinValidSize default 0"
    );
    assert(baseStatusLine!.includes("minValidSizeEffective=0.000000"), "expected minValidSizeEffective default 0");
    assert(
      baseStatusLine!.includes("minValidCostUsdEffective=0.0000"),
      "expected minValidCostUsdEffective default 0"
    );
    assert(baseStatusLine!.includes("minValidSize=0.000000"), "expected minValidSize default 0");
    assert(baseStatusLine!.includes("minValidCostUsd=0.0000"), "expected minValidCostUsd default 0");
    assert(baseStatusLine!.includes("notionalAutoStepped=false"), "expected notionalAutoStepped default false");
    assert(baseStatusLine!.includes("originalTargetNotional=0.0000"), "expected originalTargetNotional default 0");
    assert(baseStatusLine!.includes("adjustedTargetNotional=0.0000"), "expected adjustedTargetNotional default 0");
    assert(baseStatusLine!.includes("affordabilityGapNotional=0.0000"), "expected affordabilityGapNotional default 0");

    process.env.POLYMARKET_EXTREME_RESELECT_TICKS = "3";
    process.env.POLYMARKET_EXTREME_RESELECT_COOLDOWN_SEC = "20";
    const extremeTick1 = engineAny.evaluateExtremeReselectState({
      nowTs,
      selectedSlug: "btc-updown-5m-1770000000",
      selectedTokenId: "token-a",
      selectionVersion: 7,
      extremeCondition: true,
      handoffWaitActive: false
    });
    const extremeTick2 = engineAny.evaluateExtremeReselectState({
      nowTs: nowTs + 1_000,
      selectedSlug: "btc-updown-5m-1770000000",
      selectedTokenId: "token-a",
      selectionVersion: 7,
      extremeCondition: true,
      handoffWaitActive: false
    });
    const extremeTick3 = engineAny.evaluateExtremeReselectState({
      nowTs: nowTs + 2_000,
      selectedSlug: "btc-updown-5m-1770000000",
      selectedTokenId: "token-a",
      selectionVersion: 7,
      extremeCondition: true,
      handoffWaitActive: false
    });
    assert(extremeTick1.consecutiveExtremeTicks === 1, "expected first extreme tick count");
    assert(extremeTick2.consecutiveExtremeTicks === 2, "expected second extreme tick count");
    assert(extremeTick3.consecutiveExtremeTicks === 3, "expected threshold extreme tick count");
    assert(extremeTick3.extremeReselectTriggered === true, "expected extreme reselection trigger at threshold");
    assert(extremeTick3.shouldClearSelection === true, "expected clear-selection flag at threshold");
    assert(
      extremeTick3.extremeReselectCooldownSecRemaining >= 19,
      "expected cooldown to start after threshold trigger"
    );

    const suppressedByCooldown = engineAny.evaluateExtremeReselectState({
      nowTs: nowTs + 3_000,
      selectedSlug: "btc-updown-5m-1770000000",
      selectedTokenId: "token-a",
      selectionVersion: 7,
      extremeCondition: true,
      handoffWaitActive: false
    });
    assert(
      suppressedByCooldown.extremeReselectTriggered === false,
      "expected cooldown to suppress immediate re-trigger"
    );
    assert(
      suppressedByCooldown.extremeReselectCooldownSecRemaining > 0,
      "expected cooldown remaining after suppression"
    );

    const resetOnClear = engineAny.evaluateExtremeReselectState({
      nowTs: nowTs + 4_000,
      selectedSlug: "btc-updown-5m-1770000000",
      selectedTokenId: "token-a",
      selectionVersion: 7,
      extremeCondition: false,
      handoffWaitActive: false
    });
    assert(resetOnClear.consecutiveExtremeTicks === 0, "expected counter reset when extreme condition clears");

    const resetOnTokenChange = engineAny.evaluateExtremeReselectState({
      nowTs: nowTs + 5_000,
      selectedSlug: "btc-updown-5m-1770000000",
      selectedTokenId: "token-b",
      selectionVersion: 7,
      extremeCondition: true,
      handoffWaitActive: false
    });
    assert(resetOnTokenChange.consecutiveExtremeTicks === 1, "expected fresh count after token change");
    assert(resetOnTokenChange.extremeReselectTokenId === "token-b", "expected new token tracked after change");

    const resetOnHandoff = engineAny.evaluateExtremeReselectState({
      nowTs: nowTs + 6_000,
      selectedSlug: "btc-updown-5m-1770000000",
      selectedTokenId: "token-b",
      selectionVersion: 7,
      extremeCondition: true,
      handoffWaitActive: true
    });
    assert(resetOnHandoff.consecutiveExtremeTicks === 0, "expected counter reset during handoff wait");
    assert(resetOnHandoff.extremeReselectTriggered === false, "expected no trigger during handoff wait");

    lines.length = 0;
    engineAny.emitPolyStatusLine(
      {
        ...makeBaseTickLine(nowTs + 650),
        holdReason: "EXTREME_STUCK_RESELECT",
        blockedBy: "EXTREME_STUCK_RESELECT",
        selectedSlug: null,
        selectedTokenId: null,
        consecutiveExtremeTicks: 3,
        extremeReselectThreshold: 3,
        extremeReselectTriggered: true,
        extremeReselectCooldownSecRemaining: 20,
        extremeReselectTokenId: "token-a"
      },
      nowTs + 650
    );
    const extremeStatusLine = [...lines].reverse().find((line) => line.startsWith("POLY_STATUS"));
    assert(Boolean(extremeStatusLine), "expected POLY_STATUS line for extreme reselection case");
    assert(extremeStatusLine!.includes("selectedSlug=-"), "expected selectedSlug dash after extreme reselection");
    assert(extremeStatusLine!.includes("blockedBy=EXTREME_STUCK_RESELECT"), "expected extreme blocker in status");
    assert(extremeStatusLine!.includes("consecutiveExtremeTicks=3"), "expected extreme tick counter in status");
    assert(extremeStatusLine!.includes("extremeReselectTriggered=true"), "expected extreme trigger in status");
    assert(
      extremeStatusLine!.includes("extremeReselectCooldownSecRemaining=20"),
      "expected extreme cooldown telemetry in status"
    );
    assert(extremeStatusLine!.includes("extremeReselectTokenId=token-a"), "expected extreme token telemetry in status");

    // Scalp status fields should emit non-default values when provided by runtime state.
    lines.length = 0;
    engineAny.emitPolyStatusLine(
      {
        ...makeBaseTickLine(nowTs + 500),
        scalpModeActive: true,
        entriesInWindow: 2,
        exitsInWindow: 1,
        reentryCooldownSec: 8,
        reentryEligibleNow: true,
        lastExitReason: "TP1",
        timeInPositionSec: 14
      },
      nowTs + 500
    );
    const scalpStatusLine = [...lines].reverse().find((line) => line.startsWith("POLY_STATUS"));
    assert(Boolean(scalpStatusLine), "expected POLY_STATUS line for scalp telemetry case");
    assert(scalpStatusLine!.includes("scalpModeActive=true"), "expected scalpModeActive=true");
    assert(scalpStatusLine!.includes("entriesInWindow=2"), "expected entriesInWindow=2");
    assert(scalpStatusLine!.includes("exitsInWindow=1"), "expected exitsInWindow=1");
    assert(scalpStatusLine!.includes("reentryCooldownSec=8"), "expected reentryCooldownSec=8");
    assert(scalpStatusLine!.includes("reentryEligibleNow=true"), "expected reentryEligibleNow=true");
    assert(scalpStatusLine!.includes("lastExitReason=TP1"), "expected lastExitReason=TP1");
    assert(scalpStatusLine!.includes("timeInPositionSec=14"), "expected timeInPositionSec=14");

    process.env.POLYMARKET_MAX_ENTRY_PRICE = "0.70";
    const blockedPriceGate = evaluateEntryPriceGate({
      chosenSidePriceUsed: 0.81
    });
    assert(blockedPriceGate.entryPriceGateHit === true, "expected entry price gate hit above cap");
    assert(Math.abs(blockedPriceGate.entryPriceGateDelta - 0.11) < 1e-9, "expected entry price gate delta above cap");

    const passPriceGate = evaluateEntryPriceGate({
      chosenSidePriceUsed: 0.7
    });
    assert(passPriceGate.entryPriceGateHit === false, "expected entry price gate pass at cap");
    assert(Math.abs(passPriceGate.entryPriceGateDelta) < 1e-9, "expected zero delta at cap");

    lines.length = 0;
    engineAny.emitPolyStatusLine(
      {
        ...makeBaseTickLine(nowTs + 750),
        holdReason: "ENTRY_PRICE_TOO_HIGH",
        blockedBy: "ENTRY_PRICE_TOO_HIGH",
        chosenSidePriceUsed: 0.81,
        maxEntryPriceConfig: 0.7,
        entryPriceGateHit: true,
        entryPriceGateValue: 0.81,
        entryPriceGateDelta: 0.11
      },
      nowTs + 750
    );
    const entryPriceBlockedLine = [...lines].reverse().find((line) => line.startsWith("POLY_STATUS"));
    assert(Boolean(entryPriceBlockedLine), "expected POLY_STATUS line for entry-price gate case");
    assert(entryPriceBlockedLine!.includes("blockedBy=ENTRY_PRICE_TOO_HIGH"), "expected ENTRY_PRICE_TOO_HIGH blockedBy");
    assert(entryPriceBlockedLine!.includes("holdReason=ENTRY_PRICE_TOO_HIGH"), "expected ENTRY_PRICE_TOO_HIGH holdReason");
    assert(entryPriceBlockedLine!.includes("maxEntryPriceConfig=0.7000"), "expected maxEntryPriceConfig telemetry");
    assert(entryPriceBlockedLine!.includes("entryPriceGateHit=true"), "expected entryPriceGateHit=true");
    assert(entryPriceBlockedLine!.includes("entryPriceGateValue=0.8100"), "expected entryPriceGateValue telemetry");
    assert(entryPriceBlockedLine!.includes("entryPriceGateDelta=0.1100"), "expected entryPriceGateDelta telemetry");

    // Empty filtered set must surface explicit HOLD semantics and dash selected fields.
    lines.length = 0;
    engineAny.emitPolyStatusLine(
      {
        ...makeBaseTickLine(nowTs + 1_000),
        holdReason: "NO_VIABLE_CANDIDATE_AFTER_FILTER",
        blockedBy: "NO_VIABLE_CANDIDATE_AFTER_FILTER",
        candidatesBeforeFilter: 3,
        candidatesAfterFilter: 0,
        droppedExtreme: 2,
        droppedWideSpread: 1,
        droppedInvalid: 0
      },
      nowTs + 1_000
    );
    const filteredEmptyLine = [...lines].reverse().find((line) => line.startsWith("POLY_STATUS"));
    assert(Boolean(filteredEmptyLine), "expected POLY_STATUS line for empty-filter case");
    assert(filteredEmptyLine!.includes("selectedSlug=-"), "expected selectedSlug dash when no viable candidate");
    assert(filteredEmptyLine!.includes("selectedTokenId=-"), "expected selectedTokenId dash when no viable candidate");
    assert(
      filteredEmptyLine!.includes("holdReason=NO_VIABLE_CANDIDATE_AFTER_FILTER"),
      "expected NO_VIABLE_CANDIDATE_AFTER_FILTER holdReason"
    );
    assert(
      filteredEmptyLine!.includes("blockedBy=NO_VIABLE_CANDIDATE_AFTER_FILTER"),
      "expected NO_VIABLE_CANDIDATE_AFTER_FILTER blockedBy"
    );
    assert(filteredEmptyLine!.includes("candidatesBeforeFilter=3"), "expected candidatesBeforeFilter telemetry");
    assert(filteredEmptyLine!.includes("candidatesAfterFilter=0"), "expected candidatesAfterFilter telemetry");

    process.env.POLYMARKET_MIN_SHARES_REQUIRED = "5";
    process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = "5";
    const liveConfig = {
      ...config,
      polymarket: {
        ...config.polymarket,
        mode: "live",
        sizing: {
          ...config.polymarket.sizing,
          maxNotionalPerWindow: 5,
          minOrderNotional: 0.25,
          minSharesRequired: 5
        }
      }
    } as typeof config;
    const sizingLines: string[] = [];
    const sizingEngine = new PolymarketEngine(liveConfig, makeLogger(sizingLines) as any) as any;
    const steppedExpected = computePolymarketEffectiveSizingBasis({
      enabled: true,
      orderPrice: 0.52,
      minVenueShares: 5,
      minVenueNotionalUsd: 0.25,
      feeBufferBps: 30
    });

    // requiredNotionalForMinValidSize + step-up success path when within caps.
    const steppedSizing = sizingEngine.evaluateOrderSizingCheck({
      marketId: "m-step",
      chosenSide: "YES",
      orderPrice: 0.52,
      requestedBudget: 2.0,
      computedShares: null,
      maxAllowedNotionalForThisDecision: 5.0
    });
    assert(
      Math.abs(Number(steppedSizing.minValidSize) - 5) < 1e-9,
      "expected minValidSize=5"
    );
    assert(
      Math.abs(Number(steppedSizing.minValidCostUsd) - steppedExpected.minValidCostUsdEffective) < 1e-9,
      `expected minValidCostUsd=${String(steppedExpected.minValidCostUsdEffective)}`
    );
    assert(
      Math.abs(Number(steppedSizing.requiredNotionalForMinValidSize) - steppedExpected.minValidCostUsdEffective) < 1e-9,
      `expected requiredNotionalForMinValidSize=${String(steppedExpected.minValidCostUsdEffective)}`
    );
    assert(steppedSizing.notionalAutoStepped === true, "expected notionalAutoStepped=true within cap");
    assert(Math.abs(Number(steppedSizing.originalTargetNotional) - 2.0) < 1e-9, "expected originalTargetNotional=2.0");
    assert(
      Math.abs(Number(steppedSizing.adjustedTargetNotional) - steppedExpected.minValidCostUsdEffective) < 1e-9,
      `expected adjustedTargetNotional=${String(steppedExpected.minValidCostUsdEffective)}`
    );
    assert(
      Math.abs(Number(steppedSizing.finalNotional) - steppedExpected.minValidCostUsdEffective) < 1e-9,
      `expected finalNotional=${String(steppedExpected.minValidCostUsdEffective)}`
    );
    assert(Math.abs(Number(steppedSizing.finalShares) - 5) < 1e-9, "expected finalShares=5");
    assert(steppedSizing.passes === true, "expected stepped sizing to pass");
    assert(Math.abs(Number(steppedSizing.minValidSizeEffective) - 5) < 1e-9, "expected minValidSizeEffective=5");
    assert(
      Math.abs(Number(steppedSizing.minValidCostUsdEffective) - steppedExpected.minValidCostUsdEffective) < 1e-9,
      `expected minValidCostUsdEffective=${String(steppedExpected.minValidCostUsdEffective)}`
    );
    assert(
      Math.abs(Number(steppedSizing.minValidPriceBasis) - steppedExpected.minValidPriceBasis) < 1e-9,
      `expected minValidPriceBasis=${String(steppedExpected.minValidPriceBasis)}`
    );

    // explicit affordability blocker path when required min-valid notional exceeds allowed notional.
    const unaffordableSizing = sizingEngine.evaluateOrderSizingCheck({
      marketId: "m-unaffordable",
      chosenSide: "YES",
      orderPrice: 0.52,
      requestedBudget: 2.0,
      computedShares: null,
      maxAllowedNotionalForThisDecision: 2.0
    });
    assert(
      unaffordableSizing.sizingRejectReason === "MIN_VALID_SIZE_UNAFFORDABLE",
      "expected MIN_VALID_SIZE_UNAFFORDABLE reject reason"
    );
    const sizingRejectLine = [...sizingLines].reverse().find((line) => line.startsWith("POLY_ORDER_SIZING_REJECT"));
    assert(Boolean(sizingRejectLine), "expected POLY_ORDER_SIZING_REJECT line for unaffordable case");
    assert(
      sizingRejectLine!.includes("minValidSizeEffective=5.000000"),
      "expected reject log minValidSizeEffective=5"
    );
    assert(
      sizingRejectLine!.includes(`minValidPriceBasis=${steppedExpected.minValidPriceBasis.toFixed(4)}`),
      `expected reject log minValidPriceBasis=${steppedExpected.minValidPriceBasis.toFixed(4)}`
    );
    assert(
      sizingRejectLine!.includes(`minValidCostUsdEffective=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`),
      `expected reject log minValidCostUsdEffective=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`
    );
    assert(
      sizingRejectLine!.includes("sizingRejectReason=MIN_VALID_SIZE_UNAFFORDABLE"),
      "expected reject log sizing reason"
    );
    assert(Math.abs(Number(unaffordableSizing.minValidSize) - 5) < 1e-9, "expected minValidSize=5 in reject path");
    assert(
      Math.abs(Number(unaffordableSizing.minValidCostUsd) - steppedExpected.minValidCostUsdEffective) < 1e-9,
      `expected minValidCostUsd=${String(steppedExpected.minValidCostUsdEffective)} in reject path`
    );
    assert(
      Math.abs(Number(unaffordableSizing.minValidSizeEffective) - 5) < 1e-9,
      "expected minValidSizeEffective=5 in reject path"
    );
    assert(
      Math.abs(Number(unaffordableSizing.minValidCostUsdEffective) - steppedExpected.minValidCostUsdEffective) < 1e-9,
      `expected minValidCostUsdEffective=${String(steppedExpected.minValidCostUsdEffective)} in reject path`
    );
    assert(Math.abs(Number(unaffordableSizing.maxAllowedNotionalForThisDecision) - 2.0) < 1e-9, "expected maxAllowedNotional telemetry");
    assert(
      Math.abs(Number(unaffordableSizing.affordabilityGapNotional) - (steppedExpected.minValidCostUsdEffective - 2.0)) < 1e-9,
      `expected affordability gap telemetry=${String(steppedExpected.minValidCostUsdEffective - 2.0)}`
    );
    const prioritized = resolvePriorityBlockedReason({
      currentReason: "EDGE_BELOW_THRESHOLD",
      fairPriceSource: "MODEL",
      extremePriceFilterHit: false,
      dislocationAbs: 0.1,
      minDislocationConfig: 0.03,
      sizingRejectReason: "MIN_VALID_SIZE_UNAFFORDABLE",
      configFeasible: true
    });
    assert(prioritized === "MIN_VALID_SIZE_UNAFFORDABLE", "expected explicit affordability blocker priority");

    lines.length = 0;
    engineAny.emitPolyStatusLine(
      {
        ...makeBaseTickLine(nowTs + 1_500),
        holdReason: "MIN_VALID_SIZE_UNAFFORDABLE",
        blockedBy: "MIN_VALID_SIZE_UNAFFORDABLE",
        sizingRejectReason: "MIN_VALID_SIZE_UNAFFORDABLE",
        minValidPriceBasis: steppedExpected.minValidPriceBasis,
        minValidSizeEffective: 5,
        minValidCostUsdEffective: steppedExpected.minValidCostUsdEffective,
        minValidSize: 5,
        minValidCostUsd: steppedExpected.minValidCostUsdEffective,
        requiredNotionalForMinValidSize: steppedExpected.minValidCostUsdEffective,
        affordableShares: 3.846154,
        finalSize: 3.846154,
        originalTargetNotional: 2.0,
        adjustedTargetNotional: 2.0,
        affordabilityGapNotional: steppedExpected.minValidCostUsdEffective - 2.0,
        notionalAutoStepped: false
      },
      nowTs + 1_500
    );
    const affordabilityLine = [...lines].reverse().find((line) => line.startsWith("POLY_STATUS"));
    assert(Boolean(affordabilityLine), "expected POLY_STATUS line for affordability reject case");
    assert(affordabilityLine!.includes("blockedBy=MIN_VALID_SIZE_UNAFFORDABLE"), "expected explicit affordability blocker");
    assert(affordabilityLine!.includes("sizingRejectReason=MIN_VALID_SIZE_UNAFFORDABLE"), "expected sizingRejectReason telemetry");
    assert(
      affordabilityLine!.includes(`minValidPriceBasis=${steppedExpected.minValidPriceBasis.toFixed(4)}`),
      `expected minValidPriceBasis telemetry=${steppedExpected.minValidPriceBasis.toFixed(4)}`
    );
    assert(
      affordabilityLine!.includes("minValidSizeEffective=5.000000"),
      "expected minValidSizeEffective telemetry"
    );
    assert(
      affordabilityLine!.includes(`minValidCostUsdEffective=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`),
      `expected minValidCostUsdEffective telemetry=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`
    );
    assert(affordabilityLine!.includes("minValidSize=5.000000"), "expected minValidSize telemetry");
    assert(
      affordabilityLine!.includes(`minValidCostUsd=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`),
      `expected minValidCostUsd telemetry=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`
    );
    assert(
      affordabilityLine!.includes(`requiredNotionalForMinValidSize=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`),
      `expected requiredNotionalForMinValidSize telemetry=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`
    );
    assert(
      affordabilityLine!.includes(`affordabilityGapNotional=${(steppedExpected.minValidCostUsdEffective - 2.0).toFixed(4)}`),
      `expected affordabilityGapNotional telemetry=${(steppedExpected.minValidCostUsdEffective - 2.0).toFixed(4)}`
    );
    assert(
      affordabilityLine!.includes(`minValidSizeEffective=${steppedExpected.minValidSizeEffective.toFixed(6)}`) &&
        sizingRejectLine!.includes(`minValidSizeEffective=${steppedExpected.minValidSizeEffective.toFixed(6)}`),
      "expected POLY_STATUS and POLY_ORDER_SIZING_REJECT to share minValidSizeEffective"
    );
    assert(
      affordabilityLine!.includes(`minValidCostUsdEffective=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`) &&
        sizingRejectLine!.includes(`minValidCostUsdEffective=${steppedExpected.minValidCostUsdEffective.toFixed(4)}`),
      "expected POLY_STATUS and POLY_ORDER_SIZING_REJECT to share minValidCostUsdEffective"
    );

    // minValidSize=1 path remains unchanged.
    process.env.POLYMARKET_MIN_SHARES_REQUIRED = "1";
    process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = "1";
    const oneShareConfig = {
      ...config,
      polymarket: {
        ...config.polymarket,
        mode: "live",
        sizing: {
          ...config.polymarket.sizing,
          maxNotionalPerWindow: 5,
          minOrderNotional: 0.25,
          minSharesRequired: 1
        }
      }
    } as typeof config;
    const oneShareLines: string[] = [];
    const oneShareEngine = new PolymarketEngine(oneShareConfig, makeLogger(oneShareLines) as any) as any;
    const oneShareExpected = computePolymarketEffectiveSizingBasis({
      enabled: true,
      orderPrice: 0.52,
      minVenueShares: 1,
      minVenueNotionalUsd: 0.25,
      feeBufferBps: 30
    });
    const unchangedSizing = oneShareEngine.evaluateOrderSizingCheck({
      marketId: "m-one-share",
      chosenSide: "YES",
      orderPrice: 0.52,
      requestedBudget: 2.0,
      computedShares: null,
      maxAllowedNotionalForThisDecision: 5.0
    });
    assert(Math.abs(Number(unchangedSizing.minValidSize) - 1) < 1e-9, "expected minValidSize=1 for one-share path");
    assert(
      Math.abs(Number(unchangedSizing.minValidCostUsd) - oneShareExpected.minValidCostUsdEffective) < 1e-9,
      `expected minValidCostUsd=${String(oneShareExpected.minValidCostUsdEffective)}`
    );
    assert(
      Math.abs(Number(unchangedSizing.minValidSizeEffective) - 1) < 1e-9,
      "expected minValidSizeEffective=1 for one-share path"
    );
    assert(
      Math.abs(Number(unchangedSizing.minValidCostUsdEffective) - oneShareExpected.minValidCostUsdEffective) < 1e-9,
      `expected minValidCostUsdEffective=${String(oneShareExpected.minValidCostUsdEffective)}`
    );
    assert(
      Math.abs(Number(unchangedSizing.requiredNotionalForMinValidSize) - oneShareExpected.minValidCostUsdEffective) < 1e-9,
      `expected requiredNotionalForMinValidSize=${String(oneShareExpected.minValidCostUsdEffective)}`
    );
    assert(unchangedSizing.notionalAutoStepped === false, "expected no auto-step when target already covers one share");
    assert(
      !oneShareLines.some((line) => line.startsWith("POLY_ORDER_SIZING_REJECT")),
      "expected no reject log for one-share passing case"
    );

    // Normal tick progression should not emit false POLY_CLOCK_DRIFT_BUG.
    lines.length = 0;
    const tick = deriveBtc5mTickContext(nowTs);
    engineAny.maybeEmitTickLog({
      ...makeBaseTickLine(nowTs),
      now: new Date(tick.tickNowMs).toISOString(),
      canonicalTickMs: tick.tickNowMs,
      canonicalTickSec: tick.tickNowSec,
      currentBucketSlug: tick.currentSlug,
      nextBucketSlug: tick.nextSlug,
      tauSec: tick.remainingSec,
      remainingSecSource: "MARKET_WINDOW"
    });
    const nextTick = deriveBtc5mTickContext(nowTs + 2_000);
    engineAny.maybeEmitTickLog({
      ...makeBaseTickLine(nowTs + 2_000),
      now: new Date(nextTick.tickNowMs).toISOString(),
      canonicalTickMs: nextTick.tickNowMs,
      canonicalTickSec: nextTick.tickNowSec,
      currentBucketSlug: nextTick.currentSlug,
      nextBucketSlug: nextTick.nextSlug,
      tauSec: Math.max(0, nextTick.remainingSec - 1),
      remainingSecSource: "MARKET_WINDOW"
    });
    assert(!lines.some((line) => line === "POLY_CLOCK_DRIFT_BUG"), "unexpected POLY_CLOCK_DRIFT_BUG on normal progression");

    // eslint-disable-next-line no-console
    console.log("PolymarketEngineTelemetry tests: PASS");
  } finally {
    if (previousExtremeReselectTicks === undefined) {
      delete process.env.POLYMARKET_EXTREME_RESELECT_TICKS;
    } else {
      process.env.POLYMARKET_EXTREME_RESELECT_TICKS = previousExtremeReselectTicks;
    }
    if (previousExtremeReselectCooldownSec === undefined) {
      delete process.env.POLYMARKET_EXTREME_RESELECT_COOLDOWN_SEC;
    } else {
      process.env.POLYMARKET_EXTREME_RESELECT_COOLDOWN_SEC = previousExtremeReselectCooldownSec;
    }
    if (previousMaxEntryPrice === undefined) {
      delete process.env.POLYMARKET_MAX_ENTRY_PRICE;
    } else {
      process.env.POLYMARKET_MAX_ENTRY_PRICE = previousMaxEntryPrice;
    }
    if (previousMinSharesRequired === undefined) {
      delete process.env.POLYMARKET_MIN_SHARES_REQUIRED;
    } else {
      process.env.POLYMARKET_MIN_SHARES_REQUIRED = previousMinSharesRequired;
    }
    if (previousLiveMinVenueShares === undefined) {
      delete process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES;
    } else {
      process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = previousLiveMinVenueShares;
    }
    if (previousSizingFeeBufferBps === undefined) {
      delete process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS;
    } else {
      process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS = previousSizingFeeBufferBps;
    }
  }
}

if (require.main === module) {
  void runPolymarketEngineTelemetryTests();
}
