// Extension settings: defaults, provider presets, load/save.

import type { ApiProtocol } from './protocol';

export type DisplayEngine = 'texttrack' | 'overlay';

/** Provider preset ids; 'custom' is any OpenAI-compatible endpoint. */
export type PresetId =
  | 'zai'
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'lmstudio'
  | 'ollama'
  | 'custom';

export interface ProviderPreset {
  label: string;
  endpoint: string;
  model: string;
  /** false for servers that run on this machine and take no credentials */
  needsKey: boolean;
  protocol: ApiProtocol;
  /** provider's key page, linked from the options page */
  keysUrl?: string;
  /** what to paste into the key field and where it comes from */
  keyHint: string;
}

export interface Settings {
  /** provider preset id (UI convenience only; endpoint/model below is the source of truth) */
  preset: PresetId;
  /** wire protocol spoken at `endpoint` */
  protocol: ApiProtocol;
  /** base URL, e.g. https://api.z.ai/api/anthropic */
  endpoint: string;
  /** Bearer token; empty for local servers that don't need it */
  apiKey: string;
  model: string;
  targetLang: string;
  batchSize: number;
  temperature: number;
  /** auto-start translation when a caption playlist is found (top-level page) */
  autoTranslate: boolean;
  /** hosts to auto-translate on; '*' matches every host with a detected player */
  autoHosts: string[];
  /** default subtitle mode after attach (used when auto=true) */
  defaultMode: 'ru' | 'bi';
  display: DisplayEngine;
  /** subtitle font size in px (overlay rendering) */
  fontSize: number;
  /** study-guide panel font size in px */
  guideFontSize: number;
  /** concurrency for translation requests */
  concurrency: number;
}

export const PRESETS: Record<PresetId, ProviderPreset> = {
  zai: {
    label: 'Z.ai · GLM-5.3 Flash (Coding Plan)',
    endpoint: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.3-flash',
    needsKey: true,
    protocol: 'anthropic',
    keysUrl: 'https://z.ai/subscribe',
    keyHint: 'API-ключ Coding Plan со страницы подписки z.ai (тот же ключ работает и в ZCode).',
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    protocol: 'openai',
    keysUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Ключ вида sk-… из личного кабинета platform.openai.com → API keys.',
  },
  openrouter: {
    label: 'OpenRouter (сотни моделей по одному ключу)',
    endpoint: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    needsKey: true,
    protocol: 'openai',
    keysUrl: 'https://openrouter.ai/keys',
    keyHint: 'Ключ вида sk-or-… с openrouter.ai/keys; модель указывайте в формате vendor/model.',
  },
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    protocol: 'openai',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'Ключ вида sk-… из platform.deepseek.com → API keys.',
  },
  groq: {
    label: 'Groq (быстрый inference)',
    endpoint: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    protocol: 'openai',
    keysUrl: 'https://console.groq.com/keys',
    keyHint: 'Ключ вида gsk_… с console.groq.com/keys.',
  },
  lmstudio: {
    label: 'LM Studio (на этом компьютере, без ключа)',
    endpoint: 'http://127.0.0.1:1234/v1',
    model: '',
    needsKey: false,
    protocol: 'openai',
    keyHint: 'Ключ не нужен: запустите LM Studio, включите локальный сервер и выберите модель кнопкой «Список моделей».',
  },
  ollama: {
    label: 'Ollama (на этом компьютере, без ключа)',
    endpoint: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
    needsKey: false,
    protocol: 'openai',
    keyHint: 'Ключ не нужен: запустите `ollama serve` и заранее скачайте модель (`ollama pull llama3.1`).',
  },
  custom: {
    label: 'Другой OpenAI-совместимый endpoint',
    endpoint: '',
    model: '',
    needsKey: false,
    protocol: 'openai',
    keyHint: 'Вставьте ключ, если ваш сервер его требует; для локального сервера оставьте поле пустым.',
  },
};

export const DEFAULT_SETTINGS: Settings = {
  preset: 'zai',
  protocol: 'anthropic',
  endpoint: PRESETS.zai.endpoint,
  apiKey: '',
  model: PRESETS.zai.model,
  targetLang: 'Russian',
  batchSize: 40,
  temperature: 0.2,
  autoTranslate: true,
  // Works by default on every host where a player is detected, so the extension
  // is not tied to one platform; narrow the list to specific domains if
  // auto-translation is unwanted on some sites.
  autoHosts: ['*'],
  defaultMode: 'ru',
  // NB: Kaltura's mwEmbed player does not render synthetic TextTracks, so the
  // in-player overlay is the default on real lectures; TextTrack still works
  // on plain HTML5 players and remains selectable in the options page.
  display: 'overlay',
  fontSize: 24,
  guideFontSize: 16,
  concurrency: 2,
};

const SETTINGS_KEY = 'settings';

/**
 * Host list of builds that predate the universal default. Those versions shipped
 * a single university portal as the default and had no UI to edit it, so a stored
 * one-entry list is that old default rather than a deliberate choice — the options
 * page always writes the universal list and cannot produce a single-site one.
 */
function isLegacySingleSiteList(hosts: string[]): boolean {
  return hosts.length === 1 && hosts[0] !== '*';
}

/** True when `host` is covered by the auto-translate host patterns ('*' = any). */
export function hostMatches(host: string, patterns: string[]): boolean {
  if (!host) return false;
  return patterns.some((p) => p === '*' || host === p || host.endsWith(`.${p}`));
}

/** True when the selected provider cannot work without a key (local servers can). */
export function keyRequired(s: Pick<Settings, 'preset'>): boolean {
  return PRESETS[s.preset]?.needsKey === true;
}

/**
 * Actionable message for the one setup mistake every new user can make — an
 * empty key on a provider that needs one. Returns null when nothing is missing,
 * so callers can use it as a guard: `const why = missingKeyMessage(s); if (why) …`.
 */
export function missingKeyMessage(s: Pick<Settings, 'preset' | 'apiKey'>): string | null {
  if (!keyRequired(s) || s.apiKey.trim()) return null;
  const p = PRESETS[s.preset];
  return `API-ключ не задан для «${p.label}». Откройте настройки расширения (правый клик по чипу RU → «Настройки») и вставьте ключ${p.keysUrl ? `; получить его можно здесь: ${p.keysUrl}` : ''}.`;
}

/**
 * Settings as the page-facing UI needs them. The API key is deliberately not a
 * part of this type: content scripts run in every frame of every page and have
 * no use for the credential, so only the service worker ever holds it.
 */
export type UiSettings = Omit<Settings, 'apiKey'>;

export function toUiSettings(s: Settings): UiSettings {
  const copy: Record<string, unknown> = { ...s };
  delete copy.apiKey;
  return copy as unknown as UiSettings;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function mergeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (typeof r.endpoint === 'string' && r.endpoint.trim()) s.endpoint = r.endpoint.trim().replace(/\/+$/, '');
  if (r.protocol === 'anthropic' || r.protocol === 'openai') s.protocol = r.protocol;
  // Migration: the paas/v4 resource package is separate from (and exhausted unlike)
  // the Coding Plan quota — move the Z.ai preset to the Coding Plan endpoint.
  if (s.preset === 'zai' && /api\.z\.ai\/api\/paas\/v\d+$/.test(s.endpoint)) {
    s.endpoint = PRESETS.zai.endpoint;
    s.protocol = 'anthropic';
  }
  if (s.preset === 'zai' && s.endpoint === PRESETS.zai.endpoint) s.protocol = 'anthropic';
  if (typeof r.apiKey === 'string') s.apiKey = r.apiKey;
  if (typeof r.model === 'string' && r.model.trim()) s.model = r.model.trim();
  if (typeof r.targetLang === 'string' && r.targetLang.trim()) s.targetLang = r.targetLang.trim();
  if (typeof r.preset === 'string' && r.preset in PRESETS) s.preset = r.preset as Settings['preset'];
  s.batchSize = clampInt(r.batchSize, 5, 200, DEFAULT_SETTINGS.batchSize);
  s.concurrency = clampInt(r.concurrency, 1, 6, DEFAULT_SETTINGS.concurrency);
  if (typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2) s.temperature = r.temperature;
  if (typeof r.autoTranslate === 'boolean') s.autoTranslate = r.autoTranslate;
  if (Array.isArray(r.autoHosts)) {
    const hosts = r.autoHosts.filter((h): h is string => typeof h === 'string' && !!h.trim());
    s.autoHosts = hosts.length === 0 || isLegacySingleSiteList(hosts) ? DEFAULT_SETTINGS.autoHosts : hosts;
  }
  if (r.defaultMode === 'ru' || r.defaultMode === 'bi') s.defaultMode = r.defaultMode;
  if (r.display === 'texttrack' || r.display === 'overlay') s.display = r.display;
  s.fontSize = clampInt(r.fontSize, 12, 40, DEFAULT_SETTINGS.fontSize);
  s.guideFontSize = clampInt(r.guideFontSize, 11, 28, DEFAULT_SETTINGS.guideFontSize);
  return s;
}

type StorageLike = {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export async function loadSettings(storage: StorageLike): Promise<Settings> {
  const res = await storage.get(SETTINGS_KEY);
  return mergeSettings(res[SETTINGS_KEY]);
}

/** `loadSettings` without the credential — the form content scripts should use. */
export async function loadUiSettings(storage: StorageLike): Promise<UiSettings> {
  return toUiSettings(await loadSettings(storage));
}

export async function saveSettings(storage: StorageLike, settings: Settings): Promise<void> {
  await storage.set({ [SETTINGS_KEY]: settings });
}
