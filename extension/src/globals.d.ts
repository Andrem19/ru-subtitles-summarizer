// Global DOM augmentations.

declare global {
  interface HTMLVideoElement {
    /** our synthetic TextTracks, keyed by caption requestId */
    __rusubTracks?: Map<string, import('./content/tracks').TrackBundle>;
  }
}

export {};
