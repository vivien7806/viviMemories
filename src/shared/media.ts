export type MediaType = 'image' | 'video';

export const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;
// Tout ce que ffmpeg lit : Electron réencode à la volée ce que Chromium ne décode pas.
export const VIDEO_EXT = /\.(mp4|m4v|mov|qt|webm|mkv|3gp|3g2|avi|divx|mpe?g|mpe|m[12]v|vob|mod|tod|m2t|mts|m2ts|wmv|asf|flv|f4v|ogv|ogm|dv|rm|rmvb|mxf)$/i;

export const extOf = (name: string) => name.split('.').pop()!.toLowerCase();
export const baseOf = (name: string) => name.replace(/\.[^.]+$/, '');
export const isMedia = (name: string) => IMAGE_EXT.test(name) || VIDEO_EXT.test(name);
export const mediaType = (name: string): MediaType => VIDEO_EXT.test(name) ? 'video' : 'image';

export type ReadAt = (pos: number, len: number) => Promise<DataView>;

const QUICKTIME = /^(mp4|m4v|mov|qt|3gp|3g2)$/;
const JPEG = /^jpe?g$/;

// EXIF : les dates sont presque toujours dans les premiers Ko ; on ne lit plus que si besoin.
const EXIF_PROBE = 16 * 1024;
const EXIF_MAX = 128 * 1024;
// Fichier qui ne répond pas (réseau, cloud) : on garde sa date de modification.
const HEADER_TIMEOUT = 5000;
// Lectures simultanées : des dizaines de milliers d'un coup saturent le disque et la mémoire.
const BATCH = 64;

// Applique fn par lots, dans l'ordre ; done reçoit le nombre d'éléments traités.
export async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>, done: (n: number) => void = () => {}) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...await Promise.all(items.slice(i, i + BATCH).map(fn)));
    done(out.length);
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<null>(resolve => { timer = setTimeout(resolve, ms, null); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Vidéos qu'on sait tourner et filtrer sans changer de format
export const isEditable = (name: string) => QUICKTIME.test(extOf(name));

/* La plus ancienne des dates connues : modification du fichier, prise de vue (EXIF) ou
   création (en-tête QuickTime). Copier ou convertir un fichier ne change pas le classement. */
export async function mediaDate(name: string, lastModified: number, size: number, read: ReadAt): Promise<Date> {
  const modified = new Date(lastModified);
  const ext = extOf(name);
  const reader = QUICKTIME.test(ext) ? mp4CreationDate : JPEG.test(ext) ? exifDate : null;
  if (!reader) return modified;
  const found = await withTimeout(reader(size, read), HEADER_TIMEOUT).catch(() => null);
  return found && found < modified ? found : modified;
}

// Date EXIF « AAAA:MM:JJ hh:mm:ss », en heure locale de l'appareil
function parseExifDate(s: string): Date | null {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m) return null;
  const date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return date.getFullYear() > 1971 ? date : null;
}

/* Segment APP1 « Exif » d'un JPEG : DateTimeOriginal, sinon DateTimeDigitized, sinon DateTime.
   Lu d'abord sur EXIF_PROBE octets, puis sur EXIF_MAX si la date tombe au-delà. */
async function exifDate(fileSize: number, read: ReadAt): Promise<Date | null> {
  for (const len of [EXIF_PROBE, EXIF_MAX]) {
    const v = await read(0, Math.min(fileSize, len));
    const partial = v.byteLength < fileSize && len < EXIF_MAX;
    try { return jpegDate(v, partial); }
    catch (err) { if (!partial || !(err instanceof RangeError)) throw err; }
  }
  return null;
}

function jpegDate(v: DataView, partial: boolean): Date | null {
  if (v.getUint16(0) !== 0xffd8) return null;
  for (let p = 2; p + 10 <= v.byteLength;) {
    const marker = v.getUint16(p), len = v.getUint16(p + 2);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
    if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) {          // « Exif »
      return tiffDate(new DataView(v.buffer, v.byteOffset + p + 10, Math.min(len - 8, v.byteLength - p - 10)));
    }
    p += 2 + len;
  }
  if (partial) throw new RangeError('segment EXIF au-delà de la lecture');
  return null;
}

function tiffDate(t: DataView): Date | null {
  const le = t.getUint16(0) === 0x4949;                                      // « II » : petit-boutiste
  const u16 = (o: number) => t.getUint16(o, le), u32 = (o: number) => t.getUint32(o, le);
  const entries = (ifd: number) => {
    const tags = new Map<number, number>();
    for (let i = 0, n = u16(ifd); i < n; i++) tags.set(u16(ifd + 2 + i * 12), ifd + 2 + i * 12);
    return tags;
  };
  const text = (entry: number) => {
    const count = u32(entry + 4);
    const at = count > 4 ? u32(entry + 8) : entry + 8;
    return String.fromCharCode(...new Uint8Array(t.buffer, t.byteOffset + at, Math.min(count, 19)));
  };

  const ifd0 = entries(u32(4));
  const exifIfd = ifd0.get(0x8769);
  const exif = exifIfd === undefined ? new Map<number, number>() : entries(u32(exifIfd + 8));
  for (const entry of [exif.get(0x9003), exif.get(0x9004), ifd0.get(0x0132)]) {
    const date = entry === undefined ? null : parseExifDate(text(entry));
    if (date) return date;
  }
  return null;
}

// Parcourt les boîtes MP4 de premier niveau jusqu'à « moov », puis lit « mvhd ».
async function mp4CreationDate(fileSize: number, read: ReadAt): Promise<Date | null> {
  const typeAt = (v: DataView, p: number) =>
    String.fromCharCode(v.getUint8(p + 4), v.getUint8(p + 5), v.getUint8(p + 6), v.getUint8(p + 7));

  for (let pos = 0, n = 0; pos + 8 <= fileSize && n < 64; n++) {
    const head = await read(pos, 16);
    let size = head.getUint32(0), headLen = 8;
    if (size === 1 && head.byteLength >= 16) { size = Number(head.getBigUint64(8)); headLen = 16; }
    else if (size === 0) size = fileSize - pos;
    if (size < headLen) return null;

    if (typeAt(head, 0) === 'moov') {
      const moov = await read(pos + headLen, Math.min(size - headLen, 4096));
      for (let p = 0; p + 20 <= moov.byteLength;) {
        const childSize = moov.getUint32(p);
        if (typeAt(moov, p) === 'mvhd') {
          const secs = moov.getUint8(p + 8) === 1 ? Number(moov.getBigUint64(p + 12)) : moov.getUint32(p + 12);
          const date = new Date(Date.UTC(1904, 0, 1) + secs * 1000);   // secondes depuis 1904, UTC
          return date.getFullYear() > 1971 ? date : null;
        }
        if (childSize < 8) return null;
        p += childSize;
      }
      return null;
    }
    pos += size;
  }
  return null;
}
