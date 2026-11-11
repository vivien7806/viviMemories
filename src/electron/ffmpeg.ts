import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import { isEditable } from '../shared/media';

const inPath = (name: string) => (process.env.PATH ?? '').split(delimiter)
  .map(dir => join(dir, name)).find(p => existsSync(p));

/* Sous Linux, le ffmpeg du système d'abord : le binaire Linux de ffmpeg-static (7.0.2) plante
   sur tous les fichiers MPEG-TS (.mts, .m2ts). Ailleurs, celui fourni avec l'application. */
export const FFMPEG = process.env.VIVIMEMORIES_FFMPEG
  ?? (process.platform === 'linux' ? inPath('ffmpeg') : undefined)
  ?? ffmpegStatic?.replace('app.asar', 'app.asar.unpacked')
  ?? 'ffmpeg';

const running = new Set<ChildProcess>();

function run(args: string[], onProgress?: (line: string) => void) {
  return new Promise<{ code: number; log: string }>((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    running.add(child);
    let log = '';
    child.stderr!.on('data', d => { log = (log + d).slice(-20000); });
    if (onProgress) createInterface({ input: child.stdout! }).on('line', onProgress);
    child.on('error', (err: NodeJS.ErrnoException) => {
      running.delete(child);
      reject(err.code === 'ENOENT' ? new Error('ffmpeg introuvable') : err);
    });
    child.on('close', (code, signal) => {
      running.delete(child);
      if (signal) reject(new Error('conversion annulée'));
      else resolve({ code: code ?? 1, log });
    });
  });
}

export function cancelAll() {
  for (const child of running) child.kill();
}

const tail = (log: string) => log.trim().split('\n').slice(-4).join(' | ');

// Ce que Chromium décode : copiés tels quels dans un .mp4.
const PLAYABLE_VIDEO = /^(h264|vp9|av1)$/;
const PLAYABLE_AUDIO = /^(aac|mp3|opus|flac)$/;

interface Stream { index: number; kind: string; codec: string; info: string }

export function streamsOf(probe: string): Stream[] {
  return [...probe.matchAll(/Stream #\d+:(\d+)[^:]*: (Video|Audio|Subtitle|Data|Attachment): (\w+)(.*)/g)]
    .map(m => ({ index: +m[1], kind: m[2], codec: m[3], info: m[4] }));
}

/* Remux sans perte quand l'image est lisible par Chromium : seul le conteneur change, et un son
   non lisible passe en FLAC (sans perte). Sinon, l'image est réencodée par live(). */
export function planFor(probe: string) {
  const streams = streamsOf(probe);
  const video = streams.find(s => s.kind === 'Video' && !s.info.includes('attached pic'));
  if (!video) throw new Error('aucune piste vidéo');
  const audioOk = streams.filter(s => s.kind === 'Audio').every(s => PLAYABLE_AUDIO.test(s.codec));
  const remux = PLAYABLE_VIDEO.test(video.codec) && /\byuvj?420p\b/.test(video.info);
  return { video: video.index, remux, audioOk, lossless: remux && !streams.some(s => s.kind === 'Subtitle') };
}

const probeOf = async (input: string) => (await run(['-hide_banner', '-i', input])).log;

// Durée annoncée par la sonde, en secondes (0 si inconnue)
function durationOf(probe: string) {
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe);
  return d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
}

// Lignes de `-progress pipe:1` → part déjà traitée, d'après la durée annoncée par la sonde.
function progressLines(probe: string, progress: (p: number) => void) {
  const duration = durationOf(probe) * 1e6;
  return (line: string) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && duration) progress(+m[1] / duration);
  };
}

// Durée annoncée (0 si inconnue) et remux sans perte possible ou non
export async function probe(input: string) {
  const info = await probeOf(input);
  return { duration: durationOf(info), remux: planFor(info).remux };
}

/* Copie sans perte dans un .mp4, préparée pendant la lecture à la volée pour pouvoir remplacer
   l'original. null si l'image n'est pas lisible telle quelle ou si ffmpeg échoue. */
export async function remux(input: string, date: string, tmpDir: string, progress: (p: number) => void) {
  const info = await probeOf(input);
  const plan = planFor(info);
  if (!plan.remux) return null;

  const output = join(tmpDir, randomUUID() + '.mp4');
  const result = await run([
    '-hide_banner', '-nostats', '-progress', 'pipe:1',
    '-i', input, '-map', `0:${plan.video}`, '-map', '0:a?',
    '-c:v', 'copy', '-c:a', plan.audioOk ? 'copy' : 'flac',
    '-map_metadata', '0', '-metadata', 'creation_time=' + date,
    '-movflags', '+faststart', '-y', output,
  ], progressLines(info, progress));
  if (result.code !== 0) {
    await rm(output, { force: true });
    return null;
  }
  return { tmp: output, size: (await stat(output)).size, lossless: plan.lossless };
}

/* Lecture à la volée, en MP4 fragmenté écrit sur la sortie standard : la vidéo démarre dès le
   premier fragment. Fermer le flux (vidéo quittée) arrête ffmpeg. L'image est copiée telle quelle
   quand Chromium la décode, sinon réencodée, et désentrelacée (MPEG-2, DV de caméscope).
   encode : la copie s'est révélée illisible. */
const FRAGMENT_US = 500_000;

export async function live(input: string, encode: boolean): Promise<ReadableStream> {
  const plan = encode ? null : planFor(await probeOf(input));
  const codecs = plan?.remux
    ? ['-map', `0:${plan.video}`, '-map', '0:a:0?', '-c:v', 'copy', '-c:a', plan.audioOk ? 'copy' : 'flac']
    : ['-map', '0:V:0', '-map', '0:a:0?',
      '-vf', 'bwdif=mode=send_frame:deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k'];
  const child = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', input, ...codecs,
    '-movflags', 'empty_moov+default_base_moof', '-frag_duration', String(FRAGMENT_US),
    '-f', 'mp4', 'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  running.add(child);
  child.on('close', () => running.delete(child));
  child.on('error', () => {});
  child.stdout!.on('close', () => child.kill());
  return Readable.toWeb(child.stdout!) as ReadableStream;
}

/* Bruit du vent : surtout des grondements graves (passe-haut), plus un souffle large bande
   (débruitage FFT qui suit le niveau du bruit). L'image est copiée telle quelle, seul le son
   est réencodé. Même conteneur que l'original, pour pouvoir le remplacer sous le même nom. */
const WIND_FILTER = 'highpass=f=150,afftdn=nr=12:tn=1';
const FILTERED_AUDIO = ['-c:a', 'aac', '-b:a', '192k'];

export async function denoise(input: string, tmpDir: string, progress: (p: number) => void) {
  if (!isEditable(input)) throw new Error('filtre possible pour les .mp4 et .mov seulement');
  const probe = await probeOf(input);
  if (!streamsOf(probe).some(s => s.kind === 'Audio')) throw new Error('aucune piste audio');
  const output = join(tmpDir, randomUUID() + extname(input));
  const result = await run([
    '-hide_banner', '-nostats', '-progress', 'pipe:1',
    '-i', input, '-map', '0:v', '-map', '0:a', '-c:v', 'copy',
    '-af', WIND_FILTER, ...FILTERED_AUDIO,
    '-map_metadata', '0', '-movflags', '+faststart+use_metadata_tags', '-y', output,
  ], progressLines(probe, progress));
  if (result.code !== 0) throw new Error(`ffmpeg a échoué (${tail(result.log)})`);
  return { tmp: output, size: (await stat(output)).size };
}
