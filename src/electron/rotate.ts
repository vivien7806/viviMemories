import { open, stat, utimes, type FileHandle } from 'node:fs/promises';
import { isEditable } from '../shared/media';

const HEADER = 8;
const LARGE_HEADER = 16;
const HANDLER_TYPE = 8;                        // dans « hdlr », après version, drapeaux et pre_defined
const MATRIX_V0 = 40;                          // dans « tkhd », selon la version (dates sur 32 ou 64 bits)
const MATRIX_V1 = 52;
const MATRIX_LEN = 36;
const ONE = 0x10000;                           // 1 en virgule fixe 16.16
const W_ONE = 0x40000000;                      // 1 en virgule fixe 2.30
const QUARTER = 4;

interface Box { type: string; body: number; end: number }

async function children(fh: FileHandle, from: number, to: number): Promise<Box[]> {
  const out: Box[] = [];
  const head = Buffer.alloc(LARGE_HEADER);
  for (let pos = from; pos + HEADER <= to;) {
    head.fill(0);                                         // fin de fichier : pas de reste de la boîte précédente
    await fh.read(head, 0, LARGE_HEADER, pos);
    let size = head.readUInt32BE(0), len = HEADER;
    if (size === 1) { size = Number(head.readBigUInt64BE(HEADER)); len = LARGE_HEADER; }
    else if (size === 0) size = to - pos;
    if (size < len) break;
    out.push({ type: head.toString('latin1', 4, HEADER), body: pos + len, end: pos + size });
    pos += size;
  }
  return out;
}

const find = (boxes: Box[], type: string) => boxes.find(b => b.type === type);

// Position du « tkhd » de chaque piste vidéo.
async function videoHeaders(fh: FileHandle, size: number) {
  const moov = find(await children(fh, 0, size), 'moov');
  if (!moov) throw new Error('fichier MP4 invalide');
  const found: number[] = [];
  for (const trak of (await children(fh, moov.body, moov.end)).filter(b => b.type === 'trak')) {
    const boxes = await children(fh, trak.body, trak.end);
    const tkhd = find(boxes, 'tkhd'), mdia = find(boxes, 'mdia');
    const hdlr = mdia && find(await children(fh, mdia.body, mdia.end), 'hdlr');
    if (!tkhd || !hdlr) continue;
    const type = Buffer.alloc(4);
    await fh.read(type, 0, 4, hdlr.body + HANDLER_TYPE);
    if (type.toString('latin1') === 'vide') found.push(tkhd.body);
  }
  if (!found.length) throw new Error('aucune piste vidéo');
  return found;
}

/* Matrice d'affichage d'une rotation horaire de `turns` quarts de tour : a b u / c d v / x y w.
   La translation garde l'image dans le cadre (largeur et hauteur de la piste, en 16.16). */
function displayMatrix(turns: number, width: number, height: number) {
  const cos = [1, 0, -1, 0][turns] * ONE, sin = [0, 1, 0, -1][turns] * ONE;
  const [x, y] = [[0, 0], [height, 0], [width, height], [0, width]][turns];
  return [cos, sin, 0, -sin, cos, 0, x, y, W_ONE];
}

/* Tourne une vidéo .mp4/.mov sans la réencoder : seule la matrice d'affichage des pistes vidéo
   change, sur place. Le fichier garde sa date de modification. */
export async function rotate(abs: string, turns: number) {
  if (!isEditable(abs)) throw new Error('rotation possible pour les .mp4 et .mov seulement');
  if (!Number.isInteger(turns)) throw new Error('rotation invalide');
  const { atime, mtime, size } = await stat(abs);
  const fh = await open(abs, 'r+');
  try {
    for (const tkhd of await videoHeaders(fh, size)) {
      const version = Buffer.alloc(1);
      await fh.read(version, 0, 1, tkhd);
      const at = tkhd + (version[0] === 1 ? MATRIX_V1 : MATRIX_V0);
      const buf = Buffer.alloc(MATRIX_LEN + 8);              // matrice, puis largeur et hauteur
      await fh.read(buf, 0, buf.length, at);
      const current = Math.round(Math.atan2(buf.readInt32BE(4), buf.readInt32BE(0)) / (Math.PI / 2));
      const total = ((current + turns) % QUARTER + QUARTER) % QUARTER;
      displayMatrix(total, buf.readUInt32BE(MATRIX_LEN), buf.readUInt32BE(MATRIX_LEN + 4))
        .forEach((v, i) => buf.writeInt32BE(v, i * 4));
      await fh.write(buf, 0, MATRIX_LEN, at);
    }
  } finally { await fh.close(); }
  await utimes(abs, atime, mtime).catch(() => {});
}
