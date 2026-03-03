export type PaperSide = "YES" | "NO";
export type PaperOutcome = "UP" | "DOWN";

export type PaperPnlInput = {
  side: PaperSide;
  outcome: PaperOutcome;
  qty: number;
  entryPrice: number;
  feeBps: number;
};

export type PaperPnlOutput = {
  payoutPerShare: number;
  payoutUsd: number;
  entryCostUsd: number;
  feesUsd: number;
  pnlUsd: number;
};

export type PaperClosePnlInput = {
  qty: number;
  entryCostUsd: number;
  entryFeesUsd: number;
  exitPrice: number;
  feeBps: number;
};

export type PaperClosePnlOutput = {
  exitProceedsUsd: number;
  exitFeesUsd: number;
  pnlUsd: number;
};

export function applyTakerSlippage(price: number, slippageBps: number): number {
  const base = clamp(price, 0.0001, 0.9999);
  const bumped = base * (1 + Math.max(0, slippageBps) / 10_000);
  return clamp(bumped, 0.0001, 0.9999);
}

export function computePaperPnl(input: PaperPnlInput): PaperPnlOutput {
  const qty = Math.max(0, input.qty);
  const entryPrice = clamp(input.entryPrice, 0.0001, 0.9999);
  const feeBps = Math.max(0, input.feeBps);

  const payoutPerShare = computePayoutPerShare(input.side, input.outcome);
  const payoutUsd = qty * payoutPerShare;
  const entryCostUsd = qty * entryPrice;
  const feesUsd = entryCostUsd * (feeBps / 10_000);
  const pnlUsd = payoutUsd - entryCostUsd - feesUsd;

  return {
    payoutPerShare,
    payoutUsd,
    entryCostUsd,
    feesUsd,
    pnlUsd
  };
}

export function inferOutcomeFromOracle(oraclePx: number, priceToBeat: number): PaperOutcome {
  return oraclePx >= priceToBeat ? "UP" : "DOWN";
}

export function estimateNoAskFromYesBook(yesBid: number): number {
  return clamp(1 - clamp(yesBid, 0, 1), 0.0001, 0.9999);
}

export function estimateNoBidFromYesBook(yesAsk: number): number {
  return clamp(1 - clamp(yesAsk, 0, 1), 0.0001, 0.9999);
}

export function applySellSlippage(price: number, slippageBps: number): number {
  const base = clamp(price, 0.0001, 0.9999);
  const penalized = base * (1 - Math.max(0, slippageBps) / 10_000);
  return clamp(penalized, 0.0001, 0.9999);
}

export function computePaperClosePnl(input: PaperClosePnlInput): PaperClosePnlOutput {
  const qty = Math.max(0, input.qty);
  const exitPrice = clamp(input.exitPrice, 0.0001, 0.9999);
  const feeBps = Math.max(0, input.feeBps);
  const exitProceedsUsd = qty * exitPrice;
  const exitFeesUsd = exitProceedsUsd * (feeBps / 10_000);
  const pnlUsd = exitProceedsUsd - Math.max(0, input.entryCostUsd) - Math.max(0, input.entryFeesUsd) - exitFeesUsd;
  return {
    exitProceedsUsd,
    exitFeesUsd,
    pnlUsd
  };
}

function computePayoutPerShare(side: PaperSide, outcome: PaperOutcome): number {
  if (side === "YES") {
    return outcome === "UP" ? 1 : 0;
  }
  return outcome === "DOWN" ? 1 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
