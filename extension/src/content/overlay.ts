// Fallback overlay renderer: used when the display engine setting is "overlay".
// Lives inside the player container, pointer-events: none, survives fullscreen.

export class SubtitleOverlay {
  private el: HTMLDivElement | null = null;
  private fontSize = 18;

  /** Applies subtitle font size; safe to call before attach. */
  setFontSize(px: number): void {
    const clamped = Math.min(40, Math.max(12, Math.round(px) || 24));
    this.fontSize = clamped;
    if (this.el) this.el.style.fontSize = `${clamped}px`;
  }

  attach(container: HTMLElement): void {
    if (this.el && this.el.parentElement === container) return;
    this.detach();
    const el = document.createElement('div');
    el.className = 'rusub-overlay';
    Object.assign(el.style, {
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      bottom: '9%',
      maxWidth: '86%',
      padding: '5px 14px',
      background: 'rgba(8, 8, 12, 0.72)',
      color: '#fff',
      font: `600 ${this.fontSize}px/1.35 Arial, Helvetica, sans-serif`,
      textAlign: 'center',
      whiteSpace: 'pre-line',
      textShadow: '0 1px 2px rgba(0,0,0,0.9)',
      borderRadius: '6px',
      pointerEvents: 'none',
      zIndex: '2147482000',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(el);
    this.el = el;
  }

  detach(): void {
    this.el?.remove();
    this.el = null;
  }

  /** Renders plain subtitle text (may contain \n for bilingual); null hides the overlay. */
  render(text: string | null): void {
    if (!this.el) return;
    if (!text) {
      this.el.style.display = 'none';
      this.el.textContent = '';
      return;
    }
    this.el.style.display = 'block';
    this.el.textContent = text;
  }
}
