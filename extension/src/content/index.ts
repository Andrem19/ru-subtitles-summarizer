// Content script: associates detected captions with <video>, injects Russian
// TextTrack (or overlay), renders the RU chip, reports playback position.

import { chooseVideoIndex, type VideoCandidate } from './assoc';
import { SubtitleOverlay } from './overlay';
import { StudyPanel } from './studyPanel';
import {
  ensureTrack,
  makeCue,
  restoreNativeCaptions,
  suppressNativeCaptions,
  type SuppressedRecord,
  type TrackBundle,
} from './tracks';
import { GuideButton, SubtitleChip } from './ui';
import { loadUiSettings, type UiSettings } from '../shared/settings';
import { diag } from '../shared/diag';
import type { Cue, DisplayMode, TranslationsMessage } from '../shared/types';

declare const window: Window & { __rusubLoaded?: boolean };
if (window.__rusubLoaded) {
  // already injected in this frame (programmatic re-injection)
} else {
  window.__rusubLoaded = true;
  main();
}

type JobUiStatus = 'idle' | 'loading' | 'translating' | 'done' | 'partial' | 'error';

interface CaptionState {
  requestId: string;
  cues: Cue[];
  /** stable Kaltura entry id — primary study-guide cache key */
  entryId: string | null;
  cueToItem: Map<string, string>;
  itemText: Map<string, string>;
  itemStart: Map<string, number | null>;
  ru: Map<string, string>;
  status: JobUiStatus;
  error?: string;
  auto: boolean;
  settings: UiSettings;
  video: HTMLVideoElement | null;
  bundle: TrackBundle | null;
  container: HTMLElement | null;
  chip: SubtitleChip | null;
  guideBtn: GuideButton | null;
  /** row holding chip + guide button (created once per container) */
  controls: HTMLElement | null;
  controlsObserver: ResizeObserver | null;
  /** document-level layer that hosts all our UI, pinned over the player box */
  layer: HTMLElement | null;
  layerObserver: ResizeObserver | null;
  panel: StudyPanel | null;
  overlay: SubtitleOverlay;
  mode: DisplayMode;
  display: 'texttrack' | 'overlay';
  suppressed: SuppressedRecord[];
  lastReport: number;
  suppressTimer: ReturnType<typeof setInterval> | null;
  cueListByStart: Cue[];
}

const states = new Map<string, CaptionState>();

/** YouTube embed frame state (this script instance lives inside the player). */
let ytVideoId: string | null = null;
let ytAttempts = 0;
let ytHaveCues = false;
let ytRetryTimer: ReturnType<typeof setInterval> | null = null;

async function main(): Promise<void> {
  const settings = await loadUiSettings(chrome.storage.local);

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, _sendResponse) => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: string };
    if (m.type === 'rusub:cues') {
      void handleCues(msg as unknown as Parameters<typeof handleCues>[0]);
    } else if (m.type === 'rusub:translations') {
      handleTranslations(msg as unknown as TranslationsMessage);
    } else if (m.type === 'rusub:youtubeEnableCc') {
      const y = msg as { videoId: string };
      void enableYoutubeCcThenRestore(y.videoId);
    } else if (m.type === 'rusub:guide') {
      const g = msg as { requestId: string; status: 'generating' | 'ready' | 'error'; markdown?: string; error?: string };
      const st = states.get(g.requestId);
      if (!st) return;
      if (g.status === 'generating') {
        st.guideBtn?.setBusy(true);
        st.panel?.setGenerating();
      } else if (g.status === 'ready' && g.markdown) {
        st.guideBtn?.setBusy(false);
        st.panel?.setReady(g.markdown);
      } else if (g.status === 'error') {
        st.guideBtn?.setBusy(false);
        st.panel?.setError(g.error ?? 'Не удалось подготовить конспект.');
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['settings']) return;
    void loadUiSettings(chrome.storage.local).then((s) => {
      for (const st of states.values()) {
        st.settings = s;
        st.display = s.display;
        st.overlay.setFontSize(s.fontSize);
        st.panel?.setFontSize(s.guideFontSize);
        if (st.status === 'idle') {
          // allow newly-changed default mode to apply before translation starts
          setMode(st, st.auto ? s.defaultMode : st.mode);
        } else {
          applyDisplay(st);
          if (st.display === 'overlay') renderOverlay(st);
        }
      }
    });
  });

  document.addEventListener('fullscreenchange', () => {
    for (const st of states.values()) {
      if (st.video?.isConnected) {
        const container = findContainer(st.video);
        if (container !== st.container) attachVisuals(st, container);
        else if (st.layer && st.container) fitLayer(st.layer, st.container);
      }
    }
  });

  window.addEventListener('resize', () => {
    for (const st of states.values()) if (st.layer && st.container) fitLayer(st.layer, st.container);
  });

  // keep the layer glued to the player while the page scrolls (inline players)
  window.addEventListener(
    'scroll',
    () => {
      for (const st of states.values()) if (st.layer && st.container) fitLayer(st.layer, st.container);
    },
    { passive: true, capture: true },
  );

  // discovery loop: attach pending states to videos as they appear
  setInterval(() => {
    for (const st of states.values()) {
      if (!st.video || !st.video.isConnected) {
        if (st.video) detachVideo(st);
        void tryAttach(st);
      } else if (st.layer && st.container) {
        // the player box moves with page layout, scrolling and zoom
        fitLayer(st.layer, st.container);
      }
    }
  }, 1500);

  // playback-position reports + overlay refresh
  setInterval(() => {
    for (const st of states.values()) {
      if (st.video && st.mode !== 'off') reportTime(st, true);
      if (st.display === 'overlay' && st.video) renderOverlay(st);
    }
  }, 250);

  // self-healing: if translations are incomplete and the engine went quiet
  // (service worker restart), ask background to continue.
  setInterval(() => {
    for (const st of states.values()) {
      if (st.status === 'translating' && st.ru.size < st.itemText.size) {
        void ensureTranslation(st);
      }
    }
  }, 30_000);

  void initYoutubeEmbed();
  void settings;
}

/** True inside a YouTube player iframe (…/embed/VIDEOID). */
function youtubeEmbedVideoId(): string | null {
  const host = location.hostname;
  const isYoutube = /(^|\.)youtube\.com$/.test(host) || /(^|\.)youtube-nocookie\.com$/.test(host);
  if (!isYoutube) return null;
  const embed = /^\/embed\/([A-Za-z0-9_-]{6,})/.exec(location.pathname);
  if (embed) return embed[1];
  const v = new URLSearchParams(location.search).get('v');
  return v && /^[A-Za-z0-9_-]{6,}$/.test(v) ? v : null;
}

async function initYoutubeEmbed(): Promise<void> {
  const videoId = youtubeEmbedVideoId();
  if (!videoId) return;
  ytVideoId = videoId;
  diag('diagCS', `yt:init ${videoId} state=${document.readyState}`);
  // the player only issues its own timedtext request once playback (or the CC
  // toggle) reaches a live media element — retry while we still have no cues
  document.addEventListener(
    'play',
    () => {
      if (ytHaveCues) return;
      ytAttempts = 0; // playback makes a fresh batch of attempts worthwhile
      void requestYoutubeCues('play');
    },
    true,
  );
  await requestYoutubeCues('init');
  ytRetryTimer = setInterval(() => {
    if (ytHaveCues) {
      if (ytRetryTimer) clearInterval(ytRetryTimer);
      ytRetryTimer = null;
      return;
    }
    void requestYoutubeCues('retry');
  }, 8000);
}

async function requestYoutubeCues(why: string): Promise<void> {
  if (!ytVideoId || ytHaveCues) return;
  if (ytAttempts >= 12) {
    diag('diagCS', `yt:give up after ${ytAttempts} attempts`);
    if (ytRetryTimer) clearInterval(ytRetryTimer);
    ytRetryTimer = null;
    return;
  }
  ytAttempts++;
  try {
    await chrome.runtime.sendMessage({ type: 'rusub:youtubeCues', videoId: ytVideoId });
    diag('diagCS', `yt:request #${ytAttempts} (${why}) sent`);
  } catch (e) {
    diag('diagCS', `yt:request #${ytAttempts} (${why}) failed: ${String((e as Error)?.message ?? e)}`);
  }
}

/**
 * Path B: briefly toggle the player's own CC button so it issues a timedtext
 * request (with a valid proof-of-origin token) that the background observes;
 * then restore the original CC state.
 */
async function enableYoutubeCcThenRestore(videoId: string): Promise<void> {
  if (ytHaveCues) return; // captions already fetched — nothing to nudge
  if (youtubeEmbedVideoId() !== videoId) {
    diag('diagCS', `yt:cc ignored (frame is ${youtubeEmbedVideoId() ?? 'not-embed'})`);
    return;
  }
  diag('diagCS', 'yt:cc start');
  // wait for the player UI to exist
  for (let i = 0; i < 40 && !document.querySelector('.ytp-subtitles-button'); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const btn = document.querySelector('.ytp-subtitles-button') as HTMLElement | null;
  if (!btn) {
    // the player UI is not ready yet: let the periodic retry try again later
    diag('diagCS', 'yt:cc no .ytp-subtitles-button (retry via timer)');
    return;
  }
const wasOn = btn.getAttribute('aria-pressed') === 'true';
const label = btn.getAttribute('aria-label');
if (wasOn) {
  // captions are already on: the player has (or will) request the track itself
  diag('diagCS', 'yt:cc already on — not toggling');
  return;
}
btn.click();
diag('diagCS', `yt:cc clicked label=${label ?? '-'}`);
  // give the player time to request the captions; if a language menu opened,
  // pick the first entry so a track actually loads
  await new Promise((r) => setTimeout(r, 2500));
  const menuItem = document.querySelector('.ytp-panel-menu .ytp-menuitem') as HTMLElement | null;
  if (menuItem) {
    menuItem.click();
    diag('diagCS', 'yt:cc picked first language menu item');
  }
  await new Promise((r) => setTimeout(r, 4000));
  // restore the original CC state (it was off before we clicked)
  const after = document.querySelector('.ytp-subtitles-button') as HTMLElement | null;
  if (after?.getAttribute('aria-pressed') === 'true') {
    after.click();
    diag('diagCS', 'yt:cc restored off');
  }
  if (!ytHaveCues && ytAttempts < 12) void requestYoutubeCues('after-cc');
}

function uniqueItems(cues: Cue[]): {
  cueToItem: Map<string, string>;
  itemText: Map<string, string>;
  itemStart: Map<string, number | null>;
} {
  const cueToItem = new Map<string, string>();
  const itemText = new Map<string, string>();
  const itemStart = new Map<string, number | null>();
  const byText = new Map<string, string>();
  for (const cue of cues) {
    let id = byText.get(cue.original);
    if (!id) {
      id = `u${byText.size}`;
      byText.set(cue.original, id);
      itemText.set(id, cue.original);
      itemStart.set(id, cue.start);
    }
    const prev = itemStart.get(id);
    if (prev === null || prev === undefined || cue.start < prev) itemStart.set(id, cue.start);
    cueToItem.set(cue.id, id);
  }
  return { cueToItem, itemText, itemStart };
}

async function handleCues(msg: {
  type: 'rusub:cues';
  requestId: string;
  cues: Cue[];
  totalDuration: number;
  sourceUrl: string;
  entryId: string | null;
  auto: boolean;
}): Promise<void> {
  if (states.has(msg.requestId)) return;
  if (!msg.cues.length) return;
  if (msg.requestId.startsWith('yt:')) {
    ytHaveCues = true;
    diag('diagCS', `yt:cues received ${msg.cues.length}`);
  }
  const settings = await loadUiSettings(chrome.storage.local);
  const { cueToItem, itemText, itemStart } = uniqueItems(msg.cues);
  const st: CaptionState = {
    requestId: msg.requestId,
    cues: msg.cues,
    entryId: msg.entryId ?? null,
    cueToItem,
    itemText,
    itemStart,
    ru: new Map(),
    status: msg.auto ? 'translating' : 'idle',
    auto: msg.auto,
    settings,
    video: null,
    bundle: null,
    container: null,
    chip: null,
    guideBtn: null,
    controls: null,
    controlsObserver: null,
    layer: null,
    layerObserver: null,
    panel: null,
    overlay: new SubtitleOverlay(),
    mode: msg.auto ? settings.defaultMode : 'off',
    display: settings.display,
    suppressed: [],
    lastReport: 0,
    suppressTimer: null,
    cueListByStart: [...msg.cues].sort((a, b) => a.start - b.start),
  };
  states.set(msg.requestId, st);
  st.overlay.setFontSize(settings.fontSize);
  await tryAttach(st);
  if (st.auto) void ensureTranslation(st);
}

function videosInFrame(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
}

async function tryAttach(st: CaptionState): Promise<void> {
  if (st.video?.isConnected) return;
  const vids = videosInFrame().filter((v) => v.isConnected);
  if (vids.length === 0) return;
  const candidates: VideoCandidate[] = vids.map((v) => {
    const d = v.duration;
    let claimedBy: string | null = null;
    for (const other of states.values()) {
      if (other.video === v && other.requestId !== st.requestId) claimedBy = other.requestId;
    }
    return { duration: Number.isFinite(d) && d > 0 ? d : null, playing: !v.paused && !v.ended, claimedBy };
  });
  const idx = chooseVideoIndex(candidates, { totalDuration: totalDurationOf(st), requestId: st.requestId });
  const video = vids[idx];
  if (!video) return;
  st.video = video;
  attachVisuals(st, findContainer(video));
  video.addEventListener('timeupdate', onTimeUpdate(st));
  video.addEventListener('seeked', onTimeUpdate(st));
  video.addEventListener('play', onTimeUpdate(st));
  rebuildTrack(st);
  applyMode(st);
}

function totalDurationOf(st: CaptionState): number {
  const last = st.cueListByStart[st.cueListByStart.length - 1];
  return last ? last.end : 0;
}

function onTimeUpdate(st: CaptionState) {
  return () => reportTime(st, false);
}

function reportTime(st: CaptionState, force: boolean): void {
  if (!st.video) return;
  const now = Date.now();
  if (!force && now - st.lastReport < 2000) return;
  st.lastReport = now;
  try {
    // throws synchronously with "Extension context invalidated" after a reload
    void chrome.runtime
      .sendMessage({ type: 'rusub:timeUpdate', requestId: st.requestId, time: st.video.currentTime })
      .catch(() => {});
  } catch {
    /* extension reloaded — this script instance is orphaned */
  }
}

function findContainer(video: HTMLVideoElement): HTMLElement {
  const vr = video.getBoundingClientRect();
  let el: HTMLElement | null = video.parentElement;
  let fallback: HTMLElement = video.parentElement ?? video;
  while (el && el !== document.body && el !== document.documentElement) {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (
      (st.position === 'relative' || st.position === 'absolute' || st.position === 'fixed') &&
      r.width >= vr.width * 0.95 &&
      r.height >= vr.height * 0.9
    ) {
      return el;
    }
    el = el.parentElement;
  }
  if (fallback !== video && getComputedStyle(fallback).position === 'static') {
    fallback.style.position = 'relative';
  }
  return fallback;
}

/**
 * Our overlay layer: a fixed, full-player-positioned box that lives directly in
 * the frame's <body>. Everything we draw goes in here, so no layer of the
 * player (gradients, control bars, click surfaces) can sit above our buttons
 * and swallow clicks — which is what happens when our elements are children of
 * the player's own DOM, however large their z-index.
 */
function makeLayer(st: CaptionState, anchor: HTMLElement): HTMLElement {
  let layer = st.layer;
  if (!layer || !layer.isConnected) {
    const doc = anchor.ownerDocument;
    layer = doc.createElement('div');
    layer.className = 'rusub-layer';
    (doc.body ?? doc.documentElement).appendChild(layer);
    st.layer = layer;
    scheduleFit(layer, anchor);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => fitLayer(layer as HTMLElement, anchor));
      ro.observe(anchor);
      st.layerObserver?.disconnect();
      st.layerObserver = ro;
    }
  }
  return layer;
}

function makeControls(st: CaptionState, layer: HTMLElement): HTMLElement {
  let cluster = st.controls;
  if (!cluster || !cluster.isConnected) {
    cluster = layer.ownerDocument.createElement('div');
    cluster.className = 'rusub-controls';
    layer.appendChild(cluster);
    st.controls = cluster;
  }
  return cluster;
}

/**
 * Pins the layer to the player's box. Only the geometry is copied, so the layer
 * tracks scroll, resize and fullscreen transitions.
 */
function fitLayer(layer: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const visible = r.width > 0 && r.height > 0;
  layer.style.display = visible ? '' : 'none';
  if (!visible) return;
  layer.style.left = `${Math.round(r.left)}px`;
  layer.style.top = `${Math.round(r.top)}px`;
  layer.style.width = `${Math.round(r.width)}px`;
  layer.style.height = `${Math.round(r.height)}px`;
  const box = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
  if (box === lastLayerBox) return; // log geometry only when it actually moves
  lastLayerBox = box;
  try {
    const row = layer.querySelector('.rusub-controls');
    const rowRect = row?.getBoundingClientRect();
    const mid = rowRect
      ? { x: Math.round(rowRect.left + rowRect.width / 2), y: Math.round(rowRect.top + rowRect.height / 2) }
      : null;
    const top = mid ? layer.ownerDocument.elementFromPoint(mid.x, mid.y) : null;
    diag(
      'diagCS',
      `fit anchor=${anchor.id || anchor.className || anchor.tagName} box=${box}` +
        (mid ? ` topEl=${top ? `${top.tagName}.${String(top.className).slice(0, 30)}` : 'null'}` : ''),
    );
  } catch {
    /* diagnostics only */
  }
}

let lastLayerBox = '';

/** The player box can change any time (layout, fullscreen) — re-fit a few times. */
function scheduleFit(layer: HTMLElement, anchor: HTMLElement): void {
  for (const delay of [0, 300, 1000, 2500]) {
    setTimeout(() => {
      if (layer.isConnected) fitLayer(layer, anchor);
    }, delay);
  }
}

function attachVisuals(st: CaptionState, container: HTMLElement): void {
  st.container = container;
  st.overlay.attach(container);
  if (!st.chip) {
    const layer = makeLayer(st, container);
    const cluster = makeControls(st, layer);
    st.chip = new SubtitleChip(layer, {
      onCycle: () => {
        const order: DisplayMode[] = ['off', 'ru', 'bi'];
        const next = order[(order.indexOf(st.mode) + 1) % order.length];
        setMode(st, next);
        if (next !== 'off' && st.ru.size < st.itemText.size) void ensureTranslation(st);
      },
      onSetMode: (mode) => {
        setMode(st, mode);
        if (mode !== 'off' && st.ru.size < st.itemText.size) void ensureTranslation(st);
      },
      onRetry: () => {
        st.chip?.hideToast();
        st.status = st.ru.size < st.itemText.size ? 'translating' : 'done';
        updateChipStatus(st);
        void ensureTranslation(st);
      },
      onOpenOptions: () => {
        try {
          void chrome.runtime.sendMessage({ type: 'rusub:openOptions' }).catch(() => {});
        } catch {
          /* orphaned content script */
        }
      },
    }, cluster);
    st.chip.setMode(st.mode);
    updateChipStatus(st);
    st.guideBtn = new GuideButton(layer, () => toggleGuide(st), cluster);
    st.panel = new StudyPanel(layer, {
      onClose: () => {
        st.panel?.close();
      },
      onRegenerate: () => {
        st.panel?.setGenerating();
        st.guideBtn?.setBusy(true);
        void requestGuide(st, true);
      },
    });
    st.panel.setFontSize(st.settings.guideFontSize);
  } else {
    // reparent on container change (fullscreen)
    st.chip.destroy();
    st.chip = null;
    st.guideBtn?.destroy();
    st.guideBtn = null;
    st.panel?.destroy();
    st.panel = null;
    attachVisuals(st, container);
  }
}

/** Opens/closes the study panel; sends a guide request when opening. */
function toggleGuide(st: CaptionState): void {
  if (st.panel?.isOpen()) {
    st.panel.close();
    return;
  }
  st.panel?.open();
  st.panel?.setGenerating();
  void requestGuide(st, false);
}

async function requestGuide(st: CaptionState, force: boolean): Promise<void> {
  st.guideBtn?.setBusy(true);
  const cues = st.cues.map((c) => ({ start: c.start, text: c.original }));
  try {
    await chrome.runtime.sendMessage({
      type: 'rusub:guideRequest',
      requestId: st.requestId,
      cues,
      entryId: st.entryId,
      force,
    });
  } catch {
    st.guideBtn?.setBusy(false);
    st.panel?.setError('Расширение было перезагружено. Обновите страницу и попробуйте снова.');
  }
}

function rebuildTrack(st: CaptionState): void {
  if (!st.video) return;
  const bundle = ensureTrack(st.video, st.requestId);
  st.bundle = bundle;
  for (const cue of st.cues) makeCue(bundle, cue.id, cue.start, cue.end);
  applyDisplay(st);
}

function cueText(st: CaptionState, cue: Cue): string {
  const itemId = st.cueToItem.get(cue.id);
  const ru = itemId ? st.ru.get(itemId) : undefined;
  if (st.mode === 'bi') {
    return ru ? `${cue.original}\n${ru}` : cue.original;
  }
  return ru ?? '';
}

function updateAllCueTexts(st: CaptionState): void {
  if (!st.bundle) return;
  for (const cue of st.cues) {
    const vttCue = st.bundle.cues.get(cue.id);
    if (vttCue) vttCue.text = cueText(st, cue);
  }
}

function applyDisplay(st: CaptionState): void {
  if (!st.bundle) return;
  const wantTrack = st.display === 'texttrack' && st.mode !== 'off';
  st.bundle.track.mode = wantTrack ? 'showing' : 'disabled';
}

function applyMode(st: CaptionState): void {
  applyDisplay(st);
  st.chip?.setMode(st.mode);
  if (st.mode === 'off') {
    restoreNativeCaptions(st.suppressed);
    st.suppressed = [];
    if (st.suppressTimer) {
      clearInterval(st.suppressTimer);
      st.suppressTimer = null;
    }
  } else if (!st.suppressTimer) {
    st.suppressTimer = setInterval(() => {
      if (!st.video) return;
      st.suppressed.push(...suppressNativeCaptions(st.video, st.requestId));
    }, 3000);
    if (st.video) st.suppressed.push(...suppressNativeCaptions(st.video, st.requestId));
  }
  if (st.display === 'overlay') renderOverlay(st);
  else st.overlay.render(null);
}

function setMode(st: CaptionState, mode: DisplayMode): void {
  st.mode = mode;
  updateAllCueTexts(st);
  applyMode(st);
  if (mode !== 'off') updateChipStatus(st);
}

function renderOverlay(st: CaptionState): void {
  if (!st.video) return;
  if (st.mode === 'off') {
    st.overlay.render(null);
    return;
  }
  const t = st.video.currentTime;
  const cue = st.cueListByStart.find((c) => t >= c.start && t <= c.end) ?? null;
  st.overlay.render(cue ? cueText(st, cue) || null : null);
}

async function ensureTranslation(st: CaptionState): Promise<void> {
  const items = Array.from(st.itemText.entries()).map(([id, text]) => ({
    id,
    text,
    start: st.itemStart.get(id) ?? null,
  }));
  try {
    await chrome.runtime.sendMessage({
      type: 'rusub:ensureTranslation',
      requestId: st.requestId,
      items,
    });
  } catch {
    /* extension context gone (reload) — nothing to do */
  }
}

function handleTranslations(msg: TranslationsMessage): void {
  const st = states.get(msg.requestId);
  if (!st) {
    if (msg.error) {
      // detection or global error without attached state: surface once
      console.warn('[rusub]', msg.error);
    }
    return;
  }
  for (const [itemId, text] of Object.entries(msg.entries)) {
    st.ru.set(itemId, text);
  }
  updateAllCueTexts(st);
  if (msg.status) st.status = msg.status as JobUiStatus;
  if (msg.error) st.error = msg.error;
  else if (st.status !== 'partial') st.error = undefined;
  if (st.display === 'overlay') renderOverlay(st);
  updateChipStatus(st);
  if (msg.error && (msg.status === 'error' || msg.status === 'partial')) {
    st.chip?.showError(msg.error);
  } else if (st.status === 'done') {
    st.chip?.hideToast();
  }
}

function updateChipStatus(st: CaptionState): void {
  if (!st.chip) return;
  const total = st.itemText.size;
  const done = st.ru.size;
  if (st.status === 'error') {
    st.chip.setState('error', st.error ?? 'ошибка');
    return;
  }
  if (total === 0 || (st.status === 'done' && done >= total) || st.status === 'done') {
    st.chip.setState('active');
    return;
  }
  if (st.status === 'partial') {
    st.chip.setState('error', `${done}/${total}`);
    return;
  }
  if (st.status === 'translating') {
    st.chip.setState('busy', total > 0 ? `${Math.min(99, Math.round((done / total) * 100))}%` : '…');
    return;
  }
  if (st.status === 'loading' || st.status === 'idle') {
    st.chip.setState('idle');
    return;
  }
  st.chip.setState(done >= total ? 'active' : 'idle');
}

function detachVideo(st: CaptionState): void {
  restoreNativeCaptions(st.suppressed);
  st.suppressed = [];
  if (st.suppressTimer) {
    clearInterval(st.suppressTimer);
    st.suppressTimer = null;
  }
  if (st.video) {
    st.bundle = null;
    st.video = null;
  }
  if (st.container) {
    st.overlay.detach();
    st.container = null;
  }
  st.panel?.destroy();
  st.panel = null;
  st.guideBtn?.destroy();
  st.guideBtn = null;
  // chip and the controls row are destroyed together with the container
  st.chip = null;
  st.controlsObserver?.disconnect();
  st.controlsObserver = null;
  st.controls?.remove();
  st.controls = null;
  st.layerObserver?.disconnect();
  st.layerObserver = null;
  st.layer?.remove();
  st.layer = null;
}
