// Study guide generation: full transcript → (chunked) LLM calls → cached Markdown.
// Stateless: the content script sends the transcript with each request, so
// generation works across service-worker restarts.

import { sha256HexFor } from '../shared/hash';
import { ProviderError } from '../shared/protocol';
import { missingKeyMessage, type Settings } from '../shared/settings';
import {
  buildGuideMessages,
  buildNotesMessages,
  chunkTranscript,
  parseGuideResponse,
  transcriptToLines,
  type TranscriptLine,
} from '../shared/studyguide';
import { chatCompletion } from '../shared/protocol';
import { runLlm } from './llmQueue';
import { guideDelete, guideGet, guidePut } from './cache';

export interface GuideRequestParams {
  requestId: string;
  cues: TranscriptLine[];
  /** stable Kaltura entry id (preferred cache key) */
  entryId?: string | null;
  force?: boolean;
  settings: Settings;
  post: (msg: unknown) => void;
}

const GENERATING = 'generating' as const;
const READY = 'ready' as const;
const ERROR = 'error' as const;

const busy = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithRetry(
  settings: Settings,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  maxTokens: number,
  attempts = 4,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // goes through the same global gate as translation batches — no bursts
      return await runLlm(() => chatCompletion(
        (...args) => fetch(...args),
        {
          endpoint: settings.endpoint,
          apiKey: settings.apiKey,
          model: settings.model,
          temperature: 0.3,
          protocol: settings.protocol,
        },
        messages,
        { maxTokens, timeoutMs: 300_000 },
      ));
    } catch (e) {
      lastErr = e;
      const err = e as ProviderError;
      const retriable = err instanceof ProviderError && err.kind !== 'auth' && err.kind !== 'notFound';
      if (!retriable || attempt === attempts - 1) break;
      const rateLimit = err instanceof ProviderError && err.kind === 'rateLimit';
      await sleep(rateLimit
        ? 15_000 * (attempt + 1) + Math.floor(Math.random() * 3000)
        : 2000 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError('Не удалось получить ответ модели.', 'badResponse');
}

/** Builds the final Markdown guide (map-reduce when the transcript is long). */
async function buildGuide(cues: TranscriptLine[], settings: Settings): Promise<string> {
  const chunks = chunkTranscript(cues);
  if (chunks.length <= 1) {
    const raw = await callWithRetry(settings, buildGuideMessages(transcriptToLines(cues)), 8000);
    const parsed = parseGuideResponse(raw);
    if (!parsed.ok) throw new ProviderError('Модель вернула конспект не в ожидаемом формате; повторите попытку.', 'badResponse');
    return parsed.markdown;
  }
  // map: detailed notes per chunk
  const notes: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const raw = await callWithRetry(settings, buildNotesMessages(chunks[i]), 3000);
    notes.push(`### Часть ${i + 1}\n\n${raw.trim()}`);
  }
  // reduce: merge notes into the final guide
  const raw = await callWithRetry(settings, buildGuideMessages(notes.join('\n\n'), true), 8000);
  const parsed = parseGuideResponse(raw);
  if (!parsed.ok) throw new ProviderError('Модель вернула конспект не в ожидаемом формате; повторите попытку.', 'badResponse');
  return parsed.markdown;
}

/**
 * Handles a study-guide request. Safe to call repeatedly: concurrent requests
 * for the same video are deduplicated; results are cached in IndexedDB.
 */
export async function handleGuideRequest(params: GuideRequestParams): Promise<void> {
  const { requestId, cues, settings, post } = params;
  const force = params.force === true;
  const entryId = params.entryId ?? null;

  const reply = (status: typeof GENERATING | typeof READY | typeof ERROR, markdown?: string, error?: string) =>
    post({ type: 'rusub:guide', requestId, status, markdown, error });

  if (cues.length === 0) {
    reply(ERROR, undefined, 'Нет транскрипта для этого видео.');
    return;
  }
  if (busy.has(requestId) && !force) {
    reply(GENERATING);
    return;
  }

  // Timestamped transcript, used for the legacy/hash fallback key.
  const fullText = cues
    .map((c) => `[${Math.floor(c.start / 60)}:${String(Math.floor(c.start % 60)).padStart(2, '0')}] ${c.text.trim()}`)
    .join('\n');
  const hashKey = await sha256HexFor(`guide|${settings.targetLang}|${settings.model}|${fullText}`);
  // Primary key: stable Kaltura entry id — immune to transcript/segment
  // variations between page loads (partial segment fetches change the hash).
  const primaryKey = entryId
    ? await sha256HexFor(`guide|${settings.targetLang}|${settings.model}|${entryId}`)
    : hashKey;

  const readCache = async (key: string): Promise<string | null> => {
    try {
      const hit = await guideGet(key);
      return hit?.markdown ?? null;
    } catch (e) {
      console.warn('[rusub] guide cache read failed:', e);
      return null;
    }
  };

  if (!force) {
    const cached = (await readCache(primaryKey)) ?? (await readCache(hashKey));
    if (cached) {
      if (primaryKey !== hashKey) {
        // consolidate: also store under the primary key for future loads
        guidePut({ k: primaryKey, markdown: cached, lang: settings.targetLang, model: settings.model, ts: Date.now() })
          .catch((e) => console.warn('[rusub] guide cache write-back failed:', e));
      }
      reply(READY, cached);
      return;
    }
  }

  // Nothing cached: this path needs the provider, and an empty key is by far the
  // most likely reason a first-time user sees nothing happen.
  const keyProblem = missingKeyMessage(settings);
  if (keyProblem) {
    reply(ERROR, undefined, keyProblem);
    return;
  }

  busy.add(requestId);
  reply(GENERATING);
  // Keep the MV3 service worker alive while the (long) generation runs.
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo(() => {});
  }, 20_000);
  try {
    if (force) {
      try {
        await guideDelete(primaryKey);
        if (primaryKey !== hashKey) await guideDelete(hashKey);
      } catch (e) {
        console.warn('[rusub] guide cache delete failed:', e);
      }
    }
    const markdown = await buildGuide(cues, settings);
    try {
      await guidePut({ k: primaryKey, markdown, lang: settings.targetLang, model: settings.model, ts: Date.now() });
    } catch (e) {
      console.warn('[rusub] guide cache write failed:', e);
    }
    reply(READY, markdown);
  } catch (e) {
    let message: string;
    if (e instanceof ProviderError && e.kind === 'rateLimit') {
      message = 'Лимит запросов провайдера. Подождите около минуты и нажмите «↻ Заново» — конспект продолжит готовиться.';
    } else if (e instanceof ProviderError) {
      message = e.message;
    } else {
      message = 'Не удалось подготовить конспект. Проверьте подключение к серверу перевода и попробуйте ещё раз.';
    }
    reply(ERROR, undefined, message);
  } finally {
    clearInterval(keepAlive);
    busy.delete(requestId);
  }
}
