import { BotConfig } from "../config";
import { VolEstimate } from "./types";

type Point = {
  ts: number;
  price: number;
};

export class VolEstimator {
  private points: Point[] = [];

  constructor(private readonly config: BotConfig) {}

  update(price: number, ts = Date.now()): void {
    if (!(price > 0)) return;
    this.points.push({ ts, price });
    this.trim(ts);
  }

  getEstimate(anchorPrice: number, nowTs = Date.now()): VolEstimate {
    this.trim(nowTs);
    if (!(anchorPrice > 0) || this.points.length < 3) {
      return this.fallback(anchorPrice);
    }

    const returnsPerSecond: number[] = [];
    for (let i = 1; i < this.points.length; i += 1) {
      const prev = this.points[i - 1];
      const curr = this.points[i];
      if (!(prev.price > 0) || !(curr.price > 0)) continue;
      const dtSec = Math.max(0.001, (curr.ts - prev.ts) / 1000);
      const logReturn = Math.log(curr.price / prev.price);
      returnsPerSecond.push(logReturn / Math.sqrt(dtSec));
    }

    if (returnsPerSecond.length < 2) {
      return this.fallback(anchorPrice);
    }

    const mean = returnsPerSecond.reduce((sum, value) => sum + value, 0) / returnsPerSecond.length;
    const variance =
      returnsPerSecond.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, returnsPerSecond.length - 1);
    const sigmaPerSqrtSec = Math.max(
      this.config.polymarket.vol.minSigmaBps / 10_000,
      Math.sqrt(Math.max(0, variance))
    );

    return {
      sigmaPerSqrtSec,
      sigmaPricePerSqrtSec: anchorPrice * sigmaPerSqrtSec,
      sampleCount: returnsPerSecond.length
    };
  }

  private fallback(anchorPrice: number): VolEstimate {
    const sigmaPerSqrtSec = this.config.polymarket.vol.minSigmaBps / 10_000;
    return {
      sigmaPerSqrtSec,
      sigmaPricePerSqrtSec: Math.max(0, anchorPrice) * sigmaPerSqrtSec,
      sampleCount: 0
    };
  }

  private trim(nowTs: number): void {
    const keepMs = this.config.polymarket.vol.lookbackSec * 1000;
    const cutoff = nowTs - keepMs;
    this.points = this.points.filter((point) => point.ts >= cutoff);
    if (this.points.length > 10_000) {
      this.points = this.points.slice(this.points.length - 10_000);
    }
  }
}
