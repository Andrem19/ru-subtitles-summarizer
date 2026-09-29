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

/** Bumped only for a breaking change to the file shape; import refuses newer. */
export const GUIDE_EXPORT_SCHEMA_VERSION = 1;

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
      schemaVersion: GUIDE_EXPORT_SCHEMA_VERSION,
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

export type GuideExportParseResult =
  | { ok: true; value: { schemaVersion: number; document: Record<string, unknown>; transcriptHash: string; transcriptExcerpt: string } }
  | { ok: false; errors: string[] };

/**
 * Validate a saved export file before anything trusts it. Structural and
 * self-contained: the caller re-derives the entityId from the file's own
 * transcriptHash + generatorVersion (`expectedEntityId`), so an edited or
 * mismatched file is caught at import, not after ingestion.
 */
export async function validateGuideExport(raw: string): Promise<GuideExportParseResult> {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`not valid JSON: ${(err as Error).message.slice(0, 120)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['the export must be a JSON object'] };
  }
  const record = parsed as Record<string, unknown>;
  const schemaVersion = record['schemaVersion'];
  if (schemaVersion !== GUIDE_EXPORT_SCHEMA_VERSION) {
    return { ok: false, errors: [`unsupported schemaVersion ${JSON.stringify(schemaVersion) ?? 'undefined'} (expected ${GUIDE_EXPORT_SCHEMA_VERSION})`] };
  }
  const document = record['document'];
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    errors.push('document must be an object');
  } else {
    const doc = document as Record<string, unknown>;
    for (const field of ['videoUrl', 'title', 'language', 'guideMarkdown', 'generatedAt', 'generatorVersion']) {
      if (typeof doc[field] !== 'string' || (doc[field] as string).length === 0) errors.push(`document.${field} must be a non-empty string`);
    }
  }
  const transcriptHash = record['transcriptHash'];
  if (typeof transcriptHash !== 'string' || !/^[0-9a-f]{64}$/.test(transcriptHash)) {
    errors.push('transcriptHash must be a 64-char lowercase hex string');
  }
  if (typeof record['transcriptExcerpt'] !== 'string') errors.push('transcriptExcerpt must be a string');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: schemaVersion as number,
      document: document as Record<string, unknown>,
      transcriptHash: transcriptHash as string,
      transcriptExcerpt: record['transcriptExcerpt'] as string,
    },
  };
}

/** The entityId a VALID export must carry; import compares this to the Hub id. */
export async function expectedEntityId(value: { transcriptHash: string; document: Record<string, unknown> }): Promise<string> {
  const generatorVersion = value.document['generatorVersion'];
  return guideIdentity(value.transcriptHash, typeof generatorVersion === 'string' ? generatorVersion : '');
}
