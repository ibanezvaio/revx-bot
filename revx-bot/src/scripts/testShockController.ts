import { MarketShockController } from "../strategy/MarketShockController";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const controller = new MarketShockController({
    shockEnterBps: 30,
    shockSpreadBps: 6,
    shockDispersionBps: 12,
    baselineSpreadBps: 2,
    shockMinSeconds: 5,
    reentryNoNewLowSeconds: 10,
    recoveryDispersionBps: 4,
    recoveryPersistSeconds: 8
  });

  const baseTs = Date.now();
  const shocked = controller.update({
    ts: baseTs,
    revxMid: 100,
    revxBid: 99.99,
    revxAsk: 100.01,
    spreadBps: 5,
    vol1mBps: 45,
    vol5mBps: 40,
    shockVolPeakBps: 45,
    newLowInWindow: true,
    dispersionBps: 8,
    bookDepthScore: 0.8
  });
  assert(shocked.phase === "SHOCK", "high vol should enter SHOCK");

  const cooldown = controller.update({
    ts: baseTs + 6_000,
    revxMid: 100.1,
    revxBid: 100.09,
    revxAsk: 100.11,
    spreadBps: 3,
    vol1mBps: 10,
    vol5mBps: 18,
    shockVolPeakBps: 45,
    newLowInWindow: false,
    dispersionBps: 5,
    bookDepthScore: 1.1
  });
  assert(cooldown.phase === "COOLDOWN", "after min shock duration should enter COOLDOWN");

  const stabilizingPending = controller.update({
    ts: baseTs + 12_000,
    revxMid: 100.2,
    revxBid: 100.19,
    revxAsk: 100.21,
    spreadBps: 2,
    vol1mBps: 6,
    vol5mBps: 10,
    shockVolPeakBps: 45,
    newLowInWindow: false,
    dispersionBps: 3,
    bookDepthScore: 1
  });
  assert(stabilizingPending.phase === "COOLDOWN", "needs persistence before STABILIZING");

  const stabilizing = controller.update({
    ts: baseTs + 23_000,
    revxMid: 100.25,
    revxBid: 100.24,
    revxAsk: 100.26,
    spreadBps: 2,
    vol1mBps: 5,
    vol5mBps: 8,
    shockVolPeakBps: 45,
    newLowInWindow: false,
    dispersionBps: 2,
    bookDepthScore: 1
  });
  assert(stabilizing.phase === "STABILIZING", "normalized persistence should enter STABILIZING");

  const recoveryPending = controller.update({
    ts: baseTs + 33_000,
    revxMid: 100.3,
    revxBid: 100.29,
    revxAsk: 100.31,
    spreadBps: 1.8,
    vol1mBps: 4.5,
    vol5mBps: 7.9,
    shockVolPeakBps: 45,
    newLowInWindow: false,
    dispersionBps: 1.5,
    bookDepthScore: 1.1
  });
  assert(recoveryPending.phase === "STABILIZING", "recovery requires persistence window");

  const recoveryPending2 = controller.update({
    ts: baseTs + 42_000,
    revxMid: 100.32,
    revxBid: 100.31,
    revxAsk: 100.33,
    spreadBps: 1.7,
    vol1mBps: 4.2,
    vol5mBps: 7.6,
    shockVolPeakBps: 45,
    newLowInWindow: false,
    dispersionBps: 1.4,
    bookDepthScore: 1.15
  });
  assert(
    recoveryPending2.phase === "STABILIZING" || recoveryPending2.phase === "RECOVERY",
    "recovery should remain stable while persistence accrues"
  );

  const recovery = controller.update({
    ts: baseTs + 52_000,
    revxMid: 100.34,
    revxBid: 100.33,
    revxAsk: 100.35,
    spreadBps: 1.6,
    vol1mBps: 4.0,
    vol5mBps: 7.2,
    shockVolPeakBps: 45,
    newLowInWindow: false,
    dispersionBps: 1.3,
    bookDepthScore: 1.2
  });
  assert(recovery.phase === "RECOVERY", "stable/low-dispersion persistence should enter RECOVERY");

  // eslint-disable-next-line no-console
  console.log("Market phase controller transitions: PASS");
}

run();
