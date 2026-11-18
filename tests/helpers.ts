export type FetchHandler = (...args: Parameters<typeof fetch>) => Promise<Response>;

/** Stub outbound fetch for the production Worker (same isolate as the test). */
export async function withStubbedFetch<T>(
  handler: FetchHandler,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
