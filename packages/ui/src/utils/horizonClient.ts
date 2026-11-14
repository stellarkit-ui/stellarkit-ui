import {
  defaultRequestDeduplicator,
  RequestDeduplicator,
} from './requestDeduplicator';

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
}>;

export interface HorizonFetchOptions extends RequestInit {
  /** Base Horizon server URL (defaults to https://horizon-testnet.stellar.org) */
  horizonUrl?: string;
  /** Whether to deduplicate concurrent GET requests (defaults to true) */
  deduplicate?: boolean;
  /** Optional custom RequestDeduplicator instance */
  deduplicator?: RequestDeduplicator;
  /** Optional custom fetch implementation for testing */
  fetchFn?: FetchLike;
}

export class HorizonHttpError extends Error {
  public readonly status: number;
  public readonly url: string;

  constructor(status: number, url: string, message?: string) {
    super(message || `Horizon request failed with status ${status}: ${url}`);
    this.name = 'HorizonHttpError';
    this.status = status;
    this.url = url;
  }
}

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/**
 * Resolves a relative Horizon path or absolute URL into a full endpoint URL.
 */
export function resolveHorizonUrl(pathOrUrl: string, horizonUrl = DEFAULT_HORIZON_URL): string {
  const trimmed = pathOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const base = horizonUrl.trim().replace(/\/+$/, '');
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${base}${path}`;
}

/**
 * Fetches JSON from a Stellar Horizon endpoint with automatic in-flight GET request deduplication.
 */
export async function fetchHorizonJson<T = unknown>(
  pathOrUrl: string,
  options: HorizonFetchOptions = {}
): Promise<T> {
  const {
    horizonUrl = DEFAULT_HORIZON_URL,
    deduplicate = true,
    deduplicator = defaultRequestDeduplicator,
    fetchFn,
    ...requestInit
  } = options;

  const url = resolveHorizonUrl(pathOrUrl, horizonUrl);
  const method = (requestInit.method || 'GET').toUpperCase();
  const runtimeFetch: FetchLike =
    fetchFn ?? (globalThis.fetch as unknown as FetchLike);

  if (typeof runtimeFetch !== 'function') {
    throw new Error('Global fetch is not available in this environment');
  }

  const executeFetch = async (): Promise<T> => {
    const response = await runtimeFetch(url, {
      ...requestInit,
      method,
      headers: {
        Accept: 'application/json',
        ...(requestInit.headers || {}),
      },
    });

    if (!response.ok) {
      throw new HorizonHttpError(
        response.status,
        url,
        `Horizon HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ''} for ${url}`
      );
    }

    return (await response.json()) as T;
  };

  if (!deduplicate || method !== 'GET') {
    return executeFetch();
  }

  return deduplicator.deduplicate<T>(url, executeFetch);
}

/**
 * Fetches a Stellar account summary from Horizon (`/accounts/:accountId`),
 * automatically coalescing concurrent requests from multiple mounted components.
 */
export function fetchHorizonAccount<T = Record<string, unknown>>(
  accountId: string,
  options: HorizonFetchOptions = {}
): Promise<T> {
  const trimmed = accountId.trim();
  if (!trimmed) {
    return Promise.reject(new Error('Stellar account ID is required'));
  }
  return fetchHorizonJson<T>(`/accounts/${encodeURIComponent(trimmed)}`, options);
}
