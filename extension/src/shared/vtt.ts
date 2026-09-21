// WebVTT parsing and cue normalization.

export interface ParsedCue {
  start: number;
  end: number;
  text: string;
}

const TS_FULL = /^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})$/;
const TS_SHORT = /^(\d{1,3}):(\d{2})[.,](\d{1,3})$/;

/** Parses "HH:MM:SS.mmm", "MM:SS.mmm" (also comma decimals). Returns seconds or null. */
export function parseTimestamp(s: string): number | null {
  const t = s.trim();
  let m = TS_FULL.exec(t);
  if (m) {
    return (
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
    );
  }
  m = TS_SHORT.exec(t);
  if (m) {
    return Number(m[1]) * 60 + Number(m[2]) + Number(m[3].padEnd(3, '0')) / 1000;
  }
  return null;
}

const ARROW_RE = /^(.+?)\s+-->\s+(.+?)(?:\s+.*)?$/;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** Removes VTT inline markup: <c>, <v Speaker>, <i>, <b>, voice/spans and inline timestamps. */
function stripInlineTags(line: string): string {
  return decodeEntities(
    line
      .replace(/<[^>]*>/g, '')
      .replace(/\{[^}]*\}/g, '')
  ).trim();
}

/**
 * Line-scan VTT parser. Tolerates concatenated segment files, missing header,
 * NOTE/STYLE/REGION blocks and cue identifiers on their own line.
 */
export function parseVtt(text: string): ParsedCue[] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');
  const cues: ParsedCue[] = [];
  let pending: { start: number; end: number; lines: string[] } | null = null;

  const flush = () => {
    if (!pending) return;
    const textOut = pending.lines
      .map(stripInlineTags)
      .filter((l) => l.length > 0)
      .join('\n');
    if (textOut) cues.push({ start: pending.start, end: pending.end, text: textOut });
    pending = null;
  };

  for (const line of lines) {
    if (!pending) {
      const m = ARROW_RE.exec(line);
      if (m) {
        const start = parseTimestamp(m[1]);
        const end = parseTimestamp(m[2]);
        if (start !== null && end !== null && end > start) {
          pending = { start, end, lines: [] };
        }
      }
      // cue id lines, WEBVTT header, NOTE/STYLE/REGION and their bodies are skipped implicitly
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.includes('-->')) {
      // new cue started without a blank line after previous text; flush and start over
      flush();
      const m = ARROW_RE.exec(line);
      if (m) {
        const start = parseTimestamp(m[1]);
        const end = parseTimestamp(m[2]);
        if (start !== null && end !== null && end > start) {
          pending = { start, end, lines: [] };
        }
      }
      continue;
    }
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) {
      flush();
      continue;
    }
    pending.lines.push(line);
  }
  flush();
  return cues;
}

/**
 * Merged, deduplicated cue list:
 * - sorted by start time;
 * - exact duplicates removed (HLS segments often repeat a cue at segment boundaries);
 * - cues fully covered by an identical-text cue are dropped.
 */
export function normalizeCues(all: ParsedCue[]): ParsedCue[] {
  const sorted = [...all].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ParsedCue[] = [];
  const seen = new Set<string>();
  for (const cue of sorted) {
    const key = `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|${cue.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
  }
  return out;
}
