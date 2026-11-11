import { isVideoEl, ui, type Shown } from './dom';
import type { Platform } from './platform';

// Infos de lecture (touche I) : résolution, images perdues, décodage matériel.
export function createStats(platform: Platform, node: () => Shown | null) {
  let timer = 0;
  let decoding: Promise<string | null> | null = null;

  async function update() {
    const el = node();
    if (!el) return;
    const parts = isVideoEl(el) ? [`${el.videoWidth}×${el.videoHeight}`] : [`${el.naturalWidth}×${el.naturalHeight}`];
    if (isVideoEl(el)) {
      const q = el.getVideoPlaybackQuality();
      const lost = q.droppedVideoFrames, total = q.totalVideoFrames;
      parts.push(`images perdues : ${lost} / ${total}` + (total ? ` (${(lost / total * 100).toFixed(1)} %)` : ''));
      const hw = await decoding;
      if (hw) parts.push(`décodage matériel : ${hw}`);
    }
    if (el === node()) ui.stats.textContent = parts.join(' · ');
  }

  function hide() {
    ui.stats.hidden = true;
    clearInterval(timer);
  }

  function toggle() {
    if (!ui.stats.hidden) return hide();
    ui.stats.hidden = false;
    decoding ??= platform.videoDecoding().catch(() => null);
    update();
    timer = setInterval(update, 1000);
  }

  return { toggle, hide };
}
