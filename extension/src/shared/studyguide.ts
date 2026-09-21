// Study guide generation: transcript chunking, prompts, response validation.
// Pure functions — unit-tested in Node.

export interface TranscriptLine {
  start: number;
  text: string;
}

/** Formats seconds as [M:SS] (or [H:MM:SS] for long lectures). */
export function fmtTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** Builds "[M:SS] cue text" lines for the whole transcript. */
export function transcriptToLines(cues: TranscriptLine[]): string {
  return cues.map((c) => `[${fmtTimestamp(c.start)}] ${c.text.trim()}`).join('\n');
}

/**
 * Splits transcript lines into chunks under `maxChars`, always at line
 * boundaries (never mid-cue).
 */
export function chunkTranscript(cues: TranscriptLine[], maxChars = 24_000): string[] {
  const lines = cues.map((c) => `[${fmtTimestamp(c.start)}] ${c.text.trim()}`);
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (current.length > 0 && size + cost > maxChars) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += cost;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

const GUIDE_FORMAT = `Составь на русском языке учебный конспект этой лекции в формате Markdown строго со следующими разделами:

# <краткое название лекции>

## Краткая сводка
3–6 предложений: о чём видео, главные идеи и выводы.

## Ключевые моменты
5–10 пунктов списком; каждый пункт — законченная мысль.

## Подробный разбор
### [M:SS] <тема>
Для каждой значимой темы лекции — учебное объяснение: что это, зачем нужно, как работает, на что обратить внимание. Добавляй пояснения и примеры от себя (помечай их «💡 Пояснение:»), чтобы материал было легко понять даже без видео. В заголовках сохраняй таймкод начала темы из транскрипта.

## Глоссарий терминов
Список всех специальных терминов лекции в формате:
- **English term** — русский перевод: короткое определение по-русски (1–2 предложения).`;

const GUIDE_RULES = `Требования:
- Пиши по-русски понятным учебным языком, НО каждый термин, понятие, название технологии/метода при первом употреблении давай в формате: «русский перевод (English term)». Например: «обучение с учителем (supervised learning)». В глоссарии — обязательно обе формы.
- Покрой ВСЕ значимые темы транскрипта, ничего не теряй; не придумывай темы, которых там нет.
- Пояснения «от себя» должны быть фактически корректны и помогать пониманию; для дисциплины используй общепринятую академическую терминологию.
- Выводи только Markdown, без ограждающих \`\`\`-блоков и без вступлений ("Вот конспект...").`;

/** Single-chunk (or reduce) prompt: full transcript (or merged notes) → guide. */
export function buildGuideMessages(input: string, isNotes = false): Array<{ role: 'system' | 'user'; content: string }> {
  const source = isNotes
    ? `Ниже — подробные заметки по последовательным частям одной лекции (с таймкодами). Объедини их в итоговый учебный конспект, убери повторы, сохрани все темы и термины.\n\n${input}`
    : `Ниже — полная английская транскрипция учебной лекции с таймкодами.\n\n${input}`;
  return [
    {
      role: 'system',
      content: `Ты — опытный университетский преподаватель, готовишь конспект для студента, чтобы он понял материал лекции без просмотра видео.\n\n${GUIDE_FORMAT}\n\n${GUIDE_RULES}`,
    },
    { role: 'user', content: source },
  ];
}

/** Map step: one chunk → detailed notes (later merged by buildGuideMessages). */
export function buildNotesMessages(chunk: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: `Ты — ассистент преподавателя. Тебе дан фрагмент английской транскрипции учебной лекции с таймкодами. Извлеки из него подробные учебные заметки на русском языке: все темы фрагмента с их таймкодами, определения, примеры, выводы. Термины давай в формате «русский перевод (English term)». Выводи обычным Markdown (заголовки "### [M:SS] тема" и списки), без вступлений и без \`\`\`.`,
    },
    { role: 'user', content: chunk },
  ];
}

export interface ParsedGuide {
  ok: boolean;
  markdown: string;
}

/** Basic structural validation of the model's guide output. */
export function parseGuideResponse(raw: string): ParsedGuide {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/, '');
    const end = s.lastIndexOf('```');
    if (end >= 0) s = s.slice(0, end);
  }
  s = s.trim();
  // must contain section headings and be reasonably long
  const hasSections = (s.match(/^##\s/gm) ?? []).length >= 2;
  const hasTitle = /^#\s/m.test(s);
  if (!hasSections || !hasTitle || s.length < 300) {
    return { ok: false, markdown: s };
  }
  return { ok: true, markdown: s };
}
