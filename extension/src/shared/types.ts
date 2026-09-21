// Shared types for the extension.

/** Normalized subtitle cue. Timestamps are seconds (float) taken verbatim from the source VTT. */
export interface Cue {
  id: string;
  start: number;
  end: number;
  original: string;
}

/** One item sent to the LLM: text only + opaque id. Never timestamps. */
export interface TranslateItem {
  id: string;
  text: string;
}

export type DisplayMode = 'ru' | 'bi' | 'off';

export type JobStatus = 'waiting' | 'fetching' | 'translating' | 'done' | 'partial' | 'error';

export interface ProgressInfo {
  done: number;
  total: number;
}

/** background -> content: full cue list for one Kaltura caption playlist */
export interface CuesMessage {
  type: 'rusub:cues';
  requestId: string;
  cues: Cue[];
  totalDuration: number;
  sourceUrl: string;
  entryId: string | null;
  /** true when auto-translate should start immediately (settings + tab host allow it) */
  auto: boolean;
  targetLang: string;
}

/** background -> content: chunk of translations (keyed by unique-text item id) */
export interface TranslationsMessage {
  type: 'rusub:translations';
  requestId: string;
  /** itemId -> translated text */
  entries: Record<string, string>;
  progress: ProgressInfo;
  status: JobStatus;
  error?: string;
}

/** content -> background: ask to (re)translate items (used for retries and service-worker restart recovery) */
export interface EnsureTranslationMessage {
  type: 'rusub:ensureTranslation';
  requestId: string;
  /** unique texts, with earliest cue start time for prioritization */
  items: Array<{ id: string; text: string; start: number | null }>;
}

/** content -> background: request (or regenerate) the study guide for a video */
export interface GuideRequestMessage {
  type: 'rusub:guideRequest';
  requestId: string;
  /** full original transcript (cue starts + English text) */
  cues: Array<{ start: number; text: string }>;
  /** stable Kaltura entry id — primary cache key so guides survive reloads */
  entryId?: string | null;
  /** true → ignore/regenerate cached guide */
  force?: boolean;
}

/** background -> content: study guide generation progress/result */
export interface GuideMessage {
  type: 'rusub:guide';
  requestId: string;
  status: 'generating' | 'ready' | 'error';
  markdown?: string;
  error?: string;
}

/** content -> background: periodic playback position report for prioritization */
export interface TimeUpdateMessage {
  type: 'rusub:timeUpdate';
  requestId: string;
  time: number;
}

/** content -> background: YouTube embed detected — fetch its captions */
export interface YoutubeCuesRequestMessage {
  type: 'rusub:youtubeCues';
  videoId: string;
}

/** background -> content: direct-download failed; toggle the player CC so the
 *  real timedtext request can be observed (path B) */
export interface YoutubeEnableCcMessage {
  type: 'rusub:youtubeEnableCc';
  videoId: string;
}

export type ContentMessage =
  | EnsureTranslationMessage
  | GuideRequestMessage
  | TimeUpdateMessage
  | YoutubeCuesRequestMessage
  | { type: 'rusub:cancel'; requestId: string }
  | { type: 'rusub:openOptions' };

export type BackgroundMessage = CuesMessage | TranslationsMessage | GuideMessage | YoutubeEnableCcMessage;

export const isContentMessage = (m: unknown): m is ContentMessage =>
  typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string' &&
  ((m as { type: string }).type.startsWith('rusub:'));
