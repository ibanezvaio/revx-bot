import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

type NativeHttpsOptions = {
  parentSignal?: AbortSignal;
  redirectDepth?: number;
};

const MAX_REDIRECTS = 2;

export async function fetchJsonWithNativeHttps(
  url: string,
  timeoutMs: number,
  options: NativeHttpsOptions = {}
): Promise<unknown> {
  const redirectDepth = Math.max(0, Math.floor(options.redirectDepth ?? 0));
  if (redirectDepth > MAX_REDIRECTS) {
    throw new Error(`HTTP_FETCH_FAILED phase=headers status=310 elapsedMs=0: too_many_redirects url=${url}`);
  }

  return new Promise((resolve, reject) => {
    let phase: "connect" | "headers" | "body" | "parse" = "connect";
    const startedTs = Date.now();
    const target = new URL(url);
    const parentSignal = options.parentSignal;
    let parentListener: (() => void) | null = null;

    if (parentSignal?.aborted) {
      reject(
        new Error(
          `ABORTED_PARENT_SIGNAL (${String(parentSignal.reason ?? "parent_signal")}) phase=connect status=0 elapsedMs=0`
        )
      );
      return;
    }

    const req = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "user-agent": "revx-bot/venue-probe"
        }
      },
      (res) => {
        phase = "headers";
        const status = Number(res.statusCode || 0);

        if (status >= 300 && status < 400) {
          const location = String(res.headers.location || "").trim();
          if (!location) {
            const elapsedMs = Date.now() - startedTs;
            reject(
              new Error(
                `HTTP_FETCH_FAILED phase=headers status=${status} elapsedMs=${elapsedMs}: missing_redirect_location`
              )
            );
            return;
          }
          res.resume();
          const redirectUrl = new URL(location, target).toString();
          fetchJsonWithNativeHttps(redirectUrl, timeoutMs, {
            parentSignal,
            redirectDepth: redirectDepth + 1
          }).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          phase = "body";
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          const elapsedMs = Date.now() - startedTs;
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!(status >= 200 && status < 300)) {
            reject(new Error(`HTTP_FETCH_FAILED phase=headers status=${status} elapsedMs=${elapsedMs}: HTTP ${status}`));
            return;
          }
          phase = "parse";
          try {
            resolve(raw.length > 0 ? JSON.parse(raw) : {});
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reject(
              new Error(
                `HTTP_FETCH_FAILED phase=parse status=${status} elapsedMs=${elapsedMs}: ${message}`
              )
            );
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`ABORTED_LOCAL_TIMEOUT (local_timeout) phase=${phase}`));
    });

    req.on("error", (error) => {
      const elapsedMs = Date.now() - startedTs;
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`HTTP_FETCH_FAILED phase=${phase} status=0 elapsedMs=${elapsedMs}: ${message}`));
    });

    if (parentSignal) {
      parentListener = () => {
        req.destroy(new Error(`ABORTED_PARENT_SIGNAL (${String(parentSignal.reason ?? "parent_signal")})`));
      };
      parentSignal.addEventListener("abort", parentListener, { once: true });
      req.on("close", () => {
        if (parentListener) {
          parentSignal.removeEventListener("abort", parentListener);
        }
      });
    }

    req.end();
  });
}
