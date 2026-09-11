import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  main: { build: { rollupOptions: { input: resolve(appRoot, "src/main/index.ts") } } },
  preload: { build: { rollupOptions: { input: resolve(appRoot, "src/preload/index.ts") } } },
  renderer: {
    root: resolve(appRoot, "src/renderer"),
    build: { rollupOptions: { input: resolve(appRoot, "src/renderer/index.html") } },
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
  },
});
