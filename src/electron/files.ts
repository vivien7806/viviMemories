import { createReadStream } from 'node:fs';
import { copyFile, open, readdir, rename, rm, stat, unlink, utimes, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { shell } from 'electron';
import { baseOf, extOf, inBatches, isMedia, mediaDate, mediaType } from '../shared/media';
import { LIVE_HOST, type NativeEntry } from '../shared/bridge';
import { live } from './ffmpeg';

// Seuls les dossiers ouverts par l'utilisateur (et le dossier temporaire) sont servis à la page.
const roots = new Set<string>();
export const allow = (dir: string) => roots.add(resolve(dir));
export const inside = (root: string, p: string) => {
  const r = relative(root, resolve(p));
  return r !== '' && !r.startsWith('..') && !r.startsWith(sep) && !/^[a-z]:/i.test(r);
};
export const isAllowed = (p: string) => [...roots].some(root => inside(root, p));

async function describe(abs: string, base: string): Promise<NativeEntry> {
  const name = basename(abs);
  const st = await stat(abs);
  let fh: FileHandle | null = null;                    // ouvert seulement si l'en-tête est lu
  try {
    const date = await mediaDate(name, st.mtimeMs, st.size, async (pos, len) => {
      fh ??= await open(abs, 'r');
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return new DataView(buf.buffer, buf.byteOffset, bytesRead);
    });
    return { abs, name, path: relative(base, abs), type: mediaType(name), date: date.getTime() };
  } finally { await (fh as FileHandle | null)?.close(); }
}

async function walk(dir: string, out: string[], found: () => void) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out, found);
    else if (entry.isFile() && isMedia(entry.name)) out.push(p);
  }
  found();
}

// Avancement : médias trouvés, puis médias dont la date est lue.
export type ScanProgress = (found: number, analyzed: number) => void;

// Un dossier seul : chemins relatifs à ce dossier. Plusieurs éléments : relatifs à leur parent.
export async function scan(paths: string[], progress: ScanProgress = () => {}): Promise<NativeEntry[]> {
  const stats = await Promise.all(paths.map(p => stat(p).catch(() => null)));
  const single = paths.length === 1 && !!stats[0]?.isDirectory();
  const found: { abs: string; base: string }[] = [];

  for (const [i, p] of paths.entries()) {
    const st = stats[i];
    if (!st) continue;
    const abs = resolve(p);
    const base = single ? abs : dirname(abs);
    if (st.isDirectory()) {
      allow(abs);
      const files: string[] = [];
      await walk(abs, files, () => progress(found.length + files.length, 0));
      found.push(...files.map(f => ({ abs: f, base })));
    } else if (isMedia(abs)) {
      allow(dirname(abs));
      found.push({ abs, base });
    }
  }

  const described = await inBatches(found, f => describe(f.abs, f.base).catch(() => null),
    n => progress(found.length, n));
  return described.filter((e): e is NativeEntry => !!e);
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', qt: 'video/mp4', '3gp': 'video/mp4', '3g2': 'video/mp4',
  webm: 'video/webm', mkv: 'video/webm', ogv: 'video/ogg',
};

// Sert un fichier avec prise en charge des requêtes Range (nécessaire pour avancer dans une vidéo).
// Les vidéos lues à la volée n'ont pas de taille connue : flux sans requêtes Range.
export async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const abs = decodeURIComponent(url.pathname.slice(1));
  if (!isAllowed(abs)) return new Response(null, { status: 403 });
  if (url.host === LIVE_HOST) {
    return live(abs, url.searchParams.get('encode') === '1').then(
      body => new Response(body, { headers: { 'Content-Type': 'video/mp4' } }),
      () => new Response(null, { status: 500 }));
  }
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) return new Response(null, { status: 404 });

  const headers: Record<string, string> = {
    'Content-Type': MIME[extOf(abs)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  const body = (start: number, end: number) =>
    Readable.toWeb(createReadStream(abs, { start, end, highWaterMark: 1 << 20 })) as ReadableStream;

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (!range || (!range[1] && !range[2])) {
    headers['Content-Length'] = String(st.size);
    return new Response(st.size ? body(0, st.size - 1) : null, { headers });
  }
  let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
  let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
  if (start > end || start >= st.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
  }
  headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  headers['Content-Length'] = String(end - start + 1);
  return new Response(body(start, end), { status: 206, headers });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/* Copie la nouvelle version (.mp4 converti, ou même format filtré) à côté de l'original, met
   l'original à la corbeille, puis donne son nom définitif à la copie. Le nouveau fichier garde
   la date de modification de l'original. */
export async function replace(abs: string, tmp: string) {
  if (!isAllowed(abs)) throw new Error('fichier hors du dossier ouvert');
  const dir = dirname(abs), file = basename(abs);
  const ext = extname(tmp);
  let name = baseOf(file) + ext;
  for (let n = 2; name !== file && await exists(join(dir, name)); n++) {
    name = `${baseOf(file)} (${n})${ext}`;
  }
  const target = join(dir, name);
  const part = join(dir, `.${name}.part`);
  const { atime, mtime } = await stat(abs);

  await copyFile(tmp, part);
  let trashed = true;
  try { await shell.trashItem(abs); }
  catch {
    trashed = false;
    try { await unlink(abs); }
    catch (err) { await rm(part, { force: true }); throw err; }
  }
  await rename(part, target);
  await utimes(target, atime, mtime).catch(() => {});
  await rm(tmp, { force: true }).catch(() => {});        // peut être encore lu par la vidéo affichée
  return { abs: target, name, trashed };
}

export async function saveCopy(tmp: string, target: string, original: string) {
  await copyFile(tmp, target);
  const st = await stat(original).catch(() => null);
  if (st) await utimes(target, st.atime, st.mtime).catch(() => {});
}
