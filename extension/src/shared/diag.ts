// Lightweight diagnostics: a bounded ring buffer per key, flushed to
// chrome.storage.local. Written by both the service worker and content
// scripts so a live session can be inspected without DevTools.

const buffers = new Map<string, string[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const MAX_LINES = 80;

export function diag(key: string, msg: string): void {
  const buf = buffers.get(key) ?? [];
  buf.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
  buffers.set(key, buf);
  if (timers.has(key)) return;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      try {
        void chrome.storage.local.set({ [key]: [...(buffers.get(key) ?? [])] });
      } catch {
        /* extension context gone (reload) */
      }
    }, 250),
  );
}

export function diagNow(key: string): string[] {
  return [...(buffers.get(key) ?? [])];
}
