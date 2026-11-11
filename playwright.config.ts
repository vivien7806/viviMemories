import { defineConfig, devices } from '@playwright/test';

// `npm run test:e2e` compile d'abord (dist/web et dist/app).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  timeout: 60_000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  // Adresse IP explicite : avec « localhost », la vérification de Playwright essaie aussi
  // 127.0.0.1 et reste bloquée ~2 min sous WSL avant de démarrer le serveur.
  webServer: {
    command: 'npx vite preview --host ::1 --port 4173 --strictPort',
    url: 'http://[::1]:4173',
  },
  projects: [
    { name: 'web', testMatch: 'web.spec.ts', use: { ...devices['Desktop Chrome'], baseURL: 'http://[::1]:4173' } },
    { name: 'electron', testMatch: 'electron.spec.ts' },
  ],
});
