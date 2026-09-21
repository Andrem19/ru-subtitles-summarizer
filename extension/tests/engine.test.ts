// Engine behaviour tests with a scripted fetch: success flow, retry on bad JSON,
// batch splitting, provider-outage pause and manual recovery.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TranslationEngine } from '../src/background/engine';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  endpoint: 'https://fake.example/v4',
  apiKey: 'k',
  model: 'test-model',
  batchSize: 10,
  concurrency: 1,
  protocol: 'openai',
};

interface Posted {
  requestId: string;
  msg: Record<string, unknown>;
}

function makeEngine(script: Array<(reqBody: string) => string | 'FAIL'>, requests: string[]) {
  let call = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    requests.push(body);
    const step = script[Math.min(call, script.length - 1)];
    call++;
    const out = step(body);
    if (out === 'FAIL') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 });
  }) as typeof fetch;
  const posted: Posted[] = [];
  const engine = new TranslationEngine({
    fetchImpl,
    post: (requestId, msg) => posted.push({ requestId, msg: msg as Record<string, unknown> }),
    now: () => Date.now(),
  });
  return { engine, posted, fetchImpl };
}

const items = Array.from({ length: 3 }, (_, i) => ({
  id: `u${i}`,
  text: `text number ${i}`,
  start: i * 5,
}));

function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function lastPosted(posted: Posted[]): Record<string, unknown> | undefined {
  return posted.at(-1)?.msg;
}

test('engine translates items and posts progress + done', async () => {
  const requests: string[] = [];
  const { engine, posted } = makeEngine(
    [() => '[{"id":"u0","text":"т0"},{"id":"u1","text":"т1"},{"id":"u2","text":"т2"}]'],
    requests,
  );
  await engine.ensureTranslation({ requestId: 'r1', tabId: 1, frameId: 2, settings, items });
  await waitUntil(() => (lastPosted(posted) as { status?: string } | undefined)?.status === 'done');
  const entriesMsgs = posted.filter((p) => Object.keys((p.msg as { entries: object }).entries).length > 0);
  assert.equal(entriesMsgs.length, 1);
  const done = posted.at(-1)!.msg;
  assert.equal(done.status, 'done');
  assert.equal((done.progress as { done: number }).done, 3);
  // request body must contain ids/text but never start times
  const bodyJson = JSON.parse(requests[0]) as { messages: Array<{ content: string }> };
  const contents = bodyJson.messages.map((m) => m.content).join('\n');
  assert.ok(contents.includes('u0'));
  assert.ok(!contents.includes('"start"'));
  assert.ok(!contents.includes('startTime'));
});

test('engine retries malformed JSON then succeeds', async () => {
  let n = 0;
  const { engine, posted } = makeEngine(
    [
      () => {
        n++;
        return n === 1 ? 'Sorry, I cannot comply.' : '[{"id":"u0","text":"а"},{"id":"u1","text":"б"},{"id":"u2","text":"в"}]';
      },
    ],
    [],
  );
  await engine.ensureTranslation({ requestId: 'r2', tabId: 1, frameId: 2, settings, items });
  await waitUntil(() => (lastPosted(posted) as { status?: string } | undefined)?.status === 'done');
  assert.equal(n, 2);
});

test('engine splits a batch that keeps failing and salvages translatable parts', async () => {
  const { engine, posted } = makeEngine(
    [
      (body) => {
        // batch of 8 fails as a whole (drops u7); any smaller sub-batch succeeds fully.
        // NB: the request body carries JSON-escaped quotes, so match bare `uN` tokens.
        const ids = new Set(body.match(/u\d/g) ?? []);
        if (ids.size === 8) {
          return '[{"id":"u0","text":"а"},{"id":"u1","text":"б"},{"id":"u2","text":"в"},{"id":"u3","text":"г"},{"id":"u4","text":"д"},{"id":"u5","text":"е"},{"id":"u6","text":"ж"}]';
        }
        const map: Record<string, string> = {};
        for (const token of ids) map[token] = 'x-' + token;
        return JSON.stringify(Object.entries(map).map(([id, text]) => ({ id, text })));
      },
    ],
    [],
  );
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, text: `t${i}`, start: i }));
  await engine.ensureTranslation({ requestId: 'r3', tabId: 1, frameId: 2, settings: { ...settings, batchSize: 8 }, items: eight });
  await waitUntil(() => ['partial', 'done'].includes((lastPosted(posted) as { status?: string } | undefined)?.status ?? ''), 25000);
  // whole-batch failures trigger splitting; sub-batches translate everything
  const done = lastPosted(posted) as unknown as { status: string; progress: { done: number } };
  assert.equal(done.status, 'done');
  assert.equal(done.progress.done, 8);
});

test('provider outage pauses job; manual retry after recovery completes it', async () => {
  let fail = true;
  const requests: string[] = [];
  const { engine, posted } = makeEngine(
    [
      () => (fail ? 'FAIL' : '[{"id":"u0","text":"а"},{"id":"u1","text":"б"},{"id":"u2","text":"в"}]'),
    ],
    requests,
  );
  await engine.ensureTranslation({ requestId: 'r4', tabId: 1, frameId: 2, settings, items });
  // three consecutive failures -> job paused with error status
  await waitUntil(() => (lastPosted(posted) as { status?: string } | undefined)?.status === 'error', 8000);
  assert.equal(requests.length, 3);
  assert.ok(String((lastPosted(posted) as { error?: string }).error).length > 0);

  // recovery: provider works again, content script re-requests missing items
  fail = false;
  await engine.ensureTranslation({
    requestId: 'r4',
    tabId: 1,
    frameId: 2,
    settings,
    items,
  });
  await waitUntil(() => (lastPosted(posted) as { status?: string } | undefined)?.status === 'done', 8000);
  const done = lastPosted(posted) as unknown as { progress: { done: number } };
  assert.equal(done.progress.done, 3);
});
