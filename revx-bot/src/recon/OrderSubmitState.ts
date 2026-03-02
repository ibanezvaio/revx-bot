export type OrderSubmitPayloadSummary = {
  clientOrderId: string;
  symbol: string;
  side: string;
  type: string;
  price: number;
  quoteSize: number;
  executionInstructions: string[];
};

export type OrderSubmitRecord = {
  ts: number;
  endpoint: string;
  payloadSummary: OrderSubmitPayloadSummary;
  httpStatus: number | null;
  responseBody: unknown;
  errorMessage: string;
  errorStack: string;
  ok: boolean;
};

export type OrderSubmitSnapshot = {
  ts: number;
  ok: boolean;
  lastError: string;
  lastSubmit: OrderSubmitRecord | null;
};

const EMPTY_SNAPSHOT: OrderSubmitSnapshot = {
  ts: 0,
  ok: true,
  lastError: "",
  lastSubmit: null
};

class OrderSubmitStateStore {
  private snapshot: OrderSubmitSnapshot = { ...EMPTY_SNAPSHOT };

  markSuccess(input: {
    endpoint: string;
    payloadSummary: OrderSubmitPayloadSummary;
    httpStatus?: number | null;
    responseBody?: unknown;
    ts?: number;
  }): void {
    const nowTs = normalizeTs(input.ts);
    this.snapshot = {
      ts: nowTs,
      ok: true,
      lastError: "",
      lastSubmit: {
        ts: nowTs,
        endpoint: String(input.endpoint || "POST /api/1.0/orders"),
        payloadSummary: {
          ...input.payloadSummary
        },
        httpStatus: normalizeHttpStatus(input.httpStatus),
        responseBody: normalizeBody(input.responseBody),
        errorMessage: "",
        errorStack: "",
        ok: true
      }
    };
  }

  markFailure(input: {
    endpoint: string;
    payloadSummary: OrderSubmitPayloadSummary;
    httpStatus?: number | null;
    responseBody?: unknown;
    error: unknown;
    ts?: number;
  }): void {
    const nowTs = normalizeTs(input.ts);
    const errorMessage =
      input.error instanceof Error
        ? input.error.message
        : typeof input.error === "string"
          ? input.error
          : "order_submit_failed";
    const errorStack = input.error instanceof Error ? String(input.error.stack || "") : "";
    this.snapshot = {
      ts: nowTs,
      ok: false,
      lastError: errorMessage,
      lastSubmit: {
        ts: nowTs,
        endpoint: String(input.endpoint || "POST /api/1.0/orders"),
        payloadSummary: {
          ...input.payloadSummary
        },
        httpStatus: normalizeHttpStatus(input.httpStatus),
        responseBody: normalizeBody(input.responseBody),
        errorMessage,
        errorStack,
        ok: false
      }
    };
  }

  getSnapshot(): OrderSubmitSnapshot {
    return {
      ...this.snapshot,
      lastSubmit: this.snapshot.lastSubmit
        ? {
            ...this.snapshot.lastSubmit,
            payloadSummary: { ...this.snapshot.lastSubmit.payloadSummary }
          }
        : null
    };
  }
}

function normalizeTs(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

function normalizeHttpStatus(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : null;
}

function normalizeBody(value: unknown): unknown {
  if (value === undefined) return null;
  return value;
}

export const orderSubmitState = new OrderSubmitStateStore();
