export type EquityBalances = {
  usd_total: number;
  usd_free: number;
  btc_total: number;
  btc_free: number;
};

export type EquityInput = {
  ts: number;
  mid: number;
  balances: EquityBalances;
};

export type EquitySnapshot = EquityBalances & {
  ts: number;
  mid: number;
  equityUsd: number;
  equityBtc: number;
  btcNotionalUsd: number;
  usdNotionalBtc: number;
};

function numericOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAssetCode(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  const anyRow = row as Record<string, unknown>;
  const direct = [anyRow.asset, anyRow.currency, anyRow.code, anyRow.ccy, anyRow.symbol];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toUpperCase();
    }
  }

  const nested = [anyRow.asset, anyRow.currency];
  for (const candidate of nested) {
    if (!candidate || typeof candidate !== "object") continue;
    const nestedRow = candidate as Record<string, unknown>;
    const code = nestedRow.code ?? nestedRow.symbol ?? nestedRow.currency ?? nestedRow.asset;
    if (typeof code === "string" && code.trim().length > 0) {
      return code.trim().toUpperCase();
    }
  }

  return "";
}

function findAsset(rows: unknown[], aliases: string[]): Record<string, unknown> | null {
  const wanted = new Set(aliases.map((alias) => alias.toUpperCase()));
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const code = normalizeAssetCode(row);
    if (wanted.has(code)) {
      return row as Record<string, unknown>;
    }
  }
  return null;
}

export function extractBalancesFromRows(rows: unknown[]): EquityBalances {
  const usd = findAsset(rows, ["USD", "USDC"]);
  const btc = findAsset(rows, ["BTC", "XBT"]);
  return {
    usd_total: numericOrZero(usd?.total),
    usd_free: numericOrZero(usd?.free),
    btc_total: numericOrZero(btc?.total),
    btc_free: numericOrZero(btc?.free)
  };
}

export function computeEquitySnapshot(input: EquityInput): EquitySnapshot | null {
  if (!Number.isFinite(input.mid) || input.mid <= 0) {
    return null;
  }

  const usdTotal = numericOrZero(input.balances.usd_total);
  const usdFree = numericOrZero(input.balances.usd_free);
  const btcTotal = numericOrZero(input.balances.btc_total);
  const btcFree = numericOrZero(input.balances.btc_free);

  const equityUsd = usdTotal + btcTotal * input.mid;
  const equityBtc = btcTotal + usdTotal / input.mid;
  const btcNotionalUsd = btcTotal * input.mid;
  const usdNotionalBtc = usdTotal / input.mid;

  return {
    ts: numericOrZero(input.ts),
    mid: input.mid,
    usd_total: usdTotal,
    usd_free: usdFree,
    btc_total: btcTotal,
    btc_free: btcFree,
    equityUsd,
    equityBtc,
    btcNotionalUsd,
    usdNotionalBtc
  };
}

export function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toFixed(2)}`;
}

export function fmtBtc(value: number, compact = false): string {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(compact ? 6 : 8);
}
