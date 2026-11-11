import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';
import { ORDER, makeFixtures } from '../fixtures';

let app: ElectronApplication;
let page: Page;
let dir: string;

const N = ORDER.length;
const pathOf = (name: string) => name === 'a.jpg' ? join('2020', 'a.jpg') : name;

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

const root = join(__dirname, '../..');

// Profil propre à chaque test : sinon le verrou d'instance unique ferme les lancements en parallèle.
async function launch(args: string[], profile = temp('vivimemories-profile-')) {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${profile}`, ...args],
    cwd: root,
    // Corbeille isolée : les tests ne touchent pas celle de l'utilisateur.
    env: { ...process.env, XDG_DATA_HOME: temp('vivimemories-xdg-') },
  });
  page = await app.firstWindow();
}

test.beforeEach(() => { dir = makeFixtures(); });
test.afterEach(async () => { await app?.close(); });

const meta = () => ({ name: page.locator('#metaName'), info: page.locator('#metaInfo') });

async function goTo(name: string) {
  await expect(meta().info).toContainText(`/ ${N}`);
  await page.keyboard.press('g');
  await page.locator('#gotoNum').fill(String(ORDER.indexOf(name) + 1));
  await page.keyboard.press('Enter');
  await expect(meta().name).toHaveText(pathOf(name));
}

const video = () => page.locator('#stage video');
const videoWidth = () => video().evaluate((v: HTMLVideoElement) => v.videoWidth);

test('ouvre directement le dossier passé en argument, trié par date de prise de vue', async () => {
  await launch([dir]);
  await expect(meta().name).toHaveText('photo-exif.jpg');
  await expect(meta().info).toContainText(`1 / ${N}`);
  await expect.poll(() => page.locator('#stage img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);

  await goTo('clip.mov');                                    // lu tel quel, sans préparation
  await expect.poll(videoWidth).toBe(320);
  await expect(page.locator('.notice')).toHaveCount(0);
});

test('affiche les infos de lecture avec la touche I', async () => {
  await launch([dir]);
  await goTo('clip.mp4');
  await expect.poll(videoWidth).toBe(320);
  await page.keyboard.press('i');
  await expect(page.locator('#stats')).toContainText('320×240 · images perdues :');
  await expect(page.locator('#stats')).toContainText(/décodage matériel : (disponible|désactivé)/);
});

// Capture du README : animations figées, le fichier ne change que si la page change.
const SCREENSHOT_QUALITY = 85;

test('affiche la page d’accueil', async () => {
  await launch([]);
  await expect(page.locator('#pickBtn')).toBeVisible();
  await page.screenshot({ path: join(root, 'docs', 'accueil.jpg'), type: 'jpeg', quality: SCREENSHOT_QUALITY, animations: 'disabled' });
});

test('choisit un dossier avec la fenêtre native', async () => {
  await launch([]);
  await expect(page.locator('#convertOption')).toBeHidden();  // préparation toujours automatique
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, dir);
  await page.locator('#pickBtn').click();
  await expect(meta().info).toContainText(`1 / ${N}`);
});

test('une deuxième ouverture passe le dossier à la fenêtre existante', async () => {
  const profile = temp('vivimemories-profile-');
  await launch([dir], profile);
  await expect(meta().info).toContainText(`1 / ${N}`);

  const other = makeFixtures(['b.png']);
  execFileSync(electronPath as unknown as string, ['.', `--user-data-dir=${profile}`, other], { cwd: root, timeout: 20_000 });
  await expect(meta().info).toContainText('1 / 1');
  await expect(meta().name).toHaveText('b.png');
});

test('remuxe sans perte un .mts et remplace l’original', async () => {
  await launch([dir]);
  await goTo('cam.mts');
  await page.keyboard.press(' ');                            // pause : le clip d'1 s passerait au suivant
  await expect(page.locator('#convertText')).toContainText('Copie sans perte en .mp4', { timeout: 30_000 });
  await expect.poll(videoWidth).toBe(320);

  const mtime = statSync(join(dir, 'cam.mts')).mtimeMs;
  await page.locator('#replaceBtn').click();
  await expect(page.locator('#toast')).toContainText('Original remplacé : cam.mp4');
  await expect(meta().name).toHaveText('cam.mp4');
  await expect(page.locator('#convertBar')).toBeHidden();
  expect(existsSync(join(dir, 'cam.mts'))).toBe(false);
  expect(statSync(join(dir, 'cam.mp4')).mtimeMs).toBe(mtime);
});

test('lit un .avi H.264 avec son PCM, passé en FLAC', async () => {
  await launch([dir]);
  await goTo('h264.avi');
  await page.keyboard.press(' ');                            // pause : le clip d'1 s passerait au suivant
  await expect(page.locator('#convertText')).toContainText('Copie sans perte', { timeout: 30_000 });
  await expect.poll(videoWidth).toBe(320);
  await expect.poll(() => video().evaluate((v: HTMLVideoElement & { webkitAudioDecodedByteCount: number }) =>
    v.webkitAudioDecodedByteCount)).toBeGreaterThan(0);
});

test('affiche un codec illisible via un aperçu, sans toucher à l’original', async () => {
  await launch([dir]);
  await goTo('old.avi');
  await expect(meta().info).toContainText('aperçu réencodé, original intact', { timeout: 30_000 });
  await expect.poll(videoWidth).toBe(320);
  await expect(page.locator('#convertBar')).toBeHidden();
  expect(existsSync(join(dir, 'old.avi'))).toBe(true);
});

test('prépare d’avance la vidéo illisible suivante', async () => {
  await launch([dir]);
  await goTo('b.png');
  await page.keyboard.press(' ');                                              // pause
  await page.waitForTimeout(1500);                                             // préchargement
  await page.keyboard.press('ArrowRight');
  await expect(meta().name).toHaveText('old.avi');
  await expect(video()).toHaveAttribute('src', /^media:\/\/live\//, { timeout: 500 });
  await expect.poll(videoWidth).toBe(320);
  await expect(page.locator('.notice')).toHaveCount(0);
});

test('pivote une vidéo sans réencodage, seulement après confirmation', async () => {
  await launch([dir]);
  await goTo('clip.mp4');
  await expect.poll(videoWidth).toBe(320);
  const file = join(dir, 'clip.mp4');
  const before = readFileSync(file);
  const { mtimeMs } = statSync(file);

  await page.keyboard.press('r');
  await page.keyboard.press('r');
  await expect(page.locator('#rotateText')).toHaveText('Rotation de 180° : écraser clip.mp4 ?');
  await page.locator('#rotateCancel').click();
  await expect(page.locator('#rotateBar')).toBeHidden();

  await page.keyboard.press('r');
  await expect(page.locator('#rotateText')).toHaveText('Rotation de 90° : écraser clip.mp4 ?');
  expect(readFileSync(file).equals(before)).toBe(true);    // rien d'écrit avant confirmation
  await page.locator('#rotateSave').click();
  await expect(page.locator('#toast')).toContainText('Rotation enregistrée dans clip.mp4');
  await expect(page.locator('#rotateBar')).toBeHidden();
  await expect.poll(videoWidth).toBe(240);                  // Chromium applique la nouvelle rotation
  expect(statSync(file).size).toBe(before.length);
  expect(statSync(file).mtimeMs).toBe(mtimeMs);
});

test('filtre le bruit du vent : aperçu, puis annuler ou remplacer l’original', async () => {
  await launch([dir]);
  await goTo('wind.mp4');
  const file = join(dir, 'wind.mp4');
  const before = readFileSync(file);
  const { mtimeMs } = statSync(file);

  await page.keyboard.press('w');
  await expect(page.locator('#convertText')).toContainText('Son sans vent', { timeout: 30_000 });
  await expect(video()).not.toHaveAttribute('src', /wind/);                // aperçu filtré à l'écran
  await page.locator('#cancelBtn').click();
  await expect(page.locator('#convertBar')).toBeHidden();
  await expect(video()).toHaveAttribute('src', /wind\.mp4/);
  expect(readFileSync(file).equals(before)).toBe(true);

  await page.locator('#windBtn').click();
  await expect(page.locator('#convertText')).toContainText('Son sans vent', { timeout: 30_000 });
  await page.locator('#replaceBtn').click();
  await expect(page.locator('#toast')).toContainText('Original remplacé : wind.mp4');
  await expect(page.locator('#convertBar')).toBeHidden();
  expect(readFileSync(file).equals(before)).toBe(false);
  expect(statSync(file).mtimeMs).toBe(mtimeMs);
});

test('refuse de pivoter une photo ou une vidéo qui n’est pas en .mp4 / .mov', async () => {
  await launch([dir]);
  await goTo('b.png');
  await expect(page.locator('#rotateBtn')).toBeHidden();
  await page.keyboard.press('r');
  await expect(page.locator('#toast')).toContainText('vidéos seulement');
  await goTo('clip.webm');
  await page.keyboard.press('r');
  await expect(page.locator('#toast')).toContainText('.mp4 et .mov seulement');
  await expect(page.locator('#rotateBar')).toBeHidden();
});
