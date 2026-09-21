// Caption pipeline: fetch playlist, fetch all VTT segments, normalize cues.

import { extractKalturaEntryId, normalizeUrlForDedup, sourceIdentity } from '../shared/hash';
import { looksLikeVttUrl, parseHls, resolveUrl } from '../shared/hls';
import { normalizeCues, parseVtt, type ParsedCue } from '../shared/vtt';

export class PipelineError extends Error {}

export async function fetchText(url: string, timeoutMs = 20_000, retries = 1): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
      if (!res.ok) throw new PipelineError(`HTTP ${res.status} для ${shortUrl(url)}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new PipelineError(String(lastErr));
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').slice(-2).join('/');
  } catch {
    return url;
  }
}

/** Fetch many URLs with limited concurrency; null on individual failure after retries. */
async function fetchAll(urls: string[], concurrency = 6, retries = 2): Promise<Array<string | null>> {
  const results: Array<string | null> = new Array(urls.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const idx = next++;
      try {
        results[idx] = await fetchText(urls[idx], 20_000, retries);
      } catch {
        results[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

export interface CaptionSource {
  cues: ParsedCue[];
  totalDuration: number;
  entryId: string | null;
  /** stable identity for logs */
  identity: string;
  segmentCount: number;
  failedSegments: string[];
}

export interface PlaylistProbe {
  isMaster: boolean;
  isSubtitlePlaylist: boolean;
  /** resolved absolute .vtt segment URLs */
  segmentUrls: string[];
  /** SUBTITLES variant playlist URLs (master playlists only) */
  subtitleVariantUrls: string[];
  totalDuration: number;
  entryId: string | null;
}

/**
 * Phase 1: fetch + parse the playlist (cheap, no segment downloads).
 * Returns null when the URL is not caption-related (e.g. a media playlist).
 */
export async function probePlaylist(playlistUrl: string): Promise<PlaylistProbe | null> {
  const text = await fetchText(playlistUrl);
  const playlist = parseHls(text, playlistUrl);
  if (playlist.isMaster) {
    return {
      isMaster: true,
      isSubtitlePlaylist: false,
      segmentUrls: [],
      subtitleVariantUrls: playlist.subtitleVariants.map((v) => v.uri),
      totalDuration: 0,
      entryId: extractKalturaEntryId(playlistUrl),
    };
  }
  if (!playlist.isSubtitlePlaylist) return null;
  const vttSegments = playlist.segments.filter((s) => looksLikeVttUrl(s.uri));
  const segmentUrls = vttSegments.map((s) => resolveUrl(playlistUrl, s.uri));
  return {
    isMaster: false,
    isSubtitlePlaylist: true,
    segmentUrls,
    subtitleVariantUrls: [],
    totalDuration: playlist.totalDuration,
    entryId: extractKalturaEntryId(playlistUrl) ?? firstEntryId(segmentUrls),
  };
}

/** Phase 2: download all .vtt segments and build the cue list. */
export async function downloadPlaylistSegments(probe: PlaylistProbe, playlistUrl: string): Promise<CaptionSource> {
  const bodies = await fetchAll(probe.segmentUrls);

  const cues: ParsedCue[] = [];
  const failedSegments: string[] = [];
  bodies.forEach((body, i) => {
    if (body === null) {
      failedSegments.push(probe.segmentUrls[i]);
      return;
    }
    try {
      cues.push(...parseVtt(body));
    } catch {
      failedSegments.push(probe.segmentUrls[i]);
    }
  });
  const normalized = normalizeCues(cues);
  const totalDuration =
    probe.totalDuration > 0
      ? probe.totalDuration
      : normalized.length > 0
        ? normalized[normalized.length - 1].end
        : 0;
  return {
    cues: normalized,
    totalDuration,
    entryId: probe.entryId,
    identity: await sourceIdentity(playlistUrl),
    segmentCount: probe.segmentUrls.length,
    failedSegments,
  };
}

/** Convenience wrapper: probe + download in one call (used by tests). */
export async function processSubtitlePlaylist(playlistUrl: string): Promise<CaptionSource> {
  const probe = await probePlaylist(playlistUrl);
  if (!probe || !probe.isSubtitlePlaylist) {
    throw new PipelineError(`Playlist не содержит .vtt сегментов: ${shortUrl(playlistUrl)}`);
  }
  return downloadPlaylistSegments(probe, playlistUrl);
}

function firstEntryId(urls: string[]): string | null {
  for (const u of urls) {
    const id = extractKalturaEntryId(u);
    if (id) return id;
  }
  return null;
}

/** Handles a directly-requested WebVTT caption file. */
export async function processVttUrl(url: string): Promise<CaptionSource> {
  const body = await fetchText(url);
  if (!/^\uFEFF?\s*WEBVTT/.test(body)) {
    throw new PipelineError(`Файл не похож на WebVTT: ${shortUrl(url)}`);
  }
  const cues = normalizeCues(parseVtt(body));
  return {
    cues,
    totalDuration: cues.length ? cues[cues.length - 1].end : 0,
    entryId: extractKalturaEntryId(url),
    identity: await sourceIdentity(url),
    segmentCount: 1,
    failedSegments: [],
  };
}

export { normalizeUrlForDedup };
