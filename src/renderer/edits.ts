import { clamp, errMsg, toast, ui, type Shown } from './dom';
import type { Converted, Media, Platform } from './platform';
import type { Stage } from './stage';

const QUARTER = 4;
const QUARTER_DEG = 90;
const ERROR_TOAST = 4000;

interface Deps {
  platform: Platform;
  stage: Stage;
  enqueue(job: () => Promise<Converted>): Promise<Converted>;
}

/* Vidéo mal prise : rotation (R) et filtre anti-vent (W). Chaque modification passe d'abord par
   un aperçu ; l'original n'est écrasé qu'après confirmation dans la barre. */
export function createEdits({ platform, stage, enqueue }: Deps) {
  const { editor } = platform;
  const turns = new Map<Media, number>();          // quarts de tour horaires pas encore enregistrés
  const denoising = new Set<Media>();

  function blocker(m: Media) {
    if (!editor) return 'Rotation et filtre : dans l’application seulement';
    if (m.type !== 'video') return 'Rotation et filtre : vidéos seulement';
    if (!editor.canEdit(m)) return 'Rotation et filtre : fichiers .mp4 et .mov seulement';
    if (m.converted?.kind === 'preview') return 'Vidéo lue via un aperçu : modification impossible';
    if (m.converted && !m.converted.saved) {
      return m.converted.kind === 'denoised' ? 'Remplace l’original ou annule d’abord le filtre' : 'Remplace d’abord l’original';
    }
    if (denoising.has(m)) return 'Filtre anti-vent en cours';
    return null;
  }

  // Appelé à chaque média affiché : aperçu de la rotation en attente et barre de confirmation.
  function show(m: Media, node: Shown) {
    ui.rotateBtn.hidden = ui.windBtn.hidden = !editor || m.type !== 'video';
    const t = turns.get(m) ?? 0;
    node.style.rotate = t ? `${t * QUARTER_DEG}deg` : '';
    node.classList.toggle('sideways', t % 2 === 1);
    ui.rotateBar.hidden = !t;
    ui.rotateText.textContent = `Rotation de ${t * QUARTER_DEG}° : écraser ${m.name} ?`;
  }

  function rotate() {
    const m = stage.shown, node = stage.node;
    if (!m || !node) return;
    const why = blocker(m);
    if (why) return toast(why, ERROR_TOAST);
    const t = ((turns.get(m) ?? 0) + 1) % QUARTER;
    if (t) turns.set(m, t); else turns.delete(m);
    show(m, node);
  }

  ui.rotateSave.addEventListener('click', async () => {
    const m = stage.shown!;
    ui.rotateSave.disabled = true;
    try {
      await editor!.rotate(m, turns.get(m)!);
      turns.delete(m);
      ui.rotateBar.hidden = true;
      m.converted = null;                            // version déjà enregistrée : c'est l'original
      stage.forget(m);
      stage.reload();
      toast(`Rotation enregistrée dans ${m.name}`, 2500);
    } catch (err) {
      toast(`Rotation impossible : ${errMsg(err)}`, ERROR_TOAST);
    }
    ui.rotateSave.disabled = false;
    ui.rotateSave.blur();
  });

  ui.rotateCancel.addEventListener('click', () => {
    ui.rotateCancel.blur();
    turns.delete(stage.shown!);
    if (stage.node) show(stage.shown!, stage.node);
  });

  // Le son filtré remplace l'original à l'écran ; la barre de conversion propose de l'enregistrer.
  async function denoise() {
    const m = stage.shown;
    if (!m) return;
    const why = blocker(m) ?? (turns.has(m) ? 'Enregistre ou annule d’abord la rotation' : null);
    if (why) return toast(why, ERROR_TOAST);
    denoising.add(m);
    const label = `Filtre anti-vent : ${m.name}`;
    toast(`${label}…`);
    try {
      const c = await enqueue(() => editor!.denoise(m, p => toast(`${label} ${Math.round(clamp(p, 0, 1) * 100)} %`)));
      m.converted = c;
      if (stage.shown === m) stage.reload();
      toast(`${label} : aperçu prêt`, 2500);
    } catch (err) {
      toast(`Filtre impossible : ${errMsg(err)}`, ERROR_TOAST);
    }
    denoising.delete(m);
  }

  ui.rotateBtn.addEventListener('click', rotate);
  ui.windBtn.addEventListener('click', denoise);

  function stop() {
    turns.clear();
    denoising.clear();
    ui.rotateBar.hidden = true;
  }

  return { show, rotate, denoise, stop };
}
