import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGuideExport, expectedEntityId, guideIdentity, validateGuideExport } from '../src/shared/studyexport';
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

test('the export file carries schemaVersion 1 and survives its own validator', async () => {
  const cues = [cue(0, 'Hello.'), cue(30, 'World.')];
  const input = {
    markdown: '# Guide\n\n## Summary\n\nText.\n\n## Details\n\nMore.\n\n## Third\n\nEven more.',
    cues,
    videoUrl: 'https://example.org/lecture-2',
    title: 'Lecture 2',
    language: 'en',
    generatorVersion: 'ext-1.4.0',
  };
  const built = await buildGuideExport(input);
  const verdict = await validateGuideExport(built.json);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.value.schemaVersion, 1);
    assert.equal(await expectedEntityId(verdict.value), built.entityId); // identity re-derives from the file
  }
});

test('the validator rejects edited, foreign and truncated files with reasons', async () => {
  const built = await buildGuideExport({
    markdown: '# Guide\n\n## Summary\n\nText.\n\n## Details\n\nMore.\n\n## Third\n\nEven more.',
    cues: [cue(0, 'Hello.')],
    videoUrl: 'https://example.org/lecture-3',
    title: 'Lecture 3',
    language: 'en',
    generatorVersion: 'ext-1.4.0',
  });
  // Cosmetic edits stay valid and keep the identity: the id derives from the
  // transcript hash + generator, not from the editable display fields.
  const edited = JSON.parse(built.json);
  edited.document.title = 'Renamed';
  const editedVerdict = await validateGuideExport(JSON.stringify(edited));
  assert.equal(editedVerdict.ok, true);
  if (editedVerdict.ok) {
    assert.equal(await expectedEntityId(editedVerdict.value), built.entityId);
  }
  // A changed transcriptHash is a different transcript: different identity.
  const rehashed = JSON.parse(built.json);
  rehashed.transcriptHash = 'b'.repeat(64);
  const rehashedVerdict = await validateGuideExport(JSON.stringify(rehashed));
  assert.equal(rehashedVerdict.ok, true);
  if (rehashedVerdict.ok) {
    assert.notEqual(await expectedEntityId(rehashedVerdict.value), built.entityId);
  }

  const wrongSchema = JSON.parse(built.json);
  wrongSchema.schemaVersion = 99;
  assert.equal((await validateGuideExport(JSON.stringify(wrongSchema))).ok, false);
  assert.equal((await validateGuideExport('not json at all')).ok, false);
  const missing = JSON.parse(built.json);
  delete missing.transcriptHash;
  const missingVerdict = await validateGuideExport(JSON.stringify(missing));
  assert.equal(missingVerdict.ok, false);
  assert.ok(missingVerdict.ok === false && missingVerdict.errors.some((e) => e.includes('transcriptHash')));
});
