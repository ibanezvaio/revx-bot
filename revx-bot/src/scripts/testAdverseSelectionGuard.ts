import { loadConfig, BotConfig } from "../config";
import { AdverseSelectionGuard } from "../strategy/AdverseSelectionGuard";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function buildConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base = loadConfig();
  return {
    ...base,
    adverseDecay: 0,
    adverseMinFills: 1,
    adverseStateThresholdsCsv: "0.35,0.55,0.75,0.90",
    adverseToxicMarkoutBps: -4,
    adverseMarkoutWindowsMs: [5000, 15000, 60000],
    ...overrides
  };
}

function run(): void {
  const cfg = buildConfig();
  const guard = new AdverseSelectionGuard(cfg);
  const ts = Date.now();

  const normal = guard.update({
    ts,
    regime: "CALM",
    confidence: 0.8,
    basisBps: 0.5,
    driftBps: 0.4,
    asAvgBps: 2,
    asBadRate: 0.1,
    asSamples: 10,
    cancels1h: 5,
    rejects1h: 1,
    markouts: []
  });
  assert(normal.state === "NORMAL", `expected NORMAL, got ${normal.state}`);

  const widen = guard.update({
    ts: ts + 1000,
    regime: "VOLATILE",
    confidence: 0.75,
    basisBps: 8,
    driftBps: 6,
    asAvgBps: -5,
    asBadRate: 0.65,
    asSamples: 12,
    cancels1h: 35,
    rejects1h: 8,
    markouts: [
      { ts, side: "BUY", fillMid: 100, futureMid: 99.93, windowMs: 5000, markoutBps: -7 },
      { ts, side: "SELL", fillMid: 100, futureMid: 100.05, windowMs: 15000, markoutBps: -5 }
    ]
  });
  assert(widen.state === "WIDEN" || widen.state === "REDUCE", `expected WIDEN/REDUCE, got ${widen.state}`);

  const pause = guard.update({
    ts: ts + 2000,
    regime: "VOLATILE",
    confidence: 0.7,
    basisBps: 25,
    driftBps: 20,
    asAvgBps: -20,
    asBadRate: 1,
    asSamples: 20,
    cancels1h: 120,
    rejects1h: 40,
    markouts: [
      { ts, side: "BUY", fillMid: 100, futureMid: 99.85, windowMs: 5000, markoutBps: -15 },
      { ts, side: "SELL", fillMid: 100, futureMid: 100.16, windowMs: 15000, markoutBps: -16 },
      { ts, side: "BUY", fillMid: 100, futureMid: 99.82, windowMs: 60000, markoutBps: -18 }
    ]
  });
  assert(pause.state === "PAUSE" || pause.state === "HEDGE", `expected PAUSE/HEDGE, got ${pause.state}`);

  // eslint-disable-next-line no-console
  console.log("AdverseSelectionGuard transition test: PASS");
}

run();
