import { defineConfig } from 'vite';

const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  // Static-only build — no backend, no tracking, no auth.
  // PMTiles + search indexes are loaded from public/ at runtime
  // or from an R2/CDN URL configured at build time.
  base,
  build: {
    outDir: 'docs',
    target: 'es2022',
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
});
