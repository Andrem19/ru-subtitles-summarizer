/**
 * Optional direct-to-Hub sync of saved study guides (ENG-204).
 *
 * The DEFAULT flow stays the JSON file export (`studyexport.ts`): the file
 * travels through the PWA, which owns the Hub session, and the extension
 * holds no credential. This module is the OPTIONAL direct adapter, off by
 * default; it is pure logic over an injected fetch and clock, so every
 * behaviour — dedup, the bounded offline queue, backoff, explicit version
 * conflicts, and "sync off means zero network calls" — is testable in Node.
 *
 * Semantics the acceptance pins down:
 *   - an entityId already queued or uploaded is never enqueued twice;
 *   - the queue is bounded: the oldest undelivered uploads are dropped (and
 *     reported) when the bound is exceeded — the local cache stays the
 *     source of truth, not the queue;
 *   - failures back off exponentially (30 s base, 1 h cap); a 409 version
 *     conflict is NOT retried — it moves to `conflicts` for a human decision;
 *   - 401/403 pauses the queue: retrying against a refused credential is
 *     noise, the owner re-enables after fixing the token.
 */

export const HUB_SYNC_MAX_QUEUE = 50;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 3_600_000;

export interface QueuedGuideUpload {
  entityId: string;
  transcriptHash: string;
  /** The exact JSON produced by buildGuideExport. */
  payload: string;
  queuedAt: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface HubSyncConflict {
  entityId: string;
  transcriptHash: string;
  reason: string;
  at: string;
}

export interface HubSyncState {
  queue: QueuedGuideUpload[];
  conflicts: HubSyncConflict[];
  uploaded: string[];
  paused: boolean;
}

export function emptyHubSyncState(): HubSyncState {
  return { queue: [], conflicts: [], uploaded: [], paused: false };
}

export function enqueueUpload(
  state: HubSyncState,
  upload: { entityId: string; transcriptHash: string; payload: string; now: number },
): { state: HubSyncState; dropped: number; duplicate: boolean } {
  if (state.uploaded.includes(upload.entityId)) {
    // Already delivered: an upload repeat must not duplicate (acceptance).
    return { state, dropped: 0, duplicate: true };
  }
  if (state.conflicts.some((c) => c.entityId === upload.entityId)) {
    return { state, dropped: 0, duplicate: true }; // held for a human decision
  }
  const rest = state.queue.filter((q) => q.entityId !== upload.entityId);
  const fresh: QueuedGuideUpload = {
    entityId: upload.entityId,
    transcriptHash: upload.transcriptHash,
    payload: upload.payload,
    queuedAt: new Date(upload.now).toISOString(),
    attempts: 0,
    nextAttemptAt: upload.now,
  };
  let queue = [...rest, fresh];
  let dropped = 0;
  while (queue.length > HUB_SYNC_MAX_QUEUE) {
    queue = queue.slice(1); // the OLDEST undelivered upload yields its slot
    dropped += 1;
  }
  return { state: { ...state, queue }, dropped, duplicate: false };
}

/** The uploads that may go out now, oldest first, in one bounded batch. */
export function dueUploads(state: HubSyncState, now: number, batch = 5): QueuedGuideUpload[] {
  if (state.paused) return [];
  return state.queue.filter((q) => q.nextAttemptAt <= now).slice(0, batch);
}

export function recordSuccess(state: HubSyncState, entityId: string, now: number): HubSyncState {
  const queue = state.queue.filter((q) => q.entityId !== entityId);
  const uploaded = state.uploaded.includes(entityId) ? state.uploaded : [...state.uploaded, entityId].slice(-200);
  return { ...state, queue, uploaded };
}

export function recordFailure(state: HubSyncState, entityId: string, error: string, now: number): HubSyncState {
  const queue = state.queue.map((q) => {
    if (q.entityId !== entityId) return q;
    const attempts = q.attempts + 1;
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
    return { ...q, attempts, nextAttemptAt: now + backoff, lastError: error.slice(0, 300) };
  });
  return { ...state, queue };
}

/** A version conflict is explicit: out of the retry queue, into review. */
export function recordConflict(state: HubSyncState, entityId: string, reason: string, now: number): HubSyncState {
  const entry: HubSyncConflict = {
    entityId,
    transcriptHash: state.queue.find((q) => q.entityId === entityId)?.transcriptHash ?? '',
    reason: reason.slice(0, 300),
    at: new Date(now).toISOString(),
  };
  return {
    ...state,
    queue: state.queue.filter((q) => q.entityId !== entityId),
    conflicts: [...state.conflicts, entry],
  };
}

export type PushResult =
  | { status: 'uploaded' }
  | { status: 'conflict'; detail: string }
  | { status: 'unauthorized' }
  | { status: 'unreachable'; detail: string };

/**
 * One upload attempt against the Hub (`POST /api/v1/learning/guides`).
 * `fetchImpl` is injected; the sync flag is checked HERE so a disabled sync
 * cannot reach the network even if a caller forgets.
 */
export async function pushGuideToHub(
  options: { enabled: boolean; endpoint: string; token: string },
  upload: { entityId: string; payload: string },
  fetchImpl: typeof fetch,
): Promise<PushResult> {
  if (!options.enabled || options.endpoint === '') return { status: 'unreachable', detail: 'sync is disabled — zero network calls by design' };
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/v1/learning/guides', options.endpoint).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.token === '' ? {} : { authorization: `Bearer ${options.token}` }),
      },
      body: upload.payload,
    });
  } catch (err) {
    return { status: 'unreachable', detail: String((err as Error).message).slice(0, 200) };
  }
  if (response.status >= 200 && response.status < 300) return { status: 'uploaded' };
  if (response.status === 409) return { status: 'conflict', detail: (await safeBody(response)).slice(0, 200) };
  if (response.status === 401 || response.status === 403) return { status: 'unauthorized' };
  return { status: 'unreachable', detail: `HTTP ${response.status}` };
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
