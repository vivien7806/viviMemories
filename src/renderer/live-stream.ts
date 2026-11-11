// Tampon de la vidéo autour de la lecture, en secondes : sans limite, MediaSource refuse les longues vidéos.
const MAX_AHEAD = 30;
const KEEP_BEHIND = 10;

const BOX_HEADER = 8;
const hex = (b: number) => b.toString(16).padStart(2, '0');
const boxType = (b: Uint8Array, p: number) => String.fromCharCode(...b.subarray(p + 4, p + BOX_HEADER));

function indexOf(b: Uint8Array, type: string) {
  const codes = [...type].map(c => c.charCodeAt(0));
  for (let i = 0; i + codes.length <= b.length; i++) if (codes.every((c, j) => b[i + j] === c)) return i;
  return -1;
}

/* Type MIME d'un MP4 fragmenté de ffmpeg (H.264, AAC), lu dans « moov » une fois celui-ci complet.
   Le profil et le niveau sont les trois octets qui suivent la version de « avcC ». */
export function mimeOf(b: Uint8Array): string | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 0; p + BOX_HEADER <= b.length;) {
    const size = v.getUint32(p);
    if (size < BOX_HEADER) return null;
    if (boxType(b, p) === 'moov') {
      if (p + size > b.length) return null;
      const moov = b.subarray(p, p + size);
      const avcC = indexOf(moov, 'avcC');
      if (avcC < 0) return null;
      const video = 'avc1.' + [...moov.subarray(avcC + 5, avcC + 8)].map(hex).join('');
      return `video/mp4; codecs="${indexOf(moov, 'mp4a') < 0 ? video : video + ',mp4a.40.2'}"`;
    }
    p += size;
  }
  return null;
}

export type Bytes = Uint8Array<ArrayBuffer>;

// iPhone : ManagedMediaSource seulement.
type SourceClass = typeof MediaSource;
const sourceClass = () =>
  (globalThis as { ManagedMediaSource?: SourceClass }).ManagedMediaSource ?? globalThis.MediaSource as SourceClass | undefined;
export const canStream = () => !!sourceClass();
export const streamSupports = (mime: string) => !!sourceClass()?.isTypeSupported(mime);

// Flux lisible tout de suite, et fichier complet à la fin (remux : image copiée telle quelle)
export interface Streaming {
  stream: LiveStream;
  remux: boolean;
  file: Promise<{ blob: Blob; lossless: boolean }>;
}

/* MP4 fragmenté produit pendant la lecture. Chaque <video> qui le lit reçoit son propre
   MediaSource, alimenté depuis le début avec ce qui est déjà produit, puis au fil de l'eau. */
export class LiveStream {
  private chunks: Bytes[] = [];
  private head: Uint8Array[] | null;                 // début du flux, tant que son type MIME est inconnu
  private mime = '';
  private ended = false;
  private readers = new Set<() => void>();
  private started!: () => void;
  private failed!: (err: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.started = resolve; this.failed = reject; });

  // sniff : type MIME lu dans l'en-tête du flux, sinon donné par start()
  constructor(sniff: boolean) {
    this.head = sniff ? [] : null;
  }

  start(mime: string) {
    this.mime = mime;
    this.started();
  }

  push(chunk: Bytes) {
    this.chunks.push(chunk);
    if (this.head) {
      this.head.push(chunk);
      const mime = mimeOf(concat(this.head));
      if (mime) { this.head = null; this.start(mime); }
    }
    this.readers.forEach(wake => wake());
  }

  end() {
    if (!this.mime) this.failed(new Error('aucune image produite'));
    this.ended = true;
    this.readers.forEach(wake => wake());
  }

  fail(err: Error) {
    this.failed(err);
    this.end();
  }

  blob() { return new Blob(this.chunks, { type: 'video/mp4' }); }

  attach(v: HTMLVideoElement) {
    const Source = sourceClass()!;
    const ms = new Source();
    v.disableRemotePlayback = true;                  // exigé par ManagedMediaSource
    v.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      URL.revokeObjectURL(v.src);
      const sb = ms.addSourceBuffer(this.mime);
      let next = 0;
      const pump = () => {
        if (ms.readyState !== 'open' || sb.updating) return;
        const { buffered } = sb, t = v.currentTime;
        if (buffered.length && buffered.start(0) < t - KEEP_BEHIND) return sb.remove(0, t - KEEP_BEHIND);
        if (buffered.length && buffered.end(buffered.length - 1) > t + MAX_AHEAD) return;
        if (next < this.chunks.length) {
          try { sb.appendBuffer(this.chunks[next]); next++; }
          catch { /* tampon plein : on réessaie quand la lecture avance */ }
        } else if (this.ended) ms.endOfStream();
      };
      sb.addEventListener('updateend', pump);
      v.addEventListener('timeupdate', pump);
      this.readers.add(pump);
      ms.addEventListener('sourceclose', () => this.readers.delete(pump));
      pump();
    }, { once: true });
  }
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
