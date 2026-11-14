import { useCallback, useEffect, useRef, useState } from 'react';

export type HorizonStreamType = 'transactions' | 'payments' | 'operations';

export interface EventSourceLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close: () => void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface UseHorizonStreamOptions<T = Record<string, unknown>> {
  /** Optional Stellar account public key (G...) to scope the stream to a single account */
  account?: string;
  /** Horizon base URL (defaults to https://horizon-testnet.stellar.org) */
  horizonUrl?: string;
  /** Cursor token ('now' or paging_token) to resume from */
  cursor?: string;
  /** Order of stream events ('asc' | 'desc', defaults to 'asc' for live streaming) */
  order?: 'asc' | 'desc';
  /** Whether the subscription is active (defaults to true) */
  enabled?: boolean;
  /** Maximum number of items kept in the `messages` history buffer (defaults to 50) */
  maxHistory?: number;
  /** Whether to automatically reconnect when the SSE stream disconnects (defaults to true) */
  autoReconnect?: boolean;
  /** Base reconnect delay in milliseconds (defaults to 1000) */
  initialReconnectDelayMs?: number;
  /** Maximum reconnect delay in milliseconds (defaults to 30000) */
  maxReconnectDelayMs?: number;
  /** Maximum reconnect attempts before reporting a terminal disconnect error (defaults to 10) */
  maxReconnectAttempts?: number;
  /** Optional callback fired whenever a parsed stream payload arrives */
  onMessage?: (payload: T) => void;
  /** Custom EventSource factory for dependency injection and deterministic testing */
  eventSourceFactory?: EventSourceFactory;
}

export interface UseHorizonStreamResult<T = Record<string, unknown>> {
  /** Most recent parsed SSE event payload */
  data: T | null;
  /** History of received SSE event payloads (newest first) */
  messages: T[];
  /** Current stream error, if any */
  error: Error | null;
  /** True when the EventSource connection is open */
  isConnected: boolean;
  /** Number of consecutive reconnect attempts since last successful open */
  reconnectAttempts: number;
  /** Latest cursor / paging_token received from the stream */
  lastCursor: string | null;
  /** Manually close and re-open the SSE stream */
  reconnect: () => void;
  /** Manually close the SSE stream and cancel pending reconnect timers */
  disconnect: () => void;
}

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/**
 * Builds the canonical Stellar Horizon SSE endpoint URL for a given stream type and options.
 */
export function buildHorizonStreamUrl(
  type: HorizonStreamType,
  options: Pick<UseHorizonStreamOptions, 'account' | 'horizonUrl' | 'cursor' | 'order'> = {},
  resumeCursor?: string | null
): string {
  const baseUrl = (options.horizonUrl || DEFAULT_HORIZON_URL).trim().replace(/\/+$/, '');
  const accountId = options.account?.trim();
  const path = accountId
    ? `/accounts/${encodeURIComponent(accountId)}/${type}`
    : `/${type}`;

  const params = new URLSearchParams();
  const effectiveCursor = resumeCursor || options.cursor || 'now';
  params.set('cursor', effectiveCursor);
  if (options.order) {
    params.set('order', options.order);
  }

  return `${baseUrl}${path}?${params.toString()}`;
}

export interface HorizonStreamControllerState<T = Record<string, unknown>> {
  data: T | null;
  messages: T[];
  error: Error | null;
  isConnected: boolean;
  reconnectAttempts: number;
  lastCursor: string | null;
}

/**
 * Framework-agnostic SSE subscription manager used by `useHorizonStream`.
 * Exported to support deterministic unit testing and non-React consumers.
 */
export function createHorizonStreamController<T = Record<string, unknown>>(
  type: HorizonStreamType,
  options: UseHorizonStreamOptions<T>,
  onStateChange: (state: HorizonStreamControllerState<T>) => void
): {
  connect: () => void;
  disconnect: () => void;
  reconnect: () => void;
  getState: () => HorizonStreamControllerState<T>;
} {
  const maxHistory = Math.max(1, options.maxHistory ?? 50);
  const autoReconnect = options.autoReconnect ?? true;
  const initialDelay = Math.max(10, options.initialReconnectDelayMs ?? 1000);
  const maxDelay = Math.max(initialDelay, options.maxReconnectDelayMs ?? 30000);
  const maxAttempts = Math.max(0, options.maxReconnectAttempts ?? 10);

  let currentSource: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isDisposed = false;

  let state: HorizonStreamControllerState<T> = {
    data: null,
    messages: [],
    error: null,
    isConnected: false,
    reconnectAttempts: 0,
    lastCursor: options.cursor ?? null,
  };

  const emit = (patch: Partial<HorizonStreamControllerState<T>>) => {
    if (isDisposed) return;
    state = { ...state, ...patch };
    onStateChange(state);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeCurrentSource = () => {
    if (currentSource) {
      currentSource.onopen = null;
      currentSource.onmessage = null;
      currentSource.onerror = null;
      currentSource.close();
      currentSource = null;
    }
  };

  const resolveFactory = (): EventSourceFactory => {
    if (options.eventSourceFactory) {
      return options.eventSourceFactory;
    }
    if (typeof globalThis.EventSource === 'function') {
      return (url: string) => new globalThis.EventSource(url) as unknown as EventSourceLike;
    }
    throw new Error('EventSource is not available in this environment');
  };

  const openStream = () => {
    if (isDisposed || options.enabled === false) {
      return;
    }
    clearReconnectTimer();
    closeCurrentSource();

    const url = buildHorizonStreamUrl(type, options, state.lastCursor);
    let source: EventSourceLike;
    try {
      const factory = resolveFactory();
      source = factory(url);
    } catch (err) {
      emit({
        isConnected: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    currentSource = source;

    source.onopen = () => {
      if (isDisposed || currentSource !== source) return;
      emit({
        isConnected: true,
        error: null,
        reconnectAttempts: 0,
      });
    };

    source.onmessage = (event: { data: string; lastEventId?: string }) => {
      if (isDisposed || currentSource !== source) return;
      const raw = event?.data;
      if (!raw || raw === '"hello"' || raw === 'hello' || raw === '"byebye"') {
        return;
      }

      try {
        const parsed = JSON.parse(raw) as T & { paging_token?: string };
        const nextCursor =
          (typeof parsed === 'object' && parsed !== null && typeof parsed.paging_token === 'string'
            ? parsed.paging_token
            : undefined) ??
          (event.lastEventId || state.lastCursor);

        const nextMessages = [parsed, ...state.messages].slice(0, maxHistory);
        emit({
          data: parsed,
          messages: nextMessages,
          isConnected: true,
          error: null,
          lastCursor: nextCursor ?? state.lastCursor,
        });
        options.onMessage?.(parsed);
      } catch {
        emit({
          error: new Error('Failed to parse Horizon SSE event payload'),
        });
      }
    };

    source.onerror = () => {
      if (isDisposed || currentSource !== source) return;
      closeCurrentSource();

      const nextAttempt = state.reconnectAttempts + 1;
      if (!autoReconnect || nextAttempt > maxAttempts) {
        emit({
          isConnected: false,
          reconnectAttempts: state.reconnectAttempts,
          error: new Error(
            `Horizon SSE stream disconnected after ${state.reconnectAttempts} reconnect attempts`
          ),
        });
        return;
      }

      const delay = Math.min(maxDelay, initialDelay * Math.pow(2, nextAttempt - 1));
      emit({
        isConnected: false,
        reconnectAttempts: nextAttempt,
        error: new Error(`Horizon SSE stream connection lost. Reconnecting (attempt ${nextAttempt})...`),
      });

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openStream();
      }, delay);
    };
  };

  const disconnect = () => {
    isDisposed = true;
    clearReconnectTimer();
    closeCurrentSource();
  };

  const reconnect = () => {
    isDisposed = false;
    state = { ...state, reconnectAttempts: 0, error: null };
    openStream();
  };

  return {
    connect: () => {
      isDisposed = false;
      openStream();
    },
    disconnect,
    reconnect,
    getState: () => state,
  };
}

/**
 * React hook that subscribes to Stellar Horizon Server-Sent Events (SSE) streams
 * (`transactions`, `payments`, or `operations`) with automatic cursor tracking,
 * exponential backoff reconnection, and unmount cleanup.
 */
export function useHorizonStream<T = Record<string, unknown>>(
  type: HorizonStreamType,
  options: UseHorizonStreamOptions<T> = {}
): UseHorizonStreamResult<T> {
  const {
    account,
    horizonUrl = DEFAULT_HORIZON_URL,
    cursor = 'now',
    order = 'asc',
    enabled = true,
    maxHistory = 50,
    autoReconnect = true,
    initialReconnectDelayMs = 1000,
    maxReconnectDelayMs = 30000,
    maxReconnectAttempts = 10,
    eventSourceFactory,
    onMessage,
  } = options;

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const controllerRef = useRef<ReturnType<typeof createHorizonStreamController<T>> | null>(null);

  const [state, setState] = useState<HorizonStreamControllerState<T>>({
    data: null,
    messages: [],
    error: null,
    isConnected: false,
    reconnectAttempts: 0,
    lastCursor: cursor,
  });

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({ ...prev, isConnected: false }));
      return;
    }

    const controller = createHorizonStreamController<T>(
      type,
      {
        account,
        horizonUrl,
        cursor,
        order,
        enabled,
        maxHistory,
        autoReconnect,
        initialReconnectDelayMs,
        maxReconnectDelayMs,
        maxReconnectAttempts,
        eventSourceFactory,
        onMessage: (payload) => onMessageRef.current?.(payload),
      },
      (nextState) => {
        setState(nextState);
      }
    );

    controllerRef.current = controller;
    controller.connect();

    return () => {
      controller.disconnect();
      controllerRef.current = null;
    };
  }, [
    type,
    account,
    horizonUrl,
    cursor,
    order,
    enabled,
    maxHistory,
    autoReconnect,
    initialReconnectDelayMs,
    maxReconnectDelayMs,
    maxReconnectAttempts,
    eventSourceFactory,
  ]);

  const reconnect = useCallback(() => {
    controllerRef.current?.reconnect();
  }, []);

  const disconnect = useCallback(() => {
    controllerRef.current?.disconnect();
    setState((prev) => ({ ...prev, isConnected: false }));
  }, []);

  return {
    data: state.data,
    messages: state.messages,
    error: state.error,
    isConnected: state.isConnected,
    reconnectAttempts: state.reconnectAttempts,
    lastCursor: state.lastCursor,
    reconnect,
    disconnect,
  };
}
