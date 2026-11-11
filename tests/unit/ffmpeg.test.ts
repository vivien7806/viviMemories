import { execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { denoise, live, planFor, probe as probeFile, remux } from '../../src/electron/ffmpeg';
import { rotate } from '../../src/electron/rotate';
import { mediaDate } from '../../src/shared/media';
import { FFMPEG, makeFixtures } from '../fixtures';

const probe = (file: string) => {
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: 'pipe' }); return ''; }
  catch (err) { return String((err as { stderr: Buffer }).stderr); }
};

const dateOf = (file: string) => {
  const fd = openSync(file, 'r');
  const { size, mtimeMs } = statSync(file);
  return mediaDate(file, mtimeMs, size, async (pos, len) => {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, pos);
    return new DataView(buf.buffer, buf.byteOffset, n);
  });
};

describe('planFor', () => {
  const line = (s: string) => `  Stream #0:${s}\n`;

  it('remuxe le H.264 8 bits et garde un son lisible', () => {
    const plan = planFor(line('0: Video: h264 (High), yuv420p(progressive), 1920x1080') + line('1: Audio: aac (LC), 48000 Hz'));
    expect(plan).toEqual({ video: 0, remux: true, audioOk: true, lossless: true });
  });

  it('réencode ce que Chromium ne décode pas', () => {
    expect(planFor(line('0: Video: mpeg4 (Simple Profile), yuv420p')).remux).toBe(false);
    expect(planFor(line('0: Video: h264 (High 10), yuv420p10le(progressive)')).remux).toBe(false);
    expect(planFor(line('0: Video: hevc (Main), yuv420p')).remux).toBe(false);
  });

  it('passe en FLAC un son illisible, et ignore la pochette', () => {
    const plan = planFor(line('0: Video: mjpeg, yuvj420p (attached pic)') + line('1: Video: h264, yuvj420p(pc)') + line('2: Audio: pcm_s16le'));
    expect(plan).toMatchObject({ video: 1, remux: true, audioOk: false, lossless: true });
  });

  it('ne se dit pas sans perte si des sous-titres seraient perdus', () => {
    expect(planFor(line('0: Video: h264, yuv420p') + line('1: Subtitle: subrip')).lossless).toBe(false);
  });
});

describe('remux (ffmpeg natif)', () => {
  const out = mkdtempSync(join(tmpdir(), 'vivimemories-ffmpeg-'));
  const date = '2020-05-01T10:00:00.000Z';
  const run = async (name: string) => {
    const dir = makeFixtures([name]);
    const progress: number[] = [];
    const result = await remux(join(dir, name), date, out, p => progress.push(p));
    if (!result) throw new Error('pas de remux');
    return { ...result, progress, info: probe(result.tmp) };
  };

  it('remuxe sans perte un .mts de caméscope', async () => {
    const { lossless, info } = await run('cam.mts');
    expect(lossless).toBe(true);
    expect(info).toMatch(/Video: h264/);
    expect(info).toMatch(/Audio: aac/);
  });

  it('remuxe un .avi H.264 et passe son PCM en FLAC', async () => {
    const { lossless, info } = await run('h264.avi');
    expect(lossless).toBe(true);
    expect(info).toMatch(/Audio: flac/);
  });

  it('ne remuxe pas un codec illisible', async () => {
    const dir = makeFixtures(['old.avi']);
    expect(await remux(join(dir, 'old.avi'), date, out, () => {})).toBeNull();
  });
});

describe('probe (ffmpeg natif)', () => {
  it('donne la durée et dit si l’image peut être copiée', async () => {
    const dir = makeFixtures(['old.avi', 'cam.mts']);
    const old = await probeFile(join(dir, 'old.avi'));
    expect(old.remux).toBe(false);
    expect(old.duration).toBeCloseTo(1, 1);
    expect((await probeFile(join(dir, 'cam.mts'))).remux).toBe(true);
  });

  it('signale un fichier qui n’est pas une vidéo', async () => {
    const dir = makeFixtures();
    await expect(probeFile(join(dir, 'notes.txt'))).rejects.toThrow();
  });
});

describe('denoise (ffmpeg natif)', () => {
  const out = mkdtempSync(join(tmpdir(), 'vivimemories-denoise-'));
  const videoHash = (file: string) => execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString();

  it('filtre le son, copie l’image telle quelle et garde format, date et rotation', async () => {
    const file = join(makeFixtures(['wind.mp4']), 'wind.mp4');
    await rotate(file, 1);
    const progress: number[] = [];
    const { tmp, size } = await denoise(file, out, p => progress.push(p));

    expect(tmp.endsWith('.mp4')).toBe(true);
    expect(size).toBeGreaterThan(0);
    expect(progress.at(-1)).toBeGreaterThan(0.5);
    expect(videoHash(tmp)).toBe(videoHash(file));
    const info = probe(tmp);
    expect(info).toMatch(/Audio: aac/);
    expect(info).toMatch(/rotation of -90/);
    expect((await dateOf(tmp)).getTime()).toBe((await dateOf(file)).getTime());
  });

  it('refuse une vidéo sans son', async () => {
    const dir = makeFixtures(['clip.mp4']);
    await expect(denoise(join(dir, 'clip.mp4'), out, () => {})).rejects.toThrow('aucune piste audio');
  });
});
