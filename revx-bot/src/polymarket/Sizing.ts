import { BotConfig } from "../config";
import { SizeInput, SizeOutput } from "./types";

export class Sizing {
  constructor(private readonly config: BotConfig) {}

  compute(input: SizeInput): SizeOutput {
    const price = clamp(input.yesAsk, 0.0001, 0.9999);
    const conviction = Math.max(0, Number(input.conviction || 0));
    const remainingSec = Math.max(0, Number(input.remainingSec || 0));
    const entryMaxRemainingSec = Math.max(
      1,
      Number(input.entryMaxRemainingSec || this.config.polymarket.paper.entryMaxRemainingSec || 90)
    );
    const depthCapNotionalUsd = Math.max(0, Number(input.depthCapNotionalUsd || 0));
    const edge = Math.max(0, Number(input.edge || 0));

    if (!(edge > 0)) {
      return {
        notionalUsd: 0,
        shares: 0,
        kellyFraction: 0
      };
    }

    const tierFraction =
      conviction >= 0.4 ? 1 : conviction >= 0.25 ? 0.5 : conviction >= 0.15 ? 0.25 : 0;
    if (!(tierFraction > 0)) {
      return {
        notionalUsd: 0,
        shares: 0,
        kellyFraction: 0
      };
    }

    const timeProgress = clamp(1 - remainingSec / entryMaxRemainingSec, 0, 1);
    const timeScale = 0.65 + 0.7 * timeProgress;
    const rawNotional = tierFraction * timeScale * this.config.polymarket.sizing.maxNotionalPerWindow;
    const budgetCap = Math.min(
      input.remainingWindowBudget,
      input.remainingExposureBudget,
      input.remainingDailyLossBudget,
      this.config.polymarket.sizing.maxNotionalPerWindow
    );
    const effectiveBudgetCap = depthCapNotionalUsd > 0 ? Math.min(budgetCap, depthCapNotionalUsd) : budgetCap;

    const cappedNotional = clamp(rawNotional, 0, Math.max(0, effectiveBudgetCap));
    const minOrder = this.config.polymarket.sizing.minOrderNotional;
    const notionalUsd = cappedNotional >= minOrder ? cappedNotional : 0;

    return {
      notionalUsd,
      shares: notionalUsd > 0 ? notionalUsd / price : 0,
      kellyFraction: clamp(tierFraction * timeScale, 0, 1.5)
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
