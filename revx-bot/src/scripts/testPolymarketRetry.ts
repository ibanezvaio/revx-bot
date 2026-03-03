import { withRetry } from "../polymarket/auth/retry";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("retry me") as Error & { status?: number };
        error.status = 429;
        throw error;
      }
      return "ok";
    },
    {
      maxRetries: 5,
      baseDelayMs: 1,
      maxDelayMs: 10,
      jitterMs: 0,
      isRetryable: (error) => Number((error as { status?: number }).status) === 429
    }
  );

  assert(result === "ok", "expected successful retry result");
  assert(calls === 3, `expected 3 calls, got ${calls}`);

  let failed = false;
  try {
    await withRetry(
      async () => {
        throw new Error("fatal");
      },
      {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 10,
        jitterMs: 0,
        isRetryable: () => false
      }
    );
  } catch {
    failed = true;
  }
  assert(failed, "expected non-retryable error to bubble");

  // eslint-disable-next-line no-console
  console.log("Polymarket retry tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket retry tests: FAIL", error);
  process.exit(1);
});
