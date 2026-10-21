import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'client',
  build: {
    outDir: '../build/client', emptyOutDir: true,
    rollupOptions: { input: { game: fileURLToPath(new URL('./client/index.html', import.meta.url)), lounge: fileURLToPath(new URL('./client/lounge-demo.html', import.meta.url)) } },
  },
});
