export type RetryOptions = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
};

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries);
  const baseDelayMs = Math.max(1, options.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs);

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      const retryable = options.isRetryable ? options.isRetryable(error) : true;
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1) + jitter(options.jitterMs));
      options.onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxJitterMs: number): number {
  const upper = Math.max(0, Math.floor(maxJitterMs));
  if (upper <= 0) return 0;
  return Math.floor(Math.random() * (upper + 1));
}
