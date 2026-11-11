import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Page isolée : ffmpeg.wasm peut alors utiliser plusieurs cœurs (SharedArrayBuffer).
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// Un seul fichier HTML autonome : il s'ouvre aussi bien en file://, sur un serveur
// web, que dans la fenêtre Electron.
export default defineConfig({
  base: './',
  server: { headers: ISOLATION },
  preview: { headers: ISOLATION },
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist/web',
    target: 'es2022',      // garde async/await natifs : le worker ffmpeg est sérialisé avec toString()
  },
});
