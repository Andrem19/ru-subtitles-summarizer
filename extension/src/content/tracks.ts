// TextTrack management and best-effort suppression of native (English) captions.

export interface TrackBundle {
  track: TextTrack;
  cues: Map<string, VTTCue>;
}

export function ensureTrack(video: HTMLVideoElement, requestId: string): TrackBundle {
  const existing = video.__rusubTracks?.get(requestId);
  if (existing) return existing;
  const track = video.addTextTrack('subtitles', 'Русский (автоперевод)', 'ru');
  track.mode = 'disabled';
  const bundle: TrackBundle = { track, cues: new Map() };
  if (!video.__rusubTracks) video.__rusubTracks = new Map();
  video.__rusubTracks.set(requestId, bundle);
  return bundle;
}

/** Create (once) a VTTCue per cue; text is filled in as translations arrive. */
export function makeCue(
  bundle: TrackBundle,
  id: string,
  start: number,
  end: number,
): VTTCue {
  const existing = bundle.cues.get(id);
  if (existing) return existing;
  const cue = new VTTCue(start, end, '');
  cue.id = id;
  try {
    bundle.track.addCue(cue);
  } catch {
    /* duplicate or invalid — ignore */
  }
  bundle.cues.set(id, cue);
  return cue;
}

export interface SuppressedRecord {
  track: TextTrack;
  prevMode: TextTrackMode;
}

/** Disable showing native caption/subtitle tracks (English CC) while our subtitles are active. */
export function suppressNativeCaptions(video: HTMLVideoElement, requestId: string): SuppressedRecord[] {
  const out: SuppressedRecord[] = [];
  const tracks = video.textTracks;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.mode !== 'showing') continue;
    let isOurs = false;
    if (video.__rusubTracks) {
      for (const bundle of video.__rusubTracks.values()) {
        if (bundle.track === t) {
          isOurs = true;
          break;
        }
      }
    }
    if (isOurs) continue;
    const lang = (t.language || '').toLowerCase();
    // Only touch clearly-English (or language-less) caption tracks; leave anything else alone.
    if (lang && !lang.startsWith('en')) continue;
    out.push({ track: t, prevMode: t.mode });
    t.mode = 'disabled';
    void requestId;
  }
  return out;
}

/** Restore tracks suppressed earlier. */
export function restoreNativeCaptions(records: SuppressedRecord[]): void {
  for (const rec of records) {
    try {
      rec.track.mode = rec.prevMode;
    } catch {
      /* track may be gone */
    }
  }
}
