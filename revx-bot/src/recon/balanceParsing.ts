import { BalanceSnapshot } from "../store/Store";

const ASSET_ALIASES: Record<string, string> = {
  XBT: "BTC"
};

export type BalanceDiagnostic = {
  asset: string;
  rawAsset: string;
  keys: string[];
  availableRaw: string;
  freeRaw: string;
  tradableRaw: string;
  balanceRaw: string;
  totalRaw: string;
  lockedRaw: string;
  parsedFree: number;
  parsedTotal: number;
};

export type ParsedBalancesPayload = {
  snapshots: BalanceSnapshot[];
  diagnostics: BalanceDiagnostic[];
};

export function parseBalancesPayload(rows: unknown[], fallbackTs: number): ParsedBalancesPayload {
  const diagnostics: BalanceDiagnostic[] = [];
  const aggregated = new Map<string, BalanceSnapshot>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const parsed = parseSingleBalanceRow(row as Record<string, unknown>, fallbackTs);
    if (!parsed) continue;

    diagnostics.push(parsed.diagnostic);
    const existing = aggregated.get(parsed.snapshot.asset);
    if (!existing) {
      aggregated.set(parsed.snapshot.asset, parsed.snapshot);
      continue;
    }

    aggregated.set(parsed.snapshot.asset, {
      asset: parsed.snapshot.asset,
      free: existing.free + parsed.snapshot.free,
      total: existing.total + parsed.snapshot.total,
      ts: Math.max(existing.ts, parsed.snapshot.ts)
    });
  }

  return {
    snapshots: Array.from(aggregated.values()).sort((a, b) => a.asset.localeCompare(b.asset)),
    diagnostics
  };
}

export function findAsset(snapshots: BalanceSnapshot[], codes: string[]): BalanceSnapshot | null {
  const wanted = new Set<string>();
  for (const code of codes) {
    const normalized = normalizeAssetCode(code);
    if (!normalized) continue;
    wanted.add(normalized);
    wanted.add(canonicalAssetCode(normalized));
  }

  for (const snapshot of snapshots) {
    const normalized = normalizeAssetCode(snapshot.asset);
    const canonical = canonicalAssetCode(normalized);
    if (wanted.has(normalized) || wanted.has(canonical)) {
      return snapshot;
    }
  }

  return null;
}

function parseSingleBalanceRow(
  row: Record<string, unknown>,
  fallbackTs: number
): { snapshot: BalanceSnapshot; diagnostic: BalanceDiagnostic } | null {
  const rawAsset = pickBestString(row, ["asset", "currency", "symbol", "code", "ccy", "coin"]);
  const normalizedAsset = normalizeAssetCode(rawAsset);
  if (!normalizedAsset) {
    return null;
  }

  const asset = canonicalAssetCode(normalizedAsset);

  const availableRaw = pickFieldValue(row, ["available", "available_balance", "availableBalance"]);
  const freeRaw = pickFieldValue(row, ["free", "free_balance"]);
  const tradableRaw = pickFieldValue(row, ["tradable", "tradable_balance"]);
  const balanceRaw = pickFieldValue(row, ["balance", "wallet_balance"]);
  const totalRaw = pickFieldValue(row, ["total", "total_balance"]);
  const lockedRaw = pickFieldValue(row, ["locked", "hold", "held", "reserved", "frozen", "in_order", "in_orders", "on_order"]);

  const availableNum = toFiniteNumber(availableRaw);
  const freeNum = toFiniteNumber(freeRaw);
  const tradableNum = toFiniteNumber(tradableRaw);
  const balanceNum = toFiniteNumber(balanceRaw);
  const totalNum = toFiniteNumber(totalRaw);
  const lockedNum = toFiniteNumber(lockedRaw);

  const parsedFree =
    firstFinite([availableNum, freeNum, tradableNum, balanceNum]) ??
    0;

  const availPlusLocked =
    availableNum !== null && lockedNum !== null ? availableNum + lockedNum : null;

  const parsedTotal =
    firstFinite([totalNum, balanceNum, availPlusLocked, availableNum]) ??
    parsedFree;

  const ts = pickTimestampValue(row, ["timestamp", "updated_at", "created_at", "ts"], fallbackTs);

  const snapshot: BalanceSnapshot = {
    asset,
    free: parsedFree,
    total: parsedTotal,
    ts
  };

  const diagnostic: BalanceDiagnostic = {
    asset,
    rawAsset,
    keys: collectKeys(row),
    availableRaw: stringifyValue(availableRaw),
    freeRaw: stringifyValue(freeRaw),
    tradableRaw: stringifyValue(tradableRaw),
    balanceRaw: stringifyValue(balanceRaw),
    totalRaw: stringifyValue(totalRaw),
    lockedRaw: stringifyValue(lockedRaw),
    parsedFree,
    parsedTotal
  };

  return { snapshot, diagnostic };
}

function pickBestString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = pickFieldValue(obj, [key]);
    const asString = extractString(value);
    if (asString) return asString;
  }
  return "";
}

function pickFieldValue(obj: Record<string, unknown>, wantedKeys: string[]): unknown {
  const wanted = new Set(wantedKeys.map((key) => key.toLowerCase()));
  const queue: unknown[] = [obj];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (wanted.has(normalizedKey)) {
        return value;
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return undefined;
}

function pickTimestampValue(
  obj: Record<string, unknown>,
  keys: string[],
  fallback: number
): number {
  for (const key of keys) {
    const value = pickFieldValue(obj, [key]);
    const asNumber = toFiniteNumber(value);
    if (asNumber !== null) {
      return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
    }

    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fallback;
}

function collectKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort((a, b) => a.localeCompare(b));
}

function extractString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    const fromNested =
      extractString(nested.code) ||
      extractString(nested.currency) ||
      extractString(nested.asset) ||
      extractString(nested.symbol);
    if (fromNested) return fromNested;
  }

  return "";
}

function normalizeAssetCode(value: string): string {
  if (!value) return "";
  return value.trim().toUpperCase();
}

function canonicalAssetCode(value: string): string {
  return ASSET_ALIASES[value] ?? value;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().replace(/,/g, "");
    if (normalized.length === 0) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    return (
      toFiniteNumber(nested.value) ??
      toFiniteNumber(nested.amount) ??
      toFiniteNumber(nested.available)
    );
  }

  return null;
}

function firstFinite(values: Array<number | null>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
