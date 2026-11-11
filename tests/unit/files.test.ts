import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES, makeFixtures } from '../fixtures';

const trashItem = vi.fn(async (p: string) => unlinkSync(p));
vi.mock('electron', () => ({ shell: { trashItem: (p: string) => trashItem(p) } }));

const { allow, inside, replace, scan, serve } = await import('../../src/electron/files');
const { mediaUrl } = await import('../../src/shared/bridge');

describe('inside', () => {
  it('accepte seulement les chemins sous la racine', () => {
    expect(inside('/a/b', '/a/b/c.jpg')).toBe(true);
    expect(inside('/a/b', '/a/b')).toBe(false);
    expect(inside('/a/b', '/a/bc/d.jpg')).toBe(false);
    expect(inside('/a/b', '/a/b/../c.jpg')).toBe(false);
  });
});

describe('scan', () => {
  it('liste les médias d’un dossier, sous-dossiers compris, relatifs à ce dossier', async () => {
    const dir = makeFixtures();
    const found = await scan([dir]);
    expect(found.map(f => f.path).sort()).toEqual(FIXTURES.map(f => f.path).sort());
    expect(found.find(f => f.name === 'old.avi')?.type).toBe('video');
    expect(found.find(f => f.name === 'b.png')?.date).toBe(Date.parse('2020-04-01T10:00:00Z'));
    expect(found.find(f => f.name === 'clip.mov')?.date).toBe(Date.parse('2020-01-15T10:00:00Z'));
    expect(found.find(f => f.name === 'photo-exif.jpg')?.date).toBe(new Date(2019, 11, 25, 10).getTime());
  });

  it('signale les médias trouvés, puis analysés', async () => {
    const calls: [number, number][] = [];
    await scan([makeFixtures()], (found, analyzed) => calls.push([found, analyzed]));
    expect(calls.some(([, analyzed]) => analyzed === 0)).toBe(true);
    expect(calls.at(-1)).toEqual([FIXTURES.length, FIXTURES.length]);
  });

  it('rend plusieurs éléments relatifs à leur parent', async () => {
    const dir = makeFixtures();
    const found = await scan([join(dir, '2020'), join(dir, 'b.png'), join(dir, 'absent')]);
    expect(found.map(f => f.path).sort()).toEqual([join('2020', 'a.jpg'), 'b.png']);
  });
});

describe('serve', () => {
  let file: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'vivimemories-serve-'));
    file = join(dir, 'x.mp4');
    writeFileSync(file, '0123456789');
    allow(dir);
  });
  const get = (p: string, range?: string) =>
    serve(new Request(mediaUrl(p), { headers: range ? { range } : {} }));

  it('sert le fichier entier', async () => {
    const res = await get(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(await res.text()).toBe('0123456789');
  });

  it('gère les requêtes Range', async () => {
    let res = await get(file, 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');

    res = await get(file, 'bytes=-3');
    expect(await res.text()).toBe('789');

    res = await get(file, 'bytes=7-');
    expect(await res.text()).toBe('789');

    expect((await get(file, 'bytes=20-30')).status).toBe(416);
  });

  it('refuse les fichiers hors des dossiers ouverts', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'vivimemories-out-')), 'secret.jpg');
    writeFileSync(outside, 'x');
    expect((await get(outside)).status).toBe(403);
  });
});

describe('replace', () => {
  let dir: string, tmp: string;
  beforeEach(async () => {
    dir = makeFixtures(['old.avi']);
    await scan([dir]);
    tmp = join(mkdtempSync(join(tmpdir(), 'vivimemories-conv-')), 'out.mp4');
    writeFileSync(tmp, 'converti');
    trashItem.mockClear();
  });

  it('met le .mp4 à la place de l’original, avec la même date', async () => {
    const original = join(dir, 'old.avi');
    const mtime = statSync(original).mtimeMs;
    const result = await replace(original, tmp);

    expect(result).toEqual({ abs: join(dir, 'old.mp4'), name: 'old.mp4', trashed: true });
    expect(trashItem).toHaveBeenCalledWith(original);
    expect(existsSync(original)).toBe(false);
    expect(readFileSync(result.abs, 'utf8')).toBe('converti');
    expect(statSync(result.abs).mtimeMs).toBe(mtime);
    expect(existsSync(tmp)).toBe(false);
  });

  it('n’écrase jamais un autre fichier', async () => {
    writeFileSync(join(dir, 'old.mp4'), 'autre');
    const result = await replace(join(dir, 'old.avi'), tmp);
    expect(result.name).toBe('old (2).mp4');
    expect(readFileSync(join(dir, 'old.mp4'), 'utf8')).toBe('autre');
  });

  it('supprime l’original si la corbeille est indisponible', async () => {
    trashItem.mockRejectedValueOnce(new Error('pas de corbeille'));
    const result = await replace(join(dir, 'old.avi'), tmp);
    expect(result.trashed).toBe(false);
    expect(existsSync(join(dir, 'old.avi'))).toBe(false);
  });

  it('garde le nom et le format de l’original pour une version filtrée', async () => {
    const original = join(dir, 'old.avi');
    const filtered = join(mkdtempSync(join(tmpdir(), 'vivimemories-conv-')), 'out.avi');
    writeFileSync(filtered, 'filtré');
    const result = await replace(original, filtered);
    expect(result).toEqual({ abs: original, name: 'old.avi', trashed: true });
    expect(readFileSync(original, 'utf8')).toBe('filtré');
  });

  it('refuse un fichier hors du dossier ouvert', async () => {
    const other = makeFixtures(['old.avi']);
    await expect(replace(join(other, 'old.avi'), tmp)).rejects.toThrow('hors du dossier');
    rmSync(other, { recursive: true });
  });
});
