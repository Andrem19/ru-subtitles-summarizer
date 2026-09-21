// Global LLM request gate: ALL provider calls (translation batches, study
// guides) go through this queue so we never exceed the provider's
// concurrency/rate limits (Z.ai Coding Plan returns 429/1302 on bursts).

type Task<T> = () => Promise<T>;

let maxConcurrent = 2;
let minGapMs = 900;
let active = 0;
let lastStart = 0;
const queue: Array<() => void> = [];

/** Applies settings.concurrency as the GLOBAL cap across all jobs. */
export function configureLlmQueue(concurrency: number, gapMs = 900): void {
  maxConcurrent = Math.max(1, Math.min(6, Math.round(concurrency) || 2));
  minGapMs = Math.max(0, gapMs);
  pump();
}

function pump(): void {
  while (active < maxConcurrent && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    active++;
    const wait = Math.max(0, lastStart + minGapMs - Date.now());
    setTimeout(() => {
      lastStart = Date.now();
      try {
        next();
      } finally {
        active--;
        pump();
      }
    }, wait);
  }
}

/** Runs `task` when a slot frees up; starts are spaced by minGapMs. */
export function runLlm<T>(task: Task<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      task().then(resolve, reject);
    });
    pump();
  });
}
