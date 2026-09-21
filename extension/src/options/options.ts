// Options page logic.

import { listModels } from '../shared/protocol';
import { chatCompletion } from '../shared/protocol';
import {
  DEFAULT_SETTINGS,
  PRESETS,
  keyRequired,
  loadSettings,
  missingKeyMessage,
  saveSettings,
  type PresetId,
  type Settings,
} from '../shared/settings';
import { cacheClear, cacheCount } from '../background/cache';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  preset: $<HTMLSelectElement>('preset'),
  endpoint: $<HTMLInputElement>('endpoint'),
  apiKey: $<HTMLInputElement>('apiKey'),
  toggleKey: $<HTMLButtonElement>('toggleKey'),
  keyHint: $<HTMLElement>('keyHint'),
  keysLink: $<HTMLAnchorElement>('keysLink'),
  keysLinkNote: $<HTMLElement>('keysLinkNote'),
  notice: $<HTMLElement>('notice'),
  model: $<HTMLInputElement>('model'),
  modelList: $<HTMLDataListElement>('modelList'),
  refreshModels: $<HTMLButtonElement>('refreshModels'),
  targetLang: $<HTMLInputElement>('targetLang'),
  fontSize: $<HTMLInputElement>('fontSize'),
  fontSizeValue: $<HTMLElement>('fontSizeValue'),
  guideFontSize: $<HTMLInputElement>('guideFontSize'),
  guideFontSizeValue: $<HTMLElement>('guideFontSizeValue'),
  autoTranslate: $<HTMLInputElement>('autoTranslate'),
  batchSize: $<HTMLInputElement>('batchSize'),
  temperature: $<HTMLInputElement>('temperature'),
  concurrency: $<HTMLInputElement>('concurrency'),
  save: $<HTMLButtonElement>('save'),
  test: $<HTMLButtonElement>('test'),
  clearCache: $<HTMLButtonElement>('clearCache'),
  cacheInfo: $<HTMLElement>('cacheInfo'),
  status: $<HTMLPreElement>('status'),
};

function readForm(): Settings {
  const mode = document.querySelector<HTMLInputElement>('input[name=defaultMode]:checked')?.value;
  const display = document.querySelector<HTMLInputElement>('input[name=display]:checked')?.value;
  const preset = el.preset.value as Settings['preset'];
  return {
    preset,
    protocol: PRESETS[preset].protocol,
    endpoint: el.endpoint.value.trim(),
    apiKey: el.apiKey.value,
    model: el.model.value.trim(),
    targetLang: el.targetLang.value.trim() || DEFAULT_SETTINGS.targetLang,
    batchSize: Number(el.batchSize.value) || DEFAULT_SETTINGS.batchSize,
    temperature: Number(el.temperature.value),
    concurrency: Number(el.concurrency.value) || DEFAULT_SETTINGS.concurrency,
    autoTranslate: el.autoTranslate.checked,
    autoHosts: DEFAULT_SETTINGS.autoHosts,
    defaultMode: mode === 'bi' ? 'bi' : 'ru',
    display: display === 'overlay' ? 'overlay' : 'texttrack',
    fontSize: Number(el.fontSize.value) || DEFAULT_SETTINGS.fontSize,
    guideFontSize: Number(el.guideFontSize.value) || DEFAULT_SETTINGS.guideFontSize,
  };
}

function writeForm(s: Settings): void {
  el.preset.value = s.preset;
  el.endpoint.value = s.endpoint;
  el.apiKey.value = s.apiKey;
  el.model.value = s.model;
  el.targetLang.value = s.targetLang;
  el.autoTranslate.checked = s.autoTranslate;
  (document.querySelector<HTMLInputElement>(`input[name=defaultMode][value=${s.defaultMode}]`)!).checked = true;
  (document.querySelector<HTMLInputElement>(`input[name=display][value=${s.display}]`)!).checked = true;
  el.batchSize.value = String(s.batchSize);
  el.temperature.value = String(s.temperature);
  el.concurrency.value = String(s.concurrency);
  el.fontSize.value = String(s.fontSize);
  el.fontSizeValue.textContent = `${s.fontSize} px`;
  el.guideFontSize.value = String(s.guideFontSize);
  el.guideFontSizeValue.textContent = `${s.guideFontSize} px`;
}

function setStatus(text: string, kind: '' | 'ok' | 'err' | 'warn' = ''): void {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

/** Warns about a missing key on the page itself, not only in the status line. */
function showNotice(text: string | null): void {
  if (text) {
    el.notice.textContent = text;
    el.notice.hidden = false;
  } else {
    el.notice.textContent = '';
    el.notice.hidden = true;
  }
}

function cfgFrom(form: Settings) {
  return { endpoint: form.endpoint, apiKey: form.apiKey, protocol: form.protocol };
}

/** Preset dropdown is generated from PRESETS so the list cannot drift from the code. */
function fillPresets(): void {
  el.preset.innerHTML = '';
  for (const [id, preset] of Object.entries(PRESETS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = preset.label;
    el.preset.appendChild(opt);
  }
}

/** Key-field help + provider key page for the currently selected preset. */
function updatePresetHint(): void {
  const preset = PRESETS[el.preset.value as PresetId] ?? PRESETS.custom;
  el.keyHint.textContent = preset.keyHint;
  if (preset.keysUrl) {
    el.keysLink.href = preset.keysUrl;
    el.keysLink.textContent = `Где взять ключ (${hostOf(preset.keysUrl)}) →`;
    el.keysLink.hidden = false;
    el.keysLinkNote.textContent = 'Ключ хранится только в вашем браузере и отправляется лишь на указанный endpoint.';
  } else {
    el.keysLink.removeAttribute('href');
    el.keysLink.hidden = true;
    el.keysLinkNote.textContent = 'Ключ хранится только в вашем браузере; для локального сервера он вообще не нужен.';
  }
  el.apiKey.disabled = !preset.needsKey;
  const problem = missingKeyMessage(readForm());
  showNotice(problem);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function refreshModels(): Promise<void> {
  const form = readForm();
  if (!form.endpoint) {
    setStatus('Укажите endpoint.', 'err');
    return;
  }
  if (keyRequired(form) && !form.apiKey.trim()) {
    setStatus('Сначала вставьте API-ключ провайдера — без него список моделей недоступен.', 'warn');
    return;
  }
  setStatus('Запрашиваю список моделей…');
  const res = await listModels(fetch, cfgFrom(form));
  if (!res.ok) {
    setStatus(`Ошибка: ${res.error}`, 'err');
    return;
  }
  el.modelList.innerHTML = '';
  for (const m of res.models) {
    const opt = document.createElement('option');
    opt.value = m;
    el.modelList.appendChild(opt);
  }
  setStatus(`Подключено. Моделей: ${res.models.length}${res.models.length ? ` (${res.models.slice(0, 5).join(', ')}${res.models.length > 5 ? '…' : ''})` : ''}`, 'ok');
}

async function testConnection(): Promise<void> {
  const form = readForm();
  if (!form.endpoint || !form.model) {
    setStatus('Укажите endpoint и модель.', 'err');
    return;
  }
  if (keyRequired(form) && !form.apiKey.trim()) {
    setStatus('API-ключ не задан — вставьте ключ провайдера и нажмите «Проверить подключение» ещё раз.', 'warn');
    showNotice(missingKeyMessage(form));
    return;
  }
  setStatus('Проверяю подключение…');
  const models = await listModels(fetch, cfgFrom(form));
  let line = models.ok
    ? `Подключено. Endpoint ответил списком моделей (${models.models.length}).\n`
    : `Список моделей недоступен: ${models.error}\n(продолжаю проверку перевода…)\n`;
  try {
    const ru = await chatCompletion(
      fetch,
      { endpoint: form.endpoint, apiKey: form.apiKey, model: form.model, temperature: 0.2, protocol: form.protocol },
      [
        { role: 'system', content: 'Output JSON only: array of {"id","text"}.' },
        { role: 'user', content: '[{"id":"1","text":"Hello."}]' },
      ],
      { maxTokens: 800, timeoutMs: 60_000 },
    );
    line += `Тест перевода (модель ${form.model}): ${ru.slice(0, 200)}`;
    setStatus(line, 'ok');
  } catch (e) {
    line += `Ошибка теста перевода: ${e instanceof Error ? e.message : String(e)}`;
    setStatus(line, 'err');
  }
}

async function refreshCacheInfo(): Promise<void> {
  try {
    const n = await cacheCount();
    el.cacheInfo.textContent = `в кэше переводов: ${n}`;
  } catch {
    el.cacheInfo.textContent = '';
  }
}

function bindPreset(): void {
  el.preset.addEventListener('change', () => {
    const preset = PRESETS[el.preset.value as PresetId] ?? PRESETS.custom;
    if (preset.endpoint) el.endpoint.value = preset.endpoint;
    if (preset.model) el.model.value = preset.model;
    if (!preset.needsKey) el.apiKey.value = '';
    updatePresetHint();
  });
  // Keep the warning in step with what is actually typed, before saving.
  el.apiKey.addEventListener('input', () => showNotice(missingKeyMessage(readForm())));
  el.endpoint.addEventListener('input', () => showNotice(missingKeyMessage(readForm())));
}

async function init(): Promise<void> {
  fillPresets();
  writeForm(await loadSettings(chrome.storage.local));
  bindPreset();
  updatePresetHint();
  el.save.addEventListener('click', async () => {
    const s = readForm();
    if (!s.endpoint) {
      setStatus('Endpoint не может быть пустым.', 'err');
      return;
    }
    if (!s.model) {
      setStatus('Укажите модель.', 'err');
      return;
    }
    await saveSettings(chrome.storage.local, s);
    const problem = missingKeyMessage(s);
    showNotice(problem);
    if (problem) {
      // Saved anyway: a local server needs no key, and the user may be mid-setup.
      setStatus(`Настройки сохранены, но перевод ещё не заработает.\n${problem}`, 'warn');
    } else {
      setStatus('Настройки сохранены.', 'ok');
    }
  });
  el.test.addEventListener('click', () => void testConnection());
  el.refreshModels.addEventListener('click', () => void refreshModels());
  el.toggleKey.addEventListener('click', () => {
    el.apiKey.type = el.apiKey.type === 'password' ? 'text' : 'password';
    el.toggleKey.textContent = el.apiKey.type === 'password' ? 'Показать' : 'Скрыть';
  });
  el.fontSize.addEventListener('input', () => {
    el.fontSizeValue.textContent = `${el.fontSize.value} px`;
  });
  el.guideFontSize.addEventListener('input', () => {
    el.guideFontSizeValue.textContent = `${el.guideFontSize.value} px`;
  });
  el.clearCache.addEventListener('click', async () => {
    await cacheClear();
    await refreshCacheInfo();
    setStatus('Кэш переводов очищен.', 'ok');
  });
  await refreshCacheInfo();
}

void init();
