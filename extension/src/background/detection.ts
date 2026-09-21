// Caption playlist detection via chrome.webRequest (MV3, non-blocking observation).

import { normalizeUrlForDedup } from '../shared/hash';
import {
  PipelineError,
  downloadPlaylistSegments,
  processVttUrl,
  probePlaylist,
  type CaptionSource,
} from './pipeline';

export interface DetectedPlaylist {
  tabId: number;
  frameId: number;
  url: string;
  source: CaptionSource;
}

export interface DetectionHandlers {
  onSource: (det: DetectedPlaylist) => void;
  onError: (info: { tabId: number; frameId: number; url: string; message: string }) => void;
  log: (...args: unknown[]) => void;
}

const URL_FILTERS = [
  '*://*/*.m3u8*',
  '*://*/*.vtt*',
  '*://*/*.vtt?*',
];

/**
 * Extension-less caption playlists are classified by Content-Type, so the
 * header listener has to run on every host — captions are served from whatever
 * CDN a player happens to use. Only a few request types can carry a caption
 * playlist, which keeps the listener cheap on ordinary pages.
 */
const HEADER_URL_FILTERS = [
  'http://*/*',
  'https://*/*',
];

const CAPTION_REQUEST_TYPES: `${chrome.webRequest.ResourceType}`[] = [
  'xmlhttprequest',
  'media',
  'other',
];

/** The player itself downloads .vtt segments; give playlists a moment to claim them first. */
const VTT_CLAIM_GRACE_MS = 3000;

export function initDetection(handlers: DetectionHandlers): void {
  const seen = new Map<number, Set<string>>();
  /** segment URLs already claimed by a processed playlist, per tab */
  const claimedSegments = new Map<number, Set<string>>();

  const isSeen = (tabId: number, url: string): boolean => {
    const key = normalizeUrlForDedup(url);
    let set = seen.get(tabId);
    if (!set) {
      set = new Set();
      seen.set(tabId, set);
    }
    if (set.has(key)) return true;
    set.add(key);
    return false;
  };

  const claimSegments = (tabId: number, urls: string[]) => {
    let set = claimedSegments.get(tabId);
    if (!set) {
      set = new Set();
      claimedSegments.set(tabId, set);
    }
    for (const u of urls) set.add(normalizeUrlForDedup(u));
  };

  const isClaimed = (tabId: number, url: string): boolean =>
    claimedSegments.get(tabId)?.has(normalizeUrlForDedup(url)) ?? false;

  const enqueue = (tabId: number, frameId: number, url: string, isProbablyVtt: boolean) => {
    if (tabId < 0) return;
    if (isSeen(tabId, url)) return;
    if (isProbablyVtt) {
      // Defer: if this .vtt belongs to a caption playlist, the playlist probe
      // will claim it and we must not treat the segment as a standalone source.
      setTimeout(() => {
        if (isClaimed(tabId, url)) return;
        void handle(tabId, frameId, url, true);
      }, VTT_CLAIM_GRACE_MS);
      return;
    }
    void handle(tabId, frameId, url, false);
  };

  const handle = async (tabId: number, frameId: number, url: string, isProbablyVtt: boolean) => {
    try {
      if (isProbablyVtt) {
        const source = await processVttUrl(url);
        if (source.cues.length === 0) return;
        handlers.log(`[rusub] caption source (vtt): ${source.cues.length} cues from ${url.slice(0, 120)}`);
        handlers.onSource({ tabId, frameId, url, source });
        return;
      }
      const probe = await probePlaylist(url);
      if (!probe) return; // media playlist, not captions
      if (probe.isMaster) {
        for (const variant of probe.subtitleVariantUrls) {
          if (!isSeen(tabId, variant)) {
            void handle(tabId, frameId, variant, false);
          }
        }
        return;
      }
      claimSegments(tabId, probe.segmentUrls);
      const source = await downloadPlaylistSegments(probe, url);
      if (source.cues.length === 0) return;
      handlers.log(`[rusub] caption source: ${source.cues.length} cues from ${url.slice(0, 120)}`);
      handlers.onSource({ tabId, frameId, url, source });
    } catch (e) {
      const message = e instanceof PipelineError || e instanceof Error ? e.message : String(e);
      handlers.log(`[rusub] detection skipped ${url.slice(0, 120)}: ${message}`);
      if (isProbablyVtt) {
        handlers.onError({ tabId, frameId, url, message });
      }
    }
  };

  const looksLikeSubtitleRequest = (url: string): boolean => {
    const path = url.toLowerCase();
    return path.includes('.m3u8') || path.includes('.vtt');
  };

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (!looksLikeSubtitleRequest(details.url)) return;
      const isVtt = details.url.toLowerCase().includes('.vtt');
      enqueue(details.tabId, details.frameId, details.url, isVtt);
    },
    { urls: URL_FILTERS, types: CAPTION_REQUEST_TYPES },
  );

  // Extension-less caption playlists: classify by Content-Type on any host.
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      const types = details.responseHeaders ?? [];
      const ctype = types.find((h) => h.name.toLowerCase() === 'content-type')?.value?.toLowerCase() ?? '';
      if (!/mpegurl|vtt/.test(ctype)) return;
      if (looksLikeSubtitleRequest(details.url)) return; // already covered by URL filter
      enqueue(details.tabId, details.frameId, details.url, /vtt/.test(ctype));
    },
    { urls: HEADER_URL_FILTERS, types: CAPTION_REQUEST_TYPES },
    ['responseHeaders'],
  );

  // Tab closed / navigated: drop per-tab state.
  const dropTab = (tabId: number) => {
    seen.delete(tabId);
    claimedSegments.delete(tabId);
  };
  chrome.tabs.onRemoved.addListener(dropTab);
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') dropTab(tabId);
  });
}
