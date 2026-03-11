import path from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { LagProfiler } from "../LagProfiler";
import { runBtc5mSelectorV2Tests } from "./Btc5mSelectorV2.test";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const logPath = path.join(tmpdir(), `revx-lag-profiler-${Date.now()}.jsonl`);
  rmSync(logPath, { force: true });
  const profiler = new LagProfiler({
    maxSamples: 5,
    logPath,
    fastEventBps: 8,
    bookConfirmBps: 4
  });

  // ring buffer bounds + partial safety
  for (let i = 0; i < 10; i += 1) {
    profiler.record({
      tsMs: 1_000 + i * 1_000,
      windowSlug: "test-window",
      fastMid: 100 + i * 0.01,
      oraclePrice: 100 + i * 0.01,
      oracleUpdatedAtMs: 1_000 + i * 1_000,
      yesBid: 0.4,
      yesAsk: 0.5,
      yesMid: 0.45,
      pModel: 0.5
    });
  }
  profiler.record({});
  const recent = profiler.getRecent(100);
  assert(recent.length <= 5, `expected bounded ring buffer <=5, got ${recent.length}`);

  // deterministic percentile sanity for poly update age
  const p = new LagProfiler({ maxSamples: 20, logPath: `${logPath}.2` });
  p.record({ tsMs: 1000, windowSlug: "w", yesMid: 0.5 });
  p.record({ tsMs: 2000, windowSlug: "w", yesMid: 0.5 });
  p.record({ tsMs: 3000, windowSlug: "w", yesMid: 0.5 });
  const stats = p.getStats();
  assert(
    Number(stats.metrics.polyUpdateAgeMs.p50) >= 900 && Number(stats.metrics.polyUpdateAgeMs.p50) <= 1100,
    `unexpected polyUpdateAge p50=${stats.metrics.polyUpdateAgeMs.p50}`
  );
  assert(
    Number(stats.metrics.polyUpdateAgeMs.p90) >= 1700 && Number(stats.metrics.polyUpdateAgeMs.p90) <= 2100,
    `unexpected polyUpdateAge p90=${stats.metrics.polyUpdateAgeMs.p90}`
  );

  // event-based lag detection
  const e = new LagProfiler({
    maxSamples: 20,
    logPath: `${logPath}.3`,
    fastEventBps: 8,
    bookConfirmBps: 4
  });
  e.record({ tsMs: 10_000, windowSlug: "w", fastMid: 100.0, yesMid: 0.50 });
  e.record({ tsMs: 11_000, windowSlug: "w", fastMid: 100.09, yesMid: 0.50 }); // +9 bps fast event
  e.record({ tsMs: 11_600, windowSlug: "w", fastMid: 100.09, yesMid: 0.5003 }); // +6 bps book follow
  const es = e.getStats();
  assert(es.metrics.bookMoveLagMs.count >= 1, "expected at least one detected bookMoveLagMs event");
  assert(
    Number(es.metrics.bookMoveLagMs.p50) >= 500 && Number(es.metrics.bookMoveLagMs.p50) <= 700,
    `expected lag around 600ms, got ${es.metrics.bookMoveLagMs.p50}`
  );

  rmSync(logPath, { force: true });
  rmSync(`${logPath}.2`, { force: true });
  rmSync(`${logPath}.3`, { force: true });
  await runBtc5mSelectorV2Tests();
  // eslint-disable-next-line no-console
  console.log("LagProfiler tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
