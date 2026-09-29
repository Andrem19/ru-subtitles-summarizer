/**
 * Storage glue for the optional direct-to-Hub sync (ENG-204).
 *
 * All the semantics live in `shared/hubSync.ts` (pure, Node-tested); this
 * module only persists the state in chrome.storage.local and drives the
 * drain on message/alarm. Everything here is a no-op unless the owner turned
 * sync on AND configured an endpoint — sync off means zero network calls.
 */
import {
  dueUploads,
  emptyHubSyncState,
  enqueueUpload,
  nextRetryDelayMs,
  pushGuideToHub,
  recordConflict,
  recordFailure,
  recordSuccess,
  resume,
  type HubSyncState,
} from '../shared/hubSync';
import { type UiSettings } from '../shared/settings';

const SYNC_STATE_KEY = 'hubSyncState';
export const RETRY_ALARM = 'hub-sync-retry';

type SyncStorageArea = { get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void> };

function storageArea(): SyncStorageArea {
  return chrome.storage.local as unknown as SyncStorageArea;
}

export async function loadSyncState(): Promise<HubSyncState> {
  const res = await storageArea().get(SYNC_STATE_KEY);
  const raw = res[SYNC_STATE_KEY];
  if (typeof raw !== 'object' || raw === null) return emptyHubSyncState();
  const parsed = raw as Partial<HubSyncState>;
  return {
    queue: Array.isArray(parsed.queue) ? parsed.queue : [],
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
    uploaded: Array.isArray(parsed.uploaded) ? parsed.uploaded : [],
    paused: parsed.paused === true,
  };
}

export async function saveSyncState(state: HubSyncState): Promise<void> {
  await storageArea().set({ [SYNC_STATE_KEY]: state });
}

/** Called after a successful export. Sync disabled → not queued, no fetch. */
export async function enqueueGuideUpload(settings: UiSettings, upload: { entityId: string; transcriptHash: string; payload: string }, now = Date.now()): Promise<void> {
  if (!settings.hubSyncEnabled || settings.hubSyncEndpoint === '') return;
  const loaded = await loadSyncState();
  // A newly configured/enabled sync clears the unauthorized pause: the owner
  // just (re)entered credentials, so waiting on the latch would be wrong.
  const state = settings.hubSyncEndpoint !== '' ? resume(loaded) : loaded;
  const result = enqueueUpload(state, { ...upload, now });
  await saveSyncResult(result.state);
  await armRetryAlarm(result.state, Date.now());
}

function saveSyncResult(state: HubSyncState): Promise<void> {
  return saveSyncState(state);
}

/** Re-arm the retry alarm from the pure scheduler; no queue → no alarm. */
async function armRetryAlarm(state: HubSyncState, now: number): Promise<void> {
  const delayMs = nextRetryDelayMs(state, now);
  if (delayMs === null) return;
  // Chrome clamps alarms to whole half-minute steps on most platforms.
  void chrome.alarms.create(RETRY_ALARM, { delayInMinutes: Math.max(0.5, delayMs / 60_000) });
}

/**
 * Push everything that is due. Returns what happened, for diagnostics only —
 * failures stay queued with backoff; nothing here throws at the caller.
 */
export async function drainSyncQueue(settings: UiSettings, fetchImpl: typeof fetch, now = Date.now()): Promise<{ uploaded: number; failed: number; conflicts: number; paused: boolean }> {
  if (!settings.hubSyncEnabled || settings.hubSyncEndpoint === '') return { uploaded: 0, failed: 0, conflicts: 0, paused: false };
  const state = await loadSyncState();
  let current = state;
  let uploaded = 0;
  let failed = 0;
  let conflicts = 0;
  for (const upload of dueUploads(current, now)) {
    const result = await pushGuideToHub(
      { enabled: true, endpoint: settings.hubSyncEndpoint, token: settings.hubSyncToken },
      upload,
      fetchImpl,
    );
    if (result.status === 'uploaded') {
      current = recordSuccess(current, upload.entityId, now);
      uploaded += 1;
    } else if (result.status === 'conflict') {
      current = recordConflict(current, upload.entityId, result.detail, now);
      conflicts += 1;
    } else if (result.status === 'unauthorized') {
      current = recordFailure(current, upload.entityId, 'unauthorized: the Hub refused the credential', now);
      current = { ...current, paused: true }; // wait for the owner, not for the backoff
      failed += 1;
      break;
    } else {
      current = recordFailure(current, upload.entityId, result.detail, now);
      failed += 1;
    }
  }
  await saveSyncState(current);
  return { uploaded, failed, conflicts, paused: current.paused };
}

/** Alarm/message entry point: one drain attempt, then schedule the next one. */
export async function syncTick(settings: UiSettings, fetchImpl: typeof fetch): Promise<void> {
  await drainSyncQueue(settings, fetchImpl);
  // Re-arm from the POST-drain state: undelivered uploads keep the chain
  // alive even when THIS tick sent nothing and failed at nothing.
  const state = await loadSyncState();
  await armRetryAlarm(state, Date.now());
}
