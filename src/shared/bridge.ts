import type { MediaType } from './media';

// API exposée par le preload d'Electron sous window.vivi
export interface NativeEntry {
  abs: string;
  path: string;
  name: string;
  type: MediaType;
  date: number;
}

export interface ViviBridge {
  chooseFolder(): Promise<string | null>;
  scan(paths: string[], onProgress: (found: number, analyzed: number) => void): Promise<NativeEntry[]>;
  pathOf(file: File): string;
  onOpen(cb: (paths: string[]) => void): void;
  probe(abs: string): Promise<{ duration: number; remux: boolean }>;
  remux(abs: string, date: string, onProgress: (p: number) => void): Promise<{ tmp: string; size: number; lossless: boolean } | null>;
  denoise(abs: string, onProgress: (p: number) => void): Promise<{ tmp: string; size: number }>;
  rotate(abs: string, turns: number): Promise<void>;
  cancelConversions(): Promise<void>;
  discard(tmp: string): Promise<void>;
  replace(abs: string, tmp: string): Promise<{ abs: string; name: string; trashed: boolean }>;
  saveAs(abs: string, tmp: string): Promise<string | null>;
  videoDecode(): Promise<string>;
}

export const MEDIA_SCHEME = 'media';
export const LIVE_HOST = 'live';
export const mediaUrl = (abs: string) => `${MEDIA_SCHEME}://local/${encodeURIComponent(abs)}`;
// encode : réencoder l'image même si elle pourrait être copiée
export const liveUrl = (abs: string, encode: boolean) =>
  `${MEDIA_SCHEME}://${LIVE_HOST}/${encodeURIComponent(abs)}?encode=${encode ? 1 : 0}`;
