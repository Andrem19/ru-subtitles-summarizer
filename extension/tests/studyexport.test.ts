import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGuideExport, guideIdentity } from '../src/shared/studyexport';
import { type TranscriptLine } from '../src/shared/studyguide';

const cue = (start: number, text: string): TranscriptLine => ({ start, text });

test('buildGuideExport: the file matches the Hub ingestion shape, identity is stable', async () => {
  const cues = [cue(0, 'Hello.'), cue(30, 'World.')];
  const markdown = '# Lecture\n\n## Summary\n\nSome text.\n\n## Details\n\nMore.\n\n## A third section\n\nEven more text to satisfy any length ideas.';
  const input = {
    markdown,
    cues,
    videoUrl: 'https://example.org/lecture-1',
    title: 'Lecture 1',
    language: 'en',
    generatorVersion: 'ext-1.4.0',
    model: 'test-model',
  };
  const first = await buildGuideExport(input);
  const parsed = JSON.parse(first.json) as {
    document: Record<string, unknown>;
    transcriptHash: string;
    transcriptExcerpt: string;
  };
  assert.equal(parsed.document.videoUrl, 'https://example.org/lecture-1');
  assert.equal(parsed.document.language, 'en');
  assert.equal((parsed.document as { guideMarkdown?: string }).guideMarkdown, markdown);
  assert.match(parsed.transcriptHash, /^[0-9a-f]{64}$/);
  assert.ok(parsed.transcriptExcerpt.includes('Hello.'));
  assert.match(first.filename, /^study-guide-[0-9a-f]{12}\.json$/);

  // Same transcript + generator = the same Hub entity id; a different
  // generator version is a different card, by design.
  const again = await buildGuideExport(input);
  assert.equal(again.entityId, first.entityId);
  const other = await buildGuideExport({ ...input, generatorVersion: 'ext-1.5.0' });
  assert.notEqual(other.entityId, first.entityId);
});

test('guideIdentity: two transcripts never share an id, the same one always does', async () => {
  const a = await guideIdentity('hash-a', 'ext-1.4.0');
  const a2 = await guideIdentity('hash-a', 'ext-1.4.0');
  const b = await guideIdentity('hash-b', 'ext-1.4.0');
  assert.equal(a, a2);
  assert.notEqual(a, b);
});
