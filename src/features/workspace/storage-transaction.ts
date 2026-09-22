// Web Locks serialize read/modify/write across tabs; the queue also covers
// non-browser runtimes and callers using different wrappers for the same store.
const queues = new Map<string, Promise<unknown>>();

export function withStorageTransaction<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result: Promise<T> = previous.catch(() => undefined).then(async () => {
    const locks = globalThis.navigator?.locks;
    return locks ? await locks.request(`justwork:${key}`, action) : await action();
  });
  queues.set(key, result);
  void result.finally(() => {
    if (queues.get(key) === result) queues.delete(key);
  }).catch(() => undefined);
  return result;
}
