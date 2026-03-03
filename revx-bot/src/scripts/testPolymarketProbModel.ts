import { BotConfig, loadConfig } from "../config";
import { ProbModel } from "../polymarket/ProbModel";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function approx(actual: number, expected: number, tolerance: number, message: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message} (actual=${actual}, expected=${expected}, tolerance=${tolerance})`);
  }
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base = loadConfig();
  return {
    ...base,
    polymarket: {
      ...base.polymarket,
      vol: {
        ...base.polymarket.vol,
        minSigmaBps: 1
      }
    },
    ...overrides
  };
}

function run(): void {
  const model = new ProbModel(makeConfig());

  const atStrike = model.compute({
    oracleEst: 100_000,
    priceToBeat: 100_000,
    sigmaPricePerSqrtSec: 50,
    tauSec: 60
  });
  approx(atStrike.pUpModel, 0.5, 0.02, "pUp should be near 0.5 at strike");

  const bullish = model.compute({
    oracleEst: 100_100,
    priceToBeat: 100_000,
    sigmaPricePerSqrtSec: 25,
    tauSec: 120
  });
  const bearish = model.compute({
    oracleEst: 99_900,
    priceToBeat: 100_000,
    sigmaPricePerSqrtSec: 25,
    tauSec: 120
  });

  assert(bullish.pUpModel > 0.5, `expected bullish pUp > 0.5, got ${bullish.pUpModel}`);
  assert(bearish.pUpModel < 0.5, `expected bearish pUp < 0.5, got ${bearish.pUpModel}`);
  assert(
    bullish.pUpModel > bearish.pUpModel,
    "bullish scenario should have higher probability than bearish scenario"
  );

  const instant = model.computeFromSigma({
    oracleEst: 100_020,
    priceToBeat: 100_000,
    sigmaPrice: 10
  });
  assert(instant.pUpModel > 0.5, `expected computeFromSigma to be bullish, got ${instant.pUpModel}`);
  assert(instant.tauEffSec === 1, `expected computeFromSigma tauEffSec=1, got ${instant.tauEffSec}`);

  const adaptiveBullish = model.computeAdaptive({
    oracleEst: 100_050,
    priceToBeat: 100_000,
    tauSec: 180,
    cadenceSec: 300,
    shortReturn: 0.0012,
    realizedVolPricePerSqrtSec: 18
  });
  const adaptiveBearish = model.computeAdaptive({
    oracleEst: 99_950,
    priceToBeat: 100_000,
    tauSec: 180,
    cadenceSec: 300,
    shortReturn: -0.0012,
    realizedVolPricePerSqrtSec: 18
  });
  assert(
    adaptiveBullish.pUpModel > adaptiveBearish.pUpModel,
    "adaptive model should rank bullish scenario above bearish scenario"
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket ProbModel tests: PASS");
}

run();
