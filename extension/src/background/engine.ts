// Translation engine: unique-text queue, playback-position priority, retries with
// batch splitting, cache writes, progress broadcasting.

import { buildBatches, splitBatch, type Batch, type WeightedItem } from '../shared/batching';
import { translationKey } from '../shared/hash';
import type { JobStatus, ProgressInfo } from '../shared/types';
import { ProviderError } from '../shared/protocol';
import { translateBatch } from '../shared/translate';
import { missingKeyMessage, type Settings } from '../shared/settings';
import { runLlm } from './llmQueue';
import { cacheGetMany, cachePutMany, type CachedTranslation } from './cache';

export interface EngineDeps {
  fetchImpl: typeof fetch;
  /** send message to the owning frame; returns false if the frame is gone */
  post: (requestId: string, msg: unknown) => void;
  now: () => number;
}

interface Job {
  requestId: string;
  tabId: number;
  frameId: number;
  settings: Settings;
  /** all unique items (transcript order) */
  items: Map<string, WeightedItem>;
  /** itemId -> translated text */
  translations: Map<string, string>;
  failed: Set<string>;
  pending: Batch[];
  running: number;
  total: number;
  status: JobStatus;
  error?: string;
  lastTime: number;
  consecutiveNetworkErrors: number;
  startedAt: number;
}

const MAX_DIRECT_RETRIES = 2;
const MIN_SPLIT_SIZE = 6;
const ERROR_PAUSE_THRESHOLD = 3;

export class TranslationEngine {
  private jobs = new Map<string, Job>();
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: EngineDeps) {}

  updateSettings(settings: Settings): void {
    for (const job of this.jobs.values()) job.settings = settings;
  }

  setVideoTime(requestId: string, time: number): void {
    const job = this.jobs.get(requestId);
    if (job) job.lastTime = time;
  }

  cancel(requestId: string): void {
    this.jobs.delete(requestId);
  }

  jobStatus(requestId: string): { status: JobStatus; progress: ProgressInfo } | null {
    const job = this.jobs.get(requestId);
    if (!job) return null;
    return { status: job.status, progress: { done: job.translations.size, total: job.total } };
  }

  /**
   * Ensures translation of the given unique items for a requestId.
   * Called after cue discovery and again by the content script for retries /
   * service-worker restart recovery. Cache hits are applied immediately.
   */
  async ensureTranslation(params: {
    requestId: string;
    tabId: number;
    frameId: number;
    settings: Settings;
    items: WeightedItem[];
  }): Promise<void> {
    const { requestId, tabId, frameId, settings, items } = params;
    let job = this.jobs.get(requestId);
    if (!job) {
      job = {
        requestId,
        tabId,
        frameId,
        settings,
        items: new Map(),
        translations: new Map(),
        failed: new Set(),
        pending: [],
        running: 0,
        total: items.length,
        status: 'translating',
        lastTime: 0,
        consecutiveNetworkErrors: 0,
        startedAt: this.deps.now(),
      };
      this.jobs.set(requestId, job);
    }
    for (const item of items) {
      const existing = job.items.get(item.id);
      if (!existing) job.items.set(item.id, item);
      if (job.failed.has(item.id) && !item.text) job.failed.delete(item.id);
    }
    job.total = Math.max(job.total, job.items.size);

    // Which items still need work? (cache hit applied immediately)
    const missing = items.filter((it) => !job.translations.has(it.id));
    if (missing.length === 0) {
      this.finishIfComplete(job);
      return;
    }
    const keys = await Promise.all(missing.map((it) => translationKey(job.settings.targetLang, job.settings.model, it.text)));
    let cached: Map<string, CachedTranslation>;
    try {
      cached = await cacheGetMany(keys);
    } catch {
      cached = new Map(); // cache unavailable — treat as miss and keep translating
    }
    const stillMissing: WeightedItem[] = [];
    const fromCache: Record<string, string> = {};
    missing.forEach((it, i) => {
      const hit = cached.get(keys[i]);
      if (hit && hit.t) {
        fromCache[it.id] = hit.t;
        job.translations.set(it.id, hit.t);
        job.failed.delete(it.id);
      } else {
        stillMissing.push(it);
      }
    });

    if (Object.keys(fromCache).length > 0) {
      this.deps.post(requestId, this.translationsMsg(job, fromCache));
    }

    if (stillMissing.length > 0) {
      const queued = new Set(job.pending.flatMap((b) => b.items.map((i) => i.id)));
      const toQueue = stillMissing.filter((i) => !queued.has(i.id));
      if (toQueue.length > 0) {
        const batches = buildBatches(toQueue, { maxItems: job.settings.batchSize, maxChars: 3500 });
        job.pending.push(...batches);
      }
    }

    job.status = 'translating';
    job.error = undefined;
    job.consecutiveNetworkErrors = 0;
    if (stillMissing.length === 0) {
      // everything came from cache — finalize immediately
      this.finishIfComplete(job);
      this.deps.post(requestId, this.translationsMsg(job, {}));
      return;
    }
    // Only new work needs the provider, so a fully cached lecture plays without a key.
    const keyProblem = missingKeyMessage(job.settings);
    if (keyProblem) {
      job.status = 'error';
      job.error = keyProblem;
      this.deps.post(requestId, this.translationsMsg(job, {}));
      return;
    }
    this.schedule();
  }

  private translationsMsg(job: Job, entries: Record<string, string>) {
    return {
      type: 'rusub:translations',
      requestId: job.requestId,
      entries,
      progress: { done: job.translations.size, total: job.total } as ProgressInfo,
      status: job.status,
      error: job.error,
    };
  }

  private pickBatch(job: Job): Batch | null {
    if (job.pending.length === 0) return null;
    let bestIdx = 0;
    let bestScore = Infinity;
    job.pending.forEach((b, i) => {
      const start = b.startTime ?? 0;
      const score = Math.abs(start - job.lastTime);
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    const [batch] = job.pending.splice(bestIdx, 1);
    return batch ?? null;
  }

  private schedule(): void {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      this.pump();
    }, 0);
  }

  private pump(): void {
    for (const job of this.jobs.values()) {
      const concurrency = Math.max(1, job.settings.concurrency);
      while (job.running < concurrency) {
        // pause the job after repeated network errors (provider unreachable) —
        // wait for explicit retry from the content script
        if (job.consecutiveNetworkErrors >= ERROR_PAUSE_THRESHOLD) {
          job.status = 'error';
          if (!job.error) {
            job.error = `Сервер перевода недоступен (${job.settings.endpoint}). Проверьте подключение и настройки, затем нажмите «Повторить».`;
          }
          this.deps.post(job.requestId, this.translationsMsg(job, {}));
          break;
        }
        const batch = this.pickBatch(job);
        if (!batch) break;
        job.running++;
        void this.runBatch(job, batch).finally(() => {
          job.running--;
          const before = job.status;
          this.finishIfComplete(job);
          if (job.status !== before && (job.status === 'done' || job.status === 'partial')) {
            this.deps.post(job.requestId, this.translationsMsg(job, {}));
          }
          this.schedule();
        });
      }
    }
  }

  private async runBatch(job: Job, batch: Batch): Promise<void> {
    try {
      const map = await this.translateWithRetries(job, batch);
      job.consecutiveNetworkErrors = 0;
      const entries: Record<string, string> = {};
      const rows: CachedTranslation[] = [];
      for (const item of batch.items) {
        const t = map[item.id];
        if (!t) continue;
        job.translations.set(item.id, t);
        job.failed.delete(item.id);
        entries[item.id] = t;
        rows.push({
          k: await translationKey(job.settings.targetLang, job.settings.model, item.text),
          o: item.text,
          t,
          lang: job.settings.targetLang,
          model: job.settings.model,
          ts: this.deps.now(),
        });
      }
      try {
        await cachePutMany(rows);
      } catch {
        /* cache write failure must not break translation */
      }
      this.finishIfComplete(job);
      this.deps.post(job.requestId, this.translationsMsg(job, entries));
    } catch (e) {
      this.handleBatchError(job, batch, e);
    }
  }

  private async translateWithRetries(job: Job, batch: Batch): Promise<Record<string, string>> {
    try {
      let current = batch;
      for (let attempt = 0; attempt <= MAX_DIRECT_RETRIES; attempt++) {
        try {
          return await runLlm(() => translateBatch(this.deps.fetchImpl, {
            endpoint: job.settings.endpoint,
            apiKey: job.settings.apiKey,
            model: job.settings.model,
            temperature: job.settings.temperature,
            protocol: job.settings.protocol,
          }, current, job.settings.targetLang));
        } catch (e) {
          const err = e as ProviderError;
          const retriable = err instanceof ProviderError &&
            ['badResponse', 'rateLimit', 'server', 'timeout'].includes(err.kind);
          if (!retriable || attempt === MAX_DIRECT_RETRIES) throw err;
          // rate limit (429) needs a long backoff — provider windows are per-minute
          await sleep(err instanceof ProviderError && err.kind === 'rateLimit'
            ? 12_000 * (attempt + 1) + Math.floor(Math.random() * 2000)
            : 1500 * (attempt + 1));
        }
      }
      throw new ProviderError('Модель не смогла корректно перевести батч.', 'badResponse');
    } catch (e) {
      const fatal = e instanceof ProviderError && ['unreachable', 'auth', 'notFound'].includes(e.kind);
      if (fatal || batch.items.length <= MIN_SPLIT_SIZE) {
        for (const it of batch.items) job.failed.add(it.id);
        throw e;
      }
      // validation kept failing: split into smaller pieces and translate each
      const [a, b] = splitBatch(batch);
      const results: Record<string, string> = {};
      try {
        Object.assign(results, await this.translateWithRetries(job, a));
      } catch {
        for (const it of a.items) job.failed.add(it.id);
      }
      try {
        Object.assign(results, await this.translateWithRetries(job, b));
      } catch {
        for (const it of b.items) job.failed.add(it.id);
      }
      if (Object.keys(results).length === 0) throw e;
      return results;
    }
  }

  private handleBatchError(job: Job, batch: Batch, e: unknown): void {
    const err = e as ProviderError;
    if (err instanceof ProviderError && err.kind === 'unreachable') {
      job.consecutiveNetworkErrors++;
      job.error = err.message;
      job.pending.unshift(batch); // try again when user hits retry
      return;
    }
    if (err instanceof ProviderError && err.kind === 'auth') {
      job.status = 'error';
      job.error = err.message;
      job.pending.unshift(batch);
      this.deps.post(job.requestId, this.translationsMsg(job, {}));
      return;
    }
    // non-fatal: give up on this batch's items but continue the rest
    for (const it of batch.items) job.failed.add(it.id);
    this.finishIfComplete(job);
    this.deps.post(job.requestId, this.translationsMsg(job, {}));
  }

  private finishIfComplete(job: Job): void {
    const pendingIds = new Set(job.pending.flatMap((b) => b.items.map((i) => i.id)));
    if (job.running === 0 && pendingIds.size === 0) {
      const hasFailed = job.failed.size > 0 && job.translations.size < job.total;
      const allDone = job.translations.size >= job.total;
      job.status = allDone ? 'done' : hasFailed ? 'partial' : 'done';
      if (!allDone && hasFailed && !job.error) {
        job.error = `Не переведено ${job.total - job.translations.size} фрагментов.`;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
