// Translation prompt construction + strict validation of the model's JSON response.
// The model only ever sees {id, text} items — never timestamps.

import type { Batch } from './batching';
import { chatCompletion, ProviderError, type ApiConfig, type ChatMessage } from './protocol';

export function buildMessages(batch: Batch, targetLang: string): ChatMessage[] {
  const system = [
    `You are a professional subtitle translator for university-level academic lectures (Computer Science, Data Analytics, software engineering, mathematics, research methods).`,
    `Translate English subtitles into natural ${targetLang}.`,
    `The input is a JSON array of subtitle cues, each with an "id" and "text". The cues are consecutive: use surrounding cues as context and keep terminology consistent across them.`,
    `Rules:`,
    `- Preserve technical terminology accurately. Keep product/technology names (Python, API, CPU, cache, thread, database, operating system names, library names) in their standard form instead of translating them literally.`,
    `- Produce accurate academic ${targetLang}, not literal machine translation. Complete sentences across cues are fine, but never merge the content of one cue into another.`,
    `- Return exactly one output item for every supplied id: same number of items, same ids.`,
    `- Never merge, delete, add, reorder or renumber ids.`,
    `- Keep punctuation close to the source; do not add commentary or notes.`,
    `Output JSON only: an array of objects {"id": string, "text": string}. No markdown fences, no explanations.`,
  ].join('\n');
  const user = JSON.stringify(batch.items, null, 0);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface ParseResult {
  map: Record<string, string>;
  missing: string[];
  extras: string[];
}

function stripFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/, '');
    const end = s.lastIndexOf('```');
    if (end >= 0) s = s.slice(0, end);
  }
  return s.trim();
}

/**
 * Parses the model output into {id -> text}.
 * Tolerant of prose around a JSON array and of per-line "id": "text" fallback format.
 * Validates: every expected id present exactly with a non-empty string text.
 */
export function parseTranslationResponse(raw: string, expectedIds: string[]): ParseResult {
  const expected = new Set(expectedIds);
  const map: Record<string, string> = {};
  let parsedAny = false;

  const text = stripFences(raw);
  const candidates: string[] = [];

  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(text.slice(firstObj, lastObj + 1));

  for (const cand of candidates) {
    try {
      const json = JSON.parse(cand) as unknown;
      const arr = Array.isArray(json) ? json : [json];
      for (const entry of arr) {
        if (typeof entry !== 'object' || entry === null) continue;
        const id = (entry as { id?: unknown }).id;
        const t = (entry as { text?: unknown }).text;
        if (typeof id === 'string' && typeof t === 'string' && expected.has(id) && t.trim()) {
          map[id] = t.trim();
          parsedAny = true;
        } else if (typeof id === 'string' && typeof t === 'string' && t.trim()) {
          map[id] = t.trim();
          parsedAny = true; // extra id — report as extras
        } else if (typeof id === 'number' && typeof t === 'string' && t.trim()) {
          const sid = String(id);
          map[sid] = t.trim();
          parsedAny = true;
        }
      }
      if (parsedAny) break;
    } catch {
      // try next candidate shape
    }
  }

  if (!parsedAny) {
    // last resort: lines like  "42: перевод", "u42 | перевод" or "42 = перевод"
    const lineRe = /^\s*"?([A-Za-z0-9_-]+)"?\s*[:|=]\s*(.+)$/;
    for (const line of text.split(/\r?\n/)) {
      const m = lineRe.exec(line);
      if (m && expected.has(m[1]) && m[2].trim() && !m[2].trim().startsWith('{')) {
        map[m[1]] = m[2].trim();
        parsedAny = true;
      }
    }
  }

  if (!parsedAny) {
    throw new ProviderError(
      'Модель вернула ответ не в формате JSON.',
      'badResponse',
    );
  }

  const missing = expectedIds.filter((id) => !(id in map));
  const extras = Object.keys(map).filter((id) => !expected.has(id));
  return { map, missing, extras };
}

/** One attempt: request + validate. Throws ProviderError; returns entries when complete. */
export async function translateBatch(
  fetchImpl: typeof fetch,
  cfg: ApiConfig,
  batch: Batch,
  targetLang: string,
  opts: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<Record<string, string>> {
  const messages = buildMessages(batch, targetLang);
  const chars = batch.items.reduce((a, i) => a + i.text.length, 0);
  const maxTokens = opts.maxTokens ?? Math.max(2000, Math.ceil(chars * 1.2) + 600);
  const raw = await chatCompletion(fetchImpl, cfg, messages, {
    timeoutMs: opts.timeoutMs,
    maxTokens,
  });
  const { map, missing } = parseTranslationResponse(raw, batch.items.map((i) => i.id));
  if (missing.length > 0) {
    const err = new ProviderError(
      `В ответе модели отсутствуют ${missing.length} из ${batch.items.length} id.`,
      'badResponse',
    );
    (err as ProviderError & { missing?: string[] }).missing = missing;
    throw err;
  }
  return map;
}
