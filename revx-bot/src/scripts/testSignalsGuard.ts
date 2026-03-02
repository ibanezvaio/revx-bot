import { BotConfig, loadConfig } from "../config";
import { SignalsGuard } from "../strategy/SignalsGuard";
import { SignalAggregate } from "../signals/types";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base = loadConfig();
  return {
    ...base,
    signalsPauseImpact: 0.9,
    signalsMinConf: 0.6,
    signalsPauseSeconds: 2,
    signalsSpreadMult: 0.8,
    signalsSizeCutMult: 0.6,
    intelPauseImpactThreshold: 0.97,
    intelPauseConfidenceThreshold: 0.75,
    intelPausePersistenceSeconds: 2,
    ...overrides
  };
}

function agg(
  state: SignalAggregate["state"],
  impact: number,
  direction: SignalAggregate["direction"],
  confidence: number
): SignalAggregate {
  return {
    ts: Date.now(),
    impact,
    direction,
    confidence,
    state,
    reasons: [],
    latestTs: Date.now(),
    counts: {}
  };
}

function run(): void {
  const cfg = makeConfig();
  const guard = new SignalsGuard(cfg);
  const now = Date.now();

  const pending = guard.evaluate({
    ts: now,
    aggregate: agg("PAUSE", 0.99, "DOWN", 0.9),
    inventoryRatio: 0.2,
    allowTakerFlatten: true
  });
  assert(!pending.pauseMakers, "pending pause should not pause makers");

  const paused = guard.evaluate({
    ts: now + 2_200,
    aggregate: agg("PAUSE", 0.99, "DOWN", 0.9),
    inventoryRatio: 0.2,
    allowTakerFlatten: true
  });
  assert(paused.pauseMakers, "pause should pause makers");
  assert(paused.allowTakerFlattenOnly, "pause should allow flatten only");

  const riskOff = guard.evaluate({
    ts: now + 4_800,
    aggregate: agg("RISK_OFF", 0.8, "DOWN", 0.8),
    inventoryRatio: 0.3,
    allowTakerFlatten: true
  });
  assert(riskOff.spreadMultExtra > 1, "risk-off should widen spread");
  assert(riskOff.sizeMultExtra < 1, "risk-off should cut size");
  assert(riskOff.gateBuy === true, "risk-off with long inventory should gate buys");

  const normal = guard.evaluate({
    ts: now + 6_000,
    aggregate: agg("NORMAL", 0.1, "NEUTRAL", 0.4),
    inventoryRatio: 0,
    allowTakerFlatten: true
  });
  assert(!normal.pauseMakers, "normal should not pause");
  assert(normal.spreadMultExtra >= 1, "spread mult should remain valid");
  // eslint-disable-next-line no-console
  console.log("SignalsGuard tests: PASS");
}

run();
