// YouTube embedded-video captions: fetch the watch page, pick an English
// caption track and download the timedtext transcript.

import { diag } from '../shared/diag';
import { parseTimedText, type TimedTextCue } from '../shared/timedtext';

export interface YoutubeTranscript {
  videoId: string;
  cues: TimedTextCue[];
  totalDuration: number;
  title: string | null;
}

/** Outcome of the direct (watch-page) attempt, with a reason for diagnostics. */
export type DirectResult =
  | { ok: true; transcript: YoutubeTranscript }
  | { ok: false; reason: DirectFailReason; tracks?: number; bytes?: number };

export type DirectFailReason =
  | 'watch-fetch-failed'
  | 'watch-http'
  | 'no-tracks'
  | 'timedtext-http'
  | 'empty-timedtext'
  | 'parse-empty'
  | 'network-error';

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

/** Balanced-bracket scan for "captionTracks":[...] inside the watch page HTML. */
export function extractCaptionTracks(html: string): CaptionTrack[] {
  const key = '"captionTracks":';
  const keyIdx = html.indexOf(key);
  if (keyIdx < 0) return [];
  const start = html.indexOf('[', keyIdx);
  if (start < 0) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, i + 1)) as unknown;
          return Array.isArray(parsed) ? (parsed as CaptionTrack[]) : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/** Manual English track first, then auto-generated, then any track. */
export function pickEnglishTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const manualEn = tracks.find((t) => (t.languageCode ?? '').toLowerCase().startsWith('en') && !t.kind);
  const anyEn = tracks.find((t) => (t.languageCode ?? '').toLowerCase().startsWith('en'));
  return manualEn ?? anyEn ?? tracks[0] ?? null;
}

function extractTitle(html: string): string | null {
  const m = /<meta\s+name="title"\s+content="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}

const WATCH_HEADERS: Record<string, string> = { 'Accept-Language': 'en-US,en;q=0.9' };

/**
 * Path A: fetch the watch page with the browser session and download the
 * timedtext transcript directly. Fails with `empty-timedtext` when YouTube
 * withholds the body (proof-of-origin token required) — the caller then
 * switches to the intercept path.
 */
export async function fetchYoutubeTranscript(videoId: string): Promise<DirectResult> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  let html: string;
  try {
    const res = await fetch(watchUrl, { credentials: 'include', headers: WATCH_HEADERS });
    if (!res.ok) {
      diag('diagBG', `yt:A watch http ${res.status}`);
      return { ok: false, reason: 'watch-http' };
    }
    html = await res.text();
  } catch (e) {
    diag('diagBG', `yt:A watch fetch threw ${String((e as Error)?.message ?? e)}`);
    return { ok: false, reason: 'watch-fetch-failed' };
  }
  const tracks = extractCaptionTracks(html);
  const track = pickEnglishTrack(tracks);
  diag('diagBG', `yt:A html=${html.length}B tracks=${tracks.length} picked=${track?.languageCode ?? '-'}${track?.kind ? '/' + track.kind : ''}`);
  if (!track?.baseUrl) return { ok: false, reason: 'no-tracks', tracks: tracks.length };
  try {
    const res = await fetch(`${track.baseUrl}&fmt=json3`, { credentials: 'include' });
    if (!res.ok) {
      diag('diagBG', `yt:A timedtext http ${res.status}`);
      return { ok: false, reason: 'timedtext-http', tracks: tracks.length };
    }
    const body = await res.text();
    const cues = parseTimedText(body);
    diag('diagBG', `yt:A timedtext ${body.length}B cues=${cues.length}`);
    if (cues.length === 0) return { ok: false, reason: 'empty-timedtext', tracks: tracks.length, bytes: body.length };
    return { ok: true, transcript: buildTranscript(videoId, cues, extractTitle(html)) };
  } catch (e) {
    diag('diagBG', `yt:A timedtext threw ${String((e as Error)?.message ?? e)}`);
    return { ok: false, reason: 'network-error', tracks: tracks.length };
  }
}

/** Downloads an already-observed player timedtext URL (has a valid pot token). */
export async function fetchTimedTextUrl(url: string, videoId: string): Promise<YoutubeTranscript | null> {
  const hasPot = /[?&]pot=/.test(url);
  try {
    const withFmt = /[?&]fmt=/.test(url) ? url : `${url}&fmt=json3`;
    const res = await fetch(withFmt, { credentials: 'include' });
    const body = await res.text();
    const cues = parseTimedText(body);
    diag('diagBG', `yt:B observe pot=${hasPot ? 'yes' : 'no'} http=${res.status} ${body.length}B cues=${cues.length}`);
    if (!res.ok || cues.length === 0) return null;
    return buildTranscript(videoId, cues, null);
  } catch (e) {
    diag('diagBG', `yt:B fetch threw ${String((e as Error)?.message ?? e)}`);
    return null;
  }
}

function buildTranscript(videoId: string, cues: TimedTextCue[], title: string | null): YoutubeTranscript {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const last = sorted[sorted.length - 1];
  return {
    videoId,
    cues: sorted,
    totalDuration: last ? last.end : 0,
    title,
  };
}
