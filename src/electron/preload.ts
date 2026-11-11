import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ViviBridge } from '../shared/bridge';

let seq = 0;

// Tâche longue : son avancement arrive par messages « progress » portant son numéro.
function withProgress<T>(channel: string, onProgress: (...values: number[]) => void, ...args: unknown[]): Promise<T> {
  const id = ++seq;
  const listener = (_e: unknown, from: number, ...values: number[]) => { if (from === id) onProgress(...values); };
  ipcRenderer.on('progress', listener);
  return ipcRenderer.invoke(channel, id, ...args)
    .finally(() => ipcRenderer.removeListener('progress', listener));
}

const bridge: ViviBridge = {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  scan: (paths, onProgress) => withProgress('scan', onProgress, paths),
  pathOf: file => webUtils.getPathForFile(file),
  onOpen(cb) {
    ipcRenderer.on('open', (_e, paths: string[]) => cb(paths));
    ipcRenderer.send('ready');
  },
  probe: abs => ipcRenderer.invoke('probe', abs),
  remux: (abs, date, onProgress) => withProgress('remux', onProgress, abs, date),
  denoise: (abs, onProgress) => withProgress('denoise', onProgress, abs),
  rotate: (abs, turns) => ipcRenderer.invoke('rotate', abs, turns),
  cancelConversions: () => ipcRenderer.invoke('cancel'),
  discard: tmp => ipcRenderer.invoke('discard', tmp),
  replace: (abs, tmp) => ipcRenderer.invoke('replace', abs, tmp),
  saveAs: (abs, tmp) => ipcRenderer.invoke('save-as', abs, tmp),
  videoDecode: () => ipcRenderer.invoke('video-decode'),
};

contextBridge.exposeInMainWorld('vivi', bridge);
