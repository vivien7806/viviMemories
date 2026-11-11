import { describe, expect, it, vi } from 'vitest';
import { baseOf, extOf, inBatches, isMedia, mediaDate, mediaType, type ReadAt } from '../../src/shared/media';
import { withExif } from '../fixtures';

const box = (type: string, body: Uint8Array) => {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...type].map(c => c.charCodeAt(0)), 4);
  out.set(body, 8);
  return out;
};

// mvhd version 0 : version/flags, puis date de création en secondes depuis 1904
function mp4(created: Date) {
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(4, (created.getTime() - Date.UTC(1904, 0, 1)) / 1000);
  const parts = [box('ftyp', new Uint8Array(16)), box('moov', box('mvhd', mvhd))];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((pos, p) => (file.set(p, pos), pos + p.length), 0);
  return file;
}

const PHOTO_SIZE = 200_000;
const APP2_SIZE = 20_000;            // profil ICC, par exemple : repousse l'EXIF au-delà des 16 premiers Ko

const reader = (bytes: Uint8Array): ReadAt => async (pos, len) =>
  new DataView(bytes.buffer, bytes.byteOffset + pos, Math.max(0, Math.min(len, bytes.length - pos)));

describe('noms de fichiers', () => {
  it('reconnaît photos et vidéos', () => {
    expect(isMedia('IMG_001.JPG')).toBe(true);
    expect(isMedia('film.mkv')).toBe(true);
    expect(['a.mpg', 'a.MPEG', 'a.vob', 'a.mod', 'a.m2t', 'a.rmvb', 'a.dv'].every(isMedia)).toBe(true);
    expect(isMedia('notes.txt')).toBe(false);
    expect(mediaType('a.MOV')).toBe('video');
    expect(mediaType('a.heic')).toBe('image');
  });

  it('extrait extension et base', () => {
    expect(extOf('Vacances.2020.MP4')).toBe('mp4');
    expect(baseOf('Vacances.2020.MP4')).toBe('Vacances.2020');
  });
});

describe('mediaDate', () => {
  const modified = Date.UTC(2024, 5, 1);

  it('prend la date de modification hors mp4', async () => {
    const date = await mediaDate('a.jpg', modified, 0, async () => { throw new Error('ne doit pas lire'); });
    expect(date.getTime()).toBe(modified);
  });

  it('préfère la date de création mp4 si elle est plus ancienne', async () => {
    const bytes = mp4(new Date(Date.UTC(2019, 6, 14, 12)));
    const date = await mediaDate('a.mp4', modified, bytes.length, reader(bytes));
    expect(date.toISOString()).toBe('2019-07-14T12:00:00.000Z');
  });

  it('garde la date de modification si la création est plus récente', async () => {
    const bytes = mp4(new Date(Date.UTC(2025, 0, 1)));
    expect((await mediaDate('a.mp4', modified, bytes.length, reader(bytes))).getTime()).toBe(modified);
  });

  it('lit aussi la date de création des .mov', async () => {
    const bytes = mp4(new Date(Date.UTC(2019, 6, 14, 12)));
    expect((await mediaDate('IMG_0001.MOV', modified, bytes.length, reader(bytes))).toISOString()).toBe('2019-07-14T12:00:00.000Z');
  });

  it.each([true, false])('lit la date de prise de vue EXIF (petit-boutiste : %s)', async le => {
    const jpeg = withExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), '2018:03:04 05:06:07', le);
    const date = await mediaDate('a.JPG', modified, jpeg.length, reader(jpeg));
    expect(date).toEqual(new Date(2018, 2, 4, 5, 6, 7));        // heure locale de l'appareil
  });

  it('ne lit que le début d’un gros JPEG quand la date y est', async () => {
    const jpeg = withExif(new Uint8Array([0xff, 0xd8, ...new Uint8Array(PHOTO_SIZE), 0xff, 0xd9]), '2018:03:04 05:06:07');
    const lengths: number[] = [];
    const read: ReadAt = (pos, len) => { lengths.push(len); return reader(jpeg)(pos, len); };
    expect(await mediaDate('a.jpg', modified, jpeg.length, read)).toEqual(new Date(2018, 2, 4, 5, 6, 7));
    expect(lengths).toEqual([16 * 1024]);
  });

  it('lit plus loin quand le segment EXIF suit un gros segment', async () => {
    const exif = withExif(new Uint8Array([0xff, 0xd8, ...new Uint8Array(PHOTO_SIZE), 0xff, 0xd9]), '2018:03:04 05:06:07');
    const app2 = new Uint8Array(APP2_SIZE);
    new DataView(app2.buffer).setUint16(0, 0xffe2);
    new DataView(app2.buffer).setUint16(2, APP2_SIZE - 2);
    const jpeg = new Uint8Array([...exif.subarray(0, 2), ...app2, ...exif.subarray(2)]);
    expect(await mediaDate('a.jpg', modified, jpeg.length, reader(jpeg))).toEqual(new Date(2018, 2, 4, 5, 6, 7));
  });

  it('garde la date de modification d’un fichier qui ne répond pas', async () => {
    vi.useFakeTimers();
    const date = mediaDate('a.jpg', modified, PHOTO_SIZE, () => new Promise(() => {}));
    await vi.runAllTimersAsync();
    expect((await date).getTime()).toBe(modified);
    vi.useRealTimers();
  });

  it('ignore un JPEG sans EXIF', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xd9, 0, 0]);
    expect((await mediaDate('a.jpg', modified, jpeg.length, reader(jpeg))).getTime()).toBe(modified);
  });

  it('ignore un fichier mp4 corrompu', async () => {
    const bytes = new Uint8Array(64).fill(0xff);
    expect((await mediaDate('a.mp4', modified, bytes.length, reader(bytes))).getTime()).toBe(modified);
  });
});

describe('inBatches', () => {
  it('garde l’ordre et compte les éléments traités', async () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    const done: number[] = [];
    expect(await inBatches(items, async i => i * 2, n => done.push(n))).toEqual(items.map(i => i * 2));
    expect(done).toEqual([64, 128, 150]);
  });
});
