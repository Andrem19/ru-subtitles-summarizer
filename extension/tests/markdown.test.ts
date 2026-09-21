import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdownLines } from '../src/shared/markdown';

test('headings, paragraphs and lists are parsed into blocks', () => {
  const md = [
    '# Title',
    '',
    '## Section',
    'Some paragraph text.',
    '',
    '- item one',
    '- item two **bold**',
    '',
    '1. first',
    '2. second',
  ].join('\n');
  const blocks = parseMarkdownLines(md.split('\n'));
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['h1', 'h2', 'p', 'ul', 'ol'],
  );
  assert.equal(blocks[0].text, 'Title');
  assert.equal(blocks[2].text, 'Some paragraph text.');
  assert.deepEqual(blocks[3].items, ['item one', 'item two **bold**']);
  assert.deepEqual(blocks[4].items, ['first', 'second']);
});

test('multi-line paragraphs are joined', () => {
  const blocks = parseMarkdownLines(['line one', 'line two', '', 'after blank']);
  assert.equal(blocks[0].type, 'p');
  assert.equal(blocks[0].text, 'line one line two');
  assert.equal(blocks[1].text, 'after blank');
});

test('### headings map to level 3', () => {
  const blocks = parseMarkdownLines(['### [5:12] Topic']);
  assert.equal(blocks[0].type, 'h3');
  assert.equal(blocks[0].text, '[5:12] Topic');
});

test('parseInline: bold, em, code and plain segments', () => {
  const segs = parseInline('plain **bold** and *em* plus `code` tail');
  assert.deepEqual(
    segs.map((s) => s.style),
    ['plain', 'bold', 'plain', 'em', 'plain', 'code', 'plain'],
  );
  assert.equal(segs[1].text, 'bold');
  assert.equal(segs[3].text, 'em');
  assert.equal(segs[5].text, 'code');
});

test('parseInline: plain text without markup', () => {
  assert.deepEqual(parseInline('no formatting'), [{ text: 'no formatting', style: 'plain' }]);
});
