import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRequestKey,
  RequestDeduplicator,
} from './requestDeduplicator';
import {
  fetchHorizonAccount,
  fetchHorizonJson,
} from './horizonClient';

test('normalizeRequestKey canonicalizes trailing slashes and query parameter ordering', () => {
  const urlA = 'https://horizon-testnet.stellar.org/accounts/GABC123/?order=desc&limit=10';
  const urlB = 'https://horizon-testnet.stellar.org/accounts/GABC123?limit=10&order=desc';
  assert.equal(normalizeRequestKey(urlA), normalizeRequestKey(urlB));
});

test('RequestDeduplicator executes only 1 network call for concurrent callers and clears entry after settling', async () => {
  const deduplicator = new RequestDeduplicator();
  let callCount = 0;

  const url = 'https://horizon-testnet.stellar.org/accounts/GDEST123456';
  const fetcher = async () => {
    callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: 'GDEST123456', sequence: String(100 + callCount) };
  };

  // Fire 3 concurrent requests for the same URL (e.g. BalanceCard, AssetList, PaymentHistory)
  const p1 = deduplicator.deduplicate(url, fetcher);
  const p2 = deduplicator.deduplicate(url + '/', fetcher);
  const p3 = deduplicator.deduplicate(url, fetcher);

  assert.equal(deduplicator.isInFlight(url), true);
  assert.equal(deduplicator.inFlightCount, 1);

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(callCount, 1);
  assert.deepEqual(r1, { id: 'GDEST123456', sequence: '101' });
  assert.deepEqual(r2, r1);
  assert.deepEqual(r3, r1);

  // Cache entry must be cleared after completion
  assert.equal(deduplicator.isInFlight(url), false);
  assert.equal(deduplicator.inFlightCount, 0);

  // Subsequent request after completion must trigger a fresh call
  const r4 = await deduplicator.deduplicate(url, fetcher);
  assert.equal(callCount, 2);
  assert.deepEqual(r4, { id: 'GDEST123456', sequence: '102' });
});

test('RequestDeduplicator clears in-flight cache when a request rejects so subsequent retries succeed', async () => {
  const deduplicator = new RequestDeduplicator();
  let attempts = 0;
  const url = 'https://horizon-testnet.stellar.org/transactions?limit=5';

  const failingThenSuccess = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (attempts === 1) {
      throw new Error('Temporary Horizon 503');
    }
    return { records: ['tx-1'] };
  };

  await assert.rejects(
    Promise.all([
      deduplicator.deduplicate(url, failingThenSuccess),
      deduplicator.deduplicate(url, failingThenSuccess),
    ]),
    /Temporary Horizon 503/
  );

  assert.equal(attempts, 1);
  assert.equal(deduplicator.isInFlight(url), false);

  const recovered = await deduplicator.deduplicate(url, failingThenSuccess);
  assert.equal(attempts, 2);
  assert.deepEqual(recovered, { records: ['tx-1'] });
});

test('fetchHorizonAccount and fetchHorizonJson deduplicate concurrent GET requests and bypass POST', async () => {
  const deduplicator = new RequestDeduplicator();
  const networkCalls: { url: string; method: string }[] = [];

  const mockFetch = async (url: string, init?: RequestInit) => {
    networkCalls.push({ url, method: init?.method || 'GET' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    return {
      ok: true,
      status: 200,
      json: async () => ({ account_id: 'GUSER999', callNumber: networkCalls.length }),
    };
  };

  const [accA, accB] = await Promise.all([
    fetchHorizonAccount('GUSER999', { deduplicator, fetchFn: mockFetch }),
    fetchHorizonAccount('GUSER999', { deduplicator, fetchFn: mockFetch }),
  ]);

  assert.equal(networkCalls.length, 1);
  assert.deepEqual(accA, accB);

  // Concurrent POST requests should not be deduplicated
  await Promise.all([
    fetchHorizonJson('/transactions', { method: 'POST', deduplicator, fetchFn: mockFetch }),
    fetchHorizonJson('/transactions', { method: 'POST', deduplicator, fetchFn: mockFetch }),
  ]);

  assert.equal(networkCalls.length, 3);
});
