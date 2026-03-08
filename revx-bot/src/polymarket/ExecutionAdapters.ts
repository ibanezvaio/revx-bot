import { PolymarketExecution } from "./Execution";
import { ExecutionResult } from "./types";

export type CanonicalEntryDecision = {
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  contractPrice: number;
  notionalUsd: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
};

export type CanonicalExitDecision = {
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  shares: number;
  contractPrice: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
};

export class PaperExecutionAdapter {
  async executeEntry(params: {
    side: "YES" | "NO";
    execute: () => boolean;
  }): Promise<ExecutionResult> {
    const accepted = params.execute();
    return {
      action: accepted ? (params.side === "YES" ? "BUY_YES" : "BUY_NO") : "HOLD",
      accepted,
      filledShares: 0,
      reason: accepted ? "PAPER_EXECUTED" : "PAPER_REJECTED"
    };
  }
}

export class LiveExecutionAdapter {
  constructor(private readonly execution: PolymarketExecution) {}

  async executeEntry(decision: CanonicalEntryDecision): Promise<ExecutionResult> {
    return this.execution.executeEntry({
      marketId: decision.marketId,
      tokenId: decision.tokenId,
      side: decision.side,
      askPrice: decision.contractPrice,
      notionalUsd: decision.notionalUsd,
      tickSize: decision.tickSize,
      negRisk: decision.negRisk
    });
  }

  async executeExit(decision: CanonicalExitDecision): Promise<ExecutionResult> {
    return this.execution.executeExit({
      marketId: decision.marketId,
      tokenId: decision.tokenId,
      side: decision.side,
      shares: decision.shares,
      bidPrice: decision.contractPrice,
      tickSize: decision.tickSize,
      negRisk: decision.negRisk
    });
  }
}
