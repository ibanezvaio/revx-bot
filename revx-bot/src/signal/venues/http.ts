import { request as httpsRequest } from "node:https";
import { initNetworkTransport } from "../../http/networkTransport";

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

type FetchTimeoutOptions = {
  parentSignal?: AbortSignal;
};

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
  options: FetchTimeoutOptions = {}
): Promise<unknown> {
  initNetworkTransport();
  const nowFetch = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (typeof nowFetch === "function") {
    return fetchViaGlobalFetch(nowFetch, url, timeoutMs, options);
  }
  return fetchViaHttps(url, timeoutMs, options);
}

async function fetchViaGlobalFetch(
  fetchLike: FetchLike,
  url: string,
  timeoutMs: number,
  options: FetchTimeoutOptions
): Promise<unknown> {
  let phase: "connect" | "headers" | "body" = "connect";
  const controller = new AbortController();
  const parentSignal = options.parentSignal;
  let parentListener: (() => void) | null = null;

  if (parentSignal) {
    const onParentAbort = (): void => {
      controller.abort(parentSignal.reason ?? "parent_signal");
    };
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      parentListener = onParentAbort;
    }
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort("local_timeout");
    }
  }, timeoutMs);
  try {
    const response = await fetchLike(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    phase = "headers";
    const body = await response.text();
    phase = "body";
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} phase=${phase}`);
    }
    return parseJson(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failurePhase = detectFailurePhase(message, phase);
    if (controller.signal.aborted) {
      const source = parentSignal?.aborted ? "PARENT_SIGNAL" : "LOCAL_TIMEOUT";
      const reasonText =
        source === "PARENT_SIGNAL"
          ? String(parentSignal?.reason ?? controller.signal.reason ?? "parent_signal")
          : String(controller.signal.reason ?? "local_timeout");
      throw new Error(`ABORTED_${source} (${reasonText}) phase=${failurePhase}: ${message}`);
    }
    throw new Error(`HTTP_FETCH_FAILED phase=${failurePhase}: ${message}`);
  } finally {
    clearTimeout(timer);
    if (parentSignal && parentListener) {
      parentSignal.removeEventListener("abort", parentListener);
    }
  }
}

function fetchViaHttps(url: string, timeoutMs: number, options: FetchTimeoutOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (options.parentSignal?.aborted) {
      reject(new Error(`ABORTED_PARENT_SIGNAL (${String(options.parentSignal.reason ?? "parent_signal")})`));
      return;
    }
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
    const parentSignal = options.parentSignal;
    let parentListener: (() => void) | null = null;
    if (parentSignal) {
      parentListener = () => {
        req.destroy(new Error(`ABORTED_PARENT_SIGNAL (${String(parentSignal.reason ?? "parent_signal")})`));
      };
      parentSignal.addEventListener("abort", parentListener, { once: true });
    }
    req.on("timeout", () => {
      req.destroy(new Error("ABORTED_LOCAL_TIMEOUT (timeout) phase=connect"));
    });
    req.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`HTTP_FETCH_FAILED phase=connect: ${message}`));
    });
    req.on("close", () => {
      if (parentSignal && parentListener) {
        parentSignal.removeEventListener("abort", parentListener);
      }
    });
    req.end();
  });
}

function parseJson(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

function detectFailurePhase(errorText: string, fallback: "connect" | "headers" | "body"): string {
  const text = String(errorText || "").toUpperCase();
  if (text.includes("PHASE=DNS")) return "dns";
  if (text.includes("PHASE=CONNECT")) return "connect";
  if (text.includes("PHASE=HEADERS")) return "headers";
  if (text.includes("PHASE=BODY")) return "body";
  if (text.includes("ENOTFOUND") || text.includes("EAI_AGAIN")) return "dns";
  if (
    text.includes("ECONNREFUSED") ||
    text.includes("ECONNRESET") ||
    text.includes("ETIMEDOUT") ||
    text.includes("UND_ERR_CONNECT_TIMEOUT")
  ) {
    return "connect";
  }
  return fallback;
}
