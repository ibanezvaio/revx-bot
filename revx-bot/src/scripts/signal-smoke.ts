import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { CrossVenueSignalEngine } from "../signal/CrossVenueSignalEngine";
import { sleep } from "../util/time";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config);
  const engine = new CrossVenueSignalEngine(config, logger);
  const loops = 10;
  let revxMid = 50_000;

  // eslint-disable-next-line no-console
  console.log(`Running cross-venue signal smoke for ${loops} iterations...`);

  for (let i = 0; i < loops; i += 1) {
    revxMid *= 1 + (Math.random() - 0.5) * 0.0004;
    const result = await engine.compute(config.symbol, revxMid, Date.now());

    // eslint-disable-next-line no-console
    console.log(
      `[${i + 1}/${loops}] global=${fmt(result.signal.global_mid)} fair=${fmt(
        result.signal.fair_mid
      )} basis=${fmt(result.signal.basis_bps, 2)}bps drift=${fmt(
        result.signal.drift_bps,
        2
      )}bps stdev=${fmt(result.signal.stdev_bps, 2)}bps conf=${fmt(
        result.signal.confidence,
        3
      )} regime=${result.signal.vol_regime}`
    );

    // eslint-disable-next-line no-console
    console.table(
      result.venues.map((venue) => ({
        venue: venue.venue,
        ok: venue.ok && !venue.stale,
        stale: venue.stale,
        age_ms: venue.age_ms,
        mid: venue.mid,
        spread_bps: venue.spread_bps,
        latency_ms: venue.latency_ms,
        weight: venue.weight,
        error: venue.error ?? ""
      }))
    );

    if (i < loops - 1) {
      await sleep(config.venueRefreshMs);
    }
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Signal smoke failed:", error);
  process.exit(1);
});

function fmt(value: number, dp = 4): string {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(dp);
}

