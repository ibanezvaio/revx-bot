export type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";

export type CreateOrderInput = {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  expirationSec: number;
  tickSize: TickSize;
  negRisk: boolean;
};

export function buildCreateOrderInput(input: CreateOrderInput): {
  userOrder: {
    tokenID: string;
    price: number;
    size: number;
    side: "BUY" | "SELL";
    expiration: number;
  };
  options: {
    tickSize: TickSize;
    negRisk: boolean;
  };
} {
  const tokenID = String(input.tokenId || "").trim();
  if (tokenID.length === 0) {
    throw new Error("tokenId is required");
  }
  if (!Number.isFinite(input.price)) {
    throw new Error("price must be finite");
  }
  const price = normalizePrice(input.price, input.tickSize, input.side);
  if (!(input.size > 0)) {
    throw new Error("size must be positive");
  }
  const expiration = Math.max(Math.floor(Date.now() / 1000) + 2, Math.floor(input.expirationSec));

  return {
    userOrder: {
      tokenID,
      price,
      size: input.size,
      side: input.side,
      expiration
    },
    options: {
      tickSize: input.tickSize,
      negRisk: Boolean(input.negRisk)
    }
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePrice(
  rawPrice: number,
  tickSize: TickSize,
  side: "BUY" | "SELL"
): number {
  const clamped = clamp(rawPrice, 0.0001, 0.9999);
  const tick = Number(tickSize);
  const precision = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
  const ticks = clamped / tick;
  const roundedTicks = side === "BUY" ? Math.floor(ticks) : Math.ceil(ticks);
  const rounded = Number((roundedTicks * tick).toFixed(precision));
  return clamp(rounded, tick, 1 - tick);
}
