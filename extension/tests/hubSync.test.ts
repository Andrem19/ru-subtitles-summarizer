import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HUB_SYNC_MAX_QUEUE,
  dueUploads,
  emptyHubSyncState,
  enqueueUpload,
  pushGuideToHub,
  recordConflict,
  recordFailure,
  recordSuccess,
  type HubSyncState,
} from '../src/shared/hubSync';

const NOW = 1_800_000_000_000;
const UPLOAD = { entityId: 'sg-abc123', transcriptHash: 'a'.repeat(64), payload: '{"schemaVersion":1}' };

test('enqueue: dedup by entityId — a repeat never creates a second queue entry', () => {
  let state: HubSyncState = emptyHubSyncState();
  state = enqueueUpload(state, { ...UPLOAD, now: NOW }).state;
  const again = enqueueUpload(state, { ...UPLOAD, now: NOW + 1 });
  assert.equal(again.duplicate, false); // replaced in place, still one entry
  assert.equal(again.state.queue.length, 1);
});

test('enqueue: an already-uploaded entityId is refused outright', () => {
  let state: HubSyncState = emptyHubSyncState();
  state = enqueueUpload(state, { ...UPLOAD, now: NOW }).state;
  state = recordSuccess(state, UPLOAD.entityId, NOW + 1);
  const retry = enqueueUpload(state, { ...UPLOAD, now: NOW + 2 });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.state.queue.length, 0);
});

test('the queue is bounded: the OLDEST undelivered upload yields its slot', () => {
  let state: HubSyncState = emptyHubSyncState();
  for (let i = 0; i < HUB_SYNC_MAX_QUEUE + 3; i++) {
    const result = enqueueUpload(state, { ...UPLOAD, entityId: `sg-${String(i).padStart(3, '0')}`, now: NOW + i });
    state = result.state;
    if (i < HUB_SYNC_MAX_QUEUE) assert.equal(result.dropped, 0);
    else assert.equal(result.dropped, 1);
  }
  assert.equal(state.queue.length, HUB_SYNC_MAX_QUEUE);
  assert.equal(state.queue[0].entityId, 'sg-003'); // the three oldest are gone
});

test('failures back off exponentially; a conflict leaves the retry queue for review', () => {
  let state: HubSyncState = emptyHubSyncState();
  state = enqueueUpload(state, { ...UPLOAD, now: NOW }).state;
  state = recordFailure(state, UPLOAD.entityId, 'HTTP 503', NOW);
  assert.equal(state.queue[0].attempts, 1);
  assert.equal(state.queue[0].nextAttemptAt, NOW + 30_000);
  state = recordFailure(state, UPLOAD.entityId, 'HTTP 503', NOW + 30_000);
  assert.equal(state.queue[0].nextAttemptAt, NOW + 30_000 + 60_000);
  state = recordFailure(state, UPLOAD.entityId, 'x'.repeat(1000), NOW + 90_000);
  assert.ok(state.queue[0].lastError!.length <= 300);
  state = recordConflict(state, UPLOAD.entityId, 'version conflict', NOW + 120_000);
  assert.equal(state.queue.length, 0);
  assert.equal(state.conflicts.length, 1);
  // A conflicting entityId is held, not re-enqueued behind the caller's back.
  const reEnqueue = enqueueUpload(state, { ...UPLOAD, now: NOW + 130_000 });
  assert.equal(reEnqueue.duplicate, true);
});

test('paused queue hands out nothing; dueUploads is bounded and ordered', () => {
  let state: HubSyncState = emptyHubSyncState();
  for (let i = 0; i < 8; i++) {
    state = enqueueUpload(state, { ...UPLOAD, entityId: `sg-${i}`, now: NOW + i }).state;
  }
  assert.equal(dueUploads(state, NOW + 10, 5).length, 5);
  const paused: HubSyncState = { ...state, paused: true };
  assert.deepEqual(dueUploads(paused, NOW + 10), []);
});

test('pushGuideToHub: disabled sync means zero fetch calls, by design', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error('network should not be touched');
  }) as unknown as typeof fetch;
  const result = await pushGuideToHub({ enabled: false, endpoint: 'https://hub.example', token: '' }, UPLOAD, fetchImpl);
  assert.equal(result.status, 'unreachable');
  assert.equal(calls, 0);
  const noEndpoint = await pushGuideToHub({ enabled: true, endpoint: '', token: '' }, UPLOAD, fetchImpl);
  assert.equal(noEndpoint.status, 'unreachable');
  assert.equal(calls, 0);
});

test('pushGuideToHub maps status codes onto honest outcomes', async () => {
  const make = (status: number, body = '') =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;
  const url = 'https://hub.example';
  assert.equal((await pushGuideToHub({ enabled: true, endpoint: url, token: 't' }, UPLOAD, make(201))).status, 'uploaded');
  assert.equal((await pushGuideToHub({ enabled: true, endpoint: url, token: 't' }, UPLOAD, make(200))).status, 'uploaded');
  const conflict = await pushGuideToHub({ enabled: true, endpoint: url, token: 't' }, UPLOAD, make(409, 'version mismatch'));
  assert.equal(conflict.status, 'conflict');
  assert.equal((await pushGuideToHub({ enabled: true, endpoint: url, token: 't' }, UPLOAD, make(401))).status, 'unauthorized');
  assert.equal((await pushGuideToHub({ enabled: true, endpoint: url, token: 't' }, UPLOAD, make(500))).status, 'unreachable');
});

test('pushGuideToHub: a network failure is unreachable, not a crash', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const result = await pushGuideToHub({ enabled: true, endpoint: 'https://hub.example', token: '' }, UPLOAD, fetchImpl);
  assert.equal(result.status, 'unreachable');
});
