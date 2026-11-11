import { liveUrl, mediaUrl, type ViviBridge, type NativeEntry } from '../shared/bridge';
import { isEditable } from '../shared/media';
import { scanStatus, type Converted, type Media, type Platform, type Scan } from './platform';

interface NativeConverted extends Converted { tmp: string | null }   // null : lu à la volée

interface NativeMedia extends Media {
  abs: string;
  rev: number;                     // change quand le fichier est modifié sur place
  converted: NativeConverted | null;
}

// Les erreurs d'IPC arrivent préfixées par « Error invoking remote method 'x': Error: ».
const clean = (err: unknown) =>
  new Error(String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''));
const call = async <T>(p: Promise<T>) => { try { return await p; } catch (err) { throw clean(err); } };

const toMedia = (e: NativeEntry): NativeMedia => ({ ...e, date: new Date(e.date), rev: 0, converted: null });

export function electron(bridge: ViviBridge): Platform<NativeMedia> {
  let liveLoads = 0;
  const scan = (paths: string[]): Scan<NativeMedia> => async status => {
    status('Lecture du dossier…');
    return (await call(bridge.scan(paths, (found, analyzed) => status(scanStatus(found, analyzed))))).map(toMedia);
  };

  return {
    convertOption: null,
    converting: 'Préparation de',
    saveLabel: 'Enregistrer sous…',

    async pickFolder(status) {
      const folder = await call(bridge.chooseFolder());
      return folder ? scan([folder])(status) : null;
    },
    fromDrop: files => scan(files.map(f => bridge.pathOf(f)).filter(Boolean)),
    onOpen: open => bridge.onOpen(paths => open(scan(paths))),

    url: m => m.rev ? `${mediaUrl(m.abs)}?v=${m.rev}` : mediaUrl(m.abs),
    release() {},

    async convert(m, { status, progress, retry }) {
      status('Préparation de la lecture…');
      const { duration, remux } = await call(bridge.probe(m.abs));
      const encode = retry || !remux;
      const live: NativeConverted = {
        tmp: null, size: 0, saved: false, kind: 'preview', duration, remux: !encode,
        // Adresse nouvelle à chaque lecture : Chromium reprendrait sinon le flux précédent, interrompu.
        get url() { return `${liveUrl(m.abs, encode)}&n=${++liveLoads}`; },
      };
      if (!encode) {
        live.later = call(bridge.remux(m.abs, m.date.toISOString(), progress)).then(r => r && {
          tmp: r.tmp, size: r.size, url: mediaUrl(r.tmp), saved: false, kind: r.lossless ? 'copy' : 'preview', remux: true,
        });
      }
      return live;
    },
    stopConversions: () => void bridge.cancelConversions(),
    discard(c) {
      const { tmp } = c as NativeConverted;
      if (tmp) bridge.discard(tmp);
    },

    canReplace: () => true,

    async replace(m) {
      const c = m.converted!;
      const { abs, name, trashed } = await call(bridge.replace(m.abs, c.tmp!));
      m.path = m.path.slice(0, -m.name.length) + name;
      m.name = name;
      m.abs = abs;
      c.url = `${mediaUrl(abs)}?v=${Date.now()}`;
      return trashed ? `Original remplacé : ${name} (ancien fichier dans la corbeille)` : `Original remplacé : ${name}`;
    },

    async save(m) {
      const saved = await call(bridge.saveAs(m.abs, m.converted!.tmp!));
      return saved && `Enregistré : ${saved}`;
    },

    async videoDecoding() {
      const status = await call(bridge.videoDecode());
      return status.startsWith('enabled') ? 'disponible' : `désactivé (${status})`;
    },

    editor: {
      canEdit: m => isEditable(m.name),
      async rotate(m, turns) {
        await call(bridge.rotate(m.abs, turns));
        m.rev++;
      },
      async denoise(m, progress) {
        const { tmp, size } = await call(bridge.denoise(m.abs, progress));
        return { tmp, size, url: mediaUrl(tmp), saved: false, kind: 'denoised' };
      },
    },
  };
}
