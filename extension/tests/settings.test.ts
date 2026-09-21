// Settings: provider presets, the first-run key guard, and the credential-free
// view of settings that page-facing code is allowed to hold.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  PRESETS,
  hostMatches,
  keyRequired,
  loadUiSettings,
  mergeSettings,
  missingKeyMessage,
  toUiSettings,
  type PresetId,
  type Settings,
} from '../src/shared/settings';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

test('every preset is complete enough to configure the extension', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.label.trim(), `${id}: label`);
    assert.ok(preset.keyHint.trim(), `${id}: keyHint`);
    if (id !== 'custom') assert.ok(preset.endpoint, `${id}: endpoint`);
    if (preset.needsKey) assert.ok(preset.keysUrl, `${id}: needs a key, so it needs a keysUrl`);
    // 'custom' is whatever the user runs, so only the shipped keyless presets
    // must point at this machine.
    if (!preset.needsKey && id !== 'custom') {
      assert.match(preset.endpoint, /^http:\/\/(127\.0\.0\.1|localhost)/, `${id}: keyless must be local`);
    }
  }
});

test('cloud presets demand a key, local ones do not', () => {
  for (const id of ['zai', 'openai', 'openrouter', 'deepseek', 'groq'] as PresetId[]) {
    assert.equal(keyRequired(settings({ preset: id })), true, id);
  }
  for (const id of ['lmstudio', 'ollama', 'custom'] as PresetId[]) {
    assert.equal(keyRequired(settings({ preset: id })), false, id);
  }
});

test('missingKeyMessage is null exactly when nothing is missing', () => {
  assert.equal(missingKeyMessage(settings({ preset: 'zai', apiKey: 'k' })), null);
  assert.equal(missingKeyMessage(settings({ preset: 'ollama', apiKey: '' })), null);
  assert.equal(missingKeyMessage(settings({ preset: 'custom', apiKey: '' })), null);
  // whitespace is not a key
  assert.equal(missingKeyMessage(settings({ preset: 'zai', apiKey: '   ' })) !== null, true);

  const msg = missingKeyMessage(settings({ preset: 'openai', apiKey: '' }));
  assert.ok(msg && msg.includes('OpenAI'), 'names the provider');
  assert.ok(msg && msg.includes(PRESETS.openai.keysUrl!), 'tells the user where to get a key');
});

test('toUiSettings hands page code everything except the credential', async () => {
  const ui = toUiSettings(settings({ apiKey: 'secret-key', fontSize: 30 }));
  assert.equal('apiKey' in ui, false);
  assert.equal(ui.fontSize, 30);
  assert.equal(ui.preset, DEFAULT_SETTINGS.preset);
  // the secret must not survive serialisation into a page either
  assert.equal(JSON.stringify(ui).includes('secret-key'), false);
});

test('loadUiSettings reads storage and drops the key', async () => {
  const stored = settings({ apiKey: 'stored-secret' });
  const storage = { get: async () => ({ settings: stored }), set: async () => {} };
  const ui = await loadUiSettings(storage);
  assert.equal('apiKey' in ui, false);
  assert.equal(ui.model, stored.model);
});

test('mergeSettings keeps unknown presets out but preserves known ones', () => {
  assert.equal(mergeSettings({ preset: 'openrouter' }).preset, 'openrouter');
  assert.equal(mergeSettings({ preset: 'ollama' }).preset, 'ollama');
  assert.equal(mergeSettings({ preset: 'not-a-provider' }).preset, DEFAULT_SETTINGS.preset);
  assert.equal(mergeSettings({ preset: 'lmstudio' }).preset, 'lmstudio');
});

test('hostMatches still covers the universal default and specific hosts', () => {
  assert.equal(hostMatches('anything.example', ['*']), true);
  assert.equal(hostMatches('video.example.com', ['example.com']), true);
  assert.equal(hostMatches('notexample.com', ['example.com']), false);
});

test('a stored single-site host list is recognised as the pre-universal default', () => {
  // Old installs saved one portal domain; the options page cannot produce such a
  // list any more, so it must be widened to the universal default on load.
  const legacy = mergeSettings({ autoHosts: ['portal.some-university.example'] });
  assert.deepEqual(legacy.autoHosts, DEFAULT_SETTINGS.autoHosts);
  assert.deepEqual(mergeSettings({ autoHosts: ['*'] }).autoHosts, ['*']);
  // a genuine multi-host narrowing the user typed stays untouched
  assert.deepEqual(mergeSettings({ autoHosts: ['a.example', 'b.example'] }).autoHosts, ['a.example', 'b.example']);
});
