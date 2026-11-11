import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FFMPEG, FIXTURES, ORDER, makeFixtures } from '../fixtures';

// Images décodées : identiques si l'image a été copiée sans réencodage
const framesHash = (file: string) => execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'md5', '-']).toString();

const filesOf = (dir: string) => FIXTURES.filter(f => existsSync(join(dir, f.path))).map(f => ({
  path: f.path.split(sep).join('/'),
  b64: readFileSync(join(dir, f.path)).toString('base64'),
  lastModified: Date.parse(f.date),
}));

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());   // pas de ffmpeg.wasm
  await page.goto('/');
  await page.locator('#autoConvert').uncheck();
});

async function dropFolder(page: Page) {
  const dt = await page.evaluateHandle(files => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.path.split('/').pop()!, { lastModified: f.lastModified }));
    }
    return dt;
  }, filesOf(makeFixtures()));
  await page.dispatchEvent('#dropzone', 'drop', { dataTransfer: dt });
}

const meta = (page: Page) => ({ name: page.locator('#metaName'), info: page.locator('#metaInfo') });
const N = ORDER.length;

async function goTo(page: Page, n: number) {
  await page.keyboard.press('g');
  await page.locator('#gotoNum').fill(String(n));
  await page.keyboard.press('Enter');
  await expect(meta(page).name).toHaveText(ORDER[n - 1]);
}

test('ouvre un dossier glissé, trié par date de prise de vue', async ({ page }) => {
  await dropFolder(page);
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(meta(page).name).toHaveText('photo-exif.jpg');                  // date EXIF
  await expect(meta(page).info).toContainText(`1 / ${N}`);
  await expect.poll(() => page.locator('#stage img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  await goTo(page, 3);                                                           // date de création du .mov
});

test('navigue au clavier, lit une vidéo et va à un numéro', async ({ page }) => {
  await dropFolder(page);
  await expect(meta(page).name).toHaveText(ORDER[0]);

  await page.keyboard.press('ArrowRight');
  await expect(meta(page).name).toHaveText(ORDER[1]);

  await goTo(page, ORDER.indexOf('clip.webm') + 1);
  await expect.poll(() => page.locator('#stage video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0);

  await goTo(page, ORDER.indexOf('b.png') + 1);
  await expect(meta(page).info).toContainText(`${ORDER.indexOf('b.png') + 1} / ${N}`);

  await page.keyboard.press('Escape');
  await expect(page.locator('#landing')).toBeVisible();
});

test('signale une vidéo illisible et propose la conversion', async ({ page }) => {
  await dropFolder(page);
  await expect(meta(page).name).toHaveText(ORDER[0]);
  await page.keyboard.press('ArrowLeft');                    // boucle : dernier média
  await expect(meta(page).name).toHaveText(ORDER[N - 1]);
  await page.keyboard.press('ArrowLeft');
  await expect(meta(page).name).toHaveText('h264.avi');
  await expect(page.locator('.notice')).toContainText('Format non pris en charge : h264.avi');
  await expect(page.locator('.notice button')).toHaveText('Convertir en .mp4');
});

test('lit à la volée un .mts sans rien télécharger, puis propose la copie sans perte', async ({ page }) => {
  await dropFolder(page);
  await expect(meta(page).name).toHaveText(ORDER[0]);
  await goTo(page, ORDER.indexOf('cam.mts') + 1);
  await expect.poll(() => page.locator('#stage video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBe(320);
  await expect(page.locator('#stage video')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('#convertText')).toContainText('à la place de cam.mts', { timeout: 15_000 });
  await expect(page.locator('.notice')).toHaveCount(0);

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#downloadBtn').click()]);
  expect(download.suggestedFilename()).toBe('cam.mp4');
  const saved = await download.path();
  const original = join(makeFixtures(['cam.mts']), 'cam.mts');
  expect(framesHash(saved)).toBe(framesHash(original));
  expect(spawnSync(FFMPEG, ['-hide_banner', '-i', saved]).stderr.toString()).toMatch(/creation_time\s+: 2020-05-02T10:00:00/);
});

// Remplit l'OPFS et fait renvoyer sa racine par showDirectoryPicker (après release() si différé).
const fillOpfs = (page: Page, dir: string, deferred = false) => page.evaluate(async ({ files, deferred }) => {
  const root = await navigator.storage.getDirectory();
  for (const f of files) {
    const parts = f.path.split('/');
    const name = parts.pop()!;
    let d = root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    const out = await (await d.getFileHandle(name, { create: true })).createWritable();
    await out.write(Uint8Array.from(atob(f.b64), c => c.charCodeAt(0)));
    await out.close();
  }
  const w = window as typeof window & { release?: () => void };
  window.showDirectoryPicker = () => new Promise(resolve => {
    if (deferred) w.release = () => resolve(root); else resolve(root);
  });
}, { files: filesOf(dir), deferred });

test('refuse un autre dossier tant que le premier se charge', async ({ page }) => {
  await fillOpfs(page, makeFixtures(['b.png', 'clip.webm']), true);
  await page.locator('#pickBtn').click();
  await expect(page.locator('#pickBtn')).toBeDisabled();

  await dropFolder(page);                                                      // ignoré
  await page.evaluate(() => (window as typeof window & { release: () => void }).release());
  await expect(meta(page).info).toContainText('1 / 2');
  await expect(page.locator('#pickBtn')).toBeEnabled();
});

test('parcourt un dossier choisi avec le sélecteur (sous-dossiers compris)', async ({ page }) => {
  await fillOpfs(page, makeFixtures());
  await page.locator('#pickBtn').click();
  await expect(meta(page).info).toContainText(`/ ${N}`);
  const seen = new Set<string>();
  for (let i = 0; i < N; i++) {
    seen.add((await meta(page).name.textContent())!);
    await page.keyboard.press('ArrowRight');
    await expect(meta(page).info).toContainText(`${(i + 1) % N + 1} / ${N}`);
  }
  expect([...seen].sort()).toEqual(ORDER.map(n => n === 'a.jpg' ? '2020/a.jpg' : n).sort());
});

test('bascule entre vidéos seulement, photos seulement et tout', async ({ page }) => {
  const videos = ORDER.filter(n => !/\.(jpg|png)$/.test(n));
  const photos = ORDER.filter(n => /\.(jpg|png)$/.test(n));
  await dropFolder(page);
  await expect(meta(page).name).toHaveText(ORDER[0]);
  await page.keyboard.press(' ');                                              // pause

  await page.keyboard.press('v');                                              // vidéo suivante par date
  await expect(meta(page).name).toHaveText(videos[0]);
  await expect(meta(page).info).toContainText(`1 / ${videos.length} vidéos seulement`);
  await page.keyboard.press('ArrowRight');
  await expect(meta(page).name).toHaveText(videos[1]);

  await page.keyboard.press('v');                                              // photo suivante par date
  await expect(meta(page).name).toHaveText('b.png');
  await expect(meta(page).info).toContainText(`${photos.indexOf('b.png') + 1} / ${photos.length} photos seulement`);

  await page.locator('#filterBtn').click();                                    // tout : reste sur la même photo
  await expect(meta(page).name).toHaveText('b.png');
  await expect(meta(page).info).toContainText(`${ORDER.indexOf('b.png') + 1} / ${N} ·`);
});

test('zoome à la molette, Échap dézoome sans fermer, + accélère', async ({ page }) => {
  await dropFolder(page);
  await expect(meta(page).name).toHaveText(ORDER[0]);
  await page.keyboard.press(' ');                                              // pause

  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -300);
  await expect(page.locator('#stage')).toHaveClass(/zoomed/);
  await expect(page.locator('#zoomLevel')).toContainText('%');
  expect(await page.locator('#stage img').evaluate(img => (img as HTMLElement).style.transform)).toContain('scale(');

  await page.keyboard.press('Escape');
  await expect(page.locator('#stage')).not.toHaveClass(/zoomed/);
  await expect(page.locator('#viewer')).toBeVisible();

  await page.keyboard.press('+');
  await expect(page.locator('#toast')).toContainText('Photos : 3 s par image');
});
