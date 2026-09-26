// Study guide panel: scrollable reader rendered inside the player container
// (fullscreen-safe). Markdown is rendered via safe DOM building.

import { renderMarkdown } from '../shared/markdown';

const STYLE_ID = 'rusub-study-style';

function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.rusub-study-panel{position:absolute;left:4%;right:4%;top:5%;bottom:11%;z-index:2147483540;
  background:rgba(16,18,24,.97);border:1px solid #3a3f4b;border-radius:12px;color:#e8eaed;
  box-shadow:0 10px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;
  font:400 14px/1.55 "Segoe UI",Arial,sans-serif;pointer-events:auto;
  user-select:text;-webkit-user-select:text;cursor:text}
.rusub-study-panel *{user-select:text;-webkit-user-select:text}
.rusub-study-head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#1c1f26;
  border-bottom:1px solid #33373f;flex:none;user-select:none;-webkit-user-select:none;cursor:default}
.rusub-study-head .rusub-study-title{font-weight:700;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rusub-study-head button{background:#262a32;color:#e8eaed;border:1px solid #3a3f4b;border-radius:6px;
  padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.rusub-study-head button:hover{background:#303641}
.rusub-study-head button.copied{border-color:#2d5a3d;color:#81c995}
.rusub-study-body{overflow-y:auto;padding:14px 20px 22px;flex:1}
.rusub-study-body h1{font-size:1.4em;margin:4px 0 12px;color:#fff}
.rusub-study-body h2{font-size:1.18em;margin:20px 0 8px;color:#8ab4f8;border-bottom:1px solid #33373f;padding-bottom:4px}
.rusub-study-body h3{font-size:1.06em;margin:16px 0 6px;color:#c3a6ff}
.rusub-study-body p{margin:8px 0}
.rusub-study-body ul,.rusub-study-body ol{margin:8px 0 8px 20px}
.rusub-study-body li{margin:4px 0}
.rusub-study-body code{background:#0e1013;border:1px solid #33373f;border-radius:4px;padding:0 4px;font-size:.9em}
.rusub-study-body strong{color:#ffd54f}
.rusub-study-status{padding:24px;text-align:center;color:#9aa0a6;font-size:14px}
.rusub-study-error{padding:20px;color:#f28b82;font-size:13.5px;white-space:pre-wrap}
`;
  doc.head?.appendChild(style) ?? doc.documentElement.appendChild(style);
}

export class StudyPanel {
  private root: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private status: HTMLDivElement | null = null;
  private error: HTMLDivElement | null = null;
  private regenBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private markdown = '';
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private fontSize = 16;

  private exportBtn: HTMLButtonElement | null = null;
  private exportFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private host: HTMLElement,
    private callbacks: {
      onClose: () => void;
      onRegenerate: () => void;
      /** Builds the Hub ingestion file (ENG-204); called when the user exports. */
      onExport: () => Promise<{ json: string; filename: string }>;
    },
  ) {}

  isOpen(): boolean {
    return this.root !== null;
  }

  /** The guide as the generator wrote it; empty until a guide is ready. */
  getMarkdown(): string {
    return this.markdown;
  }

  /** Applies the reader font size; works before and after open(). */
  setFontSize(px: number): void {
    const clamped = Math.min(28, Math.max(11, Math.round(px) || 16));
    this.fontSize = clamped;
    if (this.body) this.body.style.fontSize = `${clamped}px`;
  }

  open(): void {
    if (this.root) return;
    injectStyle(this.host.ownerDocument);
    const doc = this.host.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'rusub-study-panel';

    const head = doc.createElement('div');
    head.className = 'rusub-study-head';
    const title = doc.createElement('span');
    title.className = 'rusub-study-title';
    title.textContent = '📚 Конспект лекции';
    const regen = doc.createElement('button');
    regen.textContent = '↻ Заново';
    regen.title = 'Перегенерировать конспект (кэш будет обновлён)';
    regen.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onRegenerate();
    });
    const copy = doc.createElement('button');
    copy.textContent = '⧉ Копировать';
    copy.title = 'Скопировать весь конспект в буфер обмена';
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.copyToClipboard(copy);
    });
    const exportBtn = doc.createElement('button');
    exportBtn.textContent = '↗ Экспорт';
    exportBtn.title = 'Сохранить конспект JSON-файлом для импорта в Hub';
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.exportToFile(exportBtn);
    });
    const close = doc.createElement('button');
    close.textContent = '× Закрыть';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onClose();
    });
    head.append(title, copy, exportBtn, regen, close);

    const body = doc.createElement('div');
    body.className = 'rusub-study-body';
    body.style.fontSize = `${this.fontSize}px`;
    const status = doc.createElement('div');
    status.className = 'rusub-study-status';
    status.textContent = 'Готовим конспект: анализируем транскрипцию и составляем учебный материал…';
    const error = doc.createElement('div');
    error.className = 'rusub-study-error';
    error.style.display = 'none';

    body.append(status, error);
    root.append(head, body);
    root.addEventListener('click', (e) => e.stopPropagation());
    this.host.appendChild(root);

    this.root = root;
    this.body = body;
    this.status = status;
    this.error = error;
    this.regenBtn = regen;
    this.copyBtn = copy;
    this.exportBtn = exportBtn;
    regen.disabled = true;
    copy.disabled = true;
    exportBtn.disabled = true;
  }

  /** Downloads the guide as the Hub ingestion JSON (ENG-204). */
  private async exportToFile(btn: HTMLButtonElement): Promise<void> {
    if (!this.markdown) return;
    if (this.exportFeedbackTimer) clearTimeout(this.exportFeedbackTimer);
    try {
      const exportData = await this.callbacks.onExport();
      const doc = this.host.ownerDocument;
      const blob = new Blob([exportData.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = exportData.filename;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      btn.textContent = '✓ Сохранено';
      btn.classList.add('copied');
    } catch {
      btn.textContent = '✗ Не удалось';
      btn.classList.remove('copied');
    }
    this.exportFeedbackTimer = setTimeout(() => {
      btn.textContent = '↗ Экспорт';
      btn.classList.remove('copied');
    }, 1800);
  }

  /** Copies the current guide markdown; shows success/failure on the button. */
  private async copyToClipboard(btn: HTMLButtonElement): Promise<void> {
    if (!this.markdown) return;
    const ok = await this.writeClipboard(this.markdown);
    if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
    btn.textContent = ok ? '✓ Скопировано' : '✗ Не удалось';
    btn.classList.toggle('copied', ok);
    this.copyFeedbackTimer = setTimeout(() => {
      btn.textContent = '⧉ Копировать';
      btn.classList.remove('copied');
    }, 1800);
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // cross-origin iframe may block the async clipboard API — fall back
      return this.legacyCopy(text);
    }
  }

  private legacyCopy(text: string): boolean {
    const doc = this.host.ownerDocument;
    const ta = doc.createElement('textarea');
    ta.value = text;
    Object.assign(ta.style, { position: 'fixed', left: '0', top: '0', opacity: '0' } satisfies Partial<CSSStyleDeclaration>);
    doc.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = doc.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  setGenerating(): void {
    if (!this.root) this.open();
    if (this.status) this.status.style.display = 'block';
    if (this.error) this.error.style.display = 'none';
    if (this.body) this.body.scrollTop = 0;
    this.regenBtn && (this.regenBtn.disabled = true);
  }

  setReady(markdown: string): void {
    if (!this.root || !this.body || !this.status || !this.error) this.open();
    if (this.status) this.status.style.display = 'none';
    if (this.error) this.error.style.display = 'none';
    this.markdown = markdown;
    if (this.copyBtn) this.copyBtn.disabled = false;
    if (this.body) {
      renderMarkdown(this.body, markdown);
      this.body.scrollTop = 0;
    }
    this.regenBtn && (this.regenBtn.disabled = false);
  }

  setError(message: string): void {
    if (!this.root || !this.status || !this.error) this.open();
    if (this.status) this.status.style.display = 'none';
    if (this.error) {
      this.error.style.display = 'block';
      this.error.textContent = message;
    }
    this.regenBtn && (this.regenBtn.disabled = false);
  }

  close(): void {
    this.root?.remove();
    this.root = null;
    this.body = null;
    this.status = null;
    this.error = null;
    this.regenBtn = null;
    this.copyBtn = null;
  }

  destroy(): void {
    this.close();
  }
}
