import { isVideoEl, stopVideo, type Shown } from './dom';
import type { Converted, Media, Platform } from './platform';
import type { Playlist } from './playlist';

const VIDEO_READY_TIMEOUT = 2000;

interface CacheEntry {
  url: string;
  img: HTMLImageElement | null;
  video: HTMLVideoElement | null;      // préchargée, pas encore affichée
  source: Converted | null;            // version lue par cette vidéo
  ready: Promise<boolean> | null;
}

export interface StageEvents {
  displayed(m: Media, node: Shown, ok: boolean): void;    // nouveau média à l'écran
  settled(): void;                                        // plus rien à charger
  unreadable(m: Media): void;                             // vidéo préchargée illisible
}

/* La playlist désigne le média voulu ; show() le charge puis l'affiche, en boucle.
   Le nouveau média est entièrement chargé et décodé HORS écran, puis remplace l'ancien
   d'un coup : jamais d'écran noir. Les voisins, photos comme vidéos, sont préchargés ; une
   vidéo ne sert qu'une fois, puis est préchargée à nouveau. Si l'on navigue plus vite que le
   décodage (flèche maintenue), un média qui n'est plus demandé n'est pas affiché. */
export class Stage {
  shown: Media | null = null;     // média réellement à l'écran
  node: Shown | null = null;      // son élément <img> ou <video>
  private cache = new Map<Media, CacheEntry>();
  private pumping = false;

  constructor(
    private el: HTMLElement,
    private playlist: Playlist,
    private platform: Platform,
    private playbackRate: () => number,
    private events: StageEvents,
  ) {}

  get busy() { return this.pumping; }

  async show() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let m = this.playlist.current; m && m !== this.shown; m = this.playlist.current) {
        const { node, ok } = await this.prepare(m);
        if (node && m === this.playlist.current) this.display(m, node, ok);
        else stopVideo(node);
      }
    } finally { this.pumping = false; }
    if (this.node) this.preload();
    this.events.settled();
  }

  // Relit le média affiché (par exemple sa version convertie).
  reload() {
    this.shown = null;
    return this.show();
  }

  // La playlist a changé sans changer de média : ajuste le cache autour de la position.
  refreshAround() {
    this.trim();
    this.preload();
  }

  forget(m: Media) {
    const entry = this.cache.get(m);
    if (!entry) return;
    this.dropVideo(entry);
    this.platform.release(entry.url);
    this.cache.delete(m);
  }

  clear() {
    stopVideo(this.node);
    this.node = this.shown = null;
    this.el.replaceChildren();
    for (const m of [...this.cache.keys()]) this.forget(m);
  }

  private display(m: Media, node: Shown, ok: boolean) {
    stopVideo(this.node);
    if (isVideoEl(node)) node.defaultPlaybackRate = node.playbackRate = this.playbackRate();
    this.el.replaceChildren(node);
    this.node = node;
    this.shown = m;
    this.events.displayed(m, node, ok);
    this.trim();
  }

  private cached(m: Media) {
    let entry = this.cache.get(m);
    if (!entry) {
      entry = { url: this.platform.url(m), img: null, video: null, source: null, ready: null };
      this.cache.set(m, entry);
    }
    return entry;
  }

  private loadImage(m: Media) {
    const entry = this.cached(m);
    if (!entry.ready) {
      const img = new Image();
      img.alt = m.name;
      img.draggable = false;
      img.src = entry.url;
      entry.img = img;
      entry.ready = img.decode().then(() => true, () => false);
    }
    return entry.ready;
  }

  // Prête dès que sa première image est disponible. Illisible avant d'être affichée : signalée.
  private loadVideo(m: Media) {
    const entry = this.cached(m);
    if (entry.video && entry.source !== m.converted) this.dropVideo(entry);
    if (!entry.video) {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      entry.video = v;
      entry.source = m.converted;
      entry.ready = new Promise(resolve => {
        const timeout = setTimeout(() => resolve(true), VIDEO_READY_TIMEOUT);
        const done = (ok: boolean) => {
          clearTimeout(timeout);
          resolve(ok);
          if (!ok && entry.video === v) this.events.unreadable(m);
        };
        v.addEventListener('loadeddata', () => done(v.videoWidth > 0), { once: true });
        v.addEventListener('error', () => done(false), { once: true });
      });
      if (m.converted?.attach) m.converted.attach(v);
      else v.src = m.converted ? m.converted.url : entry.url;
    }
    return entry.ready!;
  }

  private dropVideo(entry: CacheEntry) {
    if (!entry.video) return;
    stopVideo(entry.video);
    entry.video = null;
    entry.ready = null;
  }

  // La vidéo préchargée sort du cache pour être affichée.
  private async prepare(m: Media): Promise<{ node: Shown | null; ok: boolean }> {
    if (m.type === 'video') {
      const ready = this.loadVideo(m);
      const entry = this.cache.get(m)!, v = entry.video!;
      entry.video = entry.ready = null;
      const ok = await ready;
      return { node: v, ok: ok && !v.error };
    }
    const ok = await this.loadImage(m);
    return { node: this.cache.get(m)?.img ?? null, ok };
  }

  private preload() {
    for (const m of this.playlist.ahead()) {
      if (m.type === 'image') this.loadImage(m); else this.loadVideo(m);
    }
  }

  // Libère tout ce qui est hors de la fenêtre [-1 … +2] autour de la position courante.
  private trim() {
    const keep = this.playlist.window();
    if (this.shown) keep.add(this.shown);
    for (const m of [...this.cache.keys()]) if (!keep.has(m)) this.forget(m);
  }
}
