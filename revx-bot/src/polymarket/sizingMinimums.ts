export type PolymarketEffectiveSizingBasis = {
  minValidPriceBasis: number;
  minValidSizeEffective: number;
  minValidCostUsdEffective: number;
  minValidSize: number;
  minValidCostUsd: number;
  minSharesForVenueNotional: number;
  feeMultiplier: number;
};

export function computePolymarketEffectiveSizingBasis(input: {
  enabled: boolean;
  orderPrice: number | null | undefined;
  minVenueShares: number | null | undefined;
  minVenueNotionalUsd: number | null | undefined;
  feeBufferBps?: number | null | undefined;
  sharePrecision?: number | null | undefined;
}): PolymarketEffectiveSizingBasis {
  const orderPrice =
    Number.isFinite(Number(input.orderPrice)) && Number(input.orderPrice) > 0
      ? clamp(Number(input.orderPrice), 0.0001, 0.9999)
      : 0;
  const minVenueShares =
    Number.isFinite(Number(input.minVenueShares)) && Number(input.minVenueShares) > 0
      ? Math.max(1, Math.floor(Number(input.minVenueShares)))
      : 0;
  const minVenueNotionalUsd =
    Number.isFinite(Number(input.minVenueNotionalUsd)) && Number(input.minVenueNotionalUsd) > 0
      ? Math.max(0, Number(input.minVenueNotionalUsd))
      : 0;
  const feeBufferBps =
    Number.isFinite(Number(input.feeBufferBps)) && Number(input.feeBufferBps) >= 0
      ? Math.max(0, Number(input.feeBufferBps))
      : 0;
  const sharePrecision =
    Number.isFinite(Number(input.sharePrecision)) && Number(input.sharePrecision) >= 0
      ? Math.max(0, Math.floor(Number(input.sharePrecision)))
      : 6;
  const feeMultiplier = 1 + feeBufferBps / 10_000;
  const minSharesForVenueNotional =
    input.enabled && orderPrice > 0 && minVenueNotionalUsd > 0
      ? ceilToPrecision(minVenueNotionalUsd / Math.max(orderPrice, 0.0001), sharePrecision)
      : 0;
  const minValidSizeEffective = input.enabled ? Math.max(minVenueShares, minSharesForVenueNotional) : 0;
  const minValidPriceBasis = input.enabled && orderPrice > 0 ? orderPrice * feeMultiplier : 0;
  const minValidCostUsdEffective =
    input.enabled && minValidSizeEffective > 0 && minValidPriceBasis > 0
      ? minValidSizeEffective * minValidPriceBasis
      : 0;
  return {
    minValidPriceBasis,
    minValidSizeEffective,
    minValidCostUsdEffective,
    minValidSize: minValidSizeEffective,
    minValidCostUsd: minValidCostUsdEffective,
    minSharesForVenueNotional,
    feeMultiplier
  };
}

export function getPolymarketSizingFeeBufferBps(): number {
  const envValue = Number(process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS || 30);
  if (!Number.isFinite(envValue)) return 30;
  return Math.max(0, Math.min(1_000, envValue));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ceilToPrecision(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const factor = 10 ** Math.max(0, Math.floor(decimals));
  return Math.ceil(value * factor) / factor;
}
