import { Logger } from "../logger";
import {
  markVenueServiceError,
  markVenueServiceSuccess,
  validateVenueRoute
} from "./venueGuard";

export type HttpService = "REVX" | "POLY_GAMMA" | "POLY_DATA" | "POLY_CLOB";

export type HttpErrorRecord = {
  ts: number;
  service: HttpService;
  baseUrl: string;
  method: string;
  path: string;
  status: number;
  message: string;
  durationMs: number;
  requestId?: string;
  traceId?: string;
};

const MAX_HTTP_ERROR_BUFFER = 200;
const httpErrorBuffer: HttpErrorRecord[] = [];

export function beginHttpRequestTrace(params: {
  logger: Logger;
  service: HttpService;
  baseUrl: string;
  method: string;
  path: string;
  debugHttp: boolean;
  traceId?: string;
  module?: string;
}): {
  done: (status: number, headers?: Headers | null) => void;
  fail: (error: unknown, status?: number, headers?: Headers | null) => void;
} {
  const startedAt = Date.now();
  const normalizedBaseUrl = normalizeBaseUrl(params.baseUrl);
  const requestPath = normalizePath(params.path);
  validateVenueRoute({
    service: params.service,
    module: params.module ?? params.service,
    url: `${normalizedBaseUrl}${requestPath}`,
    logger: params.logger
  });
  const method = String(params.method || "GET").toUpperCase();
  const path = requestPath;

  return {
    done: (status: number, headers?: Headers | null) => {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const requestId = pickRequestId(headers);
      if (status >= 200 && status < 400) {
        markVenueServiceSuccess(params.service, Date.now());
      }
      params.logger[params.debugHttp ? "info" : "debug"](
        {
          service: params.service,
          baseUrl: normalizedBaseUrl,
          method,
          path,
          status,
          durationMs,
          requestId,
          traceId: params.traceId
        },
        "HTTP request"
      );
      if (status >= 400) {
        pushHttpError({
          ts: Date.now(),
          service: params.service,
          baseUrl: normalizedBaseUrl,
          method,
          path,
          status,
          message: `HTTP ${status}`,
          durationMs,
          requestId,
          traceId: params.traceId
        });
      }
    },
    fail: (error: unknown, status = 0, headers?: Headers | null) => {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const requestId = pickRequestId(headers);
      const message = error instanceof Error ? error.message : String(error);
      markVenueServiceError(params.service, {
        message,
        module: params.module ?? params.service,
        url: `${normalizedBaseUrl}${path}`
      });
      params.logger[params.debugHttp ? "warn" : "debug"](
        {
          service: params.service,
          baseUrl: normalizedBaseUrl,
          method,
          path,
          status,
          durationMs,
          message,
          requestId,
          traceId: params.traceId
        },
        "HTTP request failed"
      );
      pushHttpError({
        ts: Date.now(),
        service: params.service,
        baseUrl: normalizedBaseUrl,
        method,
        path,
        status,
        message,
        durationMs,
        requestId,
        traceId: params.traceId
      });
    }
  };
}

export function assertServiceBaseUrl(service: HttpService, baseUrl: string): void {
  validateVenueRoute({
    service,
    module: "startup",
    url: normalizeBaseUrl(baseUrl),
    logger: undefined
  });
}

export function getRecentHttpErrors(limit = MAX_HTTP_ERROR_BUFFER): HttpErrorRecord[] {
  const bounded = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(MAX_HTTP_ERROR_BUFFER, Math.floor(limit)))
    : MAX_HTTP_ERROR_BUFFER;
  if (httpErrorBuffer.length <= bounded) {
    return httpErrorBuffer.slice();
  }
  return httpErrorBuffer.slice(httpErrorBuffer.length - bounded);
}

function pushHttpError(row: HttpErrorRecord): void {
  httpErrorBuffer.push(row);
  if (httpErrorBuffer.length > MAX_HTTP_ERROR_BUFFER) {
    httpErrorBuffer.splice(0, httpErrorBuffer.length - MAX_HTTP_ERROR_BUFFER);
  }
}

function normalizeBaseUrl(value: string): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizePath(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function pickRequestId(headers?: Headers | null): string | undefined {
  if (!headers) return undefined;
  const keys = ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"];
  for (const key of keys) {
    const value = headers.get(key);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
