// Tiny Markdown block parser (pure) + safe DOM renderer.
// Model output is NEVER inserted as HTML — only text nodes.

export interface MdBlock {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol';
  /** heading level (1..3) for h1..h3 */
  level?: number;
  text?: string;
  items?: string[];
}

export function parseMarkdownLines(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: 'p', text: para.join(' ') });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: list.type, items: list.items });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const lvl = Math.min(3, h[1].length);
      blocks.push({ type: `h${lvl}` as 'h1' | 'h2' | 'h3', level: lvl, text: h[2].trim() });
      continue;
    }
    if (/^([-*•])\s+/.test(line)) {
      flushPara();
      const item = line.replace(/^([-*•])\s+/, '');
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(item);
      continue;
    }
    const ol = /^(\d+)[.)]\s+/.exec(line);
    if (ol) {
      flushPara();
      const item = line.replace(/^(\d+)[.)]\s+/, '');
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(item);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

export interface InlineSeg {
  text: string;
  style: 'plain' | 'bold' | 'em' | 'code';
}

/** Splits text into styled segments: **bold**, *em*, `code`. */
export function parseInline(text: string): InlineSeg[] {
  const segs: InlineSeg[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), style: 'plain' });
    const tok = m[0];
    if (tok.startsWith('**')) segs.push({ text: tok.slice(2, -2), style: 'bold' });
    else if (tok.startsWith('`')) segs.push({ text: tok.slice(1, -1), style: 'code' });
    else segs.push({ text: tok.slice(1, -1), style: 'em' });
    last = m.index + tok.length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), style: 'plain' });
  return segs.length > 0 ? segs : [{ text, style: 'plain' }];
}

/** Renders markdown into a container using only created DOM nodes (XSS-safe). */
export function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.textContent = '';
  const doc = container.ownerDocument;
  const appendInline = (el: HTMLElement, text: string) => {
    for (const seg of parseInline(text)) {
      if (seg.style === 'plain') el.appendChild(doc.createTextNode(seg.text));
      else {
        const tag = seg.style === 'bold' ? 'strong' : seg.style === 'em' ? 'em' : 'code';
        const node = doc.createElement(tag);
        node.textContent = seg.text;
        el.appendChild(node);
      }
    }
  };
  for (const block of parseMarkdownLines(markdown.split(/\r?\n/))) {
    if (block.type === 'h1' || block.type === 'h2' || block.type === 'h3') {
      const h = doc.createElement(block.type);
      h.textContent = block.text ?? '';
      container.appendChild(h);
    } else if (block.type === 'p') {
      const p = doc.createElement('p');
      appendInline(p, block.text ?? '');
      container.appendChild(p);
    } else {
      const list = doc.createElement(block.type === 'ul' ? 'ul' : 'ol');
      for (const item of block.items ?? []) {
        const li = doc.createElement('li');
        appendInline(li, item);
        list.appendChild(li);
      }
      container.appendChild(list);
    }
  }
}
