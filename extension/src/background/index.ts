// MV3 service worker: detection -> pipeline -> engine -> content script messaging.

import type { CuesMessage, ContentMessage, GuideRequestMessage, YoutubeCuesRequestMessage } from '../shared/types';
import { hostMatches, loadSettings, type Settings } from '../shared/settings';
import { diag } from '../shared/diag';
import { initDetection, type DetectedPlaylist } from './detection';
import { TranslationEngine } from './engine';
import { handleGuideRequest } from './guides';
import { configureLlmQueue } from './llmQueue';
import { fetchTimedTextUrl, fetchYoutubeTranscript, type YoutubeTranscript } from './youtube';

let settings: Settings | null = null;

async function getSettings(): Promise<Settings> {
  if (!settings) settings = await loadSettings(chrome.storage.local);
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['settings']) {
    void getSettings().then((s) => {
      engine.updateSettings(s);
      configureLlmQueue(s.concurrency);
    });
  }
});

function log(...args: unknown[]): void {
  console.log(...args);
}

async function tabHost(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return null;
    return new URL(tab.url).hostname;
  } catch {
    return null;
  }
}

async function postToFrame(tabId: number, frameId: number, msg: unknown): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId });
    return true;
  } catch {
    // Content script may not be injected in that frame yet (e.g. player frame on an
    // uncovered host). Inject programmatically into all frames and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content.js'],
      });
      await chrome.tabs.sendMessage(tabId, msg, { frameId });
      return true;
    } catch (e) {
      log('[rusub] postToFrame failed', tabId, frameId, e);
      return false;
    }
  }
}

const engine = new TranslationEngine({
  fetchImpl: (...args) => fetch(...args),
  post: (requestId, msg) => {
    const meta = requestMeta.get(requestId);
    if (meta) void postToFrame(meta.tabId, meta.frameId, msg);
  },
  now: () => Date.now(),
});

const requestMeta = new Map<string, { tabId: number; frameId: number }>();

initDetection({
  onSource: (det) => void handleSource(det),
  onError: ({ tabId, frameId, url, message }) => {
    void postToFrame(tabId, frameId, {
      type: 'rusub:translations',
      requestId: `det:${url}`,
      entries: {},
      progress: { done: 0, total: 0 },
      status: 'error',
      error: `Обнаружены субтитры, но не удалось их загрузить: ${message}`,
    });
  },
  log,
});

async function handleSource(det: DetectedPlaylist): Promise<void> {
  const s = await getSettings();
  const host = await tabHost(det.tabId);
  const auto = s.autoTranslate && !!host && hostMatches(host, s.autoHosts);
  const requestId = `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  requestMeta.set(requestId, { tabId: det.tabId, frameId: det.frameId });

  const cuesMsg: CuesMessage = {
    type: 'rusub:cues',
    requestId,
    cues: det.source.cues.map((c, i) => ({ id: String(i), start: c.start, end: c.end, original: c.text })),
    totalDuration: det.source.totalDuration,
    sourceUrl: det.url,
    entryId: det.source.entryId,
    auto,
    targetLang: s.targetLang,
  };
  const delivered = await postToFrame(det.tabId, det.frameId, cuesMsg);
  if (!delivered) {
    log('[rusub] could not deliver cues to frame', det.tabId, det.frameId);
    return;
  }
  if (auto) {
    void engine.ensureTranslation({
      requestId,
      tabId: det.tabId,
      frameId: det.frameId,
      settings: s,
      items: cuesMsg.cues.map((c) => ({ id: c.id, text: c.original, start: c.start })),
    });
  }
}

// --- YouTube embeds ---------------------------------------------------------

/** tab:frame:videoId already delivered — avoids duplicate cue messages. */
const deliveredYoutube = new Set<string>();
/** videoIds for which the direct watch-page download already failed (pot required) */
const youtubeNoDirect = new Set<string>();
/** frames waiting for a player timedtext request (path B) */
const youtubePending = new Map<string, { tabId: number; frameId: number; videoId: string }>();

function ytKey(tabId: number, frameId: number, videoId: string): string {
  return `${tabId}:${frameId}:${videoId}`;
}

async function deliverYoutubeTranscript(tabId: number, frameId: number, tr: YoutubeTranscript): Promise<void> {
  const key = ytKey(tabId, frameId, tr.videoId);
  if (deliveredYoutube.has(key)) return;
  deliveredYoutube.add(key);
  youtubePending.delete(key);
  diag('diagBG', `yt:deliver ${tr.videoId} cues=${tr.cues.length} -> tab=${tabId} frame=${frameId}`);

  const s = await getSettings();
  const host = await tabHost(tabId);
  const auto = s.autoTranslate && !!host && hostMatches(host, s.autoHosts);
  const requestId = `yt:${tr.videoId}`;
  requestMeta.set(requestId, { tabId, frameId });
  const cuesMsg: CuesMessage = {
    type: 'rusub:cues',
    requestId,
    cues: tr.cues.map((c, i) => ({ id: String(i), start: c.start, end: c.end, original: c.text })),
    totalDuration: tr.totalDuration,
    sourceUrl: `https://www.youtube.com/watch?v=${tr.videoId}`,
    entryId: `yt:${tr.videoId}`,
    auto,
    targetLang: s.targetLang,
  };
  const delivered = await postToFrame(tabId, frameId, cuesMsg);
  if (!delivered) {
    diag('diagBG', `yt:deliver FAILED frame gone tab=${tabId} frame=${frameId}`);
    return;
  }
  log('[rusub] youtube captions:', tr.videoId, 'cues:', tr.cues.length);
  if (auto) {
    void engine.ensureTranslation({
      requestId,
      tabId,
      frameId,
      settings: s,
      items: cuesMsg.cues.map((c) => ({ id: c.id, text: c.original, start: c.start })),
    });
  }
}

/** Path B: the player itself requested timedtext (URL carries a valid pot token). */
function initYoutubeInterception(): void {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!details.url.includes('/api/timedtext')) return;
      const url = new URL(details.url);
      const videoId = url.searchParams.get('v');
      if (!videoId) return;
      diag('diagBG', `yt:B seen pot=${/[?&]pot=/.test(details.url) ? 'yes' : 'no'} tab=${details.tabId} frame=${details.frameId} ${url.searchParams.get('fmt') ?? 'nofmt'}`);
      // exact frame first, then any frame of that tab (the player may issue the
      // request from a nested frame)
      const matches = [...youtubePending.values()].filter(
        (p) => p.tabId === details.tabId && p.videoId === videoId && !deliveredYoutube.has(ytKey(p.tabId, p.frameId, p.videoId)),
      );
      const pending = matches.find((p) => p.frameId === details.frameId) ?? matches[0];
      if (!pending) return;
      void fetchTimedTextUrl(details.url, videoId).then((tr) => {
        if (tr) void deliverYoutubeTranscript(pending.tabId, pending.frameId, tr);
        else diag('diagBG', 'yt:B no cues from observed url');
      });
    },
    { urls: ['*://*.youtube.com/api/timedtext*', '*://*.youtube-nocookie.com/api/timedtext*'] },
  );
}

initYoutubeInterception();

async function handleYoutubeRequest(msg: YoutubeCuesRequestMessage, tabId: number, frameId: number): Promise<void> {
  const key = ytKey(tabId, frameId, msg.videoId);
  if (deliveredYoutube.has(key)) return;
  if (!youtubeNoDirect.has(msg.videoId)) {
    const direct = await fetchYoutubeTranscript(msg.videoId);
    if (direct.ok) {
      await deliverYoutubeTranscript(tabId, frameId, direct.transcript);
      return;
    }
    youtubeNoDirect.add(msg.videoId);
    diag('diagBG', `yt:A failed reason=${direct.reason} -> path B`);
  }
  // ask the page to toggle the player's CC so we can observe its timedtext call
  youtubePending.set(key, { tabId, frameId, videoId: msg.videoId });
  const posted = await postToFrame(tabId, frameId, { type: 'rusub:youtubeEnableCc', videoId: msg.videoId });
  diag('diagBG', `yt:pending tab=${tabId} frame=${frameId} video=${msg.videoId} enableCcPosted=${posted}`);
}

chrome.runtime.onMessage.addListener((msg: ContentMessage, sender, sendResponse) => {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  if (typeof tabId !== 'number') return;

  switch (msg.type) {
    case 'rusub:openOptions':
      void chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return true;
    case 'rusub:timeUpdate':
      engine.setVideoTime(msg.requestId, msg.time);
      break;
    case 'rusub:cancel':
      engine.cancel(msg.requestId);
      requestMeta.delete(msg.requestId);
      break;
    case 'rusub:ensureTranslation':
      requestMeta.set(msg.requestId, { tabId, frameId });
      void getSettings().then((s) =>
        engine.ensureTranslation({
          requestId: msg.requestId,
          tabId,
          frameId,
          settings: s,
          items: msg.items,
        }),
      );
      sendResponse({ ok: true });
      return true;
    case 'rusub:youtubeCues': {
      const ytMsg = msg as YoutubeCuesRequestMessage;
      requestMeta.set(`yt:${ytMsg.videoId}`, { tabId, frameId });
      void handleYoutubeRequest(ytMsg, tabId, frameId);
      sendResponse({ ok: true });
      return true;
    }
    case 'rusub:guideRequest': {
      const guideMsg = msg as GuideRequestMessage;
      requestMeta.set(guideMsg.requestId, { tabId, frameId });
      void getSettings().then((s) =>
        handleGuideRequest({
          requestId: guideMsg.requestId,
          cues: guideMsg.cues,
          entryId: guideMsg.entryId ?? null,
          force: guideMsg.force,
          settings: s,
          post: (m) => void postToFrame(tabId, frameId, m),
        }),
      );
      sendResponse({ ok: true });
      return true;
    }
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

void getSettings().then((s) => {
  configureLlmQueue(s.concurrency);
  log('[rusub] service worker started; endpoint:', s.endpoint, 'model:', s.model || '(default)');
});
