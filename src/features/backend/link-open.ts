export type BackendLinkWarmupOptions = {
  attempts?: number;
  delayMs?: number;
  fetcher?: typeof fetch;
};

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function warmBackendLink(url: string, options: BackendLinkWarmupOptions = {}): Promise<void> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 2));
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const fetcher = options.fetcher ?? fetch;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(delayMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Connection error"));
}
