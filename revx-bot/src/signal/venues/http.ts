import { request as httpsRequest } from "node:https";

type FetchResponseLike = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type FetchLike = (
  input: string,
  init?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
  }
) => Promise<FetchResponseLike>;

export async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const nowFetch = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (typeof nowFetch === "function") {
    return fetchViaGlobalFetch(nowFetch, url, timeoutMs);
  }
  return fetchViaHttps(url, timeoutMs);
}

async function fetchViaGlobalFetch(
  fetchLike: FetchLike,
  url: string,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLike(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return parseJson(body);
  } finally {
    clearTimeout(timer);
  }
}

function fetchViaHttps(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve(parseJson(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => reject(error));
    req.end();
  });
}

function parseJson(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

