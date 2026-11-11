import { baseOf, extOf, inBatches, isMedia, mediaDate, mediaType } from '../shared/media';
import { folderOf, NeedsDownload, scanStatus, type Converted, type Media, type Platform, type Status } from './platform';
import { streamWithFfmpeg, stopWorker } from './ffmpeg-wasm';
import { streamWithWebCodecs, stopWebCodecs } from './webcodecs';
import { canStream, type Streaming } from './live-stream';

interface WebConverted extends Converted { blob: Blob | null }   // null : lue à la volée

interface WebMedia extends Media {
  file: File;
  dir: FileSystemDirectoryHandle | null;   // seulement si le dossier a été ouvert avec l'API d'écriture
  converted: WebConverted | null;
}

// Écriture directe dans le dossier : Chrome et Edge, pas Firefox.
const CAN_WRITE = typeof window.showDirectoryPicker === 'function';

// Firefox refuse le type « video/quicktime » même quand le contenu est lisible : on réétiquette.
const MIME_FIX: Record<string, string> = { mov: 'video/mp4', m4v: 'video/mp4', '3gp': 'video/mp4', mkv: 'video/webm' };

const finished = ({ blob, lossless }: Awaited<Streaming['file']>): WebConverted =>
  ({ blob, url: URL.createObjectURL(blob), size: blob.size, saved: false, kind: lossless ? 'copy' : 'converted' });

type Found = { file: File; path: string; dir: FileSystemDirectoryHandle | null };

function describe(found: Found[], status: Status): Promise<WebMedia[]> {
  status(scanStatus(found.length, 0));
  return inBatches(found, async ({ file, path, dir }) => ({
    file, path, dir,
    name: file.name,
    type: mediaType(file.name),
    date: await mediaDate(file.name, file.lastModified, file.size,
      async (pos, len) => new DataView(await file.slice(pos, pos + len).arrayBuffer())),
    converted: null,
  }), n => status(scanStatus(found.length, n)));
}

const fromFiles = (files: Iterable<File>): Found[] => Array.from(files)
  .filter(f => isMedia(f.name))
  .map(f => ({ file: f, path: f.webkitRelativePath || f.name, dir: null }));

async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: Found[], status: Status) {
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`, out, status);
    else if (isMedia(entry.name)) out.push({ file: await (entry as FileSystemFileHandle).getFile(), path: prefix + entry.name, dir });
  }
  status(scanStatus(out.length, 0));
}

function pickWithInput(): Promise<File[] | null> {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, webkitdirectory: true });
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export const web: Platform<WebMedia> = {
  convertOption: 'télécharger ffmpeg (~30 Mo) pour les vidéos que le navigateur ne sait pas lire seul',
  converting: 'Conversion de',
  saveLabel: 'Télécharger',

  async pickFolder(status) {
    if (!CAN_WRITE) {
      const files = await pickWithInput();
      return files && describe(fromFiles(files), status);
    }
    let root;
    try { root = await window.showDirectoryPicker!({ id: 'vivimemories' }); }
    catch { return null; }
    status('Lecture du dossier…');
    const found: Found[] = [];
    await walk(root, '', found, status);
    return describe(found, status);
  },

  fromDrop(files) {
    const found = fromFiles(files);
    return status => describe(found, status);
  },

  onOpen() {},

  url(m) {
    const type = MIME_FIX[extOf(m.name)];
    return URL.createObjectURL(type && type !== m.file.type ? new Blob([m.file], { type }) : m.file);
  },
  release: url => URL.revokeObjectURL(url),

  // D'abord sans rien télécharger (WebCodecs), sinon ffmpeg.wasm ; lecture pendant la conversion.
  async convert(m, { status, progress, retry, download }) {
    const s = await streamWithWebCodecs(m.file, m.date, progress, retry)
      ?? (download ? await streamWithFfmpeg(m.file, m.date, status, progress, !retry) : null);
    if (!s) throw new NeedsDownload();
    if (!canStream()) return finished(await s.file);
    return {
      blob: null, url: '', size: 0, saved: false, kind: 'preview', remux: s.remux,
      attach: v => s.stream.attach(v),
      later: s.file.then(finished),
    };
  },
  stopConversions() {
    stopWebCodecs();
    stopWorker();
  },
  discard: c => URL.revokeObjectURL(c.url),

  canReplace: m => CAN_WRITE && !!m.dir,

  // Écrit le .mp4 à côté de l'original, puis supprime l'original (seulement une fois l'écriture terminée).
  async replace(m) {
    const { dir, file } = m;
    if (!dir || !m.converted) throw new Error('dossier non accessible en écriture');
    if (dir.requestPermission && await dir.requestPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('autorisation d’écriture refusée');
    }
    const exists = (name: string) => dir.getFileHandle(name).then(() => true, () => false);
    let name = baseOf(file.name) + '.mp4';
    for (let n = 2; name !== file.name && await exists(name); n++) {
      name = `${baseOf(file.name)} (${n}).mp4`;        // ne jamais écraser un autre fichier
    }

    const handle = await dir.getFileHandle(name, { create: true });
    const out = await handle.createWritable();
    await out.write(m.converted.blob!);
    await out.close();
    if (name !== file.name) await dir.removeEntry(file.name);

    m.file = await handle.getFile();
    m.path = m.path.slice(0, -file.name.length) + name;
    m.name = name;
    return `Original remplacé : ${name}`;
  },

  async save(m) {
    const a = document.createElement('a');
    a.href = m.converted!.url;
    a.download = baseOf(m.name) + '.mp4';
    a.click();
    return `Destination : ${folderOf(m)}${a.download} (puis supprimer ${m.name})`;
  },

  videoDecoding: async () => null,
  editor: null,
};
