import { BotConfig } from "../config";
import { SignalBias, SignalRegime } from "./types";

export type RegimeClassifierInput = {
  confidence: number;
  stdevBps: number;
  driftBps: number;
  dispersionBps: number;
  failedVenueRate: number;
};

export type RegimeClassifierOutput = {
  regime: SignalRegime;
  bias: SignalBias;
  biasConfidence: number;
  reason: string;
};

export class RegimeClassifier {
  constructor(private readonly config: BotConfig) {}

  classify(input: RegimeClassifierInput): RegimeClassifierOutput {
    const confidence = clamp(input.confidence, 0, 1);
    const driftAbs = Math.abs(input.driftBps);
    const dispersionAbs = Math.abs(input.dispersionBps);
    const failedRate = clamp(input.failedVenueRate, 0, 1);

    let regime: SignalRegime = "CALM";
    if (
      input.stdevBps >= this.config.hotVolBps ||
      dispersionAbs >= this.config.fairMaxDispersionBps * 2 ||
      failedRate >= 0.6
    ) {
      regime = "CRISIS";
    } else if (
      driftAbs >= this.config.toxicDriftBps * 0.9 &&
      confidence >= this.config.signalMinConf
    ) {
      regime = "TREND";
    } else if (
      input.stdevBps >= this.config.calmVolBps * this.config.signalHotRegimeMultiplier * 0.6 ||
      dispersionAbs >= this.config.fairMaxDispersionBps
    ) {
      regime = "VOLATILE";
    }

    let bias: SignalBias = "NEUTRAL";
    if (confidence >= this.config.signalMinConf && driftAbs >= this.config.toxicDriftBps * 0.35) {
      bias = input.driftBps > 0 ? "LONG" : "SHORT";
    }
    const biasConfidence = clamp(confidence * clamp(driftAbs / Math.max(0.1, this.config.toxicDriftBps), 0, 1), 0, 1);
    const reason = `regime=${regime} stdev=${input.stdevBps.toFixed(2)} drift=${input.driftBps.toFixed(2)} dispersion=${input.dispersionBps.toFixed(2)} failRate=${failedRate.toFixed(2)} conf=${confidence.toFixed(2)}`;

    return { regime, bias, biasConfidence, reason };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

