import type { MediaType } from '../shared/media';
import type { ViviBridge } from '../shared/bridge';

// copy : remux sans perte · converted : réencodé, remplacement proposé · preview : affichage seulement
// denoised : son filtré (vent), remplacement proposé ou annulation
export interface Converted {
  url: string;
  size: number;
  saved: boolean;
  kind: 'copy' | 'converted' | 'preview' | 'denoised';
  duration?: number;     // lue à la volée : la vidéo ne connaît pas sa durée
  remux?: boolean;       // image copiée telle quelle : si elle reste illisible, on la réencode
  attach?(v: HTMLVideoElement): void;    // flux à brancher sur la vidéo (MediaSource), à la place de url
  later?: Promise<Converted | null>;     // fichier complet, préparé pendant la lecture à la volée
}

export interface ConvertOptions {
  status: Status;
  progress(p: number): void;
  retry: boolean;        // la copie est illisible elle aussi : réencoder
  download: boolean;     // téléchargement de ffmpeg.wasm permis
}

// La conversion demanderait de télécharger ffmpeg.wasm, ce qui n'est pas permis.
export class NeedsDownload extends Error {}

export interface Media {
  name: string;
  path: string;       // relatif au dossier choisi
  type: MediaType;
  date: Date;
  converted: Converted | null;
}

export type Status = (text: string) => void;

// Modifications d'une vidéo (.mp4, .mov) : Electron seulement.
export interface Editor<M extends Media = Media> {
  canEdit(m: M): boolean;
  rotate(m: M, turns: number): Promise<void>;        // quarts de tour horaires, sur place
  denoise(m: M, progress: (p: number) => void): Promise<Converted>;
}
export type Scan<M extends Media = Media> = (status: Status) => Promise<M[] | null>;

// Ce qui diffère entre le navigateur et Electron. Méthodes sans `this`, utilisables détachées.
export interface Platform<M extends Media = Media> {
  convertOption: string | null;      // null : rien à télécharger, pas d'option
  converting: string;
  saveLabel: string;
  pickFolder(status: Status): Promise<M[] | null>;
  fromDrop(files: File[]): Scan<M>;
  onOpen(open: (scan: Scan<M>) => void): void;
  url(m: M): string;
  release(url: string): void;
  // Résout dès que la vidéo peut être lue à la volée.
  convert(m: M, options: ConvertOptions): Promise<Converted>;
  stopConversions(): void;
  discard(c: Converted): void;
  canReplace(m: M): boolean;
  replace(m: M): Promise<string>;
  save(m: M): Promise<string | null>;
  videoDecoding(): Promise<string | null>;   // null : inconnu (navigateur)
  editor: Editor<M> | null;
}

// Chargement d'un dossier : médias trouvés, puis dates lues
export const scanStatus = (found: number, analyzed: number) => analyzed
  ? `Analyse des dates : ${analyzed} / ${found}`
  : `Lecture du dossier… ${found} média(s) trouvé(s)`;

export const folderOf = (m: Media) => m.path.slice(0, -m.name.length) || 'le dossier choisi';

declare global {
  interface Window {
    vivi?: ViviBridge;
    showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
}
