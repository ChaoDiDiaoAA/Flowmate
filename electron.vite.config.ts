import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const workspacePackages = ['@flowmate/contracts', '@flowmate/core', '@flowmate/runtime-pi', '@flowmate/shared'];

export default defineConfig({
  main: {
    envDir: false,
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: { rollupOptions: { input: { index: resolve(root, 'apps/desktop/main/entry.ts') },
      output: { entryFileNames: 'index.js', chunkFileNames: 'chunks/[name].js', assetFileNames: '[name][extname]' } } },
  },
  preload: {
    envDir: false,
    plugins: [externalizeDepsPlugin({ exclude: [...workspacePackages, 'zod'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'apps/desktop/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  renderer: {
    envDir: false,
    root: resolve(root, 'apps/desktop/renderer'),
    plugins: [react()],
    resolve: { alias: { '@renderer': resolve(root, 'apps/desktop/renderer/src') } },
    build: {
      outDir: resolve(root, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(root, 'apps/desktop/renderer/index.html'),
        output: { entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } },
    },
  },
});
