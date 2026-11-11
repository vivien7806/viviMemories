import { clamp, errMsg, isVideoEl, make, toast, ui, type Shown } from './dom';
import { folderOf, NeedsDownload, type Converted, type Media, type Platform } from './platform';
import type { Stage } from './stage';

// Délais avant de passer au média suivant quand celui-ci reste illisible
const SKIP_IMAGE = 3000;
const SKIP_AFTER_CONVERSION = 4000;
const SKIP_UNCONVERTED = 8000;
const SKIP_FAILED = 12000;
// Préparation automatique : message affiché seulement si elle se prolonge (lecture à la volée quasi immédiate)
const NOTICE_DELAY = 1000;

interface Deps {
  platform: Platform;
  stage: Stage;
  isPlaying(): boolean;
  next(): void;
  updated(m: Media): void;           // nom, chemin ou version lue ont changé
}

/* Média illisible : lu à la volée pendant sa conversion (une à la fois), puis proposition de
   remplacer l'original quand la plateforme le permet. */
export function createConversions({ platform, stage, isPlaying, next, updated }: Deps) {
  const pending = new Map<Media, { promise: Promise<Converted>; say: (text: string) => void }>();
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;                                // change à la fermeture du dossier

  /* Une seule tâche à la fois (conversions et filtres), fichier complet compris ; celles d'un
     dossier fermé ne démarrent pas. */
  function enqueue(job: () => Promise<Converted>) {
    const gen = generation;
    const promise = queue.then(() => gen === generation ? job() : Promise.reject(new Error('dossier fermé')));
    queue = promise.then(c => c.later).catch(() => {});
    return promise;
  }

  const download = () => platform.convertOption === null || ui.autoConvert.checked;
  const retryable = (item: Media) => !item.converted || !!item.converted.remux;
  const started = new Map<Media, number>();         // début de la préparation, toutes tentatives comprises

  /* La nouvelle version remplace la précédente, devenue inutile. Le fichier complet préparé
     pendant la lecture à la volée prend la suite, sans interrompre la vidéo affichée. */
  function use(item: Media, c: Converted) {
    const old = item.converted;
    item.converted = c;
    if (old && old !== c) platform.discard(old);
    const gen = generation;
    c.later?.then(f => {
      if (!f || item.converted !== c || gen !== generation) return;
      use(item, f);
      stage.refreshAround();
      if (stage.shown === item) updateBar();
      updated(item);
    }, () => {});
  }

  // Demander deux fois la même vidéo renvoie la même conversion.
  function convert(item: Media, say: (text: string) => void, download: boolean) {
    const running = pending.get(item);
    if (running) { running.say = say; return running.promise; }

    say('Conversion en attente…');
    const job = { say, promise: null as unknown as Promise<Converted> };
    const status = (text: string) => job.say(text);
    const label = `${platform.converting} ${item.name}…`;
    const progress = (p: number) =>
      status(isFinite(p) && p > 0 ? `${label} ${Math.round(clamp(p, 0, 1) * 100)} %` : label);

    const retry = !!item.converted?.remux;
    job.promise = enqueue(() => platform.convert(item, { status, progress, retry, download }));
    pending.set(item, job);
    job.promise.catch(() => {}).then(() => pending.delete(item));
    return job.promise;
  }

  function showUnreadable(node: Shown, item: Media) {
    if (node.dataset.unreadable) return;
    node.dataset.unreadable = '1';
    if (isVideoEl(node)) node.pause();                 // pas de son sans image

    const box = make('div', 'notice glass mono');
    const msg = make('div', '', `Format non pris en charge : ${item.name}`);
    box.append(msg);
    ui.stage.append(box);

    let skipTimer = 0;
    const skipLater = (ms: number) => {
      skipTimer = setTimeout(() => { if (stage.node === node && isPlaying()) next(); }, ms);
    };
    if (item.type !== 'video') return skipLater(SKIP_IMAGE);

    if (!retryable(item)) {                            // même la version convertie ne passe pas
      msg.textContent += '\n(même après conversion)';
      return skipLater(SKIP_AFTER_CONVERSION);
    }

    const btn = make('button', 'btn small', 'Convertir en .mp4');
    btn.hidden = true;                                 // utile seulement pour télécharger ffmpeg ou réessayer
    box.append(btn);
    const run = async (allowDownload: boolean) => {
      clearTimeout(skipTimer);
      btn.disabled = true;
      btn.blur();
      try {
        use(item, await convert(item, text => { msg.textContent = text; }, allowDownload));
        if (stage.node === node) stage.reload();      // relit avec la version lisible
      } catch (err) {
        box.hidden = false;
        btn.hidden = btn.disabled = false;
        if (err instanceof NeedsDownload) {
          msg.textContent = `Format non pris en charge : ${item.name}`;
          return skipLater(SKIP_UNCONVERTED);
        }
        msg.textContent = `Conversion impossible : ${errMsg(err)}`;
        btn.textContent = 'Réessayer';
        skipLater(SKIP_FAILED);
      }
    };
    btn.addEventListener('click', () => run(true));
    // Toujours automatique : seul le téléchargement de ffmpeg.wasm dépend de l'option.
    if (!item.converted) started.set(item, performance.now());
    const elapsed = performance.now() - (started.get(item) ?? performance.now());
    box.hidden = true;
    setTimeout(() => { box.hidden = false; }, Math.max(0, NOTICE_DELAY - elapsed));
    run(download());
  }

  /* Vidéo voisine illisible : préparée d'avance, puis préchargée dans sa version lisible.
     Electron seulement (sonde rapide) : une conversion dans le navigateur retarderait la vidéo affichée. */
  function prepare(item: Media) {
    if (!retryable(item) || platform.convertOption !== null) return;
    convert(item, () => {}, true).then(c => { use(item, c); stage.refreshAround(); }, () => {});
  }

  // Proposé une fois la nouvelle version à l'image seulement : une copie peut être illisible elle aussi.
  function updateBar() {
    const item = stage.shown, node = stage.node;
    const c = item?.converted;
    const shows = !isVideoEl(node) || (node.readyState >= node.HAVE_CURRENT_DATA && node.videoWidth > 0);
    ui.convertBar.hidden = !item || !c || c.saved || c.kind === 'preview' || !shows;
    if (!item || !c || c.saved || c.kind === 'preview') return;
    if (!shows) return node!.addEventListener('loadeddata', updateBar, { once: true });

    const canReplace = platform.canReplace(item);
    ui.replaceBtn.hidden = !canReplace;
    ui.cancelBtn.hidden = c.kind !== 'denoised';
    // Sans écriture directe (Firefox) : indiquer où enregistrer le fichier pour remplacer l'original.
    const size = `${(c.size / 1e6).toFixed(1)} Mo`;
    const what = { copy: 'Copie sans perte en .mp4', converted: 'Version convertie', denoised: 'Son sans vent' }[c.kind];
    ui.convertText.textContent = canReplace
      ? `${what} (${size}) : remplacer ${item.name} ?`
      : `Version convertie : enregistre-la dans « ${folderOf(item)} » à la place de ${item.name}.`;
  }

  ui.replaceBtn.addEventListener('click', async () => {
    const item = stage.shown!;
    ui.replaceBtn.disabled = true;
    try {
      const message = await platform.replace(item);
      stage.forget(item);                              // l'ancien fichier n'existe plus
      item.converted!.saved = true;
      updated(item);
      toast(message, 2500);
    } catch (err) {
      toast(`Remplacement impossible : ${errMsg(err)}`, 4000);
    }
    ui.replaceBtn.disabled = false;
    ui.replaceBtn.blur();
    updateBar();
  });

  ui.downloadBtn.addEventListener('click', async () => {
    ui.downloadBtn.blur();
    try {
      const message = await platform.save(stage.shown!);
      if (message) toast(message, 5000);
    } catch (err) {
      toast(`Enregistrement impossible : ${errMsg(err)}`, 4000);
    }
  });

  // Abandon du son filtré : retour à l'original, puis le fichier temporaire est libéré.
  ui.cancelBtn.addEventListener('click', async () => {
    const item = stage.shown!;
    const c = item.converted!;
    ui.cancelBtn.blur();
    item.converted = null;
    await stage.reload();
    platform.discard(c);
  });

  // Fermeture du dossier : conversions arrêtées, fichiers convertis libérés.
  function stop(all: readonly Media[]) {
    platform.stopConversions();
    generation++;
    queue = Promise.resolve();
    pending.clear();
    started.clear();
    all.forEach(m => { if (m.converted) platform.discard(m.converted); });
    ui.convertBar.hidden = true;
  }

  return { showUnreadable, prepare, updateBar, stop, enqueue };
}
