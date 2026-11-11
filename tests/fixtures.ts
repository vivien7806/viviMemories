import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG } from '../src/electron/ffmpeg';

export { FFMPEG };

const image = (color: string) => ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1'];
const video = ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25'];
const sound = ['-f', 'lavfi', '-i', 'sine=f=440'];
const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];

// date : date de modification du fichier
export const FIXTURES: { path: string; date: string; args: string[]; exif?: string }[] = [
  { path: 'photo-exif.jpg', date: '2020-06-01T10:00:00Z', args: image('green'), exif: '2019:12:25 10:00:00' },
  { path: join('2020', 'a.jpg'), date: '2020-01-01T10:00:00Z', args: image('red') },
  { path: 'clip.mov', date: '2020-07-01T10:00:00Z', args: [...video, '-t', '1', ...h264, '-metadata', 'creation_time=2020-01-15T10:00:00Z'] },
  { path: 'clip.webm', date: '2020-02-01T10:00:00Z', args: [...video, '-t', '1', '-c:v', 'libvpx', '-b:v', '200k'] },
  { path: 'clip.mp4', date: '2020-03-01T10:00:00Z', args: [...video, '-t', '1', ...h264] },
  { path: 'b.png', date: '2020-04-01T10:00:00Z', args: image('blue') },
  { path: 'old.avi', date: '2020-05-01T10:00:00Z', args: [...video, '-t', '1', '-c:v', 'mpeg4'] },
  { path: 'cam.mts', date: '2020-05-02T10:00:00Z', args: [...video, ...sound, '-t', '1', ...h264, '-c:a', 'aac', '-f', 'mpegts'] },
  { path: 'h264.avi', date: '2020-05-03T10:00:00Z', args: [...video, ...sound, '-t', '1', ...h264, '-c:a', 'pcm_s16le'] },
  { path: 'wind.mp4', date: '2020-05-04T10:00:00Z', args: [...video, ...sound, '-t', '1', ...h264, '-c:a', 'aac', '-metadata', 'creation_time=2020-05-04T08:00:00Z'] },
];

// Ordre attendu : date EXIF, puis date de création du .mov, puis dates de modification
export const ORDER = ['photo-exif.jpg', 'a.jpg', 'clip.mov', 'clip.webm', 'clip.mp4', 'b.png', 'old.avi', 'cam.mts', 'h264.avi', 'wind.mp4'];

// Segment APP1 minimal : IFD0 → IFD Exif → DateTimeOriginal
export function exifSegment(date: string, littleEndian = true): Uint8Array {
  const le = littleEndian;
  const t = new DataView(new ArrayBuffer(64));
  t.setUint16(0, le ? 0x4949 : 0x4d4d); t.setUint16(2, 42, le); t.setUint32(4, 8, le);
  t.setUint16(8, 1, le);
  t.setUint16(10, 0x8769, le); t.setUint16(12, 4, le); t.setUint32(14, 1, le); t.setUint32(18, 26, le);
  t.setUint16(26, 1, le);
  t.setUint16(28, 0x9003, le); t.setUint16(30, 2, le); t.setUint32(32, 20, le); t.setUint32(36, 44, le);
  [...date].forEach((c, i) => t.setUint8(44 + i, c.charCodeAt(0)));

  const seg = new Uint8Array(10 + t.byteLength);
  const v = new DataView(seg.buffer);
  v.setUint16(0, 0xffe1);
  v.setUint16(2, seg.length - 2);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  seg.set(new Uint8Array(t.buffer), 10);
  return seg;
}

export const withExif = (jpeg: Uint8Array, date: string, littleEndian = true) =>
  Buffer.concat([jpeg.subarray(0, 2), exifSegment(date, littleEndian), jpeg.subarray(2)]);

const source = join(tmpdir(), 'vivimemories-fixtures-v3');

function generate() {
  if (existsSync(join(source, 'done'))) return;
  mkdirSync(join(source, '2020'), { recursive: true });
  for (const f of FIXTURES) {
    const out = join(source, f.path);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...f.args, out]);
    if (f.exif) writeFileSync(out, withExif(readFileSync(out), f.exif));
  }
  writeFileSync(join(source, 'notes.txt'), 'pas un média');
  writeFileSync(join(source, 'done'), '');
}

// Copie fraîche du dossier de test (les tests peuvent le modifier).
export function makeFixtures(only?: string[]): string {
  generate();
  const dir = mkdtempSync(join(tmpdir(), 'vivimemories-test-'));
  mkdirSync(join(dir, '2020'));
  for (const f of FIXTURES) {
    if (only && !only.includes(f.path)) continue;
    cpSync(join(source, f.path), join(dir, f.path));
    const t = new Date(f.date);
    utimesSync(join(dir, f.path), t, t);
  }
  cpSync(join(source, 'notes.txt'), join(dir, 'notes.txt'));
  return dir;
}
