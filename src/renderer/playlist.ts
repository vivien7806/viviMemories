import type { Media } from './platform';

export type Filter = 'all' | 'video' | 'image';

export const FILTERS: Record<Filter, { icon: string; label: string; next: Filter }> = {
  all: { icon: 'all', label: 'photos et vidéos', next: 'video' },
  video: { icon: 'video', label: 'vidéos seulement', next: 'image' },
  image: { icon: 'image', label: 'photos seulement', next: 'all' },
};

export type DateNote = 'after-last' | 'before-first' | 'nothing-that-day' | null;

// Médias du dossier triés par date, parcourus en boucle, éventuellement filtrés. Sans DOM.
export class Playlist {
  private all: Media[] = [];
  private view: Media[] = [];
  private at = 0;
  filter: Filter = 'all';
  dir = 1;                                   // sens de navigation, pour le préchargement

  load(found: Media[]) {
    this.all = this.view = [...found].sort((a, b) => +a.date - +b.date);
    this.filter = 'all';
    this.at = 0;
    this.dir = 1;
  }

  clear() { this.load([]); }

  get media(): readonly Media[] { return this.all; }
  get items(): readonly Media[] { return this.view; }
  get length() { return this.view.length; }
  get position() { return this.at; }
  get current(): Media | undefined { return this.view[this.at]; }

  private wrap(i: number) { return ((i % this.view.length) + this.view.length) % this.view.length; }

  goTo(i: number) { this.at = this.wrap(i); return this.current; }
  next() { this.dir = 1; return this.goTo(this.at + 1); }
  prev() { this.dir = -1; return this.goTo(this.at - 1); }

  // Les voisins à précharger, puis la fenêtre à garder en mémoire autour de la position.
  ahead(): Media[] { return this.around([1, 2, -1]); }
  window(): Set<Media> { return new Set(this.around([-1, 0, 1, 2])); }
  private around(offsets: number[]) {
    return this.view.length ? offsets.map(k => this.view[this.wrap(this.at + this.dir * k)]) : [];
  }

  // Numéro à partir de 1, ramené dans les limites.
  goToNumber(n: number) {
    const i = Math.min(this.view.length, Math.max(1, n)) - 1;
    this.goTo(i);
    return { clamped: i + 1 !== n };
  }

  // Premier média à partir de cette date ; sans heure, signale un jour sans média.
  goToDate(target: Date, withTime: boolean): DateNote {
    const i = this.view.findIndex(m => m.date >= target);
    if (i === -1) { this.goTo(this.view.length - 1); return 'after-last'; }
    this.goTo(i);
    if (withTime || this.view[i].date.toDateString() === target.toDateString()) return null;
    return i === 0 ? 'before-first' : 'nothing-that-day';
  }

  /* Filtre suivant qui change quelque chose (ni vide, ni identique à « tout »). Garde le média
     courant s'il reste visible, sinon passe au suivant par date. False s'il n'y en a aucun. */
  cycleFilter(): boolean {
    let mode = FILTERS[this.filter].next;
    let view: Media[] = [];
    for (; mode !== this.filter; mode = FILTERS[mode].next) {
      view = mode === 'all' ? this.all : this.all.filter(m => m.type === mode);
      if (view.length && (mode === 'all' || view.length < this.all.length)) break;
    }
    if (mode === this.filter) return false;

    const was = this.current!;
    this.view = view;
    this.filter = mode;
    this.dir = 1;
    const kept = view.indexOf(was);
    const next = view.findIndex(m => m.date >= was.date);
    this.at = kept !== -1 ? kept : next !== -1 ? next : 0;
    return true;
  }
}
