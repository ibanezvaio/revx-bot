import { BotConfig, loadConfig } from "../config";
import { NewsSnapshot } from "../news/types";
import { NewsGuard } from "../strategy/NewsGuard";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function buildConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base = loadConfig();
  return {
    ...base,
    newsEnabled: true,
    newsMinConf: 0.6,
    newsPauseImpact: 0.85,
    newsPauseSeconds: 2,
    newsSpreadMult: 0.8,
    newsSizeCutMult: 0.6,
    intelPauseImpactThreshold: 0.97,
    intelPauseConfidenceThreshold: 0.75,
    intelPausePersistenceSeconds: 2,
    ...overrides
  };
}

function snapshot(
  ts: number,
  impact: number,
  direction: "UP" | "DOWN" | "NEUTRAL",
  confidence: number
): NewsSnapshot {
  return {
    ts,
    items: [
      {
        id: "h1",
        ts,
        title: "headline",
        source: "source",
        url: "https://example.test",
        tags: [],
        symbols: ["BTC"],
        category: "macro",
        impact,
        direction,
        confidence
      }
    ],
    aggregate: {
      impact,
      direction,
      confidence,
      categoryCounts: {
        macro: 1,
        war: 0,
        rates: 0,
        crypto: 0,
        regulation: 0,
        exchange: 0,
        outage: 0,
        other: 0
      }
    }
  };
}

function run(): void {
  const cfg = buildConfig();
  const guard = new NewsGuard(cfg);
  const ts = Date.now();

  const pending = guard.evaluate({
    ts,
    snapshot: snapshot(ts, 0.99, "DOWN", 0.9),
    regime: "CALM",
    adverseState: "NORMAL",
    inventoryRatio: 0.2
  });
  assert(pending.state !== "PAUSE", `expected non-PAUSE pending state, got ${pending.state}`);
  assert(!pending.pauseMakers, "pending pause should not pause makers");

  const pause = guard.evaluate({
    ts: ts + 2_200,
    snapshot: snapshot(ts + 2_200, 0.99, "DOWN", 0.9),
    regime: "CALM",
    adverseState: "NORMAL",
    inventoryRatio: 0.2
  });
  assert(pause.state === "PAUSE", `expected PAUSE, got ${pause.state}`);
  assert(pause.pauseMakers, "pause state should pause makers");
  assert(pause.allowTakerFlattenOnly, "pause state should allow taker flatten only");

  const cooldown = guard.evaluate({
    ts: ts + 2_700,
    snapshot: snapshot(ts + 2_700, 0.2, "NEUTRAL", 0.2),
    regime: "CALM",
    adverseState: "NORMAL",
    inventoryRatio: 0.2
  });
  assert(cooldown.state === "PAUSE", `expected cooldown PAUSE, got ${cooldown.state}`);
  assert(cooldown.cooldownRemainingSeconds >= 1, "cooldown should still be active");

  const riskOff = guard.evaluate({
    ts: ts + 4_800,
    snapshot: snapshot(ts + 4_800, 0.5, "DOWN", 0.8),
    regime: "CALM",
    adverseState: "NORMAL",
    inventoryRatio: 0.3
  });
  assert(riskOff.state === "RISK_OFF", `expected RISK_OFF, got ${riskOff.state}`);
  assert(riskOff.allowBuy === false, "risk-off with long inventory should gate buys");
  assert(riskOff.spreadMult > 1, "risk-off should widen spread");
  assert(riskOff.sizeMult < 1, "risk-off should reduce quote size");

  // eslint-disable-next-line no-console
  console.log("NewsGuard tests: PASS");
}

run();
