export type NormalizedBalances = {
  ts: number;
  baseAsset: string;
  quoteAsset: string;
  usdFree: number;
  usdTotal: number;
  btcFree: number;
  btcTotal: number;
  btcNotionalUsd: number;
  equityUsd: number;
};

type BalanceLike = {
  asset?: string;
  currency?: string;
  free?: number;
  available?: number;
  total?: number;
  ts?: number;
};

const ASSET_ALIAS: Record<string, string> = {
  XBT: "BTC"
};

export function normalizeBalancesForSymbol(
  symbol: string,
  balances: BalanceLike[],
  mid: number
): NormalizedBalances {
  const [baseRaw, quoteRaw] = splitSymbol(symbol);
  const baseAsset = canonicalAssetCode(baseRaw);
  const quoteAsset = canonicalAssetCode(quoteRaw);
  const rows = Array.isArray(balances) ? balances : [];
  let usdFree = 0;
  let usdTotal = 0;
  let btcFree = 0;
  let btcTotal = 0;
  let latestTs = 0;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const code = canonicalAssetCode(String(row.asset ?? row.currency ?? "").trim().toUpperCase());
    if (!code) continue;
    const freeValue = toNumber(
      row.free !== undefined ? row.free : row.available !== undefined ? row.available : 0
    );
    const totalValue = toNumber(row.total !== undefined ? row.total : 0);
    const rowTs = toNumber(row.ts);
    if (Number.isFinite(rowTs) && rowTs > latestTs) {
      latestTs = rowTs;
    }

    if (code === quoteAsset) {
      usdFree += freeValue;
      usdTotal += totalValue;
    }
    if (code === baseAsset) {
      btcFree += freeValue;
      btcTotal += totalValue;
    }
  }

  const safeMid = Number.isFinite(mid) && mid > 0 ? mid : 0;
  const btcNotionalUsd = safeMid > 0 ? btcTotal * safeMid : 0;
  const equityUsd = usdTotal + btcNotionalUsd;

  return {
    ts: latestTs > 0 ? latestTs : Date.now(),
    baseAsset,
    quoteAsset,
    usdFree,
    usdTotal,
    btcFree,
    btcTotal,
    btcNotionalUsd,
    equityUsd
  };
}

function splitSymbol(symbol: string): [string, string] {
  const [base, quote] = String(symbol || "").toUpperCase().split("-");
  return [base || "BTC", quote || "USD"];
}

function canonicalAssetCode(asset: string): string {
  const normalized = String(asset || "").trim().toUpperCase();
  if (!normalized) return "";
  return ASSET_ALIAS[normalized] ?? normalized;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
