import { aacBitrate, extOf } from '../shared/media';
import { LiveStream, lossNote, MAX_SIDE, type Streaming } from './live-stream';

/* Le cœur ffmpeg (~30 Mo) est téléchargé depuis jsDelivr à la première conversion.
   Son code est collé en tête d'un worker créé localement : en file://, un worker n'a pas
   le droit de charger un autre script avec importScripts.
   Page isolée (en-têtes COOP/COEP) : version multithread, plusieurs fois plus rapide. */
const MULTITHREAD = globalThis.crossOriginIsolated === true;
const FFMPEG_CORE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core${MULTITHREAD ? '-mt' : ''}@0.12.6/dist/umd/`;
const FRAGMENT_US = 500_000;
/* Threads par décodeur et encodeur : ffmpeg.wasm n'en a que 32 préparés d'avance, et un thread
   de plus ne peut pas démarrer pendant la conversion (blocage). */
const THREADS = MULTITHREAD ? 4 : 1;

// Sérialisée avec toString() : ne doit dépendre de rien d'extérieur (aacBitrate lui est passée).
function ffmpegWorker(bitrateOf: typeof aacBitrate) {
  let core: any = null;
  let log: string[] = [];
  let onProgress = (_p: number) => {};
  const run = (args: string[]) => { core.setTimeout(-1); core.exec(...args); const code = core.ret; core.reset(); return code; };

  self.onmessage = async ({ data }) => {
    try {
      if (data.type === 'load') {
        core = await createFFmpegCore({ wasmBinary: data.wasm, mainScriptUrlOrBlob: data.mainScript });
        core.setLogger(({ message }: { message: string }) => log.push(message));
        core.setProgress(({ progress }: { progress: number }) => onProgress(progress));
        return self.postMessage({ type: 'loaded' });
      }

      const input = 'input.' + data.ext, output = 'output.mp4', final = 'final.mp4';
      core.FS.writeFile(input, new Uint8Array(await data.file.arrayBuffer()));

      log = [];
      run(['-hide_banner', '-i', input]);
      const info = log.join('\n');
      // Image déjà en H.264 8 bits : copiée telle quelle (sans perte, quasi instantané).
      const canCopy = data.copy && /Video: h264.*\byuv420p[(,]/.test(info);
      // Son en AAC copié lui aussi, sinon converti en AAC comme avec videoToHevc
      const audio = /Audio: (\w+)(.*)/.exec(info);
      const copyAudio = !audio || audio[1] === 'aac';
      const size = /Video: .*?, (\d+)x(\d+)/.exec(info);
      const reduced = !!size && Math.max(+size[1], +size[2]) > data.maxSide;

      // Envoie ce que ffmpeg a ajouté au fichier de sortie depuis le dernier envoi.
      let sent = 0;
      const flush = () => {
        let size = 0;
        try { size = core.FS.stat(output).size; } catch { return; }
        if (size <= sent) return;
        const chunk = new Uint8Array(size - sent);
        const stream = core.FS.open(output, 'r');
        core.FS.read(stream, chunk, 0, chunk.length, sent);
        core.FS.close(stream);
        sent = size;
        self.postMessage({ type: 'chunk', chunk }, { transfer: [chunk.buffer] });
      };
      onProgress = progress => { flush(); self.postMessage({ type: 'progress', progress }); };

      // MP4 fragmenté : lisible pendant sa fabrication.
      const threads = ['-threads', String(data.threads)];
      const args = (copy: boolean, copySound: boolean) => [
        ...threads, '-i', input, '-map', '0:v:0', '-map', '0:a:0?', ...threads,
        ...(copy ? ['-c:v', 'copy'] : [
          '-vf', `bwdif=mode=send_frame:deint=interlaced,scale='min(${data.maxSide},iw)':'min(${data.maxSide},ih)'` +
            ':force_original_aspect_ratio=decrease:force_divisible_by=2',
          '-c:v', 'libx264', '-preset', 'superfast', '-crf', '22', '-pix_fmt', 'yuv420p',
        ]),
        ...(copySound ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', bitrateOf(audio?.[2] ?? '')]),
        '-map_metadata', '0', '-metadata', 'creation_time=' + data.date,
        '-movflags', 'empty_moov+default_base_moof', '-frag_duration', String(data.fragment),
        '-f', 'mp4', '-y', output,
      ];
      log = [];
      self.postMessage({ type: 'mode', copy: canCopy });
      let copied = canCopy, soundCopied = copyAudio;
      let code = run(args(canCopy, copyAudio));
      // Échec avant la première image : tout est réencodé
      if (code !== 0 && sent === 0 && (copied || soundCopied)) {
        copied = soundCopied = false;
        log = [];
        self.postMessage({ type: 'mode', copy: false });
        code = run(args(false, false));
      }
      flush();
      onProgress = () => {};

      // Fichier à enregistrer : MP4 classique, index en tête, sans réencodage.
      let out: Uint8Array | null = null;
      if (code === 0 && run(['-i', output, '-map', '0', '-c', 'copy', '-map_metadata', '0', '-movflags', '+faststart', '-y', final]) === 0) {
        out = core.FS.readFile(final);
      }
      for (const f of [input, output, final]) { try { core.FS.unlink(f); } catch {} }
      self.postMessage({ type: 'done', out, copied, soundCopied, reduced: reduced && !copied, log: log.slice(-4).join(' | ') },
        { transfer: out ? [out.buffer] : [] });
    } catch (e: any) {
      self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
  };
}
declare const createFFmpegCore: (options: { wasmBinary: ArrayBuffer; mainScriptUrlOrBlob?: string }) => Promise<any>;

type Handlers = Record<string, (data: any) => void>;

let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let handlers: Handlers = {};
let blobUrls: string[] = [];             // scripts des threads, gardés tant que le worker vit

function listen(on: Handlers) {
  handlers = on;
  worker!.onmessage = ({ data }) => handlers[data.type]?.(data);
  worker!.onerror = e => {
    e.preventDefault();
    handlers.error?.({ message: e.message || 'le moteur ffmpeg a planté' });
  };
}

export function stopWorker() {
  const cancel = handlers.error;
  worker?.terminate();
  blobUrls.forEach(url => URL.revokeObjectURL(url));
  worker = workerReady = null;
  handlers = {};
  blobUrls = [];
  cancel?.({ message: 'conversion annulée' });
}

const scriptUrl = (code: string) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  blobUrls.push(url);
  return url;
};

function startWorker(say: (text: string) => void) {
  workerReady ??= (async () => {
    say('Téléchargement de ffmpeg (~30 Mo, une seule fois)…');
    let js: string, wasm: ArrayBuffer, threadJs = '';
    try {
      const get = async (name: string) => {
        const res = await fetch(FFMPEG_CORE + name);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res;
      };
      [js, wasm, threadJs] = await Promise.all([
        get('ffmpeg-core.js').then(r => r.text()),
        get('ffmpeg-core.wasm').then(r => r.arrayBuffer()),
        MULTITHREAD ? get('ffmpeg-core.worker.js').then(r => r.text()) : '',
      ]);
    } catch (err) {
      throw new Error(`téléchargement de ffmpeg impossible, connexion requise (${(err as Error).message})`);
    }
    say('Démarrage de ffmpeg…');
    // Chaque thread recharge le cœur seul ; l'adresse de son script est passée après le « # ».
    const mainScript = MULTITHREAD
      ? `${scriptUrl(js)}#${btoa(JSON.stringify({ wasmURL: '', workerURL: scriptUrl(threadJs) }))}`
      : undefined;
    const url = URL.createObjectURL(new Blob([js, `\n;(${ffmpegWorker})(${aacBitrate});`], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    await new Promise((resolve, reject) => {
      listen({ loaded: resolve, error: d => reject(new Error(d.message)) });
      worker!.postMessage({ type: 'load', wasm, mainScript }, [wasm]);
    });
  })().catch(err => { stopWorker(); throw err; });
  return workerReady;
}

// copy : image H.264 copiée si possible (sinon réencodée)
export async function streamWithFfmpeg(file: File, date: Date, say: (text: string) => void, progress: (p: number) => void, copy: boolean): Promise<Streaming> {
  await startWorker(say);
  progress(0);
  const stream = new LiveStream(true);
  let remux = false;
  const result: Streaming['file'] = new Promise((resolve, reject) => {
    listen({
      mode: d => { remux = d.copy; },
      chunk: d => stream.push(d.chunk),
      progress: d => progress(d.progress),
      done: d => {
        stream.end();
        const lossless = d.copied && d.soundCopied;
        if (d.out) resolve({ blob: new Blob([d.out], { type: 'video/mp4' }), lossless, note: lossless ? undefined : lossNote(d.copied, d.reduced) });
        else reject(new Error('ffmpeg a échoué' + (d.log ? ` (${d.log})` : '')));
      },
      error: d => {
        reject(new Error(d.message));
        stopWorker();                                // état inconnu : on repartira de zéro
      },
    });
    worker!.postMessage({
      type: 'convert', file, copy, fragment: FRAGMENT_US, threads: THREADS, maxSide: MAX_SIDE,
      ext: extOf(file.name).replace(/[^a-z0-9]/g, '') || 'bin', date: date.toISOString(),
    });
  });
  result.catch(err => stream.fail(err));
  await stream.ready;
  return { stream, remux, file: result };
}
