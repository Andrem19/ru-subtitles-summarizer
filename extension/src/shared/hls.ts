// HLS (m3u8) parsing: classify playlists, resolve relative segment URLs.

export interface HlsSegment {
  uri: string;
  duration: number;
}

export interface HlsVariant {
  uri: string;
  language?: string;
  name?: string;
}

export interface HlsPlaylist {
  isMaster: boolean;
  /** true when the playlist references WebVTT segments (subtitle playlist) */
  isSubtitlePlaylist: boolean;
  segments: HlsSegment[];
  /** media variants listed in a master playlist */
  variants: HlsVariant[];
  /** SUBTITLES renditions listed in a master playlist */
  subtitleVariants: HlsVariant[];
  /** sum of EXTINF durations */
  totalDuration: number;
}

export function resolveUrl(base: string, rel: string): string {
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

const VTT_RE = /\.vtt(\?|#|$)/i;

export function looksLikeVttUrl(uri: string): boolean {
  return VTT_RE.test(uri);
}

export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  const variants: HlsVariant[] = [];
  const subtitleVariants: HlsVariant[] = [];
  let isMaster = false;
  let pendingDuration: number | null = null;
  let pendingSubtitleVariant: HlsVariant | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.slice(8).split(',')[0]);
      pendingDuration = Number.isFinite(dur) ? dur : 0;
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      pendingSubtitleVariant = null;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = (attrs.get('TYPE') || '').toUpperCase();
      const uri = attrs.get('URI');
      if (type === 'SUBTITLES' && uri) {
        subtitleVariants.push({
          uri: resolveUrl(baseUrl, uri),
          language: attrs.get('LANGUAGE'),
          name: attrs.get('NAME'),
        });
      }
      continue;
    }

    if (line.startsWith('#')) continue; // other tags / comments

    // URI line (segment or variant)
    if (isMaster) {
      variants.push({ uri: resolveUrl(baseUrl, line) });
      pendingSubtitleVariant = null;
      continue;
    }
    const uri = resolveUrl(baseUrl, line);
    segments.push({ uri, duration: pendingDuration ?? 0 });
    pendingDuration = null;
  }

  const isSubtitlePlaylist =
    !isMaster && segments.length > 0 && segments.some((s) => looksLikeVttUrl(s.uri));
  const totalDuration = segments.reduce((acc, s) => acc + s.duration, 0);
  void pendingSubtitleVariant;
  return { isMaster, isSubtitlePlaylist, segments, variants, subtitleVariants, totalDuration };
}

export function parseAttributes(input: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const key = m[1];
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out.set(key, val);
  }
  return out;
}
