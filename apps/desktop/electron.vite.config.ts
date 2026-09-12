import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  main: { build: { rollupOptions: { input: resolve(appRoot, "src/main/index.ts"), external: [/^@flowmate\//] } } },
  preload: { build: { rollupOptions: { input: resolve(appRoot, "src/preload/index.ts"), output: { format: "cjs", entryFileNames: "index.cjs" } } } },
  renderer: {
    root: resolve(appRoot, "src/renderer"),
    build: { rollupOptions: { input: resolve(appRoot, "src/renderer/index.html") } },
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
  },
});
