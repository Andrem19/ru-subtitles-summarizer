// Floating "RU" chip UI: mode switching, status, error toasts, context menu.

import { diag } from '../shared/diag';

export type ChipStateKind = 'idle' | 'busy' | 'active' | 'error';

export interface ChipCallbacks {
  /** cycle ru -> bi -> off */
  onCycle: () => void;
  onSetMode: (mode: 'ru' | 'bi' | 'off') => void;
  onRetry: () => void;
  onOpenOptions: () => void;
}

const STYLE_ID = 'rusub-chip-style';

function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* Our own layer sits above every player layer, positioned exactly over the
   player. Anything placed inside the player's own DOM can be covered by its
   chrome (gradients, control bars, click surfaces), which makes buttons look
   fine but swallow clicks. */
.rusub-layer{position:fixed;pointer-events:none;z-index:2147483550;overflow:visible}
.rusub-controls{position:absolute;right:12px;top:50%;transform:translateY(-50%);
  display:flex;align-items:center;gap:8px;pointer-events:none}
.rusub-chip{position:relative;z-index:1;display:flex;align-items:center;gap:6px;
  padding:6px 12px;border-radius:16px;border:1px solid rgba(255,255,255,.25);cursor:pointer;user-select:none;
  background:rgba(10,10,14,.78);color:#e8e8ee;font:600 12px/1 Arial,Helvetica,sans-serif;letter-spacing:.4px;
  box-shadow:0 2px 8px rgba(0,0,0,.45);pointer-events:auto;transition:background .15s;}
.rusub-guide-btn{position:relative;z-index:1;width:38px;height:38px;flex:none;
  border-radius:50%;border:1px solid rgba(255,255,255,.25);cursor:pointer;user-select:none;
  background:rgba(10,10,14,.78);color:#e8e8ee;font:600 17px/1 Arial,Helvetica,sans-serif;
  box-shadow:0 2px 8px rgba(0,0,0,.45);pointer-events:auto;display:flex;align-items:center;justify-content:center;}
.rusub-guide-btn:hover{background:rgba(30,30,40,.9)}
.rusub-guide-btn[data-busy]{border-color:#f4b400}
.rusub-guide-btn[data-busy]::after{content:'';position:absolute;inset:-3px;border-radius:50%;
  border:2px solid transparent;border-top-color:#f4b400;animation:rusub-spin 1s linear infinite}
@keyframes rusub-spin{to{transform:rotate(360deg)}}
.rusub-chip:hover{background:rgba(30,30,40,.9)}
.rusub-chip .rusub-dot{width:8px;height:8px;border-radius:50%;background:#777;flex:none}
.rusub-chip[data-state=idle] .rusub-dot{background:#9aa0a6}
.rusub-chip[data-state=busy] .rusub-dot{background:#f4b400;animation:rusub-pulse 1s infinite}
.rusub-chip[data-state=active] .rusub-dot{background:#34a853}
.rusub-chip[data-state=error] .rusub-dot{background:#ea4335}
.rusub-chip[data-off]{opacity:.55}
@keyframes rusub-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.rusub-menu{position:absolute;right:12px;top:50%;transform:translateY(-100%);margin-top:-34px;z-index:2147483551;background:#1d1f24;color:#eee;
  border:1px solid #444;border-radius:8px;padding:4px;min-width:210px;font:400 13px/1.4 Arial,sans-serif;
  box-shadow:0 6px 24px rgba(0,0,0,.6)}
.rusub-menu .rusub-mi{padding:7px 12px;border-radius:5px;cursor:pointer;white-space:nowrap}
.rusub-menu .rusub-mi:hover{background:#31343c}
.rusub-menu .rusub-mi[data-selected]{color:#8ab4f8}
.rusub-menu .rusub-sep{height:1px;background:#3c3f46;margin:4px 6px}
.rusub-toast{position:absolute;left:50%;transform:translateX(-50%);top:62%;z-index:2147483552;max-width:80%;
  background:#3b1f22;color:#ffd7d9;border:1px solid #a33;border-radius:8px;padding:8px 14px;font:400 13px/1.45 Arial,sans-serif;
  pointer-events:auto;box-shadow:0 4px 16px rgba(0,0,0,.5)}
.rusub-toast button{margin-left:10px;background:none;border:1px solid #a66;border-radius:4px;color:#ffd7d9;cursor:pointer;font:inherit}
`;
  doc.head?.appendChild(style) ?? doc.documentElement.appendChild(style);
}

export class SubtitleChip {
  private chip: HTMLDivElement;
  private label: HTMLSpanElement;
  private dot: HTMLSpanElement;
  private menu: HTMLDivElement | null = null;
  private toast: HTMLDivElement | null = null;
  private mode: 'ru' | 'bi' | 'off' = 'off';
  private state: ChipStateKind = 'idle';
  private statusText = '';

  constructor(private host: HTMLElement, private cb: ChipCallbacks, mount?: HTMLElement) {
    injectStyle(host.ownerDocument);
    this.chip = host.ownerDocument.createElement('div');
    this.chip.className = 'rusub-chip';
    this.chip.dataset.state = 'idle';
    this.dot = host.ownerDocument.createElement('span');
    this.dot.className = 'rusub-dot';
    this.label = host.ownerDocument.createElement('span');
    this.label.textContent = 'RU';
    this.chip.append(this.dot, this.label);
    this.chip.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      diag('diagCS', `chip:click mode=${this.mode}`);
      this.closeMenu();
      this.cb.onCycle();
    });
    this.chip.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.toggleMenu();
    });
    (mount ?? host).appendChild(this.chip);
  }
  private render() {
    this.chip.dataset.state = this.state;
    const off = this.mode === 'off';
    if (off) this.chip.setAttribute('data-off', '');
    else this.chip.removeAttribute('data-off');
    let text = 'RU';
    if (this.mode === 'bi') text = 'RU+EN';
    if (this.mode === 'off') text = 'RU off';
    if (this.state === 'busy') {
      text += this.statusText ? ` ${this.statusText}` : ' …';
    } else if (this.state === 'error') {
      text += ' !';
    }
    this.label.textContent = text;
    this.chip.title = off ? 'Русские субтитры: выключено (клик — включить)' : 'Клик — сменить режим, правый клик — меню';
  }

  setMode(mode: 'ru' | 'bi' | 'off') {
    this.mode = mode;
    this.render();
  }

  getMode() {
    return this.mode;
  }

  setState(state: ChipStateKind, statusText = '') {
    this.state = state;
    this.statusText = statusText;
    this.render();
  }

  showError(message: string) {
    this.setState('error');
    this.toast?.remove();
    const t = this.host.ownerDocument.createElement('div');
    t.className = 'rusub-toast';
    const span = this.host.ownerDocument.createElement('span');
    span.textContent = message;
    const retry = this.host.ownerDocument.createElement('button');
    retry.textContent = 'Повторить';
    retry.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideToast();
      this.cb.onRetry();
    });
    const close = this.host.ownerDocument.createElement('button');
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideToast();
    });
    t.append(span, retry, close);
    this.host.appendChild(t);
    this.toast = t;
  }

  hideToast() {
    this.toast?.remove();
    this.toast = null;
  }

  private toggleMenu() {
    if (this.menu) this.closeMenu();
    else this.openMenu();
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  private openMenu() {
    const doc = this.host.ownerDocument;
    const menu = doc.createElement('div');
    menu.className = 'rusub-menu';
    const item = (label: string, mode: 'ru' | 'bi' | 'off') => {
      const el = doc.createElement('div');
      el.className = 'rusub-mi';
      el.dataset.selected = this.mode === mode ? '1' : '';
      el.textContent = label;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeMenu();
        this.cb.onSetMode(mode);
      });
      return el;
    };
    menu.append(
      item('Русские субтитры', 'ru'),
      item('Русский + English', 'bi'),
      item('Выключить', 'off'),
    );
    const sep = doc.createElement('div');
    sep.className = 'rusub-sep';
    const retry = doc.createElement('div');
    retry.className = 'rusub-mi';
    retry.textContent = 'Повторить перевод';
    retry.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeMenu();
      this.cb.onRetry();
    });
    const opts = doc.createElement('div');
    opts.className = 'rusub-mi';
    opts.textContent = 'Настройки перевода';
    opts.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeMenu();
      this.cb.onOpenOptions();
    });
    menu.append(sep, retry, opts);
    const dismiss = (ev: Event) => {
      if (menu.contains(ev.target as Node)) return;
      this.closeMenu();
      doc.removeEventListener('click', dismiss, true);
    };
    doc.addEventListener('click', dismiss, true);
    this.host.appendChild(menu);
    this.menu = menu;
  }

  destroy() {
    this.closeMenu();
    this.hideToast();
    this.chip.remove();
  }
}

/** Small "📚 Конспект" button that opens the study guide panel. */
export class GuideButton {
  private btn: HTMLDivElement;
  private busy = false;

  constructor(private host: HTMLElement, private onOpen: () => void, mount?: HTMLElement) {
    injectStyle(host.ownerDocument);
    this.btn = host.ownerDocument.createElement('div');
    this.btn.className = 'rusub-guide-btn';
    this.btn.textContent = '📚';
    this.btn.title = 'Учебный конспект: краткая сводка, ключевые моменты, разбор и глоссарий терминов';
    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      diag('diagCS', 'guide:click');
      this.onOpen();
    });
    // keep the click from reaching the player's own controls underneath
    for (const ev of ['pointerdown', 'mousedown'] as const) {
      this.btn.addEventListener(ev, (e) => e.stopPropagation());
    }
    (mount ?? host).appendChild(this.btn);
  }

  setBusy(value: boolean) {
    this.busy = value;
    if (value) this.btn.setAttribute('data-busy', '');
    else this.btn.removeAttribute('data-busy');
    this.btn.title = value
      ? 'Конспект готовится…'
      : 'Учебный конспект: краткая сводка, ключевые моменты, разбор и глоссарий терминов';
  }

  isBusy() {
    return this.busy;
  }

  destroy() {
    this.btn.remove();
  }
}
