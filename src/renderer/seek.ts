import { clamp, isVideoEl, toast, ui } from './dom';
import type { Media } from './platform';

const JUMP = 10;                 // secondes, clic à gauche ou à droite de la vidéo
const HOLD_DELAY = 400;          // appui maintenu sur la vidéo : lecture accélérée
const HOLD_RATE = 2;

interface Deps {
  node(): Element | null;
  shown(): Media | null;
  zoomed(): boolean;
  playbackRate(): number;
}

/* Barre de progression : son curseur se glisse pour se déplacer dans la vidéo.
   Clic sur la moitié gauche ou droite de la vidéo : recule ou avance de 10 s.
   Appui maintenu : lecture en 2× jusqu'au relâchement. */
export function createSeek({ node, shown, zoomed, playbackRate }: Deps) {
  let holdTimer = 0;
  let held: HTMLVideoElement | null = null;
  let endingHold = false;        // le clic qui suit le relâchement n'est pas un saut de 10 s
  const video = () => { const el = node(); return isVideoEl(el) ? el : null; };
  const duration = (v: HTMLVideoElement) => shown()?.converted?.duration || v.duration || 0;

  // Une copie lue à la volée ne permet d'aller que dans la partie déjà reçue.
  function seek(v: HTMLVideoElement, t: number) {
    let target = clamp(t, 0, duration(v));
    const { buffered } = v;
    if (shown()?.converted?.kind === 'preview' && buffered.length)
      target = clamp(target, buffered.start(0), buffered.end(buffered.length - 1));
    v.currentTime = target;
  }

  function show(v: HTMLVideoElement) {
    const d = duration(v);
    if (d) ui.progress.style.width = (v.currentTime / d * 100) + '%';
  }

  function seekAt(e: PointerEvent) {
    const v = video();
    if (!v) return;
    const r = ui.seekbar.getBoundingClientRect();
    seek(v, clamp((e.clientX - r.left) / r.width, 0, 1) * duration(v));
    show(v);
  }

  ui.seekbar.addEventListener('pointerdown', e => {
    if (!video() || !e.isPrimary || e.button !== 0) return;
    ui.seekbar.setPointerCapture(e.pointerId);
    ui.seekbar.classList.add('dragging');
    seekAt(e);
  });
  ui.seekbar.addEventListener('pointermove', e => {
    if (ui.seekbar.hasPointerCapture(e.pointerId)) seekAt(e);
  });
  ui.seekbar.addEventListener('lostpointercapture', () => ui.seekbar.classList.remove('dragging'));

  ui.stage.addEventListener('pointerdown', e => {
    const v = video();
    if (!v || e.target !== v || zoomed() || !e.isPrimary || e.button !== 0) return;
    holdTimer = setTimeout(() => {
      held = v;
      v.playbackRate = HOLD_RATE;
      toast(`${HOLD_RATE}×`);
    }, HOLD_DELAY);
  });
  const release = () => {
    clearTimeout(holdTimer);
    if (!held) return;
    held.playbackRate = playbackRate();
    held = null;
    endingHold = true;
    setTimeout(() => { endingHold = false; });
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  ui.stage.addEventListener('contextmenu', e => { if (held) e.preventDefault(); });

  ui.stage.addEventListener('click', e => {
    const v = video();
    if (!v || e.target !== v || zoomed() || endingHold) return;
    const r = ui.stage.getBoundingClientRect();
    const dir = e.clientX < r.left + r.width / 2 ? -1 : 1;
    seek(v, v.currentTime + dir * JUMP);
    show(v);
    toast(`${dir < 0 ? '−' : '+'}${JUMP} s`);
  });

  return {
    // Nouveau média : le curseur n'apparaît que sur une vidéo.
    attach(el: Element) { ui.seekbar.classList.toggle('video', isVideoEl(el)); },
    show,
  };
}
