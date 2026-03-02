import {
  AdverseSelectionTracker,
  computeAsBps,
  rollingStats,
  toxicDecision,
  updateDefenseState
} from "../strategy/adverseSelection";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function approx(actual: number, expected: number, tolerance: number, message: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}. actual=${actual} expected=${expected}`);
  }
}

function testComputeAsBps(): void {
  const buy = computeAsBps({ side: "BUY", fillMid: 100, futureMid: 100.2 });
  approx(buy, 20, 0.0001, "BUY as_bps should be positive when future rises");
  const sell = computeAsBps({ side: "SELL", fillMid: 100, futureMid: 100.2 });
  approx(sell, -20, 0.0001, "SELL as_bps should be negative when future rises");
}

function testRollingStats(): void {
  const stats = rollingStats(
    [
      { ts: 1, bps: -10 },
      { ts: 2, bps: -5 },
      { ts: 3, bps: 4 },
      { ts: 4, bps: 8 }
    ],
    4,
    -6
  );
  approx(stats.as_avg_bps, -0.75, 0.0001, "avg bps should be computed correctly");
  approx(stats.as_bad_rate, 0.25, 0.0001, "bad rate should count values <= threshold");
  approx(stats.as_last_bps || 0, 8, 0.0001, "last bps should be latest sample");
  assert(stats.as_samples === 4, "sample count should match");
}

function testToxicDecisionOrThreshold(): void {
  const toxicByAvgOnly = toxicDecision(
    {
      as_avg_bps: -7,
      as_bad_rate: 0.1,
      as_last_bps: -9,
      as_samples: 12
    },
    4,
    0.55,
    5
  );
  assert(toxicByAvgOnly.as_toxic, "toxic decision should trigger if avg is toxic even when bad rate is low");

  const toxicByRateOnly = toxicDecision(
    {
      as_avg_bps: 1,
      as_bad_rate: 0.8,
      as_last_bps: -1,
      as_samples: 12
    },
    4,
    0.55,
    5
  );
  assert(toxicByRateOnly.as_toxic, "toxic decision should trigger if bad rate is toxic even when avg is not");

  const safe = toxicDecision(
    {
      as_avg_bps: -2,
      as_bad_rate: 0.2,
      as_last_bps: -1,
      as_samples: 12
    },
    4,
    0.55,
    5
  );
  assert(!safe.as_toxic, "toxic decision should be false for healthy stats");
}

function testDefenseStateCooldownAndDecay(): void {
  const start = updateDefenseState({
    nowTs: 1_000,
    toxic: true,
    currentWidenBps: 0,
    currentCooldownUntilTs: 0,
    lastDecayTs: 0,
    config: {
      widenStepBps: 2,
      maxWidenBps: 10,
      cooldownSeconds: 120,
      decayBpsPerMin: 1
    }
  });
  assert(start.widenBps === 2, "toxic state should increase widen by step");
  assert(start.cooldownRemainingSeconds >= 119, "toxic state should set cooldown");

  const decayed = updateDefenseState({
    nowTs: start.cooldownUntilTs + 120_000,
    toxic: false,
    currentWidenBps: start.widenBps,
    currentCooldownUntilTs: start.cooldownUntilTs,
    lastDecayTs: start.lastDecayTs,
    config: {
      widenStepBps: 2,
      maxWidenBps: 10,
      cooldownSeconds: 120,
      decayBpsPerMin: 1
    }
  });
  assert(decayed.widenBps < start.widenBps, "widen should decay after cooldown");
}

function testTrackerIngestAndTick(): void {
  const tracker = new AdverseSelectionTracker({
    enabled: true,
    horizonSeconds: 10,
    sampleFills: 60,
    badAvgBps: 4,
    badRate: 0.55,
    badFillBps: -6,
    widenStepBps: 2,
    maxWidenBps: 10,
    cooldownSeconds: 120,
    decayBpsPerMin: 1
  });

  tracker.ingestFill({
    id: "o1:t1",
    ts: 1_000,
    side: "BUY",
    fillMid: 100
  });

  let summary = tracker.onTick({ ts: 5_000, latestMid: 101 });
  assert(summary.as_samples === 0, "sample should not settle before horizon");

  summary = tracker.onTick({ ts: 12_000, latestMid: 99.7 });
  assert(summary.as_samples === 1, "sample should settle after horizon");
  assert(summary.as_last_bps !== null, "last bps should be present after settlement");
}

function run(): void {
  testComputeAsBps();
  testRollingStats();
  testToxicDecisionOrThreshold();
  testDefenseStateCooldownAndDecay();
  testTrackerIngestAndTick();
  // eslint-disable-next-line no-console
  console.log("AdverseSelection tests: PASS");
}

run();
