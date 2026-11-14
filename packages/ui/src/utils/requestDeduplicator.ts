export interface RequestDeduplicatorOptions {
  /**
   * Optional custom key normalizer. Defaults to normalizing HTTP method + canonical URL
   * (with sorted query parameters so equivalent Horizon requests coalesce).
   */
  normalizeKey?: (key: string) => string;
}

/**
 * Normalizes a request URL or cache key so equivalent URLs (e.g. different query param order
 * or trailing slashes on the path) map to the same in-flight deduplication key.
 */
export function normalizeRequestKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const sortedParams = new URLSearchParams(
      Array.from(parsed.searchParams.entries()).sort(([aKey, aVal], [bKey, bVal]) =>
        aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey)
      )
    );
    const search = sortedParams.toString();
    parsed.search = search ? `?${search}` : '';
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Deduplicates concurrent in-flight asynchronous requests by URL/key.
 *
 * When multiple components request the same resource simultaneously, only a single
 * underlying network call is executed and its Promise is shared across all concurrent
 * callers. Once the Promise settles (resolves or rejects), the in-flight entry is
 * immediately evicted so subsequent requests fetch fresh data.
 */
export class RequestDeduplicator {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly normalizeKey: (key: string) => string;

  constructor(options: RequestDeduplicatorOptions = {}) {
    this.normalizeKey = options.normalizeKey ?? normalizeRequestKey;
  }

  /**
   * Executes `fetcher` for `key` if no request for `key` is currently in flight,
   * or returns the existing in-flight Promise if one is already pending.
   */
  public deduplicate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const canonicalKey = this.normalizeKey(key);
    const existing = this.inFlight.get(canonicalKey) as Promise<T> | undefined;
    if (existing !== undefined) {
      return existing;
    }

    let requestPromise: Promise<T>;
    try {
      requestPromise = Promise.resolve().then(fetcher);
    } catch (syncError) {
      return Promise.reject(syncError);
    }

    const trackedPromise = requestPromise.finally(() => {
      if (this.inFlight.get(canonicalKey) === trackedPromise) {
        this.inFlight.delete(canonicalKey);
      }
    });

    this.inFlight.set(canonicalKey, trackedPromise);
    return trackedPromise;
  }

  /**
   * Returns true if a request for the given key is currently in flight.
   */
  public isInFlight(key: string): boolean {
    return this.inFlight.has(this.normalizeKey(key));
  }

  /**
   * Returns the number of currently active in-flight requests.
   */
  public get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Clears all tracked in-flight entries.
   */
  public clear(): void {
    this.inFlight.clear();
  }
}

/**
 * Shared default deduplicator instance for Horizon API requests.
 */
export const defaultRequestDeduplicator = new RequestDeduplicator();

/**
 * Convenience helper to deduplicate an in-flight request using the shared default instance.
 */
export function deduplicateRequest<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  return defaultRequestDeduplicator.deduplicate(key, fetcher);
}
