import { fmtDate, isoDay, toast, ui } from './dom';
import type { Playlist } from './playlist';

const DATE_NOTES = {
  'after-last': 'Date après le dernier média : dernier média affiché',
  'before-first': 'Date avant le premier média',
  'nothing-that-day': 'Rien ce jour-là : média suivant affiché',
};

interface Deps {
  playlist: Playlist;
  isPlaying(): boolean;
  setPlaying(p: boolean): void;
  show(): void;
  wake(): void;
}

// Panneau « Aller à… » : un numéro, ou une date (et une heure facultative).
export function createGoto({ playlist, isPlaying, setPlaying, show, wake }: Deps) {
  let wasPlaying = false;
  const isOpen = () => !ui.gotoPanel.hidden;

  function open() {
    const { items, length } = playlist;
    if (!length || isOpen()) return;
    wasPlaying = isPlaying();
    setPlaying(false);
    ui.gotoNum.max = String(length);
    ui.gotoNum.value = String(playlist.position + 1);
    ui.gotoDate.value = isoDay(playlist.current!.date);
    ui.gotoTime.value = '';
    ui.gotoNumHint.textContent = `de 1 à ${length}`;
    ui.gotoDateHint.textContent = `${fmtDate(items[0].date)} → ${fmtDate(items[length - 1].date)}`;
    ui.gotoError.textContent = '';
    ui.gotoPanel.hidden = false;
    wake();
    ui.gotoNum.focus();
    ui.gotoNum.select();
  }

  function close() {
    if (!isOpen()) return;
    ui.gotoPanel.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur();
    if (wasPlaying) setPlaying(true);
    wake();
  }

  function byNumber() {
    const n = parseInt(ui.gotoNum.value, 10);
    if (isNaN(n)) return void (ui.gotoError.textContent = 'Saisis un numéro valide.');
    if (playlist.goToNumber(n).clamped) toast(`Numéro ramené à ${playlist.position + 1}`);
    close();
    show();
  }

  function byDate() {
    if (!ui.gotoDate.value) return void (ui.gotoError.textContent = 'Choisis une date.');
    const [y, m, d] = ui.gotoDate.value.split('-').map(Number);
    const [hh, mm] = ui.gotoTime.value ? ui.gotoTime.value.split(':').map(Number) : [0, 0];
    const note = playlist.goToDate(new Date(y, m - 1, d, hh, mm), !!ui.gotoTime.value);
    if (note) toast(DATE_NOTES[note]);
    close();
    show();
  }

  const onEnter = (action: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); action(); }
  };
  ui.gotoBtn.addEventListener('click', open);
  ui.gotoCancel.addEventListener('click', close);
  ui.gotoNumBtn.addEventListener('click', byNumber);
  ui.gotoDateBtn.addEventListener('click', byDate);
  ui.gotoNum.addEventListener('keydown', onEnter(byNumber));
  ui.gotoDate.addEventListener('keydown', onEnter(byDate));
  ui.gotoTime.addEventListener('keydown', onEnter(byDate));
  ui.gotoPanel.addEventListener('mousedown', e => { if (e.target === ui.gotoPanel) close(); });

  return { open, close, isOpen };
}
