import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMessages, parseTranslationResponse, translateBatch } from '../src/shared/translate';
import { ProviderError } from '../src/shared/protocol';
import type { Batch } from '../src/shared/batching';

const batch: Batch = {
  index: 0,
  items: [
    { id: 'u0', text: 'a control scheme for machines or equipment,' },
    { id: 'u1', text: 'not fixed in hardware.' },
  ],
  startTime: 42,
};

test('prompt contains only ids and text — never timestamps', () => {
  const msgs = buildMessages(batch, 'Russian');
  const all = JSON.stringify(msgs);
  assert.ok(!all.includes('startTime'));
  assert.ok(!all.includes('"start"'));
  assert.ok(all.includes('u0'));
  assert.ok(all.includes('Russian'));
  assert.ok(all.includes('Never merge, delete, add, reorder or renumber ids.'));
});

test('parses clean JSON array', () => {
  const res = parseTranslationResponse(
    '[{"id":"u0","text":"схема управления"},{"id":"u1","text":"не в железе."}]',
    ['u0', 'u1'],
  );
  assert.deepEqual(res.missing, []);
  assert.equal(res.map['u1'], 'не в железе.');
});

test('parses JSON inside markdown fences and prose', () => {
  const raw = 'Here you go:\n```json\n[{"id":"u0","text":"а"},{"id":"u1","text":"б"}]\n```\nDone.';
  const res = parseTranslationResponse(raw, ['u0', 'u1']);
  assert.deepEqual(res.missing, []);
  assert.equal(res.map['u0'], 'а');
});

test('accepts numeric ids', () => {
  const res = parseTranslationResponse('[{"id":0,"text":"а"}]', ['0']);
  assert.equal(res.map['0'], 'а');
});

test('reports missing ids when model drops one', () => {
  const res = parseTranslationResponse('[{"id":"u0","text":"а"}]', ['u0', 'u1']);
  assert.deepEqual(res.missing, ['u1']);
});

test('throws ProviderError on non-JSON garbage', () => {
  assert.throws(
    () => parseTranslationResponse('I cannot translate this, sorry!', ['u0']),
    ProviderError,
  );
});

test('last-resort line format id: text', () => {
  const res = parseTranslationResponse('u0: а\nu1: б', ['u0', 'u1']);
  assert.deepEqual(res.missing, []);
});

test('translateBatch rejects when response has missing ids', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '[{"id":"u0","text":"а"}]' } }] }), {
      status: 200,
    })) as typeof fetch;
  await assert.rejects(
    translateBatch(fetchImpl, { endpoint: 'https://x/v4', apiKey: 'k', model: 'm', temperature: 0.2 }, batch, 'Russian'),
    (e: unknown) => e instanceof ProviderError && (e as ProviderError).kind === 'badResponse',
  );
});

test('translateBatch returns complete map on valid response', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: '[{"id":"u0","text":"а"},{"id":"u1","text":"б"}]' } }] }),
      { status: 200 },
    )) as typeof fetch;
  const map = await translateBatch(
    fetchImpl,
    { endpoint: 'https://x/v4', apiKey: 'k', model: 'm', temperature: 0.2 },
    batch,
    'Russian',
  );
  assert.deepEqual(map, { u0: 'а', u1: 'б' });
});

test('anthropic protocol: posts to /v1/messages with x-api-key and parses content blocks', async () => {
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = '';
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    capturedBody = String(init?.body ?? '');
    return new Response(
      JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: '[{"id":"u0","text":"а"},{"id":"u1","text":"б"}]' },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const map = await translateBatch(
    fetchImpl,
    { endpoint: 'https://api.z.ai/api/anthropic', apiKey: 'plan-key', model: 'glm-5.3-flash', temperature: 0.2, protocol: 'anthropic' },
    batch,
    'Russian',
  );
  assert.deepEqual(map, { u0: 'а', u1: 'б' });
  assert.ok(capturedUrl.endsWith('/v1/messages'), capturedUrl);
  assert.equal(capturedHeaders['x-api-key'], 'plan-key');
  const body = JSON.parse(capturedBody) as { thinking?: unknown; system?: string; messages: unknown[] };
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.ok((body.system ?? '').includes('Russian'));
  assert.equal(body.messages.length, 1);
});
