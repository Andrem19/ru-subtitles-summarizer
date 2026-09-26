/**
 * The "send to Hub" export (ENG-204, Learning RH-06).
 *
 * Builds the study-guide document the Hub ingests (`POST /learning/guides`)
 * from what the panel already holds: the guide markdown, the transcript and the
 * page's own facts. The export is a plain JSON *file* — the extension holds no
 * Hub credential; the file travels through the PWA, which owns the session.
 * The guide goes as markdown, as the generator wrote it — parsing it back into
 * fields would be a lossy second opinion.
 */
import { sha256HexFor } from './hash';
import { transcriptToLines, type TranscriptLine } from './studyguide';

export interface GuideExportInput {
  /** The guide as the generator produced it (markdown). */
  markdown: string;
  /** The transcript the guide was built from, in order. */
  cues: TranscriptLine[];
  /** The page the video lives on. */
  videoUrl: string;
  /** The page/video title, as the browser sees it. */
  title: string;
  /** Language of the source transcript, e.g. "en". */
  language: string;
  /** The extension's own version; provenance, not identity. */
  generatorVersion: string;
  /** The model that produced the summary, when settings name one. */
  model?: string;
}

/** The Hub's ingestion id derives from these two: same transcript + generator = one guide. */
export async function guideIdentity(transcriptHash: string, generatorVersion: string): Promise<string> {
  return `sg-${(await sha256HexFor(transcriptHash + '\u0000' + generatorVersion)).slice(0, 12)}`;
}

/** Builds the JSON file the user saves and imports in the PWA. */
export async function buildGuideExport(input: GuideExportInput): Promise<{ json: string; entityId: string; filename: string }> {
  const transcript = transcriptToLines(input.cues);
  const transcriptHash = await sha256HexFor(transcript);
  const document = {
    videoUrl: input.videoUrl,
    title: input.title,
    language: input.language,
    ...(input.model === undefined ? {} : { model: input.model }),
    guideMarkdown: input.markdown,
    generatedAt: new Date().toISOString(),
    generatorVersion: input.generatorVersion,
  };
  const json = JSON.stringify(
    {
      document,
      transcriptHash,
      transcriptExcerpt: transcript.slice(0, 2000),
    },
    null,
    2,
  );
  return {
    json,
    entityId: await guideIdentity(transcriptHash, input.generatorVersion),
    filename: `study-guide-${transcriptHash.slice(0, 12)}.json`,
  };
}
