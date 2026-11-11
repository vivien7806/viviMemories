import {
  BlobSource, BufferTarget, Conversion, Input, MATROSKA, MP4, MPEG_TS, Mp4OutputFormat, NullTarget, Output, QTFF, Quality, WEBM,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, type InputTrack,
} from 'mediabunny';
import { canStream, LiveStream, streamSupports, type Bytes, type Streaming } from './live-stream';

// Comme avec ffmpeg.wasm : au plus 1920 pixels de côté quand l'image est réencodée
const MAX_SIDE = 1920;
// Conteneurs que le navigateur peut refuser alors que leurs codecs lui sont lisibles
const FORMATS = [MPEG_TS, MATROSKA, WEBM, MP4, QTFF];

let running: Conversion | null = null;

export function stopWebCodecs() {
  running?.cancel();
  running = null;
}

const playable = async (track: InputTrack, kind: 'video' | 'audio') => {
  const codec = await track.getCodecParameterString();
  return !!codec && streamSupports(`${kind}/mp4; codecs="${codec}"`);
};

// MP4 fragmenté → MP4 classique (index en tête), sans réencodage : c'est lui qu'on enregistre.
async function regularMp4(blob: Blob, date: Date) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const output = new Output({ target: new BufferTarget(), format: new Mp4OutputFormat({ fastStart: 'in-memory' }) });
    const conversion = await Conversion.init({ input, output, showWarnings: false, tags: t => ({ ...t, creationTime: date }) });
    await conversion.execute();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } finally { input.dispose(); }
}

/* Sans rien télécharger : démuxage en JS (MPEG-TS, MKV, MOV…), image et son copiés quand le
   navigateur les décode, sinon réencodés par WebCodecs (matériel). Le MP4 fragmenté obtenu est lu
   pendant sa fabrication. null : format ou codec hors de portée, ffmpeg.wasm prendra le relais. */
export async function streamWithWebCodecs(file: File, date: Date, progress: (p: number) => void, retry: boolean): Promise<Streaming | null> {
  if (!canStream()) return null;
  const input = new Input({ source: new BlobSource(file), formats: FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack().catch(() => null);
    if (!video) throw new Error('format inconnu');
    const audio = await input.getPrimaryAudioTrack();
    const copyVideo = !retry && await playable(video, 'video');
    const copyAudio = !audio || await playable(audio, 'audio');
    const videoCodec = copyVideo ? null : await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1']);
    const audioCodec = copyAudio ? null : await getFirstEncodableAudioCodec(['aac', 'opus']);
    if ((!copyVideo && !videoCodec) || (!copyAudio && !audioCodec)) throw new Error('aucun encodeur');

    const stream = new LiveStream(false);
    const push = (data: Uint8Array) => stream.push(data as Bytes);
    const output = new Output({
      target: new NullTarget(),
      format: new Mp4OutputFormat({ fastStart: 'fragmented', onFtyp: push, onMoov: push, onMoof: push, onMdat: push }),
    });
    const { displayWidth: w, displayHeight: h } = video;
    const size = Math.max(w, h) <= MAX_SIDE ? {} : w >= h ? { width: MAX_SIDE } : { height: MAX_SIDE };
    const conversion = await Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      video: copyVideo ? {} : { forceTranscode: true, codec: videoCodec!, quality: new Quality('very-high'), ...size },
      audio: copyAudio ? {} : { forceTranscode: true, codec: audioCodec! },
      tags: t => ({ ...t, creationTime: date }),
    });
    if (!conversion.isValid || conversion.discardedTracks.length) throw new Error('piste illisible');

    running = conversion;
    conversion.onProgress = progress;
    output.getMimeType().then(mime => stream.start(mime), err => stream.fail(err));
    const done = conversion.execute().finally(() => {
      input.dispose();
      if (running === conversion) running = null;
    });
    const result = done.then(async () => {
      stream.end();
      return { blob: await regularMp4(stream.blob(), date), lossless: copyVideo && copyAudio };
    });
    result.catch(err => stream.fail(err));

    await stream.ready;
    return { stream, remux: copyVideo, file: result };
  } catch {
    input.dispose();
    return null;
  }
}
