import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rotate } from '../../src/electron/rotate';
import { FFMPEG, makeFixtures } from '../fixtures';

// Rotation lue par ffmpeg (sens antihoraire, 0 sans matrice de rotation)
function rotationOf(file: string) {
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: 'pipe' }); }
  catch (err) { return Number(/rotation of (-?[\d.]+) degrees/.exec(String((err as { stderr: Buffer }).stderr))?.[1] ?? 0); }
  return 0;
}

// Empreinte des images décodées, sans appliquer la rotation
const frames = (file: string) => execFileSync(FFMPEG, ['-v', 'error', '-noautorotate', '-i', file,
  '-map', '0:v', '-f', 'md5', '-']).toString();

describe('rotate', () => {
  it('tourne un .mp4 d’un quart de tour à la fois, sans toucher aux images', async () => {
    const file = join(makeFixtures(['clip.mp4']), 'clip.mp4');
    const { size, mtimeMs } = statSync(file);
    const before = frames(file);

    await rotate(file, 1);
    expect(rotationOf(file)).toBe(-90);
    await rotate(file, 1);
    expect(Math.abs(rotationOf(file))).toBe(180);
    await rotate(file, 2);
    expect(rotationOf(file)).toBe(0);

    expect(statSync(file).size).toBe(size);
    expect(statSync(file).mtimeMs).toBe(mtimeMs);
    expect(frames(file)).toBe(before);
  });

  it('tourne un .mov dans l’autre sens', async () => {
    const file = join(makeFixtures(['clip.mov']), 'clip.mov');
    await rotate(file, 3);
    expect(rotationOf(file)).toBe(90);
  });

  it('refuse ce qui n’est pas un MP4 ou un MOV valide', async () => {
    const dir = makeFixtures(['cam.mts']);
    await expect(rotate(join(dir, 'cam.mts'), 1)).rejects.toThrow('.mp4 et .mov');
    const fake = join(dir, 'faux.mp4');
    writeFileSync(fake, 'pas une vidéo');
    await expect(rotate(fake, 1)).rejects.toThrow('MP4 invalide');
    expect(readFileSync(fake, 'utf8')).toBe('pas une vidéo');
  });
});
