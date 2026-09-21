// YouTube timedtext parsing: JSON3 events and legacy XML transcript formats.
// Pure functions — unit-tested in Node.

export interface TimedTextCue {
  start: number;
  end: number;
  text: string;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Parses a timedtext JSON3 body (fmt=json3). */
export function parseJson3(body: string): TimedTextCue[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  const events = (data as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  const out: TimedTextCue[] = [];
  for (const ev of events) {
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown };
    if (typeof e.tStartMs !== 'number') continue;
    if (!Array.isArray(e.segs)) continue;
    const text = e.segs
      .map((s) => (typeof s === 'object' && s !== null && typeof (s as { utf8?: unknown }).utf8 === 'string'
        ? (s as { utf8: string }).utf8
        : ''))
      .join('')
      .replace(/\n+/g, ' ')
      .trim();
    if (!text) continue;
    const start = e.tStartMs / 1000;
    const end = start + (typeof e.dDurationMs === 'number' ? e.dDurationMs / 1000 : 2);
    out.push({ start, end, text });
  }
  return out;
}

/** Parses a legacy XML transcript body (<text start="..." dur="...">...). */
export function parseTimedTextXml(body: string): TimedTextCue[] {
  const out: TimedTextCue[] = [];
  const re = /<text[^>]*\bstart="([\d.]+)"[^>]*\bdur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const start = Number(m[1]);
    const dur = Number(m[2]);
    const text = decodeXmlEntities(m[3].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text || !Number.isFinite(start)) continue;
    out.push({ start, end: start + (Number.isFinite(dur) ? dur : 2), text });
  }
  return out;
}

/** Auto-detects the timedtext format; returns [] for an empty body. */
export function parseTimedText(body: string): TimedTextCue[] {
  const t = body.trim();
  if (!t) return [];
  if (t.startsWith('{')) return parseJson3(t);
  if (t.startsWith('<')) return parseTimedTextXml(t);
  return [];
}
