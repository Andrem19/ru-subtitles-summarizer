// Batching of unique texts for context-aware translation.

import type { TranslateItem } from './types';

export interface Batch {
  index: number;
  items: TranslateItem[];
  /** earliest cue start among the texts in this batch (for playback-position priority); null if unknown */
  startTime: number | null;
}

export interface BatchingOptions {
  maxItems: number;
  maxChars: number;
}

export const DEFAULT_BATCHING: BatchingOptions = { maxItems: 40, maxChars: 3500 };

export interface WeightedItem extends TranslateItem {
  start: number | null;
}

/**
 * Groups items in transcript order. A batch closes when either maxItems or maxChars
 * (sum of text lengths + fixed per-item overhead) is reached.
 */
export function buildBatches(items: WeightedItem[], opts: BatchingOptions = DEFAULT_BATCHING): Batch[] {
  const maxItems = Math.max(1, Math.floor(opts.maxItems));
  const maxChars = Math.max(50, Math.floor(opts.maxChars));
  const batches: Batch[] = [];
  let current: WeightedItem[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const starts = current.map((i) => i.start).filter((s): s is number => s !== null);
    batches.push({
      index: batches.length,
      items: current.map(({ id, text }) => ({ id, text })),
      startTime: starts.length ? Math.min(...starts) : null,
    });
    current = [];
    chars = 0;
  };

  for (const item of items) {
    const cost = item.text.length + 12;
    if (current.length >= maxItems || chars + cost > maxChars) {
      flush();
    }
    current.push(item);
    chars += cost;
  }
  flush();
  return batches;
}

/** Splits a batch into two halves (for retry-after-failure). */
export function splitBatch(batch: Batch): [Batch, Batch] {
  const mid = Math.ceil(batch.items.length / 2);
  const mk = (items: TranslateItem[], index: number): Batch => ({ index, items, startTime: batch.startTime });
  return [mk(batch.items.slice(0, mid), batch.index), mk(batch.items.slice(mid), batch.index + 0.5)];
}
