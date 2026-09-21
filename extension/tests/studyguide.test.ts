import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGuideMessages,
  buildNotesMessages,
  chunkTranscript,
  fmtTimestamp,
  parseGuideResponse,
  transcriptToLines,
  type TranscriptLine,
} from '../src/shared/studyguide';

const cue = (start: number, text: string): TranscriptLine => ({ start, text });

test('fmtTimestamp: minutes and hours formats', () => {
  assert.equal(fmtTimestamp(0), '0:00');
  assert.equal(fmtTimestamp(65), '1:05');
  assert.equal(fmtTimestamp(3723), '1:02:03');
});

test('transcriptToLines prefixes each cue with its timestamp', () => {
  const lines = transcriptToLines([cue(0, 'Hello.'), cue(75.4, ' Research methods.')]);
  assert.equal(lines, '[0:00] Hello.\n[1:15] Research methods.');
});

test('chunkTranscript splits at line boundaries within budget', () => {
  const cues: TranscriptLine[] = Array.from({ length: 100 }, (_, i) =>
    cue(i * 5, 'x'.repeat(200)),
  );
  const chunks = chunkTranscript(cues, 5000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 5000 + 250, `chunk too long: ${chunk.length}`);
    for (const line of chunk.split('\n')) {
      assert.match(line, /^\[\d+:\d+\] /);
    }
  }
  // all cues preserved, in order
  const total = chunks.reduce((a, c) => a + c.split('\n').length, 0);
  assert.equal(total, 100);
});

test('chunkTranscript: empty input → no chunks', () => {
  assert.deepEqual(chunkTranscript([]), []);
});

test('guide prompt: format, terminology rule, transcript present', () => {
  const msgs = buildGuideMessages('[0:10] Photosynthesis works.');
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('Глоссарий терминов'));
  assert.ok(msgs[0].content.includes('English term'));
  assert.ok(msgs[0].content.includes('Пояснение'));
  assert.ok(msgs[1].content.includes('[0:10] Photosynthesis works.'));
});

test('notes prompt is a map-step prompt', () => {
  const msgs = buildNotesMessages('[1:00] chunk text');
  assert.ok(msgs[0].content.includes('заметки'));
  assert.ok(msgs[1].content.includes('chunk text'));
});

test('parseGuideResponse accepts a well-formed guide', () => {
  const filler = 'Развёрнутое предложение с объяснением материала лекции. '.repeat(6);
  const md = [
    '# Лекция',
    '',
    '## Краткая сводка',
    filler,
    '',
    '## Ключевые моменты',
    '- пункт один с пояснением',
    '- пункт два с пояснением',
    '',
    '## Подробный разбор',
    '### [5:12] Тема',
    filler,
    '',
    '## Глоссарий терминов',
    '- **research** — исследование: процесс. ' + filler,
  ].join('\n');
  const res = parseGuideResponse('```markdown\n' + md + '\n```');
  assert.equal(res.ok, true);
  assert.ok(res.markdown.startsWith('# Лекция'));
});

test('parseGuideResponse rejects output without required structure', () => {
  assert.equal(parseGuideResponse('Просто текст без заголовков, недостаточно длинный.').ok, false);
  const noSections = '# Title only\n\n' + 'lorem ipsum '.repeat(40);
  assert.equal(parseGuideResponse(noSections).ok, false);
});
