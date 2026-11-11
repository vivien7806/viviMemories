import './style.css';
import { clamp, errMsg, flash, fmtDate, isImageEl, isVideoEl, setIcon, toast, ui } from './dom';
import type { Media, Platform, Scan } from './platform';
import { web } from './web';
import { electron } from './electron';
import { FILTERS, Playlist } from './playlist';
import { Stage } from './stage';
import { Zoom } from './zoom';
import { createConversions } from './conversion';
import { createEdits } from './edits';
import { createGoto } from './goto';
import { createStats } from './stats';

const platform: Platform = window.vivi ? electron(window.vivi) : web;
const UI_HIDE_DELAY = 2800;
const OPEN_DELAY = 300;          // le temps de lire le décompte avant d'ouvrir la visionneuse
const NO_FRAME_DELAY = 2500;     // au-delà, une vidéo sans image est déclarée illisible

const playlist = new Playlist();
let playing = true;
let imgFrac = 0;                 // part déjà écoulée du temps d'affichage de la photo
let rafId = 0;
let hideTimer = 0;

const playbackRate = () => parseFloat(ui.rateSelect.value) || 1;
const node = () => stage.node;

const stage = new Stage(ui.stage, playlist, platform, playbackRate, {
  displayed(m, el, ok) {
    stopTimer();
    zoom.reset(el);
    imgFrac = 0;
    ui.progress.style.width = '0';
    updateMeta();
    conversions.updateBar();
    edits.show(m, el);
    if (isVideoEl(el)) watchVideo(el, m);
    if (!ok) conversions.showUnreadable(el, m);
  },
  settled,
  unreadable: m => conversions.prepare(m),
});

const zoom = new Zoom(ui.stage, node, (level, changedMode) => {
  ui.zoomLevel.textContent = Math.round(level * 100) + ' %';
  flash(ui.zoomLevel, 1200);
  wakeUI();
  if (changedMode) syncTimer();                   // le zoom met le diaporama en pause
});

const conversions = createConversions({
  platform, stage, next: goNext,
  isPlaying: () => playing,
  updated: m => { if (stage.shown === m) updateMeta(); },
});

const edits = createEdits({ platform, stage, enqueue: conversions.enqueue });

const goto = createGoto({ playlist, setPlaying, isPlaying: () => playing, show: () => stage.show(), wake: wakeUI });
const stats = createStats(platform, node);

/* =====================================================================
   Choix du dossier
   ===================================================================== */
ui.convertOption.hidden = platform.convertOption === null;
ui.autoConvertNote.textContent = platform.convertOption ?? '';
ui.downloadBtn.textContent = platform.saveLabel;

let loading = false;

function setLoading(on: boolean) {
  loading = on;
  ui.pickBtn.disabled = on;
  if (on) return;
  ui.landing.classList.remove('loading');
  ui.pickLabel.textContent = 'Choisir un dossier';
}

// Un dossier à la fois : bouton, glisser-déposer et « Ouvrir avec » attendent la fin du chargement.
async function open(scan: Scan) {
  if (loading) return;
  if (!ui.viewer.hidden) closeViewer();
  setLoading(true);
  try {
    const found = await scan(text => {
      ui.landing.classList.add('loading');
      ui.pickLabel.textContent = 'Chargement…';
      ui.scanStatus.textContent = text;
    });
    if (found?.length) return loadFiles(found);      // déverrouillé à l'ouverture de la visionneuse
    if (found) ui.scanStatus.textContent = 'Aucune photo ou vidéo trouvée dans ce dossier.';
  } catch (err) {
    ui.scanStatus.textContent = `Lecture impossible : ${errMsg(err)}`;
  }
  setLoading(false);
}

ui.pickBtn.addEventListener('click', () => open(platform.pickFolder));
platform.onOpen(open);

(['dragenter', 'dragover', 'dragleave', 'drop'] as const).forEach(type =>
  ui.dropzone.addEventListener(type, e => {
    e.preventDefault();
    ui.dropzone.classList.toggle('drag', type === 'dragenter' || type === 'dragover');
    if (type === 'drop') open(platform.fromDrop(Array.from(e.dataTransfer?.files ?? [])));
  }));
// Un fichier lâché à côté de la zone ne doit pas remplacer la page.
['dragover', 'drop'].forEach(type => document.addEventListener(type, e => e.preventDefault()));

function loadFiles(found: Media[]) {
  playlist.load(found);
  showFilter();
  const videos = found.filter(it => it.type === 'video').length;
  ui.scanStatus.textContent = `${found.length - videos} photo(s), ${videos} vidéo(s), triées par date.`;
  setTimeout(() => { setLoading(false); openViewer(); }, OPEN_DELAY);
}

/* =====================================================================
   Lecture
   ===================================================================== */
function openViewer() {
  ui.landing.hidden = true;
  ui.viewer.hidden = false;
  setPlaying(true);
  stage.show();
  wakeUI();
}

function goNext() { playlist.next(); stage.show(); }
function goPrev() { playlist.prev(); stage.show(); }

function updateMeta() {
  const item = stage.shown;
  if (!item) return;
  const { filter } = playlist;
  ui.metaName.textContent = item.path;
  setIcon(ui.metaIcon, item.type);
  ui.metaInfo.textContent = `${item.type === 'video' ? 'vidéo' : 'photo'} · ` +
    `${playlist.items.indexOf(item) + 1} / ${playlist.length}${filter === 'all' ? '' : ` ${FILTERS[filter].label}`} · ${fmtDate(item.date)}` +
    (item.converted?.kind !== 'preview' ? '' :
      item.converted.remux ? ' · copie lue à la volée, original intact' : ' · aperçu réencodé, original intact');
}

function watchVideo(v: HTMLVideoElement, item: Media) {
  v.addEventListener('timeupdate', () => {
    const duration = item.converted?.duration || v.duration;
    if (node() === v && duration) ui.progress.style.width = (v.currentTime / duration * 100) + '%';
  });
  v.addEventListener('ended', () => { if (node() === v && playing) goNext(); });
  v.addEventListener('error', () => { if (node() === v) conversions.showUnreadable(v, item); });
  // Codec vidéo non supporté : le son peut jouer, mais aucune image n'est décodée.
  setTimeout(() => {
    if (node() === v && v.readyState > 0 && v.videoWidth === 0) conversions.showUnreadable(v, item);
  }, NO_FRAME_DELAY);
}

// Une fois la position finale atteinte : lecture de la vidéo ou minuterie de la photo.
function settled() {
  const el = node();
  if (!el) return;
  if (isVideoEl(el) && playing && !el.dataset.unreadable) el.play().catch(() => {});
  syncTimer();
}

function stopTimer() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}

// Tourne seulement pour une photo, en lecture et sans zoom ; reprend là où elle s'était arrêtée.
function syncTimer() {
  stopTimer();
  if (!isImageEl(node()) || !playing || zoom.active || stage.busy) return;
  const delay = parseInt(ui.delaySelect.value, 10);
  const start = performance.now() - imgFrac * delay;
  const step = (now: number) => {
    imgFrac = clamp((now - start) / delay, 0, 1);
    ui.progress.style.width = (imgFrac * 100) + '%';
    if (imgFrac >= 1) return goNext();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function setPlaying(p: boolean) {
  playing = p;
  setIcon(ui.playBtn, p ? 'pause' : 'play');
  const el = node();
  if (!p && isVideoEl(el)) el.pause();
  if (!stage.busy) settled();
}

/* ---------- Filtre : photos et vidéos, vidéos seulement, photos seulement ---------- */
function showFilter() {
  const { icon, label } = FILTERS[playlist.filter];
  setIcon(ui.filterBtn, icon);
  ui.filterBtn.title = `Afficher : ${label} (V)`;
}

function cycleFilter() {
  if (!playlist.cycleFilter()) return toast('Rien d’autre à afficher dans ce dossier');
  showFilter();
  if (playlist.current === stage.shown) { updateMeta(); stage.refreshAround(); }
  else stage.show();
  const { label } = FILTERS[playlist.filter];
  toast(`${label[0].toUpperCase()}${label.slice(1)} · ${playlist.length}`);
}

/* ---------- Vitesse ---------- */
function announce(select: HTMLSelectElement) {
  const label = select.options[select.selectedIndex].text;
  toast(select === ui.rateSelect ? `Vidéos : ${label}` : `Photos : ${label} par image`);
}

ui.delaySelect.addEventListener('change', () => {
  announce(ui.delaySelect);
  syncTimer();                                      // conserve le temps déjà écoulé
  ui.delaySelect.blur();
});
ui.rateSelect.addEventListener('change', () => {
  announce(ui.rateSelect);
  const el = node();
  if (isVideoEl(el)) el.defaultPlaybackRate = el.playbackRate = playbackRate();
  ui.rateSelect.blur();
});

function stepSelect(select: HTMLSelectElement, dir: number) {
  const i = clamp(select.selectedIndex + dir, 0, select.options.length - 1);
  if (i === select.selectedIndex) return announce(select);
  select.selectedIndex = i;
  select.dispatchEvent(new Event('change'));
}
// « + » accélère : vidéo plus rapide, ou photo affichée moins longtemps.
const changeSpeed = (dir: number) =>
  isVideoEl(node()) ? stepSelect(ui.rateSelect, dir) : stepSelect(ui.delaySelect, -dir);

/* =====================================================================
   Interface, boutons et clavier
   ===================================================================== */
function wakeUI() {
  ui.viewer.classList.remove('idle');
  clearTimeout(hideTimer);
  if (!goto.isOpen()) hideTimer = setTimeout(() => ui.viewer.classList.add('idle'), UI_HIDE_DELAY);
}
ui.viewer.addEventListener('mousemove', wakeUI);
ui.viewer.addEventListener('click', e => {
  // un bouton cliqué à la souris rend le focus : Espace et les flèches restent pour le diaporama
  const button = (e.target as Element).closest('button');
  if (button && e.detail > 0) button.blur();
  wakeUI();
});

ui.prevBtn.addEventListener('click', goPrev);
ui.nextBtn.addEventListener('click', goNext);
ui.playBtn.addEventListener('click', () => setPlaying(!playing));
ui.filterBtn.addEventListener('click', cycleFilter);
ui.fullscreenBtn.addEventListener('click', toggleFullscreen);
ui.closeBtn.addEventListener('click', closeViewer);
document.addEventListener('fullscreenchange', () =>
  setIcon(ui.fullscreenBtn, document.fullscreenElement ? 'minimize' : 'maximize'));

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else ui.viewer.requestFullscreen().catch(() => {});
}

function closeViewer() {
  stopTimer();
  stage.clear();                                     // arrête la vidéo avant de libérer ses fichiers
  conversions.stop(playlist.media);
  edits.stop();
  playlist.clear();
  stats.hide();
  ui.gotoPanel.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen();
  ui.viewer.hidden = true;
  ui.landing.hidden = false;
  ui.scanStatus.textContent = '';
}

const KEYS: Record<string, () => void> = {
  ArrowRight: goNext,
  ArrowLeft: goPrev,
  ' ': () => setPlaying(!playing),
  f: toggleFullscreen,
  g: goto.open,
  v: cycleFilter,
  i: stats.toggle,
  r: () => edits.rotate(),
  w: () => edits.denoise(),
  '+': () => changeSpeed(1), '=': () => changeSpeed(1),
  '-': () => changeSpeed(-1), '_': () => changeSpeed(-1),
  Escape: () => {
    if (document.fullscreenElement) return;          // Échap quitte déjà le plein écran
    if (zoom.active) zoom.set(1); else closeViewer();
  },
};

document.addEventListener('keydown', e => {
  if (ui.viewer.hidden) return;
  if (goto.isOpen()) {                               // panneau ouvert : seul Échap est géré ici
    if (e.key === 'Escape') { e.preventDefault(); goto.close(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as Element).tagName)) return;
  const action = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!action) return;
  e.preventDefault();
  action();
  wakeUI();
});
