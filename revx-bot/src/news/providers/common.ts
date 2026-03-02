import { createHash } from "node:crypto";

export const NEWS_PROVIDER_TIMEOUT_MS = 4_000;

export async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json, application/xml, text/xml, text/plain; q=0.8",
        "user-agent": "revx-bot-intel/1.0 (+https://localhost)"
      }
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeTitle(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeXmlEntities(value: string): string {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

export function stripHtml(value: string): string {
  return decodeXmlEntities(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function coerceTimestamp(value: unknown, fallbackTs: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  const parsed = Date.parse(String(value ?? ""));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackTs;
}

export function sourceFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function makeHeadlineId(title: string, url: string): string {
  const normalized = `${normalizeTitle(title)}|${String(url || "").trim().toLowerCase()}`;
  return createHash("sha1").update(normalized).digest("hex");
}

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  retries: number
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      if (attempt >= retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "unknown error"));
}
