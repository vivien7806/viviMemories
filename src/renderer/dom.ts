// Éléments de la page et petits utilitaires d'affichage.

// Un identifiant absent de index.html fait échouer le démarrage, pas un clic plus tard.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} absent de index.html`);
  return el as T;
};

export const ui = {
  landing: $('landing'), dropzone: $('dropzone'), pickBtn: $<HTMLButtonElement>('pickBtn'), pickLabel: $('pickLabel'),
  autoConvert: $<HTMLInputElement>('autoConvert'), convertOption: $('convertOption'), autoConvertNote: $('autoConvertNote'), scanStatus: $('scanStatus'),
  viewer: $('viewer'), stage: $('stage'), progress: $('progress'), zoomLevel: $('zoomLevel'), toast: $('toast'), stats: $('stats'),
  convertBar: $('convertBar'), convertText: $('convertText'),
  replaceBtn: $<HTMLButtonElement>('replaceBtn'), downloadBtn: $<HTMLButtonElement>('downloadBtn'), cancelBtn: $<HTMLButtonElement>('cancelBtn'),
  rotateBar: $('rotateBar'), rotateText: $('rotateText'),
  rotateSave: $<HTMLButtonElement>('rotateSave'), rotateCancel: $<HTMLButtonElement>('rotateCancel'),
  metaName: $('metaName'), metaIcon: $('metaIcon'), metaInfo: $('metaInfo'),
  gotoBtn: $('gotoBtn'), rotateBtn: $('rotateBtn'), windBtn: $('windBtn'), filterBtn: $('filterBtn'), fullscreenBtn: $('fullscreenBtn'), closeBtn: $('closeBtn'),
  prevBtn: $('prevBtn'), playBtn: $('playBtn'), nextBtn: $('nextBtn'),
  delaySelect: $<HTMLSelectElement>('delaySelect'), rateSelect: $<HTMLSelectElement>('rateSelect'),
  gotoPanel: $('gotoPanel'), gotoNum: $<HTMLInputElement>('gotoNum'), gotoNumBtn: $('gotoNumBtn'),
  gotoNumHint: $('gotoNumHint'), gotoDate: $<HTMLInputElement>('gotoDate'), gotoTime: $<HTMLInputElement>('gotoTime'),
  gotoDateBtn: $('gotoDateBtn'), gotoDateHint: $('gotoDateHint'), gotoError: $('gotoError'), gotoCancel: $('gotoCancel'),
};

export type Shown = HTMLImageElement | HTMLVideoElement;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pad = (n: number) => String(n).padStart(2, '0');
export const isVideoEl = (el: Element | null): el is HTMLVideoElement => !!el && el.tagName === 'VIDEO';
export const isImageEl = (el: Element | null): el is HTMLImageElement => !!el && el.tagName === 'IMG';
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtDate = (d: Date) =>
  d.toLocaleDateString('fr-FR', { year: 'numeric', month: 'short', day: '2-digit' }) + ' · ' +
  d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const errMsg = (err: unknown) => (err as Error)?.message ?? String(err);
export const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') =>
  Object.assign(document.createElement(tag), { className, textContent: text });

// Change l'icône d'un bouton ou d'une ligne (symboles #i-… de index.html).
export const setIcon = (el: Element, name: string) =>
  el.querySelector('use')!.setAttribute('href', `#i-${name}`);

export function stopVideo(el: Element | null) {
  if (!isVideoEl(el)) return;
  el.pause();
  el.removeAttribute('src');
  el.load();
}

const pillTimers: Record<string, number> = {};
export function flash(pill: HTMLElement, ms: number) {
  pill.classList.add('show');
  clearTimeout(pillTimers[pill.id]);
  pillTimers[pill.id] = setTimeout(() => pill.classList.remove('show'), ms);
}
export function toast(text: string, ms = 1800) { ui.toast.textContent = text; flash(ui.toast, ms); }
