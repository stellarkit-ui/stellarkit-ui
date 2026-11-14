import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHorizonStreamUrl,
  createHorizonStreamController,
  type EventSourceLike,
  type HorizonStreamControllerState,
} from './useHorizonStream';

class MockEventSource implements EventSourceLike {
  public url: string;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public closed = false;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.({});
  }

  emitMessage(data: string, lastEventId?: string): void {
    this.onmessage?.({ data, lastEventId });
  }

  emitError(): void {
    this.onerror?.(new Error('stream disconnected'));
  }
}

test('buildHorizonStreamUrl builds canonical global and account-scoped SSE URLs', () => {
  assert.equal(
    buildHorizonStreamUrl('transactions'),
    'https://horizon-testnet.stellar.org/transactions?cursor=now'
  );

  assert.equal(
    buildHorizonStreamUrl('payments', {
      account: 'GABC1234567890',
      horizonUrl: 'https://horizon.stellar.org/',
      cursor: '12345',
      order: 'asc',
    }),
    'https://horizon.stellar.org/accounts/GABC1234567890/payments?cursor=12345&order=asc'
  );

  assert.equal(
    buildHorizonStreamUrl('operations', { cursor: 'now' }, '999888'),
    'https://horizon-testnet.stellar.org/operations?cursor=999888'
  );
});

test('createHorizonStreamController connects, ignores heartbeat, and parses incoming SSE payloads', () => {
  const instances: MockEventSource[] = [];
  const states: HorizonStreamControllerState<{ id: string; paging_token: string }>[] = [];
  const received: { id: string; paging_token: string }[] = [];

  const controller = createHorizonStreamController<{ id: string; paging_token: string }>(
    'payments',
    {
      account: 'GDEST1234',
      eventSourceFactory: (url) => {
        const es = new MockEventSource(url);
        instances.push(es);
        return es;
      },
      onMessage: (payload) => received.push(payload),
    },
    (state) => states.push(state)
  );

  controller.connect();
  assert.equal(instances.length, 1);
  assert.equal(
    instances[0].url,
    'https://horizon-testnet.stellar.org/accounts/GDEST1234/payments?cursor=now'
  );

  instances[0].emitOpen();
  assert.equal(controller.getState().isConnected, true);
  assert.equal(controller.getState().error, null);

  // Horizon sends a "hello" heartbeat frame on initial open; it should be ignored
  instances[0].emitMessage('"hello"');
  assert.equal(controller.getState().data, null);

  // Emit a valid payment event
  instances[0].emitMessage(JSON.stringify({ id: 'pay-1', paging_token: 'cursor-101' }));
  assert.deepEqual(controller.getState().data, { id: 'pay-1', paging_token: 'cursor-101' });
  assert.equal(controller.getState().lastCursor, 'cursor-101');
  assert.equal(received.length, 1);

  controller.disconnect();
  assert.equal(instances[0].closed, true);
});

test('createHorizonStreamController automatically reconnects on disconnect and resumes from last paging_token', async () => {
  const instances: MockEventSource[] = [];

  const controller = createHorizonStreamController<{ id: string; paging_token: string }>(
    'transactions',
    {
      initialReconnectDelayMs: 15,
      maxReconnectDelayMs: 50,
      maxReconnectAttempts: 3,
      eventSourceFactory: (url) => {
        const es = new MockEventSource(url);
        instances.push(es);
        return es;
      },
    },
    () => {}
  );

  controller.connect();
  instances[0].emitOpen();
  instances[0].emitMessage(JSON.stringify({ id: 'tx-1', paging_token: 'tok-555' }));

  // Simulate network drop
  instances[0].emitError();
  assert.equal(instances[0].closed, true);
  assert.equal(controller.getState().isConnected, false);
  assert.equal(controller.getState().reconnectAttempts, 1);

  // Wait for automatic reconnect timer
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(instances.length, 2);
  assert.equal(
    instances[1].url,
    'https://horizon-testnet.stellar.org/transactions?cursor=tok-555'
  );

  instances[1].emitOpen();
  assert.equal(controller.getState().isConnected, true);
  assert.equal(controller.getState().reconnectAttempts, 0);

  controller.disconnect();
});

test('createHorizonStreamController stops reconnecting when maxReconnectAttempts is reached or when unmounted', async () => {
  const instances: MockEventSource[] = [];

  const controller = createHorizonStreamController(
    'operations',
    {
      initialReconnectDelayMs: 10,
      maxReconnectAttempts: 1,
      eventSourceFactory: (url) => {
        const es = new MockEventSource(url);
        instances.push(es);
        return es;
      },
    },
    () => {}
  );

  controller.connect();
  instances[0].emitOpen();

  // First error triggers attempt #1
  instances[0].emitError();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(instances.length, 2);

  // Second error exceeds maxReconnectAttempts (1) -> stops reconnecting
  instances[1].emitError();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(instances.length, 2);
  assert.equal(controller.getState().isConnected, false);
  assert.match(
    controller.getState().error?.message ?? '',
    /disconnected after 1 reconnect attempts/i
  );

  controller.disconnect();
});
