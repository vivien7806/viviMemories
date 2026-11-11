import { app, BrowserWindow, dialog, ipcMain, protocol, type WebContents } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseOf } from '../shared/media';
import { MEDIA_SCHEME } from '../shared/bridge';
import { allow, inside, isAllowed, replace, saveCopy, scan, serve } from './files';
import { cancelAll, denoise, probe, remux } from './ffmpeg';
import { rotate } from './rotate';

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Dossiers passés en argument : `vivimemories <dossier>` ou « Ouvrir avec » dans l'explorateur.
// En développement (`electron . <dossier>`), le chemin de l'application figure aussi parmi les arguments.
const pathsFrom = (argv: string[], cwd: string) => argv.slice(1)
  .filter(a => a && !a.startsWith('-'))
  .map(a => a.startsWith('file://') ? fileURLToPath(a) : resolve(cwd, a))
  .filter(p => p !== app.getAppPath());

let win: BrowserWindow | null = null;
let ready = false;
let pending = pathsFrom(process.argv, process.cwd());

function openPaths(paths: string[]) {
  if (!paths.length) return;
  if (ready && win) win.webContents.send('open', paths);
  else pending = paths;
}

const tmpDir = mkdtempSync(join(tmpdir(), 'vivimemories-'));
allow(tmpDir);

// Avancement d'une tâche longue, perdu si la fenêtre est déjà fermée (l'envoi lèverait une exception).
const progressTo = (sender: WebContents, id: number) => (...values: number[]) => {
  if (!sender.isDestroyed()) sender.send('progress', id, ...values);
};

// La page ne peut désigner que des fichiers des dossiers ouverts et des conversions en cours.
function check(abs: string, tmp?: string) {
  if (!isAllowed(abs) || (tmp !== undefined && !inside(tmpDir, tmp))) throw new Error('fichier non autorisé');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800,
    backgroundColor: '#0a0908',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; ready = false; });
  // `vivimemories --gpu-info` : état détaillé de l'accélération matérielle
  if (process.argv.includes('--gpu-info')) win.loadURL('chrome://gpu');
  else win.loadFile(join(__dirname, '../../web/index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    openPaths(pathsFrom(argv, cwd));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    protocol.handle(MEDIA_SCHEME, serve);

    ipcMain.on('ready', e => {
      ready = true;
      if (pending.length) e.sender.send('open', pending);
      pending = [];
    });
    ipcMain.handle('choose-folder', async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('scan', (e, id: number, paths: string[]) => scan(paths, progressTo(e.sender, id)));
    ipcMain.handle('probe', (_e, abs: string) => {
      check(abs);
      return probe(abs);
    });
    ipcMain.handle('remux', (e, id: number, abs: string, date: string) => {
      check(abs);
      return remux(abs, date, tmpDir, progressTo(e.sender, id));
    });
    ipcMain.handle('denoise', (e, id: number, abs: string) => {
      check(abs);
      return denoise(abs, tmpDir, progressTo(e.sender, id));
    });
    ipcMain.handle('rotate', (_e, abs: string, turns: number) => {
      check(abs);
      return rotate(abs, turns);
    });
    ipcMain.handle('cancel', () => cancelAll());
    ipcMain.handle('video-decode', () => app.getGPUFeatureStatus().video_decode);
    ipcMain.handle('discard', async (_e, tmp: string) => {
      if (inside(tmpDir, tmp)) await rm(tmp, { force: true }).catch(() => {});
    });
    ipcMain.handle('replace', (_e, abs: string, tmp: string) => {
      check(abs, tmp);
      return replace(abs, tmp);
    });
    ipcMain.handle('save-as', async (_e, abs: string, tmp: string) => {
      check(abs, tmp);
      const ext = extname(tmp);
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: join(dirname(abs), baseOf(basename(abs)) + ext),
        filters: [{ name: 'Vidéo', extensions: [ext.slice(1)] }],
      });
      if (r.canceled || !r.filePath) return null;
      await saveCopy(tmp, r.filePath, abs);
      return r.filePath;
    });

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    cancelAll();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
}
