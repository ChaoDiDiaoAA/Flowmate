import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const workspacePackages = ['@flowmate/contracts', '@flowmate/core', '@flowmate/runtime-pi', '@flowmate/shared'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: { rollupOptions: { input: { index: resolve(root, 'apps/desktop/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'apps/desktop/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'apps/desktop/renderer'),
    plugins: [react()],
    resolve: { alias: { '@renderer': resolve(root, 'apps/desktop/renderer/src') } },
    build: {
      outDir: resolve(root, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(root, 'apps/desktop/renderer/index.html') },
    },
  },
});
