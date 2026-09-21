import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractKalturaEntryId, normalizeUrlForDedup, sourceIdentity, translationKey } from '../src/shared/hash';

test('extractKalturaEntryId from playlist URL paths and params', () => {
  assert.equal(
    extractKalturaEntryId('https://cfvod.kaltura.com/p/4091/sp/409100/hls/entryId/0_9ab6xxqu/,1.vtt.m3u8'),
    '0_9ab6xxqu',
  );
  assert.equal(
    extractKalturaEntryId('https://cdn.example/p/1/serveFlavor/entryId/0_zz99/seg/1.vtt'),
    '0_zz99',
  );
  assert.equal(extractKalturaEntryId('https://cdn.example/api?entry_id=0_abcd1234&x=1'), '0_abcd1234');
  assert.equal(extractKalturaEntryId('https://cdn.example/entry_0_abcd12gh.vtt'), '0_abcd12gh');
  assert.equal(extractKalturaEntryId('https://cdn.example/nothing-here.m3u8'), null);
});

test('normalizeUrlForDedup drops signed query but keeps path', () => {
  assert.equal(
    normalizeUrlForDedup('https://cdn.example/hls/a.m3u8?ks=SIGNATURE&b=2'),
    'cdn.example/hls/a.m3u8',
  );
});

test('translationKey is stable and input-sensitive', async () => {
  const a1 = await translationKey('Russian', 'glm-5.3-flash', 'hello');
  const a2 = await translationKey('Russian', 'glm-5.3-flash', 'hello');
  const b = await translationKey('Russian', 'glm-5.3-flash', 'help');
  const c = await translationKey('English', 'glm-5.3-flash', 'hello');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.notEqual(a1, c);
  assert.match(a1, /^[0-9a-f]{64}$/);
});

test('sourceIdentity ignores query, differs by path', async () => {
  const a = await sourceIdentity('https://cdn.example/e/0_xx.m3u8?ks=1');
  const b = await sourceIdentity('https://cdn.example/e/0_xx.m3u8?ks=2');
  const c = await sourceIdentity('https://cdn.example/e/0_yy.m3u8?ks=1');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
