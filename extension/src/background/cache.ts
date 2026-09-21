// Translation + study-guide cache: IndexedDB in the service worker, keyed per
// (lang, model, text). Signed playlist URLs are never used as keys, so cache
// survives URL rotation.

import { diag } from '../shared/diag';

const DB_NAME = 'ru-subtitles';
/** Older builds used a university-specific database name; its rows are copied over once. */
const LEGACY_DB_NAME = 'aru-subtitles';
const DB_VERSION = 2;
const STORE = 'translations';
const GUIDE_STORE = 'guides';

export interface CachedTranslation {
  /** sha256(lang|model|text) */
  k: string;
  /** original text */
  o: string;
  /** translated text */
  t: string;
  lang: string;
  model: string;
  ts: number;
}

export interface CachedGuide {
  /** sha256(guide|lang|model|fullTranscript) */
  k: string;
  markdown: string;
  lang: string;
  model: string;
  ts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable in this context'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains(GUIDE_STORE)) {
        db.createObjectStore(GUIDE_STORE, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/**
 * One-time copy of rows written by builds that used the legacy database name,
 * so previously translated lectures and generated study guides stay available
 * after the rename. Safe to run on every start: it only copies when the new
 * database is still empty and the legacy one exists.
 */
async function migrateLegacyDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === LEGACY_DB_NAME)) return;
    }
    const already = await rawWithStore<number>(STORE, 'readonly', (s) => s.count());
    const alreadyGuides = await rawWithStore<number>(GUIDE_STORE, 'readonly', (s) => s.count());
    if (already > 0 || alreadyGuides > 0) {
      diag('diagBG', `cache: legacy migration skipped (new db already holds ${already} translations, ${alreadyGuides} guides)`);
      return;
    }
    const legacy = await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open(LEGACY_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (!legacy) return;
    const readAll = <T>(name: string): Promise<T[]> =>
      legacy.objectStoreNames.contains(name)
        ? new Promise<T[]>((resolve) => {
            const tx = legacy.transaction(name, 'readonly');
            const req = tx.objectStore(name).getAll();
            req.onsuccess = () => resolve((req.result ?? []) as T[]);
            req.onerror = () => resolve([]);
          })
        : Promise.resolve([]);
    const translations = await readAll<CachedTranslation>(STORE);
    const guides = await readAll<CachedGuide>(GUIDE_STORE);
    legacy.close();
    // NB: rawWithStore, not the public helpers — those await initCache(), which is
    // this very promise, and awaiting it here would deadlock every cache access.
    if (translations.length) {
      await rawWithStore(STORE, 'readwrite', (store) => {
        for (const row of translations) store.put(row);
      });
    }
    if (guides.length) {
      await rawWithStore(GUIDE_STORE, 'readwrite', (store) => {
        for (const row of guides) store.put(row);
      });
    }
    diag('diagBG', `cache: migrated ${translations.length} translations and ${guides.length} guides from the legacy db`);
    console.info(`[rusub] migrated ${translations.length} translations and ${guides.length} guides from the legacy cache`);
  } catch (e) {
    console.warn('[rusub] legacy cache migration skipped:', e);
  }
}

/** Runs the legacy-cache copy once per session before any cache access. */
let migration: Promise<void> | null = null;
export function initCache(): Promise<void> {
  if (!migration) {
    // Never let a migration failure poison every later cache access.
    migration = migrateLegacyDb().catch((e) => {
      console.warn('[rusub] legacy cache migration failed:', e);
    });
  }
  return migration;
}

/**
 * Public cache access: waits for the one-time legacy migration so callers never
 * see an empty cache while old rows are still being copied.
 */
async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  await initCache();
  return rawWithStore(storeName, mode, fn);
}

async function rawWithStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const request = fn(store);
      tx.oncomplete = () => {
        if (request && 'result' in request) resolve(request.result as T);
        else resolve(undefined as T);
      };
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function cacheGetMany(keys: string[]): Promise<Map<string, CachedTranslation>> {
  if (keys.length === 0) return new Map();
  const rows = await withStore<CachedTranslation[]>(STORE, 'readonly', (store) => store.getAll());
  const wanted = new Set(keys);
  const out = new Map<string, CachedTranslation>();
  for (const row of rows ?? []) {
    if (wanted.has(row.k)) out.set(row.k, row);
  }
  return out;
}

export async function cachePutMany(rows: CachedTranslation[]): Promise<void> {
  if (rows.length === 0) return;
  await withStore(STORE, 'readwrite', (store) => {
    for (const row of rows) store.put(row);
  });
}

export async function cacheCount(): Promise<number> {
  return withStore<number>(STORE, 'readonly', (store) => store.count());
}

export async function cacheClear(): Promise<void> {
  await withStore(STORE, 'readwrite', (store) => {
    store.clear();
  });
}

// --- study guides ---

export async function guideGet(key: string): Promise<CachedGuide | null> {
  const row = await withStore<CachedGuide | undefined>(GUIDE_STORE, 'readonly', (store) => store.get(key));
  return row ?? null;
}

export async function guidePut(row: CachedGuide): Promise<void> {
  await withStore(GUIDE_STORE, 'readwrite', (store) => {
    store.put(row);
  });
}

export async function guideDelete(key: string): Promise<void> {
  await withStore(GUIDE_STORE, 'readwrite', (store) => {
    store.delete(key);
  });
}

export async function guideCount(): Promise<number> {
  return withStore<number>(GUIDE_STORE, 'readonly', (store) => store.count());
}
