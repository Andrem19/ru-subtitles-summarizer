// Hashing and identity helpers (cache keys, entry ids).

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Generic sha256 hex hash (cache keys etc.). */
export const sha256HexFor = sha256Hex;

/** Cache key for one text translation: independent of signed URLs and cue ids. */
export function translationKey(lang: string, model: string, text: string): Promise<string> {
  return sha256Hex(`${lang}\u0000${model}\u0000${text}`);
}

/** Fallback identity when no Kaltura entry id can be extracted. */
export async function sourceIdentity(url: string): Promise<string> {
  let path = url;
  try {
    const u = new URL(url);
    path = `${u.host}${u.pathname}`;
  } catch {
    /* keep raw */
  }
  return sha256Hex(path);
}

/**
 * Extracts Kaltura entry id (0_xxxxxxxx) from playlist/segment URLs.
 * Handles /entryId/0_abcd/, entryId=0_abcd, entry_0_abcd.vtt patterns.
 */
export function extractKalturaEntryId(url: string): string | null {
  const m = /(?:entryId|entry_id)[=/](0_[A-Za-z0-9_-]+)/.exec(url);
  if (m) return m[1];
  const m2 = /entry[/_-](0_[A-Za-z0-9_-]+?)\.(?:vtt|m3u8)/i.exec(url);
  if (m2) return m2[1];
  return null;
}

/** Normalized URL for in-session dedup: drops signed query, keeps path. */
export function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}
