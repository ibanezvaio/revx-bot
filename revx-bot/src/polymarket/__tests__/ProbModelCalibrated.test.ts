import { loadConfig } from "../../config";
import { ProbModel } from "../ProbModel";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const model = new ProbModel(loadConfig());

  const boosted = model.computeExpiryProbCalibrated({
    fastMid: 101_200,
    priceToBeat: 100_000,
    sigmaPricePerSqrtSec: 20,
    tauSec: 45,
    polyUpdateAgeMs: 2_000,
    lagPolyP90Ms: 1_000,
    oracleAgeMs: 150
  });
  assert(boosted.boostApplied, "expected boost to apply for late/extreme/lagged case");
  assert(
    boosted.pBoosted >= boosted.pBase,
    "expected upward-or-capped boost when z>0"
  );
  assert(boosted.pBoosted - boosted.pBase <= 0.030001, "boost must be capped at 0.03");

  const noTauBoost = model.computeExpiryProbCalibrated({
    fastMid: 100_400,
    priceToBeat: 100_000,
    sigmaPricePerSqrtSec: 20,
    tauSec: 240,
    polyUpdateAgeMs: 2_000,
    lagPolyP90Ms: 1_000,
    oracleAgeMs: 150
  });
  assert(!noTauBoost.boostApplied, "expected no boost when tauSec > 120");

  const noExtremeBoost = model.computeExpiryProbCalibrated({
    fastMid: 100_010,
    priceToBeat: 100_000,
    sigmaPricePerSqrtSec: 200,
    tauSec: 60,
    polyUpdateAgeMs: 3_000,
    lagPolyP90Ms: 1_000,
    oracleAgeMs: 150
  });
  assert(!noExtremeBoost.boostApplied, "expected no boost when |z| is not extreme");

  const stable = model.computeExpiryProbCalibrated({
    fastMid: 100_000,
    priceToBeat: 100_000,
    sigmaPricePerSqrtSec: 0,
    tauSec: 0,
    polyUpdateAgeMs: 0,
    lagPolyP90Ms: 0,
    oracleAgeMs: 0
  });
  assert(Number.isFinite(stable.pBase), "pBase must be finite");
  assert(Number.isFinite(stable.pBoosted), "pBoosted must be finite");
  assert(stable.pBase >= 0.0005 && stable.pBase <= 0.9995, "pBase bounds violated");
  assert(stable.pBoosted >= 0.0005 && stable.pBoosted <= 0.9995, "pBoosted bounds violated");

  // eslint-disable-next-line no-console
  console.log("ProbModel calibrated tests: PASS");
}

run();
