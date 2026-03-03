import { BotConfig } from "../config";
import { ProbInput, ProbOutput } from "./types";

export class ProbModel {
  constructor(private readonly config: BotConfig) {}

  compute(input: ProbInput): ProbOutput {
    const tauEffSec = Math.max(1, input.tauSec);
    const sigmaMin = Math.max(
      this.config.polymarket.vol.minSigmaBps / 10_000 * Math.max(input.oracleEst, 1),
      1e-8
    );
    const sigmaPricePerSqrtSec = Math.max(sigmaMin, input.sigmaPricePerSqrtSec);
    const sigmaEffPrice = sigmaPricePerSqrtSec * Math.sqrt(tauEffSec);

    if (!(sigmaEffPrice > 0)) {
      return {
        pUpModel: input.oracleEst > input.priceToBeat ? 1 : input.oracleEst < input.priceToBeat ? 0 : 0.5,
        zScore: 0,
        sigmaEffPrice: sigmaMin,
        tauEffSec
      };
    }

    const zScore = (input.oracleEst - input.priceToBeat) / sigmaEffPrice;
    const pUpModel = clamp(normalCdf(zScore), 0.0001, 0.9999);

    return {
      pUpModel,
      zScore,
      sigmaEffPrice,
      tauEffSec
    };
  }

  computeFromSigma(input: {
    oracleEst: number;
    priceToBeat: number;
    sigmaPrice: number;
  }): ProbOutput {
    const sigmaEffPrice = Math.max(1e-9, input.sigmaPrice);
    const zScore = (input.oracleEst - input.priceToBeat) / sigmaEffPrice;
    const pUpModel = clamp(normalCdf(zScore), 0.01, 0.99);
    return {
      pUpModel,
      zScore,
      sigmaEffPrice,
      tauEffSec: 1
    };
  }

  computeAdaptive(input: {
    oracleEst: number;
    priceToBeat: number;
    tauSec: number;
    cadenceSec: number;
    shortReturn: number;
    realizedVolPricePerSqrtSec: number;
  }): ProbOutput {
    const cadenceSec = Math.max(1, input.cadenceSec);
    const tauEffSec = Math.max(1, input.tauSec);
    const tauNorm = clamp(tauEffSec / cadenceSec, 0.05, 1);
    const sigmaFloor = Math.max(
      this.config.polymarket.vol.minSigmaBps / 10_000 * Math.max(input.oracleEst, 1),
      1e-8
    );
    const realizedVol = Math.max(sigmaFloor, input.realizedVolPricePerSqrtSec);

    // Expected drift contribution from short-horizon return, dampened as time decays.
    const driftUsd = input.oracleEst * input.shortReturn * Math.sqrt(tauNorm);
    const distUsd = input.oracleEst - input.priceToBeat;
    const sigmaEffPrice = Math.max(1e-9, realizedVol * Math.sqrt(tauNorm));
    const zScore = (distUsd + driftUsd) / sigmaEffPrice;
    const pUpModel = clamp(normalCdf(zScore), 0.01, 0.99);

    return {
      pUpModel,
      zScore,
      sigmaEffPrice,
      tauEffSec
    };
  }

  computeExpiryProbCalibrated(input: {
    fastMid: number;
    priceToBeat: number;
    sigmaPricePerSqrtSec: number;
    tauSec: number;
    polyUpdateAgeMs?: number | null;
    lagPolyP90Ms?: number | null;
    oracleAgeMs?: number | null;
  }): {
    pBase: number;
    pBoosted: number;
    z: number;
    d: number;
    sigma: number;
    tauSec: number;
    polyUpdateAgeMs: number;
    lagPolyP90Ms: number;
    oracleAgeMs: number;
    boostApplied: boolean;
    boostReason: string;
  } {
    const tauSec = Math.max(0, Number.isFinite(input.tauSec) ? input.tauSec : 0);
    const tauEffSec = Math.max(1e-6, tauSec);
    const eps = 1e-9;
    const fastMid = Number.isFinite(input.fastMid) ? input.fastMid : 0;
    const priceToBeat = Number.isFinite(input.priceToBeat) ? input.priceToBeat : 0;
    const d = fastMid - priceToBeat;
    const sigmaFloor = Math.max(
      this.config.polymarket.vol.minSigmaBps / 10_000 * Math.max(1, Math.abs(fastMid)),
      1e-9
    );
    const sigmaPricePerSqrtSec = Math.max(
      sigmaFloor,
      Number.isFinite(input.sigmaPricePerSqrtSec) ? input.sigmaPricePerSqrtSec : sigmaFloor
    );
    const sigma = Math.max(eps, sigmaPricePerSqrtSec * Math.sqrt(tauEffSec));
    const z = clamp(d / sigma, -50, 50);
    const pBase = clamp(normalCdf(z), 0.0005, 0.9995);

    const polyUpdateAgeMs = Math.max(0, Number(input.polyUpdateAgeMs ?? 0));
    const lagPolyP90Ms = Math.max(1, Number(input.lagPolyP90Ms ?? 1000));
    const oracleAgeMs = Math.max(0, Number(input.oracleAgeMs ?? 0));

    const hasLateWindow = tauSec <= 120;
    const hasExtremeZ = Math.abs(z) >= 2.2;
    const laggedBook = polyUpdateAgeMs >= lagPolyP90Ms || polyUpdateAgeMs >= 500;
    const shouldBoost = hasLateWindow && hasExtremeZ && laggedBook;

    let pBoosted = pBase;
    let boostApplied = false;
    let boostReason = "NO_BOOST";
    if (shouldBoost) {
      const boostMag = Math.min(0.03, 0.03 * Math.min(1, polyUpdateAgeMs / lagPolyP90Ms));
      pBoosted = z > 0 ? Math.min(0.9995, pBase + boostMag) : Math.max(0.0005, pBase - boostMag);
      boostApplied = true;
      boostReason = z > 0 ? "LOCKEDNESS_UP" : "LOCKEDNESS_DOWN";
    } else if (!hasLateWindow) {
      boostReason = "TAU_TOO_LARGE";
    } else if (!hasExtremeZ) {
      boostReason = "Z_NOT_EXTREME";
    } else if (!laggedBook) {
      boostReason = "BOOK_NOT_LAGGED";
    }

    if (!Number.isFinite(pBoosted)) {
      pBoosted = pBase;
      boostApplied = false;
      boostReason = "NUMERIC_GUARD";
    }

    return {
      pBase,
      pBoosted,
      z,
      d,
      sigma,
      tauSec,
      polyUpdateAgeMs,
      lagPolyP90Ms,
      oracleAgeMs,
      boostApplied,
      boostReason
    };
  }
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

// Abramowitz and Stegun 7.1.26 approximation.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
