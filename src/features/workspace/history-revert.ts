export type HistoryRevertRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  shouldRetry: (error: unknown) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
};

const defaultSleep = (delayMs: number): Promise<void> => (
  new Promise((resolve) => window.setTimeout(resolve, delayMs))
);

export async function runHistoryRevertWithRetry<T>(
  operation: () => Promise<T>,
  options: HistoryRevertRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1 || !options.shouldRetry(error)) throw error;
      await sleep(baseDelayMs * (2 ** attempt));
    }
  }

  throw lastError;
}
