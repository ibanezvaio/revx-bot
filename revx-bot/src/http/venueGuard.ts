import { Logger } from "../logger";
import type { HttpService } from "./endpointGuard";

type VenueGuardError = {
  ts: number;
  service: HttpService;
  module: string;
  url: string;
  expectedHosts: string[];
  actualHost: string;
  message: string;
};

const allowedHostsByService = new Map<HttpService, Set<string>>();
const mismatchLoggedKeys = new Set<string>();
const lastSuccessByService: Record<HttpService, number | null> = {
  REVX: null,
  POLY_GAMMA: null,
  POLY_DATA: null,
  POLY_CLOB: null
};
let lastGuardError: VenueGuardError | null = null;

export function registerVenueServiceHosts(service: HttpService, baseUrls: string[]): void {
  const normalized = new Set<string>();
  for (const baseUrl of baseUrls) {
    const host = normalizeHost(baseUrl);
    if (host) normalized.add(host);
  }
  if (normalized.size === 0) return;
  const existing = allowedHostsByService.get(service) ?? new Set<string>();
  for (const host of normalized) existing.add(host);
  allowedHostsByService.set(service, existing);
}

export function validateVenueRoute(params: {
  service: HttpService;
  module: string;
  url: string;
  logger?: Logger;
}): void {
  const actualHost = normalizeHost(params.url);
  const expectedHosts = Array.from(allowedHostsByService.get(params.service) ?? []);
  const expectedHost = expectedHosts[0] ?? "";
  const violation =
    isDomainMismatch(params.service, actualHost) ||
    (expectedHosts.length > 0 && !expectedHosts.includes(actualHost));
  if (!violation) {
    return;
  }
  const message =
    `VENUE_MISROUTE_BLOCKED: ${params.service} ${params.module} expected=${expectedHost || "n/a"} actual=${actualHost || "unknown"}`;
  const logKey = `${params.service}|${params.module}|${actualHost}|${expectedHosts.join(",")}`;
  if (!mismatchLoggedKeys.has(logKey) && params.logger) {
    mismatchLoggedKeys.add(logKey);
    params.logger.error(
      {
        module: params.module,
        service: params.service,
        url: params.url,
        expectedHost: expectedHost || null,
        expectedHosts,
        actualHost
      },
      "VENUE_MISROUTE_BLOCKED"
    );
  }
  lastGuardError = {
    ts: Date.now(),
    service: params.service,
    module: params.module,
    url: params.url,
    expectedHosts,
    actualHost,
    message
  };
  throw new Error(message);
}

export function markVenueServiceSuccess(service: HttpService, ts = Date.now()): void {
  lastSuccessByService[service] = ts;
}

export function markVenueServiceError(service: HttpService, details: { message: string; module: string; url: string }): void {
  lastGuardError = {
    ts: Date.now(),
    service,
    module: details.module,
    url: details.url,
    expectedHosts: Array.from(allowedHostsByService.get(service) ?? []),
    actualHost: normalizeHost(details.url),
    message: details.message
  };
}

export function getVenueGuardHealthSnapshot(): {
  lastSuccessByService: Record<HttpService, number | null>;
  lastGuardError: VenueGuardError | null;
} {
  return {
    lastSuccessByService: { ...lastSuccessByService },
    lastGuardError: lastGuardError ? { ...lastGuardError, expectedHosts: [...lastGuardError.expectedHosts] } : null
  };
}

function normalizeHost(value: string): string {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    return new URL(input).host.toLowerCase();
  } catch {
    try {
      return new URL(`https://${input.replace(/^\/+/, "")}`).host.toLowerCase();
    } catch {
      return "";
    }
  }
}

function isDomainMismatch(service: HttpService, actualHost: string): boolean {
  if (!actualHost) return true;
  const isPolyService = service.startsWith("POLY_");
  if (isPolyService && actualHost.includes("revx.revolut.com")) return true;
  if (service === "REVX" && actualHost.includes("polymarket.com")) return true;
  return false;
}
