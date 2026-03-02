import { parseBalancesPayload, getAssetCandidates, findAsset } from "../recon/balanceParsing";
import { buildQuotePlan } from "../strategy/MakerStrategy";
import { computeSeedState } from "../strategy/inventorySeeding";
import { QuoteInputs } from "../strategy/QuoteDebugState";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testBalanceAliasing(): void {
  const now = Date.now();
  const parsed = parseBalancesPayload(
    [
      { asset: "XBT", free: "0.000000000002", total: "0.000000000002", timestamp: now },
      { asset: "USD", free: "10", total: "10", timestamp: now },
      { asset: "USDC", free: "5", total: "5", timestamp: now }
    ],
    now
  );

  const btc = parsed.snapshots.find((row) => row.asset === "BTC") ?? null;
  const usd = parsed.snapshots.find((row) => row.asset === "USD") ?? null;
  const usdc = parsed.snapshots.find((row) => row.asset === "USDC") ?? null;

  assert(btc !== null, "XBT should normalize into BTC");
  assert((btc?.total ?? 0) > 1e-12, "tiny BTC amounts above 1e-12 must be preserved");
  assert(usd !== null && usdc !== null, "USD and USDC should remain separate snapshots");

  const baseAliases = getAssetCandidates("BTC", "base");
  const quoteAliases = getAssetCandidates("USD", "quote");
  assert(baseAliases.includes("XBT"), "BTC base aliases should include XBT");
  assert(quoteAliases.includes("USDC"), "USD quote reporting aliases should include USDC");

  const detectedBase = findAsset(parsed.snapshots, baseAliases);
  const detectedQuote = findAsset(parsed.snapshots, quoteAliases);
  assert(detectedBase?.asset === "BTC", "base alias detection should resolve BTC");
  assert(detectedQuote?.asset === "USD", "quote detection should prefer USD when present");
}

function makeInputs(btcNotionalUsd: number, btcTotal: number): QuoteInputs {
  return {
    ts: Date.now(),
    symbol: "BTC-USD",
    mid: 100_000,
    bid: 99_900,
    ask: 100_100,
    marketSpreadBps: 20,
    volMoveBps: 0.5,
    trendMoveBps: 0,
    usdFree: 200,
    usdTotal: 200,
    btcFree: btcTotal,
    btcTotal,
    btcNotionalUsd,
    inventoryRatio: 0,
    config: {
      levels: 2,
      enableTopOfBook: false,
      minInsideSpreadBps: 2,
      minVolMoveBpsToQuote: 5,
      volProtectMode: "block",
      cashReserveUsd: 40,
      workingCapUsd: 200,
      targetBtcNotionalUsd: 80,
      lowBtcGateUsd: 60,
      maxActionsPerLoop: 4,
      maxBtcNotionalUsd: 120,
      seedForceTob: true
    }
  };
}

function testSeedTransitions(): void {
  const seed = computeSeedState(makeInputs(20, 0.0002), {
    lowBtcGateUsd: 60,
    targetBtcNotionalUsd: 80,
    maxBtcNotionalUsd: 120
  });
  assert(seed.mode === "SEED_BUY", "below low gate should enter SEED_BUY");

  const healthy = computeSeedState(makeInputs(80, 0.0008), {
    lowBtcGateUsd: 60,
    targetBtcNotionalUsd: 80,
    maxBtcNotionalUsd: 120
  });
  assert(healthy.mode === "TWO_SIDED", "near target should be TWO_SIDED");

  const rebalance = computeSeedState(makeInputs(180, 0.0018), {
    lowBtcGateUsd: 60,
    targetBtcNotionalUsd: 80,
    maxBtcNotionalUsd: 120
  });
  assert(rebalance.mode === "REBALANCE", "above max notional should be REBALANCE");

  const seededPlan = buildQuotePlan({
    inputs: makeInputs(20, 0.0002),
    buyLevels: 2,
    sellLevels: 2,
    tobMode: "OFF",
    blockedReasons: []
  });
  assert(seededPlan.seedMode === "SEED_BUY", "quote plan should carry SEED_BUY mode");
  assert(seededPlan.tob === "BUY", "SEED_BUY should force TOB BUY when seedForceTob=true");
  assert(seededPlan.quoteEnabled, "SEED_BUY should remain enabled even when VOL_PROTECT_MODE=block");
  assert(
    !seededPlan.blockedReasons.some((row) => row.includes("VOL_WIDEN_APPLIED")),
    "SEED_BUY should bypass VOL_WIDEN_APPLIED gating"
  );
}

function main(): void {
  testBalanceAliasing();
  testSeedTransitions();
  // eslint-disable-next-line no-console
  console.log("Balance aliasing and seeding tests passed.");
}

main();
