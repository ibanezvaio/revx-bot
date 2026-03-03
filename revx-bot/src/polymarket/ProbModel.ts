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
