// Video <-> caption-set association logic (pure, unit-tested).

export interface VideoCandidate {
  /** video.duration or null when metadata not loaded yet */
  duration: number | null;
  playing: boolean;
  /** requestId that already claimed this video */
  claimedBy: string | null;
}

export interface ChooseOptions {
  totalDuration: number;
  requestId: string;
}

/**
 * Picks the best video for a caption playlist:
 * 1. prefer duration match (within tolerance of the EXTINF sum);
 * 2. prefer unclaimed videos over already-claimed ones;
 * 3. prefer currently playing videos;
 * 4. fall back to DOM order.
 */
export function chooseVideoIndex(candidates: VideoCandidate[], opts: ChooseOptions): number {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return 0;

  const scores = candidates.map((c, i) => {
    let durationScore: number;
    if (c.duration !== null && Number.isFinite(c.duration) && c.duration > 0 && opts.totalDuration > 0) {
      durationScore = Math.abs(c.duration - opts.totalDuration);
    } else {
      durationScore = Number.POSITIVE_INFINITY;
    }
    const claimScore = c.claimedBy === opts.requestId ? -1 : c.claimedBy ? 1 : 0;
    const playScore = c.playing ? 0 : 1;
    return { i, durationScore, claimScore, playScore };
  });

  const finite = scores.filter((s) => Number.isFinite(s.durationScore));
  if (finite.length > 0) {
    const best = Math.min(...finite.map((s) => s.durationScore));
    const tolerance = Math.max(opts.totalDuration * 0.15, 5);
    const within = finite.filter((s) => s.durationScore - best <= tolerance);
    within.sort(
      (a, b) => a.claimScore - b.claimScore || a.playScore - b.playScore || a.durationScore - b.durationScore || a.i - b.i,
    );
    return within[0].i;
  }

  // no durations known anywhere: unclaimed > playing > first
  scores.sort((a, b) => a.claimScore - b.claimScore || a.playScore - b.playScore || a.i - b.i);
  return scores[0].i;
}
